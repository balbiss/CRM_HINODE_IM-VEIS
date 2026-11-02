import { uploadFile, urlPublica, existeArquivo } from './storage.js';
import { db } from '../db/client.js';
import { imobiliarias } from '../db/schema.js';
import { isNotNull } from 'drizzle-orm';

/** Criativos dos anúncios a partir de uma pasta do Google Drive compartilhada como
 *  "qualquer pessoa com o link" — sem login do Google nem chave de API: lê a listagem pública
 *  (embeddedfolderview), inclusive subpastas, e casa cada lead com o arquivo pelo NOME do anúncio.
 *
 *  Regra de casamento (os arquivos da Hinode têm o mesmo nome do anúncio no Facebook):
 *  - normaliza os dois lados: sem acento, maiúsculo, sem espaços/pontos, sem extensão;
 *  - do lado do lead tira "Importação (ID: …)", o que vem depois de "|" e sufixos " - AD3";
 *  - casa igual; se não achar, o arquivo cujo nome é o COMEÇO do nome do anúncio (o mais longo). */

export type Criativo = { id: string; nome: string; tipo: 'imagem' | 'video' | 'outro'; thumb: string; preview: string; url: string };

const EXT = /\.(png|jpe?g|webp|gif|heic|mp4|mov|m4v|webm|avi)$/i;

export function pastaIdDoLink(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = url.match(/\/folders\/([A-Za-z0-9_-]{10,})/) || url.match(/[?&]id=([A-Za-z0-9_-]{10,})/);
  return m ? m[1] : /^[A-Za-z0-9_-]{20,}$/.test(url.trim()) ? url.trim() : null;
}

/** Chave de comparação de um nome de arquivo ou de anúncio. */
export function chaveCriativo(nome: string, ladoLead = false): string {
  let s = nome.trim();
  if (ladoLead) {
    const imp = s.match(/^Importa[cç][aã]o\s*\(ID:\s*(.*)\)\s*$/i);
    if (imp) s = imp[1];
    s = s.split('|')[0];
    s = s.replace(/\s*-\s*AD\s*\d+\s*$/i, '');
  }
  s = s.replace(EXT, '');
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[\s.]+/g, '');
}

function decodificar(t: string) {
  return t.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

type Item = { id: string; nome: string; mime: string; pasta: boolean };
async function listarUmaPasta(pastaId: string): Promise<Item[]> {
  const r = await fetch('https://drive.google.com/embeddedfolderview?id=' + encodeURIComponent(pastaId), { redirect: 'follow' });
  if (!r.ok) throw new Error(r.status === 401 || r.status === 403 ? 'Pasta privada — compartilhe como "Qualquer pessoa com o link"' : 'Drive respondeu ' + r.status);
  const html = await r.text();
  const itens: Item[] = [];
  const re = /<div class="flip-entry" id="entry-([A-Za-z0-9_-]+)"[\s\S]*?<img src="https:\/\/drive-thirdparty\.googleusercontent\.com\/\d+\/type\/([^"]+)"[\s\S]*?<div class="flip-entry-title">([^<]*)<\/div>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const mime = m[2];
    // NFC: o Drive às vezes devolve acento "decomposto" (Ó = O + ´), invisível mas diferente
    itens.push({ id: m[1], mime, nome: decodificar(m[3]).trim().normalize('NFC'), pasta: mime.includes('folder') });
  }
  return itens;
}

const cache = new Map<string, { em: number; arquivos: Criativo[] }>();
const TTL = 10 * 60 * 1000;

/** Todos os criativos da pasta (e subpastas, até 3 níveis / 800 arquivos). Cache de 10 min. */
export async function listarCriativos(pastaUrl: string | null | undefined, forcar = false): Promise<Criativo[]> {
  const raiz = pastaIdDoLink(pastaUrl);
  if (!raiz) return [];
  const c = cache.get(raiz);
  if (!forcar && c && Date.now() - c.em < TTL) return c.arquivos;
  const arquivos: Criativo[] = [];
  const fila: { id: string; nivel: number }[] = [{ id: raiz, nivel: 0 }];
  while (fila.length && arquivos.length < 800) {
    const { id, nivel } = fila.shift()!;
    const itens = await listarUmaPasta(id);
    for (const it of itens) {
      if (it.pasta) { if (nivel < 3) fila.push({ id: it.id, nivel: nivel + 1 }); continue; }
      const tipo = it.mime.startsWith('image/') ? 'imagem' : it.mime.startsWith('video/') ? 'video' : 'outro';
      arquivos.push({
        id: it.id, nome: it.nome, tipo,
        thumb: `https://drive.google.com/thumbnail?id=${it.id}&sz=w800`,
        preview: `https://drive.google.com/file/d/${it.id}/preview`,
        url: `https://drive.google.com/file/d/${it.id}/view`,
      });
    }
  }
  cache.set(raiz, { em: Date.now(), arquivos });
  return arquivos;
}

