/** Análise de Crédito — regras da v1 (CRM OKA):
 *  - entrou na coluna ANÁLISE DE CRÉDITO → alerta vermelho aceso (creditoAprovadoEm = null) e dono/gerente
 *    recebem o aviso "Nova pasta" (modal bloqueante na tela);
 *  - dono/gerente dão "Visto" (documentação auditada, alerta apaga) ou "Retornar com pendência" (volta pro
 *    corretor em PENDENTE com a nota do que falta; o corretor recebe o modal);
 *  - enquanto o lead estiver na coluna, de hora em hora corretor + dono + gerente recebem o lembrete
 *    "Verificar se houve retorno da Análise de Crédito" (o lembrete anterior não lido é apagado). */
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import { leads, perfis, colunasKanban, notificacoes } from '../db/schema.js';
import { notificar } from './notificar.js';

async function gestores(imobiliariaId: string) {
  return db.select({ id: perfis.id }).from(perfis)
    .where(and(eq(perfis.imobiliariaId, imobiliariaId), inArray(perfis.role, ['dono', 'gerente']), eq(perfis.bloqueado, false)));
}

export async function avisarNovaPasta(imobiliariaId: string, lead: { id: string; nome: string; telefone: string }) {
  const gs = await gestores(imobiliariaId);
  await notificar(gs.map(g => ({
    perfilId: g.id, leadId: lead.id, tipo: 'nova_analise_credito',
    titulo: 'Nova pasta enviada para Análise de Crédito: ' + (lead.nome || lead.telefone),
  })));
}

export async function avisarPendencia(lead: { id: string; nome: string; telefone: string; corretorId: string | null }, observacao: string) {
  if (!lead.corretorId) return;
  await notificar({
    perfilId: lead.corretorId, leadId: lead.id, tipo: 'analise_credito_pendencia',
    titulo: 'Análise de Crédito retornada com pendência: ' + (lead.nome || lead.telefone), texto: observacao,
  });
}

let ultimaHora = '';
/** Chamado a cada minuto; só age na virada de cada hora (v1: cron "0 * * * *"). */
export async function lembretesCreditoDaHora(agora = new Date()) {
  const hora = agora.toISOString().slice(0, 13);
  if (hora === ultimaHora || agora.getUTCMinutes() > 4) return;
  ultimaHora = hora;
  const naColuna = await db.select({ id: leads.id, nome: leads.nome, corretorId: leads.corretorId, imobiliariaId: leads.imobiliariaId })
    .from(leads).innerJoin(colunasKanban, eq(colunasKanban.id, leads.colunaId))
    .where(and(eq(colunasKanban.slug, 'credito'), isNull(leads.descartadoEm)));
  for (const l of naColuna) {
    await db.update(notificacoes).set({ lida: true })
      .where(and(eq(notificacoes.leadId, l.id), eq(notificacoes.tipo, 'analise_credito_lembrete'), eq(notificacoes.lida, false)));
    const titulo = 'Verificar se houve retorno da Análise de Crédito do cliente ' + (l.nome || 'sem nome');
    const destinos = [...(l.corretorId ? [l.corretorId] : []), ...(await gestores(l.imobiliariaId)).map(g => g.id)];
    await notificar([...new Set(destinos)].map(perfilId => ({ perfilId, leadId: l.id, tipo: 'analise_credito_lembrete', titulo })), { push: false });
  }
}
