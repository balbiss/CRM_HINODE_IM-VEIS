/** Cliente do WAHA (WhatsApp HTTP API). Fica dormente até WAHA_URL + WAHA_API_KEY
 *  estarem no .env — aí a tela de Integrações passa a conectar números de verdade. */
const base = () => (process.env.WAHA_URL || '').replace(/\/$/, '');
const key = () => process.env.WAHA_API_KEY || '';
/** URL pública do NOSSO backend, pro WAHA chamar o webhook de mensagens recebidas. */
const publicUrl = () => (process.env.PUBLIC_URL || '').replace(/\/$/, '');
export const webhookSecret = () => process.env.WAHA_WEBHOOK_SECRET || process.env.CAPTACAO_SECRET || 'sem-segredo';

export const wahaConfigurado = () => !!(base() && key());

type WahaOpts = { method?: string; body?: unknown };
async function waha<T = unknown>(path: string, opts: WahaOpts = {}): Promise<T> {
  if (!wahaConfigurado()) throw new Error('WhatsApp não oficial indisponível (WAHA_URL / WAHA_API_KEY não definidos)');
  const r = await fetch(base() + path, {
    method: opts.method ?? 'GET',
    headers: { 'X-Api-Key': key(), 'Content-Type': 'application/json' },
    body: opts.body != null ? JSON.stringify(opts.body) : undefined,
  });
  const txt = await r.text();
  let json: unknown = null;
  try { json = txt ? JSON.parse(txt) : null; } catch { /* resposta não-json */ }
  if (!r.ok) throw new Error(`não oficial ${path} -> ${r.status} ${txt.slice(0, 200)}`);
  return json as T;
}

// message.any cobre recebidas E enviadas (uma vez cada — registrar 'message' junto
// duplica). message.ack traz o "visto" (entregue/lido). session.status mantém o status.
const EVENTOS = ['message.any', 'message.ack', 'session.status'];

function webhookConfig() {
  const url = publicUrl() ? `${publicUrl()}/api/whatsapp/webhook?secret=${encodeURIComponent(webhookSecret())}` : undefined;
  return url ? { webhooks: [{ url, events: EVENTOS }] } : {};
}

// Engine do WhatsApp. GOWS (Go/whatsmeow, sem browser) é o recomendado — o WEBJS
// (Chromium) quebra quando a versão do WhatsApp Web muda e para de receber mensagens.
// Ignorado se a instância do WAHA não permitir engine por sessão (aí vale o default dela).
const ENGINE = process.env.WAHA_ENGINE || 'GOWS';

/** Cria (ou recria) a sessão no WAHA já com o webhook apontando pro nosso backend.
 *  Se a sessão já existe, ATUALIZA a config do webhook (corrige webhook quebrado) e reinicia. */
export async function criarSessao(sessionName: string) {
  const config = webhookConfig();
  await waha('/api/sessions', {
    method: 'POST',
    body: { name: sessionName, start: true, config, engine: ENGINE },
  }).catch(async e => {
    if (String(e).includes('422') || String(e).includes('already') || String(e).includes('exist')) {
      // já existe -> reescreve a config do webhook e reinicia pra aplicar
      await waha(`/api/sessions/${sessionName}`, { method: 'PUT', body: { config } }).catch(() => {});
      await waha(`/api/sessions/${sessionName}/restart`, { method: 'POST' })
        .catch(() => waha(`/api/sessions/${sessionName}/start`, { method: 'POST' }).catch(() => {}));
    } else { throw e; }
  });
}

export async function pararSessao(sessionName: string) {
  await waha(`/api/sessions/${sessionName}/stop`, { method: 'POST' }).catch(() => {});
  await waha(`/api/sessions/${sessionName}`, { method: 'DELETE' }).catch(() => {});
}

type WahaSession = { name: string; status: string; me?: { id?: string; pushName?: string } };
/** Devolve o status normalizado + o número, se conectado. */
export async function statusSessao(sessionName: string): Promise<{ status: 'desconectada' | 'conectando' | 'conectada'; numero: string | null }> {
  try {
    const s = await waha<WahaSession>(`/api/sessions/${sessionName}`);
    const st = (s.status || '').toUpperCase();
    if (st === 'WORKING') return { status: 'conectada', numero: (s.me?.id || '').replace(/@c\.us$/, '').replace(/[^0-9]/g, '') || null };
    if (st === 'SCAN_QR_CODE' || st === 'STARTING') return { status: 'conectando', numero: null };
    return { status: 'desconectada', numero: null };
  } catch {
    return { status: 'desconectada', numero: null };
  }
}

