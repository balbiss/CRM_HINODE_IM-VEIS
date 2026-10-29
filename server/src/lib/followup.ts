/** Motor de follow-up automático — mesmas regras do CRM OKA (v1, funções followup_* + rota
 *  /followup/enviar). Resumo das regras:
 *  - 1ª mensagem sai na hora (respeita "só horário comercial" do passo, seg–sáb 8h–20h);
 *  - da 2ª em diante, só nas levas: seg–sex até 13h → manhã (a partir de 9h30), 13h–18h → 16h,
 *    depois → próximo dia útil 9h30; sábado até 15h; domingo nada;
 *  - "na próxima leva": saiu de manhã → 16h; à tarde → próxima manhã;
 *  - no máximo 1 mensagem por corretor por passada e 40–60s entre mensagens do mesmo corretor;
 *  - 1ª mensagem que não sai em 24h (WhatsApp desconectado) cancela e avisa o corretor;
 *  - para quando o cliente responde, quando o corretor manda mensagem manual, ou se o lead foi
 *    descartado / vendido / passou pra outro corretor; 3 falhas de envio → trava e avisa;
 *  - esgotou sem resposta → descarta (motivo do fluxo) se o fluxo mandar;
 *  - enquanto roda, o card fica em FOLLOW-UP AUTOMÁTICO; quando para, volta pra TAREFAS com
 *    próximo contato pra hoje (com etiqueta do motivo no histórico). */
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lte, ne, or, sql } from 'drizzle-orm';
import { notificar } from './notificar.js';
import type { Server as SocketServer } from 'socket.io';
import { db } from '../db/client.js';
import {
  followupFluxos, followupPassos, followupExecucoes, followupEnvios, followupRitmoCorretor,
  leads, perfis, imobiliarias, colunasKanban, mensagensWhatsapp, sessoesWhatsapp, notificacoes, imoveis,
} from '../db/schema.js';
import { registrarEvento } from './eventos.js';

type Exec = typeof followupExecucoes.$inferSelect;
type Passo = typeof followupPassos.$inferSelect;

const FUSO = 'America/Sao_Paulo';

// ---------- relógio de São Paulo (Brasil sem horário de verão: UTC-3 fixo) ----------
function sp(d: Date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: FUSO, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short',
  }).formatToParts(d).map(x => [x.type, x.value]));
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday);
  return { ano: +p.year, mes: +p.month, dia: +p.day, min: (+p.hour % 24) * 60 + +p.minute, dow };
}
/** dia D (+n) às hh:mm de São Paulo */
function emSp(base: { ano: number; mes: number; dia: number }, maisDias: number, hora: number, minuto = 0) {
  return new Date(Date.UTC(base.ano, base.mes - 1, base.dia + maisDias, hora + 3, minuto));
}
const HM = (h: number, m = 0) => h * 60 + m;

/** seg–sáb, 8h–20h (v1 followup_em_horario_comercial) */
export function emHorarioComercial(d = new Date()) {
  const s = sp(d);
  return s.dow >= 1 && s.dow <= 6 && s.min >= HM(8) && s.min < HM(20);
}
/** As levas estão abertas agora? seg–sex 9h30–13h30 e 16h–18h30; sáb 9h30–15h30 (v1 followup_janela_aberta) */
export function janelaAberta(d = new Date()) {
  const s = sp(d);
  if (s.dow === 0) return false;
  if (s.dow === 6) return s.min >= HM(9, 30) && s.min <= HM(15, 30);
  return (s.min >= HM(9, 30) && s.min <= HM(13, 30)) || (s.min >= HM(16) && s.min <= HM(18, 30));
}
/** Encaixa um vencimento na leva certa (v1 followup_janela_envio). */
export function janelaEnvio(venc: Date): Date {
  const s = sp(venc);
  const max = (a: Date, b: Date) => (+a > +b ? a : b);
  if (s.dow === 0) return emSp(s, 1, 9, 30);
  if (s.dow === 6) return s.min <= HM(15) ? max(venc, emSp(s, 0, 9, 30)) : emSp(s, 2, 9, 30);
  if (s.min <= HM(13)) return max(venc, emSp(s, 0, 9, 30));
  if (s.min <= HM(18)) return max(venc, emSp(s, 0, 16));
  return s.dow === 5 ? emSp(s, 3, 9, 30) : emSp(s, 1, 9, 30);
}
/** "Na próxima leva" a partir de quando a anterior saiu (v1 followup_proxima_leva). */
export function proximaLeva(d = new Date()): Date {
  const s = sp(d);
  if (s.dow === 0) return emSp(s, 1, 9, 30);
  if (s.dow === 6) return emSp(s, 2, 9, 30);
  if (s.min < HM(13)) return emSp(s, 0, 16);
  return s.dow === 5 ? emSp(s, 3, 9, 30) : emSp(s, 1, 9, 30);
}
/** Quando o passo vence (v1 followup_calc_proximo_envio). */
export function calcProximoEnvio(p: Pick<Passo, 'baseAtraso' | 'atrasoMinutos' | 'dataHoraFixa'>, inscritoEm: Date, agora = new Date()): Date {
  if (p.dataHoraFixa) return p.dataHoraFixa;
  if (p.baseAtraso === 'proxima_leva') return proximaLeva(agora);
  if (p.baseAtraso === 'inscricao') return new Date(+inscritoEm + p.atrasoMinutos * 60000);
  return new Date(+agora + p.atrasoMinutos * 60000);
}

