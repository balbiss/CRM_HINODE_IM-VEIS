import { useMemo, useState } from 'react';
import { useAppStore } from '../store/appStore';
import { useRoleInfo } from '../lib/selectors';
import { foraDoKanban } from '../lib/remoteLeads';

/** Análise de Crédito (v1): leads na coluna ANÁLISE DE CRÉDITO. Sem "Visto" da gestão = alerta vermelho.
 *  Dono/gerente: "Visto" (documentação auditada) ou "Retornar com pendência" (volta pro corretor em PENDENTE). */
export default function Credito() {
  const allLeads = useAppStore(s => s.leads);
  const colunas = useAppStore(s => s.colunasRemotas);
  const openLead = useAppStore(s => s.openLead);
  const creditoVisto = useAppStore(s => s.creditoVisto);
  const creditoPendencia = useAppStore(s => s.creditoPendencia);
  const { isManager, meNome } = useRoleInfo();
  const [pendenciaDe, setPendenciaDe] = useState<string | null>(null);
  const [obs, setObs] = useState('');

  const colCredito = colunas.find(c => c.slug === 'credito')?.id;
  const rows = useMemo(() => allLeads
    .filter(l => l.colunaId === colCredito && !foraDoKanban(l) && (isManager || l.corretor === meNome))
    .sort((a, b) => (a.creditoAprovadoEm ? 1 : 0) - (b.creditoAprovadoEm ? 1 : 0) || +new Date(a.entrouNaColunaEm ?? 0) - +new Date(b.entrouNaColunaEm ?? 0)),
  [allLeads, colCredito, isManager, meNome]);
  const semVisto = rows.filter(r => !r.creditoAprovadoEm).length;
  const quando = (iso?: string | null) => (iso ? new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <p style={{ fontSize: 11, letterSpacing: '.18em', textTransform: 'uppercase', color: 'var(--muted)', margin: '0 0 4px' }}>Financeiro</p>
        <h1 style={{ fontFamily: 'Newsreader,serif', fontWeight: 400, fontSize: 24, margin: 0, lineHeight: 1.2 }}>Análise de Crédito</h1>
        <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: '5px 0 0', maxWidth: 640, lineHeight: 1.5 }}>
          Todo lead que entra nessa coluna fica com alerta vermelho até o dono ou o gerente dar <strong>Visto</strong> (documentação auditada)
          ou <strong>Retornar com pendência</strong> (volta pro corretor com a nota do que falta). Enquanto estiver aqui, de hora em hora
          todos recebem o lembrete de conferir se o banco já respondeu.
        </p>
      </div>
      {semVisto > 0 && (
        <div style={{ border: '1px solid #DC2626', background: 'rgba(220,38,38,.07)', borderRadius: 12, padding: '14px 18px', marginBottom: 16, fontSize: 13.5 }}>
          <strong style={{ color: '#DC2626' }}>{semVisto} pasta(s) aguardando o visto da gestão.</strong>
        </div>
      )}
      <div style={{ border: '1px solid var(--line)', borderRadius: 12, background: 'var(--card)', overflow: 'hidden' }}>
        {rows.map(l => {
          const alerta = !l.creditoAprovadoEm;
          return (
            <div key={l.id} className="data-row" style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 20px', borderBottom: '1px solid var(--line)', flexWrap: 'wrap', borderLeft: '4px solid ' + (alerta ? '#DC2626' : 'var(--olive)') }}>
              <button onClick={() => openLead(l.id)} style={{ flex: 1, minWidth: 200, textAlign: 'left', background: 'none', border: 'none', padding: 0 }}>
                <span style={{ display: 'block', fontSize: 14, fontWeight: 700, color: 'var(--ink)' }}>{l.nome}</span>
                <span style={{ display: 'block', fontSize: 12, color: 'var(--muted)', marginTop: 3 }}>{l.corretor || 'Sem corretor'} · entrou {quando(l.entrouNaColunaEm)}</span>
              </button>
              <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.05em', textTransform: 'uppercase', padding: '4px 9px', borderRadius: 20, background: alerta ? 'rgba(220,38,38,.1)' : 'var(--oliveSoft)', color: alerta ? '#DC2626' : 'var(--olive)' }}>
                {alerta ? 'Aguardando visto' : 'Visto ' + quando(l.creditoAprovadoEm)}
              </span>
              {isManager && (
                <div style={{ display: 'flex', gap: 6 }}>
                  {alerta && <button onClick={() => creditoVisto(l.id)} style={{ padding: '8px 14px', border: 'none', borderRadius: 8, background: 'var(--olive)', color: '#fff', fontSize: 12.5, fontWeight: 600 }}>Visto</button>}
                  <button onClick={() => { setPendenciaDe(l.id); setObs(''); }} style={{ padding: '8px 12px', border: '1px solid var(--line)', borderRadius: 8, background: 'none', fontSize: 12.5, color: 'var(--terra)', fontWeight: 600 }}>Retornar com pendência</button>
                </div>
              )}
            </div>
          );
        })}
        {rows.length === 0 && <p style={{ padding: '36px 20px', textAlign: 'center', fontSize: 13, color: 'var(--muted)', margin: 0 }}>Nenhum lead em Análise de Crédito agora.</p>}
      </div>

      {pendenciaDe && (
        <div onClick={() => setPendenciaDe(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(8,17,31,.5)', zIndex: 70, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
          <div onClick={e => e.stopPropagation()} style={{ width: '100%', maxWidth: 420, background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 14, padding: 22 }}>
            <p style={{ fontFamily: 'Newsreader,serif', fontSize: 20, margin: 0 }}>O que está faltando?</p>
            <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: '6px 0 12px' }}>Aparece pro corretor num aviso na tela. O lead volta pra coluna PENDENTE.</p>
            <textarea autoFocus value={obs} onChange={e => setObs(e.target.value)} rows={4} style={{ width: '100%', padding: '10px 12px', border: '1px solid var(--line)', borderRadius: 8, background: 'var(--bg)', fontSize: 13.5, boxSizing: 'border-box', resize: 'vertical' }} />
            <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
              <button disabled={!obs.trim()} onClick={async () => { if (await creditoPendencia(pendenciaDe, obs.trim())) setPendenciaDe(null); }} style={{ flex: 1, padding: '11px', border: 'none', borderRadius: 8, background: 'var(--terra)', color: '#fff', fontSize: 13, fontWeight: 600, opacity: obs.trim() ? 1 : 0.5 }}>Devolver ao corretor</button>
              <button onClick={() => setPendenciaDe(null)} style={{ padding: '11px 16px', border: '1px solid var(--line)', borderRadius: 8, background: 'none', fontSize: 13 }}>Cancelar</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
