import { Router } from 'express';
import { z } from 'zod';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { conhecimentoItens, conhecimentoPerguntas, fluxosPagamento, imobiliarias, perfis } from '../db/schema.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { calcularFluxo, fluxoEmTexto, mesAtualBr, type FluxoConfig, type Simulacao } from '../lib/fluxoPagamento.js';
import { gerarTexto, lerArquivo, type Turno } from '../lib/geminiTexto.js';

// Base de Conhecimento — SÓ pra equipe (a IA que atende cliente no WhatsApp não usa).
// Dono/gerente cadastram; todo mundo consulta e pergunta pra IA.
export const conhecimentoRouter = Router();
conhecimentoRouter.use(requireAuth);
const gestor = requireRole('dono', 'gerente');

// ---------------- Itens da base ----------------

conhecimentoRouter.get('/itens', async (req, res) => {
  const rows = await db.select().from(conhecimentoItens)
    .where(eq(conhecimentoItens.imobiliariaId, req.auth!.imobiliariaId)).orderBy(conhecimentoItens.categoria, conhecimentoItens.titulo);
  res.json(rows);
});

const itemSchema = z.object({
  categoria: z.string().trim().min(1),
  titulo: z.string().trim().min(1),
  conteudo: z.string().default(''),
  anexoUrl: z.string().nullable().optional(),
  anexoNome: z.string().nullable().optional(),
});

/** Lê o anexo em segundo plano (a IA transcreve o PDF/foto) e guarda o texto. */
function lerAnexoDepois(id: string, url: string) {
  lerArquivo(url)
    .then(texto => db.update(conhecimentoItens).set({ anexoTexto: texto, anexoStatus: 'ok' }).where(eq(conhecimentoItens.id, id)))
    .catch(e => { console.warn('Base de conhecimento: não li o anexo', id, (e as Error).message); return db.update(conhecimentoItens).set({ anexoStatus: 'erro' }).where(eq(conhecimentoItens.id, id)); })
    .catch(() => {});
}

conhecimentoRouter.post('/itens', gestor, async (req, res) => {
  const p = itemSchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: 'Categoria e título são obrigatórios' });
  const temAnexo = !!p.data.anexoUrl;
  const [row] = await db.insert(conhecimentoItens).values({
    imobiliariaId: req.auth!.imobiliariaId, criadoPor: req.auth!.sub, ...p.data,
    anexoStatus: temAnexo ? 'lendo' : null,
  }).returning();
  if (temAnexo) lerAnexoDepois(row.id, row.anexoUrl!);
  res.status(201).json(row);
});

async function meuItem(id: string, imobId: string) {
  const [r] = await db.select().from(conhecimentoItens).where(and(eq(conhecimentoItens.id, id), eq(conhecimentoItens.imobiliariaId, imobId))).limit(1);
  return r;
}

conhecimentoRouter.patch('/itens/:id', gestor, async (req, res) => {
  const p = itemSchema.partial().safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: 'Dados inválidos' });
  const atual = await meuItem(req.params.id, req.auth!.imobiliariaId);
  if (!atual) return res.status(404).json({ error: 'Item não encontrado' });
  const anexoMudou = p.data.anexoUrl !== undefined && p.data.anexoUrl !== atual.anexoUrl;
  const extra = anexoMudou ? { anexoTexto: null, anexoStatus: p.data.anexoUrl ? 'lendo' : null } : {};
  const [row] = await db.update(conhecimentoItens).set({ ...p.data, ...extra, atualizadoEm: new Date() }).where(eq(conhecimentoItens.id, atual.id)).returning();
  if (anexoMudou && row.anexoUrl) lerAnexoDepois(row.id, row.anexoUrl);
  res.json(row);
});

conhecimentoRouter.post('/itens/:id/reler', gestor, async (req, res) => {
  const atual = await meuItem(req.params.id, req.auth!.imobiliariaId);
  if (!atual?.anexoUrl) return res.status(404).json({ error: 'Item sem anexo' });
  const [row] = await db.update(conhecimentoItens).set({ anexoStatus: 'lendo' }).where(eq(conhecimentoItens.id, atual.id)).returning();
  lerAnexoDepois(row.id, row.anexoUrl!);
  res.json(row);
});

