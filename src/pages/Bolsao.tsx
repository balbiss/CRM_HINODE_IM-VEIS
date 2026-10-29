import { useEffect, useMemo, useState } from 'react';
import { useAppStore } from '../store/appStore';
import { useRoleInfo } from '../lib/selectors';
import { MOTIVOS_DESCARTE_EXTREMO, type Lead } from '../lib/data';
import { dataHoraCurta } from '../lib/datas';
import type { BolsaoTab } from '../store/appStore';

/** Distribuição de Leads (v1): 6 abas pra dono/gerente; corretor usa o "+ Mais Rebatidas". */
const norm = (t?: string | null) => (t ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase().replace(/\s+/g, ' ');
const extremo = (m?: string | null) => MOTIVOS_DESCARTE_EXTREMO.some(x => (m ?? '').startsWith(x.split(' (')[0]));
const LOTE = 80;

export default function Bolsao() {
  const allLeads = useAppStore(s => s.leads);
  const colunas = useAppStore(s => s.colunasRemotas);
  const perfis = useAppStore(s => s.perfisRemotos);
  const bolsaoTab = useAppStore(s => s.bolsaoTab);
  const setBolsaoTab = useAppStore(s => s.setBolsaoTab);
  const puxarRebatida = useAppStore(s => s.puxarRebatida);
  const rebatidasStatus = useAppStore(s => s.rebatidasStatus);
  const fetchRebatidasStatus = useAppStore(s => s.fetchRebatidasStatus);
  const cidadesBolsao = useAppStore(s => s.cidadesBolsao);
  const fetchCidades = useAppStore(s => s.fetchCidadesBolsao);
  const reativarLead = useAppStore(s => s.reativarLead);
  const transferirLeads = useAppStore(s => s.transferirLeads);
  const openLead = useAppStore(s => s.openLead);
  const ask = useAppStore(s => s.ask);
  const roletaLog = useAppStore(s => s.roletaLog);
  const fetchRoletaLog = useAppStore(s => s.fetchRoletaLog);
  const { isManager } = useRoleInfo();
  useEffect(() => { fetchRebatidasStatus(); fetchCidades(); fetchRoletaLog(); }, [fetchRebatidasStatus, fetchCidades, fetchRoletaLog]);

  const [query, setQuery] = useState('');
  const [cidade, setCidade] = useState('');
  const [cidadePuxar, setCidadePuxar] = useState('');
  const [de, setDe] = useState('');
  const [ate, setAte] = useState('');
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [visivel, setVisivel] = useState(LOTE);
  const [soRecusas, setSoRecusas] = useState(false);
  useEffect(() => { setSel(new Set()); setVisivel(LOTE); }, [bolsaoTab]);

  const tabs: [BolsaoTab, string][] = [
    ['novos', 'Leads Novos'], ['rebatidas', 'Rebatidas Geral (Bolsão)'], ['presos', 'Presos para Redistribuir'],
    ['descartados', 'Leads Descartados'], ['descadastrar', 'Lead Descadastrar'], ['roletalog', 'Histórico da Roleta'],
  ];
  const bTab: BolsaoTab = tabs.some(([id]) => id === bolsaoTab) ? bolsaoTab : 'novos';
  const colNovo = colunas.find(c => c.slug === 'novo')?.id;

  const filtroTexto = (l: Lead) => {
    const q = query.trim().toLowerCase();
    if (q && !(l.nome.toLowerCase().includes(q) || l.tel.includes(q) || l.corretor.toLowerCase().includes(q))) return false;
    if (cidade && norm(l.bairroInteresse) !== norm(cidade)) return false;
    return true;
  };
  const noPeriodo = (iso?: string) => {
    if (!iso) return !de && !ate;
    const d = iso.slice(0, 10);
    return (!de || d >= de) && (!ate || d <= ate);
  };
  const porData = (a: Lead, b: Lead) => +new Date(a.criadoEm ?? 0) - +new Date(b.criadoEm ?? 0);

  const abas = useMemo(() => {
    const base = allLeads.filter(filtroTexto);
    const semDono = base.filter(l => !l.corretorId && !l.descartePendente);
    return {
      novos: semDono.filter(l => !l.descartadoEm && !l.jaTeveCorretor && noPeriodo(l.criadoEm)).sort((a, b) => -porData(a, b)),
      rebatidas: semDono.filter(l => !l.descartadoEm).sort(porData).slice(0, 500),
      presos: base.filter(l => l.corretorId && !l.descartadoEm && l.colunaId === colNovo
        && ((l.tentativasContato ?? 0) >= 5 || Date.now() - +new Date(l.entrouNaColunaEm ?? l.criadoEm ?? 0) > 24 * 3600000)),
      descartados: base.filter(l => l.descartadoEm && !extremo(l.motivo)).sort((a, b) => +new Date(b.descartadoEm!) - +new Date(a.descartadoEm!)),
      descadastrar: base.filter(l => l.descartadoEm && extremo(l.motivo)).sort((a, b) => +new Date(b.descartadoEm!) - +new Date(a.descartadoEm!)),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allLeads, query, cidade, de, ate, colNovo]);

  const hojeOntem = useMemo(() => {
    const ini = new Date(); ini.setHours(0, 0, 0, 0);
    const ontem = new Date(ini); ontem.setDate(ini.getDate() - 1);
    return allLeads.filter(l => !l.corretorId && !l.jaTeveCorretor && !l.descartadoEm && l.criadoEm && new Date(l.criadoEm) >= ontem).length;
  }, [allLeads]);

  const rs = rebatidasStatus;
  const bloqueado = !!rs && (rs.tarefasAtrasadas > 0 || rs.puxadasHoje >= rs.limite || rs.disponiveis === 0);
  const puxar = (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      <select value={cidadePuxar} onChange={e => setCidadePuxar(e.target.value)} style={inp}>
        <option value="">Todas as cidades</option>
        {cidadesBolsao.map(c => <option key={c}>{c}</option>)}
      </select>
      <button onClick={async () => { await puxarRebatida(cidadePuxar || undefined); fetchRebatidasStatus(); }} disabled={bloqueado}
        style={{ padding: '10px 16px', border: 'none', borderRadius: 8, background: 'var(--terra)', color: '#fff', fontSize: 13, fontWeight: 600, opacity: bloqueado ? 0.5 : 1 }}>
        + Mais Rebatidas
      </button>
      {rs && (
        <span style={{ fontSize: 12, color: rs.tarefasAtrasadas > 0 ? 'var(--terra)' : 'var(--muted)' }}>
          {rs.tarefasAtrasadas > 0 ? rs.tarefasAtrasadas + ' tarefa(s) atrasada(s) — resolva pra liberar'
            : 'Hoje: ' + rs.puxadasHoje + ' de ' + rs.limite + ' · até ' + (rs.porClique ?? 10) + ' por clique'}
        </span>
      )}
    </div>
  );

  if (!isManager) {
    return (
      <div>
        <Cabecalho titulo="Rebatidas" sub="Puxe leads do bolsão pra sua carteira. Eles caem na coluna REBATIDA com contato marcado pra hoje." />
        {puxar}
        <p style={{ fontSize: 12.5, color: 'var(--muted)', maxWidth: 620, lineHeight: 1.6, marginTop: 14 }}>
          Até 10 por clique e 50 por dia. Só trava se você tiver tarefa atrasada de verdade (contato marcado pra um dia que já passou).
          Nunca volta pra você um lead que já foi seu. Descartados só voltam pro bolsão depois de um tempo: Sem Resposta 3 dias,
          Parou de Responder 5 dias, Sem Interesse e Aprovado/Desistiu 20 dias.
        </p>
      </div>
    );
  }

  const lista: Lead[] = bTab === 'roletalog' ? [] : abas[bTab];
  const toggle = (id: string) => setSel(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const corretores = perfis.filter(p => !p.bloqueado && p.role !== 'dono');
  const logVisivel = soRecusas ? roletaLog.filter(r => r.tipo === 'recusa') : roletaLog;
  const ORIGEM: Record<string, string> = { roleta: 'Roleta automática', automatico: 'Roleta (5 min sem contato)', manual: 'Transferido', 'rebatida-puxada': 'Puxou do bolsão', importacao: 'Planilha' };

  return (
    <div>
      <Cabecalho titulo="Distribuição de Leads" sub="Leads que não estão sendo atendidos como deveriam." />
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center', marginBottom: 14 }}>
        <span style={{ border: '1px solid var(--line)', borderRadius: 10, padding: '8px 14px', background: 'var(--card)', fontSize: 12.5, color: 'var(--muted)' }}>
          <b style={{ color: 'var(--ink)', fontSize: 16 }}>{hojeOntem}</b> leads novos hoje + ontem
        </span>
        {puxar}
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Buscar por nome, telefone ou corretor…" style={{ ...inp, flex: '1 1 220px' }} />
        <select value={cidade} onChange={e => setCidade(e.target.value)} style={inp}>
          <option value="">Todas as cidades</option>
          {cidadesBolsao.map(c => <option key={c}>{c}</option>)}
        </select>
        {bTab === 'novos' && (
          <>
            <input type="date" value={de} onChange={e => setDe(e.target.value)} style={inp} />
            <input type="date" value={ate} onChange={e => setAte(e.target.value)} style={inp} />
          </>
        )}
      </div>
      <div style={{ display: 'flex', gap: 20, borderBottom: '1px solid var(--line)', marginBottom: 14, overflowX: 'auto' }}>
        {tabs.map(([id, label]) => (
          <button key={id} onClick={() => setBolsaoTab(id)} style={{ padding: '0 0 12px', border: 'none', background: 'none', fontSize: 13.5, fontWeight: bTab === id ? 700 : 500, whiteSpace: 'nowrap', color: bTab === id ? 'var(--ink)' : 'var(--muted)', borderBottom: '2px solid ' + (bTab === id ? 'var(--terra)' : 'transparent'), marginBottom: -1 }}>
            {label}{id !== 'roletalog' ? ' (' + abas[id as Exclude<BolsaoTab, 'roletalog'>].length + (id === 'rebatidas' && abas.rebatidas.length === 500 ? '+' : '') + ')' : ''}
          </button>
        ))}
      </div>

      {bTab !== 'roletalog' && sel.size > 0 && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>{sel.size} selecionado(s)</span>
          <select defaultValue="" onChange={e => {
            const alvo = corretores.find(p => p.id === e.target.value);
            e.target.value = '';
            if (alvo) ask('Encaminhar ' + sel.size + ' lead(s) para ' + alvo.nome + '?', 'Lead que nunca teve corretor chega como novo (com aviso); os outros caem na REBATIDA dele.', 'Encaminhar', async () => { if (await transferirLeads([...sel], alvo.id)) setSel(new Set()); });
          }} style={inp}>
            <option value="" disabled>Encaminhar para…</option>
            {corretores.map(p => <option key={p.id} value={p.id}>{p.nome}</option>)}
          </select>
          <button onClick={() => setSel(new Set())} style={{ border: 'none', background: 'none', color: 'var(--muted)', fontSize: 12.5 }}>limpar</button>
        </div>
      )}

      {bTab === 'roletalog' ? (
        <div style={{ border: '1px solid var(--line)', borderRadius: 12, background: 'var(--card)', overflow: 'hidden' }}>
          <div style={{ padding: '10px 18px', borderBottom: '1px solid var(--line)' }}>
            <label style={{ fontSize: 12.5, color: 'var(--muted)', display: 'flex', gap: 6, alignItems: 'center' }}><input type="checkbox" checked={soRecusas} onChange={e => setSoRecusas(e.target.checked)} /> Só recusas</label>
          </div>
          {logVisivel.map((r, i) => (
            <div key={i} style={{ display: 'flex', gap: 14, padding: '11px 18px', borderBottom: '1px solid var(--line)', fontSize: 13, flexWrap: 'wrap' }}>
              <span style={{ width: 110, color: 'var(--muted)' }}>{dataHoraCurta(r.criadoEm)}</span>
              <span style={{ flex: 1, minWidth: 140, fontWeight: 600 }}>{r.leadNome}</span>
              <span style={{ flex: 1, minWidth: 120 }}>{r.corretorNome}{r.paraNome ? ' → ' + r.paraNome : ''}</span>
              <span style={{ color: 'var(--muted)' }}>{r.tipo === 'recusa' ? (r.origem === 'sem_resposta' ? 'Não respondeu a tempo' : 'Recusou') : ORIGEM[r.origem] ?? (r.origem.startsWith('oka:') ? 'CRM antigo' : r.origem)}</span>
            </div>
          ))}
          {logVisivel.length === 0 && <p style={vazio}>Nada no histórico ainda.</p>}
        </div>
      ) : (
        <div style={{ border: '1px solid var(--line)', borderRadius: 12, background: 'var(--card)', overflow: 'hidden' }}>
          {lista.slice(0, visivel).map(l => (
            <div key={l.id} className="data-row" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 18px', borderBottom: '1px solid var(--line)', flexWrap: 'wrap' }}>
              {bTab !== 'descadastrar' && <input type="checkbox" checked={sel.has(l.id)} onChange={() => toggle(l.id)} />}
              <button onClick={() => openLead(l.id)} style={{ flex: 1, minWidth: 180, textAlign: 'left', background: 'none', border: 'none', padding: 0 }}>
                <span style={{ display: 'block', fontSize: 13.5, fontWeight: 700, color: 'var(--ink)' }}>{l.nome}</span>
                <span style={{ display: 'block', fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
                  {[l.tel, l.bairroInteresse, l.campanha].filter(Boolean).join(' · ')}
                </span>
              </button>
              <span style={{ fontSize: 12, color: 'var(--muted)', minWidth: 120 }}>
                {bTab === 'presos' ? l.corretor + ' · ' + ((l.tentativasContato ?? 0) >= 5 ? (l.tentativasContato + ' tentativas') : 'parado desde ' + dataHoraCurta(l.entrouNaColunaEm))
                  : bTab === 'descartados' || bTab === 'descadastrar' ? (l.motivo || '—') + ' · ' + dataHoraCurta(l.descartadoEm ?? undefined)
                  : 'entrou ' + dataHoraCurta(l.criadoEm)}
              </span>
              {bTab === 'descartados' && (
                <button onClick={() => ask('Reativar ' + l.nome + '?', 'Volta pro bolsão do zero: sem corretor e sem o descarte.', 'Reativar', () => { void reativarLead(l.id); })}
                  style={{ padding: '7px 12px', border: '1px solid var(--line)', borderRadius: 7, background: 'none', fontSize: 12, fontWeight: 600, color: 'var(--olive)' }}>Reativar</button>
              )}
            </div>
          ))}
          {lista.length > visivel && (
            <div style={{ padding: 14, textAlign: 'center' }}>
              <button onClick={() => setVisivel(v => v + LOTE)} style={{ padding: '9px 16px', border: '1px dashed var(--line)', borderRadius: 8, background: 'none', color: 'var(--muted)', fontSize: 12.5 }}>Carregar mais ({lista.length - visivel} restantes)</button>
            </div>
          )}
          {lista.length === 0 && <p style={vazio}>Nenhum lead aqui.</p>}
        </div>
      )}
      <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: 12, lineHeight: 1.6, maxWidth: 760 }}>
        <b>Leads Novos</b>: chegaram e nunca tiveram corretor. <b>Rebatidas Geral</b>: todo lead sem dono (os 500 mais antigos; o filtro de cidade busca antes do corte).
        <b> Presos</b>: com corretor, mas 5+ tentativas ou mais de 24h sem sair de LEAD NOVO. <b>Descartados</b>: descartes normais (Reativar devolve pro bolsão).
        <b> Descadastrar</b>: descartes extremos já aprovados — definitivos.
      </p>
    </div>
  );
}

function Cabecalho({ titulo, sub }: { titulo: string; sub: string }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <p style={{ fontSize: 11, letterSpacing: '.18em', textTransform: 'uppercase', color: 'var(--muted)', margin: '0 0 4px' }}>Recuperação</p>
      <h1 style={{ fontFamily: 'Newsreader,serif', fontWeight: 400, fontSize: 24, margin: 0, lineHeight: 1.2 }}>{titulo}</h1>
      <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: '5px 0 0' }}>{sub}</p>
    </div>
  );
}
const inp: React.CSSProperties = { padding: '9px 12px', border: '1px solid var(--line)', borderRadius: 8, background: 'var(--card)', fontSize: 13 };
const vazio: React.CSSProperties = { padding: '30px 18px', textAlign: 'center', fontSize: 13, color: 'var(--muted)', margin: 0 };
