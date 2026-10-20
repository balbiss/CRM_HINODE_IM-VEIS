import { and, asc, eq, or } from 'drizzle-orm';
import { db } from '../db/client.js';
import { sessoesWhatsapp } from '../db/schema.js';

type Sessao = typeof sessoesWhatsapp.$inferSelect;

/** Número CENTRAL conectado pra falar com um lead, quando a imobiliária tem mais de uma caixa de entrada.
 *  Ordem: o número que o próprio lead usou → o preferido (ex.: o da roleta) → o 1º conectado.
 *  `soComIa`: considera só números em que o Agente de IA atende. */
export async function numeroCentralDoLead(
  lead: { imobiliariaId: string; sessaoWhatsappId: string | null },
  opts: { preferidoId?: string | null; soComIa?: boolean } = {},
): Promise<Sessao | null> {
  const conectados = (await db.select().from(sessoesWhatsapp)
    .where(and(eq(sessoesWhatsapp.imobiliariaId, lead.imobiliariaId), eq(sessoesWhatsapp.escopo, 'central'),
      // no ar = WAHA conectado OU API oficial ativa (número híbrido segue funcionando com um dos dois)
      or(eq(sessoesWhatsapp.status, 'conectada'), eq(sessoesWhatsapp.oficialAtiva, true))))
    .orderBy(asc(sessoesWhatsapp.criadoEm)))
    .filter(s => !opts.soComIa || s.iaAtende);
  return conectados.find(s => s.id === lead.sessaoWhatsappId)
    ?? conectados.find(s => s.id === opts.preferidoId)
    ?? conectados[0]
    ?? null;
}
