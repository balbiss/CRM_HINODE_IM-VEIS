import { Router } from 'express';
import { z } from 'zod';
import { and, eq, ne } from 'drizzle-orm';
import { db } from '../db/client.js';
import { randomBytes } from 'node:crypto';
import { integracoesFacebook, imobiliarias } from '../db/schema.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { cifrar, decifrar } from '../lib/crypto.js';
import { checarConexao } from '../lib/facebookSaude.js';
import type { PaginaFb } from '../lib/facebook.js';
import { GRAPH, assinarLeadgen, fbConfigurado, frontendUrl, hubLiberarPagina, hubRegistrarPagina, lerEstado, paginasDoUsuario, trocarCodigo, urlLoginFacebook } from '../lib/facebook.js';

function publicUrl() {
  return (process.env.PUBLIC_URL || 'https://hinode.inoovaweb.com.br').replace(/\/$/, '');
}

export const integracoesRouter = Router();

// ------------------------------------------------------------------
// GET /api/integracoes/facebook/ativas
// Chamado pela automação (n8n), NÃO por usuário. Protegido por segredo compartilhado.
// Devolve TODAS as conexões ativas de TODAS as imobiliárias, com o token descriptografado.
// ------------------------------------------------------------------
integracoesRouter.get('/facebook/ativas', async (req, res) => {
  const segredo = req.header('x-integracoes-secret');
  if (!segredo || segredo !== process.env.INTEGRACOES_SECRET) {
    return res.status(401).json({ error: 'Não autorizado' });
  }
  // Só as manuais (token colado + formulário): as conexões por login recebem via webhook, sem varredura.
  const rows = await db.select().from(integracoesFacebook)
    .where(and(eq(integracoesFacebook.ativo, true), eq(integracoesFacebook.origem, 'manual')));
  const lista = rows.filter(r => r.formId).map(r => {
    try {
      return {
        id: r.id,
        imobiliariaId: r.imobiliariaId,
        pageId: r.pageId,
        formId: r.formId,
        accessToken: decifrar({ cifrado: r.tokenCifrado, iv: r.tokenIv, tag: r.tokenTag }),
      };
    } catch {
      return null; // token corrompido / chave trocada — ignora essa conexão
    }
  }).filter(Boolean);
  res.json(lista);
});

