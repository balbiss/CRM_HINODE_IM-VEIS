import { useEffect, useState } from 'react';
import { apiFetch } from '../lib/api';
import { useAppStore } from '../store/appStore';

export type ResultadoFluxo = {
  referencia: string; valorImovel: number; financiamento: number; subsidio: number; fgts: number;
  entrada: number; ato: number; baloes: { descricao: string; mes: string; valor: number }[]; totalBaloes: number;
  posChaves: { parcelas: number; valor: number; total: number };
  aParcelar: number; meses: number; parcela: number; primeiraParcela: string | null; ultimaParcela: string | null;
  cronograma: { mes: string; parcela: number; balao: number; descricaoBalao?: string; total: number }[];
  alertas: string[];
};
export type FluxoPagamento = {
  id: string; empreendimento: string; construtora: string; observacoes: string; ativo: boolean;
  config: Record<string, unknown>; calculo: ResultadoFluxo; atualizadoEm: string;
};

export const brl = (n: number) => (Number(n) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
export const mesBr = (m?: string | null) => { if (!m) return '—'; const [a, b] = m.split('-'); return MESES[Number(b) - 1] + '/' + a; };

const lbl: React.CSSProperties = { display: 'block', fontSize: 11, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--muted)', margin: '0 0 5px' };
const inp: React.CSSProperties = { width: '100%', padding: '9px 11px', border: '1px solid var(--line)', borderRadius: 8, background: 'var(--bg)', fontSize: 13.5, boxSizing: 'border-box' };

/** Resumo do mês de um fluxo calculado (usado na lista e na simulação). */
export function ResumoFluxo({ r, cronograma = false }: { r: ResultadoFluxo; cronograma?: boolean }) {
  return (
    <div style={{ fontSize: 13 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(140px,1fr))', gap: 8, marginBottom: 8 }}>
        <Caixa t="Entrada" v={brl(r.entrada)} />
        {r.ato > 0 && <Caixa t="Ato / sinal" v={brl(r.ato)} />}
        <Caixa t="Parcelas" v={r.meses > 0 ? `${r.meses}x de ${brl(r.parcela)}` : '—'} destaque />
        {r.totalBaloes > 0 && <Caixa t={`Balões (${r.baloes.length})`} v={brl(r.totalBaloes)} />}
        {r.posChaves.parcelas > 0 && <Caixa t="Pós-chaves" v={`${r.posChaves.parcelas}x de ${brl(r.posChaves.valor)}`} />}
      </div>
      {r.meses > 0 && <p style={{ margin: '0 0 6px', color: 'var(--muted)', fontSize: 12 }}>Parcelas de {mesBr(r.primeiraParcela)} a {mesBr(r.ultimaParcela)} · calculado para {mesBr(r.referencia)}</p>}
      {r.alertas.map(a => <p key={a} style={{ margin: '0 0 4px', color: '#B7791F', fontSize: 12.5 }}>⚠️ {a}</p>)}
      {cronograma && r.cronograma.length > 0 && (
        <details style={{ marginTop: 6 }}>
          <summary style={{ cursor: 'pointer', fontSize: 12.5, color: 'var(--muted)' }}>Ver mês a mês</summary>
          <div style={{ maxHeight: 260, overflow: 'auto', marginTop: 6, border: '1px solid var(--line)', borderRadius: 8 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
              <thead><tr style={{ background: 'var(--bg)' }}>{['Mês', 'Parcela', 'Balão', 'Total'].map(h => <th key={h} style={{ textAlign: 'left', padding: '6px 10px', fontWeight: 600 }}>{h}</th>)}</tr></thead>
              <tbody>{r.cronograma.map(c => (
                <tr key={c.mes} style={{ borderTop: '1px solid var(--line)' }}>
                  <td style={{ padding: '5px 10px' }}>{mesBr(c.mes)}</td><td style={{ padding: '5px 10px' }}>{brl(c.parcela)}</td>
                  <td style={{ padding: '5px 10px' }}>{c.balao ? brl(c.balao) + (c.descricaoBalao ? ' · ' + c.descricaoBalao : '') : '—'}</td>
                  <td style={{ padding: '5px 10px', fontWeight: 600 }}>{brl(c.total)}</td>
                </tr>))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </div>
  );
}
function Caixa({ t, v, destaque }: { t: string; v: string; destaque?: boolean }) {
  return (
    <div style={{ border: '1px solid var(--line)', borderRadius: 8, padding: '8px 10px', background: destaque ? 'var(--terra)' : 'var(--card)', color: destaque ? '#fff' : undefined }}>
      <div style={{ fontSize: 10.5, letterSpacing: '.06em', textTransform: 'uppercase', opacity: 0.75 }}>{t}</div>
      <div style={{ fontWeight: 700, fontSize: 14 }}>{v}</div>
    </div>
  );
}

/** Janela "Simular fluxo": o corretor escolhe o empreendimento, ajusta os valores do cliente e leva a mensagem pronta. */
export function SimularFluxo({ fluxoInicial, onUsarTexto, onFechar }: { fluxoInicial?: string; onUsarTexto?: (t: string) => void; onFechar: () => void }) {
  const token = useAppStore(s => s.token);
  const [fluxos, setFluxos] = useState<FluxoPagamento[] | null>(null);
  const [id, setId] = useState(fluxoInicial || '');
  const [sim, setSim] = useState<Record<string, string>>({});
  const [res, setRes] = useState<{ resultado: ResultadoFluxo; texto: string } | null>(null);
  const [erro, setErro] = useState('');
  const [copiado, setCopiado] = useState(false);

  useEffect(() => {
    apiFetch<FluxoPagamento[]>('/api/conhecimento/fluxos', token).then(fs => {
      const ativos = fs.filter(f => f.ativo); setFluxos(ativos);
      if (!fluxoInicial && ativos[0]) setId(ativos[0].id);
    }).catch(() => setFluxos([]));
  }, [token, fluxoInicial]);

  const fluxo = fluxos?.find(f => f.id === id);
  useEffect(() => { // ao trocar de empreendimento, preenche com os valores padrão dele
    if (!fluxo) return;
    const c = fluxo.config as Record<string, unknown>;
    setSim(Object.fromEntries(['valorImovel', 'financiamento', 'subsidio', 'fgts', 'ato'].map(k => [k, c[k] != null ? String(c[k]) : ''])));
  }, [fluxo?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!id) return;
    const t = setTimeout(() => {
      const simulacao = Object.fromEntries(Object.entries(sim).filter(([, v]) => v !== '').map(([k, v]) => [k, Number(v)]));
      apiFetch<{ resultado: ResultadoFluxo; texto: string }>(`/api/conhecimento/fluxos/${id}/simular`, token, { method: 'POST', body: JSON.stringify({ simulacao }) })
        .then(r => { setRes(r); setErro(''); }).catch(e => setErro((e as Error).message));
    }, 350);
    return () => clearTimeout(t);
  }, [id, sim, token]);

  const campos: [string, string][] = [['valorImovel', 'Valor do imóvel'], ['financiamento', 'Financiamento'], ['subsidio', 'Subsídio'], ['fgts', 'FGTS'], ['ato', 'Ato / sinal']];
  return (
    <div onClick={onFechar} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div onClick={e => e.stopPropagation()} style={{ background: 'var(--card)', borderRadius: 14, width: 'min(640px,100%)', maxHeight: '92vh', overflow: 'auto', padding: 22 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <h3 style={{ margin: 0, fontFamily: 'Newsreader,serif', fontWeight: 400, fontSize: 21 }}>Simular fluxo de pagamento</h3>
          <button onClick={onFechar} style={{ border: '1px solid var(--line)', background: 'none', width: 30, height: 30, borderRadius: 8 }}>×</button>
        </div>
        {fluxos === null ? <p style={{ color: 'var(--muted)' }}>Carregando…</p> : fluxos.length === 0 ? (
          <p style={{ color: 'var(--muted)' }}>Nenhum fluxo de pagamento cadastrado ainda. O dono ou gerente cadastra em <b>Base de Conhecimento → Fluxos de pagamento</b>.</p>
        ) : (
          <>
            <label style={lbl}>Empreendimento</label>
            <select value={id} onChange={e => setId(e.target.value)} style={{ ...inp, marginBottom: 12 }}>
              {fluxos.map(f => <option key={f.id} value={f.id}>{f.empreendimento}{f.construtora ? ' — ' + f.construtora : ''}</option>)}
            </select>
            <p style={{ fontSize: 12, color: 'var(--muted)', margin: '0 0 8px' }}>Ajuste com os valores do cliente (financiamento e subsídio aprovados, FGTS…). Em branco = valor padrão do empreendimento.</p>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 10, marginBottom: 14 }}>
              {campos.map(([k, t]) => (
                <div key={k}><label style={lbl}>{t}</label>
                  <input type="number" min={0} step="0.01" value={sim[k] ?? ''} onChange={e => setSim(s => ({ ...s, [k]: e.target.value }))} style={inp} /></div>
              ))}
            </div>
            {erro && <p style={{ color: '#C0392B', fontSize: 13 }}>{erro}</p>}
            {res && <ResumoFluxo r={res.resultado} cronograma />}
            {res && (
              <>
                <label style={{ ...lbl, marginTop: 14 }}>Mensagem pronta</label>
                <textarea readOnly value={res.texto} rows={8} style={{ ...inp, fontFamily: 'inherit', resize: 'vertical' }} />
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 10 }}>
                  <button onClick={() => { navigator.clipboard?.writeText(res.texto).then(() => { setCopiado(true); setTimeout(() => setCopiado(false), 1500); }); }} style={{ padding: '9px 14px', border: '1px solid var(--line)', borderRadius: 8, background: 'none', fontSize: 13 }}>{copiado ? 'Copiado ✓' : 'Copiar'}</button>
                  {onUsarTexto && <button onClick={() => { onUsarTexto(res.texto); onFechar(); }} style={{ padding: '9px 14px', border: 'none', borderRadius: 8, background: 'var(--terra)', color: '#fff', fontSize: 13, fontWeight: 600 }}>Colocar no chat</button>}
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
