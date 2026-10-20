import { Router } from 'express';
import { z } from 'zod';
import { and, desc, eq, gte, ilike, sql } from 'drizzle-orm';
import type { Request } from 'express';
import { db } from '../db/client.js';
import { assistenteMemorias, assistenteSessoes, imobiliarias, perfis } from '../db/schema.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { MODELO, VERSAO_API, VOZES, assistenteConfigurado, configSessao, criarTokenTemporario, roteiro } from '../lib/assistente.js';

/** Início do mês corrente no horário de Brasília (a cota de minutos é mensal). */
function inicioDoMes() {
  const agoraBr = new Date(Date.now() - 3 * 3600 * 1000);
  return new Date(Date.UTC(agoraBr.getUTCFullYear(), agoraBr.getUTCMonth(), 1, 3, 0, 0));
}

async function segundosUsadosNoMes(imobiliariaId: string) {
  const [r] = await db.select({ s: sql<number>`coalesce(sum(${assistenteSessoes.segundos}), 0)::int` }).from(assistenteSessoes)
    .where(and(eq(assistenteSessoes.imobiliariaId, imobiliariaId), gte(assistenteSessoes.iniciadaEm, inicioDoMes())));
  return r?.s ?? 0;
}

type Fala = { quem: string; texto: string };

/** Final das últimas conversas do usuário (até 7 dias, ~40 falas) — vai no roteiro e aparece na tela. */
async function historicoRecente(perfilId: string): Promise<Fala[]> {
  const rows = await db.select({ t: assistenteSessoes.transcricao }).from(assistenteSessoes)
    .where(and(eq(assistenteSessoes.perfilId, perfilId), gte(assistenteSessoes.iniciadaEm, new Date(Date.now() - 7 * 86400000)), sql`jsonb_array_length(${assistenteSessoes.transcricao}) > 0`))
    .orderBy(desc(assistenteSessoes.iniciadaEm)).limit(3);
  const falas = rows.reverse().flatMap(r => r.t || []).slice(-40);
  // limita o tamanho total (o roteiro vai em toda conversa)
  let total = 0;
  const out: Fala[] = [];
  for (let i = falas.length - 1; i >= 0; i--) {
    total += falas[i].texto.length;
    if (total > 4000) break;
    out.unshift(falas[i]);
  }
  return out;
}

/** Falas que o navegador manda no sinal (valida e corta). */
function falasDoCorpo(req: Request): Fala[] | null {
  const p = z.array(z.object({ quem: z.enum(['voce', 'assistente', 'sistema']), texto: z.string().max(2000) })).max(200).safeParse(req.body?.falas);
  return p.success ? p.data.filter(f => f.texto.trim()).map(f => ({ quem: f.quem, texto: f.texto.trim().slice(0, 1000) })).slice(-80) : null;
}

async function imobDe(id: string) {
  const [i] = await db.select().from(imobiliarias).where(eq(imobiliarias.id, id)).limit(1);
  return i;
}

export const assistenteRouter = Router();
assistenteRouter.use(requireAuth);

assistenteRouter.get('/config', async (req, res) => {
  const imob = await imobDe(req.auth!.imobiliariaId);
  if (!imob) return res.status(404).json({ error: 'Imobiliária não encontrada' });
  const usados = await segundosUsadosNoMes(imob.id);
  res.json({
    disponivel: imob.assistenteLiberado && assistenteConfigurado(),
    liberado: imob.assistenteLiberado,
    nome: imob.assistenteNome,
    voz: imob.assistenteVoz,
    vozes: VOZES,
    minutosMes: imob.assistenteMinutosMes,
    minutosUsados: Math.ceil(usados / 60),
  });
});

