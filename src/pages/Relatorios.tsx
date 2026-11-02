import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAppStore } from '../store/appStore';
import { useRoleInfo } from '../lib/selectors';
import { BRL } from '../lib/format';
import { apiFetch } from '../lib/api';
import { RelatorioCorretor } from '../components/RelatorioCorretor';
import { Secao, Painel, Kpi, BarrasH, Barras, Rosca, Funil, nomeEtapa, FiltroCampanhas, ModalLeads, campoFiltro, card, th, td, vazioTxt } from '../components/relatorios/ui';

/** Relatórios — todas as funções da v1 (CRM OKA) + os números próprios da v2, com os filtros da v1:
 *  mês OU intervalo de datas, cidade, corretor e várias campanhas. Os filtros valem para a tela toda,
 *  menos o Relatório de Campanhas (que compara todas, igual à v1) e o Relatório individual (período próprio).
 *  Dados: GET /api/relatorios (v2) + GET /api/relatorios-oka (blocos da v1). Corretor vê só os próprios números. */

interface RelV2 {
  periodo: { de: string; ate: string };
  kpis: {
    leads: number; leadsAnterior: number; vendas: number; vendasAnterior: number; vgv: number;
    descartes: number; distribuidos: number; recusou: number; semResposta: number;
    respostaMedianaMin: number | null; respondidos: number; respondidosEm5min: number; semMensagemNoCrm: number;
  };
  porDia: { dia: string; leads: number }[];
  porHora: { hora: number; leads: number }[];
  canais: { nome: string; leads: number; vendas: number }[];
  motivosDescarte: { motivo: string; qtd: number }[];
  corretores: { id: string; nome: string; bloqueado: boolean; recebidos: number; recusou: number; semResposta: number; respostaMin: number | null; carteira: number; vendas: number; vgv: number }[];
  recusas: { criadoEm: string; motivo: string; lead: string; corretor: string; para: string | null }[];
  ia: { atendidos: number; transferidos: number; desqualificados: number; atendendoAgora: number } | null;
}
type LinhaRanking = Record<string, number | string | null> & { nome: string; corretor_id: string };
interface RelV1 {
  resumo: { leads: number; campanha: number; whatsapp: number; outros: number; slaMin: number | null; vendas: number; vgv: number };
  novos: { total: number; responderam: number; rendaMedia: number | null; comRenda: number; descartados: number; descadastrados: number;
    porEtapa: { coluna_id: string | null; titulo: string; total: number; responderam: number; renda_media: number | null }[] };
  temperatura: { quente: number; morno: number; frio: number };
  origens: { origem: string; n: number }[];
  etapas: { slug: string; nome: string }[];
  funil: { colunaId: string; titulo: string; slug: string | null; n: number }[];
  ranking: LinhaRanking[];
  campanhas: { campanha: string; leads: number; responderam: number; agendado: number; visitou: number; credito: number; restricao: number;
    descadastrado: number; ruins: number; vendas: number; gasto: number | null; taxaAprovacaoCredito: number | null; custoPorLead: number | null; cac: number | null }[];
  motivos: { motivo: string; n: number }[];
  followup: { porCorretor: { corretor: string; entraram: number; responderam: number; corretor_parou: number; rodando: number }[]; respostaPorPasso: { passo: number; n: number }[] };
  rebatidasHoje: { corretor: string; n: number }[];
}
type LeadLista = { id: string; nome: string; telefone: string | null; corretor: string | null };

const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const hojeIso = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
const ultimoDia = (mes: string) => { const [a, m] = mes.split('-').map(Number); return `${mes}-${String(new Date(Date.UTC(a, m, 0)).getUTCDate()).padStart(2, '0')}`; };
const dataBR = (s: string) => { const [a, m, d] = s.split('-'); return `${d}/${m}/${a}`; };
const diaCurto = (s: string) => { const [, m, d] = s.split('-'); return `${d}/${m}`; };
const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);
const pct1 = (a: number, b: number) => (b ? ((a / b) * 100).toFixed(1).replace('.', ',') + '%' : '—');
const tempo = (min: number | null) => min == null ? '—' : min < 1 ? '< 1 min' : min < 60 ? Math.round(min) + ' min' : (min / 60).toFixed(1).replace('.', ',') + ' h';
const CANAL: Record<string, string> = { Indicacao: 'Indicação' };
function variacao(atual: number, anterior: number) {
  if (!anterior) return '';
  const v = Math.round(((atual - anterior) / anterior) * 100);
  return (v > 0 ? '↑ ' : v < 0 ? '↓ ' : '') + Math.abs(v) + '% vs. período anterior';
}
const ORDENS: [string, string][] = [['vendas', 'Vendas'], ['visita', 'Agendamento'], ['visitou', 'Visita'], ['credito', 'Análise de crédito'], ['recebidos', 'Leads']];
const grid2: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 420px), 1fr))', gap: 14 };