/** Criativos do anúncio (nome da campanha/anúncio gravado no lead). Vazio se não casar. */
export function casarCriativos(campanha: string | null | undefined, arquivos: Criativo[]): Criativo[] {
  if (!campanha?.trim() || !arquivos.length) return [];
  const alvo = chaveCriativo(campanha, true);
  if (alvo.length < 4) return [];
  const comChave = arquivos.map(a => ({ a, k: chaveCriativo(a.nome) })).filter(x => x.k.length >= 4);
  const iguais = comChave.filter(x => x.k === alvo).map(x => x.a);
  if (iguais.length) return iguais;
  // o arquivo é o começo do nome do anúncio (ex.: "[ANUNCIO][10][SETE SÓIS][NC 04]…" → "[ANUNCIO][10][SETE SÓIS]")
  const prefixos = comChave.filter(x => x.k.length >= 8 && alvo.startsWith(x.k));
  if (!prefixos.length) return [];
  const maior = Math.max(...prefixos.map(x => x.k.length));
  return prefixos.filter(x => x.k.length === maior).map(x => x.a);
}

// ---------------------------------------------------------------------------------------------
// Miniaturas guardadas no nosso MinIO: o Google bloqueia (429) quando o navegador pede muitas
// miniaturas do Drive a partir de outro site. O servidor baixa UMA vez e a tela carrega do CRM.
// ---------------------------------------------------------------------------------------------

const miniaturas = new Map<string, string>(); // id do arquivo no Drive → URL no MinIO
const chaveMinio = (id: string) => `criativos/${id}.jpg`;

/** É um arquivo de alguma pasta de criativos conhecida? (a rota pública só serve esses) */
export function criativoConhecido(id: string) {
  for (const c of cache.values()) if (c.arquivos.some(a => a.id === id)) return true;
  return false;
}

/** URL da miniatura no MinIO (baixa do Drive e guarda na 1ª vez). */
export async function guardarMiniatura(id: string): Promise<string> {
  const pronta = miniaturas.get(id);
  if (pronta) return pronta;
  const key = chaveMinio(id);
  if (await existeArquivo(key)) { const u = urlPublica(key); miniaturas.set(id, u); return u; }
  const r = await fetch(`https://drive.google.com/thumbnail?id=${encodeURIComponent(id)}&sz=w640`, {
    redirect: 'follow', headers: { 'user-agent': 'Mozilla/5.0 (CRM Hinode; miniaturas de criativos)' },
  });
  const tipo = r.headers.get('content-type') || '';
  if (!r.ok || !tipo.startsWith('image/')) throw new Error('Drive não entregou a miniatura (' + r.status + ')');
  const u = await uploadFile(key, Buffer.from(await r.arrayBuffer()), tipo);
  miniaturas.set(id, u);
  return u;
}

/** Relê a pasta de todas as imobiliárias e guarda as miniaturas que faltam (roda à meia-noite). */
export async function atualizarCriativosDeTodas(): Promise<{ imobiliarias: number; arquivos: number; novas: number }> {
  const imobs = await db.select({ id: imobiliarias.id, pasta: imobiliarias.criativosPastaUrl }).from(imobiliarias)
    .where(isNotNull(imobiliarias.criativosPastaUrl));
  let arquivos = 0, novas = 0;
  for (const im of imobs) {
    let lista: Criativo[] = [];
    try { lista = await listarCriativos(im.pasta, true); } catch (e) { console.error('Criativos: pasta falhou —', (e as Error).message); continue; }
    arquivos += lista.length;
    for (const c of lista) {
      if (miniaturas.has(c.id)) continue;
      try {
        const existia = await existeArquivo(chaveMinio(c.id));
        await guardarMiniatura(c.id);
        if (!existia) { novas++; await new Promise(r => setTimeout(r, 400)); } // devagar com o Google
      } catch { /* tenta de novo na próxima rodada */ }
    }
  }
  return { imobiliarias: imobs.length, arquivos, novas };
}
