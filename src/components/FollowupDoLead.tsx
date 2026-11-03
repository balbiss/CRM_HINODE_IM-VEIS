import { useEffect, useState } from 'react';
import { useAppStore, type RemoteFluxo } from '../store/appStore';
import { apiFetch } from '../lib/api';

/** Controles do follow-up na aba do card: pausar/retomar/encerrar e iniciar — sempre deixando o
 *  corretor ESCOLHER o passo de onde a régua continua. Caso típico: o robô mandou o passo 1, o
 *  cliente respondeu (a régua para), o corretor conversou e o cliente sumiu de novo → religa a
 *  partir do passo 2, sem repetir a mensagem que já foi. */

type Ultima = { fluxoId: string; passoAtual: number; status: string; resultado: string | null; motivoFim: string | null } | null;

const sel: React.CSSProperties = { padding: '9px 11px', border: '1px solid var(--line)', borderRadius: 8, background: 'var(--bg)', fontSize: 13 };

function rotuloPasso(f: RemoteFluxo | undefined, i: number) {
  const p = f?.passos[i];
  const txt = (p?.conteudo || (p ? '[' + p.tipo + ']' : '')).replace(/\s+/g, ' ').trim();
  return 'Passo ' + (i + 1) + (txt ? ' — ' + (txt.length > 48 ? txt.slice(0, 48) + '…' : txt) : '');
}

function EscolherPasso({ fluxo, valor, onChange, enviados }: { fluxo: RemoteFluxo | undefined; valor: number; onChange: (n: number) => void; enviados?: number }) {
  if (!fluxo) return null;
  return (
    <select value={valor} onChange={e => onChange(Number(e.target.value))} style={{ ...sel, flex: 1, minWidth: 200 }}>
      {fluxo.passos.map((_, i) => (
        <option key={i} value={i}>{rotuloPasso(fluxo, i)}{enviados != null && i < enviados ? '  (já enviado)' : ''}</option>
      ))}
    </select>
  );
}

