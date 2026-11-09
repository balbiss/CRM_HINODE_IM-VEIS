export const BRL = (n: number) => 'R$ ' + n.toLocaleString('pt-BR', { maximumFractionDigits: 0 });

const ACCENT_MAP: Record<string, string> = {
  a: 'áàâã', e: 'éèê', i: 'íìî', o: 'óòôõ', u: 'úùû', c: 'ç',
};
export const stripAccents = (s: string) => {
  let out = s;
  for (const [plain, accented] of Object.entries(ACCENT_MAP)) {
    out = out.replace(new RegExp('[' + accented + ']', 'g'), plain);
  }
  return out;
};

export const ini = (n: string) => n.split(' ').map(p => p[0]).slice(0, 2).join('');

export const dayLabel = (off: number) => {
  if (off <= 0) return 'Hoje';
  if (off === 1) return 'Ontem';
  const d = new Date();
  d.setDate(d.getDate() - off);
  return d
    .toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: off > 300 ? 'numeric' : undefined })
    .replace('.', '');
};

export const stamp = (off: number, hora: string) => dayLabel(off) + ' · ' + hora;

export const PILL =
  'font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;padding:4px 8px;border-radius:20px;white-space:nowrap;';

export const canalPill = (c: string) => {
  if (c === 'WhatsApp') return PILL + 'background:var(--oliveSoft);color:var(--olive)';
  if (c === 'Instagram' || c === 'Facebook') return PILL + 'background:var(--terraSoft);color:var(--terra)';
  return PILL + 'border:1px solid var(--line);color:var(--muted)';
};

export const thumb = (i: number, size: number) =>
  'width:' + size + 'px;height:' + size + 'px;border-radius:7px;flex:none;background:repeating-linear-gradient(' +
  (35 + i * 20) + 'deg,var(--line) 0 4px,var(--bg) 4px 9px);border:1px solid var(--line);display:block';

/** Telefone pra leitura: +5563992179535 → (63) 99217-9535. Número estrangeiro/estranho volta como veio. */
export function fmtTelefone(t: string | null | undefined): string {
  if (!t) return '';
  let d = t.replace(/\D/g, '');
  if (d.length >= 12 && d.startsWith('55')) d = d.slice(2);
  if (d.length === 11) return '(' + d.slice(0, 2) + ') ' + d.slice(2, 7) + '-' + d.slice(7);
  if (d.length === 10) return '(' + d.slice(0, 2) + ') ' + d.slice(2, 6) + '-' + d.slice(6);
  return t;
}
