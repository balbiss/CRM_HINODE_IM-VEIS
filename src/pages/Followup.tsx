import { useEffect, useMemo, useRef, useState } from 'react';
import { MessageSquare, Mic, Image as ImageIcon, FileText, Trash2, ArrowUp, ArrowDown, Plus, Upload, Video, Archive, Copy, RotateCcw } from 'lucide-react';
import { useAppStore, type RemoteFluxo, type RemotePassoFluxo, type PassoTipo } from '../store/appStore';
import { MOTIVOS_DESCARTE_NORMAL } from '../lib/data';
import { useRoleInfo } from '../lib/selectors';
import { uploadArquivo } from '../lib/upload';

const TIPOS: { v: PassoTipo; label: string; Icon: typeof MessageSquare }[] = [
  { v: 'texto', label: 'Texto', Icon: MessageSquare },
  { v: 'audio', label: 'Áudio', Icon: Mic },
  { v: 'imagem', label: 'Imagem', Icon: ImageIcon },
  { v: 'video', label: 'Vídeo', Icon: Video },
  { v: 'pdf', label: 'PDF', Icon: FileText },
];

/** Quando o passo sai (v1). O 1º passo sempre sai na hora; os outros nas levas da manhã e das 16h. */
const QUANDO: { v: string; label: string; base: 'proxima_leva' | 'passo_anterior'; min: number }[] = [
  { v: 'leva', label: 'Na próxima leva', base: 'proxima_leva', min: 0 },
  { v: '1d', label: '1 dia depois', base: 'passo_anterior', min: 1440 },
  { v: '2d', label: '2 dias depois', base: 'passo_anterior', min: 2880 },
  { v: '3d', label: '3 dias depois', base: 'passo_anterior', min: 4320 },
  { v: '7d', label: '7 dias depois', base: 'passo_anterior', min: 10080 },
];
const quandoDe = (p: RemotePassoFluxo) => p.baseAtraso === 'proxima_leva' ? 'leva'
  : (QUANDO.find(q => q.base === 'passo_anterior' && q.min === p.atrasoMinutos)?.v ?? '1d');
const STATUS_EXEC: Record<string, string> = { ativa: 'rodando', pausada: 'pausado', encerrada: 'encerrado' };

const fieldLabel: React.CSSProperties = { display: 'block', fontSize: 11, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--muted)', margin: '0 0 6px' };
const inp: React.CSSProperties = { width: '100%', padding: '9px 11px', border: '1px solid var(--line)', borderRadius: 8, background: 'var(--bg)', fontSize: 13, boxSizing: 'border-box' };
const iconBtn: React.CSSProperties = { border: '1px solid var(--line)', background: 'var(--card)', width: 28, height: 28, borderRadius: 7, fontSize: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' };

const ACCEPT: Record<PassoTipo, string> = { texto: '', audio: 'audio/*', imagem: 'image/*', video: 'video/*', pdf: 'application/pdf' };

function PassoAnexo({ passo, onChange }: { passo: RemotePassoFluxo; onChange: (p: Partial<RemotePassoFluxo>) => void }) {
  const token = useAppStore(s => s.token);
  const toast = useAppStore(s => s.toast);
  const ref = useRef<HTMLInputElement>(null);
  const [enviando, setEnviando] = useState(false);

  async function subir(file: File) {
    if (!token) return;
    setEnviando(true);
    try {
      const { url, nome } = await uploadArquivo(file, token);
      onChange({ anexoUrl: url, anexoNome: nome });
    } catch (e) {
      toast((e as Error).message || 'Falha no upload');
    } finally {
      setEnviando(false);
    }
  }

  return (
    <div style={{ marginBottom: 6 }}>
      <input ref={ref} type="file" accept={ACCEPT[passo.tipo]} hidden onChange={e => { const f = e.target.files?.[0]; if (f) subir(f); e.currentTarget.value = ''; }} />
      {passo.anexoUrl ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', border: '1px solid var(--line)', borderRadius: 8, background: 'var(--card)' }}>
          <FileText size={13} style={{ flex: 'none', color: 'var(--muted)' }} />
          <a href={passo.anexoUrl} target="_blank" rel="noreferrer" style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: 'var(--terra)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{passo.anexoNome || 'arquivo'}</a>
          <button type="button" onClick={() => ref.current?.click()} style={{ border: '1px solid var(--line)', background: 'none', borderRadius: 6, fontSize: 11.5, padding: '4px 8px' }}>Trocar</button>
          <button type="button" onClick={() => onChange({ anexoUrl: null, anexoNome: null })} style={{ border: 'none', background: 'none', color: 'var(--terra)', fontSize: 11.5 }}>Remover</button>
        </div>
      ) : (
        <button type="button" onClick={() => ref.current?.click()} disabled={enviando} style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', justifyContent: 'center', padding: '10px', border: '1px dashed var(--line)', borderRadius: 8, background: 'var(--card)', fontSize: 12.5, fontWeight: 600, color: 'var(--muted)' }}>
          <Upload size={13} /> {enviando ? 'Enviando…' : 'Enviar ' + (passo.tipo === 'imagem' ? 'imagem' : passo.tipo === 'audio' ? 'áudio' : passo.tipo === 'video' ? 'vídeo' : 'PDF')}
        </button>
      )}
    </div>
  );
}

