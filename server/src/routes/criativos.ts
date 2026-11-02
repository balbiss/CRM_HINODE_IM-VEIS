import { Router } from 'express';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { imobiliarias, leads } from '../db/schema.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { listarCriativos, casarCriativos, pastaIdDoLink, guardarMiniatura, criativoConhecido, type Criativo } from '../lib/criativos.js';

/** Criativos dos anúncios (pasta do Google Drive da imobiliária). */
export function criativosRouter() {
  const router = Router();

  // Miniatura servida pelo CRM (pública, como as fotos do MinIO): só arquivos das pastas conectadas.
  router.get('/miniatura/:id', async (req, res) => {
    const id = req.params.id;
    if (!/^[A-Za-z0-9_-]{10,}$/.test(id) || !criativoConhecido(id)) return res.status(404).end();
    try { res.redirect(302, await guardarMiniatura(id)); }
    catch { res.redirect(302, 'https://drive.google.com/thumbnail?id=' + id + '&sz=w640'); }
  });

  router.use(requireAuth);

  // a tela carrega a miniatura do CRM, não direto do Google (que bloqueia com 429)
  const comMiniatura = (req: import('express').Request, lista: Criativo[]) => {
    const base = (process.env.PUBLIC_URL || (req.protocol + '://' + req.get('host'))).replace(/\/$/, '');
    return lista.map(c => ({ ...c, thumb: base + '/api/criativos/miniatura/' + c.id }));
  };
  const guardarTodas = (lista: Criativo[]) => { void (async () => { for (const c of lista) { try { await guardarMiniatura(c.id); } catch { /* tenta de novo à meia-noite */ } } })(); };

  const pastaDa = async (imobiliariaId: string) =>
    (await db.select({ url: imobiliarias.criativosPastaUrl }).from(imobiliarias).where(eq(imobiliarias.id, imobiliariaId)).limit(1))[0]?.url ?? null;

  router.get('/config', async (req, res) => {
    const pastaUrl = await pastaDa(req.auth!.imobiliariaId);
    if (!pastaUrl) return res.json({ pastaUrl: null, total: 0 });
    try {
      const arq = await listarCriativos(pastaUrl);
      res.json({ pastaUrl, total: arq.length, imagens: arq.filter(a => a.tipo === 'imagem').length, videos: arq.filter(a => a.tipo === 'video').length });
    } catch (e) {
      res.json({ pastaUrl, total: 0, erro: (e as Error).message });
    }
  });

  // Salva a pasta (testa a leitura antes) — dono/gerente
  router.put('/config', requireRole('dono', 'gerente'), async (req, res) => {
    const parsed = z.object({ pastaUrl: z.string().trim().max(500).nullable() }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Link inválido' });
    const url = parsed.data.pastaUrl || null;
    if (url && !pastaIdDoLink(url)) return res.status(400).json({ error: 'Cole o link de uma PASTA do Google Drive (drive.google.com/drive/folders/…)' });
    let total = 0;
    if (url) {
      try { const lista = await listarCriativos(url, true); total = lista.length; guardarTodas(lista); }
      catch (e) { return res.status(400).json({ error: (e as Error).message }); }
      if (!total) return res.status(400).json({ error: 'Não achei nenhum arquivo nessa pasta. Ela está compartilhada como "Qualquer pessoa com o link"?' });
    }
    await db.update(imobiliarias).set({ criativosPastaUrl: url }).where(eq(imobiliarias.id, req.auth!.imobiliariaId));
    res.json({ pastaUrl: url, total });
  });

  // Criativo do anúncio que trouxe o lead
  router.get('/lead/:id', async (req, res) => {
    const { imobiliariaId, role, sub } = req.auth!;
    const [lead] = await db.select({ campanha: leads.campanha, corretorId: leads.corretorId }).from(leads)
      .where(and(eq(leads.id, req.params.id), eq(leads.imobiliariaId, imobiliariaId))).limit(1);
    if (!lead) return res.status(404).json({ error: 'Lead não encontrado' });
    if (role === 'corretor' && lead.corretorId && lead.corretorId !== sub) return res.status(403).json({ error: 'Sem acesso' });
    const pastaUrl = await pastaDa(imobiliariaId);
    if (!pastaUrl || !lead.campanha) return res.json({ campanha: lead.campanha, criativos: [] });
    try {
      res.json({ campanha: lead.campanha, criativos: comMiniatura(req, casarCriativos(lead.campanha, await listarCriativos(pastaUrl))) });
    } catch {
      res.json({ campanha: lead.campanha, criativos: [] });
    }
  });

  // Vários anúncios de uma vez (tela Campanhas)
  router.post('/casar', async (req, res) => {
    const parsed = z.object({ nomes: z.array(z.string().max(300)).max(500) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Lista inválida' });
    const pastaUrl = await pastaDa(req.auth!.imobiliariaId);
    if (!pastaUrl) return res.json({});
    try {
      const arq = await listarCriativos(pastaUrl);
      res.json(Object.fromEntries(parsed.data.nomes.map(n => [n, comMiniatura(req, casarCriativos(n, arq))])));
    } catch {
      res.json({});
    }
  });

  return router;
}