assistenteRouter.patch('/config', requireRole('dono', 'gerente'), async (req, res) => {
  const parsed = z.object({ nome: z.string().trim().min(1).max(30).optional(), voz: z.enum(VOZES).optional() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Nome (até 30 letras) ou voz inválidos' });
  const patch: Record<string, string> = {};
  if (parsed.data.nome) patch.assistenteNome = parsed.data.nome;
  if (parsed.data.voz) patch.assistenteVoz = parsed.data.voz;
  if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nada pra alterar' });
  const [row] = await db.update(imobiliarias).set(patch).where(eq(imobiliarias.id, req.auth!.imobiliariaId)).returning();
  res.json({ nome: row.assistenteNome, voz: row.assistenteVoz });
});

/** Abre uma conversa: confere liberação e cota e devolve o token temporário do Google. */
assistenteRouter.post('/sessao', async (req, res) => {
  const { imobiliariaId, sub } = req.auth!;
  const imob = await imobDe(imobiliariaId);
  if (!imob?.assistenteLiberado) return res.status(403).json({ error: 'O assistente de voz não está liberado pra sua imobiliária.' });
  if (!assistenteConfigurado()) return res.status(503).json({ error: 'O assistente de voz ainda não foi configurado no servidor.' });
  const restante = imob.assistenteMinutosMes * 60 - await segundosUsadosNoMes(imobiliariaId);
  if (restante <= 0) return res.status(429).json({ error: 'Acabaram os minutos do assistente deste mês. Fale com o administrador do CRM.' });

  const [eu] = await db.select({ nome: perfis.nome, role: perfis.role }).from(perfis).where(eq(perfis.id, sub)).limit(1);
  const memorias = await db.select({ id: assistenteMemorias.id, texto: assistenteMemorias.texto }).from(assistenteMemorias)
    .where(eq(assistenteMemorias.perfilId, sub)).orderBy(desc(assistenteMemorias.criadoEm)).limit(30);
  const historico = await historicoRecente(sub);
  const config = configSessao({
    voz: imob.assistenteVoz,
    instrucoes: roteiro({ nomeAssistente: imob.assistenteNome, nomeUsuario: (eu?.nome || '').split(' ')[0] || 'usuário', papel: eu?.role || req.auth!.role, nomeImob: imob.nome, memorias, historico }),
  });
  let token: string;
  try { token = await criarTokenTemporario(config); } catch (e) {
    console.error('assistente: token do Google falhou —', (e as Error).message);
    return res.status(502).json({ error: 'Não deu pra iniciar o assistente agora. Tente de novo em instantes.' });
  }
  const [sessao] = await db.insert(assistenteSessoes).values({ imobiliariaId, perfilId: sub }).returning({ id: assistenteSessoes.id });
  res.status(201).json({ sessaoId: sessao.id, token, modelo: MODELO, versaoApi: VERSAO_API, config, segundosRestantes: restante, nome: imob.assistenteNome });
});

/** Sinal de vida da conversa (a cada ~15 s): soma o tempo e avisa quando a cota acabar.
 *  O tempo contado nunca passa do tempo real desde o início (o navegador não consegue "economizar"). */
assistenteRouter.post('/sessao/:id/sinal', async (req, res) => {
  const fim = req.body?.fim === true;
  const [s] = await db.select().from(assistenteSessoes)
    .where(and(eq(assistenteSessoes.id, req.params.id), eq(assistenteSessoes.perfilId, req.auth!.sub))).limit(1);
  if (!s) return res.status(404).json({ error: 'Sessão não encontrada' });
  if (!s.encerrada) {
    const real = Math.ceil((Date.now() - s.iniciadaEm.getTime()) / 1000);
    const falas = falasDoCorpo(req);
    await db.update(assistenteSessoes).set({ segundos: Math.max(s.segundos, real), ultimoSinalEm: new Date(), encerrada: fim, ...(falas ? { transcricao: falas } : {}) })
      .where(eq(assistenteSessoes.id, s.id));
  }
  const imob = await imobDe(s.imobiliariaId);
  const restante = (imob?.assistenteMinutosMes ?? 0) * 60 - await segundosUsadosNoMes(s.imobiliariaId);
  res.json({ segundosRestantes: Math.max(0, restante), encerrar: restante <= 0 });
});

/** Histórico pra mostrar na tela ao reabrir o assistente. */
assistenteRouter.get('/historico', async (req, res) => {
  res.json(await historicoRecente(req.auth!.sub));
});

// --- Memória pessoal (cada usuário só mexe na sua) ---
assistenteRouter.get('/memorias', async (req, res) => {
  const q = String(req.query.q || '').trim();
  const rows = await db.select({ id: assistenteMemorias.id, texto: assistenteMemorias.texto, criadoEm: assistenteMemorias.criadoEm }).from(assistenteMemorias)
    .where(and(eq(assistenteMemorias.perfilId, req.auth!.sub), ...(q ? [ilike(assistenteMemorias.texto, '%' + q.replace(/[%_]/g, '') + '%')] : [])))
    .orderBy(desc(assistenteMemorias.criadoEm)).limit(20);
  res.json(rows);
});

assistenteRouter.post('/memorias', async (req, res) => {
  const parsed = z.object({ texto: z.string().trim().min(2).max(500) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Texto inválido' });
  const [row] = await db.insert(assistenteMemorias).values({ imobiliariaId: req.auth!.imobiliariaId, perfilId: req.auth!.sub, texto: parsed.data.texto }).returning();
  res.status(201).json(row);
});

assistenteRouter.delete('/memorias/:id', async (req, res) => {
  if (!z.string().uuid().safeParse(req.params.id).success) return res.status(404).json({ error: 'Anotação não encontrada' });
  await db.delete(assistenteMemorias).where(and(eq(assistenteMemorias.id, req.params.id), eq(assistenteMemorias.perfilId, req.auth!.sub)));
  res.json({ ok: true });
});