// ---------- variáveis do texto ({nome}, {corretor}, {origem}, {bairro}, {imovel_*}) ----------
export function primeiroNome(nome: string | null | undefined) {
  return String(nome || '').trim().split(/\s+/)[0] || '';
}
export function renderTemplate(texto: string, vars: Record<string, string>) {
  return String(texto || '').replace(/\{(\w+)\}/g, (_m, k: string) => vars[k.toLowerCase()] ?? '');
}
/** Compatível com quem já chamava (Agente de IA / templates da v2 com {{nome}}). */
export function resolverVars(texto: string, ctx: { leadNome: string; corretorNome?: string | null; imobNome?: string | null; imovel?: string | null }): string {
  return (texto || '')
    .replace(/\{\{\s*primeiro_nome\s*\}\}/gi, primeiroNome(ctx.leadNome))
    .replace(/\{\{\s*nome\s*\}\}/gi, ctx.leadNome || '')
    .replace(/\{\{\s*corretor\s*\}\}/gi, ctx.corretorNome || '')
    .replace(/\{\{\s*imobiliaria\s*\}\}/gi, ctx.imobNome || '')
    .replace(/\{\{\s*imovel\s*\}\}/gi, ctx.imovel || '');
}

// ---------- utilidades ----------
const emitirLead = async (io: SocketServer, imobiliariaId: string, leadId: string) => {
  const [l] = await db.select().from(leads).where(eq(leads.id, leadId)).limit(1);
  if (l) io.to('imobiliaria:' + imobiliariaId).emit('lead:updated', l);
};
const avisarMudou = (io: SocketServer, imobiliariaId: string, leadId?: string) =>
  io.to('imobiliaria:' + imobiliariaId).emit('followup:mudou', leadId ? { leadId } : {});

async function colunaPorSlug(imobiliariaId: string, slug: string) {
  const [c] = await db.select({ id: colunasKanban.id }).from(colunasKanban)
    .where(and(eq(colunasKanban.imobiliariaId, imobiliariaId), eq(colunasKanban.slug, slug))).limit(1);
  return c?.id ?? null;
}
async function execucaoAtiva(leadId: string) {
  const [e] = await db.select().from(followupExecucoes)
    .where(and(eq(followupExecucoes.leadId, leadId), eq(followupExecucoes.status, 'ativa'))).limit(1);
  return e ?? null;
}
async function nomeFluxo(id: string) {
  const [f] = await db.select({ nome: followupFluxos.nome }).from(followupFluxos).where(eq(followupFluxos.id, id)).limit(1);
  return f?.nome ?? '';
}
/** O WhatsApp por onde o follow-up desse corretor sai está no ar? */
async function corretorConectado(imobiliariaId: string, corretorId: string) {
  const [imob] = await db.select({ modo: imobiliarias.modoWhatsapp }).from(imobiliarias).where(eq(imobiliarias.id, imobiliariaId)).limit(1);
  const [s] = await db.select({ id: sessoesWhatsapp.id }).from(sessoesWhatsapp).where(and(
    eq(sessoesWhatsapp.imobiliariaId, imobiliariaId),
    imob?.modo === 'central' ? eq(sessoesWhatsapp.escopo, 'central') : eq(sessoesWhatsapp.corretorId, corretorId),
    or(eq(sessoesWhatsapp.status, 'conectada'), eq(sessoesWhatsapp.oficialAtiva, true)),
  )).limit(1);
  return !!s;
}

/** Execução saiu do 'ativo' (menos "parado_lead"): o card volta da coluna FOLLOW-UP AUTOMÁTICO pra
 *  TAREFAS com próximo contato pra hoje (mantém data futura que o corretor já marcou). */
async function devolverPraTarefas(io: SocketServer, ex: Exec) {
  const [colFollow, colTarefas] = await Promise.all([colunaPorSlug(ex.imobiliariaId, 'followup_auto'), colunaPorSlug(ex.imobiliariaId, 'atend')]);
  if (!colFollow || !colTarefas) return;
  const agora = new Date();
  const r = await db.update(leads).set({
    colunaId: colTarefas, entrouNaColunaEm: agora,
    proximoContatoEm: sql`case when ${leads.proximoContatoEm} is null or ${leads.proximoContatoEm} < now() then now() else ${leads.proximoContatoEm} end`,
  }).where(and(eq(leads.id, ex.leadId), eq(leads.colunaId, colFollow), isNotNull(leads.corretorId))).returning({ id: leads.id });
  if (r.length) await emitirLead(io, ex.imobiliariaId, ex.leadId);
}

