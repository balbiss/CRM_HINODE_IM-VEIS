/** Regras de negócio herdadas do CRM OKA (v1) — Kanban, cadência, descarte, venda e transferência.
 *  Ficam no servidor (não só na tela) pra valer igual vindo do card, do Kanban, do assistente de voz
 *  ou de qualquer automação. Referência: manual da v1 (src/routes/manual.tsx do repo imocrm). */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { notificar } from './notificar.js';
import { db } from '../db/client.js';
import { colunasKanban, leads, perfis, distribuicaoLog, notificacoes } from '../db/schema.js';

export const FUSO = 'America/Sao_Paulo';

/** Descartes que só valem depois da aprovação do dono/gerente. */
export const MOTIVOS_DESCARTE_EXTREMO = [
  'Descadastrar', 'Já Comprou (Outra Empresa)', 'Contato Errado',
  'Descadastrar (Idoso)', 'Descadastrar (Outra Região)', 'Descadastrar (Número Errado)',
];
/** Desses, só estes exigem observação escrita (o motivo dos outros já explica). */
export const MOTIVOS_DESCARTE_OBS_OBRIGATORIA = ['Descadastrar', 'Já Comprou (Outra Empresa)', 'Contato Errado'];
/** Descarte normal: vai pro bolsão na hora, qualquer corretor pode puxar de novo. */
export const MOTIVOS_DESCARTE_NORMAL = ['Sem Resposta', 'Parou de Responder', 'Sem Interesse', 'Aprovado/Desistiu', 'Sem Interesse (Renda Baixa)'];

/** Mover pra essas colunas exige um próximo contato marcado no futuro (pede a data junto). */
export const SLUGS_EXIGEM_PROXIMO_CONTATO = ['conversando', 'visitou', 'cobrar_doc', 'pendente', 'aprovado', 'reprovado', 'restricao', 'futuros'];
/** Agendado/FID: a data do compromisso é o próprio motivo da coluna. */
export const SLUGS_EXIGEM_AGENDAMENTO = ['visita', 'fid'];

/** Partes da data/hora em São Paulo (o servidor roda em UTC). */
function partesSp(d: Date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: FUSO, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short',
  }).formatToParts(d).map(x => [x.type, x.value]));
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday);
  return { ano: +p.year, mes: +p.month, dia: +p.day, hora: +p.hour % 24, minuto: +p.minute, dow };
}
/** Date pra "dia D às H:M de São Paulo" (Brasil sem horário de verão: UTC-3 fixo). */
function emSp(ano: number, mes: number, dia: number, hora: number, minuto = 0) {
  return new Date(Date.UTC(ano, mes - 1, dia, hora + 3, minuto));
}
export function hojeSp(agora = new Date()) {
  const p = partesSp(agora);
  return `${p.ano}-${String(p.mes).padStart(2, '0')}-${String(p.dia).padStart(2, '0')}`;
}

/** Próximo contato depois de registrar uma chamada (regra do dono, v1 04/08 + 17/08):
 *  antes das 13h → mesmo dia às 17h; a partir das 13h (ou sábado, que a equipe sai às 15h) →
 *  próximo dia às 11h, pulando domingo. */
export function calcularProximaCadencia(agora = new Date()): Date {
  const p = partesSp(agora);
  if (p.hora < 13 && p.dow !== 6) return emSp(p.ano, p.mes, p.dia, 17);
  let alvo = emSp(p.ano, p.mes, p.dia + 1, 11);
  if (partesSp(alvo).dow === 0) alvo = emSp(p.ano, p.mes, p.dia + 2, 11);
  return alvo;
}

export async function colunaPorSlug(imobiliariaId: string, slug: string) {
  const [c] = await db.select({ id: colunasKanban.id, titulo: colunasKanban.titulo }).from(colunasKanban)
    .where(and(eq(colunasKanban.imobiliariaId, imobiliariaId), eq(colunasKanban.slug, slug))).limit(1);
  return c ?? null;
}

/** Venda já aprovada = estado final: card não muda mais de coluna. */
export function vendaFechada(l: { dataFechamento: Date | null; vendaPendenteAprovacao: boolean }) {
  return !!l.dataFechamento && !l.vendaPendenteAprovacao;
}

/** Transferir/distribuir leads pra um corretor — mesma regra da v1 (distribuir_leads_massa):
 *  lead que não tinha corretor vai pra LEAD NOVO; quem já era de alguém vai pra REBATIDA do novo
 *  dono. Zera descarte, visita e tentativas; o próximo contato vira "agora" (todo lead com corretor
 *  tem um). tipo 'manual' avisa o corretor. */
export async function distribuirLeads(imobiliariaId: string, leadIds: string[], corretorId: string, tipo: string) {
  if (!leadIds.length) return [];
  const [novo, rebatida] = await Promise.all([colunaPorSlug(imobiliariaId, 'novo'), colunaPorSlug(imobiliariaId, 'rebatida')]);
  const agora = new Date();
  const rows = await db.update(leads).set({
    colunaId: sql`coalesce(case when ${leads.corretorId} is null then ${novo?.id ?? null}::uuid else ${rebatida?.id ?? null}::uuid end, ${leads.colunaId})`,
    corretorId,
    tentativasContato: 0,
    descartadoEm: null, descartadoPor: null, motivoDescarte: null, descartePendenteAprovacao: false,
    proximoContatoEm: agora, dataVisita: null, statusVisita: null,
    dataAtribuicao: agora, primeiroContatoEm: null, ultimaAcaoEm: agora, entrouNaColunaEm: agora,
  }).where(and(eq(leads.imobiliariaId, imobiliariaId), inArray(leads.id, leadIds))).returning();
  if (!rows.length) return rows;
  await db.insert(distribuicaoLog).values(rows.map(r => ({ imobiliariaId, leadId: r.id, corretorId, origem: tipo })));
  await db.update(perfis).set({ ultimoLeadRecebidoEm: agora }).where(eq(perfis.id, corretorId));
  if (tipo === 'manual') {
    await notificar(rows.map(r => ({
      perfilId: corretorId, leadId: r.id, tipo: 'lead_novo_atribuido', titulo: 'Lead atribuído a você: ' + (r.nome || r.telefone),
    })));
  }
  return rows;
}
