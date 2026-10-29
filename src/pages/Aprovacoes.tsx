import { useEffect } from 'react';
import { Navigate } from 'react-router-dom';
import { useAppStore } from '../store/appStore';
import { useRoleInfo } from '../lib/selectors';
import { BRL } from '../lib/format';

/** Aprovações (dono/gerente) — v1: descarte extremo e venda que o corretor não fecha sozinho. */
export default function Aprovacoes() {
  const { isManager } = useRoleInfo();
  const aprovacoes = useAppStore(s => s.aprovacoes);
  const fetchAprovacoes = useAppStore(s => s.fetchAprovacoes);
  const decidir = useAppStore(s => s.decidirAprovacao);
  const openLead = useAppStore(s => s.openLead);
  const ask = useAppStore(s => s.ask);
  useEffect(() => { void fetchAprovacoes(); }, [fetchAprovacoes]);
  if (!isManager) return <Navigate to="/denied" replace />;

  const vendas = aprovacoes.filter(a => a.vendaPendente);
  const descartes = aprovacoes.filter(a => a.descartePendente);
  const data = (d: string | null) => (d ? d.split('-').reverse().join('/') : '—');

  return (
    <div>
      <div style={{ marginBottom: 18 }}>
        <p style={{ fontSize: 11, letterSpacing: '.18em', textTransform: 'uppercase', color: 'var(--muted)', margin: '0 0 4px' }}>Gestão</p>
        <h1 style={{ fontFamily: 'Newsreader,serif', fontWeight: 400, fontSize: 24, margin: 0, lineHeight: 1.2 }}>Aprovações</h1>
        <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: '5px 0 0' }}>Vendas registradas e descartes extremos esperando a sua decisão.</p>
      </div>

      <Secao titulo={'Vendas (' + vendas.length + ')'} vazio="Nenhuma venda esperando aprovação.">
        {vendas.map(a => (
          <Linha key={'v' + a.id} nome={a.nome} onAbrir={() => openLead(a.id)}
            detalhe={[a.corretorNome ?? 'Sem corretor', a.valorVenda ? BRL(Number(a.valorVenda)) : '—', 'Data da venda ' + data(a.dataVendaInformada),
              a.empreendimento || '-', 'Unid. ' + (a.unidade || '-'), 'Torre ' + (a.torre || '-')].join(' · ')}
            campanha={a.campanha}
            onAprovar={() => ask('Aprovar a venda de ' + a.nome + '?', 'O card vai pra VENDA e entra nos números no mês da data informada.', 'Aprovar', () => { void decidir(a.id, 'venda', 'aprovar'); })}
            onRejeitar={() => ask('Rejeitar a venda?', 'Os dados da venda são apagados e o lead volta pro corretor revisar.', 'Rejeitar', () => { void decidir(a.id, 'venda', 'rejeitar'); })}
          />
        ))}
      </Secao>

      <Secao titulo={'Descartes (' + descartes.length + ')'} vazio="Nenhum descarte esperando aprovação.">
        {descartes.map(a => (
          <Linha key={'d' + a.id} nome={a.nome} onAbrir={() => openLead(a.id)}
            detalhe={[a.corretorNome ?? 'Sem corretor', a.motivoDescarte ?? '—'].join(' · ') + (a.observacao ? ' — “' + a.observacao + '”' : '')}
            campanha={a.campanha}
            onAprovar={() => ask('Aprovar o descarte de ' + a.nome + '?', 'O lead sai de vez da roleta e das rebatidas (vai pra LEAD DESCADASTRAR).', 'Aprovar', () => { void decidir(a.id, 'descarte', 'aprovar'); })}
            onRejeitar={() => ask('Rejeitar o descarte?', 'O lead volta pro corretor.', 'Rejeitar', () => { void decidir(a.id, 'descarte', 'rejeitar'); })}
          />
        ))}
      </Secao>
    </div>
  );
}

function Secao({ titulo, vazio, children }: { titulo: string; vazio: string; children: React.ReactNode[] }) {
  return (
    <div style={{ border: '1px solid var(--line)', borderRadius: 12, background: 'var(--card)', marginBottom: 18, overflow: 'hidden' }}>
      <p style={{ margin: 0, padding: '14px 20px', borderBottom: '1px solid var(--line)', fontSize: 11, letterSpacing: '.12em', textTransform: 'uppercase', color: 'var(--muted)', fontWeight: 700 }}>{titulo}</p>
      {children.length ? children : <p style={{ margin: 0, padding: '26px 20px', fontSize: 13, color: 'var(--muted)', textAlign: 'center' }}>{vazio}</p>}
    </div>
  );
}

function Linha({ nome, detalhe, campanha, onAbrir, onAprovar, onRejeitar }: {
  nome: string; detalhe: string; campanha: string | null; onAbrir: () => void; onAprovar: () => void; onRejeitar: () => void;
}) {
  return (
    <div className="data-row" style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 20px', borderBottom: '1px solid var(--line)', flexWrap: 'wrap' }}>
      <button onClick={onAbrir} style={{ flex: 1, minWidth: 220, textAlign: 'left', background: 'none', border: 'none', padding: 0 }}>
        <span style={{ display: 'block', fontSize: 14, fontWeight: 700, color: 'var(--ink)' }}>{nome}</span>
        <span style={{ display: 'block', fontSize: 12.5, color: 'var(--muted)', marginTop: 3, lineHeight: 1.5 }}>{detalhe}</span>
        {campanha && <span style={{ display: 'block', fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>Campanha: {campanha}</span>}
      </button>
      <button onClick={onAprovar} style={{ padding: '9px 16px', border: 'none', borderRadius: 8, background: 'var(--olive)', color: '#fff', fontSize: 13, fontWeight: 600 }}>Aprovar</button>
      <button onClick={onRejeitar} style={{ padding: '9px 14px', border: '1px solid var(--line)', borderRadius: 8, background: 'none', fontSize: 13, color: 'var(--terra)' }}>Rejeitar</button>
    </div>
  );
}
