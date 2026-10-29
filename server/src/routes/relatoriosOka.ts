import { Router } from 'express';
import { z } from 'zod';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { colunasKanban, gastosCampanha, campanhas } from '../db/schema.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

/** Números da v1 (CRM OKA): funil "está ou já passou pela coluna", ranking por corretor, campanhas com
 *  CAC, follow-up, motivos de devolução, horários e rebatidas. Venda conta pelo mês em que fechou. */
const ETAPAS: [string, string][] = [
  ['novo', 'Novos'], ['rebatida', 'Rebatidas'], ['visita', 'Agendado'], ['visitou', 'Visitou'], ['cobrar_doc', 'Cobrar Doc'],
  ['pendente', 'Pendente'], ['credito', 'Análise de Crédito'], ['restricao', 'Restrição'], ['aprovado', 'Aprovado'], ['fid', 'FID'],
];
const RUINS = ['Sem Interesse (Renda Baixa)', 'Descadastrar (Outra Região)', 'Descadastrar (Número Errado)', 'Contato Errado', 'Descadastrar (Idoso)'];

export function relatoriosOkaRouter() {
  const router = Router();
  router.use(requireAuth);

  router.get('/', async (req, res) => {
    const p = z.object({ de: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), ate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), corretorId: z.string().uuid().optional() }).safeParse(req.query);
    if (!p.success) return res.status(400).json({ error: 'Informe de e ate (AAAA-MM-DD)' });
    const { imobiliariaId, role, sub } = req.auth!;
    const corretor = role === 'corretor' ? sub : p.data.corretorId ?? null;
    const de = new Date(p.data.de + 'T00:00:00-03:00').toISOString();
    const ate = new Date(new Date(p.data.ate + 'T00:00:00-03:00').getTime() + 86400000).toISOString();
    const fCorr = corretor ? sql`and l.corretor_id = ${corretor}` : sql``;
    const cols = await db.select({ id: colunasKanban.id, slug: colunasKanban.slug, titulo: colunasKanban.titulo }).from(colunasKanban).where(eq(colunasKanban.imobiliariaId, imobiliariaId));

    // "está ou já passou": coluna atual ou um evento de mudança de coluna citando o título da coluna
    const passou = (slug: string) => {
      const c = cols.find(x => x.slug === slug);
      if (!c) return sql`false`;
      return sql`(l.coluna_id = ${c.id} or exists (select 1 from eventos_lead e where e.lead_id = l.id and e.tipo in ('coluna','oka_auto','oka_status') and e.descricao ilike ${'%"' + c.titulo + '"%'}))`;
    };
    const somas = ETAPAS.map(([slug]) => sql`count(*) filter (where ${passou(slug)})::int as ${sql.raw('"' + slug + '"')}`);

    const rankingQ = await db.execute(sql`
      select l.corretor_id, p.nome, count(*)::int as recebidos, ${sql.join(somas, sql`, `)},
        count(*) filter (where l.descartado_em is not null and not (coalesce(l.motivo_descarte,'') ~ '^(Descadastrar|Já Comprou|Contato Errado)'))::int as descarte,
        count(*) filter (where l.descartado_em is not null and coalesce(l.motivo_descarte,'') ~ '^(Descadastrar|Já Comprou|Contato Errado)')::int as descadastrado
      from leads l join perfis p on p.id = l.corretor_id
      where l.imobiliaria_id = ${imobiliariaId} and l.criado_em >= ${de}::timestamptz and l.criado_em < ${ate}::timestamptz ${fCorr}
      group by 1, 2 order by 3 desc`);
    const vendasQ = await db.execute(sql`
      select l.corretor_id, count(*)::int as vendas, coalesce(sum(coalesce(l.valor_venda, l.valor)), 0)::float as vgv
      from leads l where l.imobiliaria_id = ${imobiliariaId} and l.data_fechamento >= ${de}::timestamptz and l.data_fechamento < ${ate}::timestamptz
        and l.venda_pendente_aprovacao = false ${fCorr} group by 1`);
    const slaQ = await db.execute(sql`
      select l.corretor_id, round(avg(extract(epoch from (l.primeiro_contato_em - l.data_atribuicao)) / 60)::numeric, 1)::float as sla_min
      from leads l where l.imobiliaria_id = ${imobiliariaId} and l.data_atribuicao >= ${de}::timestamptz and l.data_atribuicao < ${ate}::timestamptz
        and l.primeiro_contato_em is not null and l.primeiro_contato_em > l.data_atribuicao ${fCorr} group by 1`);
    const vendas = new Map((vendasQ as any[]).map(v => [v.corretor_id, v]));
    const sla = new Map((slaQ as any[]).map(v => [v.corretor_id, v.sla_min]));
    const ranking = (rankingQ as any[]).map(r => ({ ...r, vendas: vendas.get(r.corretor_id)?.vendas ?? 0, vgv: vendas.get(r.corretor_id)?.vgv ?? 0, slaMin: sla.get(r.corretor_id) ?? null }));

    const funilQ = await db.execute(sql`select count(*)::int as total, ${sql.join(somas, sql`, `)} from leads l
      where l.imobiliaria_id = ${imobiliariaId} and l.criado_em >= ${de}::timestamptz and l.criado_em < ${ate}::timestamptz ${fCorr}`);

    const mesesQ = [p.data.de.slice(0, 7), p.data.ate.slice(0, 7)];
    const campQ = await db.execute(sql`
      select coalesce(l.campanha, '(sem campanha)') as campanha, count(*)::int as leads,
        count(*) filter (where exists (select 1 from mensagens_whatsapp m where m.lead_id = l.id and m.direcao = 'in'))::int as responderam,
        count(*) filter (where ${passou('credito')})::int as credito,
        count(*) filter (where l.data_fechamento is not null and l.venda_pendente_aprovacao = false)::int as vendas,
        count(*) filter (where l.motivo_descarte in (${sql.join(RUINS.map(r => sql`${r}`), sql`, `)}))::int as ruins
      from leads l where l.imobiliaria_id = ${imobiliariaId} and l.criado_em >= ${de}::timestamptz and l.criado_em < ${ate}::timestamptz ${fCorr}
      group by 1 order by 2 desc limit 60`);
    const gastos = await db.select().from(gastosCampanha).where(and(eq(gastosCampanha.imobiliariaId, imobiliariaId), sql`${gastosCampanha.mes} between ${mesesQ[0]} and ${mesesQ[1]}`));
    const gastoPor = new Map<string, number>();
    for (const g of gastos) gastoPor.set(g.origem, (gastoPor.get(g.origem) ?? 0) + Number(g.valor));
    const campanhasRel = (campQ as any[]).map(c => {
      const gasto = gastoPor.get(c.campanha) ?? null;
      return { ...c, gasto, custoPorLead: gasto && c.leads ? gasto / c.leads : null, cac: gasto && c.vendas ? gasto / c.vendas : null };
    });

    const motivosQ = await db.execute(sql`select coalesce(d.motivo, '—') as motivo, count(*)::int as n from descartes_leads d
      join leads l on l.id = d.lead_id where d.imobiliaria_id = ${imobiliariaId} and d.criado_em >= ${de}::timestamptz and d.criado_em < ${ate}::timestamptz ${fCorr}
      group by 1 order by 2 desc limit 20`);
    const horasQ = await db.execute(sql`select extract(hour from l.criado_em at time zone 'America/Sao_Paulo')::int as hora, count(*)::int as n
      from leads l where l.imobiliaria_id = ${imobiliariaId} and l.criado_em >= ${de}::timestamptz and l.criado_em < ${ate}::timestamptz ${fCorr} group by 1 order by 1`);
    const followQ = await db.execute(sql`
      select coalesce(p.nome, '—') as corretor, e.corretor_id, count(*)::int as entraram,
        count(*) filter (where e.resultado = 'respondeu')::int as responderam,
        count(*) filter (where e.resultado = 'pausado_corretor')::int as corretor_parou,
        count(*) filter (where e.status = 'ativa')::int as rodando
      from followup_execucoes e left join perfis p on p.id = e.corretor_id
      where e.imobiliaria_id = ${imobiliariaId} and e.iniciado_em >= ${de}::timestamptz and e.iniciado_em < ${ate}::timestamptz ${corretor ? sql`and e.corretor_id = ${corretor}` : sql``}
      group by 1, 2 order by 3 desc`);
    const passoQ = await db.execute(sql`select v.passo_ordem as passo, count(*)::int as n from followup_envios v
      join followup_execucoes e on e.id = v.execucao_id where e.imobiliaria_id = ${imobiliariaId} and v.respondeu_apos
        and v.enviado_em >= ${de}::timestamptz and v.enviado_em < ${ate}::timestamptz ${corretor ? sql`and e.corretor_id = ${corretor}` : sql``} group by 1 order by 1`);
    const rebatidasHojeQ = await db.execute(sql`select coalesce(p.nome, '—') as corretor, count(*)::int as n from descartes_leads d
      left join perfis p on p.id = d.usuario_id where d.imobiliaria_id = ${imobiliariaId}
        and d.criado_em >= (date_trunc('day', now() at time zone 'America/Sao_Paulo') at time zone 'America/Sao_Paulo')
        and not (d.motivo ~ '^(Descadastrar|Já Comprou|Contato Errado)') group by 1 order by 2 desc`);

    res.json({
      etapas: ETAPAS.map(([slug, nome]) => ({ slug, nome })),
      funil: (funilQ as any[])[0], ranking, campanhas: campanhasRel, motivos: motivosQ, horas: horasQ,
      followup: { porCorretor: followQ, respostaPorPasso: passoQ }, rebatidasHoje: rebatidasHojeQ,
    });
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
