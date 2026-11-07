import { Reply, X } from 'lucide-react';
import { useAppStore } from '../store/appStore';
import type { ChatMsg } from '../lib/data';

/** "Responder" igual ao WhatsApp: 2 cliques no balão (ou a setinha) escolhem a mensagem; ela
 *  aparece em cima do campo e vai citada no próximo envio — no CRM e no WhatsApp do lead. */

function resumo(m: ChatMsg | undefined) {
  if (!m) return 'Mensagem';
  if (m.texto) return m.texto;
  return m.anexoTipo === 'imagem' ? '📷 Foto' : m.anexoTipo === 'video' ? '🎥 Vídeo' : m.anexoTipo === 'audio' ? '🎤 Áudio' : m.anexoTipo === 'documento' ? '📄 ' + (m.anexoNome || 'Documento') : 'Mensagem';
}

function autor(m: ChatMsg | undefined, leadNome: string) {
  if (!m) return '';
  if (m.side === 'in') return leadNome.split(' ')[0] || 'Lead';
  return m.bot ? 'Follow-up automático' : m.ia ? 'Agente de IA' : 'Você';
}

/** Leva até a mensagem original e pisca ela. */
export function irParaMensagem(id: string) {
  const el = document.getElementById('msg-' + id);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.animate([{ filter: 'brightness(.8)' }, { filter: 'none' }], { duration: 900, iterations: 2 });
}

/** Citação dentro do balão (a mensagem que esta responde). */
export function CitacaoNoBalao({ id, msgs, leadNome, out }: { id: string; msgs: ChatMsg[]; leadNome: string; out: boolean }) {
  const orig = msgs.find(m => m.id === id);
  return (
    <span
      onClick={e => { e.stopPropagation(); irParaMensagem(id); }}
      title="Ver a mensagem original"
      style={{
        display: 'block', cursor: 'pointer', margin: '0 0 6px', padding: '5px 9px', borderRadius: 7,
        borderLeft: '3px solid ' + (out ? 'rgba(255,255,255,.85)' : 'var(--terra)'),
        background: out ? 'rgba(0,0,0,.16)' : 'rgba(0,0,0,.05)', fontSize: 12, lineHeight: 1.4,
      }}
    >
      <span style={{ display: 'block', fontWeight: 700, fontSize: 11.5, color: out ? '#fff' : 'var(--terra)' }}>{orig ? autor(orig, leadNome) : 'Mensagem'}</span>
      <span style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', opacity: 0.85 }}>{orig ? resumo(orig) : 'Mensagem antiga'}</span>
    </span>
  );
}

/** Setinha de responder que aparece ao passar o mouse no balão (no celular fica sempre visível). */
export function BotaoResponder({ leadId, msgId, out }: { leadId: string; msgId: string; out: boolean }) {
  const setRespondendo = useAppStore(s => s.setRespondendo);
  if (msgId.startsWith('temp-')) return null;
  return (
    <button
      className="btn-responder"
      title="Responder"
      onClick={e => { e.stopPropagation(); setRespondendo({ leadId, msgId }); focarCampo(); }}
      style={{ order: out ? -1 : 1, alignSelf: 'center', width: 28, height: 28, borderRadius: '50%', border: 'none', background: 'var(--card)', boxShadow: '0 1px 3px rgba(0,0,0,.18)', color: 'var(--muted)', display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none', margin: '0 6px' }}
    >
      <Reply size={14} />
    </button>
  );
}

function focarCampo() {
  setTimeout(() => (document.querySelector('[data-campo-chat]') as HTMLElement | null)?.focus(), 30);
}

/** Props pro balão: 2 cliques = responder. */
export function useResponderNoBalao(leadId: string) {
  const setRespondendo = useAppStore(s => s.setRespondendo);
  return (msgId: string) => ({
    id: 'msg-' + msgId,
    onDoubleClick: () => {
      if (msgId.startsWith('temp-')) return;
      window.getSelection()?.removeAllRanges(); // o 2 cliques seleciona a palavra — limpa
      setRespondendo({ leadId, msgId });
      focarCampo();
    },
  });
}

/** Barra "Respondendo a…" em cima do campo de digitar. */
export function BarraResposta({ leadId, msgs, leadNome }: { leadId: string; msgs: ChatMsg[]; leadNome: string }) {
  const respondendo = useAppStore(s => s.respondendo);
  const setRespondendo = useAppStore(s => s.setRespondendo);
  if (!respondendo || respondendo.leadId !== leadId) return null;
  const orig = msgs.find(m => m.id === respondendo.msgId);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8, padding: '7px 10px', borderRadius: 8, background: 'var(--bg)', border: '1px solid var(--line)', borderLeft: '4px solid var(--terra)' }}>
      <Reply size={15} color="var(--terra)" style={{ flex: 'none' }} />
      <span style={{ flex: 1, minWidth: 0, cursor: 'pointer' }} onClick={() => irParaMensagem(respondendo.msgId)}>
        <span style={{ display: 'block', fontSize: 11.5, fontWeight: 700, color: 'var(--terra)' }}>Respondendo {orig ? autor(orig, leadNome) : ''}</span>
        <span style={{ display: 'block', fontSize: 12.5, color: 'var(--muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{resumo(orig)}</span>
      </span>
      <button title="Cancelar resposta" onClick={() => setRespondendo(null)} style={{ width: 26, height: 26, border: 'none', background: 'none', color: 'var(--muted)', display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }}>
        <X size={15} />
      </button>
    </div>
  );
}
