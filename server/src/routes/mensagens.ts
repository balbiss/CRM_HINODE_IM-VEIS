import { Router } from 'express';
import { z } from 'zod';
import { and, asc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { leads, mensagensWhatsapp } from '../db/schema.js';
import { requireAuth } from '../middleware/auth.js';
import type { Server as SocketServer } from 'socket.io';

/** Carrega o lead e confere que quem está pedindo pode ver essa conversa: precisa ser da mesma
 * imobiliária, e se for corretor, o lead precisa ser dele (mesma régua de leads.ts). */
async function carregarLeadAutorizado(leadId: string, imobiliariaId: string, role: string, sub: string) {
  const [lead] = await db.select().from(leads).where(and(eq(leads.id, leadId), eq(leads.imobiliariaId, imobiliariaId))).limit(1);
  if (!lead) return null;
  if (role === 'corretor' && lead.corretorId !== sub) return undefined;
  return lead;
}

export function mensagensRouter(io: SocketServer) {
  const router = Router();
  router.use(requireAuth);

  router.get('/:leadId', async (req, res) => {
    const { imobiliariaId, role, sub } = req.auth!;
    const lead = await carregarLeadAutorizado(req.params.leadId, imobiliariaId, role, sub);
    if (lead === null) return res.status(404).json({ error: 'Lead não encontrado' });
    if (lead === undefined) return res.status(403).json({ error: 'Sem permissão para ver esta conversa' });
    const rows = await db.select().from(mensagensWhatsapp)
      .where(eq(mensagensWhatsapp.leadId, req.params.leadId))
      .orderBy(asc(mensagensWhatsapp.enviadoEm));
    res.json(rows);
  });

  const bodySchema = z.object({
    texto: z.string().min(1).optional(),
    anexoUrl: z.string().min(1).optional(),
    anexoTipo: z.enum(['imagem', 'video', 'documento', 'audio']).optional(),
  }).refine(b => !!b.texto || !!b.anexoUrl, { message: 'Mensagem precisa ter texto ou anexo' });

  router.post('/:leadId', async (req, res) => {
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Dados inválidos' });
    const { imobiliariaId, role, sub } = req.auth!;
    const lead = await carregarLeadAutorizado(req.params.leadId, imobiliariaId, role, sub);
    if (lead === null) return res.status(404).json({ error: 'Lead não encontrado' });
    if (lead === undefined) return res.status(403).json({ error: 'Sem permissão para enviar nesta conversa' });

    // Envio real via WAHA entra numa próxima etapa — por enquanto só persiste a mensagem do
    // corretor (direção "out"). Não fabricamos resposta automática do lead.
    const [row] = await db.insert(mensagensWhatsapp).values({
      leadId: req.params.leadId, direcao: 'out', canal: 'corretor',
      texto: parsed.data.texto ?? null,
      anexoUrl: parsed.data.anexoUrl ?? null,
      anexoTipo: parsed.data.anexoTipo ?? null,
    }).returning();

    io.to('imobiliaria:' + imobiliariaId).emit('mensagem:created', row);
    res.status(201).json(row);
  });

  return router;
}
