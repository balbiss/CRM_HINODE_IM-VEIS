import { useEffect, useState } from 'react';
import { useAppStore } from '../store/appStore';
import { useRoleInfo } from '../lib/selectors';
import { apiFetch } from '../lib/api';

/** Campanhas (v1): cada anúncio que já trouxe lead, com a imagem do criativo (link do Google Drive). */
type Camp = { nome: string; total: number; ult7: number; ult30: number; ultimo: string | null; driveUrl: string | null; observacao: string | null };

/** Link de arquivo do Drive → endereço de prévia da imagem. Link de pasta não tem prévia. */
function previaDrive(url: string | null): string | null {
  if (!url) return null;
  const m = url.match(/\/file\/d\/([^/]+)/) || url.match(/[?&]id=([^&]+)/);
  return m ? 'https://drive.google.com/thumbnail?id=' + m[1] + '&sz=w600' : null;
}

export default function Campanhas() {
  const token = useAppStore(s => s.token);
  const toast = useAppStore(s => s.toast);
  const { isManager } = useRoleInfo();
  const [lista, setLista] = useState<Camp[]>([]);
  const [todas, setTodas] = useState(false);
  const [busca, setBusca] = useState('');
  const [editando, setEditando] = useState<{ nome: string; driveUrl: string; novo?: boolean } | null>(null);
  const carregar = () => { if (token) apiFetch<Camp[]>('/api/relatorios-oka/campanhas', token).then(setLista).catch(() => toast('Não foi possível carregar as campanhas')); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(carregar, [token]);

  const visiveis = lista.filter(c => (todas || c.ult30 > 0 || (!c.total && c.driveUrl !== undefined)) && (!busca || c.nome.toLowerCase().includes(busca.toLowerCase())));
  async function salvar() {
    if (!editando?.nome.trim() || !token) return;
    try {
      await apiFetch('/api/relatorios-oka/campanhas', token, { method: 'PUT', body: JSON.stringify({ nome: editando.nome.trim(), driveUrl: editando.driveUrl.trim() || null }) });
      setEditando(null); carregar();
    } catch { toast('Não foi possível salvar'); }
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', marginBottom: 14 }}>
        <div>
          <p style={{ fontSize: 11, letterSpacing: '.18em', textTransform: 'uppercase', color: 'var(--muted)', margin: '0 0 4px' }}>Marketing</p>
          <h1 style={{ fontFamily: 'Newsreader,serif', fontWeight: 400, fontSize: 24, margin: 0, lineHeight: 1.2 }}>Campanhas</h1>
          <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: '5px 0 0' }}>Cada anúncio que já trouxe leads. Por padrão, só os que trouxeram lead nos últimos 30 dias.</p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <input value={busca} onChange={e => setBusca(e.target.value)} placeholder="Buscar pelo nome…" style={inp} />
          <button onClick={() => setTodas(v => !v)} style={{ ...inp, fontWeight: 600 }}>{todas ? 'Últimos 30 dias' : 'Todas'}</button>
          {isManager && <button onClick={() => setEditando({ nome: '', driveUrl: '', novo: true })} style={{ padding: '9px 14px', border: 'none', borderRadius: 8, background: 'var(--terra)', color: '#fff', fontSize: 13, fontWeight: 600 }}>Nova campanha</button>}
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(250px,1fr))', gap: 14 }}>
        {visiveis.map(c => {
          const img = previaDrive(c.driveUrl);
          return (
            <div key={c.nome} style={{ border: '1px solid var(--line)', borderRadius: 12, background: 'var(--card)', overflow: 'hidden' }}>
              <div style={{ height: 150, background: 'var(--bg)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                {img ? <img src={img} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  : c.driveUrl ? <a href={c.driveUrl} target="_blank" rel="noreferrer" style={{ fontSize: 12.5, color: 'var(--terra)', fontWeight: 600 }}>Abrir no Drive</a>
                  : <span style={{ fontSize: 12, color: 'var(--muted)' }}>Sem criativo</span>}
              </div>
              <div style={{ padding: 14 }}>
                <p style={{ margin: 0, fontSize: 13.5, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={c.nome}>{c.nome}</p>
                <p style={{ margin: '6px 0 0', fontSize: 12.5, color: 'var(--muted)' }}><b style={{ color: 'var(--ink)' }}>{c.total}</b> leads · {c.ult7} em 7 dias · {c.ult30} em 30 dias</p>
                <p style={{ margin: '3px 0 0', fontSize: 11.5, color: 'var(--muted)' }}>Último: {c.ultimo ? new Date(c.ultimo).toLocaleDateString('pt-BR') : '—'}</p>
                {isManager && <button onClick={() => setEditando({ nome: c.nome, driveUrl: c.driveUrl ?? '' })} style={{ marginTop: 10, padding: '6px 11px', border: '1px solid var(--line)', borderRadius: 7, background: 'none', fontSize: 12 }}>✎ Criativo</button>}
              </div>
            </div>
          );
        })}
      </div>
      {visiveis.length === 0 && <p style={{ fontSize: 13, color: 'var(--muted)' }}>Nenhuma campanha {todas ? '' : 'nos últimos 30 dias'}.</p>}

      {editando && (
        <div onClick={() => setEditando(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(8,17,31,.5)', zIndex: 70, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
          <div onClick={e => e.stopPropagation()} style={{ width: '100%', maxWidth: 460, background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 14, padding: 22 }}>
            <p style={{ fontFamily: 'Newsreader,serif', fontSize: 20, margin: '0 0 12px' }}>{editando.novo ? 'Nova campanha' : editando.nome}</p>
            {editando.novo && (<><label style={lbl}>Nome exatamente como vem no anúncio</label><input value={editando.nome} onChange={e => setEditando({ ...editando, nome: e.target.value })} style={campo} /></>)}
            <label style={lbl}>Link da imagem no Google Drive</label>
            <input value={editando.driveUrl} onChange={e => setEditando({ ...editando, driveUrl: e.target.value })} placeholder="https://drive.google.com/file/d/…" style={campo} />
            <p style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.5, margin: '8px 0 0' }}>No Drive: botão direito na imagem → Compartilhar → "Qualquer pessoa com o link" → Copiar link. Link de pasta vira só um botão "Abrir no Drive".</p>
            <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
              <button onClick={salvar} style={{ flex: 1, padding: 11, border: 'none', borderRadius: 8, background: 'var(--terra)', color: '#fff', fontSize: 13, fontWeight: 600 }}>Salvar</button>
              <button onClick={() => setEditando(null)} style={{ padding: '11px 16px', border: '1px solid var(--line)', borderRadius: 8, background: 'none', fontSize: 13 }}>Cancelar</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
const inp: React.CSSProperties = { padding: '9px 12px', border: '1px solid var(--line)', borderRadius: 8, background: 'var(--card)', fontSize: 13 };
const lbl: React.CSSProperties = { display: 'block', fontSize: 11, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--muted)', margin: '10px 0 5px' };
const campo: React.CSSProperties = { width: '100%', padding: '9px 11px', border: '1px solid var(--line)', borderRadius: 8, background: 'var(--bg)', fontSize: 13.5, boxSizing: 'border-box' };
