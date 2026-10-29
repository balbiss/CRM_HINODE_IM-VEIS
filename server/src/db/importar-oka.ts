import { sql } from './client.js';

/** Migração CRM OKA (v1, Supabase) → CRM Hinode (v2).
 *
 * Traz equipe (com as senhas atuais), as colunas do Kanban da v1, leads com todos os campos,
 * conversas de WhatsApp, histórico do card, tarefas, descartes, compromissos, campanhas e o log
 * da roleta. Cada registro guarda o id que tinha na v1 (`oka_id`), então rodar de novo só
 * atualiza/completa — é assim que se faz a virada: roda uma vez antes, confere, e roda de novo
 * na hora de trocar (pega o que entrou no meio tempo).
 *
 * Requer OKA_SUPABASE_TOKEN no ambiente (token da Management API) — nunca commitar o token.
 * Uso: OKA_SUPABASE_TOKEN=... npx tsx src/db/importar-oka.ts [--so=equipe,colunas,leads,...]
 */

const SUPABASE_PROJECT = 'osheoeeigahkwsrzfjdw';

async function supa<T = any>(query: string, tentativa = 1): Promise<T[]> {
  const token = process.env.OKA_SUPABASE_TOKEN;
  if (!token) throw new Error('OKA_SUPABASE_TOKEN não configurado');
  const res = await fetch(`https://api.supabase.com/v1/projects/${SUPABASE_PROJECT}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const json = (await res.json().catch(() => ({ message: 'HTTP ' + res.status }))) as any;
  if (!Array.isArray(json)) {
    // a Management API às vezes dá 429/5xx em sequência de lotes grandes — espera e tenta de novo
    if (tentativa < 5) {
      await new Promise(r => setTimeout(r, 3000 * tentativa));
      return supa(query, tentativa + 1);
    }
    throw new Error('Supabase: ' + (json.message ?? JSON.stringify(json)).slice(0, 300));
  }
  return json;
}

/** Percorre uma tabela da v1 em páginas (keyset por data,id), entregando cada página pra `fn` — nunca
 *  guarda a tabela inteira na memória (o container do backend tem pouca RAM; 75 mil mensagens de uma
 *  vez derrubavam o processo). */
async function porPagina(cols: string, from: string, ordem: string, fn: (rows: any[]) => Promise<void>, pagina = 2000) {
  let cursor: { t: string; id: string } | null = null;
  let total = 0;
  for (;;) {
    const where: string = cursor ? `where (${ordem}, id) > ('${cursor.t}'::timestamptz, '${cursor.id}'::uuid)` : '';
    const rows: any[] = await supa<any>(`select ${cols}, ${ordem} as __ord, id as __id from ${from} ${where} order by ${ordem}, id limit ${pagina}`);
    if (rows.length) await fn(rows);
    total += rows.length;
    process.stdout.write(`    ${from}: ${total}\r`);
    if (rows.length < pagina) break;
    const ult: any = rows[rows.length - 1];
    cursor = { t: ult.__ord, id: ult.__id };
  }
  console.log(`    ${from}: ${total} lidos           `);
}

/** Tabela inteira na memória — só pras pequenas/médias (leads, descartes, compromissos, follow-up). */
async function supaTudo<T = any>(cols: string, from: string, ordem = 'created_at', pagina = 5000): Promise<T[]> {
  const out: T[] = [];
  await porPagina(cols, from, ordem, async rows => { out.push(...rows); }, pagina);
  return out;
}

/** Colunas do Kanban da v1 → slug na v2. TAREFAS vira "atend" e AGENDADO vira "visita" porque o
 *  código da v2 já usa esses slugs pra "lead puxado/assumido" e "visita marcada". */
const SLUG_POR_COLUNA: Record<string, string> = {
  'LEAD NOVO': 'novo', 'REBATIDA': 'rebatida', 'TAREFAS': 'atend', 'CONVERSANDO': 'conversando',
  'AGENDADO': 'visita', 'VISITOU': 'visitou', 'COBRAR DOC': 'cobrar_doc', 'PENDENTE': 'pendente',
  'ANÁLISE DE CRÉDITO': 'credito', 'APROVADO': 'aprovado', 'FID': 'fid', 'REPROVADO': 'reprovado',
  'RESTRIÇÃO': 'restricao', 'VENDA': 'venda', 'FUTUROS': 'futuros', 'PAROU DE RESPONDER': 'parou',
  'DESCARTE': 'descarte', 'TRABALHO': 'trabalho', 'LEAD DESCADASTRAR': 'descadastrar',
  'FOLLOW-UP': 'followup', 'FOLLOW-UP AUTOMÁTICO': 'followup_auto',
};
/** Lead da v1 sem coluna_kanban_id: o status antigo decide a coluna. */
const SLUG_POR_STATUS: Record<string, string> = {
  novo: 'novo', rebatida: 'rebatida', tarefas: 'atend', em_atendimento: 'atend', agendado: 'visita',
  visitou: 'visitou', cobrar_doc: 'cobrar_doc', pendente: 'pendente', aprovado: 'aprovado',
  reprovado: 'reprovado', futuros: 'futuros', venda_concluida: 'venda', desqualificado: 'descadastrar',
};
const COR_POR_SLUG: Record<string, string> = {
  novo: '#3B82F6', rebatida: '#F97316', atend: '#EF4444', conversando: '#0EA5E9', visita: '#A855F7',
  visitou: '#F59E0B', cobrar_doc: '#06B6D4', pendente: '#64748B', credito: '#DC2626', aprovado: '#10B981',
  fid: '#8B5CF6', reprovado: '#E11D48', restricao: '#BE123C', venda: '#16A34A', futuros: '#6366F1',
  parou: '#94A3B8', descarte: '#78716C', trabalho: '#A16207', descadastrar: '#57534E',
  followup: '#7C3AED', followup_auto: '#6D28D9',
};

function canalDaOrigem(origem: string | null): string {
  const o = (origem ?? '').toLowerCase();
  if (!o) return 'Facebook';
  if (o === 'whatsapp' || o.startsWith('whatsapp')) return 'WhatsApp';
  if (o.includes('instagram')) return 'Instagram';
  if (o.includes('indica')) return 'Indicacao';
  if (o.includes('site')) return 'Site';
  if (o.includes('manual')) return 'Manual';
  return 'Facebook';
}

/** Na v1 o anexo vem no texto: "[Anexo]: <url>" (+ legenda nas linhas seguintes). */
function separarAnexo(conteudo: string | null, tipo: string | null) {
  const c = conteudo ?? '';
  const m = c.match(/^\[Anexo\]:\s*(\S+)\s*([\s\S]*)$/);
  if (!m) return { texto: c || null, anexoUrl: null, anexoTipo: null, anexoNome: null };
  const url = m[1];
  const anexoTipo = tipo === 'image' || tipo === 'sticker' ? 'imagem' : tipo === 'video' ? 'video'
    : tipo === 'audio' ? 'audio' : 'documento';
  const nome = decodeURIComponent(url.split('/').pop()?.split('?')[0] ?? '') || null;
  return { texto: m[2].trim() || null, anexoUrl: url, anexoTipo, anexoNome: anexoTipo === 'documento' ? nome : null };
}

// o Postgres devolve "2026-05-01 12:00:00.123456+00" — vira ISO válido pro JS ("+00" → "+00:00")
const ts = (v: any) => (v ? new Date(String(v).replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00")).toISOString() : null);

/** insert em lote com upsert pelo oka_id (ou "do nothing" em qualquer conflito). */
async function upsert(tabela: string, rows: Record<string, unknown>[], atualizar: string[] | 'nada', alvo = '(oka_id)') {
  if (!rows.length) return;
  const LOTE = 500;
  let n = 0;
  for (let i = 0; i < rows.length; i += LOTE) {
    const lote = rows.slice(i, i + LOTE);
    const cols = Object.keys(lote[0]);
    if (atualizar === 'nada') {
      await sql`insert into ${sql(tabela)} ${sql(lote as any, cols)} on conflict do nothing`;
    } else {
      const set = atualizar.map(c => `"${c}" = excluded."${c}"`).join(', ');
      await sql`insert into ${sql(tabela)} ${sql(lote as any, cols)} on conflict ${sql.unsafe(alvo)} do update set ${sql.unsafe(set)}`;
    }
    n += lote.length;
    process.stdout.write(`    ${tabela}: ${n}/${rows.length}\r`);
  }
  if (rows.length) console.log(`    ${tabela}: ${rows.length} ok            `);
}

async function main() {
  const so = (process.argv.find(a => a.startsWith('--so='))?.slice(5).split(',')) ?? null;
  const etapa = (nome: string) => !so || so.includes(nome);

  const [imob] = await sql<{ id: string }[]>`select id from imobiliarias order by criado_em limit 1`;
  if (!imob) throw new Error('Nenhuma imobiliária no banco da v2 — rode as migrações e crie a imobiliária antes.');
  const imobiliariaId = imob.id;

  // ---------- Equipe ----------
  console.log('Equipe...');
  const okaPerfis = await supa(`
    select p.id, p.nome, p.role::text role, p.telefone, p.avatar_url, p.bloqueado, p.removido_em, p.status_roleta,
           p.em_almoco, p.advertencias_semana, p.advertencia_semana_inicio, p.ultimo_lead_recebido_em, p.created_at,
           u.email, u.encrypted_password
    from perfis p join auth.users u on u.id = p.id`);
  if (etapa('equipe')) {
    for (const p of okaPerfis) {
      const email = String(p.email).toLowerCase();
      const dados = {
        oka_id: p.id, nome: p.nome, role: p.role, telefone: p.telefone, avatar_url: p.avatar_url,
        bloqueado: !!p.bloqueado || !!p.removido_em, removido_em: ts(p.removido_em), em_plantao: !!p.status_roleta,
        em_almoco: !!p.em_almoco, advertencias_semana: p.advertencias_semana ?? 0,
        advertencia_semana_inicio: p.advertencia_semana_inicio, ultimo_lead_recebido_em: ts(p.ultimo_lead_recebido_em),
      };
      // senha: a v1 guarda bcrypt ($2a$) — o bcryptjs da v2 confere igual, ninguém precisa trocar a senha.
      const senha = p.encrypted_password || null;
      const [existe] = await sql`select id from perfis where lower(email) = ${email} or oka_id = ${p.id} limit 1`;
      if (existe) {
        // Quem já existe na v2 continua como está lá (nome, telefone, senha, papel): a v1 só
        // preenche o que estiver vazio e traz os estados da roleta/remoção.
        const { nome, telefone, avatar_url, role, ...estados } = dados;
        void role;
        await sql`update perfis set ${sql(estados as any)},
          nome = coalesce(nullif(nome, ''), ${nome}), telefone = coalesce(nullif(telefone, ''), ${telefone}),
          avatar_url = coalesce(avatar_url, ${avatar_url})
          where id = ${existe.id}`;
      } else {
        await sql`insert into perfis ${sql({ ...dados, imobiliaria_id: imobiliariaId, email, senha_hash: senha ?? '!', criado_em: ts(p.created_at) } as any)}`;
      }
    }
    console.log(`    perfis: ${okaPerfis.length} ok`);
  }
  const perfilPorOka = new Map<string, { id: string; nome: string }>();
  for (const r of await sql<{ id: string; oka_id: string; nome: string }[]>`select id, oka_id, nome from perfis where oka_id is not null`) {
    perfilPorOka.set(r.oka_id, { id: r.id, nome: r.nome });
  }
  const perfilId = (okaId: string | null) => (okaId ? perfilPorOka.get(okaId)?.id ?? null : null);

  // ---------- Colunas ----------
  const okaColunas = await supa(`select id, nome, posicao from colunas_kanban order by posicao`);
  if (etapa('colunas')) {
    console.log('Colunas do Kanban...');
    for (const c of okaColunas) {
      const slug = SLUG_POR_COLUNA[c.nome] ?? null;
      const [existe] = slug
        ? await sql`select id from colunas_kanban where imobiliaria_id = ${imobiliariaId} and slug = ${slug} limit 1`
        : await sql`select id from colunas_kanban where imobiliaria_id = ${imobiliariaId} and upper(titulo) = ${c.nome} limit 1`;
      const dados = { titulo: c.nome, ordem: c.posicao, cor: slug ? COR_POR_SLUG[slug] : null, slug };
      if (existe) await sql`update colunas_kanban set ${sql(dados as any)} where id = ${existe.id}`;
      else await sql`insert into colunas_kanban ${sql({ ...dados, imobiliaria_id: imobiliariaId } as any)}`;
    }
    // colunas que só existem na v2 (ex.: "Proposta") ficam — o dono decide se tira
    console.log(`    colunas: ${okaColunas.length} ok`);
  }
  const colunaPorSlug = new Map<string, string>();
  for (const r of await sql<{ id: string; slug: string | null }[]>`select id, slug from colunas_kanban where imobiliaria_id = ${imobiliariaId}`) {
    if (r.slug) colunaPorSlug.set(r.slug, r.id);
  }
  const slugDaColunaOka = new Map(okaColunas.map(c => [c.id as string, SLUG_POR_COLUNA[c.nome]]));

  // ---------- Leads ----------
  if (etapa('leads')) {
    console.log('Leads...');
    const okaLeads = await supaTudo(`corretor_id, coluna_kanban_id, status::text status, temperatura::text temperatura, nome, email, telefone,
      telefone_alternativo, origem, valor_estimado, bairro_interesse, tipo_imovel_interesse, motivo_descarte, descartado_por, descartado_em,
      valor_venda, data_fechamento, referencia, renda_familiar, saldo_fgts, valor_entrada, link_drive, cadencia_chamada, data_ultima_chamada,
      data_atribuicao, ultima_acao_at, data_visita, tipo_visita, status_visita, descarte_pendente_aprovacao, lembrete_follow_up,
      tentativas_contato, primeiro_contato_em, sla_vencido, favorito, conversa_fixada, empreendimento, unidade, torre,
      venda_pendente_aprovacao, credito_aprovado_em, lembrete_pos_venda_enviado_em, data_nascimento, lembrete_aniversario_ano_enviado,
      recadastro_em, recadastro_origem, data_venda_informada, updated_at, created_at`, 'leads');
    const rows = okaLeads.map((l: any) => {
      const slug = (l.coluna_kanban_id && slugDaColunaOka.get(l.coluna_kanban_id)) || SLUG_POR_STATUS[l.status] || 'novo';
      return {
        oka_id: l.__id, imobiliaria_id: imobiliariaId,
        nome: l.nome || l.telefone || '(sem nome)', telefone: l.telefone || l.telefone_alternativo || '(sem telefone)',
        email: l.email, telefone_alternativo: l.telefone_alternativo, campanha: l.origem, canal: canalDaOrigem(l.origem),
        coluna_id: colunaPorSlug.get(slug) ?? colunaPorSlug.get('novo') ?? null, corretor_id: perfilId(l.corretor_id),
        temperatura: l.temperatura, valor: String(l.valor_venda ?? l.valor_estimado ?? 0),
        bairro_interesse: l.bairro_interesse, tipo_imovel_interesse: l.tipo_imovel_interesse, referencia: l.referencia,
        link_drive: l.link_drive, renda_declarada: l.renda_familiar, saldo_fgts: l.saldo_fgts, valor_entrada: l.valor_entrada,
        motivo_descarte: l.motivo_descarte, descartado_em: ts(l.descartado_em), descartado_por: perfilId(l.descartado_por),
        descarte_pendente_aprovacao: !!l.descarte_pendente_aprovacao, venda_pendente_aprovacao: !!l.venda_pendente_aprovacao,
        valor_venda: l.valor_venda, data_fechamento: ts(l.data_fechamento), data_venda_informada: l.data_venda_informada,
        empreendimento: l.empreendimento, torre: l.torre, unidade: l.unidade,
        imovel_titulo: l.empreendimento,
        imovel_sub: [l.torre ? 'Torre ' + l.torre : null, l.unidade ? 'Unidade ' + l.unidade : null].filter(Boolean).join(' · ') || null,
        cadencia_chamada: l.cadencia_chamada ?? 0, cadencia: l.cadencia_chamada ? 'Chamada ' + l.cadencia_chamada : null,
        data_ultima_chamada: ts(l.data_ultima_chamada), proximo_contato_em: ts(l.lembrete_follow_up),
        tentativas_contato: l.tentativas_contato ?? 0, data_visita: ts(l.data_visita), tipo_visita: l.tipo_visita,
        status_visita: l.status_visita, credito_aprovado_em: ts(l.credito_aprovado_em), primeiro_contato_em: ts(l.primeiro_contato_em),
        data_atribuicao: ts(l.data_atribuicao), ultima_acao_em: ts(l.ultima_acao_at), sla_vencido: !!l.sla_vencido,
        favorito: !!l.favorito, conversa_fixada: !!l.conversa_fixada, data_nascimento: l.data_nascimento,
        lembrete_aniversario_ano: l.lembrete_aniversario_ano_enviado, lembrete_pos_venda_em: ts(l.lembrete_pos_venda_enviado_em),
        recadastro_em: ts(l.recadastro_em), recadastro_origem: l.recadastro_origem, segundo_cadastro: !!l.recadastro_em,
        entrou_na_coluna_em: ts(l.ultima_acao_at ?? l.updated_at ?? l.__ord), criado_em: ts(l.__ord),
      };
    });
    // Lead que já entrou direto na v2 (Facebook pelo hub, WhatsApp...) e também existe na v1:
    // vira um lead só — o da v2 ganha o oka_id e recebe os dados da v1 (sem duplicar card).
    const soDigitos = (t: string | null) => (t ?? '').replace(/\D/g, '').replace(/^55(?=\d{10,11}$)/, '').slice(-11);
    const daV2 = await sql<{ id: string; telefone: string }[]>`select id, telefone from leads where oka_id is null and imobiliaria_id = ${imobiliariaId}`;
    const v2PorTel = new Map(daV2.map(l => [soDigitos(l.telefone), l.id]));
    let juntados = 0;
    for (const r of rows) {
      const tel = soDigitos(r.telefone);
      const id = tel.length >= 10 ? v2PorTel.get(tel) : undefined;
      if (id) {
        await sql`update leads set oka_id = ${r.oka_id} where id = ${id}`;
        v2PorTel.delete(tel);
        juntados++;
      }
    }
    if (juntados) console.log(`    ${juntados} lead(s) que já estavam na v2 juntados com o da v1`);
    const atualizar = Object.keys(rows[0] ?? {}).filter(c => c !== 'oka_id' && c !== 'imobiliaria_id');
    await upsert('leads', rows, atualizar, '(oka_id) where oka_id is not null');
  }
  const leadPorOka = new Map<string, string>();
  for (const r of await sql<{ id: string; oka_id: string }[]>`select id, oka_id from leads where oka_id is not null`) leadPorOka.set(r.oka_id, r.id);
  const leadId = (okaId: string | null) => (okaId ? leadPorOka.get(okaId) ?? null : null);

  // ---------- Mensagens ----------
  if (etapa('mensagens')) {
    console.log('Mensagens de WhatsApp...');
    await porPagina(`lead_id, corretor_id, conteudo, direcao, status, whatsapp_message_id, tipo, lida, canal, wa_chave`, 'mensagens_whatsapp', 'created_at', async msgs => {
    const rows = msgs.filter((m: any) => leadId(m.lead_id)).map((m: any) => {
      const a = separarAnexo(m.conteudo, m.tipo);
      const saida = m.direcao === 'outbound';
      return {
        oka_id: m.__id, lead_id: leadId(m.lead_id), direcao: saida ? 'out' : 'in',
        wa_message_id: m.whatsapp_message_id, wa_chave: m.wa_chave,
        ack_status: saida ? (m.status === 'read' ? 4 : m.status === 'delivered' ? 3 : 2) : null,
        lida: m.lida ?? true, enviado_por: saida ? perfilId(m.corretor_id) : null,
        texto: a.texto, anexo_url: a.anexoUrl, anexo_tipo: a.anexoTipo, anexo_nome: a.anexoNome,
        canal: m.canal === 'followup' ? 'followup' : 'corretor', enviado_em: ts(m.__ord),
      };
    });
    // "do nothing": a mesma mensagem não entra 2x (oka_id, wa_message_id e wa_chave são únicos)
    if (rows.length) await upsert('mensagens_whatsapp', rows, 'nada');
    });
  }

  // ---------- Histórico do card ----------
  if (etapa('historico')) {
    console.log('Histórico dos cards...');
    await porPagina(`lead_id, autor_id, tipo, conteudo`, 'leads_interacoes', 'created_at', async inter => upsert('eventos_lead', inter.filter((i: any) => leadId(i.lead_id)).map((i: any) => ({
      oka_id: i.__id, imobiliaria_id: imobiliariaId, lead_id: leadId(i.lead_id),
      tipo: i.tipo === 'nota' ? 'nota' : i.tipo === 'descarte' ? 'descarte' : 'oka_' + i.tipo,
      descricao: i.conteudo ?? '', ator_nome: i.autor_id ? perfilPorOka.get(i.autor_id)?.nome ?? null : null, criado_em: ts(i.__ord),
    })), 'nada'));
    await porPagina(`lead_id, corretor_id, removido_em, motivo`, 'lead_historico_corretores', 'atribuido_em', async hist => upsert('eventos_lead', hist.filter((h: any) => leadId(h.lead_id)).map((h: any) => ({
      oka_id: h.__id, imobiliaria_id: imobiliariaId, lead_id: leadId(h.lead_id), tipo: 'distribuido',
      descricao: 'Atribuído a ' + (perfilPorOka.get(h.corretor_id)?.nome ?? 'corretor') + (h.motivo ? ' (' + h.motivo + ')' : '')
        + (h.removido_em ? ' — saiu em ' + new Date(h.removido_em).toLocaleDateString('pt-BR') : ''),
      ator_nome: null, criado_em: ts(h.__ord),
    })), 'nada'));
  }

  // ---------- Tarefas, descartes, compromissos, campanhas, roleta ----------
  if (etapa('tarefas')) {
    console.log('Tarefas (lembretes)...');
    await porPagina(`lead_id, corretor_id, datetime, observacao, concluido`, 'lembretes_followup', 'created_at', async lemb => upsert('tarefas', lemb.map((t: any) => ({
      oka_id: t.__id, imobiliaria_id: imobiliariaId, lead_id: leadId(t.lead_id), corretor_id: perfilId(t.corretor_id),
      titulo: 'Retornar contato', descricao: t.observacao, vence_em: ts(t.datetime) ?? ts(t.__ord),
      concluida: !!t.concluido, avisada: true, criado_em: ts(t.__ord),
    })), ['lead_id', 'corretor_id', 'descricao', 'vence_em', 'concluida']));
  }
  if (etapa('descartes')) {
    console.log('Descartes...');
    const desc = await supaTudo(`lead_id, usuario_id, motivo, observacao`, 'descartes_leads');
    await upsert('descartes_leads', desc.filter((d: any) => leadId(d.lead_id)).map((d: any) => ({
      oka_id: d.__id, imobiliaria_id: imobiliariaId, lead_id: leadId(d.lead_id), usuario_id: perfilId(d.usuario_id),
      motivo: d.motivo ?? '—', observacao: d.observacao, criado_em: ts(d.__ord),
    })), 'nada');
  }
  if (etapa('compromissos')) {
    console.log('Compromissos da equipe, campanhas e gastos...');
    const comp = await supaTudo(`titulo, tipo, inicio, fim, local, observacao, criado_por, cancelado_em, aviso_enviado_em`, 'compromissos_equipe');
    await upsert('compromissos_equipe', comp.map((c: any) => ({
      oka_id: c.__id, imobiliaria_id: imobiliariaId, titulo: c.titulo, tipo: c.tipo ?? 'reuniao', inicio: ts(c.inicio),
      fim: ts(c.fim), local: c.local, observacao: c.observacao, criado_por: perfilId(c.criado_por),
      cancelado_em: ts(c.cancelado_em), aviso_enviado_em: ts(c.aviso_enviado_em), criado_em: ts(c.__ord),
    })), ['titulo', 'tipo', 'inicio', 'fim', 'local', 'observacao', 'cancelado_em', 'aviso_enviado_em']);
    const camp = await supa(`select nome, drive_url, observacao, created_at from campanhas`);
    await upsert('campanhas', camp.map((c: any) => ({
      imobiliaria_id: imobiliariaId, nome: c.nome, drive_url: c.drive_url, observacao: c.observacao, criado_em: ts(c.created_at),
    })), ['drive_url', 'observacao'], '(imobiliaria_id, nome)');
    const gastos = await supa(`select origem, mes, valor, atualizado_por from gastos_campanha`);
    await upsert('gastos_campanha', gastos.map((g: any) => ({
      imobiliaria_id: imobiliariaId, origem: g.origem, mes: g.mes, valor: String(g.valor ?? 0), atualizado_por: perfilId(g.atualizado_por),
    })), ['valor'], '(imobiliaria_id, origem, mes)');
  }
  if (etapa('roleta')) {
    console.log('Histórico da roleta...');
    // sem chave única pra deduplicar: na 2ª rodada traz só o que é mais novo que o último já importado
    const [ult] = await sql`select max(criado_em) m from distribuicao_log where origem like 'oka:%'`;
    const desde = ult?.m ? new Date(ult.m).getTime() : 0;
    await porPagina(`lead_id, corretor_id, tipo`, 'distribuicao_log', 'created_at', async dist => {
      const rows = dist.filter((d: any) => leadId(d.lead_id) && perfilId(d.corretor_id) && new Date(ts(d.__ord)!).getTime() > desde)
        .map((d: any) => ({
          imobiliaria_id: imobiliariaId, lead_id: leadId(d.lead_id), corretor_id: perfilId(d.corretor_id),
          origem: 'oka:' + (d.tipo ?? 'roleta'), criado_em: ts(d.__ord),
        }));
      if (rows.length) await upsert('distribuicao_log', rows, 'nada');
    });
  }

  // ---------- Mensagens prontas (de cada um) ----------
  const [dono] = await sql<{ id: string }[]>`select id from perfis where imobiliaria_id = ${imobiliariaId} and role = 'dono' order by criado_em limit 1`;
  if (etapa('templates')) {
    console.log('Mensagens prontas...');
    const tpls = await supa(`select id, titulo, conteudo, criado_por, anexo_url, anexo_tipo, anexo_nome, anexos from templates_mensagem`);
    await upsert('templates_mensagem', tpls.map((t: any) => {
      const anexos = Array.isArray(t.anexos) && t.anexos.length ? t.anexos
        : t.anexo_url ? [{ url: t.anexo_url, nome: t.anexo_nome, tipo: t.anexo_tipo }] : [];
      return {
        oka_id: t.id, criado_por: perfilId(t.criado_por) ?? dono?.id, titulo: t.titulo || 'Sem título', texto: t.conteudo ?? '',
        anexo_url: anexos[0]?.url ?? null, anexos: JSON.stringify(anexos),
      };
    }), ['criado_por', 'titulo', 'texto', 'anexo_url', 'anexos']);
  }

  // ---------- Imóveis, links úteis e treinamentos ----------
  if (etapa('imoveis')) {
    console.log('Imóveis, links úteis e treinamentos...');
    const ims = await supa(`select id, titulo, descricao, tipo, finalidade, preco, endereco, cidade, estado, fotos, area, quartos, banheiros, caracteristicas, referencia_anuncio, created_at from imoveis`);
    const cap = (s: string | null) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : 'Apartamento');
    await upsert('imoveis', ims.map((i: any) => ({
      oka_id: i.id, imobiliaria_id: imobiliariaId, titulo: i.titulo, descricao: i.descricao, tipo: cap(i.tipo),
      finalidade: /alug|loca/i.test(i.finalidade ?? '') ? 'Alugar' : 'Comprar', preco: String(i.preco ?? 0),
      endereco: i.endereco, cidade: i.cidade, estado: i.estado, area: i.area != null ? String(i.area) : null,
      quartos: i.quartos ?? 0, banheiros: i.banheiros ?? 0, imagens: JSON.stringify(Array.isArray(i.fotos) ? i.fotos : []),
      amenidades: JSON.stringify(Array.isArray(i.caracteristicas) ? i.caracteristicas : []), referencia_anuncio: i.referencia_anuncio,
      criado_em: ts(i.created_at),
    })), ['titulo', 'descricao', 'tipo', 'finalidade', 'preco', 'endereco', 'cidade', 'estado', 'area', 'quartos', 'banheiros', 'imagens', 'amenidades', 'referencia_anuncio']);
    const links = await supa(`select id, titulo, url from links_uteis`);
    await upsert('links_uteis', links.map((l: any) => ({ oka_id: l.id, imobiliaria_id: imobiliariaId, categoria: 'Geral', titulo: l.titulo, url: l.url })), ['titulo', 'url']);
    const treins = await supa(`select id, titulo, url from treinamentos`);
    await upsert('treinamentos', treins.map((t: any) => ({ oka_id: t.id, imobiliaria_id: imobiliariaId, titulo: t.titulo, video_url: t.url })), ['titulo', 'video_url']);
  }

  // ---------- Follow-up: fluxos, passos, execuções e envios ----------
  // Sem --virada os fluxos entram DESLIGADOS (com o estado da v1 guardado em ativo_na_v1) e os robôs que
  // estavam rodando entram pausados: a v2 não manda nada enquanto a equipe ainda usa a v1.
  // Com --virada liga tudo exatamente como estava na v1 (fluxos, Geral, automático da imobiliária).
  const virada = process.argv.includes('--virada');
  if (etapa('followup')) {
    console.log('Follow-up (fluxos, passos, execuções)' + (virada ? ' — VIRADA: ligando como na v1' : ' — fluxos entram desligados') + '...');
    const fluxos = await supa(`select id, corretor_id, nome, ativo, e_geral, ao_esgotar, motivo_descarte_esgotar, campanha, arquivado_em, created_at from followup_fluxos`);
    await upsert('followup_fluxos', fluxos.map((f: any) => ({
      oka_id: f.id, imobiliaria_id: imobiliariaId, corretor_id: perfilId(f.corretor_id), nome: f.nome,
      ativo: virada ? !!f.ativo && !f.arquivado_em : false, ativo_na_v1: !!f.ativo,
      dispara_em_lead_novo: virada ? !!f.e_geral : false,
      ao_esgotar: f.ao_esgotar === 'descartar' ? 'descartar' : 'nada', motivo_descarte_esgotar: f.motivo_descarte_esgotar || 'Sem Resposta',
      campanha: f.campanha, arquivado_em: ts(f.arquivado_em), criado_em: ts(f.created_at),
    })), ['corretor_id', 'nome', 'ativo', 'ativo_na_v1', 'dispara_em_lead_novo', 'ao_esgotar', 'motivo_descarte_esgotar', 'campanha', 'arquivado_em']);
    const fluxoPorOka = new Map((await sql<{ id: string; oka_id: string }[]>`select id, oka_id from followup_fluxos where oka_id is not null`).map(r => [r.oka_id, r.id]));

    const passos = await supa(`select id, fluxo_id, ordem, atraso_minutos, base_atraso, conteudo, so_horario_comercial, data_hora_fixa, anexo_url, anexo_tipo, anexo_nome, anexo_mimetype from followup_passos`);
    const textoAtraso = (p: any) => p.ordem === 1 ? 'na hora' : p.base_atraso === 'proxima_leva' ? 'na próxima leva'
      : (p.atraso_minutos % 1440 === 0 ? (p.atraso_minutos / 1440) + ' dia(s) depois' : p.atraso_minutos + ' min depois');
    const tipoPasso = (t: string | null) => !t ? 'texto' : t === 'documento' || t === 'document' ? 'pdf' : t;
    await upsert('followup_passos', passos.filter((p: any) => fluxoPorOka.get(p.fluxo_id)).map((p: any) => ({
      oka_id: p.id, fluxo_id: fluxoPorOka.get(p.fluxo_id), ordem: p.ordem - 1, tipo: tipoPasso(p.anexo_tipo),
      conteudo: p.conteudo ?? '', anexo_url: p.anexo_url, anexo_nome: p.anexo_nome, anexo_tipo: p.anexo_tipo, anexo_mimetype: p.anexo_mimetype,
      base_atraso: p.base_atraso || 'passo_anterior', atraso_minutos: p.atraso_minutos ?? 0, atraso_texto: textoAtraso(p),
      so_horario_comercial: !!p.so_horario_comercial, data_hora_fixa: ts(p.data_hora_fixa),
    })), ['fluxo_id', 'ordem', 'tipo', 'conteudo', 'anexo_url', 'anexo_nome', 'anexo_tipo', 'anexo_mimetype', 'base_atraso', 'atraso_minutos', 'atraso_texto', 'so_horario_comercial', 'data_hora_fixa']);

    const execs = await supaTudo(`lead_id, fluxo_id, corretor_id, passo_atual, proximo_envio_em, status, finalizado_em, motivo_parada, iniciado_por, tentativas_erro`, 'followup_execucoes', 'inscrito_em');
    // A v2 só deixa um robô "vivo" (ativo/pausado) por lead: só o mais recente de cada lead pode ficar
    // vivo; os anteriores (pausados antigos na v1) entram encerrados. Lead que já tem robô criado na
    // própria v2 também não ganha outro vivo.
    const ultimoPorLead = new Map<string, string>();
    for (const e of execs as any[]) ultimoPorLead.set(e.lead_id, e.__id); // execs vem em ordem de início
    const vivosV2 = new Set((await sql<{ lead_id: string }[]>`select lead_id from followup_execucoes where oka_id is null and status <> 'encerrada'`).map(r => r.lead_id));
    const statusV2 = (e: any) => {
      const s = e.status as string;
      const vivo = s === 'ativo' || s === 'pausado_corretor' || s === 'erro';
      if (!vivo || ultimoPorLead.get(e.lead_id) !== e.__id || vivosV2.has(leadId(e.lead_id)!)) return 'encerrada';
      return s === 'ativo' && virada ? 'ativa' : 'pausada';
    };
    await upsert('followup_execucoes', execs.filter((e: any) => leadId(e.lead_id) && fluxoPorOka.get(e.fluxo_id)).map((e: any) => ({
      oka_id: e.__id, imobiliaria_id: imobiliariaId, lead_id: leadId(e.lead_id), fluxo_id: fluxoPorOka.get(e.fluxo_id),
      corretor_id: perfilId(e.corretor_id), passo_atual: e.passo_atual ?? 0, status: statusV2(e),
      resultado: e.status === 'ativo' ? (virada ? null : 'aguardando_virada') : e.status,
      motivo_fim: e.status === 'ativo' && !virada ? 'importado da v1 — liga na virada' : e.motivo_parada,
      proximo_envio_em: e.status === 'ativo' ? ts(e.proximo_envio_em) : null, iniciado_em: ts(e.__ord),
      finalizado_em: ts(e.finalizado_em), iniciado_por: e.iniciado_por || 'manual', tentativas_erro: e.tentativas_erro ?? 0,
    })), ['status', 'resultado', 'motivo_fim', 'proximo_envio_em', 'passo_atual', 'finalizado_em', 'tentativas_erro']);
    const execPorOka = new Map((await sql<{ id: string; oka_id: string }[]>`select id, oka_id from followup_execucoes where oka_id is not null`).map(r => [r.oka_id, r.id]));

    await porPagina(`execucao_id, passo_ordem, conteudo_enviado, whatsapp_message_id, respondeu_apos`, 'followup_envios', 'enviado_em', async envios => upsert('followup_envios', envios.filter((v: any) => execPorOka.get(v.execucao_id)).map((v: any) => ({
      oka_id: v.__id, execucao_id: execPorOka.get(v.execucao_id), passo_ordem: v.passo_ordem, conteudo_enviado: v.conteudo_enviado,
      wa_message_id: v.whatsapp_message_id, respondeu_apos: !!v.respondeu_apos, enviado_em: ts(v.__ord),
    })), ['respondeu_apos']));

    if (virada) {
      const [imobV1] = await supa(`select followup_automatico_ativo from imobiliarias limit 1`);
      await sql`update imobiliarias set followup_automatico_ativo = ${!!imobV1?.followup_automatico_ativo} where id = ${imobiliariaId}`;
      console.log('    follow-up automático da imobiliária:', !!imobV1?.followup_automatico_ativo ? 'LIGADO' : 'desligado');
    }
  }

  const [tot] = await sql`select (select count(*) from leads)::int leads, (select count(*) from mensagens_whatsapp)::int mensagens,
    (select count(*) from eventos_lead)::int eventos, (select count(*) from tarefas)::int tarefas, (select count(*) from perfis)::int perfis,
    (select count(*) from templates_mensagem)::int mensagens_prontas, (select count(*) from followup_fluxos)::int fluxos,
    (select count(*) from followup_passos)::int passos, (select count(*) from followup_execucoes)::int execucoes_followup,
    (select count(*) from imoveis)::int imoveis, (select count(*) from links_uteis)::int links, (select count(*) from treinamentos)::int treinamentos`;
  console.log('Pronto:', tot);
}

main()
  .catch(err => { console.error(err); process.exitCode = 1; })
  .finally(() => sql.end());