/** Fecha a execução com o resultado da v1 e faz o que vem junto (histórico, coluna). */
async function finalizar(io: SocketServer, ex: Exec, resultado: string, motivo: string, opts: { pausa?: boolean; log?: string | null } = {}) {
  const status = opts.pausa ? 'pausada' as const : 'encerrada' as const;
  const r = await db.update(followupExecucoes).set({
    status, resultado, motivoFim: motivo, finalizadoEm: new Date(), proximoEnvioEm: null,
    reservadoEm: null, enviandoPasso: null, enviandoDesde: null,
  }).where(and(eq(followupExecucoes.id, ex.id), eq(followupExecucoes.status, 'ativa'))).returning({ id: followupExecucoes.id });
  if (!r.length) return false;
  if (opts.log !== null) {
    registrarEvento(ex.imobiliariaId, ex.leadId, 'followup', opts.log ?? ('Follow-up "' + await nomeFluxo(ex.fluxoId) + '" encerrado: ' + motivo + '.'), null);
  }
  if (resultado !== 'parado_lead') await devolverPraTarefas(io, ex);
  avisarMudou(io, ex.imobiliariaId, ex.leadId);
  return true;
}

// ---------- iniciar ----------
interface IniciarOpts {
  leadId: string;
  fluxoId: string;
  imobiliariaId: string;
  corretorId: string | null;
  automatico: boolean;
}

/** v1 followup_iniciar_interno: precisa de corretor, fluxo ativo com passo e nenhum robô rodando. */
export async function iniciarFollowup(io: SocketServer, opts: IniciarOpts): Promise<{ ok: boolean; motivo?: string; id?: string }> {
  const [lead] = await db.select({ id: leads.id, corretorId: leads.corretorId, imobiliariaId: leads.imobiliariaId, colunaId: leads.colunaId })
    .from(leads).where(eq(leads.id, opts.leadId)).limit(1);
  if (!lead) return { ok: false, motivo: 'Lead não encontrado.' };
  const corretorId = lead.corretorId ?? opts.corretorId;
  if (!corretorId) return { ok: false, motivo: 'Lead sem corretor — não dá pra iniciar follow-up.' };
  const [fluxo] = await db.select().from(followupFluxos).where(eq(followupFluxos.id, opts.fluxoId)).limit(1);
  if (!fluxo || fluxo.imobiliariaId !== lead.imobiliariaId) return { ok: false, motivo: 'Fluxo inválido.' };
  if (!fluxo.ativo || fluxo.arquivadoEm) return { ok: false, motivo: 'Fluxo está desativado.' };
  const passos = await db.select().from(followupPassos).where(eq(followupPassos.fluxoId, fluxo.id)).orderBy(asc(followupPassos.ordem));
  if (!passos.length) return { ok: false, motivo: 'Fluxo não tem nenhum passo.' };
  if (await execucaoAtiva(lead.id)) return { ok: false, motivo: 'Este lead já tem um follow-up rodando.' };

  const agora = new Date();
  const [ex] = await db.insert(followupExecucoes).values({
    imobiliariaId: lead.imobiliariaId, leadId: lead.id, fluxoId: fluxo.id, corretorId,
    passoAtual: 0, status: 'ativa', iniciadoEm: agora, iniciadoPor: opts.automatico ? 'automatico' : 'manual',
    proximoEnvioEm: calcProximoEnvio(passos[0], agora, agora),
  }).returning();
  registrarEvento(lead.imobiliariaId, lead.id, 'followup', 'Follow-up "' + fluxo.nome + '" iniciado'
    + (opts.automatico ? ' automaticamente' : '') + ' (' + passos.length + ' passo(s)).', null);
  // card vai pra coluna FOLLOW-UP AUTOMÁTICO enquanto o robô roda
  const colFollow = await colunaPorSlug(lead.imobiliariaId, 'followup_auto');
  if (colFollow && lead.colunaId !== colFollow) {
    await db.update(leads).set({ colunaId: colFollow, entrouNaColunaEm: agora }).where(eq(leads.id, lead.id));
    await emitirLead(io, lead.imobiliariaId, lead.id);
  }
  avisarMudou(io, lead.imobiliariaId, lead.id);
  return { ok: true, id: ex.id };
}

/** v1 followup_disparo_automatico: lead ganhou corretor → fluxo da campanha do lead (se tiver) ou
 *  o fluxo Geral do corretor. Só com o follow-up automático ligado na imobiliária. Lead cadastrado à
 *  mão não dispara sozinho (manual=true). */
export async function dispararGatilhoLeadNovo(io: SocketServer, imobiliariaId: string, leadId: string, corretorId: string, manual = false) {
  try {
    if (manual) return;
    if (await execucaoAtiva(leadId)) return;
    const [imob] = await db.select({ ativo: imobiliarias.followupAutomaticoAtivo }).from(imobiliarias).where(eq(imobiliarias.id, imobiliariaId)).limit(1);
    if (!imob?.ativo) return;
    const [lead] = await db.select({ campanha: leads.campanha }).from(leads).where(eq(leads.id, leadId)).limit(1);
    let fluxoId: string | null = null;
    if (lead?.campanha) {
      const [f] = await db.select({ id: followupFluxos.id }).from(followupFluxos).where(and(
        eq(followupFluxos.imobiliariaId, imobiliariaId), eq(followupFluxos.campanha, lead.campanha),
        eq(followupFluxos.ativo, true), isNull(followupFluxos.arquivadoEm),
      )).limit(1);
      fluxoId = f?.id ?? null;
    }
    if (!fluxoId) {
      const [f] = await db.select({ id: followupFluxos.id }).from(followupFluxos).where(and(
        eq(followupFluxos.corretorId, corretorId), eq(followupFluxos.ativo, true),
        eq(followupFluxos.disparaEmLeadNovo, true), isNull(followupFluxos.arquivadoEm),
      )).limit(1);
      fluxoId = f?.id ?? null;
    }
    if (!fluxoId) return;
    await iniciarFollowup(io, { leadId, fluxoId, imobiliariaId, corretorId, automatico: true });
  } catch (e) {
    console.error('followup gatilho:', (e as Error).message);
  }
}

