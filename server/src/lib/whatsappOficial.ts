import { createHmac, timingSafeEqual } from 'node:crypto';
import { and, desc, eq, gt } from 'drizzle-orm';
import { db } from '../db/client.js';
import { mensagensWhatsapp, sessoesWhatsapp } from '../db/schema.js';
import { cifrar, decifrar } from './crypto.js';
import { enviarMidia as enviarMidiaWaha, enviarTextoResolvido, presenca, resolverChatId, wahaConfigurado } from './waha.js';

/** WhatsApp API oficial (Cloud API) pelo app Meta "Conecta Zap InoovaWeb", com Coexistência:
 *  o número continua no WhatsApp Business do celular E numa sessão WAHA (híbrido).
 *
 *  - A imobiliária conecta pelo Cadastro Incorporado (Embedded Signup) na tela de Integrações;
 *    o CRM troca o `code` por um token (usuário do sistema, não expira) e assina o app na WABA.
 *  - O número é registrado no hub InoovaWeb (HUB_LEADS_URL + HUB_WA_KEY): o webhook do app é um
 *    só pra todos os CRMs, e o hub entrega cada número só pro sistema dono dele.
 *  - Envio: janela de 24h aberta → oficial; fechada → WAHA; WAHA fora → modelo aprovado (1º contato). */

// WA_GRAPH_URL só existe pra teste local (servidor falso no lugar da Meta).
const GRAPH = (process.env.WA_GRAPH_URL || process.env.FB_GRAPH_URL || 'https://graph.facebook.com').replace(/\/$/, '') + '/v21.0';

export function oficialConfigurado() {
  return !!(process.env.WA_APP_ID && process.env.WA_APP_SECRET && process.env.WA_CONFIG_ID);
}

/** O que o front precisa pra abrir o Cadastro Incorporado (nada secreto). */
export function configPublica() {
  return { configurado: oficialConfigurado(), appId: process.env.WA_APP_ID || null, configId: process.env.WA_CONFIG_ID || null };
}

/** Confere o x-hub-signature-256 (o hub repassa o corpo e a assinatura originais da Meta). */
export function assinaturaValida(raw: Buffer | undefined, header: string | undefined) {
  const secret = process.env.WA_APP_SECRET;
  if (!secret || !raw || !header?.startsWith('sha256=')) return false;
  const esperado = Buffer.from('sha256=' + createHmac('sha256', secret).update(raw).digest('hex'));
  const recebido = Buffer.from(header);
  return esperado.length === recebido.length && timingSafeEqual(esperado, recebido);
}

async function graph<T>(caminho: string, token: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const r = await fetch(GRAPH + caminho, {
    method: init?.method ?? 'GET',
    headers: { Authorization: 'Bearer ' + token, ...(init?.body ? { 'Content-Type': 'application/json' } : {}) },
    body: init?.body ? JSON.stringify(init.body) : undefined,
  });
  const body = await r.json().catch(() => ({})) as T & { error?: { message?: string; code?: number } };
  if (!r.ok || body.error) throw new Error(body.error?.message || 'Meta respondeu ' + r.status);
  return body;
}

// ---------------------------------------------------------------------------------------------
// Conexão
// ---------------------------------------------------------------------------------------------

/** code do Cadastro Incorporado → token de usuário do sistema da empresa (não expira). */
export async function trocarCodigo(code: string): Promise<string> {
  const q = new URLSearchParams({ client_id: process.env.WA_APP_ID!, client_secret: process.env.WA_APP_SECRET!, code });
  const r = await fetch(GRAPH + '/oauth/access_token?' + q.toString());
  const body = await r.json().catch(() => ({})) as { access_token?: string; error?: { message?: string } };
  if (!r.ok || !body.access_token) throw new Error(body.error?.message || 'Meta não devolveu o token');
  return body.access_token;
}

/** Assina o app na WABA — sem isso as mensagens do número não chegam no webhook. */
export async function assinarApp(wabaId: string, token: string) {
  await graph(`/${wabaId}/subscribed_apps`, token, { method: 'POST' });
}

export async function infoNumero(phoneNumberId: string, token: string) {
  return graph<{ display_phone_number?: string; verified_name?: string }>(`/${phoneNumberId}?fields=display_phone_number,verified_name`, token);
}

export function cifrarToken(token: string) {
  const c = cifrar(token);
  return { oficialTokenCifrado: c.cifrado, oficialTokenIv: c.iv, oficialTokenTag: c.tag };
}

type Sessao = typeof sessoesWhatsapp.$inferSelect;

