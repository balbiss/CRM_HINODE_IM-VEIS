import { Router } from 'express';
import { z } from 'zod';
import { and, eq, sql, type SQL } from 'drizzle-orm';
import { db } from '../db/client.js';
import { colunasKanban, gastosCampanha, campanhas } from '../db/schema.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { lerFiltro, condLead, condPorLead, origem, type FiltroRel } from '../lib/filtroRelatorio.js';

/** Tela Relatórios — todos os blocos da v1 (CRM OKA), com os mesmos filtros (mês ou intervalo, cidade,
 *  corretor, campanhas): cartões, funil completo clicável, leads novos (renda e status), temperatura,
 *  status do funil, volume por origem, ranking de consultores, relatório de campanhas (CAC, aprovação
 *  de crédito), follow-up, motivos de devolução, horários e rebatidas do dia.
 *  Venda conta pelo mês em que fechou (data_fechamento), não pelo mês em que o lead chegou. */
const ETAPAS: [string, string][] = [
  ['novo', 'Novos'], ['rebatida', 'Rebatidas'], ['visita', 'Agendado'], ['visitou', 'Visitou'], ['cobrar_doc', 'Cobrar Doc'],
  ['pendente', 'Pendente'], ['credito', 'Análise de Crédito'], ['restricao', 'Restrição'], ['aprovado', 'Aprovado'], ['fid', 'FID'],
];
const RUINS = ['Sem Interesse (Renda Baixa)', 'Descadastrar (Outra Região)', 'Descadastrar (Número Errado)', 'Contato Errado', 'Descadastrar (Idoso)'];
const EXTREMO = '^(Descadastrar|Já Comprou|Contato Errado)';
const dataRe = /^\d{4}-\d{2}-\d{2}$/;
const consulta = z.object({ de: z.string().regex(dataRe), ate: z.string().regex(dataRe), corretorId: z.string().uuid().optional() });

type Col = { id: string; slug: string | null; titulo: string; ordem: number };
type Ctx = { I: string; de: string; ate: string; corretor: string | null; F: FiltroRel; cols: Col[] };

/** Lê período + filtros. Corretor só vê os próprios números. */
async function contexto(req: any, res: any): Promise<Ctx | null> {
  const p = consulta.safeParse(req.query);
  if (!p.success) { res.status(400).json({ error: 'Informe de e ate (AAAA-MM-DD)' }); return null; }
  if (p.data.ate < p.data.de) { res.status(400).json({ error: 'A data final é antes da inicial' }); return null; }
  const { imobiliariaId, role, sub } = req.auth!;
  const de = new Date(p.data.de + 'T00:00:00-03:00').toISOString();
  const ate = new Date(new Date(p.data.ate + 'T00:00:00-03:00').getTime() + 86400000).toISOString();
  const cols = await db.select({ id: colunasKanban.id, slug: colunasKanban.slug, titulo: colunasKanban.titulo, ordem: colunasKanban.ordem })
    .from(colunasKanban).where(eq(colunasKanban.imobiliariaId, imobiliariaId)).orderBy(colunasKanban.ordem);
  return { I: imobiliariaId, de, ate, corretor: role === 'corretor' ? sub : p.data.corretorId ?? null, F: lerFiltro(req.query), cols };
}

/** "Está ou já passou pela coluna": coluna atual, histórico da v2 (lead_etapas) ou evento da v1. */
const passouCol = (c: Col) => sql`(l.coluna_id = ${c.id}
  or exists (select 1 from lead_etapas le where le.lead_id = l.id and le.coluna_id = ${c.id})
  or exists (select 1 from eventos_lead e where e.lead_id = l.id and e.tipo in ('coluna','oka_auto','oka_status') and e.descricao ilike ${'%"' + c.titulo + '"%'}))`;

