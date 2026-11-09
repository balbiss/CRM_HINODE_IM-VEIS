import { useState } from 'react';
import { Smile } from 'lucide-react';

/** Seletor de emojis igual ao do WhatsApp (pedido 11-09: "só aparece isso de emojis"): categorias em abas,
 *  "Recentes" com os últimos usados (neste aparelho) e fica aberto pra escolher vários seguidos. */
const separar = (s: string) => [...new Intl.Segmenter('pt', { granularity: 'grapheme' }).segment(s.replace(/\s+/g, ''))].map(x => x.segment);

const CATEGORIAS: { id: string; icone: string; nome: string; emojis: string[] }[] = [
  { id: 'rostos', icone: '😀', nome: 'Rostos', emojis: separar('😀😃😄😁😆😅😂🤣🥲☺️😊😇🙂🙃😉😌😍🥰😘😗😙😚😋😛😝😜🤪🤨🧐🤓😎🥸🤩🥳😏😒😞😔😟😕🙁☹️😣😖😫😩🥺😢😭😤😠😡🤬🤯😳🥵🥶😱😨😰😥😓🫣🤗🫡🤔🫢🤭🤫🤥😶😐😑😬🙄😯😦😧😮😲🥱😴🤤😪😵🤐🥴🤢🤮🤧😷🤒🤕🤑🤠😈👻💀🤖😺😸😹😻😼😽🙀😿😾🙈🙉🙊') },
  { id: 'gestos', icone: '👍', nome: 'Gestos e pessoas', emojis: separar('👋🤚🖐️✋🖖👌🤌🤏✌️🤞🫰🤟🤘🤙👈👉👆🖕👇☝️🫵👍👎✊👊🤛🤜👏🙌🫶👐🤲🤝🙏✍️💅🤳💪🦾🫂👀👁️👄💋🧠👶🧒👦👧🧑👱👨🧔👩🧓👴👵🙋🙆🙅🤷🤦💁🙇👨‍👩‍👧‍👦👪💑👫🧑‍💼👨‍💼👩‍💼🧑‍🔧👷🕵️') },
  { id: 'coracoes', icone: '❤️', nome: 'Corações', emojis: separar('❤️🧡💛💚💙💜🖤🤍🤎💔❣️💕💞💓💗💖💘💝💟❤️‍🔥❤️‍🩹💯💢💥💫💦💨🕳️💬💭💤') },
  { id: 'casa', icone: '🏠', nome: 'Casa e imóveis', emojis: separar('🏠🏡🏘️🏚️🏗️🏢🏬🏣🏤🏥🏦🏨🏪🏫🏩💒🏛️⛪🏰🏯🗼⛲🌇🌆🏙️🌃🌉🛋️🛏️🚪🪑🚽🚿🛁🪟🧱🪜🔑🗝️🏷️📐📏🧰🔨🪛🔧🪚🧹🌳🌴🌲🌵🌷🌻🌼🌸🏖️🏝️🏞️⛰️🌄🌅') },
  { id: 'objetos', icone: '📅', nome: 'Trabalho e objetos', emojis: separar('📅📆🗓️⏰⏳⌛🕐📞☎️📱💻🖥️⌨️🖨️📷📸🎥📹📺📻🎙️📢📣🔔🔕📌📍📎🖇️✂️🖊️✏️📝📄📃📑📊📈📉📋📁📂🗂️📰📦📫📬📧✉️💰💵💸💳🪙💎⚖️🧾🏆🥇🎁🎈🎉🎊🚗🚙🚕🛵🚲✈️🚀⛽🗺️🧭☕🍺🍷🥂🍕🍔🍰🎂') },
  { id: 'simbolos', icone: '✅', nome: 'Símbolos', emojis: separar('✅☑️✔️❌❎➕➖➗✖️❓❔❕❗‼️⁉️⚠️🚫⛔📛🔴🟠🟡🟢🔵🟣⚫⚪🟤🔺🔻🔸🔹🔶🔷▶️⏸️⏹️⏺️⏭️⏮️🔁🔂🔄🔃⬆️⬇️⬅️➡️↗️↘️↙️↖️🔝🔜🆕🆗🆙🆒🆓ℹ️🔟💲©️®️™️♻️🔒🔓🔐⭐🌟✨⚡🔥☀️🌤️⛅🌧️⛈️🌈☔❄️') },
];

const CHAVE = 'crm_emojis_recentes';
const lerRecentes = (): string[] => { try { return JSON.parse(localStorage.getItem(CHAVE) || '[]'); } catch { return []; } };

export function EmojiPicker({ onPick }: { onPick: (emoji: string) => void }) {
  const [open, setOpen] = useState(false);
  const [recentes, setRecentes] = useState<string[]>(lerRecentes);
  const [aba, setAba] = useState(() => (lerRecentes().length ? 'recentes' : 'rostos'));
  const abas = [...(recentes.length ? [{ id: 'recentes', icone: '🕘', nome: 'Recentes', emojis: recentes }] : []), ...CATEGORIAS];
  const atual = abas.find(a => a.id === aba) ?? abas[0];

  const escolher = (e: string) => {
    onPick(e);
    const r = [e, ...recentes.filter(x => x !== e)].slice(0, 32);
    setRecentes(r);
    try { localStorage.setItem(CHAVE, JSON.stringify(r)); } catch { /* sem storage: só não lembra */ }
  };

  return (
    <div style={{ position: 'relative', flex: 'none' }}>
      <button
        type="button"
        title="Emojis"
        onClick={() => setOpen(o => !o)}
        style={{ width: 38, height: 38, display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px solid var(--line)', borderRadius: 8, background: open ? 'var(--terraSoft)' : 'none', color: open ? 'var(--terra)' : 'var(--muted)' }}
      >
        <Smile size={16} />
      </button>
      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 20 }} />
          <div style={{
            position: 'absolute', bottom: 46, left: 0, zIndex: 21, width: 'min(330px, calc(100vw - 32px))', background: 'var(--card)',
            border: '1px solid var(--line)', borderRadius: 12, boxShadow: '0 8px 24px rgba(0,0,0,.18)', overflow: 'hidden',
          }}>
            <div style={{ display: 'flex', borderBottom: '1px solid var(--line)', padding: '4px 4px 0' }}>
              {abas.map(a => (
                <button key={a.id} type="button" title={a.nome} onClick={() => setAba(a.id)}
                  style={{ flex: 1, padding: '6px 0 7px', fontSize: 17, border: 'none', background: 'none', cursor: 'pointer', borderBottom: '2px solid ' + (atual.id === a.id ? 'var(--terra)' : 'transparent'), opacity: atual.id === a.id ? 1 : 0.55 }}>
                  {a.icone}
                </button>
              ))}
            </div>
            <p style={{ margin: 0, padding: '7px 10px 2px', fontSize: 10.5, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--muted)', fontWeight: 700 }}>{atual.nome}</p>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(8, 1fr)', gap: 1, padding: '2px 6px 8px', maxHeight: 230, overflowY: 'auto' }}>
              {atual.emojis.map((e, i) => (
                <button
                  key={e + i}
                  type="button"
                  onClick={() => escolher(e)}
                  onMouseEnter={ev => (ev.currentTarget.style.background = 'var(--bg)')}
                  onMouseLeave={ev => (ev.currentTarget.style.background = 'none')}
                  style={{ height: 36, fontSize: 21, border: 'none', background: 'none', borderRadius: 6, cursor: 'pointer', padding: 0 }}
                >
                  {e}
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
