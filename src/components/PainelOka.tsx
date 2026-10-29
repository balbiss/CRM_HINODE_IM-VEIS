import { useEffect, useState } from 'react';
import { useAppStore } from '../store/appStore';
import { apiFetch } from '../lib/api';
import { BRL } from '../lib/format';

/** Números do CRM antigo (v1) somados aos relatórios da v2: ranking por corretor com todas as etapas
 *  ("está ou já passou pela coluna"), funil, campanhas com custo por lead/CAC, follow-up, motivos de
 *  devolução, horários dos cadastros e rebatidas do dia. Venda conta pelo mês em que fechou. */
type Rel = {
  etapas: { slug: string; nome: string }[];
  funil: Record<string, number>;
  ranking: (Record<string, number | string | null> & { nome: string; corretor_id: string })[];
  campanhas: { campanha: string; leads: number; responderam: number; credito: number; vendas: number; ruins: number; gasto: number | null; custoPorLead: number | null; cac: number | null }[];
  motivos: { motivo: string; n: number }[];
  horas: { hora: number; n: number }[];
  followup: { porCorretor: { corretor: string; entraram: number; responderam: number; corretor_parou: number; rodando: number }[]; respostaPorPasso: { passo: number; n: number }[] };
  rebatidasHoje: { corretor: string; n: number }[];
};