/** O que a tela pode ver de um número (nunca o token da oficial). */
export function publica(s: Sessao) {
  const { oficialTokenCifrado: _c, oficialTokenIv: _i, oficialTokenTag: _t, ...resto } = s;
  return resto;
}

function tokenDa(sessao: Sessao): string {
  if (!sessao.oficialTokenCifrado || !sessao.oficialTokenIv || !sessao.oficialTokenTag) throw new Error('número sem token da API oficial');
  return decifrar({ cifrado: sessao.oficialTokenCifrado, iv: sessao.oficialTokenIv, tag: sessao.oficialTokenTag });
}

/** Números da WABA — no fim da Coexistência a Meta pode mandar só o waba_id. */
export async function numerosDaWaba(wabaId: string, token: string) {
  const r = await graph<{ data?: { id: string; display_phone_number?: string; verified_name?: string }[] }>(
    `/${wabaId}/phone_numbers?fields=id,display_phone_number,verified_name`, token);
  return r.data || [];
}

/** Coexistência: a Meta exige pedir a sincronização de contatos e do histórico em até 24h depois de
 *  conectar, senão desconecta o número. O CRM não importa esse conteúdo (chega nos webhooks
 *  smb_app_state_sync / history e é ignorado) — o importante é o pedido ser feito. */
export async function sincronizarCoexistencia(phoneNumberId: string, token: string) {
  const erros: string[] = [];
  for (const sync_type of ['smb_app_state_sync', 'history']) {
    await graph(`/${phoneNumberId}/smb_app_data`, token, { method: 'POST', body: { messaging_product: 'whatsapp', sync_type } })
      .catch(e => erros.push(sync_type + ': ' + (e as Error).message));
  }
  return erros;
}

export type Modelo = {
  id: string; nome: string; idioma: string; categoria: string; status: string; motivo: string | null;
  cabecalho: string | null; texto: string; rodape: string | null; botoes: string[]; variaveis: number;
};
type ModeloMeta = {
  id: string; name: string; language: string; status: string; category: string; rejected_reason?: string;
  components?: { type: string; format?: string; text?: string; buttons?: { text: string }[] }[];
};
const VARIAVEL = /\{\{\s*\w+\s*\}\}/g;

/** Todos os modelos da WABA (aprovados, em análise, rejeitados...). */
export async function listarModelos(sessao: Sessao): Promise<Modelo[]> {
  const r = await graph<{ data?: ModeloMeta[] }>(
    `/${sessao.oficialWabaId}/message_templates?fields=id,name,language,status,category,rejected_reason,components&limit=200`, tokenDa(sessao));
  return (r.data || []).map(t => {
    const comp = (tipo: string) => t.components?.find(c => c.type === tipo);
    const texto = comp('BODY')?.text || '';
    return {
      id: t.id, nome: t.name, idioma: t.language, categoria: t.category, status: t.status,
      motivo: t.rejected_reason && t.rejected_reason !== 'NONE' ? t.rejected_reason : null,
      cabecalho: comp('HEADER')?.format === 'TEXT' ? comp('HEADER')?.text || null : null,
      texto, rodape: comp('FOOTER')?.text || null,
      botoes: (comp('BUTTONS')?.buttons || []).map(b => b.text),
      variaveis: new Set(texto.match(VARIAVEL) || []).size,
    };
  });
}

export type NovoModelo = {
  nome: string; categoria: 'MARKETING' | 'UTILITY'; idioma: string;
  cabecalho?: string | null; texto: string; exemplos: string[]; rodape?: string | null; botoes?: string[];
};

/** Cria o modelo na WABA (vai pra análise da Meta; o resultado chega no webhook de status). */
export async function criarModelo(sessao: Sessao, m: NovoModelo) {
  const components: Record<string, unknown>[] = [];
  if (m.cabecalho) components.push({ type: 'HEADER', format: 'TEXT', text: m.cabecalho });
  components.push({ type: 'BODY', text: m.texto, ...(m.exemplos.length ? { example: { body_text: [m.exemplos] } } : {}) });
  if (m.rodape) components.push({ type: 'FOOTER', text: m.rodape });
  if (m.botoes?.length) components.push({ type: 'BUTTONS', buttons: m.botoes.map(text => ({ type: 'QUICK_REPLY', text })) });
  return graph<{ id: string; status: string; category: string }>(`/${sessao.oficialWabaId}/message_templates`, tokenDa(sessao), {
    method: 'POST',
    body: { name: m.nome, category: m.categoria, language: m.idioma, parameter_format: 'positional', components },
  });
}

export async function apagarModelo(sessao: Sessao, nome: string) {
  await graph(`/${sessao.oficialWabaId}/message_templates?name=${encodeURIComponent(nome)}`, tokenDa(sessao), { method: 'DELETE' });
}

