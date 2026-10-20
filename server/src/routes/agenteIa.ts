import { Router } from 'express';
import { z } from 'zod';
import { and, desc, eq } from 'drizzle-orm';
import type { Server as SocketServer } from 'socket.io';
import { db } from '../db/client.js';
import { agentesIa, iaTurnos, imobiliarias, leads, tags } from '../db/schema.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { cifrar, decifrar } from '../lib/crypto.js';
import { PERGUNTAS_PADRAO, pausarIa, passarParaRoleta } from '../lib/agenteIa.js';

const slug = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);

const perguntaSchema = z.object({
  chave: z.string().max(40).optional(),
  rotulo: z.string().min(1).max(60),
  pergunta: z.string().min(1).max(300),
  obrigatoria: z.boolean(),
  opcoes: z.array(z.string().min(1).max(60)).max(12).optional(),
});

const configSchema = z.object({
  ativo: z.boolean(),
  nomeAgente: z.string().min(1).max(40),
  tom: z.enum(['cordial', 'formal', 'descontraido']),
  apresentacao: z.string().max(1500),
  instrucoesExtras: z.string().max(1500),
  perguntas: z.array(perguntaSchema).min(1).max(12),
  etiquetas: z.array(z.object({ tagId: z.string().uuid(), quando: z.string().min(1).max(300) })).max(20).default([]),
  criterios: z.array(z.object({
    chave: z.string().max(40).optional(),
    descricao: z.string().min(1).max(300),
    acao: z.enum(['descartar', 'seguir']),
    tagId: z.string().uuid().nullable().optional(),
    tentativa: z.string().max(300).nullable().optional(),
  })).max(15).default([]),
  mensagemPassagem: z.string().min(1).max(500),
  maxMensagens: z.number().int().min(3).max(40),
  atenderWhatsapp: z.boolean(),
  primeiroContatoCanais: z.array(z.enum(['Facebook', 'Instagram', 'Site'])),
  minutosSemResposta: z.number().int().min(5).max(1440),
  minutosAbandono: z.number().int().min(15).max(2880),
  esperaSegundos: z.number().int().min(3).max(120).default(8),
  mensagemDesqualificado: z.string().min(1).max(500).optional(),
  despedidaModo: z.enum(['ia', 'fixa']).default('ia'),
  consultarImoveis: z.boolean().default(true),
  informarPreco: z.boolean().default(true),
  fotosPorImovel: z.number().int().min(1).max(8).default(3),
  simularDigitacao: z.boolean().default(true),
  modelo: z.enum(['gpt-4.1-mini', 'gpt-4.1', 'gpt-4o-mini']),
  // undefined = mantém a chave atual; '' = remove; texto = troca.
  chaveOpenai: z.string().max(300).optional(),
});

