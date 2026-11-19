/** Fluxo de pagamento da construtora — regra cadastrada UMA vez, recalculada pelo sistema a cada mês.
 *  A IA nunca faz a conta: ela só lê o resultado daqui (assim o número sempre bate).
 *
 *  Conta: entrada = valor do imóvel − financiamento − subsídio − FGTS
 *         a parcelar = entrada − ato − balões que ainda vão vencer − total do pós-chaves
 *         meses = do 1º mês de parcela até o mês das chaves (vai diminuindo sozinho mês a mês)
 *         parcela mensal = a parcelar ÷ meses */

export type Balao = { descricao: string; valor: number; mes: string };            // mes 'AAAA-MM'
export type BalaoPeriodico = { descricao: string; valor: number; aCadaMeses: number; mesInicio: string };
export type FluxoConfig = {
  valorImovel?: number;
  financiamento?: number;
  subsidio?: number;
  fgts?: number;
  ato?: number;
  dataChaves?: string;                 // 'AAAA-MM' — último mês das parcelas da entrada
  inicioParcelas?: 'proximo_mes' | 'mes_atual';
  diaVencimento?: number;
  limiteMeses?: number;                // máx. de parcelas que a construtora aceita (0 = sem limite)
  parcelaMinima?: number;              // a construtora não aceita parcela menor que isso
  baloes?: Balao[];
  baloesPeriodicos?: BalaoPeriodico[];
  posChavesParcelas?: number;          // parcelas depois das chaves (quantidade)
  posChavesValor?: number;             // valor de cada parcela pós-chaves
  correcao?: string;                   // texto livre, ex. "INCC até as chaves"
};
export type Simulacao = Partial<Pick<FluxoConfig, 'valorImovel' | 'financiamento' | 'subsidio' | 'fgts' | 'ato'>>;

export type LinhaCronograma = { mes: string; parcela: number; balao: number; descricaoBalao?: string; total: number };
export type ResultadoFluxo = {
  referencia: string;
  valorImovel: number; financiamento: number; subsidio: number; fgts: number;
  entrada: number; ato: number;
  baloes: { descricao: string; mes: string; valor: number }[]; totalBaloes: number;
  posChaves: { parcelas: number; valor: number; total: number };
  aParcelar: number; meses: number; parcela: number;
  primeiraParcela: string | null; ultimaParcela: string | null;
  cronograma: LinhaCronograma[];
  alertas: string[];
};

const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const r2 = (n: number) => Math.round(n * 100) / 100;

/** 'AAAA-MM' do mês corrente no horário de Brasília. */
export function mesAtualBr(d = new Date()): string {
  const br = new Date(d.getTime() - 3 * 3600 * 1000);
  return br.getUTCFullYear() + '-' + String(br.getUTCMonth() + 1).padStart(2, '0');
}
const valido = (m?: string) => !!m && /^\d{4}-\d{2}$/.test(m);
const idx = (m: string) => { const [a, b] = m.split('-').map(Number); return a * 12 + (b - 1); };
const deIdx = (i: number) => Math.floor(i / 12) + '-' + String((i % 12) + 1).padStart(2, '0');

