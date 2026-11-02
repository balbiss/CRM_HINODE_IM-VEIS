import { useState } from 'react';
import { KeyRound, LogOut, X } from 'lucide-react';
import { useAppStore } from '../store/appStore';
import { apiFetch } from '../lib/api';
import { ini } from '../lib/format';

const CARGO: Record<string, string> = { dono: 'Dono', gerente: 'Gerente', corretor: 'Corretor' };

/** "Meu perfil": qualquer papel vê os próprios dados e troca a senha.
 *  Senha provisória (dono/gerente redefiniu, ou membro novo com a padrão) → vira obrigatória:
 *  não fecha até criar a senha nova (dá pra sair do sistema). */
export function MeuPerfil() {
  const me = useAppStore(s => s.me);
  const token = useAppStore(s => s.token);
  const aberto = useAppStore(s => s.meuPerfilAberto);
  const setAberto = useAppStore(s => s.setMeuPerfilAberto);
  const senhaCriada = useAppStore(s => s.senhaCriada);
  const logout = useAppStore(s => s.logout);
  const toast = useAppStore(s => s.toast);
  const [atual, setAtual] = useState('');
  const [nova, setNova] = useState('');
  const [confirma, setConfirma] = useState('');
  const [erro, setErro] = useState('');
  const [salvando, setSalvando] = useState(false);

  const obrigatoria = !!me?.senhaProvisoria;
  if (!me || (!aberto && !obrigatoria)) return null;
  const fechar = () => { if (obrigatoria) return; setAberto(false); setAtual(''); setNova(''); setConfirma(''); setErro(''); };

  const salvar = async () => {
    setErro('');
    if (!atual) return setErro(obrigatoria ? 'Digite a senha que você recebeu' : 'Digite sua senha atual');
    if (nova.length < 6) return setErro('A senha nova precisa ter pelo menos 6 caracteres');
    if (nova !== confirma) return setErro('A confirmação não bate com a senha nova');
    setSalvando(true);
    try {
      await apiFetch('/api/auth/senha', token, { method: 'PATCH', body: JSON.stringify({ senhaAtual: atual, senhaNova: nova }) });
      senhaCriada();
      setAberto(false); setAtual(''); setNova(''); setConfirma('');
      toast(obrigatoria ? 'Senha criada! Agora é só usar o CRM.' : 'Senha atualizada');
    } catch (e) {
      setErro((e as Error).message || 'Não foi possível trocar a senha');
    } finally { setSalvando(false); }
  };

  return (
    <div onClick={fechar} className="modal-overlay" style={{ position: 'fixed', inset: 0, background: 'rgba(8,17,31,.55)', zIndex: obrigatoria ? 200 : 90, display: 'grid', placeItems: 'center', padding: 20 }}>
      <div onClick={e => e.stopPropagation()} role="dialog" aria-label={obrigatoria ? 'Crie sua senha' : 'Meu perfil'} className="modal-card"
        style={{ width: '100%', maxWidth: 420, background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 16, overflow: 'hidden', boxShadow: '0 24px 60px rgba(8,17,31,.28)', animation: 'fadeUp .16s ease' }}>
        {/* cabeçalho com a pessoa */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '20px 22px', borderBottom: '1px solid var(--line)', background: 'var(--bg)' }}>
          <span style={{ width: 48, height: 48, borderRadius: '50%', background: 'var(--terraSoft)', color: 'var(--terra)', display: 'grid', placeItems: 'center', fontSize: 16, fontWeight: 800, flex: 'none' }}>{ini(me.nome)}</span>
          <span style={{ flex: 1, minWidth: 0 }}>
            <b style={{ display: 'block', fontSize: 16, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{me.nome}</b>
            <span style={{ display: 'block', fontSize: 12.5, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{me.email}</span>
            <span style={{ display: 'inline-block', marginTop: 4, fontSize: 10, fontWeight: 800, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--terra)', background: 'var(--terraSoft)', padding: '2px 8px', borderRadius: 20 }}>{CARGO[me.role] ?? me.role}</span>
          </span>
          {!obrigatoria && <button onClick={fechar} aria-label="Fechar" style={{ border: '1px solid var(--line)', background: 'var(--card)', width: 30, height: 30, borderRadius: 8, display: 'grid', placeItems: 'center', flex: 'none' }}><X size={15} /></button>}
        </div>

        <div style={{ padding: '20px 22px 22px' }}>
          <p style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '0 0 4px', fontSize: 15, fontWeight: 700 }}>
            <KeyRound size={16} color="var(--terra)" /> {obrigatoria ? 'Crie sua senha' : 'Alterar senha'}
          </p>
          <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: '0 0 16px', lineHeight: 1.5 }}>
            {obrigatoria
              ? 'Sua senha foi definida por outra pessoa. Pra sua segurança, crie uma senha só sua antes de continuar.'
              : 'Use pelo menos 6 caracteres. Não compartilhe sua senha com ninguém.'}
          </p>
          <label style={rotulo}>{obrigatoria ? 'Senha que você recebeu' : 'Senha atual'}</label>
          <input type="password" autoComplete="current-password" value={atual} onChange={e => setAtual(e.target.value)} style={campo} autoFocus />
          <label style={rotulo}>Senha nova</label>
          <input type="password" autoComplete="new-password" value={nova} onChange={e => setNova(e.target.value)} placeholder="Mínimo 6 caracteres" style={campo} />
          <label style={rotulo}>Confirme a senha nova</label>
          <input type="password" autoComplete="new-password" value={confirma} onChange={e => setConfirma(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void salvar(); }} style={campo} />
          {erro && <p style={{ fontSize: 12.5, color: '#C0392B', margin: '-4px 0 12px' }}>{erro}</p>}
          <button onClick={salvar} disabled={salvando}
            style={{ width: '100%', padding: '12px 16px', border: 'none', borderRadius: 9, background: 'var(--terra)', color: '#fff', fontSize: 14, fontWeight: 700, opacity: salvando ? 0.6 : 1, cursor: 'pointer' }}>
            {salvando ? 'Salvando…' : obrigatoria ? 'Criar minha senha' : 'Atualizar senha'}
          </button>
          {obrigatoria
            ? <button onClick={() => { logout(); location.assign('/login'); }} style={{ display: 'flex', alignItems: 'center', gap: 6, margin: '14px auto 0', border: 'none', background: 'none', color: 'var(--muted)', fontSize: 12.5, cursor: 'pointer' }}><LogOut size={13} /> Sair</button>
            : <p style={{ fontSize: 11.5, color: 'var(--muted)', margin: '14px 0 0', lineHeight: 1.5, textAlign: 'center' }}>Esqueceu a senha? Saia e use "Esqueci minha senha" na tela de entrada.</p>}
        </div>
      </div>
    </div>
  );
}

const rotulo: React.CSSProperties = { display: 'block', fontSize: 10.5, fontWeight: 700, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 6 };
const campo: React.CSSProperties = { width: '100%', padding: '11px 12px', border: '1px solid var(--line)', borderRadius: 9, background: 'var(--bg)', fontSize: 14, boxSizing: 'border-box', marginBottom: 14 };