/** Cliente mandou mensagem → para na hora (sem esperar a passada): v1 "respondeu". */
export async function pausarPorResposta(io: SocketServer, imobiliariaId: string, leadId: string) {
  try {
    const ex = await execucaoAtiva(leadId);
    if (!ex) return;
    await marcarRespondeu(io, ex);
  } catch (e) {
    console.error('followup resposta:', (e as Error).message);
  }
}
async function marcarRespondeu(io: SocketServer, ex: Exec) {
  if (!await finalizar(io, ex, 'respondeu', 'cliente respondeu', { log: 'Follow-up "' + await nomeFluxo(ex.fluxoId) + '" encerrado: cliente respondeu. 🤖 Cliente respondeu o robô' })) return;
  // marca a última mensagem do robô como "a que fez o cliente responder" (métrica do Dashboard)
  const [ult] = await db.select({ id: followupEnvios.id }).from(followupEnvios).where(eq(followupEnvios.execucaoId, ex.id)).orderBy(desc(followupEnvios.enviadoEm)).limit(1);
  if (ult) await db.update(followupEnvios).set({ respondeuApos: true }).where(eq(followupEnvios.id, ult.id));
  if (ex.corretorId) {
    const [l] = await db.select({ nome: leads.nome, telefone: leads.telefone }).from(leads).where(eq(leads.id, ex.leadId)).limit(1);
    await notificar({ perfilId: ex.corretorId, leadId: ex.leadId, tipo: 'followup_respondido', titulo: (l?.nome || l?.telefone || 'Lead') + ' respondeu o follow-up' });
  }
}

/** Para qualquer robô rodando no lead (descarte, venda, transferência, corretor tirou da coluna...). */
export async function encerrarPorLead(io: SocketServer, imobiliariaId: string, leadId: string, motivo: string) {
  try {
    const ex = await execucaoAtiva(leadId);
    if (!ex) return;
    const tirouDaColuna = /coluna|cadência|cadencia/i.test(motivo);
    await finalizar(io, ex, tirouDaColuna ? 'pausado_corretor' : 'parado_lead', motivo, {
      pausa: tirouDaColuna,
      log: tirouDaColuna
        ? 'Follow-up "' + await nomeFluxo(ex.fluxoId) + '" pausado: ' + motivo + ' (assumiu o lead). 🤖 Robô parou: corretor assumiu'
        : undefined,
    });
  } catch (e) {
    console.error('followup encerrar:', (e as Error).message);
  }
}

// ---------- pausar / retomar / encerrar / trocar (tela) ----------
export async function mudarExecucao(io: SocketServer, ex: Exec, acao: 'pausada' | 'ativa' | 'encerrada', ator: string) {
  if (acao === 'encerrada') {
    if (ex.status === 'encerrada') return;
    await db.update(followupExecucoes).set({ status: 'encerrada', resultado: 'encerrado_manual', motivoFim: 'encerrado manualmente', finalizadoEm: new Date(), proximoEnvioEm: null })
      .where(eq(followupExecucoes.id, ex.id));
    registrarEvento(ex.imobiliariaId, ex.leadId, 'followup', 'Follow-up "' + await nomeFluxo(ex.fluxoId) + '" encerrado manualmente.', ator);
    if (ex.status === 'ativa') await devolverPraTarefas(io, ex);
  } else if (acao === 'pausada') {
    if (ex.status !== 'ativa') return;
    await db.update(followupExecucoes).set({ status: 'pausada', resultado: 'pausado_corretor', motivoFim: 'pausado manualmente', reservadoEm: null })
      .where(eq(followupExecucoes.id, ex.id));
    registrarEvento(ex.imobiliariaId, ex.leadId, 'followup', 'Follow-up "' + await nomeFluxo(ex.fluxoId) + '" pausado.', ator);
  } else {
    if (ex.status !== 'pausada') return;
    if (await execucaoAtiva(ex.leadId)) return;
    // retomar: 1ª mensagem ainda não saiu → agora; senão na próxima leva
    await db.update(followupExecucoes).set({
      status: 'ativa', resultado: null, motivoFim: null, finalizadoEm: null, tentativasErro: 0,
      proximoEnvioEm: ex.passoAtual === 0 ? new Date() : janelaEnvio(new Date()),
    }).where(eq(followupExecucoes.id, ex.id));
    registrarEvento(ex.imobiliariaId, ex.leadId, 'followup', 'Follow-up "' + await nomeFluxo(ex.fluxoId) + '" retomado.', ator);
  }
  avisarMudou(io, ex.imobiliariaId, ex.leadId);
}

