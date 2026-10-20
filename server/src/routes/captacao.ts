import { Router } from 'express';
import { z } from 'zod';
import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { leads, colunasKanban, imobiliarias, imoveis, notificacoes } from '../db/schema.js';
import { distribuirLead } from '../lib/roleta.js';
import { configIa, iniciarIa, temCentralConectada } from '../lib/agenteIa.js';
import { registrarEvento } from '../lib/eventos.js';
import { marcarForaDoHorario } from '../lib/foraDoHorario.js';
import { mesmoNumero, soDigitos } from '../lib/telefone.js';
import { enviarPush } from '../lib/push.js';
import type { Server as SocketServer } from 'socket.io';


/** "comprar"/"compra"/"venda" -> venda; "alugar"/"aluguel"/"locação" -> locacao; senão null. */
export function normalizarFinalidade(v?: string | null): 'venda' | 'locacao' | null {
  const s = (v || '').toLowerCase();
  if (/alug|loca|rent/.test(s)) return 'locacao';
  if (/compr|venda|sale|buy/.test(s)) return 'venda';
  return null;
}

const palavras = (s: string) => ' ' + s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() + ' ';

/** Imóvel cujo "nome na campanha" aparece no nome da campanha, como palavra inteira. */
async function imovelPelaCampanha(imobId: string, campanha: string): Promise<string | null> {
  const lista = await db.select({ id: imoveis.id, nomes: imoveis.nomesCampanha }).from(imoveis).where(eq(imoveis.imobiliariaId, imobId));
  const alvo = palavras(campanha);
  // o nome mais longo ganha ("VILA SERENA 2" antes de "VILA SERENA")
  const achados = lista.flatMap(im => (im.nomes ?? []).map(n => ({ id: im.id, n: palavras(n) })))
    .filter(x => x.n.trim() && alvo.includes(x.n))
    .sort((a, b) => b.n.length - a.n.length);
  return achados[0]?.id ?? null;
}

export async function criarLead(io: SocketServer, imobId: string, dados: {
  nome: string; telefone: string; email?: string; mensagem?: string;
  imovelTitulo?: string; imovelId?: string; campanha?: string; canal: string;
  finalidade?: 'venda' | 'locacao' | null;
  fbLeadId?: string;
}) {
  // Mesma pessoa preenchendo de novo (outro formulário, outro anúncio, o site...): não cria
  // outro card — evita o mesmo cliente com dois corretores.
  const existente = await acharLeadExistente(imobId, dados.telefone, dados.email);
  if (existente) return recadastrarLead(io, imobId, existente, dados);

  const [colunaNova] = await db.select().from(colunasKanban)
    .where(and(eq(colunasKanban.imobiliariaId, imobId), eq(colunasKanban.titulo, 'Lead Novo'))).limit(1);

  // Se veio de um imóvel específico (site ou campanha), puxa título/valor/sub reais dele.
  let imovelInteresseId: string | null = null;
  let imovelTitulo = dados.imovelTitulo?.trim() || null;
  let imovelSub = dados.mensagem?.trim() || null;
  let valor: string | undefined;
  let finalidade = dados.finalidade ?? null;
  // Sem imóvel explícito: tenta achar pelo nome da campanha (ex.: "CENARIUM" em "[NC 02][CENARIUM][FORM]").
  if (!dados.imovelId && dados.campanha) {
    dados = { ...dados, imovelId: await imovelPelaCampanha(imobId, dados.campanha) ?? undefined };
  }
  if (dados.imovelId) {
    const [im] = await db.select().from(imoveis)
      .where(and(eq(imoveis.id, dados.imovelId), eq(imoveis.imobiliariaId, imobId))).limit(1);
    if (im) {
      imovelInteresseId = im.id;
      imovelTitulo = im.titulo;
      imovelSub = [im.tipo, im.finalidade, [im.endereco, im.cidade].filter(Boolean).join(' · ')].filter(Boolean).join(' · ') || imovelSub;
      valor = im.preco;
      // o cadastro de imóvel usa "Venda"/"Aluguel" (antes só casava "Comprar"/"Alugar" e nunca batia)
      if (!finalidade) finalidade = /alug|loca/i.test(im.finalidade) ? 'locacao' : /vend|compr/i.test(im.finalidade) ? 'venda' : null;
    }
  }

  const [row] = await db.insert(leads).values({
    imobiliariaId: imobId,
    nome: dados.nome.trim(),
    telefone: dados.telefone.trim(),
    email: dados.email?.trim() || null,
    imovelInteresseId,
    imovelTitulo,
    imovelSub,
    ...(valor ? { valor } : {}),
    campanha: dados.campanha?.trim() || null,
    fbLeadId: dados.fbLeadId || null,
    canal: dados.canal as any,
    finalidade,
    colunaId: colunaNova?.id,
  }).returning();

  registrarEvento(imobId, row.id, 'criado', 'Lead recebido pelo formulário (' + dados.canal + (dados.campanha ? ' · ' + dados.campanha : '') + ')', row.nome);
  const tagIds = await marcarForaDoHorario(io, imobId, row.id).catch(() => null);
  io.to('imobiliaria:' + imobId).emit('lead:created', tagIds ? { ...row, tagIds } : row);
  primeiroAtendimento(io, imobId, row.id, dados.canal);
  return row;
}

