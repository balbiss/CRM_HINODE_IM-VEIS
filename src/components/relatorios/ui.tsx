import { useEffect, useMemo, useRef, useState } from 'react';

/** Peças visuais da tela Relatórios (mesma linguagem do CRM: tokens --card/--line/--terra, títulos
 *  em Newsreader). Uma cor por série; cor categórica só onde a categoria importa (rosca, temperatura). */

export const PALETA = ['#B5652F', '#5E6B3F', '#4F6D7A', '#C9A227', '#8C5A7A', '#7A8B99', '#A9744F', '#6E7F5A'];

export const card: React.CSSProperties = { border: '1px solid var(--line)', borderRadius: 14, background: 'var(--card)', minWidth: 0, overflow: 'hidden' };
export const th: React.CSSProperties = { textAlign: 'right', fontSize: 10.5, letterSpacing: '.07em', textTransform: 'uppercase', color: 'var(--muted)', fontWeight: 700, padding: '10px 10px', whiteSpace: 'nowrap', borderBottom: '1px solid var(--line)', background: 'var(--bg)' };
export const td: React.CSSProperties = { padding: '10px', fontSize: 13, borderBottom: '1px solid var(--line)', whiteSpace: 'nowrap', textAlign: 'right', fontVariantNumeric: 'tabular-nums' };
export const vazioTxt: React.CSSProperties = { fontSize: 13, color: 'var(--muted)', margin: 0, padding: '6px 0' };

/** Cabeçalho de seção: rótulo pequeno + título. */
export function Secao({ rotulo, titulo, desc, children }: { rotulo: string; titulo: string; desc?: string; children: React.ReactNode }) {
  return (
    <section style={{ display: 'grid', gap: 14, gridTemplateColumns: 'minmax(0, 1fr)' }}>
      <div style={{ borderBottom: '1px solid var(--line)', paddingBottom: 8, marginTop: 10 }}>
        <p style={{ margin: 0, fontSize: 10.5, letterSpacing: '.18em', textTransform: 'uppercase', color: 'var(--terra)', fontWeight: 700 }}>{rotulo}</p>
        <h2 style={{ margin: '2px 0 0', fontFamily: 'Newsreader,serif', fontWeight: 400, fontSize: 22 }}>{titulo}</h2>
        {desc && <p style={{ margin: '2px 0 0', fontSize: 12.5, color: 'var(--muted)' }}>{desc}</p>}
      </div>
      {children}
    </section>
  );
}

/** Cartão com cabeçalho (título, explicação e ação opcional à direita). */
export function Painel({ titulo, desc, extra, children, semPadding }: { titulo: string; desc?: string; extra?: React.ReactNode; children: React.ReactNode; semPadding?: boolean }) {
  return (
    <div style={card}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, padding: '14px 18px 12px', borderBottom: '1px solid var(--line)', flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0 }}>
          <h3 style={{ margin: 0, fontSize: 14.5, fontWeight: 700 }}>{titulo}</h3>
          {desc && <p style={{ margin: '3px 0 0', fontSize: 12, color: 'var(--muted)', maxWidth: 720 }}>{desc}</p>}
        </div>
        {extra}
      </div>
      <div style={semPadding ? undefined : { padding: 18 }}>{children}</div>
    </div>
  );
}

