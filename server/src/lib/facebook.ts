import { createHmac, timingSafeEqual } from 'node:crypto';
import jwt from 'jsonwebtoken';

/** Conexão "Conectar com Facebook" (app Meta Conecta Leads, aprovado no App Review).
 *  A imobiliária faz login, o CRM guarda o token de cada Página e assina o webhook `leadgen`:
 *  todo lead de qualquer formulário da Página chega em tempo real em /api/webhooks/facebook. */

// FB_GRAPH_URL só existe pra teste local (servidor falso no lugar do Facebook).
export const GRAPH = (process.env.FB_GRAPH_URL || 'https://graph.facebook.com').replace(/\/$/, '') + '/v21.0';
const SCOPES = ['pages_show_list', 'pages_read_engagement', 'pages_manage_metadata', 'leads_retrieval', 'business_management'];

export function fbConfigurado() {
  return !!(process.env.FB_APP_ID && process.env.FB_APP_SECRET);
}

function publicUrl() {
  return (process.env.PUBLIC_URL || 'https://hinode.inoovaweb.com.br').replace(/\/$/, '');
}

export function frontendUrl() {
  return (process.env.FRONTEND_URL || process.env.CORS_ORIGIN || 'http://localhost:5173').replace(/\/$/, '');
}

function redirectUri() {
  return publicUrl() + '/api/integracoes/facebook/oauth/callback';
}

// --- state do OAuth: assinado, curto, amarra o retorno à imobiliária de quem clicou ---
interface EstadoOAuth { imobiliariaId: string; sub: string; scope: 'fb-oauth' }

export function urlLoginFacebook(imobiliariaId: string, perfilId: string) {
  const state = jwt.sign({ imobiliariaId, sub: perfilId, scope: 'fb-oauth' } satisfies EstadoOAuth, process.env.JWT_SECRET!, { expiresIn: '15m' });
  const q = new URLSearchParams({
    client_id: process.env.FB_APP_ID!,
    redirect_uri: redirectUri(),
    state,
    scope: SCOPES.join(','),
    response_type: 'code',
    auth_type: 'rerequest',
  });
  return 'https://www.facebook.com/v21.0/dialog/oauth?' + q.toString();
}

export function lerEstado(state: string): EstadoOAuth | null {
  try {
    const e = jwt.verify(state, process.env.JWT_SECRET!) as EstadoOAuth;
    return e.scope === 'fb-oauth' && e.imobiliariaId ? e : null;
  } catch { return null; }
}

async function graph<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init);
  const body = await r.json().catch(() => ({})) as T & { error?: { message?: string } };
  if (!r.ok || body.error) throw new Error(body.error?.message || 'Facebook respondeu ' + r.status);
  return body;
}

/** code → token de usuário de longa duração (≈60 dias). Os tokens de Página tirados dele não expiram. */
export async function trocarCodigo(code: string) {
  const base = { client_id: process.env.FB_APP_ID!, client_secret: process.env.FB_APP_SECRET! };
  const curto = await graph<{ access_token: string }>(GRAPH + '/oauth/access_token?' + new URLSearchParams({ ...base, redirect_uri: redirectUri(), code }));
  const longo = await graph<{ access_token: string }>(GRAPH + '/oauth/access_token?' + new URLSearchParams({ ...base, grant_type: 'fb_exchange_token', fb_exchange_token: curto.access_token }));
  return longo.access_token;
}

export interface PaginaFb { id: string; name: string; access_token: string; business?: { id: string; name: string } }

/** Todas as Páginas que o login autorizou (com paginação — agência pode ter centenas, de várias BMs),
 *  com o nome da BM dona de cada uma quando o Facebook informa (ajuda a agência a não marcar a errada). */
export async function paginasDoUsuario(userToken: string): Promise<PaginaFb[]> {
  const buscar = async (fields: string) => {
    const todas: PaginaFb[] = [];
    let url: string | undefined = GRAPH + '/me/accounts?' + new URLSearchParams({ fields, limit: '100', access_token: userToken });
    for (let i = 0; url && i < 20; i++) {
      const r: { data?: PaginaFb[]; paging?: { next?: string } } = await graph(url);
      todas.push(...(r.data || []));
      url = r.paging?.next;
    }
    return todas;
  };
  // "business" pode ser recusado em alguma conta: aí lista sem o nome da BM, mas lista.
  const lista = await buscar('id,name,access_token,business{id,name}').catch(() => buscar('id,name,access_token'));
  return lista.filter(p => p.access_token);
}

