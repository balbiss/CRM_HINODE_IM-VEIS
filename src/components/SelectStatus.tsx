import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';

export interface OpcaoStatus { id: string; titulo: string }

/** Lista de status do card no jeito que o dono pediu (11-07): em MAIÚSCULO, ordem alfabética,
 *  o status atual com ✓ à esquerda e a linha em azul (igual ao menu do Mac/iPhone). */
export function SelectStatus({ value, opcoes, onChange, disabled, style }: {
  value: string;
  opcoes: OpcaoStatus[];
  onChange: (id: string) => void;
  disabled?: boolean;
  style?: React.CSSProperties;
}) {
  const [aberto, setAberto] = useState(false);
  const caixa = useRef<HTMLDivElement>(null);
  const lista = useRef<HTMLDivElement>(null);
  const atual = opcoes.find(o => o.id === value);

  useEffect(() => {
    if (!aberto) return;
    const fora = (e: MouseEvent | TouchEvent) => { if (!caixa.current?.contains(e.target as Node)) setAberto(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setAberto(false); };
    document.addEventListener('mousedown', fora);
    document.addEventListener('touchstart', fora);
    document.addEventListener('keydown', esc);
    // já abre rolado até o status atual
    lista.current?.querySelector('[data-sel="1"]')?.scrollIntoView({ block: 'center' });
    return () => {
      document.removeEventListener('mousedown', fora);
      document.removeEventListener('touchstart', fora);
      document.removeEventListener('keydown', esc);
    };
  }, [aberto]);

  return (
    <div ref={caixa} style={{ position: 'relative' }}>
      <button type="button" disabled={disabled} onClick={() => setAberto(v => !v)} aria-haspopup="listbox" aria-expanded={aberto}
        style={{ ...style, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, width: '100%', textAlign: 'left', cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.6 : 1 }}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{(atual?.titulo ?? '—').toUpperCase()}</span>
        <ChevronDown size={15} style={{ flex: 'none', opacity: 0.6 }} />
      </button>
      {aberto && (
        <div ref={lista} role="listbox" style={{
          position: 'absolute', zIndex: 60, top: 'calc(100% + 4px)', left: 0, right: 0, minWidth: 220, maxHeight: 300, overflowY: 'auto',
          background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 10, boxShadow: '0 12px 32px rgba(0,0,0,.18)', padding: 5,
        }}>
          {opcoes.map(o => {
            const sel = o.id === value;
            return (
              <button key={o.id} type="button" role="option" aria-selected={sel} data-sel={sel ? '1' : undefined}
                onClick={() => { setAberto(false); if (!sel) onChange(o.id); }}
                onMouseEnter={e => { if (!sel) e.currentTarget.style.background = 'var(--bg)'; }}
                onMouseLeave={e => { if (!sel) e.currentTarget.style.background = 'none'; }}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', border: 'none', borderRadius: 6,
                  padding: '8px 10px', fontSize: 13, fontWeight: sel ? 700 : 500, cursor: 'pointer',
                  background: sel ? '#2F6FED' : 'none', color: sel ? '#fff' : 'var(--ink)',
                }}>
                <span style={{ width: 16, flex: 'none', display: 'flex' }}>{sel && <Check size={15} strokeWidth={3} />}</span>
                {o.titulo.toUpperCase()}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