// ---------- passada do motor (v1 followup_proximo_lote + /followup/enviar) ----------
let rodando = false;

export async function varrerFollowups(io: SocketServer, limite = 25): Promise<number> {
  if (rodando) return 0; // nunca duas passadas ao mesmo tempo (era o que mandava o mesmo passo 2x na v1)
  rodando = true;
  try {
    await limparParados(io);
    const lote = await escolherLote(limite);
    let enviados = 0;
    for (const ex of lote) {
      try {
        if (await enviarPasso(io, ex)) enviados++;
      } catch (e) {
        console.error('followup envio (execução ' + ex.id + '):', (e as Error).message);
        await registrarErro(io, ex, (e as Error).message);
      }
    }
    return enviados;
  } finally {
    rodando = false;
  }
}

/** Antes de mandar: cancela 1º contato velho, e encerra quem respondeu / corretor assumiu / lead mudou. */
async function limparParados(io: SocketServer) {
  const ativas = await db.select().from(followupExecucoes).where(eq(followupExecucoes.status, 'ativa'));
  const agora = Date.now();
  for (const ex of ativas) {
    // 1ª mensagem que não saiu em 24h: cancela (não manda "oi, vi seu cadastro" dias depois)
    if (ex.passoAtual === 0 && agora - +ex.iniciadoEm > 24 * 3600000) {
      const ok = await finalizar(io, ex, 'encerrado_manual', 'cancelado: 1ª mensagem não saiu em 24h (WhatsApp do corretor desconectado?)', {
        log: 'Follow-up automático cancelado: a 1ª mensagem não saiu em 24h (WhatsApp do corretor estava desconectado). Faça o contato manualmente. 🤖 Robô não conseguiu enviar',
      });
      if (ok && ex.corretorId) {
        const [l] = await db.select({ nome: leads.nome, telefone: leads.telefone }).from(leads).where(eq(leads.id, ex.leadId)).limit(1);
        await notificar({ perfilId: ex.corretorId, leadId: ex.leadId, tipo: 'followup_erro', titulo: 'Follow-up cancelado (WhatsApp desconectado) — faça contato manual com ' + (l?.nome || l?.telefone || 'o lead') });
      }
      continue;
    }
    const msgs = await db.select({ direcao: mensagensWhatsapp.direcao, canal: mensagensWhatsapp.canal }).from(mensagensWhatsapp)
      .where(and(eq(mensagensWhatsapp.leadId, ex.leadId), gt(mensagensWhatsapp.enviadoEm, ex.iniciadoEm)));
    if (msgs.some(m => m.direcao === 'in')) { await marcarRespondeu(io, ex); continue; }
    if (msgs.some(m => m.direcao === 'out' && m.canal !== 'followup')) {
      await finalizar(io, ex, 'pausado_corretor', 'corretor assumiu a conversa', {
        pausa: true, log: 'Follow-up "' + await nomeFluxo(ex.fluxoId) + '" encerrado: corretor assumiu a conversa. 🤖 Robô parou: corretor assumiu',
      });
      continue;
    }
    const [l] = await db.select().from(leads).where(eq(leads.id, ex.leadId)).limit(1);
    if (!l) { await finalizar(io, ex, 'parado_lead', 'lead removido', { log: null }); continue; }
    if (l.descartadoEm || l.vendaPendenteAprovacao || l.dataFechamento || l.corretorId !== ex.corretorId) {
      const motivo = l.descartadoEm ? 'lead descartado' : l.corretorId !== ex.corretorId ? 'lead transferido para outro corretor' : 'lead vendido';
      await finalizar(io, ex, 'parado_lead', motivo);
    }
  }
}

/** Candidatos: venceu, liberado (manual ou automático ligado), na janela, WhatsApp do corretor no ar;
 *  1 por corretor, 1º contato primeiro, nada em voo e ritmo de 40–60s respeitado. */
