import { useEffect, useMemo, useRef, useState } from 'react';
import { apiFetch } from '../lib/api';
import { uploadArquivo } from '../lib/upload';
import { useAppStore } from '../store/appStore';
import { useRoleInfo } from '../lib/selectors';
import { ResumoFluxo, SimularFluxo, brl, type FluxoPagamento, type ResultadoFluxo } from '../components/SimularFluxo';

type Item = {
  id: string; categoria: string; titulo: string; conteudo: string;
  anexoUrl: string | null; anexoNome: string | null; anexoTexto: string | null; anexoStatus: 'lendo' | 'ok' | 'erro' | null; atualizadoEm: string;
};
type Pergunta = { id: string; pergunta: string; resposta: string; resolvida: boolean; criadoEm: string; perfilNome: string | null };
type Msg = { papel: 'corretor' | 'ia'; texto: string; fontes?: string[]; semInfo?: boolean; erro?: boolean };

const CATEGORIAS = ['Construtoras', 'Empreendimentos', 'Documentação', 'Financiamento / MCMV', 'Regras da casa', 'Dúvidas frequentes'];
const lbl: React.CSSProperties = { display: 'block', fontSize: 11, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--muted)', margin: '0 0 5px' };
const inp: React.CSSProperties = { width: '100%', padding: '9px 11px', border: '1px solid var(--line)', borderRadius: 8, background: 'var(--bg)', fontSize: 13.5, boxSizing: 'border-box', marginBottom: 12 };
const btn: React.CSSProperties = { padding: '8px 13px', border: '1px solid var(--line)', borderRadius: 8, background: 'none', fontSize: 12.5 };
const btnP: React.CSSProperties = { padding: '9px 16px', border: 'none', borderRadius: 8, background: 'var(--terra)', color: '#fff', fontSize: 13, fontWeight: 600 };
const card: React.CSSProperties = { border: '1px solid var(--line)', borderRadius: 12, background: 'var(--card)', padding: '14px 18px' };
const dataBr = (s: string) => new Date(s).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

