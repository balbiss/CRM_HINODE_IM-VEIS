/** Conector do Claude (MCP) — o dono/gerente adiciona https://<MCP_PUBLIC_URL>/mcp no Claude Code
 *  (`claude mcp add --transport http crm-hinode <url>/mcp`) ou como "conector personalizado" no
 *  claude.ai, e consulta o CRM conversando. SOMENTE LEITURA.
 *
 *  Login: OAuth 2.1 feito aqui mesmo (registro dinâmico + PKCE S256 + refresh rotativo), validando
 *  e-mail/senha do CRM (bcrypt, igual /api/auth/login). Só dono e gerente ativos entram; cargo e
 *  bloqueio são reconferidos a cada chamada, então bloquear/remover a pessoa na Equipe corta na hora.
 *
 *  As consultas chamam por dentro as MESMAS rotas das telas (Relatórios, Aprovações, Compromissos),
 *  assinando um token curto no nome de quem logou — os números batem com o que aparece no CRM.
 *
 *  Rotas (domínio próprio do conector, ex.: https://mcp-v2.inoovaweb.cloud):
 *    /mcp                                  -> servidor MCP (exige Bearer)
 *    /oauth/register | /oauth/authorize | /oauth/token
 *    /.well-known/oauth-protected-resource[/mcp], /.well-known/oauth-authorization-server */