conhecimentoRouter.delete('/itens/:id', gestor, async (req, res) => {
  const atual = await meuItem(req.params.id, req.auth!.imobiliariaId);
  if (!atual) return res.status(404).json({ error: 'Item não encontrado' });
  await db.delete(conhecimentoItens).where(eq(conhecimentoItens.id, atual.id));
  res.json({ ok: true });
});

// ---------------- Fluxos de pagamento ----------------

const n = z.coerce.number().min(0).optional();
const mes = z.string().regex(/^\d{4}-\d{2}$/);
const configSchema = z.object({
  valorImovel: n, financiamento: n, subsidio: n, fgts: n, ato: n,
  dataChaves: mes.optional().or(z.literal('')),
  inicioParcelas: z.enum(['proximo_mes', 'mes_atual']).optional(),
  diaVencimento: z.coerce.number().int().min(1).max(31).optional(),
  limiteMeses: z.coerce.number().int().min(0).optional(),
  parcelaMinima: n,
  baloes: z.array(z.object({ descricao: z.string().default(''), valor: z.coerce.number().min(0), mes })).optional(),
  baloesPeriodicos: z.array(z.object({ descricao: z.string().default(''), valor: z.coerce.number().min(0), aCadaMeses: z.coerce.number().int().min(1), mesInicio: mes })).optional(),
  posChavesParcelas: z.coerce.number().int().min(0).optional(),
  posChavesValor: n,
  correcao: z.string().optional(),
});
const simSchema = z.object({ valorImovel: n, financiamento: n, subsidio: n, fgts: n, ato: n }).partial();
const fluxoSchema = z.object({
  empreendimento: z.string().trim().min(1),
  construtora: z.string().default(''),
  config: configSchema.default({}),
  observacoes: z.string().default(''),
  ativo: z.boolean().optional(),
});

const comCalculo = <T extends { config: unknown }>(f: T) => ({ ...f, calculo: calcularFluxo(f.config as FluxoConfig) });

conhecimentoRouter.get('/fluxos', async (req, res) => {
  const rows = await db.select().from(fluxosPagamento)
    .where(eq(fluxosPagamento.imobiliariaId, req.auth!.imobiliariaId)).orderBy(fluxosPagamento.empreendimento);
  res.json(rows.map(comCalculo));
});

conhecimentoRouter.post('/fluxos', gestor, async (req, res) => {
  const p = fluxoSchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: 'Confira os campos do fluxo (empreendimento é obrigatório)' });
  const [row] = await db.insert(fluxosPagamento).values({ imobiliariaId: req.auth!.imobiliariaId, ...p.data }).returning();
  res.status(201).json(comCalculo(row));
});

async function meuFluxo(id: string, imobId: string) {
  const [r] = await db.select().from(fluxosPagamento).where(and(eq(fluxosPagamento.id, id), eq(fluxosPagamento.imobiliariaId, imobId))).limit(1);
  return r;
}

conhecimentoRouter.patch('/fluxos/:id', gestor, async (req, res) => {
  const p = fluxoSchema.partial().safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: 'Confira os campos do fluxo' });
  const atual = await meuFluxo(req.params.id, req.auth!.imobiliariaId);
  if (!atual) return res.status(404).json({ error: 'Fluxo não encontrado' });
  const [row] = await db.update(fluxosPagamento).set({ ...p.data, atualizadoEm: new Date() }).where(eq(fluxosPagamento.id, atual.id)).returning();
  res.json(comCalculo(row));
});

conhecimentoRouter.delete('/fluxos/:id', gestor, async (req, res) => {
  const atual = await meuFluxo(req.params.id, req.auth!.imobiliariaId);
  if (!atual) return res.status(404).json({ error: 'Fluxo não encontrado' });
  await db.delete(fluxosPagamento).where(eq(fluxosPagamento.id, atual.id));
  res.json({ ok: true });
});

