import { useEffect, useState } from 'react';
import { useAppStore } from '../store/appStore';
import { MOTIVOS_DESCARTE_EXTREMO, MOTIVOS_DESCARTE_NORMAL, MOTIVOS_DESCARTE_OBS_OBRIGATORIA } from '../lib/data';

/** Modais das regras da v1 (CRM OKA): data ao mudar de coluna, registrar venda e descartar/devolver. */
export function ModaisRegrasOka() {
  return (
    <>
      <MoverColunaModal />
      <VendaModal />
      <DescarteModal />
    </>
  );
}

const overlay: React.CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(8,17,31,.5)', zIndex: 70, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 };
const card: React.CSSProperties = { width: '100%', maxWidth: 440, background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 14, padding: 22, animation: 'fadeUp .16s ease', maxHeight: '90vh', overflowY: 'auto' };
const label: React.CSSProperties = { display: 'block', fontSize: 11, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--muted)', margin: '14px 0 6px' };
const input: React.CSSProperties = { width: '100%', padding: '10px 12px', border: '1px solid var(--line)', borderRadius: 8, background: 'var(--bg)', fontSize: 13.5, boxSizing: 'border-box' };
const btnPrim: React.CSSProperties = { padding: '11px 18px', border: 'none', borderRadius: 8, background: 'var(--terra)', color: '#fff', fontSize: 13, fontWeight: 600 };
const btnSec: React.CSSProperties = { padding: '11px 16px', border: '1px solid var(--line)', borderRadius: 8, background: 'none', fontSize: 13 };