function Modal({ titulo, onFechar, children, largura = 620 }: { titulo: string; onFechar: () => void; children: React.ReactNode; largura?: number }) {
  return (
    <div onClick={onFechar} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div onClick={e => e.stopPropagation()} style={{ background: 'var(--card)', borderRadius: 14, width: `min(${largura}px,100%)`, maxHeight: '92vh', overflow: 'auto', padding: 22 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <h3 style={{ margin: 0, fontFamily: 'Newsreader,serif', fontWeight: 400, fontSize: 21 }}>{titulo}</h3>
          <button onClick={onFechar} style={{ border: '1px solid var(--line)', background: 'none', width: 30, height: 30, borderRadius: 8 }}>×</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export default function Conhecimento() {
  const { isManager } = useRoleInfo();
  const token = useAppStore(s => s.token);
  const [aba, setAba] = useState<'ia' | 'base' | 'fluxos' | 'sem'>('ia');
  const [semCount, setSemCount] = useState(0);
  useEffect(() => {
    if (!isManager) return;
    apiFetch<Pergunta[]>('/api/conhecimento/perguntas', token).then(p => setSemCount(p.filter(x => !x.resolvida).length)).catch(() => {});
  }, [isManager, token, aba]);

  const abas: [typeof aba, string][] = [['ia', 'Pergunte à IA'], ['base', 'Base'], ['fluxos', 'Fluxos de pagamento'], ...(isManager ? [['sem', `Sem resposta${semCount ? ` (${semCount})` : ''}`] as [typeof aba, string]] : [])];
  return (
    <div>
      <div className="page-head" style={{ marginBottom: 14 }}>
        <p style={{ fontSize: 11, letterSpacing: '.18em', textTransform: 'uppercase', color: 'var(--muted)', margin: '0 0 4px' }}>Equipe</p>
        <h1 style={{ fontFamily: 'Newsreader,serif', fontWeight: 400, fontSize: 24, margin: 0, lineHeight: 1.2 }}>Base de Conhecimento</h1>
        <p style={{ fontSize: 13, color: 'var(--muted)', margin: '4px 0 0' }}>Regras, construtoras, documentos e fluxos de pagamento. A IA responde aos corretores só com o que está cadastrado aqui.</p>
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 16 }}>
        {abas.map(([k, t]) => (
          <button key={k} onClick={() => setAba(k)} style={{ padding: '8px 14px', borderRadius: 20, border: '1px solid ' + (aba === k ? 'var(--terra)' : 'var(--line)'), background: aba === k ? 'var(--terra)' : 'none', color: aba === k ? '#fff' : undefined, fontSize: 13, fontWeight: 600 }}>{t}</button>
        ))}
      </div>
      {aba === 'ia' && <PergunteIa />}
      {aba === 'base' && <Base />}
      {aba === 'fluxos' && <Fluxos />}
      {aba === 'sem' && isManager && <SemResposta irParaBase={() => setAba('base')} />}
    </div>
  );
}

// ---------------- Pergunte à IA ----------------
function PergunteIa() {
  const token = useAppStore(s => s.token);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [texto, setTexto] = useState('');
  const [pensando, setPensando] = useState(false);
  const fim = useRef<HTMLDivElement>(null);
  useEffect(() => { fim.current?.scrollIntoView({ behavior: 'smooth' }); }, [msgs, pensando]);

  const enviar = async (pergunta = texto.trim()) => {
    if (!pergunta || pensando) return;
    const historico = msgs.filter(m => !m.erro).slice(-10).map(m => ({ papel: m.papel, texto: m.texto }));
    setMsgs(m => [...m, { papel: 'corretor', texto: pergunta }]); setTexto(''); setPensando(true);
    try {
      const r = await apiFetch<{ resposta: string; semResposta: boolean; fontes: string[] }>('/api/conhecimento/perguntar', token, { method: 'POST', body: JSON.stringify({ pergunta, historico }) });
      setMsgs(m => [...m, { papel: 'ia', texto: r.resposta, fontes: r.fontes, semInfo: r.semResposta }]);
    } catch (e) {
      setMsgs(m => [...m, { papel: 'ia', texto: (e as Error).message || 'Não consegui responder agora. Tente de novo em instantes.', erro: true }]);
    } finally { setPensando(false); }
  };

  const sugestoes = ['Qual a parcela do fluxo deste mês?', 'Quais documentos o cliente autônomo precisa?', 'Quais construtoras a gente trabalha?'];
  return (
    <div style={{ ...card, padding: 0, display: 'flex', flexDirection: 'column', height: 'min(70vh,640px)' }}>
      <div style={{ flex: 1, overflow: 'auto', padding: 18, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {msgs.length === 0 && (
          <div style={{ color: 'var(--muted)', fontSize: 13.5, textAlign: 'center', margin: 'auto 0' }}>
            <p style={{ margin: '0 0 10px' }}>Pergunte qualquer coisa sobre construtoras, empreendimentos, documentos ou fluxo de pagamento.</p>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'center' }}>
              {sugestoes.map(s => <button key={s} onClick={() => enviar(s)} style={{ ...btn, borderRadius: 20 }}>{s}</button>)}
            </div>
          </div>
        )}
        {msgs.map((m, i) => (
          <div key={i} style={{ alignSelf: m.papel === 'corretor' ? 'flex-end' : 'flex-start', maxWidth: '85%' }}>
            <div style={{ padding: '10px 14px', borderRadius: 12, whiteSpace: 'pre-wrap', fontSize: 13.5, lineHeight: 1.5,
              background: m.papel === 'corretor' ? 'var(--terra)' : m.erro ? '#FDECEA' : m.semInfo ? '#FFF6E5' : 'var(--bg)',
              color: m.papel === 'corretor' ? '#fff' : undefined, border: m.papel === 'ia' ? '1px solid var(--line)' : 'none' }}>{m.texto}</div>
            {m.semInfo && <p style={{ fontSize: 11.5, color: '#B7791F', margin: '4px 2px 0' }}>Essa pergunta foi para a lista do gestor completar a base.</p>}
            {!!m.fontes?.length && <p style={{ fontSize: 11.5, color: 'var(--muted)', margin: '4px 2px 0' }}>Fonte: {m.fontes.join(' · ')}</p>}
          </div>
        ))}
        {pensando && <div style={{ alignSelf: 'flex-start', color: 'var(--muted)', fontSize: 13 }}>Consultando a base…</div>}
        <div ref={fim} />
      </div>
      <div style={{ display: 'flex', gap: 8, padding: 12, borderTop: '1px solid var(--line)' }}>
        <textarea value={texto} onChange={e => setTexto(e.target.value)} rows={1} placeholder="Escreva sua pergunta…"
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); enviar(); } }}
          style={{ ...inp, marginBottom: 0, resize: 'none', fontFamily: 'inherit' }} />
        <button onClick={() => enviar()} disabled={pensando || !texto.trim()} style={{ ...btnP, opacity: pensando || !texto.trim() ? 0.5 : 1 }}>Perguntar</button>
      </div>
    </div>
  );
}

