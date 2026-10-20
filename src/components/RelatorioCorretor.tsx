import { useEffect, useMemo, useState } from 'react';
import { useAppStore } from '../store/appStore';
import { useRoleInfo } from '../lib/selectors';
import { BRL } from '../lib/format';
import { apiFetch } from '../lib/api';

/** Relatório de UM corretor (GET /api/relatorios/corretor): quantos leads recebeu no período,
 *  de onde vieram e em que coluna estão hoje. Conta também os leads importados do CRM OKA,
 *  que nunca passaram pela roleta (por isso fica separado do relatório geral). */

interface RelatorioCorretorDados {
  corretorNome: string;
  periodo: { de: string; ate: string };
  total: number;
  porOrigem: { roleta: number; rebatidaPuxada: number; importados: number };
  porCampanha: { campanha: string; total: number }[];
  porDia: { data: string; total: number }[];
  porStatusAtual: { slug: string; titulo: string; total: number }[];
  vendas: { total: number; vgv: number };
  rebatidas: { total: number };
}

const hojeISO = () => new Date().toISOString().slice(0, 10);
const inicioMesISO = () => { const d = new Date(); d.setDate(1); return d.toISOString().slice(0, 10); };
const dataCurta = (iso: string) => new Date(iso + 'T00:00:00').toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
const selStyle: React.CSSProperties = { padding: '8px 11px', border: '1px solid var(--line)', borderRadius: 8, background: 'var(--card)', fontSize: 12.5 };