export function agenteIaRouter(io: SocketServer) {
  const router = Router();
  router.use(requireAuth, requireRole('dono', 'gerente'));

  async function imobDe(imobiliariaId: string) {
    const [i] = await db.select({ liberada: imobiliarias.iaLiberada, usaChaveSaas: imobiliarias.iaUsaChaveSaas })
      .from(imobiliarias).where(eq(imobiliarias.id, imobiliariaId)).limit(1);
    return i;
  }

  router.get('/', async (req, res) => {
    const { imobiliariaId } = req.auth!;
    const imob = await imobDe(imobiliariaId);
    const [cfg] = await db.select().from(agentesIa).where(eq(agentesIa.imobiliariaId, imobiliariaId)).limit(1);
    let chaveFinal: string | null = null;
    if (cfg?.chaveCifrada && cfg.chaveIv && cfg.chaveTag) {
      try { chaveFinal = '••••' + decifrar({ cifrado: cfg.chaveCifrada, iv: cfg.chaveIv, tag: cfg.chaveTag }).slice(-4); } catch { chaveFinal = '••••'; }
    }
    const { chaveCifrada: _c, chaveIv: _i, chaveTag: _t, ...semChave } = cfg ?? ({} as typeof agentesIa.$inferSelect);
    res.json({
      liberada: !!imob?.liberada,
      usaChaveSaas: imob?.usaChaveSaas ?? true,
      chaveFinal,
      config: cfg ? { ...semChave, perguntas: cfg.perguntas?.length ? cfg.perguntas : PERGUNTAS_PADRAO } : null,
      perguntasPadrao: PERGUNTAS_PADRAO,
    });
  });

  router.put('/', async (req, res) => {
    const { imobiliariaId } = req.auth!;
    const imob = await imobDe(imobiliariaId);
    if (!imob?.liberada) return res.status(403).json({ error: 'O Agente de IA não está liberado no seu plano.' });
    const parsed = configSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Dados inválidos' });
    const { chaveOpenai, perguntas, etiquetas, criterios, ...d } = parsed.data;
    const tagsDaImob = new Set((await db.select({ id: tags.id }).from(tags).where(eq(tags.imobiliariaId, imobiliariaId))).map(t => t.id));
    const etiquetasOk = etiquetas.filter(e => tagsDaImob.has(e.tagId)).map(e => ({ tagId: e.tagId, quando: e.quando.trim() }));
    const chavesCrit = new Set<string>();
    const criteriosOk = criterios.map(c => {
      let chave = slug(c.chave || c.descricao) || 'criterio';
      while (chavesCrit.has(chave)) chave += '_2';
      chavesCrit.add(chave);
      return {
        chave, descricao: c.descricao.trim(), acao: c.acao, tagId: c.tagId && tagsDaImob.has(c.tagId) ? c.tagId : null,
        tentativa: c.tentativa?.trim() || null,
      };
    });

    const vistas = new Set<string>();
    const perguntasOk = perguntas.map(p => {
      let chave = slug(p.chave || p.rotulo) || 'pergunta';
      while (vistas.has(chave)) chave += '_2';
      vistas.add(chave);
      return { chave, rotulo: p.rotulo.trim(), pergunta: p.pergunta.trim(), obrigatoria: p.obrigatoria, ...(p.opcoes?.length ? { opcoes: p.opcoes } : {}) };
    });

    const chave = chaveOpenai === undefined ? {}
      : chaveOpenai.trim() === '' ? { chaveCifrada: null, chaveIv: null, chaveTag: null }
      : (() => { const c = cifrar(chaveOpenai.trim()); return { chaveCifrada: c.cifrado, chaveIv: c.iv, chaveTag: c.tag }; })();

    if (d.ativo && !imob.usaChaveSaas) {
      const [atual] = await db.select({ c: agentesIa.chaveCifrada }).from(agentesIa).where(eq(agentesIa.imobiliariaId, imobiliariaId)).limit(1);
      const vaiTerChave = 'chaveCifrada' in chave ? !!chave.chaveCifrada : !!atual?.c;
      if (!vaiTerChave) return res.status(400).json({ error: 'Cadastre a sua chave da OpenAI antes de ligar o agente.' });
    }

    const valores = { ...d, perguntas: perguntasOk, etiquetas: etiquetasOk, criterios: criteriosOk, ...chave, atualizadoEm: new Date() };
    await db.insert(agentesIa).values({ imobiliariaId, ...valores })
      .onConflictDoUpdate({ target: agentesIa.imobiliariaId, set: valores });
    res.json({ ok: true });
  });

  // Confere na OpenAI se a chave própria salva (ou uma colada agora, antes de salvar) funciona.
  router.post('/testar-chave', async (req, res) => {
    const { imobiliariaId } = req.auth!;
    let chave = typeof req.body?.chave === 'string' ? req.body.chave.trim() : '';
    if (!chave) {
      const [cfg] = await db.select().from(agentesIa).where(eq(agentesIa.imobiliariaId, imobiliariaId)).limit(1);
      if (!cfg?.chaveCifrada || !cfg.chaveIv || !cfg.chaveTag) return res.status(400).json({ error: 'Nenhuma chave salva ainda.' });
      chave = decifrar({ cifrado: cfg.chaveCifrada, iv: cfg.chaveIv, tag: cfg.chaveTag });
    }
    try {
      const r = await fetch('https://api.openai.com/v1/models', { headers: { Authorization: 'Bearer ' + chave } });
      if (r.ok) return res.json({ ok: true, mensagem: 'Chave válida — a OpenAI aceitou.' });
      const j = await r.json().catch(() => ({})) as { error?: { message?: string } };
      res.json({ ok: false, mensagem: r.status === 401 ? 'A OpenAI recusou essa chave (inválida ou revogada).' : 'OpenAI respondeu ' + r.status + ': ' + (j.error?.message || '') });
    } catch (e) {
      res.json({ ok: false, mensagem: 'Não consegui falar com a OpenAI: ' + (e as Error).message });
    }
  });

  router.get('/turnos', async (req, res) => {
    const rows = await db.select().from(iaTurnos)
      .where(eq(iaTurnos.imobiliariaId, req.auth!.imobiliariaId))
      .orderBy(desc(iaTurnos.criadoEm)).limit(300);
    res.json(rows);
  });

  async function leadDaImob(leadId: string, imobiliariaId: string) {
    const [l] = await db.select({ id: leads.id, iaStatus: leads.iaStatus }).from(leads)
      .where(and(eq(leads.id, leadId), eq(leads.imobiliariaId, imobiliariaId))).limit(1);
    return l;
  }

  // "Assumir": a equipe pega a conversa; a IA para nesse lead.
  router.post('/leads/:id/assumir', async (req, res) => {
    const l = await leadDaImob(req.params.id, req.auth!.imobiliariaId);
    if (!l) return res.status(404).json({ error: 'Lead não encontrado' });
    await pausarIa(io, l.id, req.auth!.nome + ' assumiu a conversa');
    res.json({ ok: true });
  });

  // "Passar pra roleta agora": encerra a IA e distribui com o que ela já coletou.
  router.post('/leads/:id/passar', async (req, res) => {
    const l = await leadDaImob(req.params.id, req.auth!.imobiliariaId);
    if (!l) return res.status(404).json({ error: 'Lead não encontrado' });
    if (l.iaStatus !== 'atendendo' && l.iaStatus !== 'pausado') return res.status(400).json({ error: 'A IA não está com esse lead.' });
    await passarParaRoleta(io, l.id, 'manual');
    res.json({ ok: true });
  });

  return router;
}