// ---------------------------------------------------------------------------------------------
// Hub InoovaWeb: número → este CRM
// ---------------------------------------------------------------------------------------------

function hub() {
  const url = (process.env.HUB_LEADS_URL || '').replace(/\/$/, '');
  const key = process.env.HUB_WA_KEY || '';
  return url && key ? { url, key } : null;
}

export async function hubRegistrarNumero(phoneNumberId: string, wabaId: string, displayPhone: string, ref: string): Promise<'ok' | 'outro' | 'erro'> {
  const h = hub();
  if (!h) return 'ok'; // sem hub configurado, o webhook do app aponta direto pro CRM
  try {
    const r = await fetch(h.url + '/api/whatsapp/numbers', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-key': h.key },
      body: JSON.stringify({ phoneNumberId, wabaId, displayPhone, ref }),
    });
    if (r.status === 409) return 'outro';
    return r.ok ? 'ok' : 'erro';
  } catch { return 'erro'; }
}

export async function hubLiberarNumero(phoneNumberId: string) {
  const h = hub();
  if (!h) return;
  await fetch(h.url + '/api/whatsapp/numbers/' + encodeURIComponent(phoneNumberId), { method: 'DELETE', headers: { 'x-hub-key': h.key } })
    .catch(e => console.error('hub: liberar número falhou —', (e as Error).message));
}

// ---------------------------------------------------------------------------------------------
// Mensagens
// ---------------------------------------------------------------------------------------------

/** ID interno da mensagem no WhatsApp — o mesmo que o WAHA usa e que vai codificado no wamid
 *  da API oficial (base64). É ele que impede a mesma mensagem de entrar 2x no híbrido. */
export function chaveDaMensagem(id: string | null | undefined): string | null {
  if (!id) return null;
  let fonte = id;
  if (id.startsWith('wamid.')) {
    try { fonte = Buffer.from(id.slice(6), 'base64').toString('latin1'); } catch { return null; }
  }
  const achados = fonte.match(/[0-9A-F]{16,64}/gi);
  return achados ? achados[achados.length - 1].toUpperCase() : null;
}

// Mensagens já vistas por este processo (número:chave). A mesma mensagem chega pelo WAHA e pela
// oficial quase juntas — sem isso as duas criariam o lead ao mesmo tempo. O envio também reserva a
// chave, pro eco que volta não entrar como mensagem nova.
const reservadas = new Map<string, number>();
export function reservarChave(numero: string, chave: string): boolean {
  const k = numero.replace(/D/g, '').slice(-8) + ':' + chave;
  const agora = Date.now();
  for (const [x, t] of reservadas) if (agora - t > 300000) reservadas.delete(x);
  if (reservadas.has(k)) return false;
  reservadas.set(k, agora);
  return true;
}

/** wa_id (como o WhatsApp conhece o contato) de quem escreveu pro número oficial — pode vir sem o
 *  9º dígito. Guardado em memória: a janela de 24h só abre quando o cliente escreve, então quando a
 *  oficial é usada o wa_id quase sempre já passou por aqui. */
const waIdPorTelefone = new Map<string, string>();
const ultimos8 = (s: string) => s.replace(/\D/g, '').slice(-8);
export function lembrarWaId(waId: string) { waIdPorTelefone.set(ultimos8(waId), waId.replace(/\D/g, '')); }
function destinoOficial(telefone: string) {
  const d = telefone.replace(/\D/g, '');
  return waIdPorTelefone.get(ultimos8(d)) || (d.length <= 11 ? '55' + d : d);
}

const JANELA_MS = 24 * 3600 * 1000 - 10 * 60 * 1000; // 24h com 10 min de folga

/** O cliente escreveu nas últimas 24h? (vale mensagem que entrou pelo WAHA também — é o mesmo número) */
export async function janelaAberta(leadId: string): Promise<boolean> {
  const [m] = await db.select({ id: mensagensWhatsapp.id }).from(mensagensWhatsapp)
    .where(and(eq(mensagensWhatsapp.leadId, leadId), eq(mensagensWhatsapp.direcao, 'in'), gt(mensagensWhatsapp.enviadoEm, new Date(Date.now() - JANELA_MS))))
    .limit(1);
  return !!m;
}

export type TipoAnexo = 'imagem' | 'video' | 'documento' | 'audio';
export type Conteudo = { texto?: string | null; anexoUrl?: string | null; anexoTipo?: TipoAnexo | null; anexoNome?: string | null };