import crypto from 'crypto';
import express, { type Request, type Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { db } from '../db/client.js';
import { imobiliarias, perfis, mcpOauthClientes, mcpOauthCodigos, mcpOauthTokens } from '../db/schema.js';

const BASE_URL = (process.env.MCP_PUBLIC_URL || 'https://mcp-v2.inoovaweb.cloud').replace(/\/$/, '');
const RESOURCE_URL = BASE_URL + '/mcp';
const PRM_URL = BASE_URL + '/.well-known/oauth-protected-resource/mcp';
const ACCESS_TTL_S = 60 * 60; // 1h
const REFRESH_TTL_S = 30 * 24 * 60 * 60; // 30 dias
const CODE_TTL_S = 10 * 60;
const NOME_CRM = 'CRM Hinode';

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const aleatorio = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
const escHtml = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export const mcpRouter = express.Router();
mcpRouter.use(['/oauth', '/.well-known'], express.urlencoded({ extended: false }));

// ---------------------------------------------------------------- descoberta
const metadadosRecurso = (_req: Request, res: Response) => res.json({
  resource: RESOURCE_URL, authorization_servers: [BASE_URL], bearer_methods_supported: ['header'], resource_name: NOME_CRM,
});
const metadadosAutorizacao = (_req: Request, res: Response) => res.json({
  issuer: BASE_URL,
  authorization_endpoint: BASE_URL + '/oauth/authorize',
  token_endpoint: BASE_URL + '/oauth/token',
  registration_endpoint: BASE_URL + '/oauth/register',
  response_types_supported: ['code'],
  grant_types_supported: ['authorization_code', 'refresh_token'],
  code_challenge_methods_supported: ['S256'],
  token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
  scopes_supported: ['crm.leitura'],
});
mcpRouter.get(['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/*'], metadadosRecurso);
mcpRouter.get(['/.well-known/oauth-authorization-server', '/.well-known/oauth-authorization-server/*',
  '/.well-known/openid-configuration', '/.well-known/openid-configuration/*'], metadadosAutorizacao);

// ---------------------------------------------------------------- registro dinâmico (RFC 7591)
mcpRouter.post('/oauth/register', async (req, res) => {
  const b = req.body || {};
  const uris: string[] = Array.isArray(b.redirect_uris) ? b.redirect_uris.filter((u: unknown) => typeof u === 'string') : [];
  if (!uris.length || uris.some(u => !/^https:\/\//.test(u) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(u))) {
    return res.status(400).json({ error: 'invalid_redirect_uri', error_description: 'redirect_uris precisa de URLs https (ou localhost)' });
  }
  const metodo = ['client_secret_post', 'client_secret_basic'].includes(b.token_endpoint_auth_method) ? b.token_endpoint_auth_method : 'none';
  const clientId = 'mcp_' + aleatorio(16);
  const secret = metodo === 'none' ? null : aleatorio(32);
  await db.insert(mcpOauthClientes).values({
    id: clientId, secretHash: secret ? sha256(secret) : null, redirectUris: uris,
    nome: typeof b.client_name === 'string' ? b.client_name.slice(0, 120) : null,
  });
  res.status(201).json({
    client_id: clientId,
    ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
    client_id_issued_at: Math.floor(Date.now() / 1000),
    redirect_uris: uris, client_name: b.client_name,
    grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: metodo,
  });
});

// ---------------------------------------------------------------- login (authorize)
async function carregarCliente(clientId: unknown) {
  if (typeof clientId !== 'string' || !clientId) return null;
  const [c] = await db.select().from(mcpOauthClientes).where(eq(mcpOauthClientes.id, clientId)).limit(1);
  return c ?? null;
}

const CAMPOS_AUTH = ['client_id', 'redirect_uri', 'state', 'code_challenge', 'code_challenge_method', 'scope', 'resource'];
type Params = Record<string, string | undefined>;

function paginaLogin(params: Params, erro?: string) {
  const ocultos = CAMPOS_AUTH.map(k => `<input type="hidden" name="${k}" value="${escHtml(params[k])}">`).join('');
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Conectar o Claude ao ${NOME_CRM}</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f1f5f9;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#0f172a}
  .card{width:100%;max-width:380px;margin:16px;background:#fff;border-radius:16px;box-shadow:0 10px 30px rgba(15,23,42,.08);padding:28px}
  h1{font-size:20px;margin:0 0 6px} p{font-size:13px;color:#475569;margin:0 0 18px;line-height:1.5}
  label{display:block;font-size:12px;font-weight:600;margin:12px 0 6px;color:#334155}
  input[type=email],input[type=password]{box-sizing:border-box;width:100%;padding:11px 12px;border:1px solid #cbd5e1;border-radius:10px;font-size:15px}
  button{margin-top:18px;width:100%;padding:12px;border:0;border-radius:10px;background:#1d4ed8;color:#fff;font-size:15px;font-weight:600;cursor:pointer}
  .erro{background:#fef2f2;color:#b91c1c;border:1px solid #fecaca;border-radius:10px;padding:10px 12px;font-size:13px;margin-bottom:8px}
  .nota{font-size:11.5px;color:#64748b;margin-top:16px}
</style></head><body><form class="card" method="post" action="${BASE_URL}/oauth/authorize">
<h1>Conectar o Claude ao ${NOME_CRM}</h1>
<p>Entre com o mesmo e-mail e senha que você usa no CRM. Só dono e gerente podem conectar.</p>
${erro ? `<div class="erro">${escHtml(erro)}</div>` : ''}
${ocultos}
<label for="email">E-mail</label><input id="email" name="email" type="email" autocomplete="username" required autofocus>
<label for="senha">Senha</label><input id="senha" name="senha" type="password" autocomplete="current-password" required>
<button type="submit">Entrar e conectar</button>
<div class="nota">O Claude vai poder <strong>apenas consultar</strong> os números e os leads do CRM. Ele não altera nem apaga nada.</div>
</form></body></html>`;
}

async function validarPedido(p: Params) {
  if (p.response_type && p.response_type !== 'code') return 'Tipo de resposta não suportado.';
  const cliente = await carregarCliente(p.client_id);
  if (!cliente) return 'Aplicativo desconhecido. Remova e adicione o conector de novo no Claude.';
  if (!p.redirect_uri || !cliente.redirectUris.includes(p.redirect_uri)) return 'Endereço de retorno não autorizado.';
  if (!p.code_challenge || (p.code_challenge_method || 'S256') !== 'S256') return 'Pedido sem PKCE (S256).';
  return null;
}
const paginaErro = (msg: string) => `<p style="font-family:sans-serif;padding:24px">${escHtml(msg)}</p>`;

mcpRouter.get('/oauth/authorize', async (req, res) => {
  const p = req.query as Params;
  const erro = await validarPedido(p);
  if (erro) return res.status(400).type('html').send(paginaErro(erro));
  res.type('html').send(paginaLogin(p));
});

// Trava contra chute de senha: 8 tentativas erradas por IP+e-mail a cada 15 min.
const tentativas = new Map<string, number[]>();
function bloqueadoPorTentativas(chave: string) {
  const agora = Date.now();
  const t = (tentativas.get(chave) || []).filter(x => agora - x < 15 * 60 * 1000);
  tentativas.set(chave, t);
  return t.length >= 8;
}

/** Dono/gerente ativo, de imobiliária ativa — vale no login e em toda chamada. */
async function perfilLiberado(perfilId: string) {
  const [p] = await db.select({ id: perfis.id, nome: perfis.nome, role: perfis.role, imobiliariaId: perfis.imobiliariaId, bloqueado: perfis.bloqueado, removidoEm: perfis.removidoEm, status: imobiliarias.status })
    .from(perfis).innerJoin(imobiliarias, eq(imobiliarias.id, perfis.imobiliariaId)).where(eq(perfis.id, perfilId)).limit(1);
  if (!p || p.bloqueado || p.removidoEm || p.status !== 'ativa' || (p.role !== 'dono' && p.role !== 'gerente')) return null;
  return p;
}

mcpRouter.post('/oauth/authorize', async (req, res) => {
  const p = (req.body || {}) as Params;
  const erroPedido = await validarPedido(p);
  if (erroPedido) return res.status(400).type('html').send(paginaErro(erroPedido));

  const email = String(p.email || '').trim().toLowerCase();
  const ip = String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
  const chave = ip + '|' + email;
  if (bloqueadoPorTentativas(chave)) {
    return res.status(429).type('html').send(paginaLogin(p, 'Muitas tentativas. Espere 15 minutos e tente de novo.'));
  }
  const [perfil] = email ? await db.select({ id: perfis.id, senhaHash: perfis.senhaHash }).from(perfis).where(eq(perfis.email, email)).limit(1) : [];
  if (!perfil || !(await bcrypt.compare(String(p.senha || ''), perfil.senhaHash))) {
    tentativas.get(chave)!.push(Date.now());
    return res.status(401).type('html').send(paginaLogin(p, 'E-mail ou senha incorretos.'));
  }
  const liberado = await perfilLiberado(perfil.id);
  if (!liberado) {
    return res.status(403).type('html').send(paginaLogin(p, 'Seu usuário não tem permissão. Só dono e gerente podem conectar o Claude ao CRM.'));
  }
  const codigo = aleatorio(32);
  await db.insert(mcpOauthCodigos).values({
    codigoHash: sha256(codigo), clienteId: p.client_id!, perfilId: liberado.id, redirectUri: p.redirect_uri!,
    codeChallenge: p.code_challenge!, expiraEm: new Date(Date.now() + CODE_TTL_S * 1000),
  });
  console.log('[mcp] login ok: ' + liberado.nome + ' (' + liberado.role + ')');
  const destino = new URL(p.redirect_uri!);
  destino.searchParams.set('code', codigo);
  if (p.state) destino.searchParams.set('state', p.state);
  res.redirect(302, destino.toString());
});

// ---------------------------------------------------------------- token
async function emitirTokens(clienteId: string, perfilId: string) {
  const access = aleatorio(32);
  const refresh = aleatorio(32);
  const agora = Date.now();
  await db.insert(mcpOauthTokens).values([
    { tokenHash: sha256(access), tipo: 'access', clienteId, perfilId, expiraEm: new Date(agora + ACCESS_TTL_S * 1000) },
    { tokenHash: sha256(refresh), tipo: 'refresh', clienteId, perfilId, expiraEm: new Date(agora + REFRESH_TTL_S * 1000) },
  ]);
  return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_S, refresh_token: refresh, scope: 'crm.leitura' };
}

function credenciaisCliente(req: Request) {
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Basic ')) {
    const [id, secret] = Buffer.from(auth.slice(6), 'base64').toString().split(':');
    return { id: decodeURIComponent(id || ''), secret: decodeURIComponent(secret || '') };
  }
  return { id: req.body?.client_id as string | undefined, secret: req.body?.client_secret as string | undefined };
}

mcpRouter.post('/oauth/token', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const b = req.body || {};
  const cred = credenciaisCliente(req);
  const cliente = await carregarCliente(cred.id);
  if (!cliente) return res.status(401).json({ error: 'invalid_client' });
  if (cliente.secretHash && sha256(cred.secret || '') !== cliente.secretHash) return res.status(401).json({ error: 'invalid_client' });

  if (b.grant_type === 'authorization_code') {
    const [cod] = await db.select().from(mcpOauthCodigos).where(eq(mcpOauthCodigos.codigoHash, sha256(String(b.code || '')))).limit(1);
    if (!cod || cod.usadoEm || +cod.expiraEm < Date.now() || cod.clienteId !== cliente.id) return res.status(400).json({ error: 'invalid_grant' });
    if (b.redirect_uri && b.redirect_uri !== cod.redirectUri) return res.status(400).json({ error: 'invalid_grant' });
    const desafio = crypto.createHash('sha256').update(String(b.code_verifier || '')).digest('base64url');
    if (desafio !== cod.codeChallenge) return res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE inválido' });
    // marca usado só se ainda não foi (dois pedidos com o mesmo código)
    const marcado = await db.update(mcpOauthCodigos).set({ usadoEm: new Date() })
      .where(and(eq(mcpOauthCodigos.codigoHash, cod.codigoHash), isNull(mcpOauthCodigos.usadoEm))).returning({ h: mcpOauthCodigos.codigoHash });
    if (!marcado.length) return res.status(400).json({ error: 'invalid_grant' });
    if (!(await perfilLiberado(cod.perfilId))) return res.status(400).json({ error: 'invalid_grant', error_description: 'usuário sem permissão' });
    return res.json(await emitirTokens(cliente.id, cod.perfilId));
  }

  if (b.grant_type === 'refresh_token') {
    const hash = sha256(String(b.refresh_token || ''));
    const [tok] = await db.select().from(mcpOauthTokens).where(and(eq(mcpOauthTokens.tokenHash, hash), eq(mcpOauthTokens.tipo, 'refresh'))).limit(1);
    if (!tok || tok.revogadoEm || +tok.expiraEm < Date.now() || tok.clienteId !== cliente.id) return res.status(400).json({ error: 'invalid_grant' });
    const revogado = await db.update(mcpOauthTokens).set({ revogadoEm: new Date() })
      .where(and(eq(mcpOauthTokens.tokenHash, hash), isNull(mcpOauthTokens.revogadoEm))).returning({ h: mcpOauthTokens.tokenHash });
    if (!revogado.length) return res.status(400).json({ error: 'invalid_grant' });
    if (!(await perfilLiberado(tok.perfilId))) return res.status(400).json({ error: 'invalid_grant', error_description: 'usuário sem permissão' });
    return res.json(await emitirTokens(cliente.id, tok.perfilId));
  }
  return res.status(400).json({ error: 'unsupported_grant_type' });
});

// ---------------------------------------------------------------- servidor MCP
type Perfil = NonNullable<Awaited<ReturnType<typeof perfilLiberado>>>;

async function perfilDoToken(req: Request): Promise<Perfil | null> {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) return null;
  const hash = sha256(auth.slice(7));
  const [tok] = await db.select({ perfilId: mcpOauthTokens.perfilId, expiraEm: mcpOauthTokens.expiraEm, revogadoEm: mcpOauthTokens.revogadoEm })
    .from(mcpOauthTokens).where(and(eq(mcpOauthTokens.tokenHash, hash), eq(mcpOauthTokens.tipo, 'access'))).limit(1);
  if (!tok || tok.revogadoEm || +tok.expiraEm < Date.now()) return null;
  const p = await perfilLiberado(tok.perfilId);
  if (p) void db.update(mcpOauthTokens).set({ ultimoUsoEm: new Date() }).where(eq(mcpOauthTokens.tokenHash, hash)).catch(() => {});
  return p;
}

function negar(res: Response) {
  res.status(401).set('WWW-Authenticate', `Bearer resource_metadata="${PRM_URL}"`)
    .json({ jsonrpc: '2.0', error: { code: -32001, message: 'Faça login no ' + NOME_CRM + ' pra usar o conector.' }, id: null });
}

const hojeSP = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
const dataISO = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'use AAAA-MM-DD');
const periodo = {
  data_inicio: dataISO.describe('Primeiro dia do período, AAAA-MM-DD (horário de Brasília).'),
  data_fim: dataISO.describe('Último dia do período, inclusive, AAAA-MM-DD.'),
};
const filtroCorretor = { corretor: z.string().optional().describe('Nome (ou parte do nome) de um corretor, pra ver só os números dele. Opcional.') };
const SO_LEITURA = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const COMO_LER = {
  safra: 'Leads, funil, origens e campanhas contam os leads que ENTRARAM (foram criados) no período, e até onde cada um já chegou até hoje (funil = está ou já passou pela coluna).',
  vendas: 'Vendas contam pela data de FECHAMENTO dentro do período (de qualquer lead, mesmo que tenha chegado antes), já aprovadas.',
  responderam: 'responderam = lead que já teve o 1º contato registrado.',
  ranking: 'Ranking = o que cada corretor FEZ no período: leads recebidos (roleta, transferência, rebatida puxada) e por quais colunas os leads dele passaram no período, inclusive lead antigo.',
  tempo_resposta: 'respostaMin = mediana (minutos) entre o cliente mandar mensagem e o corretor responder; slaMin = média do lead chegar no corretor até o 1º contato.',
  follow_up: 'Conta os leads que ENTRARAM NO ROBÔ no período (outro grupo, não compare com o funil). responderam = cliente respondeu ao robô; corretor_parou = o corretor assumiu antes do cliente responder; rodando = ainda ativo.',
};

const texto = (obj: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(obj, null, 1) }] });

function criarServidor(perfil: Perfil) {
  const PORTA = Number(process.env.PORT) || 3001;
  // token curto no nome de quem logou: as rotas das telas aplicam as mesmas regras e permissões
  const tokenInterno = () => jwt.sign({ sub: perfil.id, imobiliariaId: perfil.imobiliariaId, role: perfil.role, nome: perfil.nome },
    process.env.JWT_SECRET!, { expiresIn: '2m' });
  const api = async <T = any>(caminho: string): Promise<T> => {
    const r = await fetch('http://127.0.0.1:' + PORTA + caminho, { headers: { authorization: 'Bearer ' + tokenInterno() } });
    const corpo = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((corpo as { error?: string }).error || 'erro ' + r.status);
    return corpo as T;
  };
  const corretorPorNome = async (nome?: string) => {
    if (!nome?.trim()) return null;
    const [c] = await db.execute(sql`select id, nome from perfis where imobiliaria_id = ${perfil.imobiliariaId}
      and nome ilike ${'%' + nome.trim() + '%'} order by (removido_em is null) desc, length(nome) limit 1`) as any[];
    if (!c) throw new Error('Não achei ninguém da equipe com o nome "' + nome + '".');
    return c as { id: string; nome: string };
  };
  const qs = (o: Record<string, string | null | undefined>) => new URLSearchParams(Object.entries(o).filter(([, v]) => v) as [string, string][]).toString();

  const server = new McpServer({ name: 'crm-hinode', version: '1.0.0' }, {
    instructions: NOME_CRM + ' (imobiliária, Minha Casa Minha Vida). Você está conectado como ' + perfil.nome + ' (' + perfil.role + '). '
      + 'Ferramentas SÓ DE LEITURA. Datas em AAAA-MM-DD no horário de Brasília; cada resposta traz "hoje". '
      + 'Antes de comparar números leia "como_ler": quadros diferentes medem grupos diferentes. '
      + 'Responda em português, em linguagem de imobiliária, sem termos técnicos.',
  });
  const executar = <A,>(nome: string, fn: (a: A) => Promise<ReturnType<typeof texto>>) => async (args: A) => {
    try {
      console.log('[mcp] ' + perfil.nome + ' -> ' + nome + ' ' + JSON.stringify(args));
      return await fn(args);
    } catch (e) {
      return { isError: true, content: [{ type: 'text' as const, text: 'Não consegui consultar: ' + (e as Error).message }] };
    }
  };
  const relatorios = async (a: { data_inicio: string; data_fim: string; corretor?: string }) => {
    const c = await corretorPorNome(a.corretor);
    const q = qs({ de: a.data_inicio, ate: a.data_fim, corretorId: c?.id });
    const [v2, oka] = await Promise.all([api('/api/relatorios?' + q), api('/api/relatorios-oka?' + q)]);
    return { c, v2, oka };
  };

  server.registerTool('resumo_do_periodo', {
    title: 'Resumo do período',
    description: 'Números gerais num período (mesma conta da tela Relatórios): leads que entraram (campanha x WhatsApp x outros) e comparação com o período anterior, '
      + 'quantos responderam, tempo do 1º contato, vendas e valor vendido, descartes, temperatura, funil completo (quantos passaram por cada coluna), '
      + 'origens, motivos de descarte/devolução, rebatidas de hoje e o atendimento do Agente de IA. Pode filtrar um corretor.',
    inputSchema: { ...periodo, ...filtroCorretor }, annotations: SO_LEITURA,
  }, executar('resumo_do_periodo', async a => {
    const { c, v2, oka } = await relatorios(a);
    return texto({
      hoje: hojeSP(), periodo: { de: a.data_inicio, ate: a.data_fim }, corretor: c?.nome ?? 'todos',
      numeros: v2.kpis, resumo: oka.resumo,
      leads_novos: { ...oka.novos, porEtapa: oka.novos.porEtapa?.map((e: any) => ({ coluna: e.titulo, total: e.total, responderam: e.responderam, renda_media: e.renda_media })) },
      temperatura: oka.temperatura,
      funil: oka.funil.map((f: any) => ({ coluna: f.titulo, leads: f.n })),
      origens: oka.origens, canais: v2.canais,
      motivos_descarte: oka.motivos, rebatidas_hoje: oka.rebatidasHoje, agente_ia: v2.ia,
      como_ler: { safra: COMO_LER.safra, vendas: COMO_LER.vendas, responderam: COMO_LER.responderam },
    });
  }));

  server.registerTool('desempenho_dos_corretores', {
    title: 'Desempenho dos corretores',
    description: 'Por corretor, no período: leads recebidos, por quais colunas os leads dele passaram (agendado, visitou, cobrar doc, análise de crédito, aprovado...), '
      + 'descartes, recusas, leads sem resposta, tempo de resposta, carteira atual, vendas e valor vendido.',
    inputSchema: { ...periodo, ...filtroCorretor }, annotations: SO_LEITURA,
  }, executar('desempenho_dos_corretores', async a => {
    const { c, v2, oka } = await relatorios(a);
    const etapas: { slug: string; nome: string }[] = oka.etapas;
    const porId = new Map<string, any>((v2.corretores as any[]).map(x => [x.id, x]));
    const ranking = (oka.ranking as any[]).map(r => {
      const x = porId.get(r.corretor_id) ?? {};
      porId.delete(r.corretor_id);
      return {
        corretor: r.nome, recebidos: r.recebidos,
        passaram_por: Object.fromEntries(etapas.map(e => [e.nome, r[e.slug] ?? 0])),
        descartes: r.descarte, descadastrados: r.descadastrado, recusou: x.recusou ?? 0, sem_resposta: x.semResposta ?? 0,
        respostaMin: x.respostaMin ?? null, slaMin: r.slaMin, carteira_agora: x.carteira ?? null, vendas: r.vendas, valor_vendido: r.vgv,
      };
    });
    const outros = [...porId.values()].map(x => ({ corretor: x.nome, recebidos: x.recebidos, carteira_agora: x.carteira, vendas: x.vendas, valor_vendido: x.vgv }));
    return texto({ hoje: hojeSP(), periodo: { de: a.data_inicio, ate: a.data_fim }, corretor: c?.nome ?? 'todos', ranking, outros_com_movimento: outros,
      recusas: v2.recusas, como_ler: { ranking: COMO_LER.ranking, tempo_resposta: COMO_LER.tempo_resposta, vendas: COMO_LER.vendas } });
  }));

  server.registerTool('campanhas', {
    title: 'Qualidade das campanhas',
    description: 'Por campanha/anúncio (origem do lead), dos leads que entraram no período: total, responderam, agendaram, visitaram, análise de crédito, '
      + 'restrição, taxa de aprovação de crédito, lead ruim (renda baixa, outra região, número errado), descadastrados, vendas, gasto lançado, custo por lead e custo por venda.',
    inputSchema: { ...periodo, ...filtroCorretor }, annotations: SO_LEITURA,
  }, executar('campanhas', async a => {
    const { c, oka } = await relatorios(a);
    return texto({ hoje: hojeSP(), periodo: { de: a.data_inicio, ate: a.data_fim }, corretor: c?.nome ?? 'todos', campanhas: oka.campanhas,
      como_ler: { safra: COMO_LER.safra, vendas: COMO_LER.vendas } });
  }));

  server.registerTool('follow_up_automatico', {
    title: 'Follow-up automático',
    description: 'O que o robô de follow-up fez no período, por corretor (entraram no robô, responderam, corretor parou, ainda rodando), em qual mensagem o cliente mais responde, '
      + 'e a foto de agora: fluxos de cada corretor (ligado/desligado, quantas mensagens) e quantos leads estão no robô.',
    inputSchema: { ...periodo, ...filtroCorretor }, annotations: SO_LEITURA,
  }, executar('follow_up_automatico', async a => {
    const { c, oka } = await relatorios(a);
    const fluxos = await db.execute(sql`select f.nome as fluxo, coalesce(p.nome, 'modelo da imobiliária') as dono_do_fluxo, f.ativo as ligado,
        f.dispara_em_lead_novo as dispara_em_lead_novo, f.campanha,
        (select count(*) from followup_passos x where x.fluxo_id = f.id)::int as mensagens,
        (select count(*) from followup_execucoes e where e.fluxo_id = f.id and e.status = 'ativa')::int as leads_rodando_agora
      from followup_fluxos f left join perfis p on p.id = f.corretor_id
      where f.imobiliaria_id = ${perfil.imobiliariaId} and f.arquivado_em is null ${c ? sql`and f.corretor_id = ${c.id}` : sql``}
      order by p.nome nulls first, f.nome`);
    const [cfg] = await db.execute(sql`select followup_automatico_ativo as ligado from imobiliarias where id = ${perfil.imobiliariaId}`) as any[];
    return texto({ hoje: hojeSP(), periodo: { de: a.data_inicio, ate: a.data_fim }, corretor: c?.nome ?? 'todos',
      follow_up_automatico_da_imobiliaria_ligado: !!cfg?.ligado, no_periodo: oka.followup, fluxos_agora: fluxos,
      como_ler: { follow_up: COMO_LER.follow_up } });
  }));

  server.registerTool('carteira_atual', {
    title: 'Carteira de agora',
    description: 'Foto de agora: por pessoa da equipe, quantos cards tem em cada coluna do Kanban, tarefas atrasadas (próximo contato vencido), se está no plantão/roleta, '
      + 'em almoço, com WhatsApp conectado; e os leads sem corretor (rebatidas no bolsão) e descartes/vendas esperando aprovação.',
    inputSchema: {}, annotations: SO_LEITURA,
  }, executar('carteira_atual', async () => {
    const I = perfil.imobiliariaId;
    const equipe = await db.execute(sql`
      select p.nome as pessoa, p.role as cargo, p.em_plantao as no_plantao, p.em_almoco as em_almoco,
        exists (select 1 from sessoes_whatsapp s where s.corretor_id = p.id and (s.status = 'conectada' or s.oficial_ativa)) as whatsapp_conectado,
        (select count(*) from leads l where l.corretor_id = p.id and l.descartado_em is null)::int as total_cards,
        (select coalesce(jsonb_object_agg(z.coluna, z.n), '{}'::jsonb) from (
          select coalesce(c.titulo, 'Sem coluna') as coluna, count(*)::int as n from leads l left join colunas_kanban c on c.id = l.coluna_id
          where l.corretor_id = p.id and l.descartado_em is null group by 1) z) as por_coluna,
        (select count(*) from leads l left join colunas_kanban c on c.id = l.coluna_id
          where l.corretor_id = p.id and l.descartado_em is null and coalesce(c.slug, '') <> 'followup_auto'
            and l.proximo_contato_em < now())::int as tarefas_atrasadas
      from perfis p where p.imobiliaria_id = ${I} and p.removido_em is null and not p.bloqueado
      order by case p.role when 'dono' then 0 when 'gerente' then 1 else 2 end, p.nome`);
    const [sem] = await db.execute(sql`select
        count(*) filter (where l.corretor_id is null and l.descartado_em is null)::int as sem_corretor,
        count(*) filter (where l.corretor_id is null and c.slug = 'rebatida')::int as rebatidas_no_bolsao,
        count(*) filter (where l.descarte_pendente_aprovacao)::int as descartes_aguardando_aprovacao,
        count(*) filter (where l.venda_pendente_aprovacao)::int as vendas_aguardando_aprovacao
      from leads l left join colunas_kanban c on c.id = l.coluna_id where l.imobiliaria_id = ${I} and l.importacao_pendente = false`) as any[];
    return texto({ hoje: hojeSP(), equipe, sem_corretor_e_aprovacoes: sem });
  }));

  server.registerTool('buscar_lead', {
    title: 'Buscar lead',
    description: 'Procura um lead pelo nome ou telefone (até 10 resultados) e mostra corretor, coluna, origem, datas, próximo contato, visita, renda, descarte, venda, '
      + 'follow-up, últimos registros do histórico e últimas mensagens do WhatsApp.',
    inputSchema: { busca: z.string().min(3).describe('Nome (ou parte) ou telefone do lead.') }, annotations: SO_LEITURA,
  }, executar('buscar_lead', async ({ busca }: { busca: string }) => {
    const b = busca.trim();
    const dig = b.replace(/\D/g, '');
    const porTel = dig.length >= 6 ? sql`or regexp_replace(coalesce(l.telefone, ''), '\D', '', 'g') like ${'%' + dig + '%'}
      or regexp_replace(coalesce(l.telefone_alternativo, ''), '\D', '', 'g') like ${'%' + dig + '%'}` : sql``;
    const rows = await db.execute(sql`
      select l.nome, l.telefone, l.telefone_alternativo, p.nome as corretor, c.titulo as coluna, coalesce(nullif(btrim(l.campanha), ''), l.canal::text) as origem,
        l.criado_em as entrou_em, l.recadastro_em, l.ultima_acao_em as ultima_acao, l.proximo_contato_em as proximo_contato,
        l.data_visita as visita, l.status_visita, l.renda_declarada, l.bairro_interesse as cidade_bairro, l.temperatura,
        l.descartado_em, l.motivo_descarte, l.descarte_pendente_aprovacao, l.credito_aprovado_em,
        case when l.data_fechamento is not null or l.venda_pendente_aprovacao then jsonb_build_object('data', l.data_fechamento, 'valor', l.valor_venda,
          'empreendimento', l.empreendimento, 'aguardando_aprovacao', l.venda_pendente_aprovacao) end as venda,
        (select jsonb_build_object('fluxo', f.nome, 'status', e.status, 'resultado', e.resultado, 'proxima_mensagem', e.passo_atual + 1, 'proximo_envio', e.proximo_envio_em)
          from followup_execucoes e join followup_fluxos f on f.id = e.fluxo_id where e.lead_id = l.id order by e.iniciado_em desc limit 1) as follow_up,
        (select coalesce(jsonb_agg(jsonb_build_object('quando', h.criado_em, 'quem', h.ator_nome, 'o_que', left(h.descricao, 300)) order by h.criado_em desc), '[]'::jsonb)
          from (select * from eventos_lead ev where ev.lead_id = l.id order by ev.criado_em desc limit 10) h) as historico_recente,
        (select coalesce(jsonb_agg(jsonb_build_object('quando', m.enviado_em,
            'de', case when m.direcao = 'in' then 'cliente' when m.canal = 'followup' then 'robô de follow-up' else 'corretor' end,
            'texto', left(coalesce(m.texto, '[' || coalesce(m.anexo_tipo, 'anexo') || ']'), 300)) order by m.enviado_em desc), '[]'::jsonb)
          from (select * from mensagens_whatsapp mw where mw.lead_id = l.id order by mw.enviado_em desc limit 8) m) as mensagens_recentes
      from leads l left join perfis p on p.id = l.corretor_id left join colunas_kanban c on c.id = l.coluna_id
      where l.imobiliaria_id = ${perfil.imobiliariaId} and (l.nome ilike ${'%' + b + '%'} ${porTel})
      order by l.ultima_acao_em desc nulls last limit 10`);
    return texto({ hoje: hojeSP(), encontrados: (rows as any[]).length, leads: rows });
  }));

  server.registerTool('aprovacoes_pendentes', {
    title: 'Aprovações pendentes',
    description: 'Descartes e vendas que os corretores pediram e estão esperando o dono/gerente aprovar (tela Aprovações), com corretor, motivo, observação e dados da venda.',
    inputSchema: {}, annotations: SO_LEITURA,
  }, executar('aprovacoes_pendentes', async () => {
    const rows = await api<any[]>('/api/aprovacoes');
    return texto({ hoje: hojeSP(), total: rows.length, pendentes: rows.map(r => ({
      tipo: r.vendaPendente ? 'venda' : 'descarte', lead: r.nome, telefone: r.telefone, corretor: r.corretorNome, campanha: r.campanha,
      motivo: r.motivoDescarte, observacao: r.observacao, valor_venda: r.valorVenda, empreendimento: r.empreendimento,
      torre: r.torre, unidade: r.unidade, data_venda_informada: r.dataVendaInformada, ultima_acao: r.ultimaAcaoEm,
    })) });
  }));

  server.registerTool('agenda', {
    title: 'Agenda (visitas e compromissos)',
    description: 'Visitas marcadas nos leads e compromissos da equipe (reuniões, plantões...) entre duas datas. Pode filtrar um corretor.',
    inputSchema: { ...periodo, ...filtroCorretor }, annotations: SO_LEITURA,
  }, executar('agenda', async a => {
    const c = await corretorPorNome(a.corretor);
    const de = new Date(a.data_inicio + 'T00:00:00-03:00');
    const ate = new Date(+new Date(a.data_fim + 'T00:00:00-03:00') + 86400000);
    const visitas = await db.execute(sql`select l.data_visita as quando, l.tipo_visita, l.status_visita, l.nome as lead, l.telefone, p.nome as corretor, c.titulo as coluna
      from leads l left join perfis p on p.id = l.corretor_id left join colunas_kanban c on c.id = l.coluna_id
      where l.imobiliaria_id = ${perfil.imobiliariaId} and l.data_visita >= ${de.toISOString()}::timestamptz and l.data_visita < ${ate.toISOString()}::timestamptz
        and l.descartado_em is null ${c ? sql`and l.corretor_id = ${c.id}` : sql``}
      order by l.data_visita`);
    const comp = await api<any[]>('/api/compromissos?' + qs({ de: de.toISOString(), ate: ate.toISOString() }));
    return texto({ hoje: hojeSP(), periodo: { de: a.data_inicio, ate: a.data_fim }, corretor: c?.nome ?? 'todos',
      visitas, compromissos_da_equipe: comp.map(x => ({ quando: x.inicio, fim: x.fim, titulo: x.titulo, tipo: x.tipo, local: x.local, observacao: x.observacao, criado_por: x.autorNome })) });
  }));

  return server;
}

mcpRouter.post('/mcp', async (req, res) => {
  const perfil = await perfilDoToken(req);
  if (!perfil) return negar(res);
  // sem sessão (stateless): um servidor por requisição, nada fica em memória
  const server = criarServidor(perfil);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => { void transport.close(); void server.close(); });
  try {
    await server.connect(transport);
    // req.auth do Express aqui é o do CRM (JwtClaims), não o AuthInfo do SDK — não é usado
    await transport.handleRequest(req as unknown as Parameters<typeof transport.handleRequest>[0], res, req.body);
  } catch (e) {
    console.error('[mcp] erro:', (e as Error).message);
    if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Erro interno' }, id: null });
  }
});
const naoPermitido = async (req: Request, res: Response) => {
  if (!(await perfilDoToken(req))) return negar(res);
  res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Método não permitido.' }, id: null });
};
mcpRouter.get('/mcp', naoPermitido);
mcpRouter.delete('/mcp', naoPermitido);
