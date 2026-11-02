import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ini } from '../lib/format';
import { useAppStore } from '../store/appStore';
import { nomeEtapa } from './relatorios/ui';

/** "Leads que entraram" (Dashboard do dono/gerente) — igual ao cartão "Leads Novos (Hoje + Ontem)" da v1,
 *  só que mostrando QUEM entrou: hora, origem, cidade, etapa e com quem está (ou SEM CORRETOR).
 *  Usa os leads que já estão no navegador; dia contado no fuso de Brasília. */
type Periodo = 'hoje' | 'ontem' | 'ambos';
const diaSp = (d: Date) => d.toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
const horaSp = (iso: string) => new Date(iso).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
const CANAL: Record<string, string> = { Indicacao: 'Indicação' };

export function LeadsEntraram() {
  const leads = useAppStore(s => s.leads);
  const colunas = useAppStore(s => s.colunasRemotas);
  const openLead = useAppStore(s => s.openLead);
  const setBolsaoTab = useAppStore(s => s.setBolsaoTab);
  const nav = useNavigate();
  const [periodo, setPeriodo] = useState<Periodo>('ambos');
  const [soSemCorretor, setSoSemCorretor] = useState(false);

  const hoje = diaSp(new Date());
  const ontem = diaSp(new Date(Date.now() - 86400000));

  const entraram = useMemo(() => leads
    .filter(l => l.criadoEm && [hoje, ontem].includes(diaSp(new Date(l.criadoEm))))
    .map(l => ({ ...l, dia: diaSp(new Date(l.criadoEm!)) === hoje ? 'hoje' : 'ontem' as 'hoje' | 'ontem' }))
    .sort((a, b) => +new Date(b.criadoEm!) - +new Date(a.criadoEm!)), [leads, hoje, ontem]);

  const doPeriodo = entraram.filter(l => periodo === 'ambos' || l.dia === periodo);
  const semCorretor = doPeriodo.filter(l => !l.corretorId && !l.descartadoEm);
  const devolvidos = doPeriodo.filter(l => !!l.descartadoEm);
  const comCorretor = doPeriodo.filter(l => !!l.corretorId && !l.descartadoEm);
  const lista = soSemCorretor ? semCorretor : doPeriodo;
  const nHoje = entraram.filter(l => l.dia === 'hoje').length;
  const nOntem = entraram.length - nHoje;
  const etapa = (colunaId: string) => { const c = colunas.find(x => x.id === colunaId); return c ? nomeEtapa(c.titulo) : '—'; };

  return (
    <div style={{ border: '1px solid var(--line)', borderRadius: 12, background: 'var(--card)', marginBottom: 14, overflow: 'hidden' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap', padding: '18px 22px 14px', borderBottom: '1px solid var(--line)' }}>
        <div>
          <h2 style={{ fontFamily: 'Newsreader,serif', fontWeight: 400, fontSize: 22, margin: 0, lineHeight: 1.2 }}>Leads que entraram</h2>
          <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: '3px 0 0' }}>Quem chegou hoje e ontem, a hora, de onde veio e com quem está.</p>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        {semCorretor.length > 0 && (
          <button onClick={() => { setBolsaoTab('novos'); nav('/rebatidas'); }} style={{ border: 'none', background: 'none', padding: 0, fontSize: 12.5, fontWeight: 700, color: 'var(--terra)', cursor: 'pointer' }}>
            Distribuir agora →
          </button>
        )}
        <div style={{ display: 'flex', gap: 4, background: 'var(--bg)', border: '1px solid var(--line)', borderRadius: 9, padding: 3 }}>
          {([['hoje', 'Hoje', nHoje], ['ontem', 'Ontem', nOntem], ['ambos', 'Hoje + ontem', entraram.length]] as const).map(([v, rot, n]) => (
            <button key={v} onClick={() => setPeriodo(v)}
              style={{ padding: '6px 12px', border: 'none', borderRadius: 7, fontSize: 12.5, fontWeight: 600, cursor: 'pointer',
                background: periodo === v ? 'var(--card)' : 'transparent', color: periodo === v ? 'var(--ink)' : 'var(--muted)', boxShadow: periodo === v ? '0 1px 3px rgba(0,0,0,.08)' : 'none' }}>
              {rot} <span style={{ color: periodo === v ? 'var(--terra)' : 'var(--muted)', fontWeight: 700 }}>{n}</span>
            </button>
          ))}
        </div>
        </div>
      </div>

      {/* resumo */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 1, background: 'var(--line)', borderBottom: '1px solid var(--line)' }}>
        <Resumo rotulo="Entraram" valor={doPeriodo.length} />
        <Resumo rotulo="Com corretor" valor={comCorretor.length} cor="var(--olive)" />
        <Resumo rotulo="Sem corretor" valor={semCorretor.length} cor={semCorretor.length ? 'var(--terra)' : undefined}
          ativo={soSemCorretor} onClick={semCorretor.length || soSemCorretor ? () => setSoSemCorretor(v => !v) : undefined}
          dica={semCorretor.length ? (soSemCorretor ? 'mostrando só esses · clique pra ver todos' : 'clique pra ver só esses') : undefined} />
        <Resumo rotulo="Devolvidos" valor={devolvidos.length} />
      </div>

      {/* lista */}
      <div style={{ maxHeight: 380, overflowY: 'auto' }}>
        {lista.length === 0 && (
          <p style={{ fontSize: 13, color: 'var(--muted)', margin: 0, padding: '18px 22px' }}>
            {soSemCorretor ? 'Nenhum lead sem corretor. 👍' : periodo === 'hoje' ? 'Nenhum lead entrou hoje ainda.' : periodo === 'ontem' ? 'Nenhum lead entrou ontem.' : 'Nenhum lead entrou hoje nem ontem.'}
          </p>
        )}
        {lista.map(l => {
          const sem = !l.corretorId && !l.descartadoEm;
          return (
            <button key={l.id} onClick={() => openLead(l.id)} className="data-row"
              style={{ display: 'grid', gridTemplateColumns: '64px minmax(0, 1fr) auto', alignItems: 'center', gap: 14, width: '100%', padding: '11px 22px', border: 'none', borderBottom: '1px solid var(--line)', background: sem ? 'color-mix(in srgb, var(--terraSoft) 55%, transparent)' : 'none', font: 'inherit', color: 'inherit', textAlign: 'left', cursor: 'pointer' }}>
              <span style={{ fontVariantNumeric: 'tabular-nums' }}>
                <b style={{ display: 'block', fontSize: 14 }}>{horaSp(l.criadoEm!)}</b>
                <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--muted)' }}>{l.dia}</span>
              </span>
              <span style={{ minWidth: 0 }}>
                <b style={{ display: 'block', fontSize: 13.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.nome}</b>
                <span style={{ display: 'block', fontSize: 12, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {[l.campanha || CANAL[l.canal] || l.canal, l.bairroInteresse, etapa(l.colunaId)].filter(Boolean).join(' · ')}
                </span>
              </span>
              <span style={{ textAlign: 'right' }}>
                {l.descartadoEm ? <Etiqueta cor="var(--muted)" fundo="var(--bg)">Devolvido</Etiqueta>
                  : sem ? <Etiqueta cor="var(--terra)" fundo="var(--terraSoft)">Sem corretor</Etiqueta>
                  : (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 12.5, fontWeight: 600 }}>
                      <span style={{ width: 26, height: 26, borderRadius: '50%', background: 'var(--oliveSoft)', color: 'var(--olive)', display: 'grid', placeItems: 'center', fontSize: 10, fontWeight: 800, flex: 'none' }}>{ini(l.corretor || '?')}</span>
                      <span className="entraram-corretor">{l.corretor}</span>
                    </span>
                  )}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Resumo({ rotulo, valor, cor, ativo, onClick, dica }: { rotulo: string; valor: number; cor?: string; ativo?: boolean; onClick?: () => void; dica?: string }) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag onClick={onClick} title={dica}
      style={{ background: ativo ? 'var(--terraSoft)' : 'var(--card)', padding: '13px 22px', minHeight: 84, border: 'none', font: 'inherit', color: 'inherit', textAlign: 'left', cursor: onClick ? 'pointer' : 'default', display: 'flex', flexDirection: 'column', justifyContent: 'flex-start' }}>
      <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10.5, fontWeight: 700, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--muted)' }}>
        {cor === 'var(--terra)' && <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--terra)', boxShadow: '0 0 0 3px var(--terraSoft)' }} />}{rotulo}
      </span>
      <span style={{ display: 'block', fontFamily: 'Newsreader,serif', fontSize: 26, lineHeight: 1.15, color: cor ?? 'var(--ink)' }}>{valor}</span>
      {dica && <span style={{ display: 'block', fontSize: 10.5, color: 'var(--muted)' }}>{dica}</span>}
    </Tag>
  );
}

function Etiqueta({ cor, fundo, children }: { cor: string; fundo: string; children: React.ReactNode }) {
  return <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: '.07em', textTransform: 'uppercase', color: cor, background: fundo, padding: '4px 9px', borderRadius: 20, whiteSpace: 'nowrap' }}>{children}</span>;
}
