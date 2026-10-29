import { Router } from 'express';
import { z } from 'zod';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { templatesMensagem, perfis } from '../db/schema.js';
import { requireAuth } from '../middleware/auth.js';

export const templatesRouter = Router();
templatesRouter.use(requireAuth);

// Mensagens prontas (regra da v1): todo mundo da imobiliária vê e usa as de todos — no chat é só digitar
// "/". Cada um edita/apaga as que criou; dono e gerente mexem em qualquer uma.

templatesRouter.get('/', async (req, res) => {
  const rows = await db.select({
    id: templatesMensagem.id, titulo: templatesMensagem.titulo, texto: templatesMensagem.texto,
    anexoUrl: templatesMensagem.anexoUrl, anexos: templatesMensagem.anexos,
    criadoPor: templatesMensagem.criadoPor, autorNome: perfis.nome,
  }).from(templatesMensagem)
    .innerJoin(perfis, eq(perfis.id, templatesMensagem.criadoPor))
    .where(eq(perfis.imobiliariaId, req.auth!.imobiliariaId))
    .orderBy(desc(templatesMensagem.id));
  const meus = rows.filter(r => r.criadoPor === req.auth!.sub);
  const outros = rows.filter(r => r.criadoPor !== req.auth!.sub).sort((a, b) => (a.autorNome ?? '').localeCompare(b.autorNome ?? '') || a.titulo.localeCompare(b.titulo));
  res.json([...meus.sort((a, b) => a.titulo.localeCompare(b.titulo)), ...outros]);
});

const anexoSchema = z.object({ url: z.string(), nome: z.string().optional(), tipo: z.string().optional() });
const bodySchema = z.object({
  titulo: z.string().min(1),
  texto: z.string().default(''),
  anexoUrl: z.string().nullable().optional(),
  anexos: z.array(anexoSchema).max(10).optional(),
});

templatesRouter.post('/', async (req, res) => {
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Título obrigatório' });
  if (!parsed.data.texto.trim() && !parsed.data.anexoUrl && !parsed.data.anexos?.length) return res.status(400).json({ error: 'Escreva o texto ou anexe um arquivo' });
  const [row] = await db.insert(templatesMensagem).values({ criadoPor: req.auth!.sub, ...parsed.data }).returning();
  res.status(201).json(row);
});

/** O template existe nesta imobiliária e a pessoa pode mexer nele (autor, ou dono/gerente). */
async function podeMexer(id: string, req: import('express').Request) {
  const { sub, role, imobiliariaId } = req.auth!;
  const [t] = await db.select({ id: templatesMensagem.id, criadoPor: templatesMensagem.criadoPor })
    .from(templatesMensagem).innerJoin(perfis, eq(perfis.id, templatesMensagem.criadoPor))
    .where(and(eq(templatesMensagem.id, id), eq(perfis.imobiliariaId, imobiliariaId))).limit(1);
  if (!t) return false;
  return t.criadoPor === sub || role === 'dono' || role === 'gerente';
}

templatesRouter.patch('/:id', async (req, res) => {
  const parsed = bodySchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Dados inválidos' });
  if (!await podeMexer(req.params.id, req)) return res.status(404).json({ error: 'Template não encontrado' });
  const [row] = await db.update(templatesMensagem).set(parsed.data).where(eq(templatesMensagem.id, req.params.id)).returning();
  res.json(row);
});

templatesRouter.delete('/:id', async (req, res) => {
  if (!await podeMexer(req.params.id, req)) return res.status(404).json({ error: 'Template não encontrado' });
  await db.delete(templatesMensagem).where(eq(templatesMensagem.id, req.params.id));
  res.json({ ok: true });
});
