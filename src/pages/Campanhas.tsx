import { useEffect, useState } from 'react';
import { FolderOpen, Check } from 'lucide-react';
import { useAppStore } from '../store/appStore';
import { useRoleInfo } from '../lib/selectors';
import { apiFetch } from '../lib/api';
import { Miniatura, VisualizarCriativo, type Criativo } from '../components/CriativoDoLead';

/** Campanhas (v1): cada anúncio que já trouxe lead, com o criativo. O criativo vem sozinho da pasta
 *  do Google Drive (casado pelo nome do anúncio); o link manual por campanha continua valendo e manda. */
type Camp = { nome: string; total: number; ult7: number; ult30: number; ultimo: string | null; driveUrl: string | null; observacao: string | null };
type Config = { pastaUrl: string | null; total: number; imagens?: number; videos?: number; erro?: string };

/** Link de arquivo do Drive → criativo (prévia). Link de pasta não tem prévia. */
function criativoManual(url: string | null): Criativo | null {
  if (!url) return null;
  const m = url.match(/\/file\/d\/([^/]+)/) || url.match(/[?&]id=([^&]+)/);
  return m ? { id: m[1], nome: 'Criativo', tipo: 'outro', thumb: 'https://drive.google.com/thumbnail?id=' + m[1] + '&sz=w800', preview: 'https://drive.google.com/file/d/' + m[1] + '/preview', url } : null;
}