async function enviarOficial(sessao: Sessao, telefone: string, c: Conteudo): Promise<string | null> {
  const to = destinoOficial(telefone);
  let corpo: Record<string, unknown>;
  if (c.anexoUrl && c.anexoTipo) {
    const tipo = c.anexoTipo === 'imagem' ? 'image' : c.anexoTipo === 'video' ? 'video' : c.anexoTipo === 'audio' ? 'audio' : 'document';
    const midia: Record<string, string> = { link: c.anexoUrl };
    if (tipo !== 'audio' && c.texto) midia.caption = c.texto;
    if (tipo === 'document') midia.filename = c.anexoNome || c.anexoUrl.split('/').pop() || 'arquivo';
    corpo = { type: tipo, [tipo]: midia };
  } else {
    corpo = { type: 'text', text: { body: c.texto || '', preview_url: true } };
  }
  const r = await graph<{ messages?: { id: string }[]; contacts?: { wa_id: string }[] }>(`/${sessao.oficialPhoneNumberId}/messages`, tokenDa(sessao), {
    method: 'POST', body: { messaging_product: 'whatsapp', recipient_type: 'individual', to, ...corpo },
  });
  if (r.contacts?.[0]?.wa_id) lembrarWaId(r.contacts[0].wa_id);
  return r.messages?.[0]?.id ?? null;
}

export const primeiroNome = (nome: string) => (/^(Contato |WhatsApp )/.test(nome) ? '' : nome.split(' ')[0]);

/** Manda um modelo aprovado com os valores das variáveis ({{1}}, {{2}}... na ordem). Devolve o id e
 *  o texto como o cliente vai ler (pra gravar no histórico do CRM). */
export async function enviarModeloLivre(sessao: Sessao, telefone: string, nome: string, idioma: string | null, valores: string[]):
  Promise<{ id: string | null; texto: string }> {
  const m = (await listarModelos(sessao)).find(x => x.nome === nome && x.status === 'APPROVED' && (!idioma || x.idioma === idioma));
  if (!m) throw new Error('o modelo "' + nome + '" não está aprovado');
  const vals = Array.from({ length: m.variaveis }, (_, i) => (valores[i] || '').trim() || '-');
  const r = await graph<{ messages?: { id: string }[]; contacts?: { wa_id: string }[] }>(`/${sessao.oficialPhoneNumberId}/messages`, tokenDa(sessao), {
    method: 'POST',
    body: {
      messaging_product: 'whatsapp', recipient_type: 'individual', to: destinoOficial(telefone), type: 'template',
      template: {
        name: m.nome, language: { code: m.idioma },
        ...(vals.length ? { components: [{ type: 'body', parameters: vals.map(text => ({ type: 'text', text })) }] } : {}),
      },
    },
  });
  if (r.contacts?.[0]?.wa_id) lembrarWaId(r.contacts[0].wa_id);
  const corpo = m.texto.replace(/\{\{\s*(\d+)\s*\}\}/g, (_, n) => vals[Number(n) - 1] ?? '');
  const texto = [m.cabecalho ? '*' + m.cabecalho + '*' : '', corpo, m.rodape ? '_' + m.rodape + '_' : ''].filter(Boolean).join('\n\n');
  return { id: r.messages?.[0]?.id ?? null, texto };
}

/** Modelo da 1ª mensagem do número ({{1}} = primeiro nome do lead). */
export async function enviarModelo(sessao: Sessao, lead: { telefone: string; nome: string }): Promise<{ id: string | null; texto: string }> {
  if (!sessao.oficialTemplate) throw new Error('SEM_MODELO');
  return enviarModeloLivre(sessao, lead.telefone, sessao.oficialTemplate, sessao.oficialTemplateIdioma, [primeiroNome(lead.nome) || 'tudo bem']);
}

/** Visto azul + "digitando…" pela oficial (some sozinho em 25 s ou quando a resposta sai). */
export async function digitandoOficial(sessao: Sessao, wamidRecebido: string) {
  await graph(`/${sessao.oficialPhoneNumberId}/messages`, tokenDa(sessao), {
    method: 'POST', body: { messaging_product: 'whatsapp', status: 'read', message_id: wamidRecebido, typing_indicator: { type: 'text' } },
  }).catch(() => { /* enfeite: se falhar, a resposta sai do mesmo jeito */ });
}

