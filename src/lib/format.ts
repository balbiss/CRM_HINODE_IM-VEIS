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

/** Quantos dias de CALENDÁRIO (no fuso do aparelho) a data ficou pra trás: ontem 17h vista hoje 10h = 1.
 *  (Antes contava períodos de 24h e mensagem de ontem aparecia como "Hoje" — Vitor 13/11.) */
export const diasAtras = (d: Date, agora = new Date()) => {
  const meiaNoite = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  return Math.max(0, Math.round((meiaNoite(agora) - meiaNoite(d)) / 86400000));
};

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

/** Texto pra comparar em busca: minúsculo, sem acento (á→a, ç→c), espaços normalizados. */
export const normalizarBusca = (s: string) =>
  (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

/** Distância de edição (letras trocadas/faltando/sobrando), parando cedo quando passa do limite. */
function distancia(a: string, b: string, limite: number): number {
  if (Math.abs(a.length - b.length) > limite) return limite + 1;
  let ant2: number[] = [];
  let ant = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let menor = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(ant[j] + 1, cur[j - 1] + 1, ant[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      // duas letras trocadas de lugar ("marai" → "maria") contam como 1 erro só
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) cur[j] = Math.min(cur[j], ant2[j - 2] + 1);
      if (cur[j] < menor) menor = cur[j];
    }
    if (menor > limite) return limite + 1;
    ant2 = ant;
    ant = cur;
  }
  return ant[b.length];
}

/** Uma palavra digitada "bate" com alguma palavra do nome: começo igual, ou parecida (1 letra errada a
 *  partir de 4 letras, 2 a partir de 7 — "joao" acha "João", "mrcia" acha "Márcia", "ferreria" acha "Ferreira"). */
function palavraBate(t: string, palavras: string[]): boolean {
  const tol = t.length >= 7 ? 2 : t.length >= 4 ? 1 : 0;
  return palavras.some(p => p.startsWith(t) || (tol > 0 && (
    distancia(t, p, tol) <= tol || (p.length > t.length && distancia(t, p.slice(0, t.length), tol) <= tol))));
}

/** Nota da busca por nome: 3 = trecho igual, 2 = todas as palavras pelo começo (qualquer ordem),
 *  1 = parecido (erro de digitação), 0 = não bate. */
export function notaBuscaNome(nome: string, q: string): number {
  const n = normalizarBusca(nome);
  const t = normalizarBusca(q).replace(/[^a-z0-9 ]/g, ' ').trim();
  if (!t || !/[a-z]/.test(t)) return 0;
  if (n.includes(t)) return 3;
  const palavras = n.split(/[^a-z0-9]+/).filter(Boolean);
  const termos = t.split(' ').filter(x => x.length >= 2 || t.length < 3);
  if (!termos.length) return 0;
  if (termos.every(x => palavras.some(p => p.startsWith(x)))) return 2;
  return termos.every(x => palavraBate(x, palavras)) ? 1 : 0;
}

/** Busca de lead por nome OU telefone — principal e alternativo (dono 16/11: "quando pesquiso pelo
 *  segundo número não localiza"). Número pode vir com ( ) - espaço ou +55. Nome sem ligar pra acento e
 *  por proximidade (dono 25/11). */
export function casaBuscaLead(l: { nome: string; tel: string; telefoneAlternativo?: string | null }, q: string): boolean {
  return notaBuscaLead(l, q) > 0;
}

/** Igual casaBuscaLead, mas com nota (pra ordenar: telefone/trecho igual primeiro, parecido por último). */
export function notaBuscaLead(l: { nome: string; tel: string; telefoneAlternativo?: string | null }, q: string): number {
  if (!q) return 3;
  const nota = notaBuscaNome(l.nome || '', q);
  if (nota) return nota;
  let d = q.replace(/\D/g, '');
  if (d.length < 3) return 0;
  if (d.length >= 12 && d.startsWith('55')) d = d.slice(2);
  return [l.tel, l.telefoneAlternativo].some(t => !!t && t.replace(/\D/g, '').includes(d)) ? 3 : 0;
}

/** Filtra uma lista de leads pela busca mantendo a ordem da tela. A busca por proximidade (erro de
 *  digitação) só entra quando nenhum lead bate de verdade — assim "maria" não enche a tela de "Mario". */
export function filtrarBuscaLeads<T extends { nome: string; tel: string; telefoneAlternativo?: string | null }>(lista: T[], q: string): T[] {
  if (!q.trim()) return lista;
  const notas = lista.map(l => notaBuscaLead(l, q));
  const forte = notas.some(n => n >= 2);
  return lista.filter((_, i) => (forte ? notas[i] >= 2 : notas[i] > 0));
}
