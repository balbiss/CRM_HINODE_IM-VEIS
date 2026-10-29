import { useEffect } from 'react';
import { useAppStore, type RemoteTemplate } from '../store/appStore';

type Anexo = { url: string; nome?: string; tipo?: string };
const tipoAnexo = (a: Anexo): 'imagem' | 'video' | 'audio' | 'documento' => {
  const t = (a.tipo || '').toLowerCase();
  if (t.startsWith('imag') || t === 'image') return 'imagem';
  if (t.startsWith('vid')) return 'video';
  if (t.startsWith('aud')) return 'audio';
  if (!t) {
    const u = a.url.toLowerCase();
    if (/\.(jpe?g|png|webp|gif)(\?|$)/.test(u)) return 'imagem';
    if (/\.(mp4|mov|webm)(\?|$)/.test(u)) return 'video';
    if (/\.(ogg|mp3|m4a|opus)(\?|$)/.test(u)) return 'audio';
  }
  return 'documento';
};
export const anexosDoTemplate = (t: RemoteTemplate): Anexo[] =>
  t.anexos?.length ? t.anexos : t.anexoUrl ? [{ url: t.anexoUrl, nome: t.anexoUrl.split('/').pop() }] : [];

/** Lista de mensagens prontas da imobiliária (v1): abre quando o texto começa com "/", filtra pelo que
 *  vem depois da barra. Escolher troca {nome} pelo primeiro nome do cliente; sem anexo o texto vai pra
 *  caixa (pra conferir e mandar); com anexo, manda os anexos já (o texto vai de legenda no 1º). */
export function MensagensProntas({ draft, setDraft, leadId, leadNome, aberto, onFechar, bottom = 64 }: {
  draft: string; setDraft: (v: string) => void; leadId: string; leadNome: string;
  aberto?: boolean; onFechar?: () => void; bottom?: number;
}) {
  const templates = useAppStore(s => s.templates);
  const fetchTemplates = useAppStore(s => s.fetchTemplates);
  const enviarMensagem = useAppStore(s => s.enviarMensagem);
  const toast = useAppStore(s => s.toast);
  const porBarra = draft.startsWith('/');
  const visivel = porBarra || !!aberto;
  useEffect(() => { if (visivel) void fetchTemplates(); }, [visivel, fetchTemplates]);
  if (!visivel) return null;
  const filtro = porBarra ? draft.slice(1).trim().toLowerCase() : '';
  const lista = templates.filter(t => !filtro || t.titulo.toLowerCase().includes(filtro) || t.texto.toLowerCase().includes(filtro));
  const primeiro = (leadNome || '').trim().split(/\s+/)[0] || '';

  async function usar(t: RemoteTemplate) {
    const texto = (t.texto || '').replace(/\{nome\}/gi, primeiro);
    const anexos = anexosDoTemplate(t);
    onFechar?.();
    if (!anexos.length) { setDraft(texto); return; }
    setDraft('');
    let falhas = 0;
    for (let i = 0; i < anexos.length; i++) {
      const a = anexos[i];
      try {
        await enviarMensagem(leadId, { texto: i === 0 ? texto || undefined : undefined, anexoUrl: a.url, anexoTipo: tipoAnexo(a), anexoNome: a.nome });
      } catch { falhas++; }
    }
    toast(falhas ? falhas + ' de ' + anexos.length + ' anexos falharam' : 'Mensagem pronta "' + t.titulo + '" enviada');
  }

  return (
    <div style={{ position: 'absolute', left: 18, right: 18, bottom, maxHeight: 320, overflowY: 'auto', background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 10, padding: 6, boxShadow: '0 12px 28px rgba(28,27,26,.14)', zIndex: 20 }}>
      <p style={{ fontSize: 10.5, letterSpacing: '.12em', textTransform: 'uppercase', color: 'var(--muted)', margin: '6px 10px 8px', display: 'flex', justifyContent: 'space-between' }}>
        <span>Mensagens prontas{filtro ? ' · “' + filtro + '”' : ''}</span>
        {aberto && !porBarra && <button onClick={onFechar} style={{ border: 'none', background: 'none', color: 'var(--muted)', fontSize: 12 }}>fechar</button>}
      </p>
      {lista.map(t => {
        const n = anexosDoTemplate(t).length;
        return (
          <button key={t.id} onClick={() => usar(t)} style={{ width: '100%', textAlign: 'left', padding: '8px 10px', border: 'none', background: 'none', borderRadius: 6, display: 'block' }}>
            <span style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
              <span style={{ color: 'var(--terra)', fontWeight: 700, fontSize: 12.5 }}>{t.titulo}</span>
              {t.autorNome && <span style={{ fontSize: 10.5, color: 'var(--muted)' }}>{t.autorNome}</span>}
              {n > 0 && <span style={{ fontSize: 10.5, color: 'var(--muted)' }}>📎 {n}</span>}
            </span>
            <span style={{ display: 'block', fontSize: 12.5, color: 'var(--muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.texto || '(só anexo)'}</span>
          </button>
        );
      })}
      {lista.length === 0 && <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: '6px 10px 10px' }}>{templates.length ? 'Nenhuma mensagem pronta com esse nome.' : 'Nenhuma mensagem pronta ainda — crie em Templates no menu.'}</p>}
    </div>
  );
}