/** Baixa a mídia recebida pela oficial (id → URL temporária → arquivo, os dois com o token). */
export async function baixarMidiaOficial(sessao: Sessao, mediaId: string): Promise<{ buffer: Buffer; mimetype: string; filename: string | null } | null> {
  try {
    const token = tokenDa(sessao);
    const info = await graph<{ url?: string; mime_type?: string }>(`/${mediaId}`, token);
    if (!info.url) return null;
    const r = await fetch(info.url, { headers: { Authorization: 'Bearer ' + token } });
    if (!r.ok) return null;
    return { buffer: Buffer.from(await r.arrayBuffer()), mimetype: (info.mime_type || 'application/octet-stream').split(';')[0].trim(), filename: null };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Envio unificado (híbrido)
// ---------------------------------------------------------------------------------------------

const wahaNoAr = (s: Sessao) => s.status === 'conectada' && wahaConfigurado();

export type Via = 'oficial' | 'waha' | 'modelo';

/** Manda pro lead pela via certa do número: janela aberta → oficial; senão WAHA. Oficial falhou →
 *  tenta o WAHA. Erros: NUMERO_INEXISTENTE (WAHA) | FORA_DA_JANELA (só oficial e janela fechada) |
 *  SESSAO_DESCONECTADA. `chatIdWaha` = endereço já resolvido no WAHA (pode ser @lid). */
export async function enviarAoLead(sessao: Sessao, lead: { id: string; telefone: string }, c: Conteudo, opts: { chatIdWaha?: string } = {}):
  Promise<{ id: string | null; chave: string | null; via: Via }> {
  if (sessao.oficialAtiva && await janelaAberta(lead.id)) {
    try {
      const id = await enviarOficial(sessao, lead.telefone, c);
      if (sessao.oficialErro) await db.update(sessoesWhatsapp).set({ oficialErro: null }).where(eq(sessoesWhatsapp.id, sessao.id));
      const chave = chaveDaMensagem(id);
      if (chave) reservarChave(lead.telefone, chave);
      return { id, chave, via: 'oficial' };
    } catch (e) {
      const msg = (e as Error).message;
      console.error('oficial: envio falhou, tentando o WAHA —', msg);
      await db.update(sessoesWhatsapp).set({ oficialErro: msg.slice(0, 300) }).where(eq(sessoesWhatsapp.id, sessao.id)).catch(() => {});
      if (!wahaNoAr(sessao)) throw e;
    }
  }
  if (wahaNoAr(sessao)) {
    let alvo = opts.chatIdWaha;
    if (!alvo) {
      const r = await resolverChatId(sessao.sessionName, lead.telefone);
      if (r.existe === false) throw new Error('NUMERO_INEXISTENTE');
      alvo = r.chatId;
    }
    let id: string | null = null;
    if (c.anexoUrl && c.anexoTipo) id = idWaha(await enviarMidiaWaha(sessao.sessionName, alvo, c.anexoUrl, c.anexoTipo, c.texto ?? undefined, c.anexoNome ?? undefined));
    else id = (await enviarTextoResolvido(sessao.sessionName, lead.telefone, c.texto || '', alvo)).id;
    const chave = chaveDaMensagem(id);
    if (chave) reservarChave(lead.telefone, chave);
    return { id, chave, via: 'waha' };
  }
  throw new Error(sessao.oficialAtiva ? 'FORA_DA_JANELA' : 'SESSAO_DESCONECTADA');
}

function idWaha(r: unknown): string | null {
  const x = r as { id?: string | { _serialized?: string }; key?: { id?: string } } | null;
  return typeof x?.id === 'string' ? x.id : x?.id?._serialized || x?.key?.id || null;
}

/** Só dá pra falar com esse lead por modelo? (oficial ativa, WAHA fora, janela fechada) */
export async function soPorModelo(sessao: Sessao, leadId: string) {
  return sessao.oficialAtiva && !wahaNoAr(sessao) && !(await janelaAberta(leadId));
}

/** Presença (visto/digitando) pela via disponível: WAHA se estiver no ar; senão a oficial, que
 *  precisa do wamid da última mensagem recebida. 'parar'/'offline' só existem no WAHA. */
export async function presencaNoNumero(sessao: Sessao, leadId: string, chatIdWaha: string | null, acao: 'visto' | 'digitando' | 'parar' | 'offline') {
  if (wahaNoAr(sessao) && chatIdWaha) return presenca(sessao.sessionName, chatIdWaha, acao);
  if (!sessao.oficialAtiva || acao === 'parar' || acao === 'offline') return;
  const [m] = await db.select({ id: mensagensWhatsapp.waMessageId }).from(mensagensWhatsapp)
    .where(and(eq(mensagensWhatsapp.leadId, leadId), eq(mensagensWhatsapp.direcao, 'in')))
    .orderBy(desc(mensagensWhatsapp.enviadoEm)).limit(1);
  if (m?.id?.startsWith('wamid.')) await digitandoOficial(sessao, m.id);
}