export default function Relatorios() {
  const token = useAppStore(s => s.token);
  const toast = useAppStore(s => s.toast);
  const openLead = useAppStore(s => s.openLead);
  const leadsStore = useAppStore(s => s.leads);
  const perfis = useAppStore(s => s.perfisRemotos);
  const { isManager } = useRoleInfo();

  // ---- filtros (iguais aos da v1) ----
  const [mes, setMes] = useState(hojeIso().slice(0, 7));
  const [deC, setDeC] = useState('');
  const [ateC, setAteC] = useState('');
  const [cidade, setCidade] = useState('');
  const [corretorId, setCorretorId] = useState('');
  const [campanhasSel, setCampanhasSel] = useState<string[]>([]);
  const [opcoes, setOpcoes] = useState<{ cidades: string[]; campanhas: string[] }>({ cidades: [], campanhas: [] });
  const custom = !!(deC || ateC);
  const hoje = hojeIso();
  const de = custom ? (deC || ateC.slice(0, 8) + '01') : mes + '-01';
  const ate = custom ? (ateC || hoje) : (ultimoDia(mes) > hoje && mes === hoje.slice(0, 7) ? hoje : ultimoDia(mes));
  const periodoOk = de <= ate;
  const rotuloPeriodo = custom ? `${dataBR(de)} a ${dataBR(ate)}` : `${MESES[Number(mes.slice(5, 7)) - 1]} de ${mes.slice(0, 4)}`;
  const mesGasto = custom ? ate.slice(0, 7) : mes;

  const qs = useMemo(() => {
    const p = new URLSearchParams({ de, ate });
    if (isManager && corretorId) p.set('corretorId', corretorId);
    if (cidade) p.set('cidade', cidade);
    if (campanhasSel.length) p.set('campanhas', JSON.stringify(campanhasSel));
    return p.toString();
  }, [de, ate, isManager, corretorId, cidade, campanhasSel]);

  const [v2, setV2] = useState<RelV2 | null>(null);
  const [v1, setV1] = useState<RelV1 | null>(null);
  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [ordem, setOrdem] = useState('vendas');
  const [lista, setLista] = useState<{ titulo: string; leads: LeadLista[] | null } | null>(null);

  useEffect(() => {
    if (!token) return;
    apiFetch<{ cidades: string[]; campanhas: string[] }>('/api/relatorios-oka/filtros', token).then(setOpcoes).catch(() => {});
  }, [token]);

  const carregar = useCallback(() => {
    if (!token || !periodoOk) return;
    setCarregando(true);
    setErro(null);
    Promise.all([
      apiFetch<RelV2>('/api/relatorios?' + qs, token),
      apiFetch<RelV1>('/api/relatorios-oka?' + qs, token),
    ]).then(([a, b]) => { setV2(a); setV1(b); })
      .catch(e => setErro((e as Error).message || 'Não foi possível carregar o relatório'))
      .finally(() => setCarregando(false));
  }, [token, qs, periodoOk, toast]);
  useEffect(carregar, [carregar]);

  const abrirLista = (titulo: string, coluna: string, modo: 'passou' | 'atual') => {
    setLista({ titulo, leads: null });
    apiFetch<LeadLista[]>(`/api/relatorios-oka/leads?${qs}&coluna=${encodeURIComponent(coluna)}&modo=${modo}`, token)
      .then(leads => setLista({ titulo, leads }))
      .catch(() => { setLista(null); toast('Não foi possível listar os leads'); });
  };
  const abrirLead = (id: string) => {
    if (!leadsStore.some(l => l.id === id)) { toast('Esse lead ainda está carregando — tente de novo em alguns segundos'); return; }
    setLista(null);
    openLead(id);
  };

  async function salvarGasto(origem: string, valor: number) {
    try {
      await apiFetch('/api/relatorios-oka/gastos', token, { method: 'PUT', body: JSON.stringify({ origem, mes: mesGasto, valor }) });
      carregar();
    } catch { toast('Não foi possível salvar o gasto'); }
  }

  const limparFiltros = () => { setDeC(''); setAteC(''); setCidade(''); setCorretorId(''); setCampanhasSel([]); setMes(hoje.slice(0, 7)); };
  const temFiltro = custom || !!cidade || !!corretorId || campanhasSel.length > 0 || mes !== hoje.slice(0, 7);
  const corretoresOpc = perfis.filter(p => (p.role === 'corretor' || p.role === 'gerente') && !(p as { removidoEm?: string | null }).removidoEm);
  const ranking = v1 ? [...v1.ranking].sort((a, b) => Number(b[ordem] ?? 0) - Number(a[ordem] ?? 0) || String(a.nome).localeCompare(String(b.nome))) : [];

  const exportar = () => {
    if (!v1 || !v2) return;
    const k = v2.kpis, r = v1.resumo;
    const L: (string | number)[][] = [
      ['Relatório', rotuloPeriodo], ['Filtros', [cidade && 'Cidade: ' + cidade, corretorId && 'Corretor: ' + (perfis.find(p => p.id === corretorId)?.nome ?? ''), campanhasSel.length && 'Campanhas: ' + campanhasSel.join(' | ')].filter(Boolean).join(' · ') || 'nenhum'],
      [],
      ['Leads no período', r.leads], ['De campanha', r.campanha], ['WhatsApp', r.whatsapp], ['Outros', r.outros],
      ['SLA de atendimento (min)', r.slaMin ?? ''], ['Vendas', r.vendas], ['VGV (R$)', r.vgv], ['Conversão (%)', pct(r.vendas, r.leads)],
      ['1ª resposta (mediana, min)', k.respostaMedianaMin == null ? '' : Math.round(k.respostaMedianaMin)], ['Recusas', k.recusou], ['Sem resposta a tempo', k.semResposta],
      [],
      ['Ranking de consultores'], ['Corretor', 'Leads', ...v1.etapas.map(e => e.nome), 'Vendas', 'VGV', 'Descarte', 'Descadastro', 'Conversão (%)', 'SLA (min)'],
      ...ranking.map(x => [x.nome, Number(x.recebidos), ...v1.etapas.map(e => Number(x[e.slug] ?? 0)), Number(x.vendas), Number(x.vgv), Number(x.descarte), Number(x.descadastrado), pct(Number(x.vendas), Number(x.recebidos)), x.slaMin == null ? '' : Number(x.slaMin)]),
      [],
      ['Relatório de campanhas'], ['Campanha', 'Leads', 'Agendamento', 'Visita', 'Análise de crédito', 'Restrição', 'Descadastrar', 'Taxa aprov. crédito (%)', 'Vendas', 'Gasto (R$)', 'CAC (R$)'],
      ...v1.campanhas.map(c => [c.campanha, c.leads, c.agendado, c.visitou, c.credito, c.restricao, c.descadastrado, c.taxaAprovacaoCredito == null ? '' : Math.round(c.taxaAprovacaoCredito), c.vendas, c.gasto ?? '', c.cac == null ? '' : Math.round(c.cac)]),
      [],
      ['Funil (está ou já passou)'], ...v1.funil.map(f => [f.titulo, f.n]), ['Venda (fechada no período)', r.vendas],
      [],
      ['Dia', 'Leads'], ...v2.porDia.map(d => [dataBR(d.dia), d.leads]),
    ];
    const csv = '﻿' + L.map(l => l.map(c => { const s = String(c); return /[;"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }).join(';')).join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url; a.download = `relatorio-${de}-a-${ate}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const k = v2?.kpis;
  const r = v1?.resumo;
  const aceite = k ? pct(k.distribuidos - k.recusou - k.semResposta, k.distribuidos) : 0;

  return (
    <div style={{ maxWidth: 1360 }}>
      {/* cabeçalho */}
      <div className="page-head" style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', marginBottom: 14 }}>
        <div>
          <p style={{ fontSize: 11, letterSpacing: '.18em', textTransform: 'uppercase', color: 'var(--muted)', margin: '0 0 4px' }}>Performance comercial</p>
          <h1 style={{ fontFamily: 'Newsreader,serif', fontWeight: 400, fontSize: 26, margin: 0, lineHeight: 1.2 }}>Relatórios</h1>
          <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: '4px 0 0' }}>
            {rotuloPeriodo}{isManager ? '' : ' · seus números'}{carregando ? ' · atualizando…' : ''}
          </p>
        </div>
        <button onClick={exportar} disabled={!v1 || !v2} style={{ ...campoFiltro, padding: '0 16px' }}>Exportar CSV</button>
      </div>

      {/* filtros */}
      <div className="rel-filtros" style={{ ...card, padding: '12px 14px', display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 18, overflow: 'visible' }}>
        <label className="rel-mes" style={rotuloFiltro}>Mês
          <input type="month" value={mes} onChange={e => e.target.value && setMes(e.target.value)} disabled={custom} style={{ ...campoFiltro, opacity: custom ? 0.45 : 1 }} />
        </label>
        <span className="rel-ou" style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', alignSelf: 'flex-end', paddingBottom: 10 }}>ou</span>
        <label style={rotuloFiltro}>De
          <input type="date" value={deC} max={ateC || undefined} onChange={e => setDeC(e.target.value)} style={campoFiltro} />
        </label>
        <label style={rotuloFiltro}>Até
          <input type="date" value={ateC} min={deC || undefined} onChange={e => setAteC(e.target.value)} style={campoFiltro} />
        </label>
        <span className="rel-div" style={{ width: 1, alignSelf: 'stretch', background: 'var(--line)', margin: '0 4px' }} />
        <label style={rotuloFiltro}>Cidade
          <select value={cidade} onChange={e => setCidade(e.target.value)} style={{ ...campoFiltro, maxWidth: 190, borderColor: cidade ? 'var(--terra)' : 'var(--line)' }}>
            <option value="">Todas as cidades</option>
            {opcoes.cidades.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
        {isManager && (
          <label style={rotuloFiltro}>Corretor
            <select value={corretorId} onChange={e => setCorretorId(e.target.value)} style={{ ...campoFiltro, maxWidth: 190, borderColor: corretorId ? 'var(--terra)' : 'var(--line)' }}>
              <option value="">Todos os corretores</option>
              {corretoresOpc.map(p => <option key={p.id} value={p.id}>{p.nome}</option>)}
            </select>
          </label>
        )}
        <label style={rotuloFiltro}>Campanhas
          <FiltroCampanhas opcoes={opcoes.campanhas} selecionadas={campanhasSel} onChange={setCampanhasSel} />
        </label>
        {temFiltro && <button onClick={limparFiltros} style={{ ...campoFiltro, alignSelf: 'flex-end', border: 'none', background: 'none', color: 'var(--terra)' }}>Limpar filtros</button>}
        {!periodoOk && <span style={{ fontSize: 12, color: 'var(--terra)', alignSelf: 'flex-end', paddingBottom: 10 }}>A data final é antes da inicial.</span>}
      </div>

      {erro && (
        <div style={{ ...card, padding: '14px 18px', marginBottom: 18, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, borderColor: 'var(--terra)' }}>
          <span style={{ fontSize: 13 }}>Não foi possível carregar o relatório{v1 ? ' com esses filtros — mostrando os últimos números carregados' : ''}. <span style={{ color: 'var(--muted)' }}>({erro})</span></span>
          <button onClick={carregar} style={{ ...campoFiltro, borderColor: 'var(--terra)', color: 'var(--terra)' }}>Tentar de novo</button>
        </div>
      )}
      {!v1 || !v2 || !k || !r ? <p style={vazioTxt}>{carregando ? 'Carregando relatório…' : ''}</p> : (
        <div style={{ display: 'grid', gap: 26, gridTemplateColumns: 'minmax(0, 1fr)' }}>

          {/* 1. VISÃO GERAL */}
          <Secao rotulo="01" titulo="Visão geral" desc="Leads que chegaram no período e vendas fechadas no período.">
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 220px), 1fr))', gap: 12 }}>
              <Kpi destaque titulo="Leads no período" valor={String(r.leads)} nota={variacao(k.leads, k.leadsAnterior) || rotuloPeriodo}
                detalhe={`${r.campanha} de campanha · ${r.whatsapp} chamaram no WhatsApp${r.outros ? ` · ${r.outros} outros` : ''}`} />
              <Kpi destaque titulo="SLA de atendimento" valor={r.slaMin == null ? '—' : tempo(r.slaMin)} nota="Meta: 5 min" alerta={r.slaMin != null && r.slaMin > 5}
                detalhe="Tempo médio da chegada do lead até o 1º contato." />
              <Kpi destaque titulo="Taxa de conversão" valor={pct1(r.vendas, r.leads)} nota="Vendas ÷ leads do período" />
              <Kpi destaque titulo="Vendas no período" valor={String(r.vendas)} nota={variacao(k.vendas, k.vendasAnterior) || 'Fechamentos aprovados'}
                detalhe={r.vendas ? `VGV ${BRL(r.vgv)} · ticket médio ${BRL(r.vgv / r.vendas)}` : 'Conta pela data em que a venda fechou.'} />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 200px), 1fr))', gap: 12 }}>
              <Kpi titulo="1ª resposta do corretor" valor={tempo(k.respostaMedianaMin)}
                nota={k.respondidos ? `${pct(k.respondidosEm5min, k.respondidos)}% em até 5 min` : k.distribuidos ? 'Responderam fora do CRM' : 'Sem leads distribuídos'} alerta={!k.respondidos} />
              <Kpi titulo="Aceite da roleta" valor={k.distribuidos ? aceite + '%' : '—'} nota={`${k.recusou} recusa${k.recusou === 1 ? '' : 's'} · ${k.semResposta} sem resposta`} alerta={k.recusou + k.semResposta > 0} />
              <Kpi titulo="Descartados" valor={String(v1.novos.descartados)} nota={`${v1.novos.descadastrados} descadastrado${v1.novos.descadastrados === 1 ? '' : 's'}`} alerta={v1.novos.descartados > 0} />
              <Kpi titulo="Responderam" valor={String(v1.novos.responderam)} nota={pct(v1.novos.responderam, v1.novos.total) + '% dos leads do período'} />
            </div>
          </Secao>

          {/* 2. FUNIL */}
          <Secao rotulo="02" titulo="Funil e etapas" desc="Clique numa barra ou fatia para ver os leads e abrir o card.">
            <Painel titulo="Funil completo" desc={`Dos ${r.leads} lead${r.leads === 1 ? '' : 's'} do período, quantos estão ou já passaram por cada etapa do Kanban. Clique numa etapa para ver os leads.`}>
              <Funil total={r.leads} venda={r.vendas}
                etapas={v1.funil.filter(f => f.slug !== 'venda').map(f => ({ chave: f.colunaId, nome: nomeEtapa(f.titulo), n: f.n }))}
                onClick={(chave, nome) => abrirLista(chave === 'venda' ? 'Vendas do período' : nome, chave, 'passou')} />
            </Painel>
            <div style={grid2}>
              <Painel titulo="Status do funil" desc="Em que coluna os leads do período estão agora.">
                <Rosca centro={String(v1.novos.total)} rotuloCentro="leads"
                  dados={v1.novos.porEtapa.map(e => ({ chave: e.coluna_id ?? 'sem', nome: nomeEtapa(e.titulo), valor: e.total }))}
                  onClick={chave => abrirLista(nomeEtapa(v1.novos.porEtapa.find(e => (e.coluna_id ?? 'sem') === chave)?.titulo ?? 'Etapa') + ' (agora)', chave, 'atual')} />
              </Painel>
              <Painel titulo="Leads novos — renda e status" desc="Quantos responderam, em qual etapa estão e a renda familiar média informada." semPadding>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 1, background: 'var(--line)', borderBottom: '1px solid var(--line)' }}>
                  {[
                    ['Responderam', `${v1.novos.responderam} / ${v1.novos.total}`],
                    ['Renda média', v1.novos.rendaMedia != null ? BRL(v1.novos.rendaMedia) : '—'],
                    ['Informaram renda', `${v1.novos.comRenda} / ${v1.novos.total}`],
                    ['Descarte / descad.', `${v1.novos.descartados} / ${v1.novos.descadastrados}`],
                  ].map(([t, v]) => (
                    <div key={t} style={{ background: 'var(--card)', padding: '10px 14px' }}>
                      <p style={{ margin: 0, fontSize: 10, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--muted)', fontWeight: 700 }}>{t}</p>
                      <p style={{ margin: '3px 0 0', fontSize: 16, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{v}</p>
                    </div>
                  ))}
                </div>
                <div style={{ overflowX: 'auto', maxHeight: 290, overflowY: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead><tr><th style={{ ...th, textAlign: 'left' }}>Etapa atual</th><th style={th}>Leads</th><th style={th}>Responderam</th><th style={th}>Renda média</th></tr></thead>
                    <tbody>
                      {v1.novos.porEtapa.length === 0 && <tr><td colSpan={4} style={{ ...td, textAlign: 'center', color: 'var(--muted)' }}>Sem leads no período.</td></tr>}
                      {v1.novos.porEtapa.map(e => (
                        <tr key={e.titulo}>
                          <td style={{ ...td, textAlign: 'left', fontWeight: 600 }}>{nomeEtapa(e.titulo)}</td>
                          <td style={td}>{e.total}</td><td style={td}>{e.responderam}</td>
                          <td style={td}>{e.renda_media != null ? BRL(e.renda_media) : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Painel>
            </div>
          </Secao>

          {/* 3. EQUIPE */}
          <Secao rotulo="03" titulo="Equipe" desc="O que cada corretor fez no período — inclusive em leads antigos (rebatidas, etapas, devoluções).">
            <Painel titulo="Ranking de consultores" semPadding
              desc="Leads = recebidos (roleta, transferência ou rebatida puxada) · Rebatidas = puxou do bolsão ou recebeu lead que já foi de outro · cada etapa = levou o card pra ela no período · Descarte = devolveu no período · SLA = tempo médio até o 1º contato."
              extra={
                <label style={{ ...rotuloFiltro, flexDirection: 'row', alignItems: 'center', gap: 8 }}>Ordenar por
                  <select value={ordem} onChange={e => setOrdem(e.target.value)} style={campoFiltro}>
                    {ORDENS.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
                  </select>
                </label>}>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead><tr>
                    <th style={{ ...th, textAlign: 'left', position: 'sticky', left: 0, zIndex: 1 }}>Consultor</th>
                    {['Leads', ...v1.etapas.map(e => e.nome), 'Vendas', 'VGV', 'Descarte', 'Descad.', 'Conv.', 'SLA'].map(h => (
                      <th key={h} style={th}>{h}</th>
                    ))}
                  </tr></thead>
                  <tbody>
                    {ranking.length === 0 && <tr><td colSpan={18} style={{ ...td, textAlign: 'center', color: 'var(--muted)' }}>Sem movimento no período.</td></tr>}
                    {ranking.map((x, i) => (
                      <tr key={x.corretor_id}>
                        <td style={{ ...td, textAlign: 'left', fontWeight: 700, position: 'sticky', left: 0, background: 'var(--card)' }}>
                          <span style={{ display: 'inline-grid', placeItems: 'center', width: 22, height: 22, borderRadius: 11, marginRight: 8, fontSize: 10.5, background: i < 3 && Number(x[ordem] ?? 0) > 0 ? 'var(--terraSoft)' : 'var(--bg)', color: i < 3 && Number(x[ordem] ?? 0) > 0 ? 'var(--terra)' : 'var(--muted)' }}>{i + 1}</span>
                          {x.nome}
                        </td>
                        <td style={celRank(ordem === 'recebidos')}>{x.recebidos}</td>
                        {v1.etapas.map(e => <td key={e.slug} style={{ ...celRank(ordem === e.slug), color: e.slug === 'restricao' && Number(x[e.slug]) ? 'var(--terra)' : undefined }}>{x[e.slug] ?? 0}</td>)}
                        <td style={{ ...celRank(ordem === 'vendas'), fontWeight: 700, color: 'var(--olive)' }}>{x.vendas}</td>
                        <td style={td}>{Number(x.vgv) ? BRL(Number(x.vgv)) : '—'}</td>
                        <td style={{ ...td, color: 'var(--muted)' }}>{x.descarte}</td>
                        <td style={{ ...td, color: 'var(--muted)' }}>{x.descadastrado}</td>
                        <td style={td}>{pct1(Number(x.vendas), Number(x.recebidos))}</td>
                        <td style={{ ...td, color: x.slaMin != null && Number(x.slaMin) > 5 ? 'var(--terra)' : undefined }}>{x.slaMin != null ? tempo(Number(x.slaMin)) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Painel>

            {isManager && (
              <Painel titulo="Atendimento da roleta" desc='"Aceite" = leads que ficaram com o corretor ÷ leads que a roleta mandou. 1ª resposta = mediana até a 1ª mensagem dele pelo CRM.' semPadding>
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead><tr>
                      <th style={{ ...th, textAlign: 'left' }}>Corretor</th>
                      {['Recebidos', 'Recusou', 'Não respondeu', 'Aceite', '1ª resposta', 'Na carteira'].map(t => <th key={t} style={th}>{t}</th>)}
                    </tr></thead>
                    <tbody>
                      {v2.corretores.length === 0 && <tr><td colSpan={7} style={{ ...td, textAlign: 'center', color: 'var(--muted)' }}>Sem movimento no período.</td></tr>}
                      {v2.corretores.map(c => (
                        <tr key={c.id} style={{ opacity: c.bloqueado ? 0.55 : 1 }}>
                          <td style={{ ...td, textAlign: 'left', fontWeight: 600 }}>{c.nome}{c.bloqueado ? ' (bloqueado)' : ''}</td>
                          <td style={td}>{c.recebidos}</td>
                          <td style={{ ...td, color: c.recusou ? 'var(--terra)' : undefined }}>{c.recusou}</td>
                          <td style={{ ...td, color: c.semResposta ? 'var(--terra)' : undefined }}>{c.semResposta}</td>
                          <td style={td}>{c.recebidos ? pct(c.recebidos - c.recusou - c.semResposta, c.recebidos) + '%' : '—'}</td>
                          <td style={td}>{tempo(c.respostaMin)}</td>
                          <td style={td}>{c.carteira}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Painel>
            )}

            <div style={grid2}>
              <Painel titulo="Recusas da roleta" desc="Quem recusou o lead ou deixou o tempo acabar, e para quem ele foi depois.">
                {v2.recusas.length === 0 ? <p style={vazioTxt}>Nenhuma recusa no período.</p> : (
                  <div style={{ maxHeight: 300, overflowY: 'auto' }}>
                    {v2.recusas.map((x, i) => {
                      const d = new Date(x.criadoEm);
                      return (
                        <div key={i} style={{ display: 'flex', gap: 12, alignItems: 'baseline', padding: '8px 0', borderTop: i ? '1px solid var(--line)' : 'none', fontSize: 13 }}>
                          <span style={{ width: 86, flex: 'none', fontSize: 11.5, color: 'var(--muted)' }}>{d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })} {d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</span>
                          <span style={{ flex: 1, minWidth: 0 }}>
                            <b>{x.corretor}</b> {x.motivo === 'sem_resposta' ? 'não respondeu a tempo' : 'recusou'} <b>{x.lead}</b>
                            <span style={{ display: 'block', fontSize: 11.5, color: 'var(--muted)' }}>{x.para ? '→ foi para ' + x.para : '→ ficou sem corretor'}</span>
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </Painel>
              {isManager && (
                <Painel titulo="Rebatidas de hoje, por corretor" desc="Leads devolvidos hoje (sem contar descadastro).">
                  <BarrasH vazio="Ninguém devolveu lead hoje." dados={v1.rebatidasHoje.map(x => ({ nome: x.corretor, valor: x.n }))} />
                </Painel>
              )}
            </div>
          </Secao>

          {/* 4. ORIGEM E CAMPANHAS */}
          <Secao rotulo="04" titulo="Origem e campanhas" desc="De onde vêm os leads e quanto cada campanha converte.">
            <div style={grid2}>
              <Painel titulo="Volume por origem" desc="Leads do período por campanha/anúncio ou, sem campanha, pelo canal.">
                <BarrasH larguraRotulo={190} vazio="Sem leads no período." dados={v1.origens.map(o => ({ nome: CANAL[o.origem] ?? o.origem, valor: o.n, extra: pct(o.n, r.leads) + '%' }))} />
              </Painel>
              <Painel titulo="Qualidade dos leads" desc="Temperatura marcada no card (potencial de fechamento).">
                <BarrasH vazio="Nenhum lead com temperatura marcada no período." larguraRotulo={80}
                  dados={[
                    { nome: 'Quente', valor: v1.temperatura.quente, cor: '#B5442F' },
                    { nome: 'Morno', valor: v1.temperatura.morno, cor: '#C9A227' },
                    { nome: 'Frio', valor: v1.temperatura.frio, cor: '#4F6D7A' },
                  ].map(t => ({ ...t, extra: pct(t.valor, r.leads) + '%' }))} />
                <p style={{ ...vazioTxt, fontSize: 11.5, marginTop: 10 }}>
                  {r.leads - v1.temperatura.quente - v1.temperatura.morno - v1.temperatura.frio} lead(s) sem temperatura definida.
                </p>
              </Painel>
            </div>

            <Painel titulo="Relatório de campanhas" semPadding
              desc={`Funil por campanha: % sobre os leads daquela campanha no período. O filtro de campanhas não vale aqui — a tabela sempre compara todas. Gasto lançado no mês de ${MESES[Number(mesGasto.slice(5, 7)) - 1]}/${mesGasto.slice(0, 4)}; CAC = gasto ÷ vendas.`}>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead><tr>
                    <th style={{ ...th, textAlign: 'left', position: 'sticky', left: 0, zIndex: 1 }}>Campanha</th>
                    {['Leads', 'Responderam', 'Agendamento', 'Visita', 'An. crédito', 'Restrição', 'Descadastrar', 'Aprov. crédito', 'Vendas', 'Gasto (R$)', 'Custo/lead', 'CAC'].map(h => <th key={h} style={th}>{h}</th>)}
                  </tr></thead>
                  <tbody>
                    {v1.campanhas.length === 0 && <tr><td colSpan={13} style={{ ...td, textAlign: 'center', color: 'var(--muted)' }}>Nenhuma campanha no período.</td></tr>}
                    {v1.campanhas.map(c => (
                      <tr key={c.campanha} style={{ background: campanhasSel.includes(c.campanha) ? 'var(--terraSoft)' : undefined }}>
                        <td title={c.campanha} style={{ ...td, textAlign: 'left', fontWeight: 600, maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', position: 'sticky', left: 0, background: campanhasSel.includes(c.campanha) ? 'var(--terraSoft)' : 'var(--card)' }}>{CANAL[c.campanha] ?? c.campanha}</td>
                        <td style={{ ...td, fontWeight: 700 }}>{c.leads}</td>
                        <td style={td}>{pct1(c.responderam, c.leads)}</td>
                        <td style={td}>{pct1(c.agendado, c.leads)}</td>
                        <td style={td}>{pct1(c.visitou, c.leads)}</td>
                        <td style={td}>{pct1(c.credito, c.leads)}</td>
                        <td style={{ ...td, color: c.restricao ? 'var(--terra)' : undefined }}>{pct1(c.restricao, c.leads)}</td>
                        <td style={{ ...td, color: 'var(--muted)' }}>{pct1(c.descadastrado, c.leads)}</td>
                        <td style={td}>{c.taxaAprovacaoCredito == null ? '—' : c.taxaAprovacaoCredito.toFixed(1).replace('.', ',') + '%'}</td>
                        <td style={{ ...td, fontWeight: 700, color: c.vendas ? 'var(--olive)' : undefined }}>{c.vendas}{c.leads ? <span style={{ fontWeight: 400, color: 'var(--muted)' }}> · {pct1(c.vendas, c.leads)}</span> : null}</td>
                        <td style={td}>{isManager
                          ? <input key={c.campanha + mesGasto + (c.gasto ?? '')} type="number" min={0} step="0.01" placeholder="0,00" defaultValue={c.gasto ?? ''} aria-label={'Gasto de ' + c.campanha}
                              onBlur={e => { const v = Number(e.target.value); if (e.target.value !== '' && v !== (c.gasto ?? -1)) void salvarGasto(c.campanha, v); }}
                              style={{ width: 92, height: 30, padding: '0 8px', border: '1px solid var(--line)', borderRadius: 7, background: 'var(--bg)', fontSize: 12.5, textAlign: 'right' }} />
                          : c.gasto != null ? BRL(c.gasto) : '—'}</td>
                        <td style={td}>{c.custoPorLead != null ? BRL(c.custoPorLead) : '—'}</td>
                        <td style={{ ...td, fontWeight: 700 }}>{c.cac != null ? BRL(c.cac) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Painel>

            <Painel titulo="Leads por dia" desc="Quantos leads entraram em cada dia. Passe o mouse na barra para ver o número.">
              <Barras altura={150} dados={v2.porDia.map(d => ({ rotulo: diaCurto(d.dia), dica: `${dataBR(d.dia)}: ${d.leads} lead${d.leads === 1 ? '' : 's'}`, valor: d.leads }))} />
            </Painel>
            <div style={grid2}>
              <Painel titulo="Horário de chegada" desc="Em que hora do dia os leads mais chegam — bom para escalar o plantão.">
                <Barras altura={120} dados={v2.porHora.map(h => ({ rotulo: h.hora % 3 === 0 ? h.hora + 'h' : '', dica: `${h.hora}h–${h.hora + 1}h: ${h.leads} lead${h.leads === 1 ? '' : 's'}`, valor: h.leads }))} />
              </Painel>
              <Painel titulo="Canais" desc="Leads do período por canal de entrada e quantos já viraram venda.">
                <BarrasH vazio="Sem leads no período." larguraRotulo={100}
                  dados={v2.canais.map(c => ({ nome: CANAL[c.nome] ?? c.nome, valor: c.leads, extra: c.vendas ? `${c.vendas} venda${c.vendas > 1 ? 's' : ''}` : '' }))} />
              </Painel>
            </div>
          </Secao>

          {/* 5. PÓS-ATENDIMENTO */}
          <Secao rotulo="05" titulo="Pós-atendimento" desc="Follow-up automático, devoluções e Agente de IA.">
            <div style={grid2}>
              <Painel titulo="Follow-up automático" semPadding desc="Leads que entraram num fluxo no período e o que aconteceu.">
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead><tr><th style={{ ...th, textAlign: 'left' }}>Corretor</th>{['Entraram', 'Responderam', 'Corretor parou', 'Rodando'].map(h => <th key={h} style={th}>{h}</th>)}</tr></thead>
                    <tbody>
                      {v1.followup.porCorretor.length === 0 && <tr><td colSpan={5} style={{ ...td, textAlign: 'center', color: 'var(--muted)' }}>Nenhum follow-up no período.</td></tr>}
                      {v1.followup.porCorretor.map(f => (
                        <tr key={f.corretor}><td style={{ ...td, textAlign: 'left', fontWeight: 600 }}>{f.corretor}</td><td style={td}>{f.entraram}</td>
                          <td style={td}>{f.responderam} <span style={{ color: 'var(--muted)' }}>({pct(f.responderam, f.entraram)}%)</span></td>
                          <td style={td}>{f.corretor_parou}</td><td style={td}>{f.rodando}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {v1.followup.respostaPorPasso.length > 0 && (
                  <p style={{ ...vazioTxt, fontSize: 12, padding: '10px 14px' }}>Em qual mensagem o cliente mais responde: {v1.followup.respostaPorPasso.map(p => p.passo + 'ª (' + p.n + ')').join(' · ')}</p>
                )}
              </Painel>
              <Painel titulo="Por que os leads são devolvidos" desc="Motivo escolhido no descarte + desqualificações do Agente de IA.">
                <BarrasH larguraRotulo={190} vazio="Nenhuma devolução no período." dados={v2.motivosDescarte.map(m => ({ nome: m.motivo, valor: m.qtd }))} />
              </Painel>
            </div>
            {v2.ia && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 200px), 1fr))', gap: 12 }}>
                <Kpi titulo="IA · conversas atendidas" valor={String(v2.ia.atendidos)} />
                <Kpi titulo="IA · passados à roleta" valor={String(v2.ia.transferidos)} nota="qualificados pela IA" />
                <Kpi titulo="IA · desqualificados" valor={String(v2.ia.desqualificados)} nota="pelas regras da imobiliária" />
                <Kpi titulo="IA · atendendo agora" valor={String(v2.ia.atendendoAgora)} />
              </div>
            )}
          </Secao>

          {/* 6. INDIVIDUAL */}
          <Secao rotulo="06" titulo="Relatório individual" desc="Detalhe de um corretor com período próprio (não segue os filtros de cima).">
            <RelatorioCorretor />
          </Secao>
        </div>
      )}

      {lista && <ModalLeads titulo={lista.titulo} leads={lista.leads} carregando={!lista.leads} onAbrir={abrirLead} onFechar={() => setLista(null)} />}
    </div>
  );
}

const rotuloFiltro: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 10, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--muted)', fontWeight: 700 };
const celRank = (ativo: boolean): React.CSSProperties => ({ ...td, fontWeight: ativo ? 700 : 400, background: ativo ? 'var(--bg)' : undefined });
