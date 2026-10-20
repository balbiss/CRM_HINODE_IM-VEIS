import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { imoveis } from '../db/schema.js';

/* Catálogo pro Agente de IA: o CRM escolhe no cadastro de imóveis os que combinam com o que a IA
 * já descobriu e passa só esses (com código curto IM1, IM2...). A IA nunca vê — e portanto nunca
 * inventa — imóvel fora dessa lista. Busca simples por regras, sem IA: finalidade e tipo eliminam,
 * valor tem 15% de folga, bairro e quartos só dão pontos. */

export type ImovelSugerido = {
  codigo: string; id: string; titulo: string; tipo: string; finalidade: string; local: string;
  preco: number | null; quartos: number; suites: number; vagas: number; area: number | null;
  destaques: string[]; situacao: string; aceitaFinanciamento: boolean; imagens: string[];
  condominio: number | null; iptu: number | null;
  /** O cliente disse um bairro e este imóvel NÃO fica nele (só aparece quando não há nenhum no bairro pedido). */
  foraDoBairroPedido: boolean;
};

const norm = (s: string) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Maior valor em reais citado ("até 120k", "400 mil", "1,5 milhão", "R$ 350.000"). */
export function valorMaximo(txt?: string): number | null {
  if (!txt) return null;
  // "acima de 400k", "a partir de", "mais de", "400k à vista e o resto financiado": é piso, não teto
  if (/acima|a partir|mais de|pelo menos|no minimo|minimo de|resto financ|restante financ/.test(norm(txt))) return null;
  let max: number | null = null;
  // "mil" antes de "mi" na alternância: senão "400 mil" casava "mi" e virava 400 milhões
  for (const m of norm(txt).matchAll(/(\d+(?:[.,]\d+)*)\s*(milhoes|milhao|mil|mi|k)?/g)) {
    let bruto = m[1];
    // "350.000" = milhar; "1,5" = decimal
    bruto = /^\d{1,3}(\.\d{3})+$/.test(bruto) ? bruto.replace(/\./g, '') : bruto.replace(/\./g, '').replace(',', '.');
    let v = Number(bruto);
    if (!Number.isFinite(v)) continue;
    const suf = m[2];
    if (suf === 'mil' || suf === 'k') v *= 1000;
    else if (suf) v *= 1_000_000;
    else if (v < 300) continue; // "3 quartos", "2 vagas" — não é valor
    if (max === null || v > max) max = v;
  }
  return max;
}

function tipoCanonico(txt: string): string | null {
  const t = norm(txt);
  if (/apart|apto|\bap\b|flat|studio|kitnet|cobertura/.test(t)) return 'apartamento';
  if (/casa|sobrado/.test(t)) return 'casa';
  if (/sala|loja|comercial|escritorio|ponto|galpao/.test(t)) return 'comercial';
  if (/terreno|lote/.test(t)) return 'terreno';
  return null;
}

function quartosPedidos(dados: Record<string, string>): number | null {
  for (const v of Object.values(dados)) {
    const m = norm(v).match(/(\d)\s*(quartos?|qts?|dormitorios?|dorms?)/);
    if (m) return Number(m[1]);
  }
  return null;
}

export async function imoveisParaIa(
  imobiliariaId: string, dados: Record<string, string>, imovelInteresseId: string | null, informarPreco: boolean,
): Promise<ImovelSugerido[]> {
  const lista = await db.select().from(imoveis).where(eq(imoveis.imobiliariaId, imobiliariaId));
  if (!lista.length) return [];

  // _texto = última mensagem do cliente: cobre o que ele acabou de dizer e a IA ainda não anotou.
  const finTxt = norm(dados.finalidade || dados._texto || '');
  const fin = /alug|loca/.test(finTxt) ? 'alug' : /compr|vend|invest/.test(finTxt) ? 'vend' : null;
  const tipo = tipoCanonico(dados.tipo_imovel || '') ?? tipoCanonico(dados._texto || '');
  const max = valorMaximo(dados.faixa_valor) ?? valorMaximo(dados._texto);
  const qts = quartosPedidos(dados);
  const regiao = norm(dados.regiao || '');
  const tokensRegiao = /sem preferencia|qualquer|tanto faz/.test(regiao) ? [] : regiao.split(/[^a-z0-9]+/).filter(t => t.length >= 4);
  // Sem saber nem compra/aluguel nem tipo, qualquer sugestão seria chute.
  if (!fin && !tipo && !imovelInteresseId) return [];

  type Pontuado = { im: typeof lista[number]; score: number; noBairro: boolean };
  let pontuados = lista.map(im => {
    const onde = norm([im.endereco, im.cidade, im.titulo].filter(Boolean).join(' '));
    const noBairro = tokensRegiao.some(t => onde.includes(t));
    if (im.id === imovelInteresseId) return { im, score: 1000, noBairro: true };
    if (fin && !norm(im.finalidade).includes(fin)) return null;
    if (tipo && tipoCanonico(im.tipo) !== tipo) return null;
    const preco = Number(im.preco) || 0;
    if (max && preco > max * 1.15) return null;
    let score = 0;
    if (max && preco <= max) score += 2;
    if (noBairro) score += 3;
    if (qts) score += (im.quartos ?? 0) >= qts ? 2 : -2;
    if ((im.imagens ?? []).length) score += 1;
    return { im, score, noBairro };
  }).filter((x): x is Pontuado => !!x);
  // Cliente disse o bairro e há imóvel nele: a IA só recebe os do bairro (não oferece Pedreira a
  // quem pediu Umarizal). Sem nenhum no bairro, vão os outros, marcados como "fora do bairro pedido".
  if (tokensRegiao.length && pontuados.some(p => p.noBairro)) pontuados = pontuados.filter(p => p.noBairro);
  pontuados = pontuados.sort((a, b) => b.score - a.score).slice(0, 3);

  return pontuados.map(({ im, noBairro }, i) => ({
    codigo: 'IM' + (i + 1),
    id: im.id,
    titulo: im.titulo,
    tipo: im.tipo,
    finalidade: im.finalidade,
    local: [im.endereco, im.cidade].filter(Boolean).join(' — '),
    preco: informarPreco ? Number(im.preco) || null : null,
    quartos: im.quartos ?? 0,
    suites: im.suites ?? 0,
    vagas: im.vagas ?? 0,
    area: im.area ? Number(im.area) : null,
    destaques: (im.amenidades ?? []).slice(0, 4),
    situacao: im.situacao + (im.previsaoEntrega ? ' (entrega ' + im.previsaoEntrega + ')' : ''),
    aceitaFinanciamento: im.aceitaFinanciamento,
    imagens: im.imagens ?? [],
    condominio: informarPreco && im.valorCondominio ? Number(im.valorCondominio) : null,
    iptu: informarPreco && im.valorIptu ? Number(im.valorIptu) : null,
    foraDoBairroPedido: tokensRegiao.length > 0 && !noBairro,
  }));
}
