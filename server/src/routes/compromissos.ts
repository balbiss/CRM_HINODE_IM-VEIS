import { Router } from 'express';
import { z } from 'zod';
import { and, asc, eq, gte, isNull, lte } from 'drizzle-orm';
import type { Server as SocketServer } from 'socket.io';
import { db } from '../db/client.js';
import { compromissosEquipe, perfis } from '../db/schema.js';
import { requireAuth } from '../middleware/auth.js';

/** Compromissos da equipe (v1): reunião, treinamento… qualquer um cria, aparece pra todos, aviso 1h antes.
 *  Quem criou, o dono e o gerente editam ou cancelam. */
export function compromissosRouter(io: SocketServer) {
  const router = Router();
  router.use(requireAuth);

  router.get('/', async (req, res) => {
    const { imobiliariaId } = req.auth!;
    const conds = [eq(compromissosEquipe.imobiliariaId, imobiliariaId), isNull(compromissosEquipe.canceladoEm)];
    if (typeof req.query.de === 'string') conds.push(gte(compromissosEquipe.inicio, new Date(req.query.de)));
    if (typeof req.query.ate === 'string') conds.push(lte(compromissosEquipe.inicio, new Date(req.query.ate)));
    else conds.push(gte(compromissosEquipe.inicio, new Date(Date.now() - 60 * 86400000)));
    const rows = await db.select({ c: compromissosEquipe, autor: perfis.nome }).from(compromissosEquipe)
      .leftJoin(perfis, eq(perfis.id, compromissosEquipe.criadoPor)).where(and(...conds)).orderBy(asc(compromissosEquipe.inicio));
    res.json(rows.map(r => ({ ...r.c, autorNome: r.autor })));
  });

  const schema = z.object({
    titulo: z.string().trim().min(1).max(160), tipo: z.string().max(40).default('reuniao'),
    inicio: z.string().datetime({ offset: true }), fim: z.string().datetime({ offset: true }).nullable().optional(),
    local: z.string().max(300).nullable().optional(), observacao: z.string().max(1000).nullable().optional(),
  });

  router.post('/', async (req, res) => {
    const p = schema.safeParse(req.body);
    if (!p.success) return res.status(400).json({ error: 'Título, data e horário são obrigatórios' });
    const { imobiliariaId, sub } = req.auth!;
    const [row] = await db.insert(compromissosEquipe).values({
      imobiliariaId, criadoPor: sub, titulo: p.data.titulo, tipo: p.data.tipo, inicio: new Date(p.data.inicio),
      fim: p.data.fim ? new Date(p.data.fim) : null, local: p.data.local ?? null, observacao: p.data.observacao ?? null,
    }).returning();
    io.to('imobiliaria:' + imobiliariaId).emit('compromissos:mudou', {});
    res.status(201).json(row);
  });

  async function podeMexer(id: string, req: import('express').Request) {
    const { imobiliariaId, sub, role } = req.auth!;
    const [c] = await db.select().from(compromissosEquipe).where(and(eq(compromissosEquipe.id, id), eq(compromissosEquipe.imobiliariaId, imobiliariaId))).limit(1);
    return c && (c.criadoPor === sub || role === 'dono' || role === 'gerente') ? c : null;
  }

  router.patch('/:id', async (req, res) => {
    const p = schema.partial().safeParse(req.body);
    if (!p.success) return res.status(400).json({ error: 'Dados inválidos' });
    const c = await podeMexer(req.params.id, req);
    if (!c) return res.status(404).json({ error: 'Compromisso não encontrado' });
    const set: Record<string, unknown> = { ...p.data };
    if (p.data.inicio) { set.inicio = new Date(p.data.inicio); set.avisoEnviadoEm = null; }
    if (p.data.fim) set.fim = new Date(p.data.fim);
    const [row] = await db.update(compromissosEquipe).set(set).where(eq(compromissosEquipe.id, c.id)).returning();
    io.to('imobiliaria:' + req.auth!.imobiliariaId).emit('compromissos:mudou', {});
    res.json(row);
  });

  router.delete('/:id', async (req, res) => {
    const c = await podeMexer(req.params.id, req);
    if (!c) return res.status(404).json({ error: 'Compromisso não encontrado' });
    await db.update(compromissosEquipe).set({ canceladoEm: new Date() }).where(eq(compromissosEquipe.id, c.id));
    io.to('imobiliaria:' + req.auth!.imobiliariaId).emit('compromissos:mudou', {});
    res.json({ ok: true });
  });

  return router;
}
