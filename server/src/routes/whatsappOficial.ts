import { Router } from 'express';
import { z } from 'zod';
import { and, asc, eq } from 'drizzle-orm';
import type { Server as SocketServer } from 'socket.io';
import { db } from '../db/client.js';
import { leads, mensagensWhatsapp, sessoesWhatsapp } from '../db/schema.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { requirePlataforma } from '../middleware/plataforma.js';
import {
  apagarModelo, assinarApp, assinaturaValida, baixarMidiaOficial, cifrarToken, configPublica, criarModelo, hubLiberarNumero,
  hubRegistrarNumero, infoNumero, janelaAberta, lembrarWaId, listarModelos, numerosDaWaba, oficialConfigurado, primeiroNome,
  sincronizarCoexistencia, trocarCodigo, publica, enviarModeloLivre, chaveDaMensagem, reservarChave,
} from '../lib/whatsappOficial.js';
import { processarMensagem, type MensagemWhatsapp } from './whatsapp.js';
import { carregarLeadAutorizado } from './mensagens.js';
import { pausarIa } from '../lib/agenteIa.js';
import { registrarEvento } from '../lib/eventos.js';

const soDigitos = (s: string) => (s || '').replace(/\D/g, '');
type Sessao = typeof sessoesWhatsapp.$inferSelect;

// Status da oficial → "visto" do CRM (1=enviando, 2=no servidor, 3=entregue, 4=lido).
const ACK: Record<string, number> = { sent: 2, delivered: 3, read: 4 };

/** Tipo de mensagem da Cloud API → anexo do CRM. */
function anexoDe(msg: any): { tipo: MensagemWhatsapp['anexoTipo']; mediaId: string | null; nome: string | null; legenda: string | null } {
  const t = msg?.type;
  const m = t ? msg[t] : null;
  if (t === 'image') return { tipo: 'imagem', mediaId: m?.id ?? null, nome: null, legenda: m?.caption ?? null };
  if (t === 'video') return { tipo: 'video', mediaId: m?.id ?? null, nome: null, legenda: m?.caption ?? null };
  if (t === 'audio') return { tipo: 'audio', mediaId: m?.id ?? null, nome: null, legenda: null };
  if (t === 'document') return { tipo: 'documento', mediaId: m?.id ?? null, nome: m?.filename ?? null, legenda: m?.caption ?? null };
  if (t === 'sticker') return { tipo: 'documento', mediaId: m?.id ?? null, nome: 'figurinha.webp', legenda: null };
  return { tipo: null, mediaId: null, nome: null, legenda: null };
}

/** Texto legível de mensagens sem mídia (botão, lista, localização, contato...). */
function textoDe(msg: any): string | null {
  switch (msg?.type) {
    case 'text': return msg.text?.body ?? null;
    case 'button': return msg.button?.text ?? null;
    case 'interactive': return msg.interactive?.button_reply?.title ?? msg.interactive?.list_reply?.title ?? null;
    case 'location': {
      const l = msg.location || {};
      return '📍 ' + [l.name, l.address].filter(Boolean).join(' — ') + (l.latitude != null ? ` (https://maps.google.com/?q=${l.latitude},${l.longitude})` : '');
    }
    case 'contacts': return '👤 ' + (msg.contacts || []).map((c: any) => [c.name?.formatted_name, c.phones?.[0]?.phone].filter(Boolean).join(' ')).join(', ');
    default: return null;
  }
}

