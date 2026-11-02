import { sql, type SQL } from 'drizzle-orm';

/** Filtros da tela Relatórios iguais aos da v1: cidade (bairro/cidade de interesse do lead, sem
 *  diferenciar acento/maiúscula) e campanhas (várias, marcadas na lista). Vazio = sem filtro.
 *  Valem pra TODOS os blocos: o que é contado por lead usa condLead; o que é contado por outra
 *  tabela que aponta pro lead (distribuição, recusas, descartes, follow-up) usa condPorLead. */
export type FiltroRel = { cidade: string | null; campanhas: string[] };

const COM_ACENTO = 'áàâãäéèêëíìîïóòôõöúùûüçÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ';
const SEM_ACENTO = 'aaaaaeeeeiiiiooooouuuucAAAAAEEEEIIIIOOOOOUUUUC';

export function lerFiltro(q: Record<string, unknown>): FiltroRel {
  const cidade = typeof q.cidade === 'string' && q.cidade.trim() ? q.cidade.trim().slice(0, 120) : null;
  let campanhas: string[] = [];
  if (typeof q.campanhas === 'string' && q.campanhas) {
    try {
      const v = JSON.parse(q.campanhas);
      if (Array.isArray(v)) campanhas = v.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim()).slice(0, 300);
    } catch { /* parâmetro malformado = sem filtro */ }
  }
  return { cidade, campanhas };
}

/** "Origem" do lead como na v1: a campanha/anúncio; sem campanha, o canal (WhatsApp, Site, Manual...). */
export const origem = (a: string) => sql`coalesce(nullif(btrim(${sql.raw(a)}.campanha), ''), ${sql.raw(a)}.canal::text)`;

export const temFiltro =(f: FiltroRel) => !!f.cidade || f.campanhas.length > 0;

/** " and ..." sobre o lead de alias `a` (ou vazio). */
export function condLead(a: string, f: FiltroRel): SQL {
  const partes: SQL[] = [];
  if (f.cidade) {
    partes.push(sql`and lower(btrim(translate(coalesce(${sql.raw(a)}.bairro_interesse, ''), ${COM_ACENTO}, ${SEM_ACENTO})))
      = lower(btrim(translate(${f.cidade}, ${COM_ACENTO}, ${SEM_ACENTO})))`);
  }
  if (f.campanhas.length) {
    partes.push(sql`and ${origem(a)} in (${sql.join(f.campanhas.map(c => sql`${c}`), sql`, `)})`);
  }
  return partes.length ? sql.join(partes, sql` `) : sql``;
}

/** " and exists(lead que passa no filtro)" pra tabelas que apontam pro lead pela coluna `col`. */
export function condPorLead(col: string, f: FiltroRel): SQL {
  if (!temFiltro(f)) return sql``;
  return sql`and exists (select 1 from leads lf where lf.id = ${sql.raw(col)} ${condLead('lf', f)})`;
}
