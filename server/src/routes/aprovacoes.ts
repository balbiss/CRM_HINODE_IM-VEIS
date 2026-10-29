import { Router } from 'express';
import { and, desc, eq, or } from 'drizzle-orm';
import { notificar } from '../lib/notificar.js';
import type { Server as SocketServer } from 'socket.io';
import { db } from '../db/client.js';
import { leads, perfis, descartesLeads, notificacoes } from '../db/schema.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { registrarEvento } from '../lib/eventos.js';
import { encerrarPorLead } from '../lib/followup.js';
import { colunaPorSlug, hojeSp } from '../lib/regrasOka.js';

/** Aprovações (dono/gerente): descarte extremo e venda registrada pelo corretor — v1. */
export function aprovacoesRouter(io: SocketServer) {
  const router = Router();
  router.use(requireAuth, requireRole('dono', 'gerente'));

  router.get('/', async (req, res) => {
    const { imobiliariaId } = req.auth!;
    const rows = await db.select({
      id: leads.id, nome: leads.nome, telefone: leads.telefone, campanha: leads.campanha, corretorId: leads.corretorId,
      corretorNome: perfis.nome, motivoDescarte: leads.motivoDescarte, descartePendente: leads.descartePendenteAprovacao,
      vendaPendente: leads.vendaPendenteAprovacao, valorVenda: leads.valorVenda, empreendimento: leads.empreendimento,
      unidade: leads.unidade, torre: leads.torre, dataVendaInformada: leads.dataVendaInformada, ultimaAcaoEm: leads.ultimaAcaoEm,
    }).from(leads).leftJoin(perfis, eq(perfis.id, leads.corretorId))
      .where(and(eq(leads.imobiliariaId, imobiliariaId), or(eq(leads.descartePendenteAprovacao, true), eq(leads.vendaPendenteAprovacao, true))))
      .orderBy(desc(leads.ultimaAcaoEm));
    // observação do pedido de descarte (o último registro de descarte do lead)
    const comObs = await Promise.all(rows.map(async r => {
      if (!r.descartePendente) return { ...r, observacao: null };
      const [d] = await db.select({ observacao: descartesLeads.observacao }).from(descartesLeads)
        .where(eq(descartesLeads.leadId, r.id)).orderBy(desc(descartesLeads.criadoEm)).limit(1);
      return { ...r, observacao: d?.observacao ?? null };
    }));
    res.json(comObs);
  });

  async function pegar(imobiliariaId: string, id: string) {
    const [l] = await db.select().from(leads).where(and(eq(leads.id, id), eq(leads.imobiliariaId, imobiliariaId))).limit(1);
    return l ?? null;
  }
  function avisar(perfilId: string | null, leadId: string, titulo: string, texto?: string) {
    if (!perfilId) return;
    void notificar({ perfilId, leadId, tipo: 'aprovacao_resultado', titulo, texto: texto ?? null }).catch(() => {});
  }

  // Descarte extremo aprovado: sai DE VEZ da roleta e das rebatidas → coluna LEAD DESCADASTRAR.
  router.post('/:id/descarte/aprovar', async (req, res) => {
    const { imobiliariaId, sub, nome } = req.auth!;
    const l = await pegar(imobiliariaId, req.params.id);
    if (!l || !l.descartePendenteAprovacao) return res.status(404).json({ error: 'Pedido não encontrado' });
    const col = await colunaPorSlug(imobiliariaId, 'descadastrar');
    const agora = new Date();
    const [row] = await db.update(leads).set({
      descartePendenteAprovacao: false, descartadoEm: agora, descartadoPor: sub, corretorId: null,
      colunaId: col?.id ?? l.colunaId, proximoContatoEm: null, dataVisita: null, ultimaAcaoEm: agora, entrouNaColunaEm: agora,
    }).where(eq(leads.id, l.id)).returning();
    registrarEvento(imobiliariaId, l.id, 'descarte', 'Descarte (' + (l.motivoDescarte ?? '') + ') APROVADO pela gerência — lead removido de vez', nome);
    avisar(l.corretorId, l.id, 'Descarte aprovado: ' + l.nome);
    void encerrarPorLead(io, imobiliariaId, l.id, 'descarte aprovado');
    io.to('imobiliaria:' + imobiliariaId).emit('lead:updated', row);
    res.json(row);
  });

  router.post('/:id/descarte/rejeitar', async (req, res) => {
    const { imobiliariaId, nome } = req.auth!;
    const l = await pegar(imobiliariaId, req.params.id);
    if (!l || !l.descartePendenteAprovacao) return res.status(404).json({ error: 'Pedido não encontrado' });
    const [row] = await db.update(leads).set({ descartePendenteAprovacao: false, motivoDescarte: null, ultimaAcaoEm: new Date() })
      .where(eq(leads.id, l.id)).returning();
    registrarEvento(imobiliariaId, l.id, 'alerta', 'Descarte REJEITADO pela gerência — o lead voltou pro corretor', nome);
    avisar(l.corretorId, l.id, 'Descarte recusado: ' + l.nome, 'O lead voltou pra sua carteira.');
    io.to('imobiliaria:' + imobiliariaId).emit('lead:updated', row);
    res.json(row);
  });

  // Venda aprovada: conta na DATA DA VENDA informada (não no dia da aprovação) e vai pra VENDA.
  router.post('/:id/venda/aprovar', async (req, res) => {
    const { imobiliariaId, nome } = req.auth!;
    const l = await pegar(imobiliariaId, req.params.id);
    if (!l || !l.vendaPendenteAprovacao) return res.status(404).json({ error: 'Pedido não encontrado' });
    const col = await colunaPorSlug(imobiliariaId, 'venda');
    const dataInf = l.dataVendaInformada;
    const dataFechamento = dataInf && dataInf !== hojeSp() ? new Date(dataInf + 'T12:00:00-03:00') : new Date();
    const [row] = await db.update(leads).set({
      vendaPendenteAprovacao: false, dataFechamento, colunaId: col?.id ?? l.colunaId, valor: l.valorVenda ?? l.valor,
      // venda aprovada não deixa follow-up/visita pendente (senão vira "tarefa atrasada")
      proximoContatoEm: null, dataVisita: null, ultimaAcaoEm: new Date(), entrouNaColunaEm: new Date(),
    }).where(eq(leads.id, l.id)).returning();
    registrarEvento(imobiliariaId, l.id, 'venda', 'Venda APROVADA pela gerência' + (dataInf ? ' · data da venda ' + dataInf.split('-').reverse().join('/') : ''), nome);
    avisar(l.corretorId, l.id, 'Venda aprovada: ' + l.nome, 'Parabéns!');
    void encerrarPorLead(io, imobiliariaId, l.id, 'venda aprovada');
    io.to('imobiliaria:' + imobiliariaId).emit('lead:updated', row);
    res.json(row);
  });

  router.post('/:id/venda/rejeitar', async (req, res) => {
    const { imobiliariaId, nome } = req.auth!;
    const l = await pegar(imobiliariaId, req.params.id);
    if (!l || !l.vendaPendenteAprovacao) return res.status(404).json({ error: 'Pedido não encontrado' });
    const [row] = await db.update(leads).set({
      vendaPendenteAprovacao: false, valorVenda: null, empreendimento: null, unidade: null, torre: null, dataVendaInformada: null, ultimaAcaoEm: new Date(),
    }).where(eq(leads.id, l.id)).returning();
    registrarEvento(imobiliariaId, l.id, 'alerta', 'Venda REJEITADA pela gerência — revise os dados e envie de novo', nome);
    avisar(l.corretorId, l.id, 'Venda recusada: ' + l.nome, 'Revise os dados e envie de novo.');
    io.to('imobiliaria:' + imobiliariaId).emit('lead:updated', row);
    res.json(row);
  });

  return router;
}