export function RelatorioCorretor() {
  const perfis = useAppStore(s => s.perfisRemotos);
  const token = useAppStore(s => s.token);
  const me = useAppStore(s => s.me);
  const { isManager } = useRoleInfo();

  const corretores = useMemo(() => perfis.filter(p => p.role === 'corretor'), [perfis]);
  const [corretorId, setCorretorId] = useState('');
  useEffect(() => {
    if (corretorId) return;
    if (!isManager) { if (me) setCorretorId(me.id); return; }
    if (corretores.length > 0) setCorretorId(corretores[0].id);
  }, [isManager, me, corretores, corretorId]);

  const [de, setDe] = useState(inicioMesISO());
  const [ate, setAte] = useState(hojeISO());
  const [relatorio, setRelatorio] = useState<RelatorioCorretorDados | null>(null);
  const [carregando, setCarregando] = useState(false);

  useEffect(() => {
    if (!corretorId) return;
    setCarregando(true);
    apiFetch<RelatorioCorretorDados>('/api/relatorios/corretor?corretorId=' + corretorId + '&de=' + de + '&ate=' + ate, token)
      .then(setRelatorio)
      .catch(() => setRelatorio(null))
      .finally(() => setCarregando(false));
  }, [corretorId, de, ate, token]);

  const maxCampanha = Math.max(1, ...(relatorio?.porCampanha.map(c => c.total) ?? [1]));
  const maxDia = Math.max(1, ...(relatorio?.porDia.map(d => d.total) ?? [1]));
  const maxStatus = Math.max(1, ...(relatorio?.porStatusAtual.map(s => s.total) ?? [1]));
  const convPct = relatorio && relatorio.total ? Math.round((relatorio.vendas.total / relatorio.total) * 1000) / 10 : 0;

  return (
    <div style={{ border: '1px solid var(--line)', borderRadius: 12, background: 'var(--card)', padding: 22, minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 14, flexWrap: 'wrap', marginBottom: 20 }}>
        <div>
          <h2 style={{ fontFamily: 'Newsreader,serif', fontWeight: 400, fontSize: 21, margin: '0 0 4px' }}>Relatório por corretor</h2>
          <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: 0 }}>Quantos leads recebeu, de onde vieram e o que aconteceu com eles no período.</p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          {isManager && (
            <select value={corretorId} onChange={e => setCorretorId(e.target.value)} style={selStyle}>
              {corretores.map(c => <option key={c.id} value={c.id}>{c.nome}</option>)}
            </select>
          )}
          <input type="date" value={de} onChange={e => setDe(e.target.value)} style={selStyle} />
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>até</span>
          <input type="date" value={ate} onChange={e => setAte(e.target.value)} style={selStyle} />
          <button onClick={() => { setDe(inicioMesISO()); setAte(hojeISO()); }} style={{ ...selStyle, cursor: 'pointer', fontWeight: 600 }}>Este mês</button>
        </div>
      </div>

      {carregando && <p style={{ fontSize: 13, color: 'var(--muted)' }}>Calculando…</p>}

      {!carregando && relatorio && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 14, marginBottom: 24 }}>
            {[
              { label: 'Leads recebidos', value: String(relatorio.total), delta: relatorio.porOrigem.roleta + ' pela roleta · ' + relatorio.porOrigem.rebatidaPuxada + ' puxados do bolsão · ' + relatorio.porOrigem.importados + ' importados/manuais' },
              { label: 'Vendas fechadas', value: String(relatorio.vendas.total), delta: BRL(relatorio.vendas.vgv) + ' em VGV' },
              { label: 'Taxa de conversão', value: convPct + '%', delta: 'sobre o total recebido' },
              { label: 'Rebatidos', value: String(relatorio.rebatidas.total), delta: relatorio.total ? Math.round((relatorio.rebatidas.total / relatorio.total) * 100) + '% do que recebeu' : '—' },
            ].map(k => (
              <div key={k.label} style={{ border: '1px solid var(--line)', borderRadius: 10, background: 'var(--bg)', padding: 16 }}>
                <p style={{ fontSize: 10.5, letterSpacing: '.12em', textTransform: 'uppercase', color: 'var(--muted)', margin: '0 0 10px' }}>{k.label}</p>
                <p style={{ fontFamily: 'Newsreader,serif', fontSize: 30, lineHeight: 1, margin: '0 0 8px' }}>{k.value}</p>
                <p style={{ fontSize: 11.5, color: 'var(--muted)', margin: 0 }}>{k.delta}</p>
              </div>
            ))}
          </div>

          <div className="grid2" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
            <div style={{ minWidth: 0 }}>
              <p style={{ fontSize: 13, fontWeight: 700, margin: '0 0 12px' }}>Por anúncio / campanha</p>
              {relatorio.porCampanha.length === 0 && <p style={{ fontSize: 12.5, color: 'var(--muted)' }}>Sem leads no período.</p>}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {relatorio.porCampanha.map(c => (
                  <div key={c.campanha}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, marginBottom: 4 }}>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 220 }}>{c.campanha}</span>
                      <span style={{ color: 'var(--muted)' }}>{c.total}</span>
                    </div>
                    <div style={{ height: 7, background: 'var(--bg)', borderRadius: 5, overflow: 'hidden' }}><div style={{ height: '100%', width: (c.total / maxCampanha * 100) + '%', background: 'var(--terra)', borderRadius: 5 }} /></div>
                  </div>
                ))}
              </div>
            </div>

            <div style={{ minWidth: 0 }}>
              <p style={{ fontSize: 13, fontWeight: 700, margin: '0 0 12px' }}>Status atual desses leads</p>
              {relatorio.porStatusAtual.length === 0 && <p style={{ fontSize: 12.5, color: 'var(--muted)' }}>Sem leads no período.</p>}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {relatorio.porStatusAtual.map(s => (
                  <div key={s.slug}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, marginBottom: 4 }}>
                      <span>{s.titulo}</span><span style={{ color: 'var(--muted)' }}>{s.total}</span>
                    </div>
                    <div style={{ height: 7, background: 'var(--bg)', borderRadius: 5, overflow: 'hidden' }}><div style={{ height: '100%', width: (s.total / maxStatus * 100) + '%', background: s.slug === 'venda' ? 'var(--olive)' : s.slug === 'rebatida' ? 'var(--terra)' : 'var(--muted)', borderRadius: 5 }} /></div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <p style={{ fontSize: 13, fontWeight: 700, margin: '24px 0 12px' }}>Por dia</p>
          {relatorio.porDia.length === 0 && <p style={{ fontSize: 12.5, color: 'var(--muted)' }}>Sem leads no período.</p>}
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 4, height: 90, overflowX: 'auto', paddingBottom: 4 }}>
            {relatorio.porDia.map(d => (
              <div key={d.data} title={dataCurta(d.data) + ': ' + d.total + ' leads'} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, flex: 'none', width: 26 }}>
                <span style={{ fontSize: 10, color: 'var(--muted)' }}>{d.total}</span>
                <div style={{ width: 14, height: Math.max(3, (d.total / maxDia) * 56), background: 'var(--terra)', borderRadius: 3 }} />
                <span style={{ fontSize: 9.5, color: 'var(--muted)' }}>{dataCurta(d.data)}</span>
              </div>
            ))}
          </div>
        </>
      )}

      {!carregando && !relatorio && <p style={{ fontSize: 13, color: 'var(--muted)' }}>{corretorId ? 'Não foi possível carregar o relatório.' : 'Nenhum corretor cadastrado ainda.'}</p>}
    </div>
  );
}
