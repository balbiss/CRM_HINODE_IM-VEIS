import { useEffect, useState } from 'react';
import { Megaphone, Play, ExternalLink, X } from 'lucide-react';
import { useAppStore } from '../store/appStore';
import { apiFetch } from '../lib/api';

/** Criativo do anúncio (vem da pasta do Google Drive da imobiliária, casado pelo nome do anúncio). */
export type Criativo = { id: string; nome: string; tipo: 'imagem' | 'video' | 'outro'; thumb: string; preview: string; url: string };

/** Bloco "Anúncio que trouxe esse lead" no card. Some sozinho se não achar criativo. */
export function CriativoDoLead({ leadId, campanha }: { leadId: string; campanha?: string | null }) {
  const token = useAppStore(s => s.token);
  const [criativos, setCriativos] = useState<Criativo[]>([]);
  const [aberto, setAberto] = useState<Criativo | null>(null);

  useEffect(() => {
    setCriativos([]);
    if (!token || !campanha) return;
    let vivo = true;
    apiFetch<{ criativos: Criativo[] }>('/api/criativos/lead/' + leadId, token)
      .then(r => { if (vivo) setCriativos(r.criativos ?? []); })
      .catch(() => {});
    return () => { vivo = false; };
  }, [leadId, campanha, token]);

  if (!criativos.length) return null;
  return (
    <div style={{ display: 'flex', gap: 14, alignItems: 'center', padding: 12, marginBottom: 12, border: '1px solid var(--line)', borderRadius: 12, background: 'var(--card)', boxShadow: '0 1px 2px rgba(0,0,0,.04)' }}>
      <div style={{ display: 'flex', gap: 6, flex: 'none' }}>
        {criativos.slice(0, 3).map(c => <Miniatura key={c.id} c={c} largura={criativos.length > 1 ? 74 : 112} altura={74} onClick={() => setAberto(c)} />)}
      </div>
      <div style={{ minWidth: 0, flex: 1 }}>
        <p style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 6, fontSize: 10.5, fontWeight: 800, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--terra)' }}>
          <Megaphone size={12} /> Anúncio que trouxe esse lead
        </p>
        <p title={campanha ?? ''} style={{ margin: '4px 0 0', fontSize: 13.5, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{campanha}</p>
        <button onClick={() => setAberto(criativos[0])} style={{ marginTop: 6, border: 'none', background: 'none', padding: 0, fontSize: 12.5, fontWeight: 700, color: 'var(--terra)', cursor: 'pointer' }}>
          {criativos[0].tipo === 'video' ? '▶ Ver o vídeo do anúncio' : 'Ver o criativo'}{criativos.length > 1 ? ` (${criativos.length})` : ''}
        </button>
      </div>
      {aberto && <VisualizarCriativo c={aberto} lista={criativos} onTrocar={setAberto} onFechar={() => setAberto(null)} />}
    </div>
  );
}

export function Miniatura({ c, largura, altura, onClick }: { c: Criativo; largura: number | string; altura: number | string; onClick?: () => void }) {
  const [erro, setErro] = useState(false);
  return (
    <button onClick={onClick} title={c.nome}
      style={{ position: 'relative', width: largura, height: altura, padding: 0, border: '1px solid var(--line)', borderRadius: 9, overflow: 'hidden', background: 'var(--bg)', cursor: onClick ? 'pointer' : 'default', flex: 'none', display: 'block' }}>
      {!erro
        ? <img src={c.thumb} alt="" loading="lazy" onError={() => setErro(true)} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
        : <span style={{ display: 'grid', placeItems: 'center', height: '100%', fontSize: 11, color: 'var(--muted)' }}>Prévia indisponível</span>}
      {c.tipo === 'video' && (
        <span style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', background: 'linear-gradient(transparent 40%, rgba(0,0,0,.35))' }}>
          <span style={{ width: 28, height: 28, borderRadius: '50%', background: 'rgba(0,0,0,.6)', display: 'grid', placeItems: 'center' }}><Play size={13} color="#fff" fill="#fff" /></span>
        </span>
      )}
    </button>
  );
}

/** Tela cheia: imagem grande ou o vídeo tocando (player do Drive). */
export function VisualizarCriativo({ c, lista, onTrocar, onFechar }: { c: Criativo; lista?: Criativo[]; onTrocar?: (c: Criativo) => void; onFechar: () => void }) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onFechar(); };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [onFechar]);
  return (
    <div onClick={onFechar} style={{ position: 'fixed', inset: 0, background: 'rgba(8,10,14,.82)', zIndex: 120, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 20, gap: 12 }}>
      <div onClick={e => e.stopPropagation()} style={{ display: 'flex', alignItems: 'center', gap: 10, width: 'min(900px, 100%)', color: '#fff' }}>
        <span style={{ flex: 1, minWidth: 0, fontSize: 13.5, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.nome}</span>
        <a href={c.url} target="_blank" rel="noreferrer" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: '#fff', fontSize: 12.5, fontWeight: 600, textDecoration: 'none', padding: '6px 10px', border: '1px solid rgba(255,255,255,.3)', borderRadius: 7 }}><ExternalLink size={13} /> Abrir no Drive</a>
        <button onClick={onFechar} aria-label="Fechar" style={{ width: 32, height: 32, borderRadius: 8, border: '1px solid rgba(255,255,255,.3)', background: 'none', color: '#fff', display: 'grid', placeItems: 'center' }}><X size={16} /></button>
      </div>
      <div onClick={e => e.stopPropagation()} style={{ width: 'min(900px, 100%)', height: 'min(70vh, 640px)', borderRadius: 12, overflow: 'hidden', background: '#000', display: 'grid', placeItems: 'center' }}>
        {c.tipo === 'video'
          ? <iframe src={c.preview} title={c.nome} allow="autoplay; fullscreen" allowFullScreen style={{ width: '100%', height: '100%', border: 0 }} />
          : <img src={c.thumb.replace(/sz=w\d+/, 'sz=w1600')} alt={c.nome} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />}
      </div>
      {lista && lista.length > 1 && (
        <div onClick={e => e.stopPropagation()} style={{ display: 'flex', gap: 8 }}>
          {lista.map(x => (
            <div key={x.id} style={{ outline: x.id === c.id ? '2px solid #fff' : 'none', borderRadius: 10 }}>
              <Miniatura c={x} largura={64} altura={64} onClick={() => onTrocar?.(x)} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
