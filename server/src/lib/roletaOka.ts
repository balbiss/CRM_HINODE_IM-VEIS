/** Roleta com as regras do CRM OKA (v1):
 *  - expediente: seg–sex até 18:20, quinta até 19:30, sábado até 15:20, domingo fechado. Fora disso
 *    ninguém recebe e o "disponível" de todo mundo desliga sozinho;
 *  - recebe quem está disponível, fora do almoço, não bloqueado, com menos de 3 advertências na semana e
 *    ativo no turno; o 1º da fila recebe e vai pro fim;
 *  - ligar o "disponível" depois das 14h dá advertência e não entra no turno; 3 advertências na semana
 *    tiram da roleta até a semana virar;
 *  - SLA: lead novo sem nenhum contato do corretor em 5 min passa pro próximo da fila (até 3 vezes);
 *    depois vai pro bolsão (REBATIDA). */
import { and, asc, eq, gt, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import type { Server as SocketServer } from 'socket.io';
import { db } from '../db/client.js';
import { perfis, filasAtendimento, leads, colunasKanban, distribuicaoLog, mensagensWhatsapp } from '../db/schema.js';
import { registrarEvento } from './eventos.js';
import { notificar } from './notificar.js';

const FUSO = 'America/Sao_Paulo';
export const SLA_SEGUNDOS = 300;

function sp(d: Date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: FUSO, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short',
  }).formatToParts(d).map(x => [x.type, x.value]));
  return { ano: +p.year, mes: +p.month, dia: +p.day, min: (+p.hour % 24) * 60 + +p.minute, dow: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday) };
}
/** Minuto do dia em que a roleta fecha (null = não abre). */
export function corteDoDia(d = new Date()): number | null {
  const s = sp(d);
  if (s.dow === 0) return null;
  return s.dow === 4 ? 19 * 60 + 30 : s.dow === 6 ? 15 * 60 + 20 : 18 * 60 + 20;
}
export function expedienteAberto(d = new Date()) {
  const corte = corteDoDia(d);
  return corte !== null && sp(d).min < corte;
}
export const HORARIO_ROLETA = 'A roleta funciona de segunda a sábado: até 18:20 (quinta até 19:30, sábado até 15:20). Domingo fechada.';
/** Segunda-feira da semana (YYYY-MM-DD) — as advertências zeram quando a semana vira. */
export function inicioSemana(d = new Date()) {
  const s = sp(d);
  const dt = new Date(Date.UTC(s.ano, s.mes - 1, s.dia - ((s.dow + 6) % 7)));
  return dt.toISOString().slice(0, 10);
}

/** Ligar o "disponível na roleta" (v1 entrar_na_roleta). Devolve se entrou no turno e as advertências. */
export async function entrarNaRoleta(corretorId: string, agora = new Date()) {
  const [p] = await db.select().from(perfis).where(eq(perfis.id, corretorId)).limit(1);
  if (!p) throw new Error('Corretor não encontrado');
  const semana = inicioSemana(agora);
  let advertencias = p.advertenciaSemanaInicio === semana ? p.advertenciasSemana : 0;
  const atrasado = sp(agora).min > 14 * 60;
  if (atrasado) advertencias += 1;
  const ativo = !atrasado && advertencias < 3;
  await db.update(perfis).set({ emPlantao: true, advertenciasSemana: advertencias, advertenciaSemanaInicio: semana }).where(eq(perfis.id, corretorId));
  // em todas as roletas de que participa: entrou no turno → vai pro fim da fila; atrasado → fica de fora do turno
  const filas = await db.select().from(filasAtendimento).where(eq(filasAtendimento.corretorId, corretorId));
  for (const f of filas) {
    if (ativo) {
      const [m] = await db.select({ max: sql<number>`coalesce(max(${filasAtendimento.posicao}), 0)` }).from(filasAtendimento)
        .where(f.roletaId ? eq(filasAtendimento.roletaId, f.roletaId) : eq(filasAtendimento.imobiliariaId, f.imobiliariaId));
      await db.update(filasAtendimento).set({ posicao: Number(m.max) + 1, ativoNoTurno: true }).where(eq(filasAtendimento.id, f.id));
    } else {
      await db.update(filasAtendimento).set({ ativoNoTurno: false }).where(eq(filasAtendimento.id, f.id));
    }
  }
  return { ativo, atrasado, advertencias };
}

/** Escolhe e trava o próximo da fila da roleta (o 1º elegível vai pro fim). */
export async function proximoDaFilaOka(roletaId: string, agora = new Date()): Promise<string | null> {
  if (!expedienteAberto(agora)) return null;
  const semana = inicioSemana(agora);
  return db.transaction(async tx => {
    await tx.execute(sql`select id from roletas where id = ${roletaId} for update`);
    const [c] = await tx.select({ corretorId: filasAtendimento.corretorId, id: filasAtendimento.id })
      .from(filasAtendimento).innerJoin(perfis, eq(perfis.id, filasAtendimento.corretorId))
      .where(and(
        eq(filasAtendimento.roletaId, roletaId), eq(filasAtendimento.ativoNoTurno, true),
        eq(perfis.emPlantao, true), eq(perfis.emAlmoco, false), eq(perfis.bloqueado, false), isNull(perfis.removidoEm),
        sql`(${perfis.advertenciaSemanaInicio} is distinct from ${semana} or ${perfis.advertenciasSemana} < 3)`,
      ))
      .orderBy(asc(filasAtendimento.posicao)).limit(1);
    if (!c) return null;
    const [m] = await tx.select({ max: sql<number>`coalesce(max(${filasAtendimento.posicao}), 0)` }).from(filasAtendimento).where(eq(filasAtendimento.roletaId, roletaId));
    await tx.update(filasAtendimento).set({ posicao: Number(m.max) + 1, ultimaAtribuicao: agora }).where(eq(filasAtendimento.id, c.id));
    return c.corretorId;
  });
}