async function escolherLote(limite: number): Promise<Exec[]> {
  const agora = new Date();
  const vencidas = await db.select().from(followupExecucoes)
    .where(and(eq(followupExecucoes.status, 'ativa'), lte(followupExecucoes.proximoEnvioEm, agora)))
    .orderBy(asc(followupExecucoes.proximoEnvioEm));
  if (!vencidas.length) return [];
  const autoLigado = new Map<string, boolean>();
  const porCorretor = new Map<string, Exec>();
  const emVoo = new Set((await db.select({ c: followupExecucoes.corretorId }).from(followupExecucoes).where(and(
    eq(followupExecucoes.status, 'ativa'), gt(followupExecucoes.reservadoEm, new Date(+agora - 15 * 60000)),
  ))).map(r => r.c));
  const ritmo = new Map((await db.select().from(followupRitmoCorretor)).map(r => [r.corretorId, r.liberadoEm]));
  const conectado = new Map<string, boolean>();

  for (const ex of vencidas) {
    if (!ex.corretorId || emVoo.has(ex.corretorId)) continue;
    const lib = ritmo.get(ex.corretorId);
    if (lib && +lib > +agora) continue;
    if (ex.iniciadoPor !== 'manual') {
      if (!autoLigado.has(ex.imobiliariaId)) {
        const [i] = await db.select({ a: imobiliarias.followupAutomaticoAtivo }).from(imobiliarias).where(eq(imobiliarias.id, ex.imobiliariaId)).limit(1);
        autoLigado.set(ex.imobiliariaId, !!i?.a);
      }
      if (!autoLigado.get(ex.imobiliariaId)) continue;
    }
    const [passo] = await db.select().from(followupPassos).where(and(eq(followupPassos.fluxoId, ex.fluxoId), eq(followupPassos.ordem, ex.passoAtual))).limit(1);
    if (!passo) continue;
    if (passo.soHorarioComercial && !emHorarioComercial(agora)) continue;
    if (ex.passoAtual > 0 && !janelaAberta(agora)) continue;
    if (!conectado.has(ex.corretorId)) conectado.set(ex.corretorId, await corretorConectado(ex.imobiliariaId, ex.corretorId));
    if (!conectado.get(ex.corretorId)) continue;
    const atual = porCorretor.get(ex.corretorId);
    // por corretor: o 1º contato (passo 1) vem antes; depois o que venceu primeiro
    if (!atual || (ex.passoAtual === 0 && atual.passoAtual !== 0)) porCorretor.set(ex.corretorId, ex);
  }
  const escolhidos = [...porCorretor.values()]
    .sort((a, b) => (a.passoAtual === 0 ? 0 : 1) - (b.passoAtual === 0 ? 0 : 1) || +a.proximoEnvioEm! - +b.proximoEnvioEm!)
    .slice(0, limite);
  if (!escolhidos.length) return [];
  // reserva por 30 min (se o envio der certo o próximo passo sobrescreve; se falhar, volta em 5 min)
  const reservadas = await db.update(followupExecucoes)
    .set({ proximoEnvioEm: new Date(+agora + 30 * 60000), reservadoEm: agora })
    .where(and(inArray(followupExecucoes.id, escolhidos.map(e => e.id)), eq(followupExecucoes.status, 'ativa'), lte(followupExecucoes.proximoEnvioEm, agora)))
    .returning();
  return escolhidos.filter(e => reservadas.some(r => r.id === e.id)).map(e => reservadas.find(r => r.id === e.id)!);
}

