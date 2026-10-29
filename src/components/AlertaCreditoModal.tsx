import { useAppStore } from '../store/appStore';

const TITULOS: Record<string, string> = {
  nova_analise_credito: 'Nova pasta em Análise de Crédito',
  analise_credito_pendencia: 'Análise retornada com pendência',
  analise_credito_lembrete: 'Lembrete: Análise de Crédito',
};

/** Modal bloqueante da v1 pros avisos de crédito: só some com "Ver lead" ou "OK, ciente". Um por vez. */
export function AlertaCreditoModal() {
  const alertas = useAppStore(s => s.alertasModal);
  const fechar = useAppStore(s => s.fecharAlertaModal);
  const openLead = useAppStore(s => s.openLead);
  const a = alertas[0];
  if (!a) return null;
  const lembrete = a.tipo === 'analise_credito_lembrete';
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(8,17,31,.6)', zIndex: 90, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div role="alertdialog" style={{ width: '100%', maxWidth: 420, background: 'var(--card)', border: '2px solid ' + (lembrete ? 'var(--terra)' : '#DC2626'), borderRadius: 14, padding: 24, animation: 'fadeUp .16s ease' }}>
        <p style={{ fontSize: 11, letterSpacing: '.14em', textTransform: 'uppercase', color: lembrete ? 'var(--terra)' : '#DC2626', fontWeight: 700, margin: '0 0 8px' }}>{TITULOS[a.tipo] ?? 'Aviso'}</p>
        <p style={{ fontFamily: 'Newsreader,serif', fontSize: 20, lineHeight: 1.3, margin: 0 }}>{a.titulo}</p>
        {a.texto && <p style={{ fontSize: 13.5, lineHeight: 1.5, margin: '12px 0 0', padding: '10px 12px', borderRadius: 8, background: 'var(--bg)', border: '1px solid var(--line)' }}>{a.texto}</p>}
        {alertas.length > 1 && <p style={{ fontSize: 12, color: 'var(--muted)', margin: '12px 0 0' }}>+ {alertas.length - 1} aviso(s) na fila</p>}
        <div style={{ display: 'flex', gap: 8, marginTop: 20 }}>
          {a.leadId && (
            <button onClick={() => { const id = a.leadId!; fechar(a.id); openLead(id); }} style={{ flex: 1, padding: '11px 16px', border: 'none', borderRadius: 8, background: 'var(--terra)', color: '#fff', fontSize: 13, fontWeight: 600 }}>Ver lead</button>
          )}
          <button onClick={() => fechar(a.id)} style={{ flex: 1, padding: '11px 16px', border: '1px solid var(--line)', borderRadius: 8, background: 'none', fontSize: 13, fontWeight: 600 }}>OK, ciente</button>
        </div>
      </div>
    </div>
  );
}
