import { useState } from 'react';
import { IconeFacebook, IconeInstagram, IconeSite, IconeWhatsapp } from './IconesMarca';

// só palavras com letra/número ("TESTE - Lead" → "TL", não "T-")
const iniciais = (n: string) => n.trim().split(/\s+/).filter(p => /[\p{L}\p{N}]/u.test(p)).slice(0, 2).map(p => p.match(/[\p{L}\p{N}]/u)?.[0] || '').join('').toUpperCase() || '?';

/** Avatar redondo do lead, pela origem:
 *  - Facebook (formulário) → logo do Facebook · Instagram → logo do Instagram · Site → ícone de site;
 *  - WhatsApp e o resto → foto real do perfil do WhatsApp (quando tem) ou as iniciais;
 *    lead de WhatsApp ganha um selo verde no canto. */
export function ChatAvatar({ nome, foto, size = 38, canal }: { nome: string; foto?: string | null; size?: number; canal?: string | null }) {
  const [erro, setErro] = useState(false);
  const redondo: React.CSSProperties = { width: size, height: size, borderRadius: '50%', flex: 'none', display: 'grid', placeItems: 'center' };

  if (canal === 'Facebook') {
    return <span title="Veio de formulário do Facebook" style={{ ...redondo, background: '#fff', boxShadow: 'inset 0 0 0 1px var(--line)' }}><IconeFacebook size={size * 0.78} /></span>;
  }
  if (canal === 'Instagram') {
    return <span title="Veio do Instagram" style={{ ...redondo, background: 'radial-gradient(circle at 30% 107%, #fdf497 0%, #fd5949 45%, #d6249f 60%, #285AEB 90%)' }}><IconeInstagram size={size * 0.56} /></span>;
  }
  if (canal === 'Site') {
    return <span title="Veio do site" style={{ ...redondo, background: 'var(--terra)' }}><IconeSite size={size * 0.56} color="#fff" /></span>;
  }

  const base = foto && !erro
    ? <img src={foto} alt="" width={size} height={size} loading="lazy" onError={() => setErro(true)}
        style={{ width: size, height: size, borderRadius: '50%', objectFit: 'cover', display: 'block' }} />
    : <span style={{ ...redondo, fontSize: size * 0.33, fontWeight: 700, background: 'var(--terraSoft)', color: 'var(--terra)' }}>{iniciais(nome)}</span>;
  if (canal !== 'WhatsApp') return <span style={{ flex: 'none', display: 'block' }}>{base}</span>;

  const selo = Math.max(14, Math.round(size * 0.4));
  return (
    <span title="Veio do WhatsApp" style={{ position: 'relative', flex: 'none', display: 'block', width: size, height: size }}>
      {base}
      <span style={{ position: 'absolute', right: -2, bottom: -2, width: selo, height: selo, borderRadius: '50%', background: '#25D366', display: 'grid', placeItems: 'center', boxShadow: '0 0 0 2px var(--card)' }}>
        <IconeWhatsapp size={selo * 0.62} color="#fff" />
      </span>
    </span>
  );
}