// ---------------- Base ----------------
function Base({ novoTitulo }: { novoTitulo?: string }) {
  const token = useAppStore(s => s.token);
  const { isManager } = useRoleInfo();
  const [itens, setItens] = useState<Item[] | null>(null);
  const [busca, setBusca] = useState('');
  const [editando, setEditando] = useState<Partial<Item> | null>(novoTitulo ? { titulo: novoTitulo } : null);
  const carregar = () => apiFetch<Item[]>('/api/conhecimento/itens', token).then(setItens).catch(() => setItens([]));
  useEffect(() => { carregar(); }, [token]); // eslint-disable-line react-hooks/exhaustive-deps
  // enquanto a IA lê algum anexo, atualiza sozinho
  useEffect(() => {
    if (!itens?.some(i => i.anexoStatus === 'lendo')) return;
    const t = setInterval(carregar, 5000); return () => clearInterval(t);
  }, [itens]); // eslint-disable-line react-hooks/exhaustive-deps

  const grupos = useMemo(() => {
    const q = busca.trim().toLowerCase();
    const map = new Map<string, Item[]>();
    for (const i of itens || []) {
      if (q && !(i.titulo + ' ' + i.conteudo + ' ' + i.categoria + ' ' + (i.anexoTexto || '')).toLowerCase().includes(q)) continue;
      if (!map.has(i.categoria)) map.set(i.categoria, []);
      map.get(i.categoria)!.push(i);
    }
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0], 'pt-BR'));
  }, [itens, busca]);

  const excluir = async (i: Item) => {
    if (!confirm(`Excluir "${i.titulo}" da base?`)) return;
    await apiFetch('/api/conhecimento/itens/' + i.id, token, { method: 'DELETE' }); carregar();
  };
  const reler = async (i: Item) => { await apiFetch(`/api/conhecimento/itens/${i.id}/reler`, token, { method: 'POST' }); carregar(); };

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
        <input value={busca} onChange={e => setBusca(e.target.value)} placeholder="Buscar na base…" style={{ ...inp, marginBottom: 0, flex: 1, minWidth: 200 }} />
        {isManager && <button onClick={() => setEditando({})} style={btnP}>+ Nova informação</button>}
      </div>
      {itens === null ? <p style={{ color: 'var(--muted)' }}>Carregando…</p> : grupos.length === 0 ? (
        <div style={{ ...card, color: 'var(--muted)', fontSize: 13.5 }}>{busca ? 'Nada encontrado.' : isManager ? 'Nada cadastrado ainda. Clique em "+ Nova informação" — pode digitar ou anexar PDF/foto (a IA lê o anexo).' : 'O gestor ainda não cadastrou informações.'}</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          {grupos.map(([cat, lista]) => (
            <div key={cat}>
              <p style={{ fontSize: 11, letterSpacing: '.12em', textTransform: 'uppercase', color: 'var(--muted)', margin: '0 0 8px' }}>{cat}</p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {lista.map(i => (
                  <details key={i.id} style={card}>
                    <summary style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10, listStyle: 'none' }}>
                      <span style={{ width: 8, height: 8, background: 'var(--terra)', transform: 'rotate(45deg)', flex: 'none' }} />
                      <span style={{ flex: 1, fontWeight: 600, fontSize: 14 }}>{i.titulo}</span>
                      {i.anexoUrl && <span style={{ fontSize: 11.5, color: i.anexoStatus === 'erro' ? '#C0392B' : 'var(--muted)' }}>{i.anexoStatus === 'lendo' ? '📎 IA lendo o anexo…' : i.anexoStatus === 'erro' ? '📎 não consegui ler' : '📎 anexo'}</span>}
                    </summary>
                    <div style={{ marginTop: 10, fontSize: 13.5, whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>{i.conteudo || <span style={{ color: 'var(--muted)' }}>(sem texto — só anexo)</span>}</div>
                    {i.anexoUrl && (
                      <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                        <a href={i.anexoUrl} target="_blank" rel="noreferrer" style={{ ...btn, color: 'var(--ink)' }}>Abrir anexo{i.anexoNome ? ` (${i.anexoNome})` : ''}</a>
                        {isManager && i.anexoStatus === 'erro' && <button onClick={() => reler(i)} style={btn}>Tentar ler de novo</button>}
                        {i.anexoTexto && <details style={{ width: '100%' }}><summary style={{ cursor: 'pointer', fontSize: 12, color: 'var(--muted)' }}>O que a IA leu do anexo</summary><div style={{ whiteSpace: 'pre-wrap', fontSize: 12.5, maxHeight: 260, overflow: 'auto', marginTop: 6, padding: 10, background: 'var(--bg)', borderRadius: 8 }}>{i.anexoTexto}</div></details>}
                      </div>
                    )}
                    {isManager && (
                      <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
                        <button onClick={() => setEditando(i)} style={btn}>Editar</button>
                        <button onClick={() => excluir(i)} style={{ ...btn, color: 'var(--terra)' }}>Excluir</button>
                      </div>
                    )}
                  </details>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
      {editando && <EditorItem item={editando} categoriasExistentes={(itens || []).map(i => i.categoria)} onFechar={() => setEditando(null)} onSalvo={() => { setEditando(null); carregar(); }} />}
    </div>
  );
}

export function EditorItem({ item, categoriasExistentes, onFechar, onSalvo }: { item: Partial<Item>; categoriasExistentes: string[]; onFechar: () => void; onSalvo: () => void }) {
  const token = useAppStore(s => s.token);
  const [f, setF] = useState({ categoria: item.categoria || '', titulo: item.titulo || '', conteudo: item.conteudo || '', anexoUrl: item.anexoUrl || null, anexoNome: item.anexoNome || null });
  const [subindo, setSubindo] = useState(false);
  const [erro, setErro] = useState('');
  const cats = Array.from(new Set([...CATEGORIAS, ...categoriasExistentes])).sort((a, b) => a.localeCompare(b, 'pt-BR'));
  const anexar = async (file?: File) => {
    if (!file || !token) return;
    if (!/^image\/|^application\/pdf$/.test(file.type)) return setErro('Anexo só PDF ou foto.');
    setSubindo(true); setErro('');
    try { const r = await uploadArquivo(file, token); setF(x => ({ ...x, anexoUrl: r.url, anexoNome: r.nome })); }
    catch (e) { setErro((e as Error).message); } finally { setSubindo(false); }
  };
  const salvar = async () => {
    if (!f.categoria.trim() || !f.titulo.trim()) return setErro('Preencha categoria e título.');
    if (!f.conteudo.trim() && !f.anexoUrl) return setErro('Escreva o conteúdo ou anexe um arquivo.');
    try {
      await apiFetch('/api/conhecimento/itens' + (item.id ? '/' + item.id : ''), token, { method: item.id ? 'PATCH' : 'POST', body: JSON.stringify(f) });
      onSalvo();
    } catch (e) { setErro((e as Error).message); }
  };
  return (
    <Modal titulo={item.id ? 'Editar informação' : 'Nova informação'} onFechar={onFechar}>
      <label style={lbl}>Categoria</label>
      <input list="cats-conhecimento" value={f.categoria} onChange={e => setF({ ...f, categoria: e.target.value })} placeholder="Ex.: Construtoras" style={inp} />
      <datalist id="cats-conhecimento">{cats.map(c => <option key={c} value={c} />)}</datalist>
      <label style={lbl}>Título</label>
      <input value={f.titulo} onChange={e => setF({ ...f, titulo: e.target.value })} placeholder="Ex.: Documentos para autônomo" style={inp} />
      <label style={lbl}>Conteúdo</label>
      <textarea value={f.conteudo} onChange={e => setF({ ...f, conteudo: e.target.value })} rows={9} placeholder="Escreva as regras, condições, passo a passo…" style={{ ...inp, fontFamily: 'inherit', resize: 'vertical' }} />
      <label style={lbl}>Anexo (PDF ou foto — a IA lê o conteúdo)</label>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 14, flexWrap: 'wrap' }}>
        <input type="file" accept="application/pdf,image/*" onChange={e => anexar(e.target.files?.[0])} disabled={subindo} />
        {subindo && <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>Enviando…</span>}
        {f.anexoUrl && !subindo && <span style={{ fontSize: 12.5 }}>📎 {f.anexoNome || 'anexo'} <button onClick={() => setF({ ...f, anexoUrl: null, anexoNome: null })} style={{ ...btn, padding: '3px 8px' }}>remover</button></span>}
      </div>
      {erro && <p style={{ color: '#C0392B', fontSize: 13, margin: '0 0 10px' }}>{erro}</p>}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <button onClick={onFechar} style={btn}>Cancelar</button>
        <button onClick={salvar} disabled={subindo} style={btnP}>Salvar</button>
      </div>
    </Modal>
  );
}

// ---------------- Fluxos de pagamento ----------------
function Fluxos() {
  const token = useAppStore(s => s.token);
  const { isManager } = useRoleInfo();
  const [fluxos, setFluxos] = useState<FluxoPagamento[] | null>(null);
  const [editando, setEditando] = useState<Partial<FluxoPagamento> | null>(null);
  const [simulando, setSimulando] = useState<string | null>(null);
  const carregar = () => apiFetch<FluxoPagamento[]>('/api/conhecimento/fluxos', token).then(setFluxos).catch(() => setFluxos([]));
  useEffect(() => { carregar(); }, [token]); // eslint-disable-line react-hooks/exhaustive-deps
  const excluir = async (f: FluxoPagamento) => {
    if (!confirm(`Excluir o fluxo de "${f.empreendimento}"?`)) return;
    await apiFetch('/api/conhecimento/fluxos/' + f.id, token, { method: 'DELETE' }); carregar();
  };
  const lista = (fluxos || []).filter(f => isManager || f.ativo);
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
        <p style={{ margin: 0, fontSize: 13, color: 'var(--muted)', maxWidth: 620 }}>A regra é cadastrada uma vez. Todo mês o sistema recalcula sozinho: os meses até as chaves diminuem e a parcela se ajusta.</p>
        {isManager && <button onClick={() => setEditando({ config: { inicioParcelas: 'proximo_mes' } })} style={btnP}>+ Novo fluxo</button>}
      </div>
      {fluxos === null ? <p style={{ color: 'var(--muted)' }}>Carregando…</p> : lista.length === 0 ? (
        <div style={{ ...card, color: 'var(--muted)', fontSize: 13.5 }}>{isManager ? 'Nenhum fluxo cadastrado. Clique em "+ Novo fluxo".' : 'O gestor ainda não cadastrou fluxos de pagamento.'}</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {lista.map(f => (
            <div key={f.id} style={{ ...card, opacity: f.ativo ? 1 : 0.6 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
                <span style={{ fontWeight: 700, fontSize: 15 }}>{f.empreendimento}</span>
                {f.construtora && <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>{f.construtora}</span>}
                {!f.ativo && <span style={{ fontSize: 11, color: 'var(--muted)' }}>(desativado — corretor não vê)</span>}
                <span style={{ flex: 1 }} />
                <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>Imóvel {brl(f.calculo.valorImovel)}</span>
              </div>
              <ResumoFluxo r={f.calculo} cronograma />
              {f.observacoes && <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: '8px 0 0', whiteSpace: 'pre-wrap' }}>{f.observacoes}</p>}
              <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
                <button onClick={() => setSimulando(f.id)} style={btn}>Simular pra um cliente</button>
                {isManager && <button onClick={() => setEditando(f)} style={btn}>Editar regra</button>}
                {isManager && <button onClick={() => excluir(f)} style={{ ...btn, color: 'var(--terra)' }}>Excluir</button>}
              </div>
            </div>
          ))}
        </div>
      )}
      {editando && <EditorFluxo fluxo={editando} onFechar={() => setEditando(null)} onSalvo={() => { setEditando(null); carregar(); }} />}
      {simulando && <SimularFluxo fluxoInicial={simulando} onFechar={() => setSimulando(null)} />}
    </div>
  );
}

type Cfg = {
  valorImovel?: number | string; financiamento?: number | string; subsidio?: number | string; fgts?: number | string; ato?: number | string;
  dataChaves?: string; inicioParcelas?: 'proximo_mes' | 'mes_atual'; diaVencimento?: number | string; limiteMeses?: number | string; parcelaMinima?: number | string;
  baloes?: { descricao: string; valor: number | string; mes: string }[];
  baloesPeriodicos?: { descricao: string; valor: number | string; aCadaMeses: number | string; mesInicio: string }[];
  posChavesParcelas?: number | string; posChavesValor?: number | string; correcao?: string;
};
/** Tira campos vazios e converte números antes de mandar pro servidor. */
function limparCfg(c: Cfg) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(c)) {
    if (v === '' || v == null) continue;
    if (k === 'baloes') out[k] = (v as Cfg['baloes'])!.filter(b => b.mes && b.valor !== '').map(b => ({ ...b, valor: Number(b.valor) }));
    else if (k === 'baloesPeriodicos') out[k] = (v as Cfg['baloesPeriodicos'])!.filter(b => b.mesInicio && b.valor !== '').map(b => ({ ...b, valor: Number(b.valor), aCadaMeses: Number(b.aCadaMeses) || 12 }));
    else if (['inicioParcelas', 'dataChaves', 'correcao'].includes(k)) out[k] = v;
    else out[k] = Number(v);
  }
  return out;
}

function EditorFluxo({ fluxo, onFechar, onSalvo }: { fluxo: Partial<FluxoPagamento>; onFechar: () => void; onSalvo: () => void }) {
  const token = useAppStore(s => s.token);
  const [emp, setEmp] = useState(fluxo.empreendimento || '');
  const [constr, setConstr] = useState(fluxo.construtora || '');
  const [obs, setObs] = useState(fluxo.observacoes || '');
  const [ativo, setAtivo] = useState(fluxo.ativo ?? true);
  const [c, setC] = useState<Cfg>((fluxo.config as Cfg) || {});
  const [prev, setPrev] = useState<ResultadoFluxo | null>(null);
  const [erro, setErro] = useState('');
  const set = (k: keyof Cfg, v: unknown) => setC(x => ({ ...x, [k]: v }));

  useEffect(() => {
    const t = setTimeout(() => {
      apiFetch<ResultadoFluxo>('/api/conhecimento/fluxos/calcular', token, { method: 'POST', body: JSON.stringify({ config: limparCfg(c) }) }).then(setPrev).catch(() => {});
    }, 350);
    return () => clearTimeout(t);
  }, [c, token]);

  const salvar = async () => {
    if (!emp.trim()) return setErro('Informe o empreendimento.');
    try {
      await apiFetch('/api/conhecimento/fluxos' + (fluxo.id ? '/' + fluxo.id : ''), token, { method: fluxo.id ? 'PATCH' : 'POST', body: JSON.stringify({ empreendimento: emp, construtora: constr, observacoes: obs, ativo, config: limparCfg(c) }) });
      onSalvo();
    } catch (e) { setErro((e as Error).message); }
  };
  const numero = (k: keyof Cfg, t: string, dica?: string) => (
    <div><label style={lbl}>{t}</label>
      <input type="number" min={0} step="0.01" value={(c[k] as string | number | undefined) ?? ''} onChange={e => set(k, e.target.value)} placeholder={dica} style={inp} /></div>
  );
  const grade: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(170px,1fr))', gap: '0 10px' };
  const baloes = c.baloes || [], periodicos = c.baloesPeriodicos || [];
  return (
    <Modal titulo={fluxo.id ? 'Editar fluxo de pagamento' : 'Novo fluxo de pagamento'} onFechar={onFechar} largura={760}>
      <div style={grade}>
        <div><label style={lbl}>Empreendimento</label><input value={emp} onChange={e => setEmp(e.target.value)} style={inp} /></div>
        <div><label style={lbl}>Construtora</label><input value={constr} onChange={e => setConstr(e.target.value)} style={inp} /></div>
      </div>
      <p style={{ ...lbl, marginTop: 4 }}>Valores padrão (o corretor ajusta por cliente na simulação)</p>
      <div style={grade}>
        {numero('valorImovel', 'Valor do imóvel')}
        {numero('financiamento', 'Financiamento')}
        {numero('subsidio', 'Subsídio')}
        {numero('fgts', 'FGTS')}
        {numero('ato', 'Ato / sinal')}
      </div>
      <p style={{ ...lbl, marginTop: 4 }}>Regra das parcelas</p>
      <div style={grade}>
        <div><label style={lbl}>Mês das chaves</label><input type="month" value={c.dataChaves || ''} onChange={e => set('dataChaves', e.target.value)} style={inp} /></div>
        <div><label style={lbl}>1ª parcela</label>
          <select value={c.inicioParcelas || 'proximo_mes'} onChange={e => set('inicioParcelas', e.target.value)} style={inp}>
            <option value="proximo_mes">No mês seguinte</option><option value="mes_atual">No mesmo mês</option>
          </select></div>
        {numero('limiteMeses', 'Máx. de parcelas', '0 = sem limite')}
        {numero('parcelaMinima', 'Parcela mínima', 'opcional')}
        {numero('posChavesParcelas', 'Parcelas pós-chaves', 'quantidade')}
        {numero('posChavesValor', 'Valor pós-chaves', 'cada parcela')}
      </div>
      <label style={lbl}>Correção (texto)</label>
      <input value={c.correcao || ''} onChange={e => set('correcao', e.target.value)} placeholder="Ex.: INCC até as chaves" style={inp} />

      <p style={{ ...lbl, marginTop: 4 }}>Balões em mês fixo</p>
      {baloes.map((b, i) => (
        <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 6, flexWrap: 'wrap' }}>
          <input value={b.descricao} placeholder="Descrição" onChange={e => set('baloes', baloes.map((x, j) => j === i ? { ...x, descricao: e.target.value } : x))} style={{ ...inp, marginBottom: 0, flex: 2, minWidth: 140 }} />
          <input type="month" value={b.mes} onChange={e => set('baloes', baloes.map((x, j) => j === i ? { ...x, mes: e.target.value } : x))} style={{ ...inp, marginBottom: 0, flex: 1, minWidth: 130 }} />
          <input type="number" min={0} value={b.valor} placeholder="Valor" onChange={e => set('baloes', baloes.map((x, j) => j === i ? { ...x, valor: e.target.value } : x))} style={{ ...inp, marginBottom: 0, flex: 1, minWidth: 110 }} />
          <button onClick={() => set('baloes', baloes.filter((_, j) => j !== i))} style={btn}>×</button>
        </div>
      ))}
      <button onClick={() => set('baloes', [...baloes, { descricao: 'Balão', mes: '', valor: '' }])} style={{ ...btn, marginBottom: 12 }}>+ Balão</button>

      <p style={{ ...lbl, marginTop: 4 }}>Balões que se repetem (ex.: anual, semestral)</p>
      {periodicos.map((b, i) => (
        <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          <input value={b.descricao} placeholder="Descrição" onChange={e => set('baloesPeriodicos', periodicos.map((x, j) => j === i ? { ...x, descricao: e.target.value } : x))} style={{ ...inp, marginBottom: 0, flex: 2, minWidth: 130 }} />
          <input type="number" min={0} value={b.valor} placeholder="Valor" onChange={e => set('baloesPeriodicos', periodicos.map((x, j) => j === i ? { ...x, valor: e.target.value } : x))} style={{ ...inp, marginBottom: 0, flex: 1, minWidth: 100 }} />
          <span style={{ fontSize: 12 }}>a cada</span>
          <input type="number" min={1} value={b.aCadaMeses} onChange={e => set('baloesPeriodicos', periodicos.map((x, j) => j === i ? { ...x, aCadaMeses: e.target.value } : x))} style={{ ...inp, marginBottom: 0, width: 70 }} />
          <span style={{ fontSize: 12 }}>meses, começando em</span>
          <input type="month" value={b.mesInicio} onChange={e => set('baloesPeriodicos', periodicos.map((x, j) => j === i ? { ...x, mesInicio: e.target.value } : x))} style={{ ...inp, marginBottom: 0, width: 150 }} />
          <button onClick={() => set('baloesPeriodicos', periodicos.filter((_, j) => j !== i))} style={btn}>×</button>
        </div>
      ))}
      <button onClick={() => set('baloesPeriodicos', [...periodicos, { descricao: 'Balão anual', valor: '', aCadaMeses: 12, mesInicio: '' }])} style={{ ...btn, marginBottom: 12 }}>+ Balão que se repete</button>

      <label style={lbl}>Observações (aparecem na simulação e a IA usa)</label>
      <textarea value={obs} onChange={e => setObs(e.target.value)} rows={3} style={{ ...inp, fontFamily: 'inherit', resize: 'vertical' }} />
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, marginBottom: 14 }}>
        <input type="checkbox" checked={ativo} onChange={e => setAtivo(e.target.checked)} /> Ativo (corretores veem e a IA usa)
      </label>

      <div style={{ ...card, background: 'var(--bg)', marginBottom: 14 }}>
        <p style={{ ...lbl }}>Como fica este mês</p>
        {prev ? <ResumoFluxo r={prev} cronograma /> : <span style={{ color: 'var(--muted)', fontSize: 13 }}>Preencha os valores…</span>}
      </div>
      {erro && <p style={{ color: '#C0392B', fontSize: 13 }}>{erro}</p>}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <button onClick={onFechar} style={btn}>Cancelar</button>
        <button onClick={salvar} style={btnP}>Salvar</button>
      </div>
    </Modal>
  );
}