export function PainelOka({ de, ate, corretorId }: { de: string; ate: string; corretorId?: string }) {
  const token = useAppStore(s => s.token);
  const me = useAppStore(s => s.me);
  const toast = useAppStore(s => s.toast);
  const gestor = me?.role === 'dono' || me?.role === 'gerente';
  const [rel, setRel] = useState<Rel | null>(null);
  const [ordem, setOrdem] = useState('vendas');
  const [carregando, setCarregando] = useState(false);

  const carregar = () => {
    if (!token || !de || !ate) return;
    setCarregando(true);
    apiFetch<Rel>('/api/relatorios-oka?de=' + de + '&ate=' + ate + (corretorId ? '&corretorId=' + corretorId : ''), token)
      .then(setRel).catch(() => toast('Não foi possível carregar os números')).finally(() => setCarregando(false));
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(carregar, [token, de, ate, corretorId]);

  if (!rel) return <p style={{ fontSize: 13, color: 'var(--muted)' }}>{carregando ? 'Carregando números do funil…' : ''}</p>;
  const mes = ate.slice(0, 7);
  const ranking = [...rel.ranking].sort((a, b) => Number(b[ordem] ?? 0) - Number(a[ordem] ?? 0));
  const maxHora = Math.max(1, ...rel.horas.map(h => h.n));
  async function salvarGasto(origem: string, valor: number) {
    try {
      await apiFetch('/api/relatorios-oka/gastos', token, { method: 'PUT', body: JSON.stringify({ origem, mes, valor }) });
      carregar();
    } catch { toast('Não foi possível salvar o gasto'); }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, marginTop: 22 }}>
      <h2 style={{ fontFamily: 'Newsreader,serif', fontWeight: 400, fontSize: 21, margin: 0 }}>Funil e ranking (como no CRM antigo)</h2>

      <Caixa titulo={'Funil completo · ' + (rel.funil.total ?? 0) + ' leads no período'}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {rel.etapas.map(e => {
            const n = Number(rel.funil[e.slug] ?? 0);
            const pct = rel.funil.total ? n / Number(rel.funil.total) : 0;
            return (
              <div key={e.slug} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12.5 }}>
                <span style={{ width: 130 }}>{e.nome}</span>
                <span style={{ flex: 1, height: 14, background: 'var(--bg)', borderRadius: 4, overflow: 'hidden' }}><span style={{ display: 'block', height: '100%', width: (pct * 100) + '%', background: 'var(--terra)' }} /></span>
                <span style={{ width: 90, textAlign: 'right' }}>{n} ({Math.round(pct * 100)}%)</span>
              </div>
            );
          })}
        </div>
        <p style={nota}>Conta o lead que está ou já passou pela coluna.</p>
      </Caixa>

      <Caixa titulo="Ranking de consultores" extra={
        <select value={ordem} onChange={e => setOrdem(e.target.value)} style={sel}>
          <option value="vendas">Ranking por vendas</option><option value="visita">por agendamento</option>
          <option value="visitou">por visita</option><option value="credito">por análise</option><option value="recebidos">por leads</option>
        </select>}>
        <div style={{ overflowX: 'auto' }}>
          <table style={tabela}>
            <thead><tr>{['Corretor', 'Leads', ...rel.etapas.map(e => e.nome), 'Vendas', 'VGV', 'Descarte', 'Descadastr.', 'Conversão', 'SLA'].map(h => <th key={h} style={th}>{h}</th>)}</tr></thead>
            <tbody>
              {ranking.map(r => (
                <tr key={r.corretor_id}>
                  <td style={{ ...td, fontWeight: 700, textAlign: 'left' }}>{r.nome}</td>
                  <td style={td}>{r.recebidos}</td>
                  {rel.etapas.map(e => <td key={e.slug} style={td}>{r[e.slug] ?? 0}</td>)}
                  <td style={{ ...td, fontWeight: 700, color: 'var(--olive)' }}>{r.vendas}</td>
                  <td style={td}>{BRL(Number(r.vgv ?? 0))}</td>
                  <td style={td}>{r.descarte}</td>
                  <td style={td}>{r.descadastrado}</td>
                  <td style={td}>{Number(r.recebidos) ? ((Number(r.vendas) / Number(r.recebidos)) * 100).toFixed(1) + '%' : '—'}</td>
                  <td style={td}>{r.slaMin != null ? r.slaMin + ' min' : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p style={nota}>Venda conta no mês em que fechou (data informada), não no mês em que o lead chegou. SLA = tempo médio até o 1º contato.</p>
      </Caixa>

      <Caixa titulo={'Campanhas · gasto do mês ' + mes.split('-').reverse().join('/')}>
        <div style={{ overflowX: 'auto' }}>
          <table style={tabela}>
            <thead><tr>{['Campanha', 'Leads', 'Responderam', 'Análise', 'Vendas', 'Lead ruim', 'Gasto (R$)', 'Custo/lead', 'CAC'].map(h => <th key={h} style={th}>{h}</th>)}</tr></thead>
            <tbody>
              {rel.campanhas.map(c => (
                <tr key={c.campanha}>
                  <td style={{ ...td, textAlign: 'left', maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={c.campanha}>{c.campanha}</td>
                  <td style={td}>{c.leads}</td>
                  <td style={td}>{c.responderam} <span style={pc}>{pct(c.responderam, c.leads)}</span></td>
                  <td style={td}>{c.credito} <span style={pc}>{pct(c.credito, c.leads)}</span></td>
                  <td style={{ ...td, color: 'var(--olive)', fontWeight: 700 }}>{c.vendas}</td>
                  <td style={td}>{c.ruins} <span style={pc}>{pct(c.ruins, c.leads)}</span></td>
                  <td style={td}>{gestor
                    ? <input type="number" min={0} defaultValue={c.gasto ?? ''} onBlur={e => { const v = Number(e.target.value); if (e.target.value !== '' && v !== (c.gasto ?? -1)) void salvarGasto(c.campanha, v); }} style={{ width: 90, padding: '4px 6px', border: '1px solid var(--line)', borderRadius: 6, background: 'var(--bg)', fontSize: 12 }} />
                    : c.gasto != null ? BRL(c.gasto) : '—'}</td>
                  <td style={td}>{c.custoPorLead != null ? BRL(c.custoPorLead) : '—'}</td>
                  <td style={td}>{c.cac != null ? BRL(c.cac) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p style={nota}>Lead ruim = renda baixa, outra região, número errado, contato errado, idoso. CAC = gasto ÷ vendas da campanha.</p>
      </Caixa>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(300px,1fr))', gap: 16 }}>
        <Caixa titulo="Follow-up automático">
          <table style={tabela}>
            <thead><tr>{['Corretor', 'Entraram', 'Responderam', 'Corretor parou', 'Rodando'].map(h => <th key={h} style={th}>{h}</th>)}</tr></thead>
            <tbody>{rel.followup.porCorretor.map(f => (
              <tr key={f.corretor}><td style={{ ...td, textAlign: 'left' }}>{f.corretor}</td><td style={td}>{f.entraram}</td><td style={td}>{f.responderam} <span style={pc}>{pct(f.responderam, f.entraram)}</span></td><td style={td}>{f.corretor_parou}</td><td style={td}>{f.rodando}</td></tr>
            ))}</tbody>
          </table>
          {rel.followup.respostaPorPasso.length > 0 && <p style={nota}>Em qual mensagem o cliente mais responde: {rel.followup.respostaPorPasso.map(p => p.passo + 'ª (' + p.n + ')').join(' · ')}</p>}
        </Caixa>
        <Caixa titulo="Por que os leads são devolvidos">
          {rel.motivos.map(m => <Barra key={m.motivo} rotulo={m.motivo} n={m.n} max={Math.max(1, ...rel.motivos.map(x => x.n))} />)}
          {rel.motivos.length === 0 && <p style={nota}>Nenhuma devolução no período.</p>}
        </Caixa>
        <Caixa titulo="Horários dos cadastros">
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 90 }}>
            {Array.from({ length: 24 }, (_, h) => {
              const n = rel.horas.find(x => x.hora === h)?.n ?? 0;
              return <span key={h} title={h + 'h: ' + n} style={{ flex: 1, height: Math.max(2, (n / maxHora) * 86), background: n ? 'var(--terra)' : 'var(--line)', borderRadius: 2 }} />;
            })}
          </div>
          <p style={nota}>00h → 23h, somando todos os dias do período.</p>
        </Caixa>
        {gestor && (
          <Caixa titulo="Rebatidas no dia, por corretor">
            {rel.rebatidasHoje.map(r => <Barra key={r.corretor} rotulo={r.corretor} n={r.n} max={Math.max(1, ...rel.rebatidasHoje.map(x => x.n))} />)}
            {rel.rebatidasHoje.length === 0 && <p style={nota}>Ninguém devolveu lead hoje.</p>}
          </Caixa>
        )}
      </div>
    </div>
  );
}

const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) + '%' : '');
function Caixa({ titulo, extra, children }: { titulo: string; extra?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div style={{ border: '1px solid var(--line)', borderRadius: 12, background: 'var(--card)', padding: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <p style={{ margin: 0, fontSize: 11, letterSpacing: '.12em', textTransform: 'uppercase', color: 'var(--muted)', fontWeight: 700 }}>{titulo}</p>{extra}
      </div>
      {children}
    </div>
  );
}
function Barra({ rotulo, n, max }: { rotulo: string; n: number; max: number }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, marginBottom: 5 }}>
      <span style={{ width: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={rotulo}>{rotulo}</span>
      <span style={{ flex: 1, height: 10, background: 'var(--bg)', borderRadius: 4, overflow: 'hidden' }}><span style={{ display: 'block', height: '100%', width: (n / max) * 100 + '%', background: 'var(--terra)' }} /></span>
      <span style={{ width: 30, textAlign: 'right' }}>{n}</span>
    </div>
  );
}
const nota: React.CSSProperties = { fontSize: 11.5, color: 'var(--muted)', margin: '10px 0 0' };
const sel: React.CSSProperties = { padding: '6px 9px', border: '1px solid var(--line)', borderRadius: 7, background: 'var(--bg)', fontSize: 12 };
const tabela: React.CSSProperties = { width: '100%', borderCollapse: 'collapse', fontSize: 12.5 };
const th: React.CSSProperties = { textAlign: 'center', padding: '6px 8px', fontSize: 10.5, letterSpacing: '.05em', textTransform: 'uppercase', color: 'var(--muted)', borderBottom: '1px solid var(--line)', whiteSpace: 'nowrap' };
const td: React.CSSProperties = { textAlign: 'center', padding: '7px 8px', borderBottom: '1px solid var(--line)', whiteSpace: 'nowrap' };
const pc: React.CSSProperties = { fontSize: 10.5, color: 'var(--muted)' };