/** Faz a Página avisar o nosso app a cada lead novo (campo `leadgen` do webhook). */
export async function assinarLeadgen(pageId: string, pageToken: string) {
  await graph(GRAPH + '/' + encodeURIComponent(pageId) + '/subscribed_apps?' + new URLSearchParams({ subscribed_fields: 'leadgen', access_token: pageToken }), { method: 'POST' });
}

export interface LeadFb {
  id: string; created_time?: string; ad_name?: string; campaign_name?: string; form_id?: string;
  field_data?: { name: string; values?: string[] }[];
}

export async function buscarLead(leadgenId: string, pageToken: string) {
  return graph<LeadFb>(GRAPH + '/' + encodeURIComponent(leadgenId) + '?' + new URLSearchParams({
    fields: 'id,created_time,field_data,ad_name,campaign_name,form_id', access_token: pageToken,
  }));
}

/** Cada imobiliária monta o próprio formulário: nome/telefone/e-mail têm nomes padrão da Meta,
 *  o resto vira "respostas extras" (vai pro histórico do lead). */
export function mapearCampos(fieldData: LeadFb['field_data'] = []) {
  const v = (f: { values?: string[] }) => (f.values || []).join(', ').trim();
  const achar = (...nomes: string[]) => fieldData.find(f => nomes.includes(f.name.toLowerCase()));
  const nomeCompleto = achar('full_name', 'nome_completo', 'nome');
  const primeiro = achar('first_name'), ultimo = achar('last_name');
  const tel = achar('phone_number', 'phone', 'telefone', 'whatsapp');
  const email = achar('email', 'e-mail');
  const finalidade = fieldData.find(f => /interesse|finalidade|compr|alug|objetivo/i.test(f.name));
  const usados = new Set([nomeCompleto, primeiro, ultimo, tel, email].filter(Boolean));
  const extras = fieldData.filter(f => !usados.has(f) && v(f)).map(f => ({ pergunta: f.name.replace(/_/g, ' '), resposta: v(f) }));
  return {
    nome: (nomeCompleto ? v(nomeCompleto) : [primeiro, ultimo].filter(Boolean).map(f => v(f!)).join(' ')) || 'Lead do Facebook',
    telefone: tel ? v(tel) : '',
    email: email && /\S+@\S+\.\S+/.test(v(email)) ? v(email) : undefined,
    finalidade: finalidade ? v(finalidade) : undefined,
    extras,
  };
}

/** Confere a assinatura `x-hub-signature-256` que a Meta manda em todo webhook. */
export function assinaturaValida(rawBody: Buffer | undefined, header: string | undefined) {
  if (!rawBody || !header?.startsWith('sha256=')) return false;
  const esperado = createHmac('sha256', process.env.FB_APP_SECRET!).update(rawBody).digest('hex');
  const recebido = header.slice(7);
  return esperado.length === recebido.length && timingSafeEqual(Buffer.from(esperado), Buffer.from(recebido));
}

// --- Hub InoovaWeb (agencia.inoovaweb.com.br): o webhook do app Meta chega no hub, que entrega
// cada lead só pro sistema dono da Página. O CRM registra/libera as Páginas que conecta. ---
function hub() {
  const url = (process.env.HUB_LEADS_URL || '').replace(/\/$/, '');
  const key = process.env.HUB_LEADS_KEY || '';
  return url && key ? { url, key } : null;
}

/** 'ok' = Página é deste CRM no hub · 'outro' = já pertence a outro sistema · 'erro' = hub fora do ar. */
export async function hubRegistrarPagina(pageId: string, pageName: string, ref: string): Promise<'ok' | 'outro' | 'erro'> {
  const h = hub();
  if (!h) return 'ok'; // sem hub configurado, o CRM recebe o webhook direto
  try {
    const r = await fetch(h.url + '/api/leads/pages', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-key': h.key },
      body: JSON.stringify({ pageId, pageName, ref }),
    });
    if (r.status === 409) return 'outro';
    return r.ok ? 'ok' : 'erro';
  } catch { return 'erro'; }
}

export async function hubLiberarPagina(pageId: string) {
  const h = hub();
  if (!h) return;
  await fetch(h.url + '/api/leads/pages/' + encodeURIComponent(pageId), { method: 'DELETE', headers: { 'x-hub-key': h.key } })
    .catch(e => console.error('hub: liberar página falhou —', (e as Error).message));
}
