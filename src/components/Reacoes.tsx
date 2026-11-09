/** Reações do WhatsApp (👍❤️...) penduradas embaixo do balão, como no celular. */
export function Reacoes({ reacoes, out }: { reacoes?: { emoji: string; de: 'lead' | 'equipe' }[]; out: boolean }) {
  if (!reacoes?.length) return null;
  return (
    <span style={{ display: 'flex', justifyContent: out ? 'flex-start' : 'flex-end', margin: '3px -6px -10px' }}>
      <span title={reacoes.map(r => (r.de === 'lead' ? 'Cliente' : 'Você') + ': ' + r.emoji).join(' · ')}
        style={{ display: 'inline-flex', gap: 2, padding: '2px 6px', borderRadius: 12, background: 'var(--card)', border: '1px solid var(--line)', boxShadow: '0 1px 2px rgba(0,0,0,.12)', fontSize: 14, lineHeight: 1.2 }}>
        {reacoes.map((r, i) => <span key={i}>{r.emoji}</span>)}
      </span>
    </span>
  );
}
