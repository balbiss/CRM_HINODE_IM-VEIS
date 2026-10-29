import { Router } from 'express';
import { z } from 'zod';
import { notificar } from '../lib/notificar.js';
import { avisarNovaPasta, avisarPendencia } from '../lib/credito.js';
import { and, asc, eq, gte, isNull, lt, sql, getTableColumns } from 'drizzle-orm';
import { db } from '../db/client.js';
import { leads, leadTags, mensagensWhatsapp, filasAtendimento, colunasKanban, eventosLead, perfis, tarefas, distribuicaoLog, recusasLead, imobiliarias, notificacoes, imoveis, descartesLeads } from '../db/schema.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { distribuirLead } from '../lib/roleta.js';
import {
  FUSO, MOTIVOS_DESCARTE_EXTREMO, MOTIVOS_DESCARTE_OBS_OBRIGATORIA, SLUGS_EXIGEM_AGENDAMENTO, SLUGS_EXIGEM_PROXIMO_CONTATO,
  calcularProximaCadencia, colunaPorSlug, distribuirLeads, hojeSp, vendaFechada,
} from '../lib/regrasOka.js';
import { inArray } from 'drizzle-orm';
import { registrarEvento } from '../lib/eventos.js';
import { dispararGatilhoLeadNovo, encerrarPorLead } from '../lib/followup.js';
import { desc } from 'drizzle-orm';
import type { Server as SocketServer } from 'socket.io';