export function FollowupControles({ leadId, leadNome }: { leadId: string; leadNome: string }) {
  const token = useAppStore(s => s.token);
  const fluxos = useAppStore(s => s.fluxos);
  const execucao = useAppStore(s => s.execucoesFollowup.find(e => e.leadId === leadId)) ?? null;
  const iniciarFollowupLead = useAppStore(s => s.iniciarFollowupLead);
  const mudarExecucao = useAppStore(s => s.mudarExecucao);
  const ask = useAppStore(s => s.ask);
  const fluxosDisponiveis = fluxos.filter(f => f.passos.length > 0);

  const [ultima, setUltima] = useState<Ultima>(null);
  const [fluxoId, setFluxoId] = useState('');
  const [passo, setPasso] = useState(0);
  const [passoRetomar, setPassoRetomar] = useState(0);
  const [retomando, setRetomando] = useState(false);

  // última régua do lead (mesmo encerrada) → sugere continuar de onde parou
  useEffect(() => {
    setFluxoId(''); setPasso(0);
    if (execucao || !token) { setUltima(null); return; }
    let vivo = true;
    apiFetch<Ultima>('/api/followup/execucoes/lead/' + leadId + '/ultima', token)
      .then(u => {
        if (!vivo) return;
        setUltima(u);
        const f = u && fluxos.find(x => x.id === u.fluxoId && x.passos.length > 0);
        if (u && f) { setFluxoId(f.id); setPasso(Math.min(u.passoAtual, f.passos.length - 1)); }
      })
      .catch(() => { if (vivo) setUltima(null); });
    return () => { vivo = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leadId, execucao?.id, token]);

  useEffect(() => { setPassoRetomar(execucao?.passoAtual ?? 0); setRetomando(false); }, [execucao?.id, execucao?.passoAtual, execucao?.status]);

  if (execucao) {
    const fx = fluxos.find(f => f.id === execucao.fluxoId);
    const ultimoIdx = Math.max(execucao.totalPassos - 1, 0);
    return (
      <div style={{ border: '1px solid var(--line)', borderRadius: 10, padding: 18, marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
          <span style={{ width: 9, height: 9, borderRadius: '50%', flex: 'none', background: execucao.status === 'ativa' ? 'var(--olive)' : 'var(--terra)' }} />
          <span style={{ flex: 1, minWidth: 190 }}>
            <span style={{ display: 'block', fontSize: 14, fontWeight: 700 }}>
              {execucao.status === 'ativa' ? 'Follow-up rodando' : 'Follow-up pausado'} — {execucao.fluxoNome}
            </span>
            <span style={{ display: 'block', fontSize: 12.5, color: 'var(--muted)', marginTop: 3 }}>
              passo {Math.min(execucao.passoAtual + 1, execucao.totalPassos)} de {execucao.totalPassos}
              {execucao.status === 'ativa' && execucao.proximoEnvioEm
                ? ' · próximo envio ' + new Date(execucao.proximoEnvioEm).toLocaleString('pt-BR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
                : execucao.motivoFim ? ' · ' + execucao.motivoFim : ''}
            </span>
          </span>
          {execucao.status === 'ativa'
            ? <button onClick={() => mudarExecucao(execucao.id, 'pausada')} style={{ padding: '8px 14px', border: '1px solid var(--line)', borderRadius: 7, background: 'none', fontSize: 12.5, fontWeight: 600 }}>Pausar</button>
            : !retomando && <button onClick={() => { setPassoRetomar(Math.min(execucao.passoAtual, ultimoIdx)); setRetomando(true); }} style={{ padding: '8px 14px', border: '1px solid var(--olive)', borderRadius: 7, background: 'none', color: 'var(--olive)', fontSize: 12.5, fontWeight: 600 }}>Retomar</button>}
          <button onClick={() => ask('Encerrar follow-up?', leadNome + ' sai da régua e não recebe mais mensagens programadas.', 'Encerrar', () => mudarExecucao(execucao.id, 'encerrada'))} style={{ padding: '8px 14px', border: '1px solid var(--line)', borderRadius: 7, background: 'none', fontSize: 12.5, color: 'var(--terra)' }}>Encerrar</button>
        </div>
        {execucao.status === 'pausada' && retomando && (
          <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px dashed var(--line)' }}>
            <p style={{ fontSize: 12.5, fontWeight: 700, margin: '0 0 8px' }}>Retomar a partir de qual passo?</p>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <EscolherPasso fluxo={fx} valor={passoRetomar} onChange={setPassoRetomar} enviados={execucao.passoAtual} />
              <button onClick={() => mudarExecucao(execucao.id, 'ativa', passoRetomar)} style={{ padding: '9px 16px', border: 'none', borderRadius: 8, background: 'var(--olive)', color: '#fff', fontSize: 13, fontWeight: 600 }}>Retomar</button>
              <button onClick={() => setRetomando(false)} style={{ padding: '9px 12px', border: '1px solid var(--line)', borderRadius: 8, background: 'none', fontSize: 13 }}>Cancelar</button>
            </div>
            <p style={{ fontSize: 11.5, color: 'var(--muted)', margin: '8px 0 0' }}>
              O passo escolhido sai na leva atual (ou na próxima, se estiver fora do horário). Os seguintes continuam com os prazos do fluxo.
            </p>
          </div>
        )}
      </div>
    );
  }

  const fx = fluxos.find(f => f.id === fluxoId);
  const mesmaRegua = !!ultima && ultima.fluxoId === fluxoId;
  return (
    <div style={{ border: '1px solid var(--line)', borderRadius: 10, padding: 18, marginBottom: 16 }}>
      <p style={{ fontSize: 13.5, fontWeight: 700, margin: '0 0 4px' }}>Nenhuma régua rodando pra este lead</p>
      <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: '0 0 12px' }}>Escolha o fluxo e o passo de onde ele começa.</p>
      {ultima && (
        <p style={{ fontSize: 12.5, margin: '0 0 12px', padding: '8px 10px', borderRadius: 8, background: 'var(--oliveSoft)', color: 'var(--ink)', lineHeight: 1.5 }}>
          {ultima.passoAtual > 0
            ? <>O último follow-up enviou até o <strong>passo {ultima.passoAtual}</strong></>
            : <>O último follow-up não chegou a enviar nenhum passo</>}
          {ultima.motivoFim ? ' (' + ultima.motivoFim + ')' : ''}. {mesmaRegua && fx && ultima.passoAtual < fx.passos.length
            ? <>Já deixamos marcado pra continuar do <strong>passo {ultima.passoAtual + 1}</strong>, sem repetir o que foi enviado.</>
            : null}
        </p>
      )}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <select
          value={fluxoId}
          onChange={e => {
            const id = e.target.value; setFluxoId(id);
            const f = fluxos.find(x => x.id === id);
            setPasso(ultima && ultima.fluxoId === id && f ? Math.min(ultima.passoAtual, f.passos.length - 1) : 0);
          }}
          style={{ ...sel, flex: 1, minWidth: 180 }}
        >
          <option value="">Escolha o fluxo…</option>
          {fluxosDisponiveis.map(f => <option key={f.id} value={f.id}>{f.nome} ({f.passos.length} passos)</option>)}
        </select>
      </div>
      {fx && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
          <EscolherPasso fluxo={fx} valor={passo} onChange={setPasso} enviados={mesmaRegua ? ultima!.passoAtual : undefined} />
          <button
            onClick={async () => { if (await iniciarFollowupLead(leadId, fx.id, passo)) setFluxoId(''); }}
            style={{ padding: '9px 16px', border: 'none', borderRadius: 8, background: 'var(--terra)', color: '#fff', fontSize: 13, fontWeight: 600 }}
          >{passo > 0 ? 'Iniciar do passo ' + (passo + 1) : 'Iniciar'}</button>
        </div>
      )}
      {fluxosDisponiveis.length === 0 && <p style={{ fontSize: 11.5, color: 'var(--muted)', margin: '10px 0 0' }}>Monte um fluxo com passos na página Follow-up primeiro.</p>}
    </div>
  );
}