/** Um passo: reivindica, monta o texto, manda pelo WhatsApp, grava e agenda o próximo. */
async function enviarPasso(io: SocketServer, ex: Exec): Promise<boolean> {
  const [passo] = await db.select().from(followupPassos).where(and(eq(followupPassos.fluxoId, ex.fluxoId), eq(followupPassos.ordem, ex.passoAtual))).limit(1);
  const [lead] = await db.select().from(leads).where(eq(leads.id, ex.leadId)).limit(1);
  if (!passo || !lead) { await db.update(followupExecucoes).set({ reservadoEm: null }).where(eq(followupExecucoes.id, ex.id)); return false; }

  // reivindica: confere de novo, imediatamente antes de mandar, que nada mudou desde o lote
  const [atual] = await db.select().from(followupExecucoes).where(eq(followupExecucoes.id, ex.id)).limit(1);
  if (!atual || atual.status !== 'ativa' || atual.passoAtual !== ex.passoAtual) return false;
  if (atual.enviandoPasso === ex.passoAtual && atual.enviandoDesde && Date.now() - +atual.enviandoDesde < 10 * 60000) return false;
  if (lead.descartadoEm || lead.corretorId !== ex.corretorId) { await db.update(followupExecucoes).set({ reservadoEm: null }).where(eq(followupExecucoes.id, ex.id)); return false; }
  const [conversa] = await db.select({ id: mensagensWhatsapp.id }).from(mensagensWhatsapp).where(and(
    eq(mensagensWhatsapp.leadId, ex.leadId), gt(mensagensWhatsapp.enviadoEm, ex.iniciadoEm),
    or(eq(mensagensWhatsapp.direcao, 'in'), and(eq(mensagensWhatsapp.direcao, 'out'), ne(mensagensWhatsapp.canal, 'followup'))),
  )).limit(1);
  if (conversa) { await db.update(followupExecucoes).set({ reservadoEm: null }).where(eq(followupExecucoes.id, ex.id)); return false; }
  await db.update(followupExecucoes).set({ enviandoPasso: ex.passoAtual, enviandoDesde: new Date() }).where(eq(followupExecucoes.id, ex.id));

  // texto: {nome} = primeiro nome; imóvel casado pela referência do anúncio (= origem do lead)
  const [corr] = ex.corretorId ? await db.select({ nome: perfis.nome }).from(perfis).where(eq(perfis.id, ex.corretorId)).limit(1) : [];
  const origem = lead.referencia || lead.campanha || '';
  const [imovel] = origem
    ? await db.select().from(imoveis).where(and(eq(imoveis.imobiliariaId, ex.imobiliariaId), eq(imoveis.referenciaAnuncio, origem))).limit(1)
    : [];
  const pedeFoto = /\{imovel_foto\}/i.test(passo.conteudo || '');
  const semFoto = (passo.conteudo || '').replace(/\n?\s*\{imovel_foto\}\s*\n?/gi, '\n').trim();
  const texto = semFoto ? renderTemplate(semFoto, {
    nome: primeiroNome(lead.nome), corretor: corr?.nome ?? '', origem, bairro: lead.bairroInteresse ?? '',
    imovel_titulo: imovel?.titulo ?? '', imovel_descricao: imovel?.descricao ?? '',
    imovel_preco: imovel?.preco ? Number(imovel.preco).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) : '',
  }) : '';
  let anexoUrl = passo.anexoUrl ?? null;
  let anexoTipo = normalizarTipo(passo.anexoTipo ?? passo.tipo);
  let anexoNome = passo.anexoNome ?? null;
  if (!anexoUrl && pedeFoto && imovel?.imagens?.[0]) { anexoUrl = imovel.imagens[0]; anexoTipo = 'imagem'; anexoNome = 'foto-imovel.jpg'; }
  if (!anexoUrl) anexoTipo = null;
  if (!texto && !anexoUrl) { await registrarErro(io, ex, 'passo sem texto nem anexo'); return false; }

  const { despacharPeloWhatsapp } = await import('../routes/whatsapp.js');
  let r = await despacharPeloWhatsapp({
    imobiliariaId: ex.imobiliariaId, leadId: lead.id, telefone: lead.telefone, corretorId: ex.corretorId, sessaoWhatsappId: lead.sessaoWhatsappId,
    texto: texto || null, anexoUrl, anexoTipo, anexoNome,
  });
  if (!r.enviado && r.erro === 'NUMERO_INEXISTENTE' && lead.telefoneAlternativo) {
    r = await despacharPeloWhatsapp({
      imobiliariaId: ex.imobiliariaId, leadId: lead.id, telefone: lead.telefoneAlternativo, corretorId: ex.corretorId, sessaoWhatsappId: lead.sessaoWhatsappId,
      texto: texto || null, anexoUrl, anexoTipo, anexoNome,
    });
  }
  if (!r.enviado) {
    await registrarErro(io, ex, r.erro === 'NUMERO_INEXISTENTE' ? 'número não encontrado no WhatsApp (ou conexão momentaneamente fora do ar)' : (r.erro || 'falha no envio'));
    return false;
  }

  const [msg] = await db.insert(mensagensWhatsapp).values({
    leadId: lead.id, direcao: 'out', canal: 'followup', enviadoPor: ex.corretorId, ackStatus: r.waMessageId ? 2 : 1,
    waMessageId: r.waMessageId ?? null, waChave: r.waChave ?? null, lida: true,
    texto: texto || null, anexoUrl, anexoTipo, anexoNome,
  }).onConflictDoNothing().returning();
  if (msg) io.to('imobiliaria:' + ex.imobiliariaId).emit('mensagem:created', msg);
  await registrarEnvio(io, ex, texto, r.waMessageId ?? null, msg?.id ?? null);
  return true;
}

function normalizarTipo(t: string | null | undefined): 'imagem' | 'video' | 'audio' | 'documento' | null {
  if (!t || t === 'texto') return null;
  if (t === 'imagem' || t === 'image') return 'imagem';
  if (t === 'video') return 'video';
  if (t === 'audio') return 'audio';
  return 'documento';
}

