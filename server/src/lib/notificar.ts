import type { Server as SocketServer } from 'socket.io';
import { db } from '../db/client.js';
import { notificacoes } from '../db/schema.js';
import { enviarPush } from './push.js';

/** Notificação que chega NA HORA pra pessoa (socket na sala `perfil:<id>` + push no celular), não só
 *  quando ela recarrega a tela. Os avisos da v1 (crédito, aprovações, lead transferido, follow-up)
 *  dependem disso — vários abrem um modal bloqueante assim que chegam. */
let io: SocketServer | null = null;
export function setIoNotificacoes(server: SocketServer) { io = server; }

type Nova = { perfilId: string; tipo: string; titulo: string; texto?: string | null; leadId?: string | null };

export async function notificar(lista: Nova | Nova[], opts: { push?: boolean } = {}) {
  const rows = (Array.isArray(lista) ? lista : [lista]).filter(n => n.perfilId);
  if (!rows.length) return [];
  const criadas = await db.insert(notificacoes).values(rows.map(n => ({
    perfilId: n.perfilId, tipo: n.tipo, titulo: n.titulo, texto: n.texto ?? null, leadId: n.leadId ?? null,
  }))).returning();
  for (const n of criadas) {
    io?.to('perfil:' + n.perfilId).emit('notificacao:nova', n);
    if (opts.push !== false) {
      void enviarPush(n.perfilId, { title: n.titulo, body: n.texto ?? '', url: n.leadId ? '/kanban?lead=' + n.leadId : '/', tag: n.tipo + '-' + (n.leadId ?? n.id) }).catch(() => {});
    }
  }
  return criadas;
}
