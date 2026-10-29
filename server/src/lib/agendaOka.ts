/** Agenda — rotinas da v1 (CRM OKA):
 *  - compromisso da equipe: aviso pra todo mundo 1 hora antes;
 *  - aniversário do cliente: aviso pro corretor no dia (manda um áudio), uma vez por ano;
 *  - pós-venda: 30 dias depois da venda aprovada, aviso pro corretor com a mensagem pronta.
 *  Nenhuma mensagem é mandada pro cliente sozinha — quem manda é o corretor. */
import { and, eq, gt, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { compromissosEquipe, leads, perfis } from '../db/schema.js';
import { notificar } from './notificar.js';

const FUSO = 'America/Sao_Paulo';
const partes = (d: Date) => Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: FUSO, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false })
  .formatToParts(d).map(x => [x.type, x.value]));
const primeiro = (nome: string | null) => (nome ?? '').trim().split(/\s+/)[0] || '';

export async function avisarCompromissosEquipe(agora = new Date()) {
  const alvo = await db.update(compromissosEquipe).set({ avisoEnviadoEm: agora }).where(and(
    isNull(compromissosEquipe.canceladoEm), isNull(compromissosEquipe.avisoEnviadoEm),
    gt(compromissosEquipe.inicio, agora), lte(compromissosEquipe.inicio, new Date(+agora + 3600000)),
  )).returning();
  for (const c of alvo) {
    const hora = c.inicio.toLocaleTimeString('pt-BR', { timeZone: FUSO, hour: '2-digit', minute: '2-digit' });
    const equipe = await db.select({ id: perfis.id }).from(perfis)
      .where(and(eq(perfis.imobiliariaId, c.imobiliariaId), isNull(perfis.removidoEm), eq(perfis.bloqueado, false)));
    await notificar(equipe.map(p => ({ perfilId: p.id, tipo: 'compromisso', titulo: '📅 ' + c.titulo + ' às ' + hora + (c.local?.trim() ? ' — ' + c.local.trim() : '') })));
  }
}

let diaAniversario = '', diaPosVenda = '';
/** 9h de São Paulo (v1: cron 12h UTC), uma vez por dia. */
export async function avisarAniversarios(agora = new Date()) {
  const p = partes(agora);
  const dia = `${p.year}-${p.month}-${p.day}`;
  if (dia === diaAniversario || +p.hour % 24 < 9) return;
  diaAniversario = dia;
  const ano = +p.year;
  const hoje = await db.select({ id: leads.id, nome: leads.nome, corretorId: leads.corretorId }).from(leads).where(and(
    isNotNull(leads.corretorId), isNotNull(leads.dataNascimento),
    sql`extract(month from ${leads.dataNascimento}) = ${+p.month} and extract(day from ${leads.dataNascimento}) = ${+p.day}`,
    sql`coalesce(${leads.lembreteAniversarioAno}, 0) < ${ano}`,
  ));
  for (const l of hoje) {
    await notificar({ perfilId: l.corretorId!, leadId: l.id, tipo: 'aniversario_cliente', titulo: 'Hoje é aniversário de ' + (l.nome || 'um cliente seu') + '! 🎂', texto: 'Manda um ÁUDIO parabenizando ' + (primeiro(l.nome) || 'o cliente') + ' pelo aniversário.' });
    await db.update(leads).set({ lembreteAniversarioAno: ano }).where(eq(leads.id, l.id));
  }
}

/** 10h de São Paulo (v1: cron 13h UTC): venda aprovada há 30 dias → mensagem de pós-venda pronta pro corretor. */
export async function avisarPosVenda(agora = new Date()) {
  const p = partes(agora);
  const dia = `${p.year}-${p.month}-${p.day}`;
  if (dia === diaPosVenda || +p.hour % 24 < 10) return;
  diaPosVenda = dia;
  const vendas = await db.select({ id: leads.id, nome: leads.nome, corretorId: leads.corretorId }).from(leads).where(and(
    isNotNull(leads.corretorId), isNull(leads.lembretePosVendaEm), eq(leads.vendaPendenteAprovacao, false), isNotNull(leads.dataFechamento),
    lte(leads.dataFechamento, new Date(+agora - 30 * 86400000)), gt(leads.dataFechamento, new Date(+agora - 31 * 86400000)),
  ));
  for (const l of vendas) {
    const texto = `Oi, ${primeiro(l.nome) || 'tudo bem'}, tudo bem?\n\nFaz 30 dias que realizou seu sonho da compra do seu apartamento! Passando para saber se ficou alguma dúvida sobre o processo e se você gostou do meu atendimento.\n\nSe deu tudo certo e você gostou do suporte, poderia me dar uma ajuda deixando uma avaliação, é muito importante para meu trabalho? É bem rapidinho.\n\nE se souber de alguém que também esteja procurando imóvel e puder me indicar agradeço imensamente e lembrando que ganha uma bonificação por indicação que comprar!`;
    await notificar({ perfilId: l.corretorId!, leadId: l.id, tipo: 'pos_venda_30_dias', titulo: 'Lembrete: mande a mensagem de pós-venda pra ' + (l.nome || 'este cliente'), texto });
    await db.update(leads).set({ lembretePosVendaEm: agora }).where(eq(leads.id, l.id));
  }
}
