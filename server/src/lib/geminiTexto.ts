/** Chamada de texto ao Gemini (mesma GEMINI_API_KEY do assistente de voz).
 *  Tenta uma lista de modelos: se um estiver sobrecarregado/indisponível, passa pro próximo. */
const MODELOS = (process.env.GEMINI_TEXT_MODELS || 'gemini-flash-latest,gemini-3.5-flash,gemini-flash-lite-latest,gemini-3.5-flash-lite,gemini-3.1-flash-lite')
  .split(',').map(s => s.trim()).filter(Boolean);

export const geminiTextoConfigurado = () => !!process.env.GEMINI_API_KEY;

type Parte = { text: string } | { inlineData: { mimeType: string; data: string } };
export type Turno = { role: 'user' | 'model'; parts: Parte[] };

export async function gerarTexto(opts: { sistema?: string; turnos: Turno[]; temperatura?: number; timeoutMs?: number }): Promise<string> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('IA indisponível (GEMINI_API_KEY não configurada)');
  let ultimoErro = '';
  for (const modelo of MODELOS) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 20000); // por modelo: travou, passa pro próximo
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent`, {
        method: 'POST', signal: ctrl.signal,
        headers: { 'x-goog-api-key': key, 'content-type': 'application/json' },
        body: JSON.stringify({
          ...(opts.sistema ? { systemInstruction: { parts: [{ text: opts.sistema }] } } : {}),
          contents: opts.turnos,
          generationConfig: { temperature: opts.temperatura ?? 0.2 },
        }),
      });
      const j = await r.json().catch(() => ({})) as { error?: { message?: string }; candidates?: { content?: { parts?: { text?: string }[] } }[] };
      if (!r.ok || j.error) { ultimoErro = `${modelo}: ${j.error?.message || r.status}`; continue; }
      const texto = (j.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('').trim();
      if (texto) return texto;
      ultimoErro = `${modelo}: resposta vazia`;
    } catch (e) {
      ultimoErro = `${modelo}: ${(e as Error).name === 'AbortError' ? 'demorou demais' : (e as Error).message}`;
    } finally { clearTimeout(t); }
  }
  throw new Error('IA indisponível agora (' + ultimoErro.slice(0, 160) + ')');
}

/** Lê um PDF/foto e devolve todo o texto e tabelas em texto simples. */
export async function lerArquivo(url: string): Promise<string> {
  const r = await fetch(url);
  if (!r.ok) throw new Error('não consegui baixar o anexo (' + r.status + ')');
  const tipo = (r.headers.get('content-type') || '').split(';')[0] || (url.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'image/jpeg');
  if (!/^image\/|^application\/pdf$/.test(tipo)) throw new Error('só dá pra ler PDF ou foto');
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > 18 * 1024 * 1024) throw new Error('anexo grande demais pra IA ler (máx. 18 MB)');
  return gerarTexto({
    timeoutMs: 90000,
    turnos: [{ role: 'user', parts: [
      { inlineData: { mimeType: tipo, data: buf.toString('base64') } },
      { text: 'Transcreva fielmente TODO o conteúdo deste arquivo em texto simples, em português: textos, regras, valores, datas e tabelas (tabela em linhas "coluna: valor"). Não resuma e não invente nada.' },
    ] }],
  });
}