/** Agente de IA configurado pra fazer o primeiro contato nesse canal? Senão, roleta direto (como sempre). */
function primeiroAtendimento(io: SocketServer, imobId: string, leadId: string, canal: string) {
  void (async () => {
    const conf = await configIa(imobId);
    if (conf && conf.cfg.primeiroContatoCanais.includes(canal) && await temCentralConectada(imobId)) {
      if (await iniciarIa(io, imobId, leadId, 'formulario')) return;
    }
    await distribuirLead(io, imobId, leadId);
  })().catch(e => console.error('roleta captação:', (e as Error).message));
}

type LeadRow = typeof leads.$inferSelect;

/** Lead da imobiliária com o mesmo telefone (ou o mesmo e-mail, quando o formulário não traz telefone). */
async function acharLeadExistente(imobId: string, telefone: string, email?: string): Promise<LeadRow | null> {
  const digitos = soDigitos(telefone);
  if (digitos.length >= 8) {
    const candidatos = await db.select().from(leads).where(and(
      eq(leads.imobiliariaId, imobId),
      sql`right(regexp_replace(${leads.telefone}, '\\D', '', 'g'), 8) = ${digitos.slice(-8)}`,
    )).orderBy(desc(leads.criadoEm));
    return candidatos.find(l => mesmoNumero(l.telefone, telefone)) ?? null;
  }
  const mail = email?.trim().toLowerCase();
  if (!mail) return null;
  const [porEmail] = await db.select().from(leads)
    .where(and(eq(leads.imobiliariaId, imobId), sql`lower(${leads.email}) = ${mail}`))
    .orderBy(desc(leads.criadoEm)).limit(1);
  return porEmail ?? null;
}

/** A pessoa já é lead: marca "cadastrou de novo", avisa o corretor dono e, se ela tinha sido
 *  descartada (bolsão), volta pro Lead Novo e pra roleta. */
async function recadastrarLead(io: SocketServer, imobId: string, lead: LeadRow, dados: Parameters<typeof criarLead>[2]): Promise<LeadRow> {
  const [colNova] = await db.select({ id: colunasKanban.id }).from(colunasKanban)
    .where(and(eq(colunasKanban.imobiliariaId, imobId), eq(colunasKanban.slug, 'novo'))).limit(1);
  const [colRebatida] = await db.select({ id: colunasKanban.id }).from(colunasKanban)
    .where(and(eq(colunasKanban.imobiliariaId, imobId), eq(colunasKanban.slug, 'rebatida'))).limit(1);
  const reabrir = !lead.corretorId && (!!lead.motivoDescarte || (!!colRebatida && lead.colunaId === colRebatida.id));

  const patch: Partial<LeadRow> = { segundoCadastro: true };
  if (!lead.email && dados.email) patch.email = dados.email.trim();
  if (dados.fbLeadId && !lead.fbLeadId) patch.fbLeadId = dados.fbLeadId;
  if (!lead.campanha && dados.campanha) patch.campanha = dados.campanha.trim();
  if (lead.importacaoPendente) patch.importacaoPendente = false;
  if (reabrir) Object.assign(patch, { colunaId: colNova?.id ?? lead.colunaId, motivoDescarte: null, entrouNaColunaEm: new Date() });
  const [row] = await db.update(leads).set(patch).where(eq(leads.id, lead.id)).returning();

  const origem = dados.canal + (dados.campanha ? ' · ' + dados.campanha : '');
  registrarEvento(imobId, row.id, 'recadastro',
    'Cadastrou de novo pelo formulário (' + origem + ')'
    + (reabrir ? ' — estava descartado e voltou pro Lead Novo' : '')
    // marca o lead do Facebook: o webhook usa pra não contar o mesmo aviso duas vezes
    + (dados.fbLeadId && dados.fbLeadId !== row.fbLeadId ? ' [fb:' + dados.fbLeadId + ']' : ''),
    row.nome);

  const tagIds = await marcarForaDoHorario(io, imobId, row.id).catch(() => null);
  io.to('imobiliaria:' + imobId).emit('lead:updated', tagIds ? { ...row, tagIds } : row);

  if (row.corretorId) {
    const texto = `${row.nome} preencheu o formulário de novo (${origem}). Bom momento pra chamar.`;
    await db.insert(notificacoes).values({ perfilId: row.corretorId, tipo: 'lead', titulo: 'Seu lead se cadastrou de novo', texto, lida: false });
    enviarPush(row.corretorId, { title: 'Seu lead se cadastrou de novo', body: texto, url: '/kanban', tag: 'lead-' + row.id }).catch(() => {});
  } else if (row.iaStatus !== 'atendendo') {
    primeiroAtendimento(io, imobId, row.id, dados.canal);
  }
  return row;
}