let ultimoCorte = '';
/** No horário de fechamento, desliga o "disponível" de todo mundo (v1 auto_offline_fim_de_expediente). */
export async function desligarFimDeExpediente(io: SocketServer, agora = new Date()) {
  if (expedienteAberto(agora)) return;
  const chave = agora.toISOString().slice(0, 16);
  if (chave === ultimoCorte) return;
  ultimoCorte = chave;
  const desligados = await db.update(perfis).set({ emPlantao: false }).where(eq(perfis.emPlantao, true))
    .returning({ id: perfis.id, imobiliariaId: perfis.imobiliariaId });
  for (const p of desligados) io.to('imobiliaria:' + p.imobiliariaId).emit('fila:atualizada', { corretorId: p.id, emPlantao: false });
}

/** SLA de 5 min (v1 reassign_overdue_leads): lead em LEAD NOVO, com corretor, sem nenhum contato. */
export async function reatribuirSlaVencido(io: SocketServer, agora = new Date()) {
  const limite = new Date(+agora - SLA_SEGUNDOS * 1000);
  const vencidos = await db.select({ id: leads.id, imobiliariaId: leads.imobiliariaId, corretorId: leads.corretorId, dataAtribuicao: leads.dataAtribuicao, nome: leads.nome, telefone: leads.telefone, ultimaAcaoEm: leads.ultimaAcaoEm })
    .from(leads).innerJoin(colunasKanban, eq(colunasKanban.id, leads.colunaId))
    .where(and(
      eq(colunasKanban.slug, 'novo'), isNotNull(leads.corretorId), isNull(leads.primeiroContatoEm), isNull(leads.descartadoEm),
      isNotNull(leads.dataAtribuicao), lte(leads.dataAtribuicao, limite),
    ));
  for (const l of vencidos) {
    // qualquer ação do corretor no card ou mensagem enviada depois de receber conta como 1º contato
    const [msg] = await db.select({ id: mensagensWhatsapp.id }).from(mensagensWhatsapp)
      .where(and(eq(mensagensWhatsapp.leadId, l.id), eq(mensagensWhatsapp.direcao, 'out'), gt(mensagensWhatsapp.enviadoEm, l.dataAtribuicao!))).limit(1);
    if (msg || (l.ultimaAcaoEm && +l.ultimaAcaoEm > +l.dataAtribuicao!)) {
      await db.update(leads).set({ primeiroContatoEm: msg ? agora : l.ultimaAcaoEm }).where(eq(leads.id, l.id));
      continue;
    }
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(distribuicaoLog)
      .where(and(eq(distribuicaoLog.leadId, l.id), eq(distribuicaoLog.origem, 'automatico')));
    if (n >= 3) {
      const [reb] = await db.select({ id: colunasKanban.id }).from(colunasKanban).where(and(eq(colunasKanban.imobiliariaId, l.imobiliariaId), eq(colunasKanban.slug, 'rebatida'))).limit(1);
      const [row] = await db.update(leads).set({ corretorId: null, colunaId: reb?.id, entrouNaColunaEm: agora }).where(eq(leads.id, l.id)).returning();
      registrarEvento(l.imobiliariaId, l.id, 'roleta', 'Ninguém atendeu em 5 min depois de 3 tentativas — lead foi pro bolsão', 'Roleta');
      io.to('imobiliaria:' + l.imobiliariaId).emit('lead:updated', row);
      continue;
    }
    const { roletaDoLead } = await import('./roleta.js');
    const roletaId = await roletaDoLead(l.imobiliariaId, l.id);
    const proximo = roletaId ? await proximoDaFilaOka(roletaId, agora) : null;
    if (!proximo || proximo === l.corretorId) continue;
    const [row] = await db.update(leads).set({ corretorId: proximo, dataAtribuicao: agora, entrouNaColunaEm: agora })
      .where(and(eq(leads.id, l.id), eq(leads.corretorId, l.corretorId!))).returning();
    if (!row) continue;
    await db.insert(distribuicaoLog).values({ imobiliariaId: l.imobiliariaId, leadId: l.id, corretorId: proximo, origem: 'automatico', roletaId });
    const [nomes] = await db.select({ nome: perfis.nome }).from(perfis).where(eq(perfis.id, proximo)).limit(1);
    registrarEvento(l.imobiliariaId, l.id, 'roleta', 'Sem atendimento em 5 min — passou para ' + (nomes?.nome ?? 'o próximo da fila'), 'Roleta');
    await notificar({ perfilId: proximo, leadId: l.id, tipo: 'lead_novo_atribuido', titulo: 'Novo lead recebido: ' + (l.nome || l.telefone) });
    io.to('imobiliaria:' + l.imobiliariaId).emit('lead:updated', row);
  }
}

/** Corretores ainda em almoço / com advertência estourada aparecem na tela da roleta. */
export async function estadoRoleta(imobiliariaId: string) {
  const semana = inicioSemana();
  const rows = await db.select({ id: perfis.id, emAlmoco: perfis.emAlmoco, adv: perfis.advertenciasSemana, sem: perfis.advertenciaSemanaInicio })
    .from(perfis).where(eq(perfis.imobiliariaId, imobiliariaId));
  return rows.map(r => ({ corretorId: r.id, emAlmoco: r.emAlmoco, advertencias: r.sem === semana ? r.adv : 0 }));
}
