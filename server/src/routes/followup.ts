import { Router } from 'express';
import { z } from 'zod';
import { and, asc, eq, inArray, isNotNull, isNull, ne, or } from 'drizzle-orm';
import type { Server as SocketServer } from 'socket.io';
import { db } from '../db/client.js';
import { followupFluxos, followupPassos, followupExecucoes, leads, perfis, imobiliarias } from '../db/schema.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { iniciarFollowup, mudarExecucao } from '../lib/followup.js';

// Quando cada passo sai (v1): 1º sempre na hora; os outros "na próxima leva" ou N dias depois do
// anterior (na mesma leva) — o motor encaixa tudo nas levas da manhã e das 16h.
const passoSchema = z.object({
  tipo: z.enum(['texto', 'audio', 'imagem', 'video', 'pdf']).default('texto'),
  conteudo: z.string().default(''),
  anexoUrl: z.string().nullable().optional(),
  anexoNome: z.string().nullable().optional(),
  anexoMimetype: z.string().nullable().optional(),
  baseAtraso: z.enum(['inscricao', 'passo_anterior', 'proxima_leva']).default('passo_anterior'),
  atrasoMinutos: z.number().int().min(0).max(60 * 24 * 60).default(0),
  atrasoTexto: z.string().default('na hora'),
  soHorarioComercial: z.boolean().default(false),
  dataHoraFixa: z.string().datetime({ offset: true }).nullable().optional(),
  cadenciaLabel: z.string().nullable().optional(),
});

const fluxoPatchSchema = z.object({
  nome: z.string().min(1).optional(),
  ativo: z.boolean().optional(),
  // "Geral": dispara sozinho pra todo lead que ganha o corretor (só um Geral por corretor)
  disparaEmLeadNovo: z.boolean().optional(),
  campanha: z.string().nullable().optional(),
  janelaInicioMin: z.number().int().min(0).max(1439).optional(),
  janelaFimMin: z.number().int().min(1).max(1440).optional(),
  janelaDias: z.array(z.boolean()).length(7).optional(),
  aoEsgotar: z.enum(['nada', 'descartar', 'mover']).optional(),
  aoEsgotarColunaId: z.string().uuid().nullable().optional(),
  motivoDescarteEsgotar: z.string().min(1).optional(),
  arquivado: z.boolean().optional(),
});