export default function Campanhas() {
  const token = useAppStore(s => s.token);
  const toast = useAppStore(s => s.toast);
  const { isManager } = useRoleInfo();
  const [lista, setLista] = useState<Camp[]>([]);
  const [todas, setTodas] = useState(false);
  const [busca, setBusca] = useState('');
  const [editando, setEditando] = useState<{ nome: string; driveUrl: string; novo?: boolean } | null>(null);
  const [config, setConfig] = useState<Config | null>(null);
  const [pasta, setPasta] = useState('');
  const [salvandoPasta, setSalvandoPasta] = useState(false);
  const [casados, setCasados] = useState<Record<string, Criativo[]>>({});
  const [aberto, setAberto] = useState<{ c: Criativo; lista: Criativo[] } | null>(null);

  const carregar = () => { if (token) apiFetch<Camp[]>('/api/relatorios-oka/campanhas', token).then(setLista).catch(() => toast('Não foi possível carregar as campanhas')); };
  const carregarConfig = () => { if (token) apiFetch<Config>('/api/criativos/config', token).then(c => { setConfig(c); setPasta(c.pastaUrl ?? ''); }).catch(() => {}); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { carregar(); carregarConfig(); }, [token]);
  // casa os anúncios da lista com os criativos da pasta
  useEffect(() => {
    if (!token || !lista.length || !config?.pastaUrl) { setCasados({}); return; }
    apiFetch<Record<string, Criativo[]>>('/api/criativos/casar', token, { method: 'POST', body: JSON.stringify({ nomes: lista.map(c => c.nome) }) })
      .then(setCasados).catch(() => {});
  }, [token, lista, config?.pastaUrl, config?.total]);

  const visiveis = lista.filter(c => (todas || c.ult30 > 0 || (!c.total && c.driveUrl !== undefined)) && (!busca || c.nome.toLowerCase().includes(busca.toLowerCase())));
  const comCriativo = visiveis.filter(c => criativoManual(c.driveUrl) || casados[c.nome]?.length).length;

  async function salvar() {
    if (!editando?.nome.trim() || !token) return;
    try {
      await apiFetch('/api/relatorios-oka/campanhas', token, { method: 'PUT', body: JSON.stringify({ nome: editando.nome.trim(), driveUrl: editando.driveUrl.trim() || null }) });
      setEditando(null); carregar();
    } catch { toast('Não foi possível salvar'); }
  }
  async function salvarPasta() {
    if (!token) return;
    setSalvandoPasta(true);
    try {
      const r = await apiFetch<Config>('/api/criativos/config', token, { method: 'PUT', body: JSON.stringify({ pastaUrl: pasta.trim() || null }) });
      toast(r.pastaUrl ? `Pasta conectada: ${r.total} criativos encontrados` : 'Pasta desconectada');
      carregarConfig();
    } catch (e) { toast((e as Error).message || 'Não foi possível ler a pasta'); }
    finally { setSalvandoPasta(false); }
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', marginBottom: 14 }}>
        <div>
          <p style={{ fontSize: 11, letterSpacing: '.18em', textTransform: 'uppercase', color: 'var(--muted)', margin: '0 0 4px' }}>Marketing</p>
          <h1 style={{ fontFamily: 'Newsreader,serif', fontWeight: 400, fontSize: 24, margin: 0, lineHeight: 1.2 }}>Campanhas</h1>
          <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: '5px 0 0' }}>Cada anúncio que já trouxe leads, com o criativo. Por padrão, só os que trouxeram lead nos últimos 30 dias.</p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <input value={busca} onChange={e => setBusca(e.target.value)} placeholder="Buscar pelo nome…" style={inp} />
          <button onClick={() => setTodas(v => !v)} style={{ ...inp, fontWeight: 600 }}>{todas ? 'Últimos 30 dias' : 'Todas'}</button>
          {isManager && <button onClick={() => setEditando({ nome: '', driveUrl: '', novo: true })} style={{ padding: '9px 14px', border: 'none', borderRadius: 8, background: 'var(--terra)', color: '#fff', fontSize: 13, fontWeight: 600 }}>Nova campanha</button>}
        </div>
      </div>

      {/* pasta de criativos no Drive */}
      {isManager && (
        <div style={{ border: '1px solid var(--line)', borderRadius: 12, background: 'var(--card)', padding: '14px 16px', marginBottom: 16, display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ width: 40, height: 40, borderRadius: 10, background: 'var(--terraSoft)', color: 'var(--terra)', display: 'grid', placeItems: 'center', flex: 'none' }}><FolderOpen size={19} /></span>
          <div style={{ flex: '1 1 260px', minWidth: 0 }}>
            <p style={{ margin: 0, fontSize: 13.5, fontWeight: 700 }}>Pasta de criativos no Google Drive</p>
            <p style={{ margin: '2px 0 0', fontSize: 12, color: 'var(--muted)', lineHeight: 1.5 }}>
              {config?.pastaUrl && !config.erro
                ? <><Check size={12} style={{ verticalAlign: '-2px' }} color="var(--olive)" /> {config.total} criativos lidos ({config.imagens ?? 0} imagens, {config.videos ?? 0} vídeos) · {comCriativo} de {visiveis.length} campanhas da lista com criativo. Nomeie o arquivo igual ao anúncio.</>
                : config?.erro ? <span style={{ color: 'var(--terra)' }}>{config.erro}</span>
                : 'Cole o link da pasta (compartilhada como "Qualquer pessoa com o link"). O CRM acha o criativo de cada anúncio pelo nome do arquivo.'}
            </p>
          </div>
          <input value={pasta} onChange={e => setPasta(e.target.value)} placeholder="https://drive.google.com/drive/folders/…" style={{ ...inp, flex: '1 1 300px' }} />
          <button onClick={salvarPasta} disabled={salvandoPasta} style={{ padding: '9px 14px', border: 'none', borderRadius: 8, background: 'var(--terra)', color: '#fff', fontSize: 13, fontWeight: 600, opacity: salvandoPasta ? 0.6 : 1 }}>{salvandoPasta ? 'Lendo a pasta…' : config?.pastaUrl ? 'Atualizar' : 'Conectar pasta'}</button>
        </div>
      )}

      {/* OBS pro dono: o nome do arquivo no Drive tem que ser igual ao nome do anúncio na Meta */}
      {isManager && (
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', padding: '14px 16px', marginBottom: 16, border: '1px solid #E0B44A', borderLeft: '4px solid #D99A1E', borderRadius: 12, background: 'rgba(233,178,64,.12)' }}>
          <span style={{ fontSize: 18, lineHeight: 1, flex: 'none' }}>⚠️</span>
          <div style={{ minWidth: 0, fontSize: 13, lineHeight: 1.55 }}>
            <p style={{ margin: 0, fontWeight: 800, letterSpacing: '.02em' }}>OBS: o nome do arquivo no Drive tem que ser IGUAL ao nome do anúncio no Gerenciador de Anúncios da Meta</p>
            <p style={{ margin: '4px 0 0', color: 'var(--ink)' }}>
              É assim que o CRM descobre qual criativo trouxe cada lead. Exemplo: anúncio <b>[CN 38] [SETE SÓIS]</b> na Meta → arquivo <b>[CN 38] [SETE SÓIS].png</b> (ou .mp4) no Drive.
              Acento, letra maiúscula/minúscula e espaços não atrapalham — o que importa são as palavras e os números.
            </p>
            {(() => {
              const faltando = visiveis.filter(c => !criativoManual(c.driveUrl) && !casados[c.nome]?.length && !/^(whatsapp|manual|site|importa)/i.test(c.nome.trim())).map(c => c.nome);
              if (!config?.pastaUrl || !faltando.length) return null;
              return (
                <p style={{ margin: '8px 0 0', color: 'var(--ink)' }}>
                  <b>Anúncios sem criativo na pasta ({faltando.length}):</b>{' '}
                  {faltando.slice(0, 8).map((n, i) => <span key={n}>{i ? ' · ' : ''}<code style={{ fontSize: 12, background: 'var(--card)', padding: '1px 6px', borderRadius: 5, border: '1px solid var(--line)' }}>{n}</code></span>)}
                  {faltando.length > 8 ? ` e mais ${faltando.length - 8}` : ''} — suba o arquivo com esse nome que ele aparece sozinho.
                </p>
              );
            })()}
          </div>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(250px,1fr))', gap: 14 }}>
        {visiveis.map(c => {
          const manual = criativoManual(c.driveUrl);
          const daPasta = casados[c.nome] ?? [];
          const principal = manual ?? daPasta[0] ?? null;
          const listaCriativos = manual ? [manual] : daPasta;
          return (
            <div key={c.nome} style={{ border: '1px solid var(--line)', borderRadius: 12, background: 'var(--card)', overflow: 'hidden' }}>
              <div style={{ height: 170, background: 'var(--bg)', display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative' }}>
                {principal
                  ? <Miniatura c={principal} largura="100%" altura="100%" onClick={() => setAberto({ c: principal, lista: listaCriativos })} />
                  : c.driveUrl ? <a href={c.driveUrl} target="_blank" rel="noreferrer" style={{ fontSize: 12.5, color: 'var(--terra)', fontWeight: 600 }}>Abrir no Drive</a>
                  : <span style={{ fontSize: 12, color: 'var(--muted)' }}>Sem criativo</span>}
                {listaCriativos.length > 1 && <span style={{ position: 'absolute', top: 8, right: 8, fontSize: 10.5, fontWeight: 800, color: '#fff', background: 'rgba(0,0,0,.6)', padding: '2px 7px', borderRadius: 20 }}>+{listaCriativos.length - 1}</span>}
              </div>
              <div style={{ padding: 14 }}>
                <p style={{ margin: 0, fontSize: 13.5, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={c.nome}>{c.nome}</p>
                <p style={{ margin: '6px 0 0', fontSize: 12.5, color: 'var(--muted)' }}><b style={{ color: 'var(--ink)' }}>{c.total}</b> leads · {c.ult7} em 7 dias · {c.ult30} em 30 dias</p>
                <p style={{ margin: '3px 0 0', fontSize: 11.5, color: 'var(--muted)' }}>Último: {c.ultimo ? new Date(c.ultimo).toLocaleDateString('pt-BR') : '—'}</p>
                {isManager && <button onClick={() => setEditando({ nome: c.nome, driveUrl: c.driveUrl ?? '' })} style={{ marginTop: 10, padding: '6px 11px', border: '1px solid var(--line)', borderRadius: 7, background: 'none', fontSize: 12 }}>✎ Trocar criativo</button>}
              </div>
            </div>
          );
        })}
      </div>
      {visiveis.length === 0 && <p style={{ fontSize: 13, color: 'var(--muted)' }}>Nenhuma campanha {todas ? '' : 'nos últimos 30 dias'}.</p>}

      {aberto && <VisualizarCriativo c={aberto.c} lista={aberto.lista} onTrocar={x => setAberto({ ...aberto, c: x })} onFechar={() => setAberto(null)} />}

      {editando && (
        <div onClick={() => setEditando(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(8,17,31,.5)', zIndex: 70, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
          <div onClick={e => e.stopPropagation()} style={{ width: '100%', maxWidth: 460, background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 14, padding: 22 }}>
            <p style={{ fontFamily: 'Newsreader,serif', fontSize: 20, margin: '0 0 12px' }}>{editando.novo ? 'Nova campanha' : editando.nome}</p>
            {editando.novo && (<><label style={lbl}>Nome exatamente como vem no anúncio</label><input value={editando.nome} onChange={e => setEditando({ ...editando, nome: e.target.value })} style={campo} /></>)}
            <label style={lbl}>Link de um arquivo no Google Drive (opcional)</label>
            <input value={editando.driveUrl} onChange={e => setEditando({ ...editando, driveUrl: e.target.value })} placeholder="https://drive.google.com/file/d/…" style={campo} />
            <p style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.5, margin: '8px 0 0' }}>Normalmente não precisa: o CRM acha o criativo na pasta conectada pelo nome do arquivo. Use isso só pra forçar outro arquivo nessa campanha.</p>
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
