import { Router } from 'express';
import { and, eq, like } from 'drizzle-orm';
import type { Server as SocketServer } from 'socket.io';
import { db } from '../db/client.js';
import { eventosLead, integracoesFacebook, leads } from '../db/schema.js';
import { decifrar } from '../lib/crypto.js';
import { registrarEvento } from '../lib/eventos.js';
import { assinaturaValida, buscarLead, fbConfigurado, mapearCampos } from '../lib/facebook.js';
import { criarLead, normalizarFinalidade } from './captacao.js';

interface AvisoLeadgen { leadgen_id?: string; page_id?: string; form_id?: string; ad_id?: string }
interface CorpoWebhook { object?: string; entry?: { id: string; changes?: { field: string; value: AvisoLeadgen }[] }[] }

/** Webhook de leads do app Meta (Conecta Leads). Chega pelo hub InoovaWeb (agencia.inoovaweb.com.br),
 *  que entrega só os avisos das Páginas deste CRM, com o corpo e a assinatura originais da Meta.
 *  Aqui o lead vai pra imobiliária dona da Página (`page_id`); Página desconhecida é ignorada. */
export function facebookWebhookRouter(io: SocketServer) {
  const router = Router();

  // Verificação da Meta ao cadastrar a URL do webhook no painel do app.
  router.get('/', (req, res) => {
    if (req.query['hub.mode'] === 'subscribe' && process.env.FB_VERIFY_TOKEN && req.query['hub.verify_token'] === process.env.FB_VERIFY_TOKEN) {
      return res.type('text/plain').send(String(req.query['hub.challenge'] ?? ''));
    }
    res.sendStatus(403);
  });

  router.post('/', (req, res) => {
    if (!fbConfigurado()) return res.sendStatus(503);
    const raw = (req as unknown as { rawBody?: Buffer }).rawBody;
    if (!assinaturaValida(raw, req.header('x-hub-signature-256'))) return res.sendStatus(401);
    // Responde na hora (a Meta reenvia se demorar) e processa em seguida.
    res.sendStatus(200);
    processar(io, req.body as CorpoWebhook).catch(e => console.error('webhook facebook:', (e as Error).message));
  });

  return router;
}

async function processar(io: SocketServer, corpo: CorpoWebhook) {
  if (corpo.object !== 'page') return;
  for (const entry of corpo.entry || []) {
    for (const ch of entry.changes || []) {
      if (ch.field !== 'leadgen' || !ch.value?.leadgen_id) continue;
      const pageId = ch.value.page_id || entry.id;
      const [conexao] = await db.select().from(integracoesFacebook).where(and(
        eq(integracoesFacebook.pageId, pageId), eq(integracoesFacebook.origem, 'oauth'), eq(integracoesFacebook.ativo, true),
      )).limit(1);
      if (!conexao) continue;
      await receberLead(io, conexao, ch.value.leadgen_id).catch(async e => {
        const msg = (e as Error).message || 'Falha ao buscar o lead no Facebook';
        await db.update(integracoesFacebook).set({ ultimoErro: msg }).where(eq(integracoesFacebook.id, conexao.id));
        console.error('webhook facebook: lead', ch.value.leadgen_id, '—', msg);
      });
    }
  }
}

async function receberLead(io: SocketServer, conexao: typeof integracoesFacebook.$inferSelect, leadgenId: string) {
  const imobId = conexao.imobiliariaId;
  // Mesmo aviso de novo? Pode ter virado lead novo (fb_lead_id) ou "cadastrou de novo" num card que
  // já existia (marca [fb:<id>] no histórico).
  const [jaExiste] = await db.select({ id: leads.id }).from(leads)
    .where(and(eq(leads.imobiliariaId, imobId), eq(leads.fbLeadId, leadgenId))).limit(1);
  if (jaExiste) return;
  const [jaRecadastrado] = await db.select({ id: eventosLead.id }).from(eventosLead).where(and(
    eq(eventosLead.imobiliariaId, imobId), eq(eventosLead.tipo, 'recadastro'), like(eventosLead.descricao, '%[fb:' + leadgenId + ']%'),
  )).limit(1);
  if (jaRecadastrado) return;

  const token = decifrar({ cifrado: conexao.tokenCifrado, iv: conexao.tokenIv, tag: conexao.tokenTag });
  const lead = await buscarLead(leadgenId, token);
  // Conexão restrita a um formulário específico? Ignora os outros.
  if (conexao.formId && lead.form_id && lead.form_id !== conexao.formId) return;

  const c = mapearCampos(lead.field_data);
  let row;
  try {
    row = await criarLead(io, imobId, {
      nome: c.nome,
      telefone: c.telefone,
      email: c.email,
      campanha: lead.campaign_name || lead.ad_name || 'Formulário Facebook',
      canal: 'Facebook',
      finalidade: normalizarFinalidade(c.finalidade),
      fbLeadId: leadgenId,
    });
  } catch (e) {
    // Mesmo aviso chegando duas vezes ao mesmo tempo: o índice único segura, não é erro.
    if (/leads_imobiliaria_fb_lead_id_uq|duplicate key/i.test((e as Error).message)) return;
    throw e;
  }
  if (c.extras.length) {
    registrarEvento(imobId, row.id, 'formulario', 'Respostas do formulário: ' + c.extras.map(x => x.pergunta + ': ' + x.resposta).join(' · '));
  }
  await db.update(integracoesFacebook).set({ ultimaSyncEm: new Date(), ultimoErro: null }).where(eq(integracoesFacebook.id, conexao.id));
}
