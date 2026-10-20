/** Comparação de telefone igual ao resto do CRM: últimos 8 dígitos, mais o DDD quando os dois têm.
 *  Assim "+55 (62) 99999-0000", "62999990000" e "6299990000" (sem o 9) são o mesmo número,
 *  mas "(11) 99999-0000" não é. */

export const soDigitos = (s: string | null | undefined) => (s || '').replace(/\D/g, '');

function chave(bruto: string) {
  let d = bruto.replace(/^0+/, '');
  if (d.length >= 12 && d.startsWith('55')) d = d.slice(2); // código do país
  // 10 dígitos = DDD + fixo/celular antigo; 11 = DDD + celular com o 9 — o DDD é sempre o começo.
  return { ddd: d.length === 10 || d.length === 11 ? d.slice(0, 2) : null, fim: d.slice(-8) };
}

export function mesmoNumero(a: string | null | undefined, b: string | null | undefined): boolean {
  const da = soDigitos(a), db = soDigitos(b);
  if (da.length < 8 || db.length < 8) return false;
  const x = chave(da), y = chave(db);
  if (x.fim !== y.fim) return false;
  return !x.ddd || !y.ddd || x.ddd === y.ddd;
}