/** Prévia ao vivo do editor (config ainda não salva). */
conhecimentoRouter.post('/fluxos/calcular', async (req, res) => {
  const c = configSchema.safeParse(req.body?.config ?? {});
  const s = simSchema.safeParse(req.body?.simulacao ?? {});
  if (!c.success || !s.success) return res.status(400).json({ error: 'Valores inválidos' });
  res.json(calcularFluxo(c.data as FluxoConfig, s.data as Simulacao, mes.safeParse(req.body?.referencia).success ? req.body.referencia : mesAtualBr()));
});

/** Simulação pro cliente: ajusta valores (renda/financiamento dele) e devolve a mensagem pronta. */
conhecimentoRouter.post('/fluxos/:id/simular', async (req, res) => {
  const f = await meuFluxo(req.params.id, req.auth!.imobiliariaId);
  if (!f) return res.status(404).json({ error: 'Fluxo não encontrado' });
  const s = simSchema.safeParse(req.body?.simulacao ?? {});
  if (!s.success) return res.status(400).json({ error: 'Valores inválidos' });
  const cfg = f.config as FluxoConfig;
  const r = calcularFluxo(cfg, s.data as Simulacao);
  res.json({ resultado: r, texto: fluxoEmTexto(f.empreendimento + (f.construtora ? ' (' + f.construtora + ')' : ''), cfg, r, f.observacoes) });
});

// ---------------- Pergunte à IA ----------------

const LIMITE_CONTEXTO = 150_000;

/** Base inteira em texto (fluxos já calculados pro mês). Usada no Pergunte à IA e no assistente de voz. */
export async function montarContexto(imobId: string, limite = LIMITE_CONTEXTO) {
  const [itens, fluxos] = await Promise.all([
    db.select().from(conhecimentoItens).where(eq(conhecimentoItens.imobiliariaId, imobId)),
    db.select().from(fluxosPagamento).where(and(eq(fluxosPagamento.imobiliariaId, imobId), eq(fluxosPagamento.ativo, true))),
  ]);
  const blocos: string[] = [];
  for (const f of fluxos) {
    const cfg = f.config as FluxoConfig;
    blocos.push(`### [Fluxo de pagamento] ${f.empreendimento}${f.construtora ? ' — ' + f.construtora : ''}\n` + fluxoEmTexto(f.empreendimento, cfg, calcularFluxo(cfg), f.observacoes));
  }
  for (const i of itens) {
    let b = `### [${i.categoria}] ${i.titulo}\n${i.conteudo || ''}`;
    if (i.anexoTexto) b += `\n(Conteúdo do anexo "${i.anexoNome || 'arquivo'}"):\n${i.anexoTexto}`;
    blocos.push(b);
  }
  let txt = blocos.join('\n\n');
  if (txt.length > limite) txt = txt.slice(0, limite) + '\n[...base cortada por tamanho]';
  return { txt, vazio: blocos.length === 0 };
}

const perguntaSchema = z.object({
  pergunta: z.string().trim().min(2).max(2000),
  historico: z.array(z.object({ papel: z.enum(['corretor', 'ia']), texto: z.string().max(4000) })).max(12).default([]),
});

