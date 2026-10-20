import { Router } from 'express';
import { z } from 'zod';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Server as SocketServer } from 'socket.io';
import { db } from '../db/client.js';
import { leads, lotesImportacao, tags, leadTags, colunasKanban, perfis, distribuicaoLog, notificacoes, imobiliarias } from '../db/schema.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { registrarEvento } from '../lib/eventos.js';
import { enviarPush } from '../lib/push.js';
import { numeroCentralDoLead } from '../lib/numeros.js';
import { enviarTextoResolvido } from '../lib/waha.js';

/** Importação de leads por planilha (Excel/CSV). A planilha é lida no navegador; aqui chegam
 *  as linhas já com as colunas ligadas (nome/telefone/e-mail/observação).
 *
 *  Regra de ouro: lead importado fica GUARDADO (`importacaoPendente`) — fora do Kanban, da roleta
 *  automática, da IA e do follow-up — até o dono/gerente distribuir pelo lote. Lista antiga
 *  disparando sozinha é o jeito mais rápido de o WhatsApp bloquear o número. */

const soDigitos = (s: string) => (s || '').replace(/\D/g, '');
/** Telefone brasileiro válido? Devolve só dígitos com DDD (sem o 55), ou null. */
function telefoneValido(bruto: string): string | null {
  let d = soDigitos(bruto);
  if (d.startsWith('55') && d.length >= 12) d = d.slice(2);
  if (d.startsWith('0')) d = d.replace(/^0+/, '');
  return d.length === 10 || d.length === 11 ? d : null;
}
function formatar(d: string) {
  return d.length === 11 ? `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}` : `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
}
/** Mesmo número? Igual ao resto do CRM (últimos 8 dígitos), mais o DDD quando os dois têm. */
function chave(d: string) { return { ddd: d.length >= 10 ? d.slice(-10, -8) : null, fim: d.slice(-8) }; }
function mesmoNumero(a: string, b: string) {
  const x = chave(soDigitos(a)), y = chave(soDigitos(b));
  if (!x.fim || x.fim !== y.fim) return false;
  return !x.ddd || !y.ddd || x.ddd === y.ddd;
}

const linhaSchema = z.object({
  nome: z.string().max(200).optional().default(''),
  telefone: z.string().max(60).optional().default(''),
  email: z.string().max(200).optional().default(''),
  observacao: z.string().max(2000).optional().default(''),
});
const linhasSchema = z.array(linhaSchema).min(1, 'A planilha está vazia').max(5000, 'Máximo de 5.000 linhas por importação');

type Linha = z.infer<typeof linhaSchema>;
type Analise = {
  novos: { linha: number; nome: string; telefone: string; email: string | null; observacao: string }[];
  duplicados: { linha: number; leadId: string; email: string | null }[];
  invalidos: { linha: number; motivo: string }[];
};

/** Separa as linhas em novas / já existentes / com erro. Linha = número na planilha (cabeçalho é a 1). */
async function analisar(imobiliariaId: string, linhas: Linha[]): Promise<Analise> {
  const existentes = await db.select({ id: leads.id, telefone: leads.telefone, email: leads.email })
    .from(leads).where(eq(leads.imobiliariaId, imobiliariaId));
  const porFim = new Map<string, typeof existentes>();
  for (const e of existentes) {
    const fim = soDigitos(e.telefone).slice(-8);
    if (fim.length === 8) porFim.set(fim, [...(porFim.get(fim) ?? []), e]);
  }
  const r: Analise = { novos: [], duplicados: [], invalidos: [] };
  linhas.forEach((l, i) => {
    const linha = i + 2;
    const tel = telefoneValido(l.telefone);
    const email = l.email.trim() && /\S+@\S+\.\S+/.test(l.email.trim()) ? l.email.trim().toLowerCase() : null;
    if (!l.telefone.trim() && !l.nome.trim()) return; // linha em branco: ignora sem contar erro
    if (!tel) { r.invalidos.push({ linha, motivo: l.telefone.trim() ? 'telefone inválido (' + l.telefone.trim() + ')' : 'sem telefone' }); return; }
    const jaNoCrm = (porFim.get(tel.slice(-8)) ?? []).find(e => mesmoNumero(e.telefone, tel));
    if (jaNoCrm) { r.duplicados.push({ linha, leadId: jaNoCrm.id, email: jaNoCrm.email ? null : email }); return; }
    // repetido dentro da própria planilha
    if (r.novos.some(n => mesmoNumero(n.telefone, tel))) { r.duplicados.push({ linha, leadId: '', email: null }); return; }
    r.novos.push({ linha, nome: l.nome.trim() || 'Contato ' + formatar(tel), telefone: formatar(tel), email, observacao: l.observacao.trim() });
  });
  return r;
}

export function importacoesRouter(io: SocketServer) {
  const router = Router();
  router.use(requireAuth, requireRole('dono', 'gerente'));

  // Prévia: conta o que vai acontecer, sem gravar nada.
  router.post('/previa', async (req, res) => {
    const parsed = linhasSchema.safeParse(req.body?.linhas);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Planilha inválida' });
    const a = await analisar(req.auth!.imobiliariaId, parsed.data);
    res.json({
      novos: a.novos.length, duplicados: a.duplicados.length, invalidos: a.invalidos.length,
      exemplos: a.novos.slice(0, 5).map(n => ({ nome: n.nome, telefone: n.telefone, email: n.email })),
      erros: a.invalidos.slice(0, 20),
    });
  });

  // Importa de verdade: cria o lote, a etiqueta e os leads guardados.
  router.post('/', async (req, res) => {
    const parsed = z.object({ nome: z.string().trim().min(1, 'Dê um nome pro lote').max(80), linhas: linhasSchema }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Dados inválidos' });
    const { imobiliariaId, nome: autor } = req.auth!;
    const a = await analisar(imobiliariaId, parsed.data.linhas);
    if (!a.novos.length && !a.duplicados.length) return res.status(400).json({ error: 'Nenhuma linha com telefone válido' });

    const [colNovo] = await db.select({ id: colunasKanban.id }).from(colunasKanban)
      .where(and(eq(colunasKanban.imobiliariaId, imobiliariaId), eq(colunasKanban.slug, 'novo'))).limit(1);
    const [qtdTags] = await db.select({ n: sql<number>`count(*)::int` }).from(tags).where(eq(tags.imobiliariaId, imobiliariaId));
    const [tag] = await db.insert(tags).values({ imobiliariaId, nome: 'Planilha: ' + parsed.data.nome, cor: '#6B5B95', ordem: qtdTags?.n ?? 0 }).returning();
    const [lote] = await db.insert(lotesImportacao).values({
      imobiliariaId, nome: parsed.data.nome, criadoPorNome: autor ?? null, tagId: tag.id,
      novos: a.novos.length, duplicados: a.duplicados.length, invalidos: a.invalidos.length,
    }).returning();

    for (let i = 0; i < a.novos.length; i += 500) {
      const fatia = a.novos.slice(i, i + 500);
      const criados = await db.insert(leads).values(fatia.map(n => ({
        imobiliariaId, nome: n.nome, telefone: n.telefone, email: n.email, canal: 'Manual' as const,
        colunaId: colNovo?.id, campanha: 'Planilha: ' + parsed.data.nome,
        loteImportacaoId: lote.id, importacaoPendente: true,
      }))).returning({ id: leads.id });
      await db.insert(leadTags).values(criados.map(c => ({ leadId: c.id, tagId: tag.id })));
      criados.forEach((c, k) => {
        const obs = fatia[k].observacao;
        registrarEvento(imobiliariaId, c.id, 'importacao', 'Importado da planilha "' + parsed.data.nome + '"' + (obs ? '. Observação: ' + obs : ''), autor);
      });
    }
    // Já existentes: não duplica e não troca de corretor — só completa o e-mail que faltava.
    for (const d of a.duplicados) {
      if (d.leadId && d.email) await db.update(leads).set({ email: d.email }).where(eq(leads.id, d.leadId));
    }
    io.to('imobiliaria:' + imobiliariaId).emit('tag:changed', {});
    res.status(201).json({ lote, novos: a.novos.length, duplicados: a.duplicados.length, invalidos: a.invalidos.length });
  });

  // Lotes com a contagem de guardados x distribuídos.
  router.get('/', async (req, res) => {
    const { imobiliariaId } = req.auth!;
    const lotes = await db.select().from(lotesImportacao)
      .where(eq(lotesImportacao.imobiliariaId, imobiliariaId)).orderBy(desc(lotesImportacao.criadoEm));
    const contagem = lotes.length ? await db.select({
      loteId: leads.loteImportacaoId,
      pendentes: sql<number>`count(*) filter (where ${leads.importacaoPendente})::int`,
      distribuidos: sql<number>`count(*) filter (where not ${leads.importacaoPendente})::int`,
    }).from(leads).where(inArray(leads.loteImportacaoId, lotes.map(l => l.id))).groupBy(leads.loteImportacaoId) : [];
    res.json(lotes.map(l => {
      const c = contagem.find(x => x.loteId === l.id);
      return { ...l, pendentes: c?.pendentes ?? 0, distribuidos: c?.distribuidos ?? 0 };
    }));
  });

  // Leads ainda guardados de um lote (pra escolher na mão).
  router.get('/:id/pendentes', async (req, res) => {
    const rows = await db.select({ id: leads.id, nome: leads.nome, telefone: leads.telefone, email: leads.email })
      .from(leads)
      .where(and(eq(leads.loteImportacaoId, req.params.id), eq(leads.imobiliariaId, req.auth!.imobiliariaId), eq(leads.importacaoPendente, true)))
      .orderBy(asc(leads.criadoEm));
    res.json(rows);
  });

  // Distribui: reparte em sequência entre os corretores escolhidos (1 corretor = tudo pra ele).
  // `leadIds` = escolhidos na mão; `quantidade` = só os N primeiros guardados; nenhum = todos.
  router.post('/:id/distribuir', async (req, res) => {
    const parsed = z.object({
      corretorIds: z.array(z.string().uuid()).min(1, 'Escolha pelo menos um corretor').max(200),
      leadIds: z.array(z.string().uuid()).max(5000).optional(),
      quantidade: z.number().int().min(1).max(5000).optional(),
    }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Dados inválidos' });
    const { imobiliariaId, nome: autor } = req.auth!;
    const [lote] = await db.select().from(lotesImportacao)
      .where(and(eq(lotesImportacao.id, req.params.id), eq(lotesImportacao.imobiliariaId, imobiliariaId))).limit(1);
    if (!lote) return res.status(404).json({ error: 'Lote não encontrado' });

    const corretores = await db.select({ id: perfis.id, nome: perfis.nome, telefone: perfis.telefone, bloqueado: perfis.bloqueado })
      .from(perfis).where(and(inArray(perfis.id, parsed.data.corretorIds), eq(perfis.imobiliariaId, imobiliariaId)));
    const ordem = parsed.data.corretorIds.map(id => corretores.find(c => c.id === id)).filter(c => c && !c.bloqueado) as typeof corretores;
    if (!ordem.length) return res.status(400).json({ error: 'Nenhum corretor válido (bloqueado ou de outra imobiliária)' });

    const cond = [eq(leads.loteImportacaoId, lote.id), eq(leads.importacaoPendente, true)];
    if (parsed.data.leadIds?.length) cond.push(inArray(leads.id, parsed.data.leadIds));
    let alvo = await db.select({ id: leads.id }).from(leads).where(and(...cond)).orderBy(asc(leads.criadoEm));
    if (parsed.data.quantidade) alvo = alvo.slice(0, parsed.data.quantidade);
    if (!alvo.length) return res.status(400).json({ error: 'Não há leads guardados pra distribuir neste lote' });

    const porCorretor = new Map<string, string[]>();
    alvo.forEach((l, i) => {
      const c = ordem[i % ordem.length];
      porCorretor.set(c.id, [...(porCorretor.get(c.id) ?? []), l.id]);
    });

    const agora = new Date();
    for (const [corretorId, ids] of porCorretor) {
      const nomeCorr = ordem.find(c => c.id === corretorId)!.nome;
      // `importacaoPendente = true` na condição: se dois cliques chegarem juntos, o lead não vai pra dois
      const atualizados = await db.update(leads).set({ corretorId, importacaoPendente: false, entrouNaColunaEm: agora })
        .where(and(inArray(leads.id, ids), eq(leads.importacaoPendente, true))).returning();
      if (!atualizados.length) continue;
      porCorretor.set(corretorId, atualizados.map(l => l.id));
      await db.insert(distribuicaoLog).values(atualizados.map(l => ({ imobiliariaId, leadId: l.id, corretorId, origem: 'importacao' })));
      for (const l of atualizados) {
        registrarEvento(imobiliariaId, l.id, 'roleta', 'Distribuído da planilha "' + lote.nome + '" para ' + nomeCorr, autor);
        io.to('imobiliaria:' + imobiliariaId).emit('lead:created', l);
      }
    }

    // Um aviso por corretor (não um por lead): notificação no CRM, push e, se a imobiliária usa o
    // aviso por WhatsApp, uma mensagem só com o total.
    const [imob] = await db.select({ avisoWhats: imobiliarias.notificarCorretorWhatsapp }).from(imobiliarias).where(eq(imobiliarias.id, imobiliariaId)).limit(1);
    const numero = imob?.avisoWhats ? await numeroCentralDoLead({ imobiliariaId, sessaoWhatsappId: null }) : null;
    const resumo: { corretor: string; quantidade: number }[] = [];
    for (const [corretorId, ids] of porCorretor) {
      const c = ordem.find(x => x.id === corretorId)!;
      const n = ids.length;
      if (!n) continue;
      resumo.push({ corretor: c.nome, quantidade: n });
      const texto = `${n} lead${n > 1 ? 's' : ''} da planilha "${lote.nome}" ${n > 1 ? 'foram' : 'foi'} pra sua carteira.`;
      await db.insert(notificacoes).values({ perfilId: corretorId, tipo: 'lead', titulo: 'Leads da planilha pra você', texto, lida: false });
      enviarPush(corretorId, { title: 'Leads da planilha pra você', body: texto + ' Abra o CRM pra atender.', url: '/kanban', tag: 'lote-' + lote.id }).catch(() => {});
      if (numero && c.telefone) {
        const msg = `Olá, ${c.nome.split(' ')[0]}! *${n} lead${n > 1 ? 's' : ''} novo${n > 1 ? 's' : ''} pra você*\n\n` +
          `Vieram da planilha *${lote.nome}* e já estão na sua carteira no CRM, com a etiqueta "Planilha: ${lote.nome}".\n\n` +
          `_São contatos de lista: nenhuma mensagem automática foi enviada pra eles._\n\n_Mensagem automática — Hinode Imóveis CRM_`;
        enviarTextoResolvido(numero.sessionName, c.telefone, msg).catch(e => console.error('aviso planilha:', (e as Error).message));
      }
    }
    res.json({ distribuidos: resumo.reduce((s, r) => s + r.quantidade, 0), resumo });
  });

  // Desfaz: apaga os leads AINDA GUARDADOS do lote (os já distribuídos ficam com o corretor).
  router.delete('/:id', async (req, res) => {
    const { imobiliariaId } = req.auth!;
    const [lote] = await db.select().from(lotesImportacao)
      .where(and(eq(lotesImportacao.id, req.params.id), eq(lotesImportacao.imobiliariaId, imobiliariaId))).limit(1);
    if (!lote) return res.status(404).json({ error: 'Lote não encontrado' });
    const apagados = await db.delete(leads)
      .where(and(eq(leads.loteImportacaoId, lote.id), eq(leads.importacaoPendente, true))).returning({ id: leads.id });
    const [resta] = await db.select({ n: sql<number>`count(*)::int` }).from(leads).where(eq(leads.loteImportacaoId, lote.id));
    if (!resta?.n) {
      await db.delete(lotesImportacao).where(eq(lotesImportacao.id, lote.id));
      if (lote.tagId) await db.delete(tags).where(eq(tags.id, lote.tagId));
      io.to('imobiliaria:' + imobiliariaId).emit('tag:changed', {});
    }
    res.json({ apagados: apagados.length, loteRemovido: !resta?.n });
  });

  return router;
}