/** v1 followup_registrar_envio: grava o envio, ritmo do corretor, +1 na cadência, próximo passo ou fim. */
async function registrarEnvio(io: SocketServer, ex: Exec, texto: string, waMessageId: string | null, mensagemId: string | null) {
  const agora = new Date();
  await db.insert(followupEnvios).values({ execucaoId: ex.id, passoOrdem: ex.passoAtual + 1, conteudoEnviado: texto, waMessageId, mensagemId });
  const liberado = new Date(+agora + (40 + Math.floor(Math.random() * 21)) * 1000);
  await db.insert(followupRitmoCorretor).values({ corretorId: ex.corretorId!, liberadoEm: liberado })
    .onConflictDoUpdate({ target: followupRitmoCorretor.corretorId, set: { liberadoEm: liberado } });
  const [l] = await db.update(leads).set({
    cadenciaChamada: sql`least(${leads.cadenciaChamada} + 1, 5)`, dataUltimaChamada: agora, ultimaAcaoEm: agora,
  }).where(eq(leads.id, ex.leadId)).returning();
  if (l) {
    await db.update(leads).set({ cadencia: 'Chamada ' + l.cadenciaChamada }).where(eq(leads.id, l.id));
  }

  const passos = await db.select().from(followupPassos).where(eq(followupPassos.fluxoId, ex.fluxoId)).orderBy(asc(followupPassos.ordem));
  const prox = passos.find(p => p.ordem === ex.passoAtual + 1);
  const [fluxo] = await db.select().from(followupFluxos).where(eq(followupFluxos.id, ex.fluxoId)).limit(1);
  if (prox) {
    await db.update(followupExecucoes).set({
      passoAtual: ex.passoAtual + 1, proximoEnvioEm: janelaEnvio(calcProximoEnvio(prox, ex.iniciadoEm, agora)),
      tentativasErro: 0, enviandoPasso: null, enviandoDesde: null, reservadoEm: null,
    }).where(eq(followupExecucoes.id, ex.id));
    registrarEvento(ex.imobiliariaId, ex.leadId, 'followup', 'Follow-up "' + (fluxo?.nome ?? '') + '" enviou o passo ' + (ex.passoAtual + 1) + ' de ' + passos.length + '.', null);
    await emitirLead(io, ex.imobiliariaId, ex.leadId);
    avisarMudou(io, ex.imobiliariaId, ex.leadId);
    return;
  }

  // acabaram os passos sem resposta
  await db.update(followupExecucoes).set({ passoAtual: ex.passoAtual + 1, enviandoPasso: null, enviandoDesde: null, reservadoEm: null }).where(eq(followupExecucoes.id, ex.id));
  const exFim = { ...ex, passoAtual: ex.passoAtual + 1 };
  if (fluxo?.aoEsgotar === 'descartar') {
    const rebatida = await colunaPorSlug(ex.imobiliariaId, 'rebatida');
    await db.update(leads).set({
      corretorId: null, colunaId: rebatida ?? undefined, motivoDescarte: fluxo.motivoDescarteEsgotar, descartadoPor: ex.corretorId,
      descartadoEm: agora, proximoContatoEm: null, dataVisita: null, ultimaAcaoEm: agora, entrouNaColunaEm: agora,
    }).where(and(eq(leads.id, ex.leadId), isNull(leads.descartadoEm), eq(leads.corretorId, ex.corretorId!)));
    await finalizar(io, exFim, 'concluido', 'esgotado sem resposta -> lead descartado', {
      log: 'Follow-up "' + fluxo.nome + '": ' + passos.length + ' de ' + passos.length + ' passo(s) enviado(s) sem resposta. Lead descartado automaticamente (motivo: ' + fluxo.motivoDescarteEsgotar + ').',
    });
    await emitirLead(io, ex.imobiliariaId, ex.leadId);
  } else if (fluxo?.aoEsgotar === 'mover' && fluxo.aoEsgotarColunaId) {
    await finalizar(io, exFim, 'parado_lead', 'concluído sem resposta', { log: 'Follow-up "' + fluxo.nome + '" concluído: ' + passos.length + ' passo(s) enviado(s), sem resposta do cliente.' });
    await db.update(leads).set({ colunaId: fluxo.aoEsgotarColunaId, entrouNaColunaEm: agora }).where(eq(leads.id, ex.leadId));
    await emitirLead(io, ex.imobiliariaId, ex.leadId);
  } else {
    await finalizar(io, exFim, 'concluido', 'concluído sem resposta', {
      log: 'Follow-up "' + (fluxo?.nome ?? '') + '" concluído: ' + passos.length + ' passo(s) enviado(s), sem resposta do cliente. 🤖 Robô terminou sem resposta',
    });
  }
}

/** v1 followup_registrar_erro: tenta de novo em 5 min; na 3ª falha trava e avisa corretor + gestão. */
async function registrarErro(io: SocketServer, ex: Exec, erro: string) {
  const [atual] = await db.select().from(followupExecucoes).where(and(eq(followupExecucoes.id, ex.id), eq(followupExecucoes.status, 'ativa'))).limit(1);
  if (!atual) return;
  const desistiu = atual.tentativasErro + 1 >= 3;
  await db.update(followupExecucoes).set({
    tentativasErro: atual.tentativasErro + 1, motivoFim: erro.slice(0, 500),
    proximoEnvioEm: new Date(Date.now() + 5 * 60000), enviandoPasso: null, enviandoDesde: null, reservadoEm: null,
    ...(desistiu ? { status: 'pausada' as const, resultado: 'erro', finalizadoEm: new Date() } : {}),
  }).where(eq(followupExecucoes.id, ex.id));
  if (!desistiu) return;
  const [l] = await db.select({ nome: leads.nome }).from(leads).where(eq(leads.id, ex.leadId)).limit(1);
  registrarEvento(ex.imobiliariaId, ex.leadId, 'followup', 'Follow-up "' + await nomeFluxo(ex.fluxoId) + '" travado após 3 tentativas de envio sem sucesso ('
    + erro + '). Mande mensagem manual pra esse lead. 🤖 Robô não conseguiu enviar', null);
  if (ex.corretorId) await notificar({ perfilId: ex.corretorId, leadId: ex.leadId, tipo: 'followup_erro', titulo: 'Follow-up travado — mande mensagem manual pra ' + (l?.nome || 'esse lead') });
  const gestores = await db.select({ id: perfis.id }).from(perfis).where(and(eq(perfis.imobiliariaId, ex.imobiliariaId), inArray(perfis.role, ['dono', 'gerente'])));
  if (gestores.length) {
    await notificar(gestores.map(g => ({ perfilId: g.id, leadId: ex.leadId, tipo: 'followup_erro', titulo: 'Follow-up travado (falha de envio) — lead: ' + (l?.nome || 'sem nome') })));
  }
  await devolverPraTarefas(io, ex);
  avisarMudou(io, ex.imobiliariaId, ex.leadId);
}