/** "YYYY-MM-DD" de hoje no fuso do navegador (a equipe está em SP). */
export function hojeLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
/** Horários de 30 em 30 min, das 7h às 21h30 (mesma grade da v1). */
export const HORARIOS = Array.from({ length: 30 }, (_, i) => {
  const min = i * 30;
  return `${String(7 + Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
});
/** data "YYYY-MM-DD" + hora "HH:mm" local → ISO com fuso. */
export function isoLocal(data: string, hora: string) {
  return new Date(data + 'T' + hora + ':00').toISOString();
}

function MoverColunaModal() {
  const p = useAppStore(s => s.moverPendente);
  const setP = useAppStore(s => s.setMoverPendente);
  const moverComData = useAppStore(s => s.moverComData);
  const lead = useAppStore(s => s.leads.find(l => l.id === p?.leadId));
  const [data, setData] = useState('');
  const [hora, setHora] = useState('');
  const [tipo, setTipo] = useState<'VISITA' | 'FID'>('VISITA');
  const [salvando, setSalvando] = useState(false);
  useEffect(() => { setData(''); setHora(''); setTipo(p?.titulo.toUpperCase().includes('FID') ? 'FID' : 'VISITA'); }, [p]);
  if (!p) return null;
  const agendamento = p.motivo === 'agendamento';
  const valido = !!data && !!hora && new Date(isoLocal(data, hora)).getTime() > Date.now();
  async function confirmar() {
    if (!p || !valido) return;
    setSalvando(true);
    const iso = isoLocal(data, hora);
    await moverComData(p.leadId, p.colunaId, agendamento ? { dataVisita: iso, tipoVisita: tipo } : { proximoContatoEm: iso });
    setSalvando(false);
  }
  return (
    <div style={overlay} onClick={() => setP(null)}>
      <div style={card} onClick={e => e.stopPropagation()}>
        <p style={{ fontFamily: 'Newsreader,serif', fontSize: 21, margin: 0 }}>Mover para {p.titulo}</p>
        <p style={{ fontSize: 13, color: 'var(--muted)', margin: '6px 0 0', lineHeight: 1.5 }}>
          {agendamento
            ? 'Essa coluna exige a data e o horário do compromisso.'
            : 'Marque quando vai ser o próximo contato com ' + (lead?.nome.split(' ')[0] ?? 'o cliente') + '.'}
        </p>
        {agendamento && (
          <>
            <label style={label}>Tipo</label>
            <div style={{ display: 'flex', gap: 6 }}>
              {(['VISITA', 'FID'] as const).map(t => (
                <button key={t} onClick={() => setTipo(t)} style={{ ...btnSec, flex: 1, fontWeight: 700, borderColor: tipo === t ? 'var(--terra)' : 'var(--line)', color: tipo === t ? 'var(--terra)' : 'var(--ink)' }}>{t}</button>
              ))}
            </div>
          </>
        )}
        <label style={label}>Data</label>
        <input type="date" min={hojeLocal()} value={data} onChange={e => { setData(e.target.value); setHora(''); }} style={input} />
        <label style={label}>Horário</label>
        {/* o horário só depois da data — ninguém marca "pra hoje" sem querer (regra da v1) */}
        <select value={hora} disabled={!data} onChange={e => setHora(e.target.value)} style={{ ...input, opacity: data ? 1 : 0.5 }}>
          <option value="">Escolha…</option>
          {HORARIOS.map(h => <option key={h} value={h}>{h}</option>)}
        </select>
        {data && hora && !valido && <p style={{ fontSize: 12, color: 'var(--terra)', margin: '8px 0 0' }}>Escolha um horário no futuro.</p>}
        <div style={{ display: 'flex', gap: 8, marginTop: 20 }}>
          <button onClick={confirmar} disabled={!valido || salvando} style={{ ...btnPrim, flex: 1, opacity: valido && !salvando ? 1 : 0.5 }}>{salvando ? 'Salvando…' : 'Mover'}</button>
          <button onClick={() => setP(null)} style={btnSec}>Cancelar</button>
        </div>
      </div>
    </div>
  );
}

function VendaModal() {
  const leadId = useAppStore(s => s.vendaLeadId);
  const fechar = useAppStore(s => s.setVendaLeadId);
  const registrarVenda = useAppStore(s => s.registrarVenda);
  const lead = useAppStore(s => s.leads.find(l => l.id === leadId));
  const [valor, setValor] = useState('');
  const [dataVenda, setDataVenda] = useState(hojeLocal());
  const [empreendimento, setEmpreendimento] = useState('');
  const [unidade, setUnidade] = useState('');
  const [torre, setTorre] = useState('');
  const [obs, setObs] = useState('');
  const [salvando, setSalvando] = useState(false);
  useEffect(() => {
    setValor(''); setDataVenda(hojeLocal()); setEmpreendimento(lead?.empreendimento || lead?.imovel || ''); setUnidade(''); setTorre(''); setObs('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leadId]);
  if (!leadId) return null;
  const valorNum = Number(valor.replace(/\./g, '').replace(',', '.').replace(/[^\d.]/g, ''));
  const valido = valorNum > 0 && !!dataVenda && dataVenda <= hojeLocal();
  async function enviar() {
    if (!leadId || !valido) return;
    setSalvando(true);
    await registrarVenda(leadId, { valor: valorNum, dataVenda, empreendimento: empreendimento || undefined, unidade: unidade || undefined, torre: torre || undefined, observacao: obs || undefined });
    setSalvando(false);
  }
  return (
    <div style={overlay} onClick={() => fechar(null)}>
      <div style={card} onClick={e => e.stopPropagation()}>
        <p style={{ fontFamily: 'Newsreader,serif', fontSize: 21, margin: 0 }}>Registrar venda</p>
        <p style={{ fontSize: 13, color: 'var(--muted)', margin: '6px 0 0', lineHeight: 1.5 }}>
          {lead?.nome} · a venda vai pra aprovação do gerente/dono. O card só vai pra VENDA depois de aprovada.
        </p>
        <label style={label}>Valor da venda (R$)</label>
        <input inputMode="decimal" value={valor} onChange={e => setValor(e.target.value)} placeholder="250.000,00" style={input} />
        <label style={label}>Data em que a venda aconteceu</label>
        <input type="date" max={hojeLocal()} value={dataVenda} onChange={e => setDataVenda(e.target.value)} style={input} />
        <label style={label}>Empreendimento</label>
        <input value={empreendimento} onChange={e => setEmpreendimento(e.target.value)} style={input} />
        <div style={{ display: 'flex', gap: 10 }}>
          <div style={{ flex: 1 }}><label style={label}>Unidade</label><input value={unidade} onChange={e => setUnidade(e.target.value)} style={input} /></div>
          <div style={{ flex: 1 }}><label style={label}>Torre</label><input value={torre} onChange={e => setTorre(e.target.value)} style={input} /></div>
        </div>
        <label style={label}>Observação</label>
        <textarea value={obs} onChange={e => setObs(e.target.value)} rows={2} style={{ ...input, resize: 'vertical' }} />
        <div style={{ display: 'flex', gap: 8, marginTop: 20 }}>
          <button onClick={enviar} disabled={!valido || salvando} style={{ ...btnPrim, flex: 1, opacity: valido && !salvando ? 1 : 0.5 }}>{salvando ? 'Enviando…' : 'Enviar pra aprovação'}</button>
          <button onClick={() => fechar(null)} style={btnSec}>Cancelar</button>
        </div>
      </div>
    </div>
  );
}

function DescarteModal() {
  const leadId = useAppStore(s => s.descarteLeadId);
  const fechar = useAppStore(s => s.setDescarteLeadId);
  const descartarLead = useAppStore(s => s.descartarLead);
  const lead = useAppStore(s => s.leads.find(l => l.id === leadId));
  const [motivo, setMotivo] = useState('');
  const [obs, setObs] = useState('');
  const [salvando, setSalvando] = useState(false);
  useEffect(() => { setMotivo(''); setObs(''); }, [leadId]);
  if (!leadId) return null;
  const extremo = MOTIVOS_DESCARTE_EXTREMO.includes(motivo);
  const obsObrigatoria = MOTIVOS_DESCARTE_OBS_OBRIGATORIA.includes(motivo);
  const valido = !!motivo && (!obsObrigatoria || obs.trim().length > 0);
  async function confirmar() {
    if (!leadId || !valido) return;
    setSalvando(true);
    await descartarLead(leadId, motivo, obs.trim());
    setSalvando(false);
  }
  return (
    <div style={overlay} onClick={() => fechar(null)}>
      <div style={card} onClick={e => e.stopPropagation()}>
        <p style={{ fontFamily: 'Newsreader,serif', fontSize: 21, margin: 0 }}>Devolver / descartar lead</p>
        <p style={{ fontSize: 13, color: 'var(--muted)', margin: '6px 0 0', lineHeight: 1.5 }}>{lead?.nome}</p>
        <label style={label}>Motivo</label>
        <select value={motivo} onChange={e => setMotivo(e.target.value)} style={input}>
          <option value="">Escolha o motivo…</option>
          <optgroup label="Volta pro bolsão na hora">
            {MOTIVOS_DESCARTE_NORMAL.map(m => <option key={m} value={m}>{m}</option>)}
          </optgroup>
          <optgroup label="Requer aprovação do gerente/dono">
            {MOTIVOS_DESCARTE_EXTREMO.map(m => <option key={m} value={m}>{m} (requer aprovação)</option>)}
          </optgroup>
        </select>
        {motivo && (
          <p style={{ fontSize: 12.5, lineHeight: 1.5, margin: '10px 0 0', color: extremo ? 'var(--terra)' : 'var(--muted)' }}>
            {extremo
              ? 'O lead sai do seu Kanban e espera a aprovação. Aprovado, ele sai de vez da roleta e das rebatidas (vai pra LEAD DESCADASTRAR).'
              : 'O lead volta pro bolsão sem corretor. Próximo contato, visita e follow-up são cancelados.'}
          </p>
        )}
        <label style={label}>Observação{obsObrigatoria ? ' (obrigatória)' : ''}</label>
        <textarea value={obs} onChange={e => setObs(e.target.value)} rows={3} style={{ ...input, resize: 'vertical' }} />
        <div style={{ display: 'flex', gap: 8, marginTop: 20 }}>
          <button onClick={confirmar} disabled={!valido || salvando} style={{ ...btnPrim, flex: 1, opacity: valido && !salvando ? 1 : 0.5 }}>
            {salvando ? 'Enviando…' : extremo ? 'Pedir aprovação' : 'Confirmar devolução'}
          </button>
          <button onClick={() => fechar(null)} style={btnSec}>Cancelar</button>
        </div>
      </div>
    </div>
  );
}