export function followupRouter(io: SocketServer) {
  const router = Router();
  router.use(requireAuth);

  async function comPassos(fluxos: (typeof followupFluxos.$inferSelect)[]) {
    if (!fluxos.length) return [];
    const ps = await db.select().from(followupPassos)
      .where(inArray(followupPassos.fluxoId, fluxos.map(f => f.id)))
      .orderBy(asc(followupPassos.ordem));
    return fluxos.map(f => ({ ...f, passos: ps.filter(p => p.fluxoId === f.id) }));
  }

  // Fluxos: corretor vê os dele + os modelos/campanhas da imobiliária (sem dono); dono/gerente veem
  // todos (ou ?corretorId=). Arquivados só com ?arquivados=1.
  router.get('/fluxos', async (req, res) => {
    const { imobiliariaId, role, sub } = req.auth!;
    const conds = [eq(followupFluxos.imobiliariaId, imobiliariaId)];
    if (role === 'corretor') conds.push(or(eq(followupFluxos.corretorId, sub), isNull(followupFluxos.corretorId))!);
    else if (typeof req.query.corretorId === 'string') conds.push(eq(followupFluxos.corretorId, req.query.corretorId));
    conds.push(req.query.arquivados === '1' ? isNotNull(followupFluxos.arquivadoEm) : isNull(followupFluxos.arquivadoEm));
    const fluxos = await db.select().from(followupFluxos).where(and(...conds)).orderBy(asc(followupFluxos.criadoEm));
    res.json(await comPassos(fluxos));
  });

  router.post('/fluxos', async (req, res) => {
    const parsed = z.object({ nome: z.string().min(1), corretorId: z.string().uuid().nullable().optional() }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Nome obrigatório' });
    const { imobiliariaId, role, sub } = req.auth!;
    // corretor cria pra si; dono/gerente pode criar modelo da imobiliária (corretorId null)
    const corretorId = role === 'corretor' ? sub : (parsed.data.corretorId === null ? null : parsed.data.corretorId || sub);
    const [row] = await db.insert(followupFluxos).values({ imobiliariaId, corretorId, nome: parsed.data.nome.trim(), ativo: true, aoEsgotar: 'descartar' }).returning();
    io.to('imobiliaria:' + imobiliariaId).emit('followup:mudou', {});
    res.status(201).json({ ...row, passos: [] });
  });

  async function fluxoDoUsuario(id: string, req: import('express').Request, paraLer = false) {
    const { imobiliariaId, role, sub } = req.auth!;
    const cond = role === 'corretor'
      ? and(eq(followupFluxos.id, id), eq(followupFluxos.imobiliariaId, imobiliariaId),
        paraLer ? or(eq(followupFluxos.corretorId, sub), isNull(followupFluxos.corretorId)) : eq(followupFluxos.corretorId, sub))
      : and(eq(followupFluxos.id, id), eq(followupFluxos.imobiliariaId, imobiliariaId));
    const [f] = await db.select().from(followupFluxos).where(cond).limit(1);
    return f ?? null;
  }

  // "Usar como base": copia o fluxo (modelo da imobiliária ou de outro) com os passos, pro corretor ajustar.
  router.post('/fluxos/:id/copiar', async (req, res) => {
    const base = await fluxoDoUsuario(req.params.id, req, true);
    if (!base) return res.status(404).json({ error: 'Fluxo não encontrado' });
    const { imobiliariaId, sub } = req.auth!;
    const [novo] = await db.insert(followupFluxos).values({
      imobiliariaId, corretorId: sub, nome: base.nome + ' (minha cópia)', ativo: false, disparaEmLeadNovo: false,
      aoEsgotar: base.aoEsgotar, aoEsgotarColunaId: base.aoEsgotarColunaId, motivoDescarteEsgotar: base.motivoDescarteEsgotar,
    }).returning();
    const passos = await db.select().from(followupPassos).where(eq(followupPassos.fluxoId, base.id)).orderBy(asc(followupPassos.ordem));
    if (passos.length) {
      await db.insert(followupPassos).values(passos.map(({ id: _id, fluxoId: _f, okaId: _o, ...p }) => ({ ...p, fluxoId: novo.id })));
    }
    io.to('imobiliaria:' + imobiliariaId).emit('followup:mudou', {});
    res.status(201).json((await comPassos([novo]))[0]);
  });

  router.patch('/fluxos/:id', async (req, res) => {
    const parsed = fluxoPatchSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Dados inválidos' });
    const alvo = await fluxoDoUsuario(req.params.id, req);
    if (!alvo) return res.status(404).json({ error: 'Fluxo não encontrado' });
    const { arquivado, ...resto } = parsed.data;
    const set: Record<string, unknown> = { ...resto };
    // arquivar: sai da lista, para de disparar e deixa de ser o Geral; restaurar volta DESATIVADO
    if (arquivado === true) Object.assign(set, { arquivadoEm: new Date(), ativo: false, disparaEmLeadNovo: false });
    if (arquivado === false) Object.assign(set, { arquivadoEm: null, ativo: false });

    // Só um fluxo "Geral" por corretor.
    if (set.disparaEmLeadNovo && alvo.corretorId) {
      await db.update(followupFluxos).set({ disparaEmLeadNovo: false })
        .where(and(eq(followupFluxos.corretorId, alvo.corretorId), ne(followupFluxos.id, alvo.id)));
    }
    const [row] = await db.update(followupFluxos).set(set).where(eq(followupFluxos.id, alvo.id)).returning();
    io.to('imobiliaria:' + req.auth!.imobiliariaId).emit('followup:mudou', {});
    res.json((await comPassos([row]))[0]);
  });

  router.delete('/fluxos/:id', async (req, res) => {
    const alvo = await fluxoDoUsuario(req.params.id, req);
    if (!alvo) return res.status(404).json({ error: 'Fluxo não encontrado' });
    await db.delete(followupFluxos).where(eq(followupFluxos.id, alvo.id));
    io.to('imobiliaria:' + req.auth!.imobiliariaId).emit('followup:mudou', {});
    res.json({ ok: true });
  });

  // Substitui todos os passos do fluxo de uma vez. O 1º passo sempre sai na hora.
  router.put('/fluxos/:id/passos', async (req, res) => {
    const parsed = z.object({ passos: z.array(passoSchema).max(30) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Passos inválidos' });
    const alvo = await fluxoDoUsuario(req.params.id, req);
    if (!alvo) return res.status(404).json({ error: 'Fluxo não encontrado' });

    await db.delete(followupPassos).where(eq(followupPassos.fluxoId, alvo.id));
    if (parsed.data.passos.length) {
      await db.insert(followupPassos).values(parsed.data.passos.map((p, i) => ({
        fluxoId: alvo.id, ordem: i, tipo: p.tipo, conteudo: p.conteudo,
        anexoUrl: p.anexoUrl ?? null, anexoNome: p.anexoNome ?? null, anexoMimetype: p.anexoMimetype ?? null,
        anexoTipo: p.tipo === 'texto' ? null : p.tipo === 'pdf' ? 'documento' : p.tipo,
        baseAtraso: i === 0 ? 'inscricao' : p.baseAtraso, atrasoMinutos: i === 0 ? 0 : p.atrasoMinutos,
        atrasoTexto: i === 0 ? 'na hora' : p.atrasoTexto, soHorarioComercial: p.soHorarioComercial,
        dataHoraFixa: p.dataHoraFixa ? new Date(p.dataHoraFixa) : null, cadenciaLabel: p.cadenciaLabel ?? null,
      })));
    }
    io.to('imobiliaria:' + req.auth!.imobiliariaId).emit('followup:mudou', {});
    res.json((await comPassos([alvo]))[0]);
  });

  // Liga/desliga o follow-up automático da imobiliária inteira (v1: só o dono salva).
  router.get('/config', async (req, res) => {
    const [i] = await db.select({ followupAutomaticoAtivo: imobiliarias.followupAutomaticoAtivo }).from(imobiliarias).where(eq(imobiliarias.id, req.auth!.imobiliariaId)).limit(1);
    res.json(i ?? { followupAutomaticoAtivo: false });
  });
  router.put('/config', requireRole('dono'), async (req, res) => {
    const parsed = z.object({ followupAutomaticoAtivo: z.boolean() }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'valor inválido' });
    await db.update(imobiliarias).set(parsed.data).where(eq(imobiliarias.id, req.auth!.imobiliariaId));
    io.to('imobiliaria:' + req.auth!.imobiliariaId).emit('followup:mudou', {});
    res.json(parsed.data);
  });

  // Execuções em andamento (ativas e pausadas). Corretor vê as dele.
  router.get('/execucoes', async (req, res) => {
    const { imobiliariaId, role, sub } = req.auth!;
    const conds = [eq(followupExecucoes.imobiliariaId, imobiliariaId), ne(followupExecucoes.status, 'encerrada')];
    if (role === 'corretor') conds.push(eq(followupExecucoes.corretorId, sub));
    const rows = await db.select().from(followupExecucoes).where(and(...conds)).orderBy(asc(followupExecucoes.proximoEnvioEm));
    if (!rows.length) return res.json([]);

    const ls = await db.select({ id: leads.id, nome: leads.nome }).from(leads).where(inArray(leads.id, rows.map(r => r.leadId)));
    const fs = await db.select({ id: followupFluxos.id, nome: followupFluxos.nome }).from(followupFluxos).where(inArray(followupFluxos.id, rows.map(r => r.fluxoId)));
    const corrIds = [...new Set(rows.map(r => r.corretorId).filter(Boolean))] as string[];
    const ps = corrIds.length ? await db.select({ id: perfis.id, nome: perfis.nome }).from(perfis).where(inArray(perfis.id, corrIds)) : [];
    const totalPorFluxo = new Map<string, number>();
    const passosCount = await db.select({ fluxoId: followupPassos.fluxoId }).from(followupPassos).where(inArray(followupPassos.fluxoId, rows.map(r => r.fluxoId)));
    for (const p of passosCount) totalPorFluxo.set(p.fluxoId, (totalPorFluxo.get(p.fluxoId) || 0) + 1);
    const lm = new Map(ls.map(l => [l.id, l.nome]));
    const fm = new Map(fs.map(f => [f.id, f.nome]));
    const pm = new Map(ps.map(p => [p.id, p.nome]));

    res.json(rows.map(r => ({
      id: r.id, leadId: r.leadId, leadNome: lm.get(r.leadId) ?? '—',
      fluxoId: r.fluxoId, fluxoNome: fm.get(r.fluxoId) ?? '—',
      passoAtual: r.passoAtual, totalPassos: totalPorFluxo.get(r.fluxoId) ?? 0,
      status: r.status, proximoEnvioEm: r.proximoEnvioEm, motivoFim: r.motivoFim,
      corretorId: r.corretorId, corretorNome: r.corretorId ? pm.get(r.corretorId) ?? null : null,
    })));
  });

  // Inicia manualmente a régua pra um lead ("Iniciar follow-up" na aba do card).
  router.post('/execucoes', async (req, res) => {
    const parsed = z.object({ leadId: z.string().uuid(), fluxoId: z.string().uuid() }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'leadId e fluxoId obrigatórios' });
    const { imobiliariaId, role, sub } = req.auth!;

    const leadCond = role === 'corretor'
      ? and(eq(leads.id, parsed.data.leadId), eq(leads.imobiliariaId, imobiliariaId), eq(leads.corretorId, sub))
      : and(eq(leads.id, parsed.data.leadId), eq(leads.imobiliariaId, imobiliariaId));
    const [lead] = await db.select({ id: leads.id, corretorId: leads.corretorId }).from(leads).where(leadCond).limit(1);
    if (!lead) return res.status(404).json({ error: 'Lead não encontrado' });

    const r = await iniciarFollowup(io, { leadId: lead.id, fluxoId: parsed.data.fluxoId, imobiliariaId, corretorId: lead.corretorId, automatico: false });
    if (!r.ok) return res.status(400).json({ error: r.motivo || 'Não foi possível iniciar' });
    res.status(201).json({ ok: true, id: r.id });
  });

  // Pausar / retomar / encerrar. "Trocar fluxo" = encerrar + iniciar outro (POST /execucoes).
  router.patch('/execucoes/:id', async (req, res) => {
    const parsed = z.object({ status: z.enum(['ativa', 'pausada', 'encerrada']) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'status inválido' });
    const { imobiliariaId, role, sub, nome } = req.auth!;
    const cond = role === 'corretor'
      ? and(eq(followupExecucoes.id, req.params.id), eq(followupExecucoes.imobiliariaId, imobiliariaId), eq(followupExecucoes.corretorId, sub))
      : and(eq(followupExecucoes.id, req.params.id), eq(followupExecucoes.imobiliariaId, imobiliariaId));
    const [ex] = await db.select().from(followupExecucoes).where(cond).limit(1);
    if (!ex) return res.status(404).json({ error: 'Follow-up não encontrado' });
    await mudarExecucao(io, ex, parsed.data.status, nome);
    res.json({ ok: true });
  });

  return router;
}
