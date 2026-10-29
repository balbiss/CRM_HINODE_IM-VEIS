import { sql } from './client.js';
import { uploadFile } from '../lib/storage.js';

/** Fase 10 da migração: copia fotos/áudios/vídeos/PDFs que ainda apontam pro Storage do Supabase da
 *  v1 (o projeto pode ser restringido por cota) pro MinIO da v2 e troca os links no banco.
 *  Pode rodar quantas vezes precisar: só pega o que ainda aponta pro Supabase. Lê pouco por vez
 *  (o container tem pouca memória) e baixa 4 arquivos em paralelo.
 *  Uso: node dist/db/copiar-midias-oka.js [--limite=N] */

const SUPA = '%osheoeeigahkwsrzfjdw.supabase.co/storage/%';
const limite = Number(process.argv.find(a => a.startsWith('--limite='))?.slice(9) ?? 0) || Infinity;
const mapa = new Map<string, string>();
let copiados = 0, falhas = 0;

async function copiar(url: string): Promise<string | null> {
  if (mapa.has(url)) return mapa.get(url)!;
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const buf = Buffer.from(await r.arrayBuffer());
    const caminho = decodeURIComponent(new URL(url).pathname.split('/storage/v1/object/public/')[1] ?? ('avulso/' + Date.now()));
    const novo = await uploadFile('oka/' + caminho, buf, r.headers.get('content-type') || 'application/octet-stream');
    mapa.set(url, novo);
    copiados++;
    return novo;
  } catch (e) {
    falhas++;
    console.error('  falhou:', url.slice(-60), (e as Error).message);
    return null;
  }
}

async function emParalelo<T>(itens: T[], n: number, fn: (x: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < itens.length) await fn(itens[i++]); }));
}

async function main() {
  // mensagens: em lotes de 200
  for (;;) {
    if (copiados >= limite) break;
    const lote = await sql<{ id: string; anexo_url: string }[]>`select id, anexo_url from mensagens_whatsapp where anexo_url like ${SUPA} limit 200`;
    if (!lote.length) break;
    let mudou = 0;
    await emParalelo(lote, 4, async m => {
      const novo = await copiar(m.anexo_url);
      if (novo) { await sql`update mensagens_whatsapp set anexo_url = ${novo} where id = ${m.id}`; mudou++; }
    });
    console.log(`mensagens: +${mudou} (total copiados ${copiados}, falhas ${falhas})`);
    if (!mudou) break; // só falhas nesse lote: para pra não girar em falso
  }
  // mensagens prontas, passos de follow-up e fotos dos imóveis
  for (const t of await sql<{ id: string; anexo_url: string | null; anexos: { url: string }[] }[]>`select id, anexo_url, anexos from templates_mensagem where anexo_url like ${SUPA} or anexos::text like ${SUPA}`) {
    const anexos = await Promise.all((t.anexos ?? []).map(async a => ({ ...a, url: a.url.includes('supabase.co/storage') ? (await copiar(a.url)) ?? a.url : a.url })));
    const principal = t.anexo_url?.includes('supabase.co/storage') ? (await copiar(t.anexo_url)) ?? t.anexo_url : t.anexo_url;
    await sql`update templates_mensagem set anexo_url = ${principal}, anexos = ${JSON.stringify(anexos)}::jsonb where id = ${t.id}`;
  }
  for (const p of await sql<{ id: string; anexo_url: string }[]>`select id, anexo_url from followup_passos where anexo_url like ${SUPA}`) {
    const novo = await copiar(p.anexo_url);
    if (novo) await sql`update followup_passos set anexo_url = ${novo} where id = ${p.id}`;
  }
  for (const im of await sql<{ id: string; imagens: string[] }[]>`select id, imagens from imoveis where imagens::text like ${SUPA}`) {
    const imagens = await Promise.all((im.imagens ?? []).map(async u => (u.includes('supabase.co/storage') ? (await copiar(u)) ?? u : u)));
    await sql`update imoveis set imagens = ${JSON.stringify(imagens)}::jsonb where id = ${im.id}`;
  }
  const [{ n }] = await sql`select count(*)::int n from mensagens_whatsapp where anexo_url like ${SUPA}`;
  console.log(`Pronto: ${copiados} arquivo(s) copiado(s), ${falhas} falha(s). Ainda no Supabase: ${n} mensagem(ns).`);
}

main().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => sql.end());