export function leadsRouter(io: SocketServer) {
  const router = Router();
  router.use(requireAuth);

  // Corretor only ever sees their own leads; dono/gerente see everyone's in the imobiliária.
  router.get('/', async (req, res) => {
    const { imobiliariaId, role, sub } = req.auth!;
    // lead guardado de planilha (importacaoPendente) não aparece: fica na tela de Importações
    const scoped = role === 'corretor'
      ? and(eq(leads.imobiliariaId, imobiliariaId), eq(leads.corretorId, sub), eq(leads.importacaoPendente, false))
      : and(eq(leads.imobiliariaId, imobiliariaId), eq(leads.importacaoPendente, false));
    // sem os campos pesados que a lista não usa (respostas do Agente de IA, controle interno, id da v1)
    const { iaDados: _a, iaAguardandoDesde: _b, okaId: _c, recadastroOrigem: _d, iaTurnos: _e, iaMsgsCliente: _f,
      lembreteAniversarioAno: _g, lembretePosVendaEm: _h, ...colunasLista } = getTableColumns(leads);
    const rows = await db.select(colunasLista).from(leads).where(scoped);
    // etiquetas de cada lead (mesmo escopo — join por lead_id)
    const vinculos = await db.select({ leadId: leadTags.leadId, tagId: leadTags.tagId })
      .from(leadTags).innerJoin(leads, eq(leadTags.leadId, leads.id)).where(scoped);
    const porLead = new Map<string, string[]>();
    for (const v of vinculos) {
      const arr = porLead.get(v.leadId) ?? [];
      arr.push(v.tagId);
      porLead.set(v.leadId, arr);
    }
    res.json(rows.map(r => ({ ...r, tagIds: porLead.get(r.id) ?? [] })));
  });

  const createSchema = z.object({
    nome: z.string().min(1),
    telefone: z.string().min(8),
    email: z.string().email().optional(),
    fotoUrl: z.string().url().optional(),
    imovelInteresseId: z.string().uuid().optional(),
    imovelTitulo: z.string().optional(),
    imovelSub: z.string().optional(),
    campanha: z.string().optional(),
    valor: z.number().optional(),
    canal: z.enum(['WhatsApp', 'Instagram', 'Facebook', 'Indicacao', 'Manual', 'Site']).default('Manual'),
    finalidade: z.enum(['venda', 'locacao']).optional(),
    colunaId: z.string().uuid().optional(),
    corretorId: z.string().uuid().optional(),
  });

  router.post('/', async (req, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Dados inválidos' });
    const { imobiliariaId, nome } = req.auth!;

    // Se veio ligado a um imóvel, puxa título/valor/subtítulo/finalidade reais dele.
    const extra: Record<string, unknown> = {};
    if (parsed.data.imovelInteresseId) {
      const [im] = await db.select().from(imoveis)
        .where(and(eq(imoveis.id, parsed.data.imovelInteresseId), eq(imoveis.imobiliariaId, imobiliariaId))).limit(1);
      if (im) {
        extra.imovelTitulo = im.titulo;
        extra.valor = im.preco;
        extra.imovelSub = [im.tipo, im.finalidade, [im.endereco, im.cidade].filter(Boolean).join(' · ')].filter(Boolean).join(' · ');
        if (!parsed.data.finalidade) extra.finalidade = im.finalidade === 'Alugar' ? 'locacao' : im.finalidade === 'Comprar' ? 'venda' : null;
      }
    }
    const [row] = await db.insert(leads).values({
      ...parsed.data, ...extra, imobiliariaId,
      valor: extra.valor != null ? String(extra.valor) : parsed.data.valor?.toString(),
    }).returning();
    registrarEvento(imobiliariaId, row.id, 'criado', 'Lead cadastrado manualmente (canal ' + row.canal + ')', nome);
    io.to('imobiliaria:' + imobiliariaId).emit('lead:created', row);
    res.status(201).json(row);
    if (row.corretorId) void dispararGatilhoLeadNovo(io, imobiliariaId, row.id, row.corretorId, true); // cadastrado à mão: não liga o robô sozinho (v1)
  });

  // Mover de coluna com as travas da v1: venda fechada/pendente não mexe, VENDA só pelo registro de
  // venda, Agendado/FID exige o compromisso marcado e as colunas de acompanhamento exigem um
  // próximo contato no futuro — o front manda a data junto (proximoContatoEm / dataVisita).
  const moveSchema = z.object({
    colunaId: z.string().uuid(),
    proximoContatoEm: z.string().datetime({ offset: true }).optional(),
    dataVisita: z.string().datetime({ offset: true }).optional(),
    tipoVisita: z.enum(['VISITA', 'FID']).optional(),
  });

  router.patch('/:id/mover', async (req, res) => {
    const parsed = moveSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'colunaId inválido' });
    const { imobiliariaId, role, sub, nome } = req.auth!;
    const { colunaId, proximoContatoEm, dataVisita, tipoVisita } = parsed.data;

    const scoped = role === 'corretor'
      ? and(eq(leads.id, req.params.id), eq(leads.imobiliariaId, imobiliariaId), eq(leads.corretorId, sub))
      : and(eq(leads.id, req.params.id), eq(leads.imobiliariaId, imobiliariaId));

    const [antes] = await db.select().from(leads).where(scoped).limit(1);
    if (!antes) return res.status(404).json({ error: 'Lead não encontrado' });
    const [col] = await db.select({ titulo: colunasKanban.titulo, slug: colunasKanban.slug }).from(colunasKanban)
      .where(and(eq(colunasKanban.id, colunaId), eq(colunasKanban.imobiliariaId, imobiliariaId))).limit(1);
    if (!col) return res.status(400).json({ error: 'Coluna não encontrada' });
    if (antes.colunaId === colunaId) return res.json(antes);

    if (vendaFechada(antes)) return res.status(409).json({ error: 'Negócio já fechado — não dá pra mudar a coluna.', motivo: 'venda_fechada' });
    if (antes.vendaPendenteAprovacao) return res.status(409).json({ error: 'Venda aguardando aprovação — não dá pra mudar a coluna agora.', motivo: 'venda_pendente' });
    if (col.slug === 'venda') {
      return res.status(409).json({ error: 'Pra levar o card pra VENDA, registre a venda (valor e empreendimento) — ela vai pra aprovação.', motivo: 'registrar_venda' });
    }
    const agora = Date.now();
    const extra: Partial<typeof leads.$inferInsert> = {};
    if (col.slug && SLUGS_EXIGEM_AGENDAMENTO.includes(col.slug)) {
      const visita = dataVisita ? new Date(dataVisita) : antes.dataVisita;
      if (!visita || +visita <= agora) {
        return res.status(409).json({ error: '"' + col.titulo + '" exige a data e o horário do compromisso.', motivo: 'agendamento' });
      }
      if (dataVisita) Object.assign(extra, { dataVisita: visita, tipoVisita: tipoVisita ?? (col.slug === 'fid' ? 'FID' : 'VISITA'), statusVisita: 'AGENDADA' });
    } else if (col.slug && SLUGS_EXIGEM_PROXIMO_CONTATO.includes(col.slug)) {
      const prox = proximoContatoEm ? new Date(proximoContatoEm) : antes.proximoContatoEm;
      if (!prox || +prox <= agora) {
        return res.status(409).json({ error: 'Marque a data e o horário do próximo contato.', motivo: 'proximo_contato' });
      }
      if (proximoContatoEm) extra.proximoContatoEm = prox;
    } else if (proximoContatoEm) {
      extra.proximoContatoEm = new Date(proximoContatoEm);
    }

    const [row] = await db.update(leads)
      // entrou em ANÁLISE DE CRÉDITO: o alerta vermelho acende de novo até a gestão dar "Visto"
      .set({ colunaId, entrouNaColunaEm: new Date(), ultimaAcaoEm: new Date(), ...extra, ...(col.slug === 'credito' ? { creditoAprovadoEm: null } : {}) })
      .where(scoped)
      .returning();
    if (!row) return res.status(404).json({ error: 'Lead não encontrado' });
    registrarEvento(imobiliariaId, row.id, 'coluna', 'Movido para "' + col.titulo + '"'
      + (extra.proximoContatoEm ? ' e agendou o próximo contato' : extra.dataVisita ? ' e marcou ' + (extra.tipoVisita ?? 'o compromisso') : ''), nome);
    // tirou do robô (coluna FOLLOW-UP AUTOMÁTICO) ou saiu do funil → para o follow-up
    const [colAntes] = antes.colunaId
      ? await db.select({ slug: colunasKanban.slug }).from(colunasKanban).where(eq(colunasKanban.id, antes.colunaId)).limit(1)
      : [];
    if (col.slug === 'credito') void avisarNovaPasta(imobiliariaId, row).catch(e => console.error('crédito aviso:', e.message));
    if (colAntes?.slug === 'followup_auto' || col.slug === 'rebatida') {
      void encerrarPorLead(io, imobiliariaId, row.id, colAntes?.slug === 'followup_auto' ? 'corretor tirou o card da coluna FOLLOW-UP AUTOMÁTICO' : 'lead saiu do funil');
    }
    io.to('imobiliaria:' + imobiliariaId).emit('lead:updated', row);
    res.json(row);
  });

  // Registrar uma chamada da cadência (Início → Chamada 5). Já agenda o próximo contato no
  // horário fixo (17h ou 11h do próximo dia útil) e manda o card pra TAREFAS.
  router.post('/:id/cadencia', async (req, res) => {
    const parsed = z.object({ cadencia: z.number().int().min(0).max(5) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Cadência inválida' });
    const { imobiliariaId, role, sub, nome } = req.auth!;
    const scoped = role === 'corretor'
      ? and(eq(leads.id, req.params.id), eq(leads.imobiliariaId, imobiliariaId), eq(leads.corretorId, sub))
      : and(eq(leads.id, req.params.id), eq(leads.imobiliariaId, imobiliariaId));
    const [antes] = await db.select().from(leads).where(scoped).limit(1);
    if (!antes) return res.status(404).json({ error: 'Lead não encontrado' });
    const agora = new Date();
    const proximo = calcularProximaCadencia(agora);
    const set: Partial<typeof leads.$inferInsert> = {
      cadenciaChamada: parsed.data.cadencia, cadencia: parsed.data.cadencia ? 'Chamada ' + parsed.data.cadencia : 'Início',
      dataUltimaChamada: agora, proximoContatoEm: proximo, ultimaAcaoEm: agora,
    };
    let saiuDoRobo = false;
    if (!vendaFechada(antes) && !antes.descartadoEm && !antes.vendaPendenteAprovacao) {
      const tarefasCol = await colunaPorSlug(imobiliariaId, 'atend');
      if (tarefasCol && antes.colunaId !== tarefasCol.id) {
        const [colAntes] = antes.colunaId ? await db.select({ slug: colunasKanban.slug }).from(colunasKanban).where(eq(colunasKanban.id, antes.colunaId)).limit(1) : [];
        saiuDoRobo = colAntes?.slug === 'followup_auto';
        Object.assign(set, { colunaId: tarefasCol.id, entrouNaColunaEm: agora });
      }
    }
    const [row] = await db.update(leads).set(set).where(scoped).returning();
    registrarEvento(imobiliariaId, row.id, 'cadencia', 'Cadência de chamada: ' + (parsed.data.cadencia ? 'Chamada ' + parsed.data.cadencia : 'Início')
      + ' · próximo contato ' + proximo.toLocaleString('pt-BR', { timeZone: FUSO, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }), nome);
    if (saiuDoRobo) void encerrarPorLead(io, imobiliariaId, row.id, 'corretor mudou a cadência de chamada');
    io.to('imobiliaria:' + imobiliariaId).emit('lead:updated', row);
    res.json(row);
  });

  // Descartar / devolver ao bolsão. Motivo extremo (Descadastrar, Já Comprou, Contato Errado...)
  // não descarta na hora: some do Kanban do corretor e espera a aprovação do dono/gerente.
  router.post('/:id/descartar', async (req, res) => {
    const parsed = z.object({ motivo: z.string().min(1).max(120), observacao: z.string().max(1000).optional() }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Escolha o motivo' });
    const { motivo } = parsed.data;
    const observacao = parsed.data.observacao?.trim() || null;
    if (MOTIVOS_DESCARTE_OBS_OBRIGATORIA.includes(motivo) && !observacao) {
      return res.status(400).json({ error: 'Esse motivo exige uma observação.' });
    }
    const { imobiliariaId, role, sub, nome } = req.auth!;
    const scoped = role === 'corretor'
      ? and(eq(leads.id, req.params.id), eq(leads.imobiliariaId, imobiliariaId), eq(leads.corretorId, sub))
      : and(eq(leads.id, req.params.id), eq(leads.imobiliariaId, imobiliariaId));
    const [antes] = await db.select().from(leads).where(scoped).limit(1);
    if (!antes) return res.status(404).json({ error: 'Lead não encontrado' });
    if (vendaFechada(antes) || antes.vendaPendenteAprovacao) return res.status(409).json({ error: 'Lead com venda registrada não pode ser descartado.' });

    await db.insert(descartesLeads).values({ imobiliariaId, leadId: antes.id, usuarioId: sub, motivo, observacao });
    const agora = new Date();
    let row;
    if (MOTIVOS_DESCARTE_EXTREMO.includes(motivo)) {
      [row] = await db.update(leads).set({ descartePendenteAprovacao: true, motivoDescarte: motivo, ultimaAcaoEm: agora })
        .where(eq(leads.id, antes.id)).returning();
      registrarEvento(imobiliariaId, antes.id, 'descarte', 'Pediu descarte (aguarda aprovação): ' + motivo + (observacao ? ' — ' + observacao : ''), nome);
      const gestores = await db.select({ id: perfis.id }).from(perfis)
        .where(and(eq(perfis.imobiliariaId, imobiliariaId), inArray(perfis.role, ['dono', 'gerente']), eq(perfis.bloqueado, false)));
      if (gestores.length) {
        await notificar(gestores.map(g => ({
          perfilId: g.id, leadId: antes.id, tipo: 'aprovacao_descarte', titulo: 'Descarte pra aprovar: ' + antes.nome, texto: motivo + ' · pedido por ' + nome,
        })));
      }
    } else {
      // vai pro bolsão sem corretor, sem próximo contato nem visita (não fica preso em Tarefas)
      const rebatida = await colunaPorSlug(imobiliariaId, 'rebatida');
      [row] = await db.update(leads).set({
        corretorId: null, colunaId: rebatida?.id ?? antes.colunaId, motivoDescarte: motivo, descartadoPor: sub, descartadoEm: agora,
        proximoContatoEm: null, dataVisita: null, statusVisita: null, ultimaAcaoEm: agora, entrouNaColunaEm: agora,
        ...(antes.iaStatus === 'atendendo' ? { iaStatus: 'pausado' as const, iaAguardandoDesde: null } : {}),
      }).where(eq(leads.id, antes.id)).returning();
      registrarEvento(imobiliariaId, antes.id, 'descarte', 'Lead devolvido: ' + motivo + (observacao ? ' — ' + observacao : ''), nome);
    }
    void encerrarPorLead(io, imobiliariaId, antes.id, 'lead descartado');
    io.to('imobiliaria:' + imobiliariaId).emit('lead:updated', row);
    res.json(row);
  });

  // Análise de Crédito (dono/gerente): "Visto" = documentação auditada, o alerta vermelho apaga.
  router.post('/:id/credito/visto', requireRole('dono', 'gerente'), async (req, res) => {
    const { imobiliariaId, nome } = req.auth!;
    const [row] = await db.update(leads).set({ creditoAprovadoEm: new Date(), ultimaAcaoEm: new Date() })
      .where(and(eq(leads.id, req.params.id), eq(leads.imobiliariaId, imobiliariaId))).returning();
    if (!row) return res.status(404).json({ error: 'Lead não encontrado' });
    registrarEvento(imobiliariaId, row.id, 'credito', 'Visto na Análise de Crédito — documentação auditada', nome);
    io.to('imobiliaria:' + imobiliariaId).emit('lead:updated', row);
    res.json(row);
  });

  // "Retornar com pendência": volta pro corretor em PENDENTE com a nota do que falta (modal pro corretor).
  router.post('/:id/credito/pendencia', requireRole('dono', 'gerente'), async (req, res) => {
    const parsed = z.object({ observacao: z.string().trim().min(1).max(1000) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Escreva o que está faltando.' });
    const { imobiliariaId, nome } = req.auth!;
    const pendente = await colunaPorSlug(imobiliariaId, 'pendente');
    const [row] = await db.update(leads).set({
      ...(pendente ? { colunaId: pendente.id, entrouNaColunaEm: new Date() } : {}), ultimaAcaoEm: new Date(),
    }).where(and(eq(leads.id, req.params.id), eq(leads.imobiliariaId, imobiliariaId))).returning();
    if (!row) return res.status(404).json({ error: 'Lead não encontrado' });
    registrarEvento(imobiliariaId, row.id, 'alerta', 'Análise de Crédito retornada com pendência: ' + parsed.data.observacao, nome);
    await avisarPendencia(row, parsed.data.observacao);
    io.to('imobiliaria:' + imobiliariaId).emit('lead:updated', row);
    res.json(row);
  });

  // Registrar venda: NÃO fecha na hora — vai pra aprovação do dono/gerente (coluna não muda aqui).
  router.post('/:id/venda', async (req, res) => {
    const parsed = z.object({
      valor: z.number().positive(), dataVenda: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      empreendimento: z.string().max(200).optional(), unidade: z.string().max(60).optional(), torre: z.string().max(60).optional(),
      observacao: z.string().max(1000).optional(),
    }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Informe o valor e a data da venda.' });
    const d = parsed.data;
    if (d.dataVenda > hojeSp()) return res.status(400).json({ error: 'A data da venda não pode ser no futuro.' });
    const { imobiliariaId, role, sub, nome } = req.auth!;
    const scoped = role === 'corretor'
      ? and(eq(leads.id, req.params.id), eq(leads.imobiliariaId, imobiliariaId), eq(leads.corretorId, sub))
      : and(eq(leads.id, req.params.id), eq(leads.imobiliariaId, imobiliariaId));
    const [antes] = await db.select().from(leads).where(scoped).limit(1);
    if (!antes) return res.status(404).json({ error: 'Lead não encontrado' });
    if (vendaFechada(antes)) return res.status(409).json({ error: 'Esse lead já tem venda aprovada.' });
    const [row] = await db.update(leads).set({
      vendaPendenteAprovacao: true, valorVenda: String(d.valor), empreendimento: d.empreendimento || null,
      unidade: d.unidade || null, torre: d.torre || null, dataVendaInformada: d.dataVenda, ultimaAcaoEm: new Date(),
    }).where(eq(leads.id, antes.id)).returning();
    const dataBr = d.dataVenda.split('-').reverse().join('/');
    registrarEvento(imobiliariaId, antes.id, 'venda', `Venda enviada pra aprovação · data ${dataBr} · ${d.valor.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}`
      + ` · ${d.empreendimento || '-'} · unidade ${d.unidade || '-'} · torre ${d.torre || '-'}` + (d.observacao ? ' · ' + d.observacao : ''), nome);
    const gestores = await db.select({ id: perfis.id }).from(perfis)
      .where(and(eq(perfis.imobiliariaId, imobiliariaId), inArray(perfis.role, ['dono', 'gerente']), eq(perfis.bloqueado, false)));
    if (gestores.length) {
      await notificar(gestores.map(g => ({
        perfilId: g.id, leadId: antes.id, tipo: 'aprovacao_venda', titulo: 'Venda pra aprovar: ' + antes.nome, texto: 'Registrada por ' + nome,
      })));
    }
    io.to('imobiliaria:' + imobiliariaId).emit('lead:updated', row);
    res.json(row);
  });

  // Tirar o compromisso (visita/FID) marcado sem querer — some do card e da agenda.
  router.post('/:id/remover-compromisso', async (req, res) => {
    const { imobiliariaId, role, sub, nome } = req.auth!;
    const scoped = role === 'corretor'
      ? and(eq(leads.id, req.params.id), eq(leads.imobiliariaId, imobiliariaId), eq(leads.corretorId, sub))
      : and(eq(leads.id, req.params.id), eq(leads.imobiliariaId, imobiliariaId));
    const [antes] = await db.select().from(leads).where(scoped).limit(1);
    if (!antes) return res.status(404).json({ error: 'Lead não encontrado' });
    const [row] = await db.update(leads).set({ dataVisita: null, statusVisita: null, ultimaAcaoEm: new Date() }).where(eq(leads.id, antes.id)).returning();
    if (antes.dataVisita) {
      registrarEvento(imobiliariaId, antes.id, 'visita', 'Compromisso (' + (antes.tipoVisita || 'VISITA') + ') de '
        + antes.dataVisita.toLocaleString('pt-BR', { timeZone: FUSO, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) + ' removido do card', nome);
    }
    io.to('imobiliaria:' + imobiliariaId).emit('lead:updated', row);
    res.json(row);
  });

  // Transferir (um ou vários) leads pra um corretor — só dono/gerente. Avisa o corretor.
  router.post('/transferir', requireRole('dono', 'gerente'), async (req, res) => {
    const parsed = z.object({ leadIds: z.array(z.string().uuid()).min(1).max(500), corretorId: z.string().uuid() }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Escolha os leads e o corretor' });
    const { imobiliariaId, nome } = req.auth!;
    const [corretor] = await db.select({ id: perfis.id, nome: perfis.nome }).from(perfis)
      .where(and(eq(perfis.id, parsed.data.corretorId), eq(perfis.imobiliariaId, imobiliariaId), eq(perfis.bloqueado, false))).limit(1);
    if (!corretor) return res.status(404).json({ error: 'Corretor não encontrado' });
    const rows = await distribuirLeads(imobiliariaId, parsed.data.leadIds, corretor.id, 'manual');
    for (const r of rows) {
      registrarEvento(imobiliariaId, r.id, 'atribuicao', 'Transferido para ' + corretor.nome, nome);
      io.to('imobiliaria:' + imobiliariaId).emit('lead:updated', r);
      // a régua do corretor antigo para antes de a do novo (fluxo Geral) começar
      void encerrarPorLead(io, imobiliariaId, r.id, 'lead passou pra outro corretor')
        .then(() => dispararGatilhoLeadNovo(io, imobiliariaId, r.id, corretor.id));
    }
    res.json({ ok: true, total: rows.length });
  });

  const updateSchema = z.object({
    nome: z.string().min(1).optional(),
    telefone: z.string().min(8).optional(),
    email: z.string().email().optional(),
    corretorId: z.string().uuid().nullable().optional(),
    motivoDescarte: z.string().nullable().optional(),
    cadencia: z.string().nullable().optional(),
    finalidade: z.enum(['venda', 'locacao']).nullable().optional(),
    rendaDeclarada: z.number().optional(),
    // campos do card da v1
    temperatura: z.enum(['quente', 'morno', 'frio']).nullable().optional(),
    telefoneAlternativo: z.string().max(40).nullable().optional(),
    bairroInteresse: z.string().max(120).nullable().optional(),
    tipoImovelInteresse: z.string().max(120).nullable().optional(),
    referencia: z.string().max(200).nullable().optional(),
    linkDrive: z.string().max(500).nullable().optional(),
    saldoFgts: z.number().nullable().optional(),
    valorEntrada: z.number().nullable().optional(),
    dataNascimento: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    favorito: z.boolean().optional(),
    proximoContatoEm: z.string().datetime({ offset: true }).nullable().optional(),
    dataVisita: z.string().datetime({ offset: true }).optional(),
    tipoVisita: z.enum(['VISITA', 'FID']).optional(),
    statusVisita: z.enum(['AGENDADA', 'REALIZADA', 'DESMARCADA', 'REAGENDADA', 'FURO']).optional(),
  });
  // Rótulos pro histórico automático (v1: toda mudança no card vira registro, sem o corretor anotar).
  const ROTULOS: Record<string, string> = {
    nome: 'Nome', telefone: 'Telefone', email: 'E-mail', temperatura: 'Temperatura', telefoneAlternativo: 'Telefone alternativo',
    bairroInteresse: 'Bairro de interesse', tipoImovelInteresse: 'Tipo de imóvel', referencia: 'Referência', linkDrive: 'Link do Drive',
    saldoFgts: 'Saldo FGTS', valorEntrada: 'Valor de entrada', rendaDeclarada: 'Renda familiar', dataNascimento: 'Data de nascimento',
    proximoContatoEm: 'Próximo contato', dataVisita: 'Data do compromisso', tipoVisita: 'Tipo de compromisso', statusVisita: 'Status do compromisso',
    favorito: 'Favorito',
  };
  const NUMERICOS = ['saldoFgts', 'valorEntrada'];
  const DATAS = ['proximoContatoEm', 'dataVisita'];

  router.patch('/:id', async (req, res) => {
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Dados inválidos' });
    const { imobiliariaId, role, sub, nome } = req.auth!;
    const scoped = role === 'corretor'
      ? and(eq(leads.id, req.params.id), eq(leads.imobiliariaId, imobiliariaId), eq(leads.corretorId, sub))
      : and(eq(leads.id, req.params.id), eq(leads.imobiliariaId, imobiliariaId));

    const [antes] = await db.select().from(leads).where(scoped).limit(1);
    if (!antes) return res.status(404).json({ error: 'Lead não encontrado' });
    // corretor só troca o próprio lead de dono via "Transferir" (dono/gerente)
    if (role === 'corretor' && parsed.data.corretorId !== undefined && parsed.data.corretorId !== antes.corretorId) {
      return res.status(403).json({ error: 'Só dono ou gerente transferem lead.' });
    }
    const { rendaDeclarada, ...rest } = parsed.data;
    const conv: Record<string, unknown> = { ...rest };
    for (const k of NUMERICOS) if (conv[k] != null) conv[k] = String(conv[k]);
    for (const k of DATAS) if (typeof conv[k] === 'string') conv[k] = new Date(conv[k] as string);
    if (conv.dataVisita && !conv.statusVisita) conv.statusVisita = 'AGENDADA';
    // Atribuir ou descartar na mão tira o lead das mãos do Agente de IA.
    const tiraDaIa = antes.iaStatus === 'atendendo' && (!!rest.corretorId || !!rest.motivoDescarte);
    const [row] = await db.update(leads)
      .set({
        ...conv,
        ...(rendaDeclarada != null ? { rendaDeclarada: rendaDeclarada.toString() } : {}),
        ...(tiraDaIa ? { iaStatus: 'pausado' as const, iaAguardandoDesde: null } : {}),
        ultimaAcaoEm: new Date(),
      })
      .where(scoped)
      .returning();
    if (!row) return res.status(404).json({ error: 'Lead não encontrado' });
    const fmt = (k: string, v: unknown) => v == null || v === '' ? '—'
      : v instanceof Date ? v.toLocaleString('pt-BR', { timeZone: FUSO, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
      : k === 'favorito' ? (v ? 'sim' : 'não') : String(v);
    const mudancas = Object.keys(parsed.data).filter(k => ROTULOS[k])
      .map(k => [k, (antes as any)[k], (row as any)[k]] as const)
      .filter(([, a, d]) => String(a instanceof Date ? +a : a ?? '') !== String(d instanceof Date ? +d : d ?? ''))
      .map(([k, , d]) => ROTULOS[k] + ': ' + fmt(k, d));
    if (mudancas.length) registrarEvento(imobiliariaId, row.id, 'auto', 'Alterou ' + mudancas.join(' · '), nome);
    if (tiraDaIa) registrarEvento(imobiliariaId, row.id, 'ia', 'Agente de IA pausado: o lead foi ' + (rest.motivoDescarte ? 'descartado' : 'atribuído') + ' manualmente', nome);
    if (rest.corretorId !== undefined && rest.corretorId !== antes?.corretorId) {
      if (rest.corretorId) {
        const [c] = await db.select({ nome: perfis.nome }).from(perfis).where(eq(perfis.id, rest.corretorId)).limit(1);
        registrarEvento(imobiliariaId, row.id, 'atribuicao', 'Atribuído a ' + (c?.nome ?? 'corretor'), nome);
        // v1: todo lead que ganha corretor já nasce com próximo contato (tarefa pra hoje)
        const agora = new Date();
        await db.update(leads).set({ dataAtribuicao: agora, ...(row.proximoContatoEm ? {} : { proximoContatoEm: agora }) }).where(eq(leads.id, row.id));
        Object.assign(row, { dataAtribuicao: agora, proximoContatoEm: row.proximoContatoEm ?? agora });
        void dispararGatilhoLeadNovo(io, imobiliariaId, row.id, rest.corretorId);
      } else {
        registrarEvento(imobiliariaId, row.id, 'atribuicao', 'Removido do corretor', nome);
        void encerrarPorLead(io, imobiliariaId, row.id, 'lead sem corretor');
      }
    }
    if (rest.motivoDescarte && rest.motivoDescarte !== antes?.motivoDescarte) {
      registrarEvento(imobiliariaId, row.id, 'descarte', 'Descartado: ' + rest.motivoDescarte, nome);
      void encerrarPorLead(io, imobiliariaId, row.id, 'lead descartado');
      // descarte manda o lead pro bolsão (coluna Rebatida) e tira o corretor
      const [colReb] = await db.select({ id: colunasKanban.id }).from(colunasKanban)
        .where(and(eq(colunasKanban.imobiliariaId, imobiliariaId), eq(colunasKanban.slug, 'rebatida'))).limit(1);
      if (colReb && row.colunaId !== colReb.id) {
        const [movido] = await db.update(leads).set({ colunaId: colReb.id, corretorId: null, entrouNaColunaEm: new Date() }).where(eq(leads.id, row.id)).returning();
        if (movido) { io.to('imobiliaria:' + imobiliariaId).emit('lead:updated', movido); return res.json(movido); }
      }
    }
    io.to('imobiliaria:' + imobiliariaId).emit('lead:updated', row);
    res.json(row);
  });

  // Corretor recusa um lead que caiu pra ele — volta pra roleta (ele vai pro fim da fila).
  router.post('/:id/recusar', async (req, res) => {
    const { imobiliariaId, sub, nome } = req.auth!;
    // porTempo = o corretor não respondeu o popup a tempo (o front recusa sozinho)
    const porTempo = req.body?.porTempo === true;
    const [lead] = await db.select().from(leads)
      .where(and(eq(leads.id, req.params.id), eq(leads.imobiliariaId, imobiliariaId), eq(leads.corretorId, sub))).limit(1);
    if (!lead) return res.status(404).json({ error: 'Lead não encontrado ou não é seu' });

    await db.update(leads).set({ corretorId: null }).where(eq(leads.id, lead.id));
    // quem recusou vai pro fim: marca ultimaAtribuicao como agora
    await db.update(filasAtendimento).set({ ultimaAtribuicao: new Date() }).where(eq(filasAtendimento.corretorId, sub));
    io.to('imobiliaria:' + imobiliariaId).emit('lead:updated', { ...lead, corretorId: null });
    registrarEvento(imobiliariaId, lead.id, 'recusa', porTempo
      ? nome + ' não respondeu ao lead a tempo — devolvido à roleta'
      : 'Lead recusado por ' + nome + ' — devolvido à roleta', nome);
    const [recusa] = await db.insert(recusasLead).values({ imobiliariaId, leadId: lead.id, corretorId: sub, motivo: porTempo ? 'sem_resposta' : 'recusou' }).returning();
    await encerrarPorLead(io, imobiliariaId, lead.id, 'lead recusado');

    const novoCorretor = await distribuirLead(io, imobiliariaId, lead.id);
    if (novoCorretor) await db.update(recusasLead).set({ redistribuidoParaId: novoCorretor }).where(eq(recusasLead.id, recusa.id));
    res.json({ ok: true, redistribuido: !!novoCorretor });
  });

  // Limpa só a conversa de WhatsApp do lead (o lead continua). Só dono/gerente.
  router.delete('/:id/conversa', requireRole('dono', 'gerente'), async (req, res) => {
    const { imobiliariaId } = req.auth!;
    const [lead] = await db.select({ id: leads.id }).from(leads)
      .where(and(eq(leads.id, req.params.id), eq(leads.imobiliariaId, imobiliariaId))).limit(1);
    if (!lead) return res.status(404).json({ error: 'Lead não encontrado' });
    await db.delete(mensagensWhatsapp).where(eq(mensagensWhatsapp.leadId, lead.id));
    io.to('imobiliaria:' + imobiliariaId).emit('conversa:limpa', { leadId: lead.id });
    res.json({ ok: true });
  });

  // Exclui o lead do CRM inteiro (conversa, etiquetas, tudo — FKs ON DELETE CASCADE).
  // SÓ dono/gerente — corretor não apaga lead do CRM (usa "Descartar" pra tirar do funil).
  router.delete('/:id', requireRole('dono', 'gerente'), async (req, res) => {
    const { imobiliariaId } = req.auth!;
    const [lead] = await db.select({ id: leads.id }).from(leads)
      .where(and(eq(leads.id, req.params.id), eq(leads.imobiliariaId, imobiliariaId))).limit(1);
    if (!lead) return res.status(404).json({ error: 'Lead não encontrado' });
    await db.delete(leads).where(eq(leads.id, lead.id));
    io.to('imobiliaria:' + imobiliariaId).emit('lead:removido', { id: lead.id });
    res.json({ ok: true });
  });

  // --- Puxar rebatidas do bolsão (corretor pega leads rebatidos sem dono) ---
  async function statusRebatidas(imobiliariaId: string, corretorId: string) {
    const [imob] = await db.select({ limite: imobiliarias.limiteRebatidasDia }).from(imobiliarias).where(eq(imobiliarias.id, imobiliariaId)).limit(1);
    const limite = imob?.limite ?? 0;
    const inicioDia = new Date(); inicioDia.setHours(0, 0, 0, 0);
    const [{ n: puxadasHoje }] = await db.select({ n: sql<number>`count(*)::int` }).from(distribuicaoLog)
      .where(and(eq(distribuicaoLog.corretorId, corretorId), eq(distribuicaoLog.origem, 'rebatida-puxada'), gte(distribuicaoLog.criadoEm, inicioDia)));
    const [{ n: tarefasAtrasadas }] = await db.select({ n: sql<number>`count(*)::int` }).from(tarefas)
      .where(and(eq(tarefas.corretorId, corretorId), eq(tarefas.concluida, false), lt(tarefas.venceEm, new Date())));
    const [colReb] = await db.select({ id: colunasKanban.id }).from(colunasKanban)
      .where(and(eq(colunasKanban.imobiliariaId, imobiliariaId), eq(colunasKanban.slug, 'rebatida'))).limit(1);
    const [{ n: disponiveis }] = colReb
      ? await db.select({ n: sql<number>`count(*)::int` }).from(leads).where(and(eq(leads.colunaId, colReb.id), isNull(leads.corretorId)))
      : [{ n: 0 }];
    return { limite, puxadasHoje, tarefasAtrasadas, disponiveis, colRebId: colReb?.id ?? null };
  }

  router.get('/rebatidas/status', async (req, res) => {
    const { imobiliariaId, sub } = req.auth!;
    const s = await statusRebatidas(imobiliariaId, sub);
    res.json({ limite: s.limite, puxadasHoje: s.puxadasHoje, tarefasAtrasadas: s.tarefasAtrasadas, disponiveis: s.disponiveis });
  });

  router.post('/rebatidas/puxar', async (req, res) => {
    const { imobiliariaId, sub, nome, role } = req.auth!;
    const alvoId = role !== 'corretor' && typeof req.body?.corretorId === 'string' ? req.body.corretorId : sub;
    const s = await statusRebatidas(imobiliariaId, alvoId);
    if (s.tarefasAtrasadas > 0) return res.status(409).json({ error: 'Resolva suas ' + s.tarefasAtrasadas + ' tarefa(s) atrasada(s) antes de puxar rebatidas.', motivo: 'tarefas' });
    if (s.limite > 0 && s.puxadasHoje >= s.limite) return res.status(409).json({ error: 'Você já puxou o máximo de ' + s.limite + ' rebatidas hoje.', motivo: 'limite' });
    if (!s.colRebId) return res.status(400).json({ error: 'Coluna de rebatidas não configurada' });

    const [colAtend] = await db.select({ id: colunasKanban.id }).from(colunasKanban)
      .where(and(eq(colunasKanban.imobiliariaId, imobiliariaId), eq(colunasKanban.slug, 'atend'))).limit(1);

    const [lead] = await db.select().from(leads)
      .where(and(eq(leads.colunaId, s.colRebId), isNull(leads.corretorId), eq(leads.imobiliariaId, imobiliariaId)))
      .orderBy(asc(leads.entrouNaColunaEm)).limit(1);
    if (!lead) return res.status(404).json({ error: 'Nenhuma rebatida disponível no bolsão agora.', motivo: 'vazio' });

    const [atualizado] = await db.update(leads)
      .set({ corretorId: alvoId, colunaId: colAtend?.id ?? lead.colunaId, entrouNaColunaEm: new Date(), motivoDescarte: null })
      .where(and(eq(leads.id, lead.id), isNull(leads.corretorId))).returning();
    if (!atualizado) return res.status(409).json({ error: 'Alguém puxou essa rebatida primeiro. Tenta de novo.' });

    await db.insert(distribuicaoLog).values({ imobiliariaId, leadId: lead.id, corretorId: alvoId, origem: 'rebatida-puxada' });
    await notificar({ perfilId: alvoId, tipo: 'lead', titulo: 'Rebatida puxada', texto: atualizado.nome + ' voltou pra sua carteira.' });
    registrarEvento(imobiliariaId, lead.id, 'roleta', 'Rebatida puxada do bolsão por ' + nome, nome);
    io.to('imobiliaria:' + imobiliariaId).emit('lead:updated', atualizado);

    const novo = await statusRebatidas(imobiliariaId, alvoId);
    res.json({ lead: atualizado, status: { limite: novo.limite, puxadasHoje: novo.puxadasHoje, tarefasAtrasadas: novo.tarefasAtrasadas, disponiveis: novo.disponiveis } });
  });

  // Linha do tempo do lead (eventos reais registrados pelo sistema + notas manuais).
  router.get('/:id/eventos', async (req, res) => {
    const { imobiliariaId, role, sub } = req.auth!;
    const scoped = role === 'corretor'
      ? and(eq(leads.id, req.params.id), eq(leads.imobiliariaId, imobiliariaId), eq(leads.corretorId, sub))
      : and(eq(leads.id, req.params.id), eq(leads.imobiliariaId, imobiliariaId));
    const [lead] = await db.select({ id: leads.id }).from(leads).where(scoped).limit(1);
    if (!lead) return res.status(404).json({ error: 'Lead não encontrado' });
    const rows = await db.select().from(eventosLead)
      .where(eq(eventosLead.leadId, lead.id)).orderBy(desc(eventosLead.criadoEm));
    res.json(rows);
  });

  // Nota manual na linha do tempo.
  router.post('/:id/eventos', async (req, res) => {
    const parsed = z.object({ texto: z.string().min(1).max(1000) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Texto obrigatório' });
    const { imobiliariaId, role, sub, nome } = req.auth!;
    const scoped = role === 'corretor'
      ? and(eq(leads.id, req.params.id), eq(leads.imobiliariaId, imobiliariaId), eq(leads.corretorId, sub))
      : and(eq(leads.id, req.params.id), eq(leads.imobiliariaId, imobiliariaId));
    const [lead] = await db.select({ id: leads.id }).from(leads).where(scoped).limit(1);
    if (!lead) return res.status(404).json({ error: 'Lead não encontrado' });
    const [row] = await db.insert(eventosLead)
      .values({ imobiliariaId, leadId: lead.id, tipo: 'nota', descricao: parsed.data.texto, atorNome: nome })
      .returning();
    res.status(201).json(row);
  });

  return router;
}
