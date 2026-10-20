import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { integracoesFacebook, notificacoes, perfis } from '../db/schema.js';
import { decifrar } from './crypto.js';
import { GRAPH, assinarLeadgen, fbConfigurado } from './facebook.js';
import { enviarPush } from './push.js';

type Conexao = typeof integracoesFacebook.$inferSelect;

/** Confere se a Página conectada pelo login continua mandando leads pro nosso app:
 *  o token ainda vale e a assinatura do webhook `leadgen` continua lá (se sumiu, tenta refazer).
 *  'ok' · { erro } = problema real · 'indeterminado' = falha de rede (não acusa nada). */
export async function checarConexao(c: Conexao): Promise<'ok' | 'indeterminado' | { erro: string }> {
  let token: string;
  try { token = decifrar({ cifrado: c.tokenCifrado, iv: c.tokenIv, tag: c.tokenTag }); }
  catch { return { erro: 'Não foi possível ler o acesso salvo. Clique em "Conectar com Facebook" de novo.' }; }

  let body: { data?: { id: string }[]; error?: { message?: string } };
  try {
    const r = await fetch(GRAPH + '/' + encodeURIComponent(c.pageId) + '/subscribed_apps?access_token=' + encodeURIComponent(token));
    body = await r.json() as typeof body;
  } catch { return 'indeterminado'; }

  if (body.error) {
    return { erro: 'O Facebook não deixa mais o CRM acessar a página (' + (body.error.message || 'acesso recusado') + '). Clique em "Conectar com Facebook" de novo.' };
  }
  if ((body.data || []).some(a => a.id === process.env.FB_APP_ID)) return 'ok';
  try { await assinarLeadgen(c.pageId, token); return 'ok'; }
  catch { return { erro: 'A página parou de enviar leads pro CRM. Clique em "Conectar com Facebook" de novo.' }; }
}

/** Passa em todas as conexões por login ativas. Quando uma passa de OK pra erro, avisa o dono e
 *  os gerentes (notificação + push) uma vez; volta a ficar OK sozinha quando a checagem passa. */
export async function verificarConexoesFacebook() {
  if (!fbConfigurado()) return;
  const conexoes = await db.select().from(integracoesFacebook)
    .where(and(eq(integracoesFacebook.origem, 'oauth'), eq(integracoesFacebook.ativo, true)));
  for (const c of conexoes) {
    const r = await checarConexao(c);
    if (r === 'indeterminado') continue;
    if (r === 'ok') {
      if (c.ultimoErro) await db.update(integracoesFacebook).set({ ultimoErro: null }).where(eq(integracoesFacebook.id, c.id));
      continue;
    }
    if (c.ultimoErro === r.erro) continue; // já avisado
    await db.update(integracoesFacebook).set({ ultimoErro: r.erro }).where(eq(integracoesFacebook.id, c.id));
    if (!c.ultimoErro) await avisarGestores(c, r.erro);
  }
}

async function avisarGestores(c: Conexao, erro: string) {
  const gestores = await db.select({ id: perfis.id }).from(perfis)
    .where(and(eq(perfis.imobiliariaId, c.imobiliariaId), inArray(perfis.role, ['dono', 'gerente'])));
  if (!gestores.length) return;
  const titulo = 'Leads do Facebook pararam de chegar';
  const texto = `Página "${c.nomeConta}": ${erro}`;
  await db.insert(notificacoes).values(gestores.map(g => ({ perfilId: g.id, tipo: 'integracao', titulo, texto, lida: false })));
  for (const g of gestores) enviarPush(g.id, { title: titulo, body: texto, url: '/integracoes', tag: 'fb-' + c.id }).catch(() => {});
}