export function captacaoRouter(io: SocketServer) {
  const router = Router();

  // ---------------------------------------------------------------
  // Webhook do FORMULÁRIO DO SITE da imobiliária (landing Lovable etc.)
  // Sem header — o token vai na URL, pra facilitar em ferramenta no-code.
  // CORS liberado: a página fica num domínio de terceiro.
  // ---------------------------------------------------------------
  const cors = (_req: import('express').Request, res: import('express').Response, next: import('express').NextFunction) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    next();
  };
  router.options('/site/:token', cors, (_req, res) => res.sendStatus(204));

  const siteSchema = z.object({
    nome: z.string().min(1, 'nome é obrigatório'),
    telefone: z.string().min(8, 'telefone inválido'),
    email: z.string().email().optional().or(z.literal('')),
    mensagem: z.string().max(2000).optional(),
    imovel: z.string().max(300).optional(),
    imovelId: z.string().uuid().optional(),
    campanha: z.string().max(200).optional(),
    // "comprar" / "alugar" / "venda" / "locacao" — pra rotear pra roleta certa
    interesse: z.string().max(40).optional(),
    finalidade: z.string().max(40).optional(),
  }).passthrough();

  router.post('/site/:token', cors, async (req, res) => {
    const token = req.params.token;
    if (!token || token.length < 12) return res.status(404).json({ error: 'Link inválido' });
    const [imob] = await db.select({ id: imobiliarias.id, status: imobiliarias.status })
      .from(imobiliarias).where(eq(imobiliarias.capturaToken, token)).limit(1);
    if (!imob) return res.status(404).json({ error: 'Link inválido' });
    if (imob.status !== 'ativa') return res.status(403).json({ error: 'Imobiliária inativa' });

    const parsed = siteSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Dados inválidos' });
    if (!soDigitos(parsed.data.telefone)) return res.status(400).json({ error: 'telefone inválido' });

    const lead = await criarLead(io, imob.id, {
      nome: parsed.data.nome,
      telefone: parsed.data.telefone,
      email: parsed.data.email || undefined,
      mensagem: parsed.data.mensagem,
      imovelTitulo: parsed.data.imovel,
      imovelId: parsed.data.imovelId,
      campanha: parsed.data.campanha,
      canal: 'Site',
      finalidade: normalizarFinalidade(parsed.data.finalidade || parsed.data.interesse),
    });
    res.status(201).json({ ok: true, id: lead.id });
  });

  // ---------------------------------------------------------------
  // Ingestão de automação (n8n) — protegido por CAPTACAO_SECRET no header.
  // ---------------------------------------------------------------
  router.use((req, res, next) => {
    const secret = req.header('x-captacao-secret');
    if (!secret || secret !== process.env.CAPTACAO_SECRET) return res.status(401).json({ error: 'Não autorizado' });
    next();
  });

  const schema = z.object({
    imobiliariaId: z.string().uuid().optional(),
    nome: z.string().min(1),
    telefone: z.string().min(8),
    email: z.string().email().optional(),
    fotoUrl: z.string().url().optional(),
    imovelTitulo: z.string().optional(),
    imovelId: z.string().uuid().optional(),
    mensagem: z.string().optional(),
    campanha: z.string().optional(),
    interesse: z.string().optional(),
    finalidade: z.string().optional(),
    canal: z.enum(['WhatsApp', 'Instagram', 'Facebook', 'Indicacao', 'Manual', 'Site']).default('Facebook'),
  });

  router.post('/facebook', async (req, res) => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Dados inválidos' });

    const [imob] = parsed.data.imobiliariaId
      ? await db.select().from(imobiliarias).where(eq(imobiliarias.id, parsed.data.imobiliariaId)).limit(1)
      : await db.select().from(imobiliarias).limit(1);
    if (!imob) return res.status(parsed.data.imobiliariaId ? 404 : 500).json({ error: 'Imobiliária não encontrada' });

    const row = await criarLead(io, imob.id, {
      nome: parsed.data.nome,
      telefone: parsed.data.telefone,
      email: parsed.data.email,
      mensagem: parsed.data.mensagem,
      imovelTitulo: parsed.data.imovelTitulo,
      imovelId: parsed.data.imovelId,
      campanha: parsed.data.campanha,
      canal: parsed.data.canal,
      finalidade: normalizarFinalidade(parsed.data.finalidade || parsed.data.interesse),
    });
    if (parsed.data.fotoUrl) await db.update(leads).set({ fotoUrl: parsed.data.fotoUrl }).where(eq(leads.id, row.id)).catch(() => {});
    res.status(201).json(row);
  });

  return router;
}