export function Kpi({ titulo, valor, nota, detalhe, destaque, alerta }: { titulo: string; valor: string; nota?: string; detalhe?: string; destaque?: boolean; alerta?: boolean }) {
  return (
    <div style={{ ...card, padding: '16px 18px', borderTop: destaque ? '3px solid var(--terra)' : card.border }}>
      <p style={{ margin: 0, fontSize: 10.5, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--muted)', fontWeight: 700 }}>{titulo}</p>
      <p style={{ margin: '8px 0 2px', fontFamily: 'Newsreader,serif', fontSize: destaque ? 32 : 26, lineHeight: 1.05, color: 'var(--ink)', fontVariantNumeric: 'tabular-nums' }}>{valor}</p>
      {nota && <p style={{ margin: 0, fontSize: 11.5, fontWeight: 600, color: alerta ? 'var(--terra)' : 'var(--olive)' }}>{nota}</p>}
      {detalhe && <p style={{ margin: '6px 0 0', fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.45 }}>{detalhe}</p>}
    </div>
  );
}

/** Barras horizontais com rótulo e número; clicáveis quando onClick existe. */
export function BarrasH({ dados, vazio, cor = 'var(--terra)', onClick, larguraRotulo }: {
  dados: { chave?: string; nome: string; valor: number; extra?: string; cor?: string }[];
  vazio: string; cor?: string; onClick?: (chave: string) => void; larguraRotulo?: number;
}) {
  const max = useMemo(() => Math.max(1, ...dados.map(d => d.valor)), [dados]);
  if (!dados.length || dados.every(d => !d.valor)) return <p style={vazioTxt}>{vazio}</p>;
  return (
    <div style={{ display: 'grid', gap: 7, gridTemplateColumns: 'minmax(0, 1fr)' }}>
      {dados.map(d => {
        const Tag = onClick ? 'button' : 'div';
        return (
          <Tag key={d.chave ?? d.nome} onClick={onClick ? () => onClick(d.chave ?? d.nome) : undefined} title={`${d.nome}: ${d.valor}`}
            className={onClick ? 'rel-barra' : undefined}
            style={{ display: 'grid', gridTemplateColumns: `${larguraRotulo ?? 150}px minmax(0, 1fr) auto`, alignItems: 'center', gap: 10, background: 'none', border: 'none', padding: '3px 4px', margin: '0 -4px', borderRadius: 6, cursor: onClick ? 'pointer' : 'default', textAlign: 'left', font: 'inherit', color: 'inherit', width: 'calc(100% + 8px)' }}>
            <span style={{ fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.nome}</span>
            <span style={{ height: 10, background: 'var(--bg)', borderRadius: 5, overflow: 'hidden' }}>
              <span style={{ display: 'block', height: '100%', width: (d.valor ? Math.max(2, (d.valor / max) * 100) : 0) + '%', background: d.cor ?? cor, borderRadius: 5 }} />
            </span>
            <span style={{ fontSize: 12.5, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums', minWidth: 28, textAlign: 'right' }}>
              <b>{d.valor}</b>{d.extra ? <span style={{ color: 'var(--muted)' }}> · {d.extra}</span> : null}
            </span>
          </Tag>
        );
      })}
    </div>
  );
}

/** Colunas verticais (uma série). Valor no hover; o maior ganha rótulo fixo. */
export function Barras({ dados, altura }: { dados: { rotulo: string; dica: string; valor: number }[]; altura: number }) {
  const [foco, setFoco] = useState<number | null>(null);
  const max = Math.max(1, ...dados.map(d => d.valor));
  const iMax = dados.findIndex(d => d.valor === max && max > 0);
  const muitos = dados.length > 16;
  return (
    <div>
      <div style={{ position: 'relative', height: altura, display: 'flex', alignItems: 'flex-end', gap: 2, borderBottom: '1px solid var(--line)' }}>
        {dados.map((d, i) => (
          <div key={i} onMouseEnter={() => setFoco(i)} onMouseLeave={() => setFoco(null)} title={d.dica}
            style={{ flex: 1, height: '100%', display: 'flex', alignItems: 'flex-end', position: 'relative' }}>
            <div style={{ width: '100%', height: d.valor ? Math.max(3, (d.valor / max) * (altura - 18)) : 0, background: 'var(--terra)', opacity: foco == null || foco === i ? 1 : 0.45, borderRadius: '4px 4px 0 0' }} />
            {(i === iMax || foco === i) && d.valor > 0 && (
              <span style={{ position: 'absolute', bottom: (d.valor / max) * (altura - 18) + 2, left: '50%', transform: 'translateX(-50%)', fontSize: 10.5, fontWeight: 700, whiteSpace: 'nowrap' }}>{d.valor}</span>
            )}
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 2, marginTop: 4 }}>
        {dados.map((d, i) => (
          <span key={i} style={{ flex: 1, fontSize: 10, color: 'var(--muted)', textAlign: 'center', overflow: 'hidden', whiteSpace: 'nowrap' }}>
            {!muitos || i % Math.ceil(dados.length / 10) === 0 ? d.rotulo : ''}
          </span>
        ))}
      </div>
      <p style={{ margin: '6px 0 0', fontSize: 11.5, color: 'var(--muted)', minHeight: 16 }}>{foco != null ? dados[foco].dica : ' '}</p>
    </div>
  );
}

/** Rosca com legenda clicável (top 7 + "Outras"). */
export function Rosca({ dados, centro, rotuloCentro, onClick }: {
  dados: { chave: string; nome: string; valor: number }[]; centro: string; rotuloCentro: string; onClick?: (chave: string) => void;
}) {
  const ord = [...dados].filter(d => d.valor > 0).sort((a, b) => b.valor - a.valor);
  const top = ord.slice(0, 7);
  const resto = ord.slice(7).reduce((s, d) => s + d.valor, 0);
  const fatias = resto ? [...top, { chave: '', nome: 'Outras', valor: resto }] : top;
  const total = fatias.reduce((s, d) => s + d.valor, 0);
  if (!total) return <p style={vazioTxt}>Sem leads no período.</p>;
  const R = 54, C = 2 * Math.PI * R;
  let acc = 0;
  return (
    <div style={{ display: 'flex', gap: 22, alignItems: 'center', flexWrap: 'wrap' }}>
      <svg width="150" height="150" viewBox="0 0 150 150" style={{ flex: 'none' }} role="img" aria-label={rotuloCentro}>
        <circle cx="75" cy="75" r={R} fill="none" stroke="var(--bg)" strokeWidth="20" />
        {fatias.map((f, i) => {
          const len = (f.valor / total) * C;
          const el = (
            <circle key={f.nome} cx="75" cy="75" r={R} fill="none" stroke={PALETA[i % PALETA.length]} strokeWidth="20"
              strokeDasharray={`${Math.max(0, len - 1.5)} ${C}`} strokeDashoffset={-acc} transform="rotate(-90 75 75)"
              style={{ cursor: onClick && f.chave ? 'pointer' : 'default' }} onClick={() => onClick && f.chave && onClick(f.chave)}>
              <title>{f.nome}: {f.valor}</title>
            </circle>
          );
          acc += len;
          return el;
        })}
        <text x="75" y="72" textAnchor="middle" style={{ fontFamily: 'Newsreader,serif', fontSize: 26, fill: 'var(--ink)' }}>{centro}</text>
        <text x="75" y="90" textAnchor="middle" style={{ fontSize: 9, letterSpacing: '.1em', fill: 'var(--muted)', textTransform: 'uppercase' }}>{rotuloCentro}</text>
      </svg>
      <div style={{ flex: 1, minWidth: 180, display: 'grid', gap: 4 }}>
        {fatias.map((f, i) => (
          <button key={f.nome} onClick={() => onClick && f.chave && onClick(f.chave)} className={onClick && f.chave ? 'rel-barra' : undefined}
            style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'none', border: 'none', padding: '4px 6px', borderRadius: 6, font: 'inherit', color: 'inherit', cursor: onClick && f.chave ? 'pointer' : 'default', textAlign: 'left' }}>
            <span style={{ width: 9, height: 9, borderRadius: 3, background: PALETA[i % PALETA.length], flex: 'none' }} />
            <span style={{ fontSize: 12.5, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.nome}</span>
            <b style={{ fontSize: 12.5, fontVariantNumeric: 'tabular-nums' }}>{f.valor}</b>
            <span style={{ fontSize: 11, color: 'var(--muted)', width: 34, textAlign: 'right' }}>{Math.round((f.valor / total) * 100)}%</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** Seletor de várias campanhas com busca e "Marcar todas" (igual à v1). Lista vazia = todas. */
export function FiltroCampanhas({ opcoes, selecionadas, onChange }: { opcoes: string[]; selecionadas: string[]; onChange: (v: string[]) => void }) {
  const [aberto, setAberto] = useState(false);
  const [busca, setBusca] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!aberto) return;
    const fora = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setAberto(false); };
    document.addEventListener('mousedown', fora);
    return () => document.removeEventListener('mousedown', fora);
  }, [aberto]);
  const q = busca.trim().toLowerCase();
  const visiveis = q ? opcoes.filter(o => o.toLowerCase().includes(q)) : opcoes;
  const todasVisiveis = visiveis.length > 0 && visiveis.every(o => selecionadas.includes(o));
  const rotulo = selecionadas.length === 0 ? 'Todas as campanhas' : selecionadas.length === 1 ? selecionadas[0] : selecionadas.length + ' campanhas';
  const alternar = (o: string) => onChange(selecionadas.includes(o) ? selecionadas.filter(x => x !== o) : [...selecionadas, o]);
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button onClick={() => setAberto(a => !a)} style={{ ...campoFiltro, display: 'flex', alignItems: 'center', gap: 8, maxWidth: 240, borderColor: selecionadas.length ? 'var(--terra)' : 'var(--line)' }}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{rotulo}</span>
        <span style={{ fontSize: 10, color: 'var(--muted)' }}>▾</span>
      </button>
      {aberto && (
        <div style={{ position: 'absolute', top: 'calc(100% + 6px)', right: 0, zIndex: 40, width: 'min(360px, 86vw)', background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 12, boxShadow: '0 12px 32px rgba(0,0,0,.14)', overflow: 'hidden' }}>
          <div style={{ padding: 10, borderBottom: '1px solid var(--line)' }}>
            <input autoFocus value={busca} onChange={e => setBusca(e.target.value)} placeholder="Buscar campanha (ex: cenarium)"
              style={{ width: '100%', padding: '8px 10px', border: '1px solid var(--line)', borderRadius: 8, background: 'var(--bg)', fontSize: 13, boxSizing: 'border-box' }} />
            <div style={{ display: 'flex', gap: 14, marginTop: 8, fontSize: 12, fontWeight: 700 }}>
              <button onClick={() => onChange(todasVisiveis ? selecionadas.filter(s => !visiveis.includes(s)) : [...new Set([...selecionadas, ...visiveis])])}
                style={{ background: 'none', border: 'none', padding: 0, color: 'var(--terra)', cursor: 'pointer', fontWeight: 700 }}>
                {todasVisiveis ? 'Desmarcar' : 'Marcar'} {q ? 'as encontradas' : 'todas'}
              </button>
              {selecionadas.length > 0 && <button onClick={() => onChange([])} style={{ background: 'none', border: 'none', padding: 0, color: 'var(--muted)', cursor: 'pointer', fontWeight: 700 }}>Limpar ({selecionadas.length})</button>}
            </div>
          </div>
          <div style={{ maxHeight: 300, overflowY: 'auto', padding: '4px 0' }}>
            {visiveis.length === 0 && <p style={{ ...vazioTxt, padding: '10px 14px' }}>Nenhuma campanha encontrada.</p>}
            {visiveis.map(o => (
              <label key={o} className="rel-barra" style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '7px 14px', fontSize: 13, cursor: 'pointer' }}>
                <input type="checkbox" checked={selecionadas.includes(o)} onChange={() => alternar(o)} style={{ accentColor: 'var(--terra)' }} />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={o}>{o}</span>
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export const campoFiltro: React.CSSProperties = { height: 36, padding: '0 11px', border: '1px solid var(--line)', borderRadius: 9, background: 'var(--card)', fontSize: 12.5, fontWeight: 600, color: 'var(--ink)', boxSizing: 'border-box', cursor: 'pointer' };

/** Janela com a lista de leads de uma barra/fatia; clicar abre o card. */
export function ModalLeads({ titulo, leads, carregando, onAbrir, onFechar }: {
  titulo: string; leads: { id: string; nome: string; telefone: string | null; corretor: string | null }[] | null;
  carregando: boolean; onAbrir: (id: string) => void; onFechar: () => void;
}) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onFechar(); };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [onFechar]);
  return (
    <div onClick={onFechar} style={{ position: 'fixed', inset: 0, background: 'rgba(20,18,16,.45)', zIndex: 60, display: 'grid', placeItems: 'center', padding: 16 }}>
      <div onClick={e => e.stopPropagation()} role="dialog" aria-label={titulo} style={{ ...card, width: 'min(520px, 100%)', maxHeight: '78vh', display: 'flex', flexDirection: 'column', boxShadow: '0 18px 48px rgba(0,0,0,.25)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 18px', borderBottom: '1px solid var(--line)' }}>
          <h3 style={{ margin: 0, fontSize: 14.5, fontWeight: 700 }}>{titulo}{leads ? ` · ${leads.length}${leads.length === 500 ? '+' : ''} lead${leads.length === 1 ? '' : 's'}` : ''}</h3>
          <button onClick={onFechar} aria-label="Fechar" style={{ background: 'none', border: 'none', fontSize: 20, lineHeight: 1, cursor: 'pointer', color: 'var(--muted)' }}>×</button>
        </div>
        <div style={{ overflowY: 'auto', padding: 8 }}>
          {carregando && <p style={{ ...vazioTxt, padding: 10 }}>Carregando…</p>}
          {!carregando && leads?.length === 0 && <p style={{ ...vazioTxt, padding: 10 }}>Nenhum lead.</p>}
          {leads?.map(l => (
            <button key={l.id} onClick={() => onAbrir(l.id)} className="rel-barra"
              style={{ width: '100%', display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center', padding: '9px 10px', background: 'none', border: 'none', borderRadius: 8, font: 'inherit', color: 'inherit', cursor: 'pointer', textAlign: 'left' }}>
              <span style={{ minWidth: 0 }}>
                <b style={{ fontSize: 13, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.nome}</b>
                <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>{l.corretor ?? 'Sem corretor'}</span>
              </span>
              <span style={{ fontSize: 12, color: 'var(--muted)', whiteSpace: 'nowrap' }}>{l.telefone ?? ''}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