export function relatoriosOkaRouter() {
  const router = Router();
  router.use(requireAuth);

  // opções dos filtros: cidades (sem repetir por acento/maiúscula) e origens/campanhas
  router.get('/filtros', async (req, res) => {
    const { imobiliariaId, role, sub } = req.auth!;
    const esc = role === 'corretor' ? sql`and l.corretor_id = ${sub}` : sql``;
    const cid = await db.execute(sql`select btrim(l.bairro_interesse) as b, count(*)::int as n from leads l
      where l.imobiliaria_id = ${imobiliariaId} and btrim(coalesce(l.bairro_interesse, '')) <> '' ${esc} group by 1`) as any[];
    const norm = (t: string) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase().replace(/\s+/g, ' ');
    const melhor = new Map<string, { b: string; n: number }>();
    for (const r of cid) { const k = norm(r.b); const m = melhor.get(k); if (!m || r.n > m.n) melhor.set(k, { b: r.b, n: r.n }); }
    const camp = await db.execute(sql`select distinct ${origem('l')} as o from leads l where l.imobiliaria_id = ${imobiliariaId} ${esc} order by 1`) as any[];
    res.json({
      cidades: [...melhor.values()].map(x => x.b).sort((a, b) => a.localeCompare(b, 'pt-BR')),
      campanhas: camp.map(c => String(c.o ?? '')).filter(Boolean),
    });
  });

  router.get('/', async (req, res) => {
    const ctx = await contexto(req, res);
    if (!ctx) return;
    const { I, de, ate, corretor, F, cols } = ctx;
    const semCamp: FiltroRel = { ...F, campanhas: [] };
    const base = sql`l.imobiliaria_id = ${I} and l.importacao_pendente = false`;
    const noPeriodo = sql`l.criado_em >= ${de}::timestamptz and l.criado_em < ${ate}::timestamptz`;
    const fCorr = corretor ? sql`and l.corretor_id = ${corretor}` : sql``;
    const fLead = sql`${fCorr} ${condLead('l', F)}`;
    const fecho = sql`l.data_fechamento >= ${de}::timestamptz and l.data_fechamento < ${ate}::timestamptz and l.venda_pendente_aprovacao = false`;
    const passou = (slug: string) => { const c = cols.find(x => x.slug === slug); return c ? passouCol(c) : sql`false`; };
    const ehCampanha = sql`(btrim(coalesce(l.campanha, '')) <> '' and btrim(l.campanha) !~* '^(whatsapp|manual|site|importa)')`;
    const ehWhats = sql`(${origem('l')} ilike 'whatsapp%')`;

    // 1) cartões + leads novos (renda) + temperatura — tudo sobre os leads que chegaram no período
    const [resumo] = await db.execute(sql`
      select count(*)::int as leads,
        count(*) filter (where ${ehCampanha})::int as campanha,
        count(*) filter (where not ${ehCampanha} and ${ehWhats})::int as whatsapp,
        round((avg(extract(epoch from (l.primeiro_contato_em - l.criado_em)) / 60) filter (where l.primeiro_contato_em > l.criado_em))::numeric, 0)::float as sla_min,
        count(*) filter (where l.primeiro_contato_em is not null)::int as responderam,
        round((avg(l.renda_declarada) filter (where l.renda_declarada > 0))::numeric, 0)::float as renda_media,
        count(*) filter (where l.renda_declarada > 0)::int as com_renda,
        count(*) filter (where l.descartado_em is not null and not (coalesce(l.motivo_descarte, '') ~ ${EXTREMO}))::int as descartados,
        count(*) filter (where l.descartado_em is not null and coalesce(l.motivo_descarte, '') ~ ${EXTREMO})::int as descadastrados,
        count(*) filter (where l.temperatura = 'quente')::int as quente,
        count(*) filter (where l.temperatura = 'morno')::int as morno,
        count(*) filter (where l.temperatura = 'frio')::int as frio
      from leads l where ${base} and ${noPeriodo} ${fLead}`) as any[];
    const [vendasTot] = await db.execute(sql`select count(*)::int as n, coalesce(sum(coalesce(l.valor_venda, l.valor)), 0)::float as vgv
      from leads l where ${base} and ${fecho} ${fLead}`) as any[];

    // 2) funil completo: todas as colunas do Kanban ("está ou já passou") + venda do período
    const funilQ = cols.length
      ? (await db.execute(sql`select ${sql.join(cols.map((c, i) => sql`count(*) filter (where ${passouCol(c)})::int as ${sql.raw('c' + i)}`), sql`, `)}
          from leads l where ${base} and ${noPeriodo} ${fLead}`) as any[])[0]
      : {};
    const funil = cols.map((c, i) => ({ colunaId: c.id, titulo: c.titulo, slug: c.slug, n: Number(funilQ?.['c' + i] ?? 0) }));

    // 3) leads do período por etapa ATUAL (renda e status) — também alimenta "Status do funil"
    const porEtapa = await db.execute(sql`
      select c.id as coluna_id, coalesce(c.titulo, 'Sem coluna') as titulo, count(*)::int as total,
        count(*) filter (where l.primeiro_contato_em is not null)::int as responderam,
        round((avg(l.renda_declarada) filter (where l.renda_declarada > 0))::numeric, 0)::float as renda_media
      from leads l left join colunas_kanban c on c.id = l.coluna_id
      where ${base} and ${noPeriodo} ${fLead} group by c.id, c.titulo, c.ordem order by 3 desc`);

    // 4) volume por origem (campanha ou, sem campanha, o canal)
    const origens = await db.execute(sql`select ${origem('l')} as origem, count(*)::int as n from leads l
      where ${base} and ${noPeriodo} ${fLead} group by 1 order by 2 desc limit 15`);

    // 5) Ranking de Consultores = o que cada corretor FEZ no período (pedido do dono, 11/2026): na v1 o
    // ranking só olhava leads que chegaram no período e na coluna em que estão hoje, então rebatida
    // puxada (lead antigo) e etapa de lead de mês anterior nunca contavam — tudo zerado.
    // Etapas: histórico gravado pelo banco (lead_etapas) + eventos da v1 importada (corretor = quem
    // tinha o lead naquela hora). Rebatidas = entrou na REBATIDA com o corretor ou puxou do bolsão.
    const rankingQ = await db.execute(sql`
      with mov as (
        select le.lead_id, le.corretor_id, c.slug from lead_etapas le join colunas_kanban c on c.id = le.coluna_id
        where le.imobiliaria_id = ${I} and le.corretor_id is not null
          and le.criado_em >= ${de}::timestamptz and le.criado_em < ${ate}::timestamptz ${condPorLead('le.lead_id', F)}
        union
        select e.lead_id, coalesce((select d.corretor_id from distribuicao_log d where d.lead_id = e.lead_id and d.criado_em <= e.criado_em
                                    order by d.criado_em desc limit 1), l.corretor_id), c.slug
        from eventos_lead e join leads l on l.id = e.lead_id
          join colunas_kanban c on c.imobiliaria_id = e.imobiliaria_id and c.slug is not null and e.descricao ilike '%"' || c.titulo || '"%'
        where e.imobiliaria_id = ${I} and e.oka_id is not null and e.tipo in ('coluna','oka_auto','oka_status')
          and e.criado_em >= ${de}::timestamptz and e.criado_em < ${ate}::timestamptz ${condLead('l', F)}
        union
        select d.lead_id, d.corretor_id, 'rebatida' from distribuicao_log d
        where d.imobiliaria_id = ${I} and d.origem ilike '%rebatida%'
          and d.criado_em >= ${de}::timestamptz and d.criado_em < ${ate}::timestamptz ${condPorLead('d.lead_id', F)}
      ),
      recebidos as (
        select d.lead_id, d.corretor_id from distribuicao_log d
        where d.imobiliaria_id = ${I} and d.criado_em >= ${de}::timestamptz and d.criado_em < ${ate}::timestamptz ${condPorLead('d.lead_id', F)}
        union select lead_id, corretor_id from mov where slug = 'novo'
      ),
      desc_ as (
        select d.usuario_id as corretor_id, d.lead_id, coalesce(d.motivo, '') ~ ${EXTREMO} as extremo
        from descartes_leads d
        where d.imobiliaria_id = ${I} and d.usuario_id is not null
          and d.criado_em >= ${de}::timestamptz and d.criado_em < ${ate}::timestamptz ${condPorLead('d.lead_id', F)}
      ),
      quem as (
        select id as corretor_id from perfis where imobiliaria_id = ${I} and role = 'corretor' and removido_em is null and not bloqueado
        union select corretor_id from mov where corretor_id is not null
        union select corretor_id from recebidos
        union select corretor_id from desc_
      )
      select q.corretor_id, p.nome,
        (select count(distinct r.lead_id) from recebidos r where r.corretor_id = q.corretor_id)::int as recebidos,
        ${sql.join(ETAPAS.map(([s]) => sql`(select count(distinct m.lead_id) from mov m where m.corretor_id = q.corretor_id and m.slug = ${s})::int as ${sql.raw('"' + s + '"')}`), sql`, `)},
        (select count(distinct x.lead_id) from desc_ x where x.corretor_id = q.corretor_id and not x.extremo)::int as descarte,
        (select count(distinct x.lead_id) from desc_ x where x.corretor_id = q.corretor_id and x.extremo)::int as descadastrado
      from quem q join perfis p on p.id = q.corretor_id
      where true ${corretor ? sql`and q.corretor_id = ${corretor}` : sql``}
      order by 3 desc, 2`);
    const vendasQ = await db.execute(sql`
      select l.corretor_id, count(*)::int as vendas, coalesce(sum(coalesce(l.valor_venda, l.valor)), 0)::float as vgv
      from leads l where ${base} and ${fecho} ${fLead} group by 1`);
    const slaQ = await db.execute(sql`
      select l.corretor_id, round(avg(extract(epoch from (l.primeiro_contato_em - l.data_atribuicao)) / 60)::numeric, 1)::float as sla_min
      from leads l where ${base} and l.data_atribuicao >= ${de}::timestamptz and l.data_atribuicao < ${ate}::timestamptz
        and l.primeiro_contato_em is not null and l.primeiro_contato_em > l.data_atribuicao ${fLead} group by 1`);
    const vendas = new Map((vendasQ as any[]).map(v => [v.corretor_id, v]));
    const sla = new Map((slaQ as any[]).map(v => [v.corretor_id, v.sla_min]));
    const ranking = (rankingQ as any[]).map(r => ({ ...r, vendas: vendas.get(r.corretor_id)?.vendas ?? 0, vgv: vendas.get(r.corretor_id)?.vgv ?? 0, slaMin: sla.get(r.corretor_id) ?? null }));

    // 6) Relatório de Campanhas: compara TODAS (o filtro de campanha não vale aqui, igual à v1)
    const fSemCamp = sql`${fCorr} ${condLead('l', semCamp)}`;
    const campQ = await db.execute(sql`
      select ${origem('l')} as campanha, count(*)::int as leads,
        count(*) filter (where exists (select 1 from mensagens_whatsapp m where m.lead_id = l.id and m.direcao = 'in'))::int as responderam,
        count(*) filter (where ${passou('visita')})::int as agendado,
        count(*) filter (where ${passou('visitou')})::int as visitou,
        count(*) filter (where ${passou('credito')})::int as credito,
        count(*) filter (where ${passou('restricao')})::int as restricao,
        count(*) filter (where l.descartado_em is not null and coalesce(l.motivo_descarte, '') ~ ${EXTREMO})::int as descadastrado,
        count(*) filter (where l.motivo_descarte in (${sql.join(RUINS.map(r => sql`${r}`), sql`, `)}))::int as ruins
      from leads l where ${base} and ${noPeriodo} ${fSemCamp}
      group by 1 order by 2 desc limit 80`) as any[];
    const vendasCampQ = await db.execute(sql`select ${origem('l')} as campanha, count(*)::int as n from leads l
      where ${base} and ${fecho} ${fSemCamp} group by 1`) as any[];
    const vendasCamp = new Map(vendasCampQ.map(v => [String(v.campanha), Number(v.n)]));
    // gasto é lançado por mês: soma os meses que o período cobre
    const mesIni = new Date(new Date(de).getTime() - 3 * 3600e3).toISOString().slice(0, 7);
    const mesFim = new Date(new Date(ate).getTime() - 3 * 3600e3 - 1).toISOString().slice(0, 7);
    const gastos = await db.select().from(gastosCampanha).where(and(eq(gastosCampanha.imobiliariaId, I), sql`${gastosCampanha.mes} between ${mesIni} and ${mesFim}`));
    const gastoPor = new Map<string, number>();
    for (const g of gastos) gastoPor.set(g.origem, (gastoPor.get(g.origem) ?? 0) + Number(g.valor));
    const vazio = { leads: 0, responderam: 0, agendado: 0, visitou: 0, credito: 0, restricao: 0, descadastrado: 0, ruins: 0 };
    const nomesCamp = new Set([...campQ.map(c => String(c.campanha)), ...vendasCamp.keys()]);
    const campanhasRel = [...nomesCamp].map(nome => {
      const c = campQ.find(x => String(x.campanha) === nome) ?? vazio;
      const v = vendasCamp.get(nome) ?? 0;
      const gasto = gastoPor.get(nome) ?? null;
      return {
        ...c, campanha: nome, vendas: v, gasto,
        taxaAprovacaoCredito: c.credito ? ((c.credito - c.restricao) / c.credito) * 100 : null,
        custoPorLead: gasto && c.leads ? gasto / c.leads : null, cac: gasto && v ? gasto / v : null,
      };
    }).sort((a, b) => b.leads - a.leads || b.vendas - a.vendas);

    // 7) devoluções, horários, follow-up, rebatidas do dia
    const fDesc = sql`${corretor ? sql`and d.usuario_id = ${corretor}` : sql``} ${condPorLead('d.lead_id', F)}`;
    const motivosQ = await db.execute(sql`select coalesce(d.motivo, '—') as motivo, count(*)::int as n from descartes_leads d
      where d.imobiliaria_id = ${I} and d.criado_em >= ${de}::timestamptz and d.criado_em < ${ate}::timestamptz ${fDesc}
      group by 1 order by 2 desc limit 20`);
    const horasQ = await db.execute(sql`select extract(hour from l.criado_em at time zone 'America/Sao_Paulo')::int as hora, count(*)::int as n
      from leads l where ${base} and ${noPeriodo} ${fLead} group by 1 order by 1`);
    const fFup = sql`${corretor ? sql`and e.corretor_id = ${corretor}` : sql``} ${condPorLead('e.lead_id', F)}`;
    const followQ = await db.execute(sql`
      select coalesce(p.nome, '—') as corretor, e.corretor_id, count(*)::int as entraram,
        count(*) filter (where e.resultado = 'respondeu')::int as responderam,
        count(*) filter (where e.resultado = 'pausado_corretor')::int as corretor_parou,
        count(*) filter (where e.status = 'ativa')::int as rodando
      from followup_execucoes e left join perfis p on p.id = e.corretor_id
      where e.imobiliaria_id = ${I} and e.iniciado_em >= ${de}::timestamptz and e.iniciado_em < ${ate}::timestamptz ${fFup}
      group by 1, 2 order by 3 desc`);
    const passoQ = await db.execute(sql`select v.passo_ordem as passo, count(*)::int as n from followup_envios v
      join followup_execucoes e on e.id = v.execucao_id where e.imobiliaria_id = ${I} and v.respondeu_apos
        and v.enviado_em >= ${de}::timestamptz and v.enviado_em < ${ate}::timestamptz ${fFup} group by 1 order by 1`);
    const rebatidasHojeQ = await db.execute(sql`select coalesce(p.nome, '—') as corretor, count(*)::int as n from descartes_leads d
      left join perfis p on p.id = d.usuario_id where d.imobiliaria_id = ${I}
        and d.criado_em >= (date_trunc('day', now() at time zone 'America/Sao_Paulo') at time zone 'America/Sao_Paulo')
        and not (d.motivo ~ ${EXTREMO}) ${fDesc} group by 1 order by 2 desc`);

    const r = resumo ?? {};
    res.json({
      resumo: {
        leads: r.leads ?? 0, campanha: r.campanha ?? 0, whatsapp: r.whatsapp ?? 0,
        outros: Math.max(0, (r.leads ?? 0) - (r.campanha ?? 0) - (r.whatsapp ?? 0)),
        slaMin: r.sla_min ?? null, vendas: vendasTot?.n ?? 0, vgv: vendasTot?.vgv ?? 0,
      },
      novos: {
        total: r.leads ?? 0, responderam: r.responderam ?? 0, rendaMedia: r.renda_media ?? null, comRenda: r.com_renda ?? 0,
        descartados: r.descartados ?? 0, descadastrados: r.descadastrados ?? 0, porEtapa,
      },
      temperatura: { quente: r.quente ?? 0, morno: r.morno ?? 0, frio: r.frio ?? 0 },
      origens,
      etapas: ETAPAS.map(([slug, nome]) => ({ slug, nome })),
      funil, ranking, campanhas: campanhasRel, motivos: motivosQ, horas: horasQ,
      followup: { porCorretor: followQ, respostaPorPasso: passoQ }, rebatidasHoje: rebatidasHojeQ,
    });
  });

  // Clicar numa barra do funil / fatia do status: lista os leads (pra abrir o card).
  // modo 'passou' = está ou já passou pela coluna (funil); 'atual' = está nela agora (status);
  // coluna 'venda' = vendas fechadas no período; 'sem' = leads sem coluna.
  router.get('/leads', async (req, res) => {
    const ctx = await contexto(req, res);
    if (!ctx) return;
    const { I, de, ate, corretor, F, cols } = ctx;
    const coluna = String(req.query.coluna ?? '');
    const modo = req.query.modo === 'atual' ? 'atual' : 'passou';
    const base = sql`l.imobiliaria_id = ${I} and l.importacao_pendente = false ${corretor ? sql`and l.corretor_id = ${corretor}` : sql``} ${condLead('l', F)}`;
    const noPeriodo = sql`l.criado_em >= ${de}::timestamptz and l.criado_em < ${ate}::timestamptz`;
    let cond: SQL;
    if (coluna === 'venda') {
      cond = sql`l.data_fechamento >= ${de}::timestamptz and l.data_fechamento < ${ate}::timestamptz and l.venda_pendente_aprovacao = false`;
    } else if (coluna === 'sem') {
      cond = sql`${noPeriodo} and l.coluna_id is null`;
    } else {
      const c = cols.find(x => x.id === coluna);
      if (!c) return res.status(400).json({ error: 'Coluna inválida' });
      cond = sql`${noPeriodo} and ${modo === 'atual' ? sql`l.coluna_id = ${c.id}` : passouCol(c)}`;
    }
    const rows = await db.execute(sql`select l.id, l.nome, l.telefone, p.nome as corretor from leads l left join perfis p on p.id = l.corretor_id
      where ${base} and ${cond} order by l.criado_em desc limit 500`);
    res.json(rows);
  });

  // gasto da campanha no mês (base do CAC e do custo por lead) — dono/gerente
  router.put('/gastos', requireRole('dono', 'gerente'), async (req, res) => {
    const p = z.object({ origem: z.string().min(1), mes: z.string().regex(/^\d{4}-\d{2}$/), valor: z.number().min(0) }).safeParse(req.body);
    if (!p.success) return res.status(400).json({ error: 'Dados inválidos' });
    const { imobiliariaId, sub } = req.auth!;
    await db.insert(gastosCampanha).values({ imobiliariaId, origem: p.data.origem, mes: p.data.mes, valor: String(p.data.valor), atualizadoPor: sub })
      .onConflictDoUpdate({ target: [gastosCampanha.imobiliariaId, gastosCampanha.origem, gastosCampanha.mes], set: { valor: String(p.data.valor), atualizadoPor: sub } });
    res.json({ ok: true });
  });

  // Tela Campanhas: cada anúncio que já trouxe lead, com o criativo (link do Drive)
  router.get('/campanhas', async (req, res) => {
    const { imobiliariaId } = req.auth!;
    const rows = await db.execute(sql`
      with agg as (
        select campanha as nome, count(*)::int as total,
          count(*) filter (where criado_em >= now() - interval '7 days')::int as ult7,
          count(*) filter (where criado_em >= now() - interval '30 days')::int as ult30, max(criado_em) as ultimo
        from leads where imobiliaria_id = ${imobiliariaId} and campanha is not null and btrim(campanha) <> '' group by 1)
      select coalesce(a.nome, c.nome) as nome, coalesce(a.total, 0) as total, coalesce(a.ult7, 0) as ult7, coalesce(a.ult30, 0) as ult30,
        a.ultimo, c.drive_url as "driveUrl", c.observacao, c.id
      from agg a full outer join campanhas c on c.nome = a.nome and c.imobiliaria_id = ${imobiliariaId}
      where c.imobiliaria_id = ${imobiliariaId} or c.id is null
      order by a.ultimo desc nulls last`);
    res.json(rows);
  });
  router.put('/campanhas', requireRole('dono', 'gerente'), async (req, res) => {
    const p = z.object({ nome: z.string().trim().min(1), driveUrl: z.string().nullable().optional(), observacao: z.string().nullable().optional() }).safeParse(req.body);
    if (!p.success) return res.status(400).json({ error: 'Nome obrigatório' });
    const { imobiliariaId } = req.auth!;
    await db.insert(campanhas).values({ imobiliariaId, nome: p.data.nome, driveUrl: p.data.driveUrl ?? null, observacao: p.data.observacao ?? null })
      .onConflictDoUpdate({ target: [campanhas.imobiliariaId, campanhas.nome], set: { driveUrl: p.data.driveUrl ?? null, observacao: p.data.observacao ?? null } });
    res.json({ ok: true });
  });

  return router;
}