/** QR code em data-URL (base64 png) pra exibir na tela. */
export async function qrSessao(sessionName: string): Promise<string | null> {
  // format=image → { mimetype, data } com o PNG em base64 (raw devolve só a string do QR, não renderiza).
  try {
    const r = await waha<{ mimetype?: string; data?: string }>(`/api/${sessionName}/auth/qr?format=image`);
    if (r?.data) return r.data.startsWith('data:') ? r.data : `data:${r.mimetype || 'image/png'};base64,${r.data}`;
  } catch { /* tenta o binário abaixo */ }
  // Fallback: endpoint devolve o PNG binário direto.
  try {
    const res = await fetch(base() + `/api/${sessionName}/auth/qr`, { headers: { 'X-Api-Key': key(), Accept: 'image/png' } });
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') || 'image/png';
    if (ct.includes('json')) {
      const jj = await res.json() as { mimetype?: string; data?: string };
      return jj.data ? `data:${jj.mimetype || 'image/png'};base64,${jj.data}` : null;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    return `data:${ct};base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}

// Aceita telefone ("559198...") ou um chatId já resolvido ("...@lid" / "...@c.us"), que passa direto.
const chatId = (numero: string) => (numero.includes('@') ? numero : numero.replace(/[^0-9]/g, '') + '@c.us');

/** URL da foto de perfil do contato no WhatsApp (null se não tiver / for privada). */
export async function fotoPerfil(sessionName: string, numero: string): Promise<string | null> {
  try {
    const r = await waha<{ profilePictureURL?: string; url?: string }>(
      `/api/contacts/profile-picture?contactId=${encodeURIComponent(chatId(numero))}&session=${encodeURIComponent(sessionName)}`,
    );
    return r?.profilePictureURL || r?.url || null;
  } catch {
    return null;
  }
}

export async function enviarTexto(sessionName: string, numero: string, texto: string) {
  return waha('/api/sendText', { method: 'POST', body: { session: sessionName, chatId: chatId(numero), text: texto } });
}

/** Contorno NÃO-oficial pra um bug conhecido do WAHA no engine GOWS (issue aberta
 *  devlikeapro/waha#2214, sem correção confirmada até a versão 2026.9.1): às vezes o
 *  `/api/sendText` falha com "no LID found for ...@s.whatsapp.net" porque o servidor do
 *  WhatsApp não resolveu a identidade LID do contato a tempo. Forçar essa consulta antes de
 *  mandar a mensagem foi reportado por outro usuário como um jeito de "esquentar" a resolução.
 *  Best-effort: se falhar, ignora e deixa o envio normal tentar mesmo assim. */
export async function resolverLid(sessionName: string, numero: string): Promise<void> {
  try {
    const fone = numero.replace(/[^0-9]/g, '');
    await waha(`/api/${sessionName}/lids/pn/${fone}`);
  } catch {
    // contorno experimental — se o endpoint não existir ou falhar, segue sem travar nada
  }
}

/** Confere se o número existe no WhatsApp antes de mandar a 1ª mensagem da régua.
 *  true = existe, false = não existe, null = não deu pra checar (WAHA fora / sessão off). */
export async function checarNumero(sessionName: string, numero: string): Promise<boolean | null> {
  try {
    const fone = numero.replace(/[^0-9]/g, '');
    const r = await waha<{ numberExists?: boolean }>(
      `/api/contacts/check-exists?phone=${encodeURIComponent(fone)}&session=${encodeURIComponent(sessionName)}`,
    );
    return typeof r?.numberExists === 'boolean' ? r.numberExists : null;
  } catch {
    return null;
  }
}

/** chatId que o próprio WhatsApp reconhece pra esse número (check-exists, pode vir @lid).
 *  existe=false → o número não tem WhatsApp; null → não deu pra checar. */
export async function resolverChatId(sessionName: string, numero: string): Promise<{ chatId: string; existe: boolean | null }> {
  const fone = numero.replace(/[^0-9]/g, '');
  const chk = await waha<{ numberExists?: boolean; chatId?: string }>(
    `/api/contacts/check-exists?phone=${encodeURIComponent(fone)}&session=${encodeURIComponent(sessionName)}`,
  ).catch(() => null);
  return { chatId: chk?.chatId || chatId(fone), existe: typeof chk?.numberExists === 'boolean' ? chk.numberExists : null };
}

/** Presença no chat — best-effort, com prazo curto pra nunca segurar a resposta:
 *  'visto' = visto azul; 'digitando' = fica ONLINE e mostra "digitando…" (o WhatsApp não mostra
 *  "digitando" de quem está offline, e a sessão fica offline por padrão); 'parar' = tira o
 *  "digitando"; 'offline' = volta a ficar offline (senão o celular do número para de receber push). */
export async function presenca(sessionName: string, chatIdAlvo: string, acao: 'visto' | 'digitando' | 'parar' | 'offline') {
  const chamar = async (rota: string, body: unknown) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    try {
      await fetch(base() + rota, {
        method: 'POST', signal: ctrl.signal,
        headers: { 'X-Api-Key': key(), 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
    } catch { /* presença é enfeite: se falhar, a mensagem sai do mesmo jeito */ } finally { clearTimeout(t); }
  };
  if (acao === 'visto') return chamar('/api/sendSeen', { session: sessionName, chatId: chatIdAlvo });
  if (acao === 'offline') return chamar(`/api/${sessionName}/presence`, { presence: 'offline' });
  if (acao === 'parar') return chamar(`/api/${sessionName}/presence`, { chatId: chatIdAlvo, presence: 'paused' });
  await chamar(`/api/${sessionName}/presence`, { presence: 'online' });
  await chamar(`/api/${sessionName}/presence`, { chatId: chatIdAlvo, presence: 'typing' });
}

/** Envia texto usando o chatId que o próprio WhatsApp resolve (check-exists, pode ser @lid) —
 *  evita o "no LID found" com contato que nunca falou com o número. Devolve o id da mensagem.
 *  Lança 'NUMERO_INEXISTENTE' se o número não tem WhatsApp. */
export async function enviarTextoResolvido(sessionName: string, numero: string, texto: string, chatIdPronto?: string): Promise<{ id: string | null }> {
  let alvo = chatIdPronto;
  if (!alvo) {
    const r = await resolverChatId(sessionName, numero);
    if (r.existe === false) throw new Error('NUMERO_INEXISTENTE');
    alvo = r.chatId;
  }
  const r = await waha<{ id?: string | { _serialized?: string }; key?: { id?: string } }>('/api/sendText', {
    method: 'POST', body: { session: sessionName, chatId: alvo, text: texto },
  });
  const id = typeof r?.id === 'string' ? r.id : r?.id?._serialized || r?.key?.id || null;
  return { id };
}

/** Envia uma foto (URL pública) com legenda, no chatId já resolvido. Devolve o id da mensagem. */
export async function enviarImagemResolvida(sessionName: string, chatIdAlvo: string, url: string, legenda: string): Promise<{ id: string | null }> {
  const r = await waha<{ id?: string | { _serialized?: string }; key?: { id?: string } }>('/api/sendImage', {
    method: 'POST',
    body: { session: sessionName, chatId: chatIdAlvo, caption: legenda, file: { url, mimetype: 'image/jpeg', filename: 'imovel.jpg' } },
  });
  const id = typeof r?.id === 'string' ? r.id : r?.id?._serialized || r?.key?.id || null;
  return { id };
}

export type MensagemHistorico = { id: string; timestamp: number; fromMe: boolean; body?: string | null; hasMedia?: boolean };

/** Últimas mensagens de uma conversa, direto do WhatsApp (mais nova primeiro). Usa o chatId
 *  resolvido pelo check-exists (pode ser @lid), que é o que o WhatsApp de fato reconhece. */
export async function historicoConversa(sessionName: string, numero: string, limite = 30): Promise<MensagemHistorico[]> {
  try {
    const fone = numero.replace(/[^0-9]/g, '');
    const chk = await waha<{ chatId?: string }>(
      `/api/contacts/check-exists?phone=${encodeURIComponent(fone)}&session=${encodeURIComponent(sessionName)}`,
    ).catch(() => null);
    const id = chk?.chatId || chatId(fone);
    const msgs = await waha<MensagemHistorico[]>(
      `/api/${sessionName}/chats/${encodeURIComponent(id)}/messages?limit=${limite}&downloadMedia=false`,
    );
    return Array.isArray(msgs) ? msgs : [];
  } catch {
    return [];
  }
}

/** Baixa a mídia de uma mensagem recebida: pede pro WAHA baixar (downloadMedia=true) e puxa
 *  o arquivo do storage local do WAHA (que exige a X-Api-Key). */
export async function baixarMidiaMensagem(sessionName: string, chatId: string, msgId: string): Promise<{ buffer: Buffer; mimetype: string; filename: string | null } | null> {
  try {
    const msg = await waha<{ media?: { url?: string | null; mimetype?: string; filename?: string } }>(
      `/api/${sessionName}/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(msgId)}?downloadMedia=true`,
    );
    const url = msg?.media?.url;
    if (!url) return null;
    const r = await fetch(url, { headers: { 'X-Api-Key': key() } });
    if (!r.ok) return null;
    return {
      buffer: Buffer.from(await r.arrayBuffer()),
      mimetype: (msg.media?.mimetype || r.headers.get('content-type') || 'application/octet-stream').split(';')[0].trim(),
      filename: msg.media?.filename || null,
    };
  } catch {
    return null;
  }
}

export async function enviarMidia(sessionName: string, numero: string, url: string, tipo: 'imagem' | 'video' | 'documento' | 'audio', legenda?: string, nomeArquivo?: string) {
  const endpoint = tipo === 'imagem' ? '/api/sendImage' : tipo === 'video' ? '/api/sendVideo' : tipo === 'audio' ? '/api/sendVoice' : '/api/sendFile';
  const mimetype = tipo === 'audio' ? 'audio/ogg; codecs=opus' : undefined;
  const filename = tipo === 'documento' ? (nomeArquivo || url.split('/').pop()) : undefined;
  const file: Record<string, string> = { url };
  if (mimetype) file.mimetype = mimetype;
  if (filename) file.filename = filename;
  const body: Record<string, unknown> = { session: sessionName, chatId: chatId(numero), file };
  if (tipo !== 'audio' && legenda) body.caption = legenda;
  if (tipo === 'audio') body.convert = true; // WAHA converte se não estiver no formato certo
  return waha(endpoint, { method: 'POST', body });
}