// ---------------- Perguntas sem resposta ----------------
function SemResposta({ irParaBase }: { irParaBase: () => void }) {
  const token = useAppStore(s => s.token);
  const [lista, setLista] = useState<Pergunta[] | null>(null);
  const [verResolvidas, setVerResolvidas] = useState(false);
  const [cadastrar, setCadastrar] = useState<Pergunta | null>(null);
  const carregar = () => apiFetch<Pergunta[]>('/api/conhecimento/perguntas', token).then(setLista).catch(() => setLista([]));
  useEffect(() => { carregar(); }, [token]); // eslint-disable-line react-hooks/exhaustive-deps
  const marcar = async (p: Pergunta, resolvida = true) => {
    await apiFetch('/api/conhecimento/perguntas/' + p.id, token, { method: 'PATCH', body: JSON.stringify({ resolvida }) }); carregar();
  };
  const vis = (lista || []).filter(p => verResolvidas || !p.resolvida);
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
        <p style={{ margin: 0, fontSize: 13, color: 'var(--muted)' }}>Perguntas que a IA não soube responder. Cadastre a resposta na base e marque como resolvida.</p>
        <label style={{ fontSize: 12.5, display: 'flex', gap: 6, alignItems: 'center' }}><input type="checkbox" checked={verResolvidas} onChange={e => setVerResolvidas(e.target.checked)} /> mostrar resolvidas</label>
      </div>
      {lista === null ? <p style={{ color: 'var(--muted)' }}>Carregando…</p> : vis.length === 0 ? (
        <div style={{ ...card, color: 'var(--muted)', fontSize: 13.5 }}>Nenhuma pergunta pendente 🎉</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {vis.map(p => (
            <div key={p.id} style={{ ...card, opacity: p.resolvida ? 0.6 : 1 }}>
              <div style={{ fontWeight: 600, fontSize: 14 }}>{p.pergunta}</div>
              <div style={{ fontSize: 12, color: 'var(--muted)', margin: '3px 0 10px' }}>{p.perfilNome || 'Corretor'} · {dataBr(p.criadoEm)}</div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {!p.resolvida && <button onClick={() => setCadastrar(p)} style={btnP}>Cadastrar resposta</button>}
                <button onClick={() => marcar(p, !p.resolvida)} style={btn}>{p.resolvida ? 'Reabrir' : 'Marcar resolvida'}</button>
              </div>
            </div>
          ))}
        </div>
      )}
      {cadastrar && <EditorItem item={{ titulo: cadastrar.pergunta, categoria: 'Dúvidas frequentes' }} categoriasExistentes={[]} onFechar={() => setCadastrar(null)}
        onSalvo={async () => { await marcar(cadastrar); setCadastrar(null); irParaBase(); }} />}
    </div>
  );
}
