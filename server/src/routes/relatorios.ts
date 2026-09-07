import { Router } from 'express';
import { z } from 'zod';
import { and, eq, gte, inArray, lte } from 'drizzle-orm';
import { db } from '../db/client.js';
import { distribuicaoLog, leads, colunasKanban, perfis } from '../db/schema.js';
import { requireAuth } from '../middleware/auth.js';

export const relatoriosRouter = Router();
relatoriosRouter.use(requireAuth);

// Relatório por corretor: quantos leads ele recebeu num período, de onde vieram e o que
// aconteceu com eles. Duas fontes combinadas:
// 1) distribuicao_log — o registro real de "recebimento" pra tudo que passou pela roleta/puxada
//    de rebatida desde que o CRM foi pro ar (não se perde quando o lead depois é rebatido e o
//    corretorId do lead em si vira null).
// 2) leads.criadoEm + leads.corretorId — fallback pros 10k+ leads importados em massa do CRM OKA
//    (e qualquer atribuição manual), que nunca passaram pela roleta e por isso não têm log.
// Um lead nunca conta duas vezes: só entra pelo fallback se não tiver linha em distribuicao_log.
relatoriosRouter.get('/corretor', async (req, res) => {
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
