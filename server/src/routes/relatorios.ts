import { Router } from 'express';
import { z } from 'zod';
import { and, eq, gte, inArray, lte, sql, type SQL } from 'drizzle-orm';
import { db } from '../db/client.js';
import { distribuicaoLog, leads, colunasKanban, perfis } from '../db/schema.js';
import { requireAuth } from '../middleware/auth.js';

/** Relatórios (tela Relatórios). Tudo calculado no período escolhido (datas no fuso de Brasília).
 *  Dono/gerente veem a imobiliária inteira; corretor vê só os próprios números. */

const TZ = 'America/Sao_Paulo';
const dataSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

type Linha = Record<string, unknown>;
const rows = async (q: SQL) => (await db.execute(q)) as unknown as Linha[];
const num = (v: unknown) => (v == null ? 0 : Number(v));
const numOuNull = (v: unknown) => (v == null ? null : Number(v));

export function relatoriosRouter() {
  const router = Router();
  router.use(requireAuth);

  router.get('/', async (req, res) => {
    const parsed = z.object({ de: dataSchema, ate: dataSchema }).safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: 'Período inválido (use de=AAAA-MM-DD&ate=AAAA-MM-DD)' });
    const { de, ate } = parsed.data;
    if (ate < de) return res.status(400).json({ error: 'A data final é antes da inicial' });
    const { imobiliariaId: I, role, sub, nome } = req.auth!;
    const corretor = role === 'corretor';

    // janela [ini, fim) e a janela anterior do mesmo tamanho (pra comparar)
    const ini = sql`((${de})::date)::timestamp at time zone ${TZ}`;
    const fim = sql`((${ate})::date + 1)::timestamp at time zone ${TZ}`;
    const dur = sql`(${fim} - ${ini})`;
    const iniAnt = sql`(${ini} - ${dur})`;

    // escopo do lead (corretor = só os dele) e lead guardado de planilha nunca conta
    const escLead = (a: string) => corretor
      ? sql.raw(`${a}.imobiliaria_id = '${I}' and ${a}.importacao_pendente = false and ${a}.corretor_id = '${sub}'`)
      : sql.raw(`${a}.imobiliaria_id = '${I}' and ${a}.importacao_pendente = false`);
    const escDist = corretor ? sql.raw(`and d.corretor_id = '${sub}'`) : sql.raw('');
    const escRec = corretor ? sql.raw(`and r.corretor_id = '${sub}'`) : sql.raw('');

    const [k] = await rows(sql`
      select
        (select count(*) from leads l where ${escLead('l')} and l.criado_em >= ${ini} and l.criado_em < ${fim}) as leads,
        (select count(*) from leads l where ${escLead('l')} and l.criado_em >= ${iniAnt} and l.criado_em < ${ini}) as leads_ant,
        (select count(*) from leads l join colunas_kanban c on c.id = l.coluna_id
           where ${escLead('l')} and c.slug = 'venda' and l.entrou_na_coluna_em >= ${ini} and l.entrou_na_coluna_em < ${fim}) as vendas,
        (select coalesce(sum(l.valor), 0) from leads l join colunas_kanban c on c.id = l.coluna_id
           where ${escLead('l')} and c.slug = 'venda' and l.entrou_na_coluna_em >= ${ini} and l.entrou_na_coluna_em < ${fim}) as vgv,
        (select count(*) from leads l join colunas_kanban c on c.id = l.coluna_id
           where ${escLead('l')} and c.slug = 'venda' and l.entrou_na_coluna_em >= ${iniAnt} and l.entrou_na_coluna_em < ${ini}) as vendas_ant,
        (select count(*) from eventos_lead e where e.imobiliaria_id = ${I} and e.tipo = 'descarte'
           and e.criado_em >= ${ini} and e.criado_em < ${fim} ${corretor ? sql`and e.ator_nome = ${nome}` : sql``}) as descartes,
        (select count(*) from distribuicao_log d where d.imobiliaria_id = ${I} and d.criado_em >= ${ini} and d.criado_em < ${fim} ${escDist}) as distribuidos,
        (select count(*) from recusas_lead r where r.imobiliaria_id = ${I} and r.criado_em >= ${ini} and r.criado_em < ${fim} and r.motivo = 'recusou' ${escRec}) as recusou,
        (select count(*) from recusas_lead r where r.imobiliaria_id = ${I} and r.criado_em >= ${ini} and r.criado_em < ${fim} and r.motivo = 'sem_resposta' ${escRec}) as sem_resposta
    `);

    // 1ª resposta do corretor: da hora em que o lead caiu pra ele até a 1ª mensagem dele no CRM
    const [resp] = await rows(sql`
      with d as (
        select d.lead_id, d.corretor_id, d.criado_em,
          (select min(m.enviado_em) from mensagens_whatsapp m
            where m.lead_id = d.lead_id and m.direcao = 'out' and m.canal = 'corretor' and m.enviado_em >= d.criado_em) as primeira
        from distribuicao_log d
        where d.imobiliaria_id = ${I} and d.criado_em >= ${ini} and d.criado_em < ${fim} ${escDist}
      )
      select
        percentile_cont(0.5) within group (order by extract(epoch from (primeira - criado_em)) / 60) filter (where primeira is not null) as mediana_min,
        count(*) filter (where primeira is not null) as respondidos,
        count(*) filter (where primeira is not null and primeira - criado_em <= interval '5 minutes') as em_5min,
        count(*) filter (where primeira is null) as sem_mensagem
      from d
    `);

    const porDia = await rows(sql`
      select to_char(g.dia, 'YYYY-MM-DD') as dia,
        (select count(*) from leads l where ${escLead('l')}
           and (l.criado_em at time zone ${TZ})::date = g.dia) as leads
      from generate_series((${de})::date, (${ate})::date, interval '1 day') as g(dia)
      order by g.dia
    `);

    const porHora = await rows(sql`
      select extract(hour from l.criado_em at time zone ${TZ})::int as hora, count(*) as leads
      from leads l where ${escLead('l')} and l.criado_em >= ${ini} and l.criado_em < ${fim}
      group by 1 order by 1
    `);

    const canais = await rows(sql`
      select l.canal::text as nome, count(*) as leads, count(*) filter (where c.slug = 'venda') as vendas
      from leads l left join colunas_kanban c on c.id = l.coluna_id
      where ${escLead('l')} and l.criado_em >= ${ini} and l.criado_em < ${fim}
      group by 1 order by 2 desc
    `);

    const campanhas = await rows(sql`
      select coalesce(nullif(trim(l.campanha), ''), 'Sem campanha') as nome, count(*) as leads,
        count(*) filter (where c.slug = 'venda') as vendas
      from leads l left join colunas_kanban c on c.id = l.coluna_id
      where ${escLead('l')} and l.criado_em >= ${ini} and l.criado_em < ${fim}
      group by 1 order by 2 desc limit 10
    `);

    // funil é foto de AGORA (onde os leads estão hoje), não do período
    const funil = await rows(sql`
      select c.titulo, c.slug, count(l.id) as leads
      from colunas_kanban c left join leads l on l.coluna_id = c.id and ${escLead('l')}
      where c.imobiliaria_id = ${I}
      group by c.id, c.titulo, c.slug, c.ordem order by c.ordem
    `);

    // motivo escolhido no descarte (sem a observação, que deixava cada descarte "único") + desqualificações do Agente de IA
    const motivos = await rows(sql`
      select motivo, count(*) as qtd from (
        select d.motivo from descartes_leads d left join perfis p on p.id = d.usuario_id
        where d.imobiliaria_id = ${I} and d.criado_em >= ${ini} and d.criado_em < ${fim}
          ${corretor ? sql`and p.nome = ${nome}` : sql``}
        union all
        select 'IA: ' || substring(e.descricao from 'desqualificou o lead: (.*?)( — |$)') from eventos_lead e
        where e.imobiliaria_id = ${I} and e.tipo = 'descarte' and e.descricao like '%desqualificou o lead:%'
          and e.criado_em >= ${ini} and e.criado_em < ${fim} ${corretor ? sql`and e.ator_nome = ${nome}` : sql``}
      ) x where motivo is not null
      group by 1 order by 2 desc limit 8
    `);

    const corretores = await rows(sql`
      select p.id, p.nome, p.bloqueado,
        (select count(*) from distribuicao_log d where d.corretor_id = p.id and d.criado_em >= ${ini} and d.criado_em < ${fim}) as recebidos,
        (select count(*) from recusas_lead r where r.corretor_id = p.id and r.motivo = 'recusou' and r.criado_em >= ${ini} and r.criado_em < ${fim}) as recusou,
        (select count(*) from recusas_lead r where r.corretor_id = p.id and r.motivo = 'sem_resposta' and r.criado_em >= ${ini} and r.criado_em < ${fim}) as sem_resposta,
        (select percentile_cont(0.5) within group (order by extract(epoch from (x.primeira - x.criado_em)) / 60)
           from (select d.criado_em, (select min(m.enviado_em) from mensagens_whatsapp m
                   where m.lead_id = d.lead_id and m.direcao = 'out' and m.canal = 'corretor' and m.enviado_em >= d.criado_em) as primeira
                 from distribuicao_log d where d.corretor_id = p.id and d.criado_em >= ${ini} and d.criado_em < ${fim}) x
           where x.primeira is not null) as resposta_min,
        (select count(*) from leads l left join colunas_kanban c on c.id = l.coluna_id
           where l.corretor_id = p.id and l.importacao_pendente = false and coalesce(c.slug, '') not in ('venda', 'rebatida')) as carteira,
        (select count(*) from leads l join colunas_kanban c on c.id = l.coluna_id
           where l.corretor_id = p.id and c.slug = 'venda' and l.entrou_na_coluna_em >= ${ini} and l.entrou_na_coluna_em < ${fim}) as vendas,
        (select coalesce(sum(l.valor), 0) from leads l join colunas_kanban c on c.id = l.coluna_id
           where l.corretor_id = p.id and c.slug = 'venda' and l.entrou_na_coluna_em >= ${ini} and l.entrou_na_coluna_em < ${fim}) as vgv
      from perfis p
      where p.imobiliaria_id = ${I} ${corretor ? sql`and p.id = ${sub}` : sql`and p.role in ('corretor', 'gerente')`}
    `);

    const recusas = await rows(sql`
      select r.criado_em, r.motivo, l.nome as lead, p.nome as corretor, para.nome as para
      from recusas_lead r
      join leads l on l.id = r.lead_id
      join perfis p on p.id = r.corretor_id
      left join perfis para on para.id = r.redistribuido_para_id
      where r.imobiliaria_id = ${I} and r.criado_em >= ${ini} and r.criado_em < ${fim} ${escRec}
      order by r.criado_em desc limit 30
    `);

    // Agente de IA: só aparece se a imobiliária usou no período
    const [ia] = corretor ? [null] : await rows(sql`
      select
        (select count(distinct t.lead_id) from ia_turnos t where t.imobiliaria_id = ${I} and t.criado_em >= ${ini} and t.criado_em < ${fim}) as atendidos,
        (select count(*) from leads l where ${escLead('l')} and l.ia_status = 'transferido' and l.criado_em >= ${ini} and l.criado_em < ${fim}) as transferidos,
        (select count(*) from eventos_lead e where e.imobiliaria_id = ${I} and e.tipo = 'descarte' and e.ator_nome = 'Agente de IA'
           and e.criado_em >= ${ini} and e.criado_em < ${fim}) as desqualificados,
        (select count(*) from leads l where ${escLead('l')} and l.ia_status = 'atendendo') as atendendo_agora
    `);

    res.json({
      periodo: { de, ate },
      kpis: {
        leads: num(k.leads), leadsAnterior: num(k.leads_ant),
        vendas: num(k.vendas), vendasAnterior: num(k.vendas_ant), vgv: num(k.vgv),
        descartes: num(k.descartes), distribuidos: num(k.distribuidos),
        recusou: num(k.recusou), semResposta: num(k.sem_resposta),
        respostaMedianaMin: numOuNull(resp?.mediana_min), respondidos: num(resp?.respondidos),
        respondidosEm5min: num(resp?.em_5min), semMensagemNoCrm: num(resp?.sem_mensagem),
      },
      porDia: porDia.map(r => ({ dia: String(r.dia), leads: num(r.leads) })),
      porHora: Array.from({ length: 24 }, (_, h) => ({ hora: h, leads: num(porHora.find(r => num(r.hora) === h)?.leads) })),
      canais: canais.map(r => ({ nome: String(r.nome), leads: num(r.leads), vendas: num(r.vendas) })),
      campanhas: campanhas.map(r => ({ nome: String(r.nome), leads: num(r.leads), vendas: num(r.vendas) })),
      funil: funil.map(r => ({ titulo: String(r.titulo), slug: String(r.slug ?? ''), leads: num(r.leads) })),
      motivosDescarte: motivos.map(r => ({ motivo: String(r.motivo), qtd: num(r.qtd) })),
      corretores: corretores.map(r => ({
        id: String(r.id), nome: String(r.nome), bloqueado: !!r.bloqueado,
        recebidos: num(r.recebidos), recusou: num(r.recusou), semResposta: num(r.sem_resposta),
        respostaMin: numOuNull(r.resposta_min), carteira: num(r.carteira), vendas: num(r.vendas), vgv: num(r.vgv),
      })).filter(c => corretor || c.recebidos || c.carteira || c.vendas || c.recusou || c.semResposta)
        .sort((a, b) => b.vendas - a.vendas || b.recebidos - a.recebidos),
      recusas: recusas.map(r => ({ criadoEm: r.criado_em, motivo: String(r.motivo), lead: String(r.lead), corretor: String(r.corretor), para: r.para ? String(r.para) : null })),
      ia: ia && num(ia.atendidos) + num(ia.atendendo_agora) > 0 ? {
        atendidos: num(ia.atendidos), transferidos: num(ia.transferidos), desqualificados: num(ia.desqualificados), atendendoAgora: num(ia.atendendo_agora),
      } : null,
    });
  });


  // Relatório por corretor: quantos leads ele recebeu num período, de onde vieram e o que
  // aconteceu com eles. Duas fontes combinadas:
  // 1) distribuicao_log — o registro real de "recebimento" pra tudo que passou pela roleta/puxada
  //    de rebatida desde que o CRM foi pro ar (não se perde quando o lead depois é rebatido e o
  //    corretorId do lead em si vira null).
  // 2) leads.criadoEm + leads.corretorId — fallback pros 10k+ leads importados em massa do CRM OKA
  //    (e qualquer atribuição manual), que nunca passaram pela roleta e por isso não têm log.
  // Um lead nunca conta duas vezes: só entra pelo fallback se não tiver linha em distribuicao_log.
  router.get('/corretor', async (req, res) => {
    const { imobiliariaId, role, sub } = req.auth!;
    const parsed = z.object({
      corretorId: z.string().uuid().optional(),
      de: z.string().optional(),
      ate: z.string().optional(),
    }).safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: 'Parâmetros inválidos' });

    if (role === 'corretor' && parsed.data.corretorId && parsed.data.corretorId !== sub) {
      return res.status(403).json({ error: 'Corretor só vê o próprio relatório' });
    }
    const corretorId = role === 'corretor' ? sub : (parsed.data.corretorId || sub);

    const agora = new Date();
    const inicioMes = new Date(agora.getFullYear(), agora.getMonth(), 1);
    const de = parsed.data.de ? new Date(parsed.data.de + 'T00:00:00') : inicioMes;
    const ate = parsed.data.ate ? new Date(parsed.data.ate + 'T23:59:59.999') : agora;

    const [corretor] = await db.select({ nome: perfis.nome }).from(perfis)
      .where(and(eq(perfis.id, corretorId), eq(perfis.imobiliariaId, imobiliariaId))).limit(1);
    if (!corretor) return res.status(404).json({ error: 'Corretor não encontrado' });

    const logRows = await db.select({
      leadId: distribuicaoLog.leadId,
      origem: distribuicaoLog.origem,
      recebidoEm: distribuicaoLog.criadoEm,
    })
      .from(distribuicaoLog)
      .where(and(
        eq(distribuicaoLog.imobiliariaId, imobiliariaId),
        eq(distribuicaoLog.corretorId, corretorId),
        gte(distribuicaoLog.criadoEm, de),
        lte(distribuicaoLog.criadoEm, ate),
      ));
    const logLeadIds = new Set(logRows.map(r => r.leadId));

    const leadsDoCorretor = await db.select({ id: leads.id, criadoEm: leads.criadoEm })
      .from(leads)
      .where(and(
        eq(leads.imobiliariaId, imobiliariaId),
        eq(leads.corretorId, corretorId),
        gte(leads.criadoEm, de),
        lte(leads.criadoEm, ate),
      ));
    const extras = leadsDoCorretor.filter(l => !logLeadIds.has(l.id));

    const eventos = [
      ...logRows.map(r => ({ leadId: r.leadId, origem: r.origem, quando: r.recebidoEm })),
      ...extras.map(l => ({ leadId: l.id, origem: 'importado', quando: l.criadoEm })),
    ];

    const idsUnicos = [...new Set(eventos.map(e => e.leadId))];
    const infoRows = idsUnicos.length === 0 ? [] : await db.select({
      id: leads.id,
      campanha: leads.campanha,
      valor: leads.valor,
      colunaSlug: colunasKanban.slug,
      colunaTitulo: colunasKanban.titulo,
    })
      .from(leads)
      .leftJoin(colunasKanban, eq(colunasKanban.id, leads.colunaId))
      .where(inArray(leads.id, idsUnicos));
    const infoPorId = new Map(infoRows.map(r => [r.id, r]));

    let roleta = 0, rebatidaPuxada = 0, importados = 0, vendasN = 0, vendasVgv = 0, rebatidasN = 0;
    const porCampanha = new Map<string, number>();
    const porDia = new Map<string, number>();
    const porStatus = new Map<string, { titulo: string; total: number }>();

    for (const ev of eventos) {
      if (ev.origem === 'rebatida-puxada') rebatidaPuxada++;
      else if (ev.origem === 'importado') importados++;
      else roleta++;

      const info = infoPorId.get(ev.leadId);
      const campanha = info?.campanha || 'Sem campanha identificada';
      porCampanha.set(campanha, (porCampanha.get(campanha) || 0) + 1);

      const dia = ev.quando.toISOString().slice(0, 10);
      porDia.set(dia, (porDia.get(dia) || 0) + 1);

      const slug = info?.colunaSlug || 'outro';
      const atual = porStatus.get(slug) || { titulo: info?.colunaTitulo || slug, total: 0 };
      atual.total++;
      porStatus.set(slug, atual);
      if (slug === 'venda') { vendasN++; vendasVgv += Number(info?.valor || 0); }
      if (slug === 'rebatida') rebatidasN++;
    }

    res.json({
      corretorNome: corretor.nome,
      periodo: { de: de.toISOString().slice(0, 10), ate: ate.toISOString().slice(0, 10) },
      total: eventos.length,
      porOrigem: { roleta, rebatidaPuxada, importados },
      porCampanha: [...porCampanha.entries()].map(([campanha, total]) => ({ campanha, total })).sort((a, b) => b.total - a.total),
      porDia: [...porDia.entries()].map(([data, total]) => ({ data, total })).sort((a, b) => a.data.localeCompare(b.data)),
      porStatusAtual: [...porStatus.entries()].map(([slug, v]) => ({ slug, titulo: v.titulo, total: v.total })).sort((a, b) => b.total - a.total),
      vendas: { total: vendasN, vgv: vendasVgv },
      rebatidas: { total: rebatidasN },
    });
  });

  return router;
}