interface Rascunho {
  nome: string; ativo: boolean; disparaEmLeadNovo: boolean;
  aoEsgotar: 'nada' | 'descartar' | 'mover'; aoEsgotarColunaId: string | null; motivoDescarteEsgotar: string;
  passos: RemotePassoFluxo[];
}
const doFluxo = (f: RemoteFluxo): Rascunho => ({
  nome: f.nome, ativo: f.ativo, disparaEmLeadNovo: f.disparaEmLeadNovo,
  aoEsgotar: f.aoEsgotar, aoEsgotarColunaId: f.aoEsgotarColunaId, motivoDescarteEsgotar: f.motivoDescarteEsgotar || 'Sem Resposta',
  passos: f.passos.map(p => ({ ...p })),
});

export default function Followup() {
  const { isManager, meNome } = useRoleInfo();
  const fluxos = useAppStore(s => s.fluxos);
  const execucoes = useAppStore(s => s.execucoesFollowup);
  const perfis = useAppStore(s => s.perfisRemotos);
  const colunas = useAppStore(s => s.colunasRemotas);
  const criarFluxo = useAppStore(s => s.criarFluxo);
  const atualizarFluxo = useAppStore(s => s.atualizarFluxo);
  const salvarPassos = useAppStore(s => s.salvarPassos);
  const excluirFluxo = useAppStore(s => s.excluirFluxo);
  const copiarFluxo = useAppStore(s => s.copiarFluxo);
  const arquivados = useAppStore(s => s.fluxosArquivados);
  const fetchArquivados = useAppStore(s => s.fetchFluxosArquivados);
  const automatico = useAppStore(s => s.followupAutomaticoAtivo);
  const setAutomatico = useAppStore(s => s.setFollowupAutomatico);
  const souDono = useAppStore(s => s.me?.role === 'dono');
  const [verArquivados, setVerArquivados] = useState(false);
  const mudarExecucao = useAppStore(s => s.mudarExecucao);
  const fetchFollowup = useAppStore(s => s.fetchFollowup);
  const openLead = useAppStore(s => s.openLead);
  const ask = useAppStore(s => s.ask);

  useEffect(() => { fetchFollowup(); }, [fetchFollowup]);

  const corretores = useMemo(() => perfis.filter(p => p.role === 'corretor'), [perfis]);
  const [aba, setAba] = useState<'fluxos' | 'andamento'>('fluxos');
  const [corretorSel, setCorretorSel] = useState<string>('');
  const meId = perfis.find(p => p.nome === meNome)?.id;
  const corretorAtivo = isManager ? corretorSel : (meId ?? '');

  // corretor vê os dele + os modelos da imobiliária (sem dono), que ele copia com "Usar como base"
  const fluxosDoCorretor = fluxos.filter(f => (isManager ? (corretorAtivo ? f.corretorId === corretorAtivo || !f.corretorId : true) : f.corretorId === meId || !f.corretorId));
  const [fluxoIdSel, setFluxoIdSel] = useState<string | null>(null);
  const fluxo = fluxos.find(f => f.id === fluxoIdSel) ?? fluxosDoCorretor[0] ?? null;

  const [rasc, setRasc] = useState<Rascunho | null>(null);
  const [dirty, setDirty] = useState(false);
  useEffect(() => { setRasc(fluxo ? doFluxo(fluxo) : null); setDirty(false); }, [fluxo?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const [novoNome, setNovoNome] = useState('');
  const patch = (p: Partial<Rascunho>) => { setRasc(r => (r ? { ...r, ...p } : r)); setDirty(true); };
  const patchPasso = (i: number, p: Partial<RemotePassoFluxo>) => {
    setRasc(r => (r ? { ...r, passos: r.passos.map((x, j) => (j === i ? { ...x, ...p } : x)) } : r));
    setDirty(true);
  };
  const moverPasso = (i: number, dir: -1 | 1) => {
    setRasc(r => {
      if (!r) return r;
      const j = i + dir;
      if (j < 0 || j >= r.passos.length) return r;
      const passos = [...r.passos];
      [passos[i], passos[j]] = [passos[j], passos[i]];
      return { ...r, passos };
    });
    setDirty(true);
  };
  const addPasso = () => {
    patch({
      passos: [...(rasc?.passos ?? []), {
        tipo: 'texto', conteudo: rasc?.passos.length ? '' : 'Oi {nome}, aqui é {corretor}. ',
        baseAtraso: rasc?.passos.length ? 'proxima_leva' : 'inscricao', atrasoMinutos: 0,
        atrasoTexto: rasc?.passos.length ? 'na próxima leva' : 'na hora', soHorarioComercial: false,
        cadenciaLabel: null, anexoUrl: null, anexoNome: null,
      }],
    });
  };

  async function salvar() {
    if (!fluxo || !rasc) return;
    await atualizarFluxo(fluxo.id, {
      nome: rasc.nome, ativo: rasc.ativo, disparaEmLeadNovo: rasc.disparaEmLeadNovo,
      aoEsgotar: rasc.aoEsgotar, aoEsgotarColunaId: rasc.aoEsgotar === 'mover' ? rasc.aoEsgotarColunaId : null,
      motivoDescarteEsgotar: rasc.motivoDescarteEsgotar,
    });
    await salvarPassos(fluxo.id, rasc.passos.map((p, i) => {
      if (i === 0) return { ...p, baseAtraso: 'inscricao' as const, atrasoMinutos: 0, atrasoTexto: 'na hora' };
      const q = QUANDO.find(x => x.v === quandoDe(p))!;
      return { ...p, baseAtraso: q.base, atrasoMinutos: q.min, atrasoTexto: q.label.toLowerCase() };
    }));
    setDirty(false);
  }

  async function criar() {
    if (!novoNome.trim()) return;
    const alvo = isManager ? (corretorAtivo || undefined) : meId;
    const f = await criarFluxo(novoNome.trim(), alvo);
    setNovoNome('');
    if (f) setFluxoIdSel(f.id);
  }

  const pill = (txt: string, on: boolean) => (
    <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.05em', textTransform: 'uppercase', padding: '3px 7px', borderRadius: 20, background: on ? 'var(--terraSoft)' : 'var(--bg)', color: on ? 'var(--terra)' : 'var(--muted)', border: '1px solid ' + (on ? 'transparent' : 'var(--line)') }}>{txt}</span>
  );

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <p style={{ fontSize: 11, letterSpacing: '.18em', textTransform: 'uppercase', color: 'var(--muted)', margin: '0 0 4px' }}>Automação</p>
        <h1 style={{ fontFamily: 'Newsreader,serif', fontWeight: 400, fontSize: 24, margin: 0, lineHeight: 1.2 }}>Follow-up Automático</h1>
        <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: '6px 0 0', maxWidth: 640, lineHeight: 1.5 }}>
          A 1ª mensagem sai na hora que o lead chega pro corretor; as outras saem nas levas da manhã (a partir de 9h30) e
          das 16h — sábado até 15h, domingo nada — com 40 a 60 segundos entre mensagens do mesmo corretor. O robô para
          sozinho quando o cliente responde, quando você manda mensagem manual ou tira o card da coluna FOLLOW-UP
          AUTOMÁTICO. Se a 1ª mensagem não sair em 24h (WhatsApp desconectado), o follow-up é cancelado e você é avisado.
        </p>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', border: '1px solid ' + (automatico ? 'var(--olive)' : 'var(--line)'), borderRadius: 10, padding: '11px 14px', marginBottom: 16, background: 'var(--card)' }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: automatico ? 'var(--olive)' : 'var(--muted)' }} />
        <span style={{ flex: 1, minWidth: 220, fontSize: 13 }}>
          <strong>Follow-up automático da imobiliária: {automatico ? 'ligado' : 'desligado'}.</strong>{' '}
          <span style={{ color: 'var(--muted)' }}>{automatico ? 'Os fluxos "Geral" disparam sozinhos quando o lead ganha corretor.' : 'Os fluxos "Geral" ficam prontos mas não disparam sozinhos (o "Iniciar follow-up" no card continua funcionando).'}</span>
        </span>
        {souDono && (
          <button onClick={() => setAutomatico(!automatico)} style={{ padding: '7px 13px', border: '1px solid var(--line)', borderRadius: 8, background: 'none', fontSize: 12.5, fontWeight: 600 }}>{automatico ? 'Desligar' : 'Ligar'}</button>
        )}
      </div>

      <div style={{ display: 'flex', gap: 22, borderBottom: '1px solid var(--line)', marginBottom: 18 }}>
        {(['fluxos', 'andamento'] as const).map(t => (
          <button key={t} onClick={() => setAba(t)} style={{ padding: '0 0 12px', border: 'none', background: 'none', fontSize: 13.5, fontWeight: aba === t ? 700 : 500, color: aba === t ? 'var(--ink)' : 'var(--muted)', borderBottom: '2px solid ' + (aba === t ? 'var(--terra)' : 'transparent'), marginBottom: -1 }}>
            {t === 'fluxos' ? 'Meus fluxos' : 'Em andamento' + (execucoes.length ? ' (' + execucoes.length + ')' : '')}
          </button>
        ))}
      </div>

      {aba === 'andamento' ? (
        <div style={{ border: '1px solid var(--line)', borderRadius: 12, background: 'var(--card)', overflow: 'hidden' }}>
          {execucoes.map(e => (
            <div key={e.id} style={{ display: 'flex', gap: 14, alignItems: 'center', padding: '13px 18px', borderBottom: '1px solid var(--line)', flexWrap: 'wrap' }}>
              <button onClick={() => openLead(e.leadId)} style={{ border: 'none', background: 'none', textAlign: 'left', padding: 0, flex: 1, minWidth: 160 }}>
                <span style={{ display: 'block', fontSize: 13.5, fontWeight: 700 }}>{e.leadNome}</span>
                <span style={{ display: 'block', fontSize: 11.5, color: 'var(--muted)' }}>{e.fluxoNome}{e.corretorNome ? ' · ' + e.corretorNome : ''}</span>
              </button>
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>passo {Math.min(e.passoAtual + 1, e.totalPassos)}/{e.totalPassos}</span>
              <span style={{ fontSize: 11.5, color: 'var(--muted)', minWidth: 130 }}>
                {e.status === 'pausada' ? (e.motivoFim || 'pausado')
                  : e.proximoEnvioEm ? 'próx. ' + new Date(e.proximoEnvioEm).toLocaleString('pt-BR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
                  : '—'}
              </span>
              <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em', padding: '3px 8px', borderRadius: 20, background: e.status === 'ativa' ? 'var(--oliveSoft)' : 'var(--terraSoft)', color: e.status === 'ativa' ? 'var(--olive)' : 'var(--terra)' }}>{STATUS_EXEC[e.status] ?? e.status}</span>
              <div style={{ display: 'flex', gap: 6 }}>
                {e.status === 'ativa'
                  ? <button onClick={() => mudarExecucao(e.id, 'pausada')} style={{ ...iconBtn, width: 'auto', padding: '0 10px', fontSize: 12, fontWeight: 600 }}>Pausar</button>
                  : <button onClick={() => mudarExecucao(e.id, 'ativa')} style={{ ...iconBtn, width: 'auto', padding: '0 10px', fontSize: 12, fontWeight: 600, color: 'var(--olive)', borderColor: 'var(--olive)' }}>Retomar</button>}
                <button onClick={() => ask('Encerrar follow-up?', e.leadNome + ' sai da régua e não recebe mais mensagens programadas.', 'Encerrar', () => mudarExecucao(e.id, 'encerrada'))} style={{ ...iconBtn, width: 'auto', padding: '0 10px', fontSize: 12, color: 'var(--terra)' }}>Encerrar</button>
              </div>
            </div>
          ))}
          {execucoes.length === 0 && <p style={{ padding: '30px 18px', textAlign: 'center', fontSize: 13, color: 'var(--muted)', margin: 0 }}>Nenhum lead em follow-up agora.</p>}
        </div>
      ) : (
        <div className="split-pane" style={{ display: 'grid', gridTemplateColumns: '240px 1fr', gap: 14, alignItems: 'start' }}>
          <div className="split-aside" style={{ display: 'flex', flexDirection: 'column', gap: 12, position: 'sticky', top: 78 }}>
            <div style={{ border: '1px solid var(--line)', borderRadius: 12, background: 'var(--card)', padding: 14 }}>
              {isManager && (
                <>
                  <label style={fieldLabel}>Corretor</label>
                  <select value={corretorAtivo} onChange={e => { setCorretorSel(e.target.value); setFluxoIdSel(null); }} style={{ ...inp, marginBottom: 12 }}>
                    <option value="">Todos</option>
                    {corretores.map(c => <option key={c.id} value={c.id}>{c.nome}</option>)}
                  </select>
                </>
              )}
              <p style={{ fontSize: 10.5, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--muted)', margin: '0 0 8px' }}>Fluxos</p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
                {fluxosDoCorretor.length === 0 && <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: 0 }}>Nenhum fluxo ainda.</p>}
                {fluxosDoCorretor.map(f => (
                  <button key={f.id} onClick={() => setFluxoIdSel(f.id)} style={{ textAlign: 'left', padding: '9px 11px', borderRadius: 8, border: '1px solid ' + (f.id === fluxo?.id ? 'var(--terra)' : 'var(--line)'), background: f.id === fluxo?.id ? 'var(--terraSoft)' : 'var(--bg)' }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ width: 6, height: 6, borderRadius: '50%', background: f.ativo ? 'var(--olive)' : 'var(--muted)', flex: 'none' }} />
                      <span style={{ fontSize: 13, fontWeight: 700, flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{f.nome}</span>
                    </span>
                    <span style={{ fontSize: 11, color: 'var(--muted)' }}>{f.passos.length} passo{f.passos.length === 1 ? '' : 's'}{f.disparaEmLeadNovo ? ' · Geral' : ''}{!f.corretorId ? ' · Modelo' : ''}{f.campanha ? ' · campanha' : ''}</span>
                    {!f.corretorId && (
                      <span onClick={ev => { ev.stopPropagation(); void copiarFluxo(f.id).then(n => { if (n) setFluxoIdSel(n.id); }); }} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginTop: 5, fontSize: 11, fontWeight: 600, color: 'var(--terra)' }}><Copy size={11} /> Usar como base</span>
                    )}
                  </button>
                ))}
              </div>
              <label style={fieldLabel}>Novo fluxo</label>
              <input value={novoNome} onChange={e => setNovoNome(e.target.value)} onKeyDown={e => e.key === 'Enter' && criar()} placeholder="Ex: Boas-vindas" style={{ ...inp, marginBottom: 8 }} />
              <button onClick={criar} disabled={isManager && !corretorAtivo} style={{ width: '100%', padding: '9px', border: 'none', borderRadius: 8, background: 'var(--terra)', color: '#fff', fontSize: 12.5, fontWeight: 600, opacity: isManager && !corretorAtivo ? 0.5 : 1 }}>+ Criar fluxo</button>
              {isManager && !corretorAtivo && <p style={{ fontSize: 11, color: 'var(--muted)', margin: '6px 0 0' }}>Escolha um corretor pra criar.</p>}
              <button onClick={() => { setVerArquivados(v => !v); void fetchArquivados(); }} style={{ marginTop: 12, width: '100%', padding: '7px', border: 'none', background: 'none', fontSize: 12, color: 'var(--muted)', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5 }}>
                <Archive size={12} /> {verArquivados ? 'Esconder arquivados' : 'Ver arquivados'}
              </button>
              {verArquivados && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}>
                  {arquivados.length === 0 && <p style={{ fontSize: 12, color: 'var(--muted)', margin: 0 }}>Nenhum arquivado.</p>}
                  {arquivados.map(f => (
                    <div key={f.id} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 9px', border: '1px dashed var(--line)', borderRadius: 8 }}>
                      <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{f.nome}</span>
                      <button title="Restaurar (volta desativado)" onClick={() => atualizarFluxo(f.id, { arquivado: false })} style={iconBtn}><RotateCcw size={12} /></button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div>
            {fluxo && rasc ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <div style={{ border: '1px solid var(--line)', borderRadius: 12, background: 'var(--card)', padding: 16 }}>
                  <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 14 }}>
                    <input value={rasc.nome} onChange={e => patch({ nome: e.target.value })} style={{ fontFamily: 'Newsreader,serif', fontSize: 18, border: '1px solid var(--line)', background: 'var(--bg)', padding: '5px 8px', borderRadius: 7, minWidth: 160, flex: 1 }} />
                    <button onClick={() => patch({ ativo: !rasc.ativo })} style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '7px 11px', border: '1px solid var(--line)', borderRadius: 20, background: 'var(--card)', fontSize: 12, fontWeight: 600 }}>
                      <span style={{ width: 24, height: 14, borderRadius: 8, background: rasc.ativo ? 'var(--olive)' : 'var(--line)', padding: 2, display: 'flex', justifyContent: rasc.ativo ? 'flex-end' : 'flex-start' }}>
                        <span style={{ width: 10, height: 10, borderRadius: '50%', background: '#fff' }} />
                      </span>
                      {rasc.ativo ? 'Ativo' : 'Inativo'}
                    </button>
                    <button title="Arquivar (para de disparar, fica guardado)" onClick={() => ask('Arquivar "' + fluxo.nome + '"?', 'Sai da lista, para de disparar e deixa de ser o Geral. Os passos ficam guardados em "Ver arquivados".', 'Arquivar', () => { void atualizarFluxo(fluxo.id, { arquivado: true }); setFluxoIdSel(null); })} style={iconBtn}><Archive size={13} /></button>
                    {isManager && <button title="Excluir de vez" onClick={() => ask('Excluir fluxo "' + fluxo.nome + '" de vez?', 'Os passos e o histórico de execuções somem. Pra só tirar de uso, prefira arquivar.', 'Excluir', () => { excluirFluxo(fluxo.id); setFluxoIdSel(null); })} style={{ ...iconBtn, color: 'var(--terra)' }}><Trash2 size={13} /></button>}
                  </div>

                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, marginBottom: 14 }}>
                    <input type="checkbox" checked={rasc.disparaEmLeadNovo} onChange={e => patch({ disparaEmLeadNovo: e.target.checked })} />
                    <strong>Geral</strong> — entra sozinho em todo lead que o corretor receber (roleta ou transferência)
                    <span style={{ fontSize: 11, color: 'var(--muted)' }}>(só um Geral por corretor; lead cadastrado à mão não entra sozinho)</span>
                  </label>

                  <p style={fieldLabel}>Quando a régua terminar</p>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <select value={rasc.aoEsgotar} onChange={e => patch({ aoEsgotar: e.target.value as Rascunho['aoEsgotar'] })} style={{ ...inp, width: 200 }}>
                      <option value="nada">Não fazer nada</option>
                      <option value="descartar">Descartar o lead</option>
                      <option value="mover">Mover pra uma coluna</option>
                    </select>
                    {rasc.aoEsgotar === 'descartar' && (
                      <select value={rasc.motivoDescarteEsgotar} onChange={e => patch({ motivoDescarteEsgotar: e.target.value })} style={{ ...inp, width: 220 }}>
                        {MOTIVOS_DESCARTE_NORMAL.map(m => <option key={m} value={m}>Motivo: {m}</option>)}
                      </select>
                    )}
                    {rasc.aoEsgotar === 'mover' && (
                      <select value={rasc.aoEsgotarColunaId ?? ''} onChange={e => patch({ aoEsgotarColunaId: e.target.value || null })} style={{ ...inp, width: 200 }}>
                        <option value="">Escolha a coluna…</option>
                        {colunas.map(c => <option key={c.id} value={c.id}>{c.titulo}</option>)}
                      </select>
                    )}
                  </div>
                </div>

                <div style={{ border: '1px solid var(--line)', borderRadius: 12, background: 'var(--card)', padding: 16 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                    <p style={fieldLabel}>Passos da régua</p>
                    <span style={{ fontSize: 11, color: 'var(--muted)' }}>Variáveis: {'{nome} {corretor} {origem} {bairro} {imovel_titulo} {imovel_preco} {imovel_foto}'}</span>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    {rasc.passos.map((p, i) => {
                      const Icon = TIPOS.find(t => t.v === p.tipo)?.Icon ?? MessageSquare;
                      return (
                        <div key={i} style={{ border: '1px solid var(--line)', borderRadius: 10, padding: 12, background: 'var(--bg)' }}>
                          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10, flexWrap: 'wrap' }}>
                            <Icon size={14} color="var(--terra)" />
                            <select value={p.tipo} onChange={e => patchPasso(i, { tipo: e.target.value as PassoTipo })} style={{ ...inp, width: 110, padding: '6px 8px' }}>
                              {TIPOS.map(t => <option key={t.v} value={t.v}>{t.label}</option>)}
                            </select>
                            {i === 0 ? (
                              <span style={{ fontSize: 12, color: 'var(--muted)' }}>sai <strong>na hora</strong> que o lead chega pro corretor</span>
                            ) : (
                              <select value={quandoDe(p)} onChange={e => { const q = QUANDO.find(x => x.v === e.target.value)!; patchPasso(i, { baseAtraso: q.base, atrasoMinutos: q.min }); }} style={{ ...inp, width: 170, padding: '6px 8px' }}>
                                {QUANDO.map(q => <option key={q.v} value={q.v}>{q.label}</option>)}
                              </select>
                            )}
                            <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11.5, color: 'var(--muted)' }}>
                              <input type="checkbox" checked={!!p.soHorarioComercial} onChange={e => patchPasso(i, { soHorarioComercial: e.target.checked })} /> só seg–sáb 8h–20h
                            </label>
                            <span style={{ flex: 1 }} />
                            <button onClick={() => moverPasso(i, -1)} disabled={i === 0} style={{ ...iconBtn, opacity: i === 0 ? 0.4 : 1 }}><ArrowUp size={12} /></button>
                            <button onClick={() => moverPasso(i, 1)} disabled={i === rasc.passos.length - 1} style={{ ...iconBtn, opacity: i === rasc.passos.length - 1 ? 0.4 : 1 }}><ArrowDown size={12} /></button>
                            <button onClick={() => { patch({ passos: rasc.passos.filter((_, j) => j !== i) }); }} style={{ ...iconBtn, color: 'var(--terra)' }}><Trash2 size={12} /></button>
                          </div>
                          {p.tipo === 'texto' ? (
                            <textarea value={p.conteudo} onChange={e => patchPasso(i, { conteudo: e.target.value })} rows={3} style={{ ...inp, resize: 'vertical', fontFamily: 'inherit' }} placeholder="Mensagem…" />
                          ) : (
                            <>
                              <PassoAnexo passo={p} onChange={patch => patchPasso(i, patch)} />
                              <input value={p.conteudo} onChange={e => patchPasso(i, { conteudo: e.target.value })} placeholder="Legenda (opcional)" style={{ ...inp, fontSize: 12 }} />
                            </>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  <button onClick={addPasso} style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 6, padding: '9px 12px', border: '1px dashed var(--line)', borderRadius: 8, background: 'none', fontSize: 12.5, fontWeight: 600, color: 'var(--muted)', width: '100%', justifyContent: 'center' }}>
                    <Plus size={14} /> Adicionar passo
                  </button>
                </div>

                <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                  <button onClick={salvar} disabled={!dirty} style={{ padding: '10px 20px', border: 'none', borderRadius: 8, background: 'var(--terra)', color: '#fff', fontSize: 13, fontWeight: 600, opacity: dirty ? 1 : 0.5 }}>Salvar fluxo</button>
                  {dirty && <span style={{ fontSize: 12, color: 'var(--muted)' }}>alterações não salvas</span>}
                  <span style={{ flex: 1 }} />
                  {pill(rasc.ativo ? 'ativo' : 'inativo', rasc.ativo)}
                  {rasc.disparaEmLeadNovo && pill('Geral', true)}
                </div>
              </div>
            ) : (
              <div style={{ border: '1px dashed var(--line)', borderRadius: 12, padding: '60px 20px', textAlign: 'center', color: 'var(--muted)', fontSize: 13.5 }}>
                Selecione ou crie um fluxo pra montar a régua.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
