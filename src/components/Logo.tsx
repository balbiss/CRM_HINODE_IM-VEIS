/**
 * Logomarca Hinode Imóveis — losango simples em terracota, o mesmo mark que já era usado no
 * CRM Hinode antes deste componente existir (Sidebar/Login originais). Mantém a MESMA API do
 * componente que veio do fork (markSize/wordSize/showCrm/showTagline/gap, size/chip) pra não
 * precisar mexer em nenhum call site.
 *
 * - <LogoMark/>  → só o losango
 * - <Logo/>      → losango + wordmark "HINODE IMÓVEIS" (+ linha CRM, + tagline opcionais)
 */

export function LogoMark({ size = 40, chip = false }: { size?: number; chip?: boolean }) {
  const diamond = (
    <span
      style={{
        display: 'block', width: size * 0.35, height: size * 0.35,
        background: 'var(--terra)', transform: 'rotate(45deg)', flex: 'none',
      }}
    />
  );
  if (!chip) {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: size, height: size, flex: 'none' }}>
        {diamond}
      </span>
    );
  }
  return (
    <span
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: size, height: size,
        borderRadius: size * 0.24, background: 'var(--side)', flex: 'none',
      }}
    >
      {diamond}
    </span>
  );
}

export default function Logo({
  markSize = 34,
  wordSize = 17,
  showCrm = true,
  showTagline = false,
  gap = 13,
}: {
  markSize?: number;
  wordSize?: number;
  showCrm?: boolean;
  showTagline?: boolean;
  gap?: number;
}) {
  const serif = 'Newsreader, serif';
  const sans = 'Manrope, system-ui, sans-serif';
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap, whiteSpace: 'nowrap' }}>
      <LogoMark size={markSize} />
      <span style={{ display: 'inline-flex', flexDirection: 'column', lineHeight: 1 }}>
        <span style={{ fontFamily: serif, fontWeight: 400, fontSize: wordSize, letterSpacing: '.14em', textTransform: 'uppercase' }}>
          Hinode<span style={{ color: 'var(--terra)' }}>&nbsp;Imóveis</span>
        </span>
        {showCrm && (
          <span style={{ display: 'flex', alignItems: 'center', gap: wordSize * 0.4, marginTop: wordSize * 0.34 }}>
            <span style={{ flex: 1, height: 1, background: 'currentColor', opacity: 0.35 }} />
            <span style={{ fontFamily: sans, fontWeight: 700, fontSize: wordSize * 0.44, letterSpacing: '.4em', textTransform: 'uppercase', color: 'var(--terra)', marginRight: '-.4em' }}>
              CRM
            </span>
            <span style={{ flex: 1, height: 1, background: 'currentColor', opacity: 0.35 }} />
          </span>
        )}
        {showTagline && (
          <span style={{ fontFamily: sans, fontWeight: 500, fontSize: wordSize * 0.34, letterSpacing: '.06em', textTransform: 'uppercase', marginTop: wordSize * 0.4, opacity: 0.85 }}>
            <b style={{ color: 'var(--terra)' }}>Leads</b> atendidos. <b style={{ color: 'var(--terra)' }}>Visitas</b> agendadas. <b style={{ color: 'var(--terra)' }}>Negócios</b> fechados.
          </span>
        )}
      </span>
    </span>
  );
}