export function calcularFluxo(cfgIn: FluxoConfig, sim: Simulacao = {}, referencia = mesAtualBr()): ResultadoFluxo {
  const cfg = { ...cfgIn, ...Object.fromEntries(Object.entries(sim).filter(([, v]) => v != null && v !== ('' as unknown))) } as FluxoConfig;
  const alertas: string[] = [];
  const valorImovel = num(cfg.valorImovel), financiamento = num(cfg.financiamento), subsidio = num(cfg.subsidio), fgts = num(cfg.fgts), ato = num(cfg.ato);
  const entrada = r2(valorImovel - financiamento - subsidio - fgts);
  if (!valorImovel) alertas.push('Falta o valor do imóvel.');
  if (entrada < 0) alertas.push('Financiamento + subsídio + FGTS passam do valor do imóvel.');

  const ref = idx(referencia);
  const inicio = ref + (cfg.inicioParcelas === 'mes_atual' ? 0 : 1);
  let fim = valido(cfg.dataChaves) ? idx(cfg.dataChaves!) : inicio - 1;
  if (!valido(cfg.dataChaves)) alertas.push('Falta o mês das chaves.');
  let meses = Math.max(0, fim - inicio + 1);
  const limite = num(cfg.limiteMeses);
  if (limite > 0 && meses > limite) { meses = limite; fim = inicio + limite - 1; }

  // balões que ainda vão vencer, dentro do período das parcelas
  const baloes: { descricao: string; mes: string; valor: number }[] = [];
  for (const b of cfg.baloes || []) {
    if (!valido(b.mes) || num(b.valor) <= 0) continue;
    const i = idx(b.mes);
    if (i >= inicio && i <= fim) baloes.push({ descricao: b.descricao || 'Balão', mes: b.mes, valor: num(b.valor) });
  }
  for (const p of cfg.baloesPeriodicos || []) {
    const passo = Math.max(1, Math.floor(num(p.aCadaMeses)));
    if (!valido(p.mesInicio) || num(p.valor) <= 0) continue;
    for (let i = idx(p.mesInicio); i <= fim; i += passo) if (i >= inicio) baloes.push({ descricao: p.descricao || 'Balão', mes: deIdx(i), valor: num(p.valor) });
  }
  baloes.sort((a, b) => a.mes.localeCompare(b.mes));
  const totalBaloes = r2(baloes.reduce((s, b) => s + b.valor, 0));
  const posParcelas = Math.max(0, Math.floor(num(cfg.posChavesParcelas))), posValor = num(cfg.posChavesValor);
  const posChaves = { parcelas: posParcelas, valor: posValor, total: r2(posParcelas * posValor) };

  const aParcelar = r2(entrada - ato - totalBaloes - posChaves.total);
  let parcela = 0;
  if (meses > 0) parcela = r2(Math.max(0, aParcelar) / meses);
  else if (valido(cfg.dataChaves) && aParcelar > 0) alertas.push('As chaves já são este mês (ou já passaram): o restante da entrada fica à vista.');
  if (aParcelar < 0) alertas.push('Ato + balões + pós-chaves já cobrem a entrada inteira — não sobra parcela mensal.');
  if (parcela > 0 && num(cfg.parcelaMinima) > 0 && parcela < num(cfg.parcelaMinima)) alertas.push('A parcela ficou abaixo do mínimo da construtora (' + num(cfg.parcelaMinima).toFixed(2) + ').');

  const cronograma: LinhaCronograma[] = [];
  for (let i = inicio; i <= fim && meses > 0; i++) {
    const mes = deIdx(i);
    const bs = baloes.filter(b => b.mes === mes);
    const balao = r2(bs.reduce((s, b) => s + b.valor, 0));
    cronograma.push({ mes, parcela, balao, descricaoBalao: bs.map(b => b.descricao).join(' + ') || undefined, total: r2(parcela + balao) });
  }

  return {
    referencia, valorImovel, financiamento, subsidio, fgts, entrada, ato, baloes, totalBaloes, posChaves,
    aParcelar, meses, parcela,
    primeiraParcela: meses > 0 ? deIdx(inicio) : null, ultimaParcela: meses > 0 ? deIdx(fim) : null,
    cronograma, alertas,
  };
}

const brl = (n: number) => n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const mesBr = (m: string) => { const [a, b] = m.split('-'); return ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'][Number(b) - 1] + '/' + a; };

/** Texto do fluxo já calculado (vai pra IA e pro "Simular fluxo"). */
export function fluxoEmTexto(nome: string, cfg: FluxoConfig, r: ResultadoFluxo, observacoes = ''): string {
  const l: string[] = [`Fluxo de pagamento — ${nome} (calculado para ${mesBr(r.referencia)})`];
  l.push(`Valor do imóvel: ${brl(r.valorImovel)}`);
  if (r.financiamento) l.push(`Financiamento: ${brl(r.financiamento)}`);
  if (r.subsidio) l.push(`Subsídio: ${brl(r.subsidio)}`);
  if (r.fgts) l.push(`FGTS: ${brl(r.fgts)}`);
  l.push(`Entrada total: ${brl(r.entrada)}`);
  if (r.ato) l.push(`Ato/sinal: ${brl(r.ato)}`);
  for (const b of r.baloes) l.push(`${b.descricao} em ${mesBr(b.mes)}: ${brl(b.valor)}`);
  if (r.meses > 0) l.push(`Parcelas mensais: ${r.meses}x de ${brl(r.parcela)} (de ${mesBr(r.primeiraParcela!)} a ${mesBr(r.ultimaParcela!)})`);
  if (r.posChaves.parcelas) l.push(`Pós-chaves: ${r.posChaves.parcelas}x de ${brl(r.posChaves.valor)}`);
  if (cfg.correcao) l.push(`Correção: ${cfg.correcao}`);
  if (observacoes) l.push(`Observações: ${observacoes}`);
  for (const a of r.alertas) l.push(`Atenção: ${a}`);
  return l.join('\n');
}