export function whatsappOficialRouter(io: SocketServer) {
  const router = Router();

  // ---------------------------------------------------------------
  // WEBHOOK — a Meta manda pro hub InoovaWeb, que repassa (corpo e assinatura originais) só
  // as mensagens dos números deste CRM. Sem JWT: vale a assinatura do App Secret.
  // ---------------------------------------------------------------
  router.get('/webhook', (req, res) => {
    // só usado se o webhook do app apontar direto pro CRM (sem hub)
    if (req.query['hub.mode'] === 'subscribe' && process.env.WA_VERIFY_TOKEN && req.query['hub.verify_token'] === process.env.WA_VERIFY_TOKEN) {
      return res.status(200).send(String(req.query['hub.challenge'] ?? ''));
    }
    res.sendStatus(403);
  });

  router.post('/webhook', async (req, res) => {
    const raw = (req as unknown as { rawBody?: Buffer }).rawBody;
    if (!assinaturaValida(raw, req.header('x-hub-signature-256'))) return res.sendStatus(401);
    res.sendStatus(200); // responde rápido, processa depois
    try {
      await processarWebhook(io, req.body);
    } catch (e) {
      console.error('webhook oficial:', (e as Error).message);
    }
  });

  /** Admin da plataforma: liga a oficial num número que JÁ está na API oficial por este mesmo app
   *  (ex.: conectado antes pelo Chatwoot), reaproveitando o token de usuário do sistema — o Cadastro
   *  Incorporado não deixa conectar de novo um número que já está registrado. */
  router.post('/vincular', requirePlataforma, async (req, res) => {
    const parsed = z.object({
      imobiliariaId: z.string().uuid(),
      token: z.string().min(50),
      wabaId: z.string().regex(/^\d+$/),
      phoneNumberId: z.string().regex(/^\d+$/),
      sessaoId: z.string().uuid().optional(),
    }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Dados incompletos' });
    const r = await ligarOficial(io, parsed.data.imobiliariaId, { ...parsed.data, sincronizar: false });
    res.status(r.status).json(r.body);
  });

  // ---------------------------------------------------------------
  // Tela de Integrações (dono/gerente) e chat
  // ---------------------------------------------------------------
  router.use(requireAuth);

  router.get('/config', (_req, res) => res.json(configPublica()));

  /** Situação da conversa: dá pra responder livre (janela aberta / WAHA no ar) ou só por modelo? */
  router.get('/conversa/:leadId', async (req, res) => {
    const { imobiliariaId, role, sub } = req.auth!;
    const lead = await carregarLeadAutorizado(req.params.leadId, imobiliariaId, role, sub);
    if (!lead) return res.status(lead === null ? 404 : 403).json({ error: 'Lead não encontrado' });
    const sessao = await sessaoDoLead(imobiliariaId, lead.sessaoWhatsappId);
    if (!sessao) return res.json({ oficial: false });
    res.json({
      oficial: true,
      sessaoId: sessao.id,
      janelaAberta: await janelaAberta(lead.id),
      naoOficialNoAr: sessao.status === 'conectada',
      nomeSugerido: primeiroNome(lead.nome),
    });
  });

  /** Modelos aprovados pro chat (qualquer um que pode falar com o lead). */
  router.get('/conversa/:leadId/modelos', async (req, res) => {
    const { imobiliariaId, role, sub } = req.auth!;
    const lead = await carregarLeadAutorizado(req.params.leadId, imobiliariaId, role, sub);
    if (!lead) return res.status(lead === null ? 404 : 403).json({ error: 'Lead não encontrado' });
    const sessao = await sessaoDoLead(imobiliariaId, lead.sessaoWhatsappId);
    if (!sessao) return res.json([]);
    try {
      res.json((await listarModelos(sessao)).filter(m => m.status === 'APPROVED'));
    } catch (e) { res.status(502).json({ error: 'A Meta recusou: ' + (e as Error).message }); }
  });

  /** Corretor manda um modelo pelo chat (janela de 24h fechada e sem WAHA). */
  router.post('/conversa/:leadId/modelo', async (req, res) => {
    const parsed = z.object({ nome: z.string().min(1), idioma: z.string().min(2), valores: z.array(z.string().max(300)).max(10).default([]) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Dados inválidos' });
    const { imobiliariaId, role, sub } = req.auth!;
    const lead = await carregarLeadAutorizado(req.params.leadId, imobiliariaId, role, sub);
    if (!lead) return res.status(lead === null ? 404 : 403).json({ error: 'Lead não encontrado' });
    const sessao = await sessaoDoLead(imobiliariaId, lead.sessaoWhatsappId);
    if (!sessao) return res.status(400).json({ error: 'Nenhum número com a API oficial ativa' });
    try {
      const { id, texto } = await enviarModeloLivre(sessao, lead.telefone, parsed.data.nome, parsed.data.idioma, parsed.data.valores);
      const chave = chaveDaMensagem(id);
      if (chave) reservarChave(lead.telefone, chave);
      const [row] = await db.insert(mensagensWhatsapp).values({
        leadId: lead.id, direcao: 'out', canal: 'corretor', enviadoPor: sub, waMessageId: id, waChave: chave, ackStatus: 2, texto,
      }).returning();
      if (!lead.sessaoWhatsappId) await db.update(leads).set({ sessaoWhatsappId: sessao.id }).where(eq(leads.id, lead.id));
      io.to('imobiliaria:' + imobiliariaId).emit('mensagem:created', row);
      if (lead.iaStatus === 'atendendo') void pausarIa(io, lead.id, 'alguém da equipe mandou um modelo pelo CRM');
      registrarEvento(imobiliariaId, lead.id, 'whatsapp', 'Modelo "' + parsed.data.nome + '" enviado pela API oficial', 'CRM');
      res.status(201).json(row);
    } catch (e) {
      res.status(502).json({ error: 'A Meta recusou: ' + (e as Error).message });
    }
  });

  router.use(requireRole('dono', 'gerente'));

  /** Volta do Cadastro Incorporado: troca o code, assina o app na WABA, liga o número ao CRM. */
  router.post('/conectar', async (req, res) => {
    if (!oficialConfigurado()) return res.status(400).json({ error: 'API oficial não configurada no servidor (WA_APP_ID / WA_APP_SECRET / WA_CONFIG_ID).' });
    const parsed = z.object({
      code: z.string().min(10),
      wabaId: z.string().regex(/^\d+$/),
      phoneNumberId: z.string().regex(/^\d+$/).optional(),
      sessaoId: z.string().uuid().optional(),
    }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Dados do cadastro incompletos' });
    let token: string;
    try { token = await trocarCodigo(parsed.data.code); } catch (e) { return res.status(502).json({ error: 'A Meta recusou o código: ' + (e as Error).message }); }
    const r = await ligarOficial(io, req.auth!.imobiliariaId, { ...parsed.data, token, sincronizar: true });
    res.status(r.status).json(r.body);
  });

  /** Desliga a oficial do número (o WAHA, se houver, continua). */
  router.delete('/:sessaoId', async (req, res) => {
    const sessao = await sessaoDaImob(req.auth!.imobiliariaId, req.params.sessaoId);
    if (!sessao) return res.status(404).json({ error: 'Número não encontrado' });
    if (sessao.oficialPhoneNumberId) await hubLiberarNumero(sessao.oficialPhoneNumberId);
    const limpo = {
      oficialPhoneNumberId: null, oficialWabaId: null, oficialNumero: null, oficialTokenCifrado: null, oficialTokenIv: null,
      oficialTokenTag: null, oficialAtiva: false, oficialErro: null, oficialTemplate: null, oficialTemplateIdioma: null,
    };
    const [row] = await db.update(sessoesWhatsapp).set(limpo).where(eq(sessoesWhatsapp.id, sessao.id)).returning();
    res.json(publica(row));
  });

  /** Modelo da 1ª mensagem (quando o WAHA está fora e a janela fechada). */
  router.patch('/:sessaoId', async (req, res) => {
    const parsed = z.object({ template: z.string().nullable(), idioma: z.string().nullable().optional() }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Dados inválidos' });
    const sessao = await sessaoDaImob(req.auth!.imobiliariaId, req.params.sessaoId);
    if (!sessao?.oficialAtiva) return res.status(404).json({ error: 'Número sem API oficial' });
    if (parsed.data.template) {
      const m = (await listarModelos(sessao).catch(() => [])).find(x => x.nome === parsed.data.template && (!parsed.data.idioma || x.idioma === parsed.data.idioma));
      if (!m || m.status !== 'APPROVED') return res.status(400).json({ error: 'Escolha um modelo aprovado' });
      if (m.variaveis > 1) return res.status(400).json({ error: 'O modelo da 1ª mensagem pode ter no máximo uma variável ({{1}} = nome do cliente)' });
    }
    const [row] = await db.update(sessoesWhatsapp).set({ oficialTemplate: parsed.data.template, oficialTemplateIdioma: parsed.data.template ? parsed.data.idioma ?? null : null })
      .where(eq(sessoesWhatsapp.id, sessao.id)).returning();
    res.json(publica(row));
  });

  router.get('/:sessaoId/modelos', async (req, res) => {
    const sessao = await sessaoDaImob(req.auth!.imobiliariaId, req.params.sessaoId);
    if (!sessao?.oficialAtiva) return res.status(404).json({ error: 'Número sem API oficial' });
    try { res.json(await listarModelos(sessao)); } catch (e) { res.status(502).json({ error: 'A Meta recusou: ' + (e as Error).message }); }
  });

  router.post('/:sessaoId/modelos', async (req, res) => {
    const parsed = z.object({
      nome: z.string().regex(/^[a-z0-9_]{1,512}$/, 'Nome só com letras minúsculas, números e _'),
      categoria: z.enum(['MARKETING', 'UTILITY']),
      idioma: z.string().default('pt_BR'),
      cabecalho: z.string().max(60).nullable().optional(),
      texto: z.string().min(1).max(1024),
      exemplos: z.array(z.string().min(1).max(200)).default([]),
      rodape: z.string().max(60).nullable().optional(),
      botoes: z.array(z.string().min(1).max(25)).max(3).default([]),
    }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Dados inválidos' });
    const m = parsed.data;
    // Variáveis {{1}}, {{2}}... em ordem, sem pular, e com um exemplo pra cada (a Meta exige).
    const nums = [...m.texto.matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map(x => Number(x[1]));
    const distintos = [...new Set(nums)].sort((a, b) => a - b);
    if (distintos.some((n, i) => n !== i + 1)) return res.status(400).json({ error: 'Use as variáveis em sequência: {{1}}, {{2}}, {{3}}...' });
    if (/\{\{[^}]*\}\}/.test(m.texto.replace(/\{\{\s*\d+\s*\}\}/g, ''))) return res.status(400).json({ error: 'Variável inválida: use só números, como {{1}}' });
    if (m.exemplos.length !== distintos.length) return res.status(400).json({ error: 'Preencha um exemplo pra cada variável' });
    if (/^\s*\{\{\s*\d+\s*\}\}|\{\{\s*\d+\s*\}\}\s*$/.test(m.texto)) return res.status(400).json({ error: 'A Meta não aceita o texto começando ou terminando com uma variável' });
    const sessao = await sessaoDaImob(req.auth!.imobiliariaId, req.params.sessaoId);
    if (!sessao?.oficialAtiva) return res.status(404).json({ error: 'Número sem API oficial' });
    try {
      const r = await criarModelo(sessao, { ...m, cabecalho: m.cabecalho || null, rodape: m.rodape || null });
      res.status(201).json(r);
    } catch (e) { res.status(502).json({ error: 'A Meta recusou: ' + (e as Error).message }); }
  });

  router.delete('/:sessaoId/modelos/:nome', async (req, res) => {
    const sessao = await sessaoDaImob(req.auth!.imobiliariaId, req.params.sessaoId);
    if (!sessao?.oficialAtiva) return res.status(404).json({ error: 'Número sem API oficial' });
    try {
      await apagarModelo(sessao, req.params.nome);
      if (sessao.oficialTemplate === req.params.nome) {
        await db.update(sessoesWhatsapp).set({ oficialTemplate: null, oficialTemplateIdioma: null }).where(eq(sessoesWhatsapp.id, sessao.id));
      }
      res.json({ ok: true });
    } catch (e) { res.status(502).json({ error: 'A Meta recusou: ' + (e as Error).message }); }
  });

  return router;
}

/** Liga a API oficial num número central da imobiliária: confere o número na Meta, assina o app na
 *  WABA, registra no hub e grava (token cifrado). Usado pelo Cadastro Incorporado e pelo admin. */
async function ligarOficial(io: SocketServer, imobiliariaId: string, o: { token: string; wabaId: string; phoneNumberId?: string; sessaoId?: string; sincronizar: boolean }):
  Promise<{ status: number; body: unknown }> {
  const resp = (status: number, body: unknown) => ({ status, body });
  const { token, wabaId } = o;
  // Na Coexistência a Meta pode devolver só a WABA: o número vem da lista dela.
  let phoneNumberId = o.phoneNumberId;
  let display = '';
  try {
    if (!phoneNumberId) {
      const nums = await numerosDaWaba(wabaId, token);
      if (nums.length !== 1) return resp(400, { error: nums.length ? 'A conta tem mais de um número — conecte de novo escolhendo só um.' : 'Nenhum número nessa conta do WhatsApp.' });
      phoneNumberId = nums[0].id;
      display = nums[0].display_phone_number || '';
    } else {
      display = (await infoNumero(phoneNumberId, token)).display_phone_number || '';
    }
    await assinarApp(wabaId, token);
  } catch (e) {
    return resp(502, { error: 'Não deu pra ativar o número na Meta: ' + (e as Error).message });
  }
  const numero = soDigitos(display);

  // Um número oficial só pode estar numa imobiliária.
  const [outro] = await db.select({ id: sessoesWhatsapp.id, imob: sessoesWhatsapp.imobiliariaId }).from(sessoesWhatsapp)
    .where(eq(sessoesWhatsapp.oficialPhoneNumberId, phoneNumberId)).limit(1);
  if (outro && outro.imob !== imobiliariaId) return resp(409, { error: 'Esse número já está conectado em outra imobiliária.' });
  const noHub = await hubRegistrarNumero(phoneNumberId, wabaId, display, imobiliariaId);
  if (noHub === 'outro') return resp(409, { error: 'Esse número já está conectado em outro sistema da InoovaWeb.' });
  if (noHub === 'erro') return resp(502, { error: 'Não deu pra registrar o número no hub. Tente de novo.' });

  // Liga ao número central certo: o escolhido na tela, o que já tem a oficial, o WAHA do MESMO
  // número (híbrido) ou, se não existir, cria um número central só com a oficial.
  const centrais = await db.select().from(sessoesWhatsapp)
    .where(and(eq(sessoesWhatsapp.imobiliariaId, imobiliariaId), eq(sessoesWhatsapp.escopo, 'central'))).orderBy(asc(sessoesWhatsapp.criadoEm));
  const mesmo = (n: string | null) => !!n && !!numero && n.slice(-8) === numero.slice(-8);
  let alvo = centrais.find(s => s.id === o.sessaoId)
    ?? centrais.find(s => s.oficialPhoneNumberId === phoneNumberId)
    ?? centrais.find(s => mesmo(s.numero));
  const dados = {
    oficialPhoneNumberId: phoneNumberId, oficialWabaId: wabaId, oficialNumero: numero || null,
    ...cifrarToken(token), oficialAtiva: true, oficialErro: null,
  };
  if (alvo) {
    [alvo] = await db.update(sessoesWhatsapp).set(dados).where(eq(sessoesWhatsapp.id, alvo.id)).returning();
  } else {
    const sessionName = centrais.length === 0 ? 'imob-' + imobiliariaId : 'imob-' + imobiliariaId + '-' + Date.now().toString(36);
    [alvo] = await db.insert(sessoesWhatsapp).values({
      imobiliariaId, escopo: 'central', sessionName, status: 'desconectada', numero: numero || null, rotulo: 'API oficial', ...dados,
    }).returning();
  }

  // Exigência da Coexistência: pedir a sincronização logo depois de conectar (só vale uma vez,
  // nas 24h depois do cadastro — quem reaproveita uma conexão antiga não pede de novo).
  const errosSync = o.sincronizar ? await sincronizarCoexistencia(phoneNumberId, token) : [];
  if (errosSync.length) console.warn('oficial: sincronização da Coexistência —', errosSync.join(' | '));

  io.to('imobiliaria:' + imobiliariaId).emit('sessao:mudou', { sessionName: alvo.sessionName, status: alvo.status });
  return resp(201, { ...publica(alvo), avisoSync: errosSync.length ? 'A Meta não aceitou a sincronização: ' + errosSync.join('; ') : null });
}

async function sessaoDaImob(imobiliariaId: string, id: string) {
  const [s] = await db.select().from(sessoesWhatsapp).where(and(eq(sessoesWhatsapp.id, id), eq(sessoesWhatsapp.imobiliariaId, imobiliariaId))).limit(1);
  return s ?? null;
}

/** Número com oficial ativa por onde o lead fala (o dele; senão o 1º central com oficial). */
async function sessaoDoLead(imobiliariaId: string, sessaoWhatsappId: string | null) {
  const com = await db.select().from(sessoesWhatsapp)
    .where(and(eq(sessoesWhatsapp.imobiliariaId, imobiliariaId), eq(sessoesWhatsapp.escopo, 'central'), eq(sessoesWhatsapp.oficialAtiva, true)))
    .orderBy(asc(sessoesWhatsapp.criadoEm));
  if (sessaoWhatsappId) {
    const doLead = com.find(s => s.id === sessaoWhatsappId);
    if (doLead) return doLead;
    // o lead fala por um número que não tem oficial: não muda de número no meio da conversa
    const [existe] = await db.select({ id: sessoesWhatsapp.id }).from(sessoesWhatsapp).where(eq(sessoesWhatsapp.id, sessaoWhatsappId)).limit(1);
    if (existe) return null;
  }
  return com[0] ?? null;
}

/** Processa um aviso do WhatsApp oficial (já com assinatura conferida). Exportado pros testes. */
export async function processarWebhook(io: SocketServer, body: any) {
  if (body?.object !== 'whatsapp_business_account') return;
  for (const entry of body.entry || []) {
    for (const ch of entry.changes || []) {
      const v = ch.value || {};
      const field: string = ch.field;

      // Desconectado pelo celular (Configurações > Conta > Plataforma comercial) ou pela Meta.
      if (field === 'account_update' && /PARTNER_REMOVED|ACCOUNT_DELETED|DISABLED/i.test(String(v.event || ''))) {
        const rows = await db.update(sessoesWhatsapp)
          .set({ oficialAtiva: false, oficialErro: 'Desconectado da API oficial (' + v.event + ')' })
          .where(eq(sessoesWhatsapp.oficialWabaId, String(entry.id))).returning();
        for (const r of rows) io.to('imobiliaria:' + r.imobiliariaId).emit('sessao:mudou', { sessionName: r.sessionName, status: r.status });
        continue;
      }
      // Modelo aprovado/rejeitado/pausado: a tela de modelos recarrega.
      if (field === 'message_template_status_update' || field === 'message_template_quality_update') {
        const rows = await db.select({ imob: sessoesWhatsapp.imobiliariaId }).from(sessoesWhatsapp).where(eq(sessoesWhatsapp.oficialWabaId, String(entry.id)));
        for (const r of rows) io.to('imobiliaria:' + r.imob).emit('oficial:modelos', { nome: v.message_template_name, status: v.event });
        continue;
      }
      if (field !== 'messages' && field !== 'smb_message_echoes') continue; // history / smb_app_state_sync: não importamos

      const phoneId = String(v.metadata?.phone_number_id || '');
      if (!phoneId) continue;
      const [sessao] = await db.select().from(sessoesWhatsapp).where(eq(sessoesWhatsapp.oficialPhoneNumberId, phoneId)).limit(1);
      if (!sessao || !sessao.oficialAtiva) continue;

      // Status das mensagens que saíram pela oficial → "visto" no CRM.
      for (const st of v.statuses || []) {
        const ack = ACK[st.status];
        if (st.status === 'failed') console.warn('oficial: mensagem não entregue —', JSON.stringify(st.errors || []).slice(0, 300));
        if (!ack || !st.id) continue;
        const [row] = await db.update(mensagensWhatsapp).set({ ackStatus: ack })
          .where(eq(mensagensWhatsapp.waMessageId, st.id)).returning({ id: mensagensWhatsapp.id });
        if (row) io.to('imobiliaria:' + sessao.imobiliariaId).emit('mensagem:ack', { id: row.id, ackStatus: ack });
      }

      const nomes = new Map<string, string>((v.contacts || []).map((c: any) => [String(c.wa_id), String(c.profile?.name || '')]));
      const lista: { msg: any; fromMe: boolean }[] = field === 'messages'
        ? (v.messages || []).map((msg: any) => ({ msg, fromMe: false }))
        : (v.message_echoes || []).map((msg: any) => ({ msg, fromMe: true }));

      for (const { msg, fromMe } of lista) {
        if (['reaction', 'system', 'unsupported', 'ephemeral', 'request_welcome'].includes(msg.type)) continue;
        // Retentativa atrasada da Meta (ex.: CRM fora do ar por horas) não acorda IA/roleta com conversa velha.
        const ts = Number(msg.timestamp) || 0;
        if (ts && Date.now() / 1000 - ts > 6 * 3600) continue;
        const contato = String(fromMe ? msg.to : msg.from || '');
        const numero = soDigitos(contato);
        if (!numero || numero.length > 15) continue;
        if (!fromMe) lembrarWaId(numero);
        const anexo = anexoDe(msg);
        await processarMensagem(io, sessao, {
          fromMe,
          numero,
          texto: anexo.tipo ? anexo.legenda : textoDe(msg),
          waId: msg.id ?? null,
          pushName: fromMe ? '' : (nomes.get(contato) || '').trim(),
          anexoTipo: anexo.tipo,
          anexoNome: anexo.nome,
          baixarMidia: () => (anexo.mediaId ? baixarMidiaOficial(sessao, anexo.mediaId) : Promise.resolve(null)),
        });
      }
    }
  }
}