// ------------------------------------------------------------------
// POST /api/integracoes/facebook/sync-status
// A automação (n8n) reporta o resultado da última varredura de cada conexão,
// pra tela de Integrações mostrar "Última captação" / "Situação" de verdade.
// Protegido pelo mesmo segredo compartilhado.
// ------------------------------------------------------------------
integracoesRouter.post('/facebook/sync-status', async (req, res) => {
  const segredo = req.header('x-integracoes-secret');
  if (!segredo || segredo !== process.env.INTEGRACOES_SECRET) {
    return res.status(401).json({ error: 'Não autorizado' });
  }
  const parsed = z.object({
    id: z.string().uuid(),
    ok: z.boolean(),
    erro: z.string().max(500).optional(),
    leadsCaptados: z.number().int().nonnegative().optional(),
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Dados inválidos' });

  const patch = parsed.data.ok
    ? { ultimaSyncEm: new Date(), ultimoErro: null }
    : { ultimoErro: parsed.data.erro || 'Falha na captação (sem detalhe)' };
  await db.update(integracoesFacebook).set(patch).where(eq(integracoesFacebook.id, parsed.data.id));
  res.json({ ok: true });
});

// ------------------------------------------------------------------
// GET /api/integracoes/facebook/oauth/callback
// Volta do login do Facebook ("Conectar com Facebook"). Público (é o navegador do dono
// voltando da Meta); a imobiliária vem do `state` assinado gerado em /oauth/url.
// Salva cada Página autorizada e assina o webhook de leads dela.
// ------------------------------------------------------------------
integracoesRouter.get('/facebook/oauth/callback', async (req, res) => {
  const volta = (q: Record<string, string>) => res.redirect(frontendUrl() + '/integracoes?' + new URLSearchParams(q).toString());
  const estado = lerEstado(String(req.query.state || ''));
  if (!estado) return volta({ facebook: 'erro', msg: 'Link de conexão expirado. Clique em "Conectar com Facebook" de novo.' });
  if (req.query.error || !req.query.code) return volta({ facebook: 'erro', msg: 'Conexão cancelada no Facebook.' });

  try {
    const userToken = await trocarCodigo(String(req.query.code));
    const paginas = await paginasDoUsuario(userToken);
    if (!paginas.length) return volta({ facebook: 'erro', msg: 'Nenhuma página encontrada. Entre com a conta que administra a página da imobiliária e marque a página na tela do Facebook.' });

    // Uma página só e livre: conecta direto (o caso da imobiliária comum).
    // Mais de uma (agência com páginas de vários clientes): o dono escolhe no CRM quais são desta imobiliária.
    if (paginas.length > 1 || await paginaEmOutraImobiliaria(paginas[0].id, estado.imobiliariaId)) {
      const sel = randomBytes(18).toString('base64url');
      selecoes.set(sel, { imobiliariaId: estado.imobiliariaId, paginas, expira: Date.now() + 15 * 60000 });
      return volta({ facebook: 'escolher', sel });
    }
    volta(await conectarPaginas(estado.imobiliariaId, paginas));
  } catch (e) {
    console.error('oauth facebook:', (e as Error).message);
    volta({ facebook: 'erro', msg: 'O Facebook recusou a conexão: ' + ((e as Error).message || 'erro desconhecido') });
  }
});

/** Páginas autorizadas no login esperando o dono escolher quais são da imobiliária (15 min, só em memória). */
const selecoes = new Map<string, { imobiliariaId: string; paginas: PaginaFb[]; expira: number }>();
function pegarSelecao(sel: string, imobiliariaId: string) {
  for (const [k, v] of selecoes) if (v.expira < Date.now()) selecoes.delete(k);
  const s = selecoes.get(sel);
  return s && s.imobiliariaId === imobiliariaId ? s : null;
}

/** Conecta as páginas escolhidas: trava "uma página, uma imobiliária", registra no hub, assina o
 *  webhook de leads e grava a conexão. Devolve o resumo no formato da volta pro front. */
async function conectarPaginas(imobiliariaId: string, paginas: PaginaFb[]): Promise<Record<string, string>> {
  const estado = { imobiliariaId };
  {
    const conectadas: string[] = [], emOutra: string[] = [], falharam: string[] = [];
    for (const p of paginas) {
      // Uma Página só pode alimentar UMA imobiliária: o mesmo lead nunca cai em duas.
      if (await paginaEmOutraImobiliaria(p.id, estado.imobiliariaId)) { emOutra.push(p.name); continue; }
      // ...nem em outro sistema que usa o mesmo app Meta (o hub é quem garante isso entre CRMs).
      const noHub = await hubRegistrarPagina(p.id, p.name, estado.imobiliariaId);
      if (noHub === 'outro') { emOutra.push(p.name); continue; }
      let erro: string | null = noHub === 'erro' ? 'Não foi possível registrar a página no hub de leads. Tente conectar de novo.' : null;
      if (!erro) {
        try { await assinarLeadgen(p.id, p.access_token); } catch (e) { erro = (e as Error).message; }
      }
      if (erro) falharam.push(p.name);
      const { cifrado, iv, tag } = cifrar(p.access_token);
      const dados = { nomeConta: p.name, tokenCifrado: cifrado, tokenIv: iv, tokenTag: tag, ativo: true, ultimoErro: erro };
      const [existente] = await db.select({ id: integracoesFacebook.id }).from(integracoesFacebook).where(and(
        eq(integracoesFacebook.imobiliariaId, estado.imobiliariaId), eq(integracoesFacebook.pageId, p.id), eq(integracoesFacebook.origem, 'oauth'),
      )).limit(1);
      if (existente) await db.update(integracoesFacebook).set(dados).where(eq(integracoesFacebook.id, existente.id));
      else await db.insert(integracoesFacebook).values({ ...dados, imobiliariaId: estado.imobiliariaId, pageId: p.id, formId: null, origem: 'oauth' });
      if (!erro) conectadas.push(p.name);
    }
    const q: Record<string, string> = { facebook: conectadas.length ? 'ok' : 'erro', conectadas: conectadas.join('|') };
    if (emOutra.length) q.emOutra = emOutra.join('|');
    if (falharam.length) q.falharam = falharam.join('|');
    if (!conectadas.length) q.msg = emOutra.length ? 'Essa página já está conectada em outra imobiliária ou outro sistema.' : 'Não foi possível ativar o recebimento de leads da página.';
    return q;
  }
}

async function paginaEmOutraImobiliaria(pageId: string, imobiliariaId: string) {
  const [outra] = await db.select({ id: integracoesFacebook.id }).from(integracoesFacebook)
    .where(and(eq(integracoesFacebook.pageId, pageId), ne(integracoesFacebook.imobiliariaId, imobiliariaId))).limit(1);
  return !!outra;
}

// ------------------------------------------------------------------
// Daqui pra baixo: só usuário autenticado (Dono/Gerente).
// ------------------------------------------------------------------
integracoesRouter.use(requireAuth);
integracoesRouter.use('/facebook', requireRole('dono', 'gerente'));

/** Link do login do Facebook pro botão "Conectar com Facebook". */
integracoesRouter.get('/facebook/oauth/url', (req, res) => {
  if (!fbConfigurado()) return res.status(503).json({ error: 'Conexão com Facebook ainda não configurada no servidor' });
  res.json({ url: urlLoginFacebook(req.auth!.imobiliariaId, req.auth!.sub) });
});

/** Lista das páginas autorizadas no login, pra escolher quais são desta imobiliária.
 *  situacao: 'livre' | 'nesta' (já conectada aqui) | 'outra' (de outra imobiliária — bloqueada). */
integracoesRouter.get('/facebook/oauth/paginas', async (req, res) => {
  const s = pegarSelecao(String(req.query.sel || ''), req.auth!.imobiliariaId);
  if (!s) return res.status(410).json({ error: 'A escolha de páginas expirou. Clique em "Conectar com Facebook" de novo.' });
  const nesta = new Set((await db.select({ pageId: integracoesFacebook.pageId }).from(integracoesFacebook)
    .where(eq(integracoesFacebook.imobiliariaId, req.auth!.imobiliariaId))).map(r => r.pageId));
  const lista = [];
  for (const p of s.paginas) {
    const situacao = (await paginaEmOutraImobiliaria(p.id, req.auth!.imobiliariaId)) ? 'outra' : nesta.has(p.id) ? 'nesta' : 'livre';
    lista.push({ id: p.id, nome: p.name, bm: p.business?.name || null, situacao });
  }
  res.json(lista);
});

/** Conecta só as páginas que o dono marcou. */
integracoesRouter.post('/facebook/oauth/confirmar', async (req, res) => {
  const parsed = z.object({ sel: z.string().min(10), pageIds: z.array(z.string()).min(1).max(50) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Marque pelo menos uma página' });
  const s = pegarSelecao(parsed.data.sel, req.auth!.imobiliariaId);
  if (!s) return res.status(410).json({ error: 'A escolha de páginas expirou. Clique em "Conectar com Facebook" de novo.' });
  const escolhidas = s.paginas.filter(p => parsed.data.pageIds.includes(p.id));
  if (!escolhidas.length) return res.status(400).json({ error: 'Marque pelo menos uma página' });
  const resultado = await conectarPaginas(req.auth!.imobiliariaId, escolhidas);
  selecoes.delete(parsed.data.sel);
  res.json(resultado);
});
integracoesRouter.use('/site', requireRole('dono', 'gerente'));

// ------------------------------------------------------------------
// Webhook do formulário do site (landing Lovable). Um link por imobiliária.
// ------------------------------------------------------------------
async function urlDoSite(imobId: string, gerarSeFaltar: boolean) {
  let [imob] = await db.select({ token: imobiliarias.capturaToken }).from(imobiliarias).where(eq(imobiliarias.id, imobId)).limit(1);
  if ((!imob?.token) && gerarSeFaltar) {
    const token = randomBytes(24).toString('base64url');
    await db.update(imobiliarias).set({ capturaToken: token }).where(eq(imobiliarias.id, imobId));
    imob = { token };
  }
  return imob?.token ? { token: imob.token, url: publicUrl() + '/api/captacao/site/' + imob.token } : { token: null, url: null };
}

integracoesRouter.get('/site', async (req, res) => {
  res.json(await urlDoSite(req.auth!.imobiliariaId, true));
});

integracoesRouter.post('/site/regenerar', async (req, res) => {
  const token = randomBytes(24).toString('base64url');
  await db.update(imobiliarias).set({ capturaToken: token }).where(eq(imobiliarias.id, req.auth!.imobiliariaId));
  res.json({ token, url: publicUrl() + '/api/captacao/site/' + token });
});

const mascarar = (r: typeof integracoesFacebook.$inferSelect) => ({
  id: r.id, nomeConta: r.nomeConta, pageId: r.pageId, formId: r.formId, origem: r.origem,
  ativo: r.ativo, ultimaSyncEm: r.ultimaSyncEm, ultimoErro: r.ultimoErro, criadoEm: r.criadoEm,
  tokenFinal: '••••' + (safeLast4(r) ?? ''),
});

function safeLast4(r: typeof integracoesFacebook.$inferSelect): string | null {
  try {
    const t = decifrar({ cifrado: r.tokenCifrado, iv: r.tokenIv, tag: r.tokenTag });
    return t.slice(-4);
  } catch { return null; }
}

integracoesRouter.get('/facebook', async (req, res) => {
  const rows = await db.select().from(integracoesFacebook)
    .where(eq(integracoesFacebook.imobiliariaId, req.auth!.imobiliariaId));
  res.json(rows.map(mascarar));
});

const createSchema = z.object({
  nomeConta: z.string().min(1).max(80),
  pageId: z.string().min(1).max(60),
  formId: z.string().min(1).max(60),
  accessToken: z.string().min(20),
});

integracoesRouter.post('/facebook', async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Dados inválidos' });
  if (await paginaEmOutraImobiliaria(parsed.data.pageId.trim(), req.auth!.imobiliariaId)) {
    return res.status(409).json({ error: 'Essa página do Facebook já está conectada em outra imobiliária' });
  }
  const { cifrado, iv, tag } = cifrar(parsed.data.accessToken.trim());
  const [row] = await db.insert(integracoesFacebook).values({
    imobiliariaId: req.auth!.imobiliariaId,
    nomeConta: parsed.data.nomeConta.trim(),
    pageId: parsed.data.pageId.trim(),
    formId: parsed.data.formId.trim(),
    tokenCifrado: cifrado, tokenIv: iv, tokenTag: tag,
  }).returning();
  res.status(201).json(mascarar(row));
});

const patchSchema = z.object({
  nomeConta: z.string().min(1).max(80).optional(),
  pageId: z.string().min(1).max(60).optional(),
  formId: z.string().min(1).max(60).optional(),
  accessToken: z.string().min(20).optional(),
  ativo: z.boolean().optional(),
});

async function daImobiliaria(id: string, imobiliariaId: string) {
  const [row] = await db.select().from(integracoesFacebook)
    .where(and(eq(integracoesFacebook.id, id), eq(integracoesFacebook.imobiliariaId, imobiliariaId))).limit(1);
  return row;
}

integracoesRouter.patch('/facebook/:id', async (req, res) => {
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Dados inválidos' });
  if (!(await daImobiliaria(req.params.id, req.auth!.imobiliariaId))) return res.status(404).json({ error: 'Conexão não encontrada' });
  if (parsed.data.pageId && await paginaEmOutraImobiliaria(parsed.data.pageId.trim(), req.auth!.imobiliariaId)) {
    return res.status(409).json({ error: 'Essa página do Facebook já está conectada em outra imobiliária' });
  }

  const patch: Record<string, unknown> = {};
  if (parsed.data.nomeConta) patch.nomeConta = parsed.data.nomeConta.trim();
  if (parsed.data.pageId) patch.pageId = parsed.data.pageId.trim();
  if (parsed.data.formId) patch.formId = parsed.data.formId.trim();
  if (typeof parsed.data.ativo === 'boolean') patch.ativo = parsed.data.ativo;
  if (parsed.data.accessToken) {
    const { cifrado, iv, tag } = cifrar(parsed.data.accessToken.trim());
    patch.tokenCifrado = cifrado; patch.tokenIv = iv; patch.tokenTag = tag;
  }
  const [row] = await db.update(integracoesFacebook).set(patch).where(eq(integracoesFacebook.id, req.params.id)).returning();
  res.json(mascarar(row));
});

integracoesRouter.delete('/facebook/:id', async (req, res) => {
  const row = await daImobiliaria(req.params.id, req.auth!.imobiliariaId);
  if (!row) return res.status(404).json({ error: 'Conexão não encontrada' });
  await db.delete(integracoesFacebook).where(eq(integracoesFacebook.id, req.params.id));
  // Página conectada por login: libera no hub (outro sistema/imobiliária pode conectar depois).
  if (row.origem === 'oauth') await hubLiberarPagina(row.pageId);
  res.json({ ok: true });
});

/** Testa a conexão de verdade: busca o formulário no Graph API com o token salvo. */
integracoesRouter.post('/facebook/:id/testar', async (req, res) => {
  const row = await daImobiliaria(req.params.id, req.auth!.imobiliariaId);
  if (!row) return res.status(404).json({ error: 'Conexão não encontrada' });
  // Conexão por login: mesma checagem da vigia automática (acesso + webhook de leads da página).
  if (row.origem === 'oauth') {
    const r = await checarConexao(row);
    if (r === 'indeterminado') return res.json({ ok: false, erro: 'Não foi possível falar com o Facebook agora. Tente de novo em instantes.' });
    if (r === 'ok') {
      await db.update(integracoesFacebook).set({ ultimoErro: null }).where(eq(integracoesFacebook.id, row.id));
      return res.json({ ok: true, formulario: row.nomeConta });
    }
    await db.update(integracoesFacebook).set({ ultimoErro: r.erro }).where(eq(integracoesFacebook.id, row.id));
    return res.json({ ok: false, erro: r.erro });
  }
  let token: string;
  try { token = decifrar({ cifrado: row.tokenCifrado, iv: row.tokenIv, tag: row.tokenTag }); }
  catch { return res.status(400).json({ ok: false, erro: 'Não foi possível ler o token salvo (chave de criptografia mudou?)' }); }

  try {
    // Conexão por login: confere a Página (todos os formulários). Manual: confere o formulário.
    const alvo = row.formId || row.pageId;
    const url = `${GRAPH}/${encodeURIComponent(alvo)}?fields=id,name&access_token=${encodeURIComponent(token)}`;
    const r = await fetch(url);
    const body = await r.json() as { id?: string; name?: string; error?: { message?: string } };
    if (!r.ok || body.error) {
      const msg = body.error?.message || `Graph API respondeu ${r.status}`;
      await db.update(integracoesFacebook).set({ ultimoErro: msg }).where(eq(integracoesFacebook.id, row.id));
      return res.json({ ok: false, erro: msg });
    }
    await db.update(integracoesFacebook).set({ ultimoErro: null, ultimaSyncEm: new Date() }).where(eq(integracoesFacebook.id, row.id));
    res.json({ ok: true, formulario: body.name || body.id });
  } catch (e) {
    res.json({ ok: false, erro: (e as Error).message || 'Falha ao contatar o Graph API' });
  }
});
