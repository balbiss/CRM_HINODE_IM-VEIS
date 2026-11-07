import { useLayoutEffect, useRef } from 'react';

/** Campo de escrever mensagem igual ao WhatsApp: cresce conforme o texto (até ~6 linhas, depois rola),
 *  mantém as quebras de linha (antes era <input> e as mensagens prontas perdiam os "pulos de linha").
 *  Computador: Enter envia, Shift+Enter pula linha. Celular: Enter pula linha, envia pelo botão. */
export function CampoMensagem({ value, onChange, onEnviar, placeholder, padding = '12px 14px' }: {
  value: string;
  onChange: (v: string) => void;
  onEnviar: () => void;
  placeholder?: string;
  padding?: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight + 2, 150) + 'px';
  }, [value]);
  const toque = typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches;
  return (
    <textarea
      ref={ref}
      data-campo-chat
      rows={1}
      value={value}
      onChange={e => onChange(e.target.value)}
      onKeyDown={e => {
        if (e.key === 'Enter' && !e.shiftKey && !toque && !e.nativeEvent.isComposing) {
          e.preventDefault();
          onEnviar();
        }
      }}
      placeholder={placeholder}
      style={{
        flex: 1, minWidth: 0, padding, border: '1px solid var(--line)', borderRadius: 8, background: 'var(--bg)',
        fontSize: 13.5, fontFamily: 'inherit', lineHeight: 1.45, resize: 'none', overflowY: 'auto', maxHeight: 150, color: 'inherit',
      }}
    />
  );
}
