import { and, eq, sql } from 'drizzle-orm';
import type { Server as SocketServer } from 'socket.io';
import { db } from '../db/client.js';
import { imobiliarias, leadTags, tags } from '../db/schema.js';
import { isBusinessHoursOpen } from './schedule.js';

export const TAG_FORA_DO_HORARIO = 'Fora do horário';
const COR = '#6B5BD2';

/** Lead que chega fora do horário de atendimento da imobiliária (madrugada, fim de semana...)
 *  ganha a etiqueta "Fora do horário", pro corretor saber por quem começar quando abrir o plantão.
 *  A etiqueta é criada sozinha na 1ª vez (o dono pode trocar a cor depois; se renomear, o CRM
 *  cria outra com o nome padrão). Devolve as etiquetas do lead quando marcou, senão null. */
export async function marcarForaDoHorario(io: SocketServer, imobId: string, leadId: string, agora = new Date()): Promise<string[] | null> {
  const [imob] = await db.select({ horario: imobiliarias.horarioAtendimento }).from(imobiliarias)
    .where(eq(imobiliarias.id, imobId)).limit(1);
  if (!imob || isBusinessHoursOpen(imob.horario, agora)) return null;

  let [tag] = await db.select({ id: tags.id }).from(tags)
    .where(and(eq(tags.imobiliariaId, imobId), sql`lower(${tags.nome}) = lower(${TAG_FORA_DO_HORARIO})`)).limit(1);
  if (!tag) {
    [tag] = await db.insert(tags).values({ imobiliariaId: imobId, nome: TAG_FORA_DO_HORARIO, cor: COR, ordem: 99 }).returning({ id: tags.id });
    io.to('imobiliaria:' + imobId).emit('tag:changed');
  }
  await db.insert(leadTags).values({ leadId, tagId: tag.id }).onConflictDoNothing();

  const doLead = await db.select({ tagId: leadTags.tagId }).from(leadTags).where(eq(leadTags.leadId, leadId));
  const tagIds = doLead.map(t => t.tagId);
  io.to('imobiliaria:' + imobId).emit('lead:tags', { leadId, tagIds });
  return tagIds;
}