conhecimentoRouter.post('/perguntar', async (req, res) => {
  const p = perguntaSchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: 'Escreva a pergunta' });
  const imobId = req.auth!.imobiliariaId;
  const [[imob], [eu], ctx] = await Promise.all([
    db.select({ nome: imobiliarias.nome }).from(imobiliarias).where(eq(imobiliarias.id, imobId)).limit(1),
    db.select({ nome: perfis.nome }).from(perfis).where(eq(perfis.id, req.auth!.sub)).limit(1),
    montarContexto(imobId),
  ]);
  const gestorNome = 'o gerente ou o dono';
  const sistema = [
    `Você é a assistente interna da imobiliária ${imob?.nome || ''} e ajuda os CORRETORES (não fala com cliente).`,
    `Quem está perguntando: ${eu?.nome || 'corretor'}. Hoje é ${new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })}.`,
    'Responda SOMENTE com base na BASE DE CONHECIMENTO abaixo. Não use conhecimento de fora, não suponha e nunca invente valores, regras ou datas.',
    'Os fluxos de pagamento já vêm CALCULADOS para o mês atual pelo sistema: use exatamente esses números, não refaça a conta.',
    `Se a resposta não estiver na base, responda começando EXATAMENTE com "[SEM_INFO]" e depois diga em uma frase que ainda não tem essa informação cadastrada e que é pra confirmar com ${gestorNome}.`,
    'Seja direto e prático, em português do Brasil, com listas curtas quando ajudar. Valores em R$.',
    'Na última linha escreva "FONTES:" seguido dos títulos (entre colchetes como aparecem na base) que você usou, separados por ";". Se for [SEM_INFO], escreva "FONTES:" vazio.',
    '',
    ctx.vazio ? '=== BASE DE CONHECIMENTO ===\n(vazia — nada cadastrado ainda)' : '=== BASE DE CONHECIMENTO ===\n' + ctx.txt,
  ].join('\n');
  const turnos: Turno[] = [
    ...p.data.historico.map(h => ({ role: (h.papel === 'ia' ? 'model' : 'user') as Turno['role'], parts: [{ text: h.texto }] })),
    { role: 'user', parts: [{ text: p.data.pergunta }] },
  ];
  let bruto: string;
  try { bruto = await gerarTexto({ sistema, turnos }); }
  catch (e) { return res.status(503).json({ error: (e as Error).message }); }

  const semResposta = bruto.trimStart().startsWith('[SEM_INFO]');
  let resposta = bruto.replace(/^\s*\[SEM_INFO\]\s*/, '');
  let fontes: string[] = [];
  const m = resposta.match(/\n?\s*FONTES:\s*(.*)\s*$/i);
  if (m) {
    fontes = m[1].split(';').map(s => s.trim()).filter(Boolean);
    resposta = resposta.slice(0, m.index).trim();
  }
  const [reg] = await db.insert(conhecimentoPerguntas).values({
    imobiliariaId: imobId, perfilId: req.auth!.sub, pergunta: p.data.pergunta, resposta, semResposta,
  }).returning({ id: conhecimentoPerguntas.id });
  res.json({ id: reg.id, resposta, semResposta, fontes });
});

/** Perguntas que a IA não soube responder — o dono completa a base e marca como resolvida. */
conhecimentoRouter.get('/perguntas', gestor, async (req, res) => {
  const rows = await db.select({
    id: conhecimentoPerguntas.id, pergunta: conhecimentoPerguntas.pergunta, resposta: conhecimentoPerguntas.resposta,
    semResposta: conhecimentoPerguntas.semResposta, resolvida: conhecimentoPerguntas.resolvida,
    criadoEm: conhecimentoPerguntas.criadoEm, perfilNome: perfis.nome,
  }).from(conhecimentoPerguntas).leftJoin(perfis, eq(perfis.id, conhecimentoPerguntas.perfilId))
    .where(and(eq(conhecimentoPerguntas.imobiliariaId, req.auth!.imobiliariaId), eq(conhecimentoPerguntas.semResposta, true)))
    .orderBy(desc(conhecimentoPerguntas.criadoEm)).limit(300);
  res.json(rows);
});

conhecimentoRouter.patch('/perguntas/:id', gestor, async (req, res) => {
  const resolvida = req.body?.resolvida !== false;
  const [row] = await db.update(conhecimentoPerguntas).set({ resolvida })
    .where(and(eq(conhecimentoPerguntas.id, req.params.id), eq(conhecimentoPerguntas.imobiliariaId, req.auth!.imobiliariaId))).returning();
  if (!row) return res.status(404).json({ error: 'Pergunta não encontrada' });
  res.json(row);
});
