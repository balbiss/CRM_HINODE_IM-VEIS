import { Router } from 'express';
import { and, desc, eq } from 'drizzle-orm';
import type { Server as SocketServer } from 'socket.io';
import { db } from '../db/client.js';
import { contatosPendentes, contatosIgnorados, leads, colunasKanban, sessoesWhatsapp, mensagensWhatsapp } from '../db/schema.js';
import { requireAuth } from '../middleware/auth.js';
import { registrarEvento } from '../lib/eventos.js';
import { historicoConversa } from '../lib/waha.js';
import { formatarTelefone } from './whatsapp.js';

// Tudo aqui é do PRÓPRIO usuário logado (sub): nem dono/gerente enxergam os contatos
// pendentes/pessoais de um corretor — é justamente o que protege a privacidade dele.
export function contatosWhatsappRouter(io: SocketServer) {
  const router = Router();
  router.use(requireAuth);

  // `espelho` = o usuário tem o próprio WhatsApp espelhado no CRM (só aí os botões fazem sentido).
  router.get('/pendentes', async (req, res) => {
    const { sub } = req.auth!;
    const [sessao] = await db.select({ id: sessoesWhatsapp.id }).from(sessoesWhatsapp)
      .where(and(eq(sessoesWhatsapp.corretorId, sub), eq(sessoesWhatsapp.escopo, 'corretor'))).limit(1);
    const pendentes = await db.select().from(contatosPendentes)
      .where(eq(contatosPendentes.corretorId, sub))
      .orderBy(desc(contatosPendentes.ultimaMensagemEm));
    res.json({ espelho: !!sessao, pendentes });
  });

  async function pendenteDoUsuario(id: string, sub: string) {
    const [p] = await db.select().from(contatosPendentes)
      .where(and(eq(contatosPendentes.id, id), eq(contatosPendentes.corretorId, sub))).limit(1);
    return p;
  }

  router.post('/pendentes/:id/trazer', async (req, res) => {
    const { imobiliariaId, sub, nome: ator } = req.auth!;
    const p = await pendenteDoUsuario(req.params.id, sub);
    if (!p) return res.status(404).json({ error: 'Contato não encontrado' });

    const [colNova] = await db.select({ id: colunasKanban.id }).from(colunasKanban)
      .where(and(eq(colunasKanban.imobiliariaId, imobiliariaId), eq(colunasKanban.slug, 'novo'))).limit(1);
    const [lead] = await db.insert(leads).values({
      imobiliariaId,
      nome: p.nome || 'Contato ' + formatarTelefone(p.telefone),
      telefone: p.telefone,
      canal: 'WhatsApp',
      colunaId: colNova?.id,
      corretorId: sub,
      sessaoWhatsappId: p.sessaoWhatsappId,
    }).returning();
    await db.delete(contatosPendentes).where(eq(contatosPendentes.id, p.id));

    registrarEvento(imobiliariaId, lead.id, 'criado', 'Trazido pro CRM pelo corretor a partir do WhatsApp dele', ator);
    io.to('imobiliaria:' + imobiliariaId).emit('lead:created', lead);
    io.to('imobiliaria:' + imobiliariaId).emit('pendentes:mudou', { corretorId: sub });

    // Enquanto era pendente nada do conteúdo foi guardado; agora que o corretor disse que é
    // cliente, puxa o histórico recente direto do WhatsApp pra conversa já aparecer completa.
    const [sessao] = await db.select({ nome: sessoesWhatsapp.sessionName }).from(sessoesWhatsapp)
      .where(eq(sessoesWhatsapp.id, p.sessaoWhatsappId)).limit(1);
    const historico = sessao ? await historicoConversa(sessao.nome, p.telefone) : [];
    const linhas = historico
      .map(m => ({
        leadId: lead.id,
        direcao: (m.fromMe ? 'out' : 'in') as 'out' | 'in',
        canal: 'corretor' as const,
        waMessageId: m.id,
        ackStatus: m.fromMe ? 2 : null,
        enviadoPor: m.fromMe ? sub : null,
        texto: m.body || (m.hasMedia ? 'Anexo (abra no WhatsApp pra ver)' : null),
        lida: true,
        enviadoEm: new Date(m.timestamp * 1000),
      }))
      .filter(m => m.texto);
    if (linhas.length) {
      const inseridas = await db.insert(mensagensWhatsapp).values(linhas).onConflictDoNothing().returning();
      const ultima = inseridas.sort((a, b) => b.enviadoEm.getTime() - a.enviadoEm.getTime())[0];
      if (ultima) io.to('imobiliaria:' + imobiliariaId).emit('mensagem:created', ultima);
    }
    res.status(201).json(lead);
  });

  router.post('/pendentes/:id/pessoal', async (req, res) => {
    const { imobiliariaId, sub } = req.auth!;
    const p = await pendenteDoUsuario(req.params.id, sub);
    if (!p) return res.status(404).json({ error: 'Contato não encontrado' });
    await db.insert(contatosIgnorados).values({ imobiliariaId, corretorId: sub, telefone: p.telefone, nome: p.nome })
      .onConflictDoNothing();
    await db.delete(contatosPendentes).where(eq(contatosPendentes.id, p.id));
    io.to('imobiliaria:' + imobiliariaId).emit('pendentes:mudou', { corretorId: sub });
    res.json({ ok: true });
  });

  // Lead que já tinha entrado pelo WhatsApp do próprio corretor e é conversa pessoal:
  // ignora o número dali pra frente e apaga o lead + a conversa do CRM.
  // Só vale pra lead que chegou pelo número PESSOAL dele — lead da empresa (número central,
  // campanha, site) não pode ser apagado assim.
  router.post('/leads/:leadId/pessoal', async (req, res) => {
    const { imobiliariaId, sub } = req.auth!;
    const [lead] = await db.select({
      id: leads.id, nome: leads.nome, telefone: leads.telefone,
      sessaoEscopo: sessoesWhatsapp.escopo, sessaoCorretorId: sessoesWhatsapp.corretorId,
    }).from(leads)
      .innerJoin(sessoesWhatsapp, eq(sessoesWhatsapp.id, leads.sessaoWhatsappId))
      .where(and(eq(leads.id, req.params.leadId), eq(leads.imobiliariaId, imobiliariaId), eq(leads.corretorId, sub)))
      .limit(1);
    if (!lead || lead.sessaoEscopo !== 'corretor' || lead.sessaoCorretorId !== sub) {
      return res.status(403).json({ error: 'Só dá pra marcar como pessoal uma conversa que chegou pelo seu próprio WhatsApp.' });
    }
    await db.insert(contatosIgnorados).values({ imobiliariaId, corretorId: sub, telefone: lead.telefone, nome: lead.nome })
      .onConflictDoNothing();
    await db.delete(leads).where(eq(leads.id, lead.id));
    io.to('imobiliaria:' + imobiliariaId).emit('lead:removido', { id: lead.id });
    res.json({ ok: true });
  });

  router.get('/ignorados', async (req, res) => {
    const rows = await db.select().from(contatosIgnorados)
      .where(eq(contatosIgnorados.corretorId, req.auth!.sub))
      .orderBy(desc(contatosIgnorados.criadoEm));
    res.json(rows);
  });

  router.delete('/ignorados/:id', async (req, res) => {
    const [row] = await db.delete(contatosIgnorados)
      .where(and(eq(contatosIgnorados.id, req.params.id), eq(contatosIgnorados.corretorId, req.auth!.sub)))
      .returning();
    if (!row) return res.status(404).json({ error: 'Contato não encontrado' });
    res.json({ ok: true });
  });

  return router;
}
