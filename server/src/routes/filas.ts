import { Router } from 'express';
import { z } from 'zod';
import { and, asc, eq } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db } from '../db/client.js';
import { filasAtendimento, roletas, perfis, imobiliarias, distribuicaoLog, leads, recusasLead } from '../db/schema.js';
import { desc } from 'drizzle-orm';
import { requireAuth } from '../middleware/auth.js';
import { isBusinessHoursOpen, horarioAtendimentoLabel } from '../lib/schedule.js';
import { distribuirPendentes, garantirRoletaPadrao } from '../lib/roleta.js';
import { entrarNaRoleta, expedienteAberto, HORARIO_ROLETA, estadoRoleta } from '../lib/roletaOka.js';
import type { Server as SocketServer } from 'socket.io';

export function filasRouter(io: SocketServer) {
  const router = Router();
  router.use(requireAuth);

  // Corretores que participam de ALGUMA roleta (deduplicado) — usado pra saber quem vê o toggle
  // de plantão e pra tela da Roleta. A posição por roleta fica em /api/roletas.
  router.get('/', async (req, res) => {
    const rows = await db
      .select({
        corretorId: filasAtendimento.corretorId,
        posicao: filasAtendimento.posicao,
        nome: perfis.nome,
        emPlantao: perfis.emPlantao,
        bloqueado: perfis.bloqueado,
        ativoNoTurno: filasAtendimento.ativoNoTurno,
      })
      .from(filasAtendimento)
      .innerJoin(perfis, eq(perfis.id, filasAtendimento.corretorId))
      .where(eq(filasAtendimento.imobiliariaId, req.auth!.imobiliariaId))
      .orderBy(asc(filasAtendimento.posicao));

    const vistos = new Set<string>();
    const unico = rows.filter(r => (vistos.has(r.corretorId) ? false : vistos.add(r.corretorId)));
    const estado = new Map((await estadoRoleta(req.auth!.imobiliariaId)).map(e => [e.corretorId, e]));
    res.json(unico.map(r => ({ ...r, emAlmoco: estado.get(r.corretorId)?.emAlmoco ?? false, advertencias: estado.get(r.corretorId)?.advertencias ?? 0 })));
  });

  // Histórico de distribuição da roleta (últimas 100). Corretor vê só as dele.
  router.get('/log', async (req, res) => {
    const { imobiliariaId, role, sub } = req.auth!;
    const base = eq(distribuicaoLog.imobiliariaId, imobiliariaId);
    const rows = await db
      .select({
        criadoEm: distribuicaoLog.criadoEm,
        origem: distribuicaoLog.origem,
        roletaNome: roletas.nome,
        leadNome: leads.nome,
        corretorNome: perfis.nome,
        corretorId: distribuicaoLog.corretorId,
      })
      .from(distribuicaoLog)
      .innerJoin(leads, eq(leads.id, distribuicaoLog.leadId))
      .innerJoin(perfis, eq(perfis.id, distribuicaoLog.corretorId))
      .leftJoin(roletas, eq(roletas.id, distribuicaoLog.roletaId))
      .where(role === 'corretor' ? and(base, eq(distribuicaoLog.corretorId, sub)) : base)
      .orderBy(desc(distribuicaoLog.criadoEm))
      .limit(100);
    // recusas (clicou Recusar ou deixou o tempo acabar) entram na mesma linha do tempo
    const para = alias(perfis, 'para');
    const baseR = eq(recusasLead.imobiliariaId, imobiliariaId);
    const recusas = await db.select({
      criadoEm: recusasLead.criadoEm, motivo: recusasLead.motivo,
      leadNome: leads.nome, corretorNome: perfis.nome, corretorId: recusasLead.corretorId, paraNome: para.nome,
    }).from(recusasLead)
      .innerJoin(leads, eq(leads.id, recusasLead.leadId))
      .innerJoin(perfis, eq(perfis.id, recusasLead.corretorId))
      .leftJoin(para, eq(para.id, recusasLead.redistribuidoParaId))
      .where(role === 'corretor' ? and(baseR, eq(recusasLead.corretorId, sub)) : baseR)
      .orderBy(desc(recusasLead.criadoEm))
      .limit(100);
    const tudo = [
      ...rows.map(r => ({ ...r, tipo: 'entrega' as const })),
      ...recusas.map(r => ({ ...r, tipo: 'recusa' as const, origem: r.motivo, roletaNome: null })),
    ].sort((a, b) => b.criadoEm.getTime() - a.criadoEm.getTime()).slice(0, 150);
    res.json(tudo);
  });

  const toggleSchema = z.object({ corretorId: z.string().uuid() });

  router.patch('/disponibilidade', async (req, res) => {
    const parsed = toggleSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'corretorId inválido' });
    const { imobiliariaId, role, sub } = req.auth!;

    if (role === 'corretor' && parsed.data.corretorId !== sub) {
      return res.status(403).json({ error: 'Só o gerente altera a disponibilidade de outro corretor' });
    }

    const [alvo] = await db.select().from(perfis)
      .where(and(eq(perfis.id, parsed.data.corretorId), eq(perfis.imobiliariaId, imobiliariaId)))
      .limit(1);
    if (!alvo) return res.status(404).json({ error: 'Corretor não encontrado' });

    const vaiLigar = !alvo.emPlantao;
    if (vaiLigar) {
      if (alvo.bloqueado) return res.status(403).json({ error: alvo.nome + ' está com acesso bloqueado — não pode entrar na roleta' });
      // v1: fora do expediente da roleta não dá pra ficar disponível
      if (!expedienteAberto()) return res.status(403).json({ error: HORARIO_ROLETA });

      // Se o corretor não participa de NENHUMA roleta, entra na padrão (senão ficar online não
      // adianta nada). Se já é membro de alguma, respeita o que o gerente configurou.
      const [jaTem] = await db.select({ id: filasAtendimento.id }).from(filasAtendimento)
        .where(eq(filasAtendimento.corretorId, parsed.data.corretorId)).limit(1);
      if (!jaTem) {
        const roletaId = await garantirRoletaPadrao(imobiliariaId);
        const existentes = await db.select({ posicao: filasAtendimento.posicao }).from(filasAtendimento)
          .where(eq(filasAtendimento.roletaId, roletaId));
        const proxima = existentes.reduce((m, r) => Math.max(m, r.posicao), -1) + 1;
        await db.insert(filasAtendimento).values({ imobiliariaId, roletaId, corretorId: parsed.data.corretorId, posicao: proxima });
      }
    }

    // v1 entrar_na_roleta: depois das 14h dá advertência e não entra no turno; 3 na semana tira da roleta
    let aviso: string | null = null;
    if (vaiLigar) {
      const r = await entrarNaRoleta(parsed.data.corretorId);
      if (r.atrasado) aviso = 'Entrou depois das 14h: advertência registrada (' + r.advertencias + ' na semana) e fica fora do turno de hoje.';
      else if (!r.ativo) aviso = '3 advertências na semana — fora da roleta até a semana virar.';
    } else {
      await db.update(perfis).set({ emPlantao: false }).where(eq(perfis.id, parsed.data.corretorId));
    }
    const [row] = await db.select().from(perfis).where(eq(perfis.id, parsed.data.corretorId)).limit(1);

    io.to('imobiliaria:' + imobiliariaId).emit('fila:atualizada', { corretorId: row.id, emPlantao: row.emPlantao });
    io.to('imobiliaria:' + imobiliariaId).emit('roletas:mudou', {});
    res.json({ corretorId: row.id, emPlantao: row.emPlantao, aviso });
  });

  // Almoço (v1): enquanto estiver em almoço o corretor não recebe lead, mas não perde o lugar na fila.
  router.patch('/almoco', async (req, res) => {
    const parsed = toggleSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'corretorId inválido' });
    const { imobiliariaId, role, sub } = req.auth!;
    if (role === 'corretor' && parsed.data.corretorId !== sub) return res.status(403).json({ error: 'Só o gerente altera o almoço de outro corretor' });
    const [alvo] = await db.select().from(perfis).where(and(eq(perfis.id, parsed.data.corretorId), eq(perfis.imobiliariaId, imobiliariaId))).limit(1);
    if (!alvo) return res.status(404).json({ error: 'Corretor não encontrado' });
    const [row] = await db.update(perfis).set({ emAlmoco: !alvo.emAlmoco }).where(eq(perfis.id, alvo.id)).returning();
    io.to('imobiliaria:' + imobiliariaId).emit('roletas:mudou', {});
    res.json({ corretorId: row.id, emAlmoco: row.emAlmoco });
  });

  router.post('/distribuir', async (req, res) => {
    const { imobiliariaId, role } = req.auth!;
    if (role === 'corretor') return res.status(403).json({ error: 'Só dono ou gerente pode distribuir a roleta' });
    const n = await distribuirPendentes(io, imobiliariaId);
    res.json({ distribuidos: n });
  });

  // Embaralha a ordem dos membros de TODAS as roletas.
  router.post('/embaralhar', async (req, res) => {
    const { imobiliariaId, role } = req.auth!;
    if (role === 'corretor') return res.status(403).json({ error: 'Só dono ou gerente pode embaralhar a roleta' });

    const lista = await db.select({ id: roletas.id }).from(roletas).where(eq(roletas.imobiliariaId, imobiliariaId));
    for (const r of lista) {
      const membros = await db.select().from(filasAtendimento).where(eq(filasAtendimento.roletaId, r.id));
      const shuffled = [...membros].sort(() => Math.random() - 0.5);
      for (let i = 0; i < shuffled.length; i++) {
        await db.update(filasAtendimento).set({ posicao: i }).where(eq(filasAtendimento.id, shuffled[i].id));
      }
    }
    io.to('imobiliaria:' + imobiliariaId).emit('fila:embaralhada', {});
    io.to('imobiliaria:' + imobiliariaId).emit('roletas:mudou', {});
    res.json({ ok: true });
  });

  return router;
}
