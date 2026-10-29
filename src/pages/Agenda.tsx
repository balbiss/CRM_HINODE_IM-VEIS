import { useEffect, useMemo, useState } from 'react';
import { useAppStore, type Compromisso } from '../store/appStore';
import { useRoleInfo } from '../lib/selectors';
import { foraDoKanban, perfilAtivo, nomeNaLista } from '../lib/remoteLeads';
import { HORARIOS, hojeLocal, isoLocal } from '../components/ModaisRegrasOka';
import type { Lead } from '../lib/data';

/** Agenda (v1): todo lead com corretor tem um próximo contato. Aba Tarefas = Atrasadas / A fazer hoje /
 *  Futuras; Calendário com a agenda do dia (visitas/FID e compromissos da equipe primeiro, depois os
 *  contatos). Lead com o robô de follow-up rodando não aparece nas tarefas. */
const WEEKDAYS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
const MESES = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
const chave = (d: Date) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const hora = (iso: string) => new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
const dataCurta = (iso: string) => new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });

type Item = { id: string; quando: string; tipo: 'visita' | 'compromisso' | 'contato' | 'tarefa'; titulo: string; sub: string; leadId?: string; comp?: Compromisso; robo?: string | null };

export default function Agenda() {
  const { isManager, meNome } = useRoleInfo();
  const leads = useAppStore(s => s.leads);
  const colunas = useAppStore(s => s.colunasRemotas);
  const perfis = useAppStore(s => s.perfisRemotos);
  const tarefas = useAppStore(s => s.tarefas);
  const fetchTarefas = useAppStore(s => s.fetchTarefas);
  const toggleTarefa = useAppStore(s => s.toggleTarefa);
  const compromissos = useAppStore(s => s.compromissos);
  const fetchCompromissos = useAppStore(s => s.fetchCompromissos);
  const salvarCompromisso = useAppStore(s => s.salvarCompromisso);
  const cancelarCompromisso = useAppStore(s => s.cancelarCompromisso);
  const openLead = useAppStore(s => s.openLead);
  const ask = useAppStore(s => s.ask);
  const me = useAppStore(s => s.me);
  useEffect(() => { fetchTarefas(); fetchCompromissos(); }, [fetchTarefas, fetchCompromissos]);

  const [aba, setAba] = useState<'tarefas' | 'calendario'>('tarefas');
  const [filtroCorretor, setFiltroCorretor] = useState('');
  const [ref, setRef] = useState(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); });
  const [diaSel, setDiaSel] = useState(chave(new Date()));
  const [form, setForm] = useState<null | { id?: string; titulo: string; tipo: string; data: string; hora: string; local: string; observacao: string }>(null);
  const [verComp, setVerComp] = useState<Compromisso | null>(null);

  const colFollow = colunas.find(c => c.slug === 'followup_auto')?.id;
  const meus = (l: Lead) => isManager ? (!filtroCorretor || l.corretorId === filtroCorretor) : l.corretor === meNome;
  const ativos = useMemo(() => leads.filter(l => l.corretorId && !foraDoKanban(l) && !(l.dataFechamento && !l.vendaPendente) && meus(l)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [leads, isManager, filtroCorretor, meNome]);

  const itens: Item[] = useMemo(() => {
    const out: Item[] = [];
    for (const l of ativos) {
      if (l.dataVisita) out.push({ id: 'v' + l.id, quando: l.dataVisita, tipo: 'visita', titulo: (l.tipoVisita || 'VISITA') + ' · ' + l.nome, sub: (isManager ? l.corretor + ' · ' : '') + (l.statusVisita || 'AGENDADA'), leadId: l.id });
      // lead com o robô rodando não entra nas tarefas (quem cuida dele é o follow-up)
      if (l.proximoContatoEm && l.colunaId !== colFollow) out.push({ id: 'c' + l.id, quando: l.proximoContatoEm, tipo: 'contato', titulo: l.nome, sub: (isManager ? l.corretor + ' · ' : '') + (colunas.find(c => c.id === l.colunaId)?.titulo ?? ''), leadId: l.id });
    }
    for (const c of compromissos) out.push({ id: 'p' + c.id, quando: c.inicio, tipo: 'compromisso', titulo: c.titulo, sub: [c.tipo, c.local].filter(Boolean).join(' · '), comp: c });
    for (const t of tarefas) {
      if (t.concluida) continue;
      if (!isManager && t.corretorId && t.corretorId !== me?.id) continue;
      if (isManager && filtroCorretor && t.corretorId !== filtroCorretor) continue;
      out.push({ id: 't' + t.id, quando: t.venceEm, tipo: 'tarefa', titulo: t.titulo, sub: t.leadNome ?? '', leadId: t.leadId ?? undefined });
    }
    return out.sort((a, b) => +new Date(a.quando) - +new Date(b.quando));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ativos, compromissos, tarefas, colFollow, colunas, isManager, filtroCorretor, me?.id]);

  const hoje = chave(new Date());
  const contatos = itens.filter(i => i.tipo === 'contato' || i.tipo === 'tarefa');
  const atrasadas = contatos.filter(i => chave(new Date(i.quando)) < hoje);
  const deHoje = itens.filter(i => chave(new Date(i.quando)) === hoje);
  const futuras = itens.filter(i => chave(new Date(i.quando)) > hoje).slice(0, 200);
  const ordemDia = (a: Item, b: Item) => (a.tipo === 'visita' || a.tipo === 'compromisso' ? 0 : 1) - (b.tipo === 'visita' || b.tipo === 'compromisso' ? 0 : 1) || +new Date(a.quando) - +new Date(b.quando);
  const doDia = itens.filter(i => chave(new Date(i.quando)) === diaSel).sort(ordemDia);
  const marcas = useMemo(() => {
    const m = new Map<string, { visita: boolean; comp: boolean; n: number }>();
    for (const i of itens) {
      const k = chave(new Date(i.quando));
      const x = m.get(k) ?? { visita: false, comp: false, n: 0 };
      if (i.tipo === 'visita') x.visita = true; else if (i.tipo === 'compromisso') x.comp = true; else x.n++;
      m.set(k, x);
    }
    return m;
  }, [itens]);

  const primeiroDia = new Date(ref.getFullYear(), ref.getMonth(), 1).getDay();
  const diasNoMes = new Date(ref.getFullYear(), ref.getMonth() + 1, 0).getDate();
  const celulas = Array.from({ length: 42 }, (_, i) => { const n = i - primeiroDia + 1; return n < 1 || n > diasNoMes ? null : { n, key: chave(new Date(ref.getFullYear(), ref.getMonth(), n)) }; });
  const podeEditar = (c: Compromisso) => c.criadoPor === me?.id || isManager;

  const linha = (i: Item, comData = false) => (
    <button key={i.id} onClick={() => (i.comp ? setVerComp(i.comp) : i.leadId && openLead(i.leadId))}
      style={{ display: 'flex', gap: 12, alignItems: 'center', width: '100%', textAlign: 'left', padding: '10px 14px', border: 'none', borderBottom: '1px solid var(--line)', background: i.tipo === 'compromisso' ? 'rgba(234,179,8,.10)' : 'none' }}>
      <span style={{ width: comData ? 92 : 48, fontSize: 12, color: 'var(--muted)', flex: 'none' }}>{comData ? dataCurta(i.quando) + ' ' : ''}{hora(i.quando)}</span>
      <span style={{ width: 8, height: 8, borderRadius: '50%', flex: 'none', background: i.tipo === 'visita' ? '#A855F7' : i.tipo === 'compromisso' ? '#CA8A04' : i.tipo === 'tarefa' ? 'var(--olive)' : 'var(--terra)' }} />
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: 13.5, fontWeight: 600, color: 'var(--ink)' }}>{i.titulo}</span>
        <span style={{ display: 'block', fontSize: 11.5, color: 'var(--muted)' }}>{i.tipo === 'contato' ? 'Contato · ' : i.tipo === 'tarefa' ? 'Tarefa · ' : ''}{i.sub}</span>
      </span>
      {i.tipo === 'tarefa' && <span onClick={e => { e.stopPropagation(); void toggleTarefa(i.id.slice(1), true); }} style={{ fontSize: 11.5, color: 'var(--olive)', fontWeight: 600 }}>concluir</span>}
    </button>
  );
  const bloco = (titulo: string, lista: Item[], cor: string, comData = true) => (
    <div style={{ border: '1px solid var(--line)', borderRadius: 12, background: 'var(--card)', overflow: 'hidden', marginBottom: 14 }}>
      <p style={{ margin: 0, padding: '11px 14px', borderBottom: '1px solid var(--line)', fontSize: 11, letterSpacing: '.12em', textTransform: 'uppercase', fontWeight: 700, color: cor }}>{titulo} ({lista.length})</p>
      {lista.map(i => linha(i, comData))}
      {lista.length === 0 && <p style={{ margin: 0, padding: '18px 14px', fontSize: 12.5, color: 'var(--muted)' }}>Nada aqui.</p>}
    </div>
  );

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', marginBottom: 14 }}>
        <div>
          <p style={{ fontSize: 11, letterSpacing: '.18em', textTransform: 'uppercase', color: 'var(--muted)', margin: '0 0 4px' }}>Agenda</p>
          <h1 style={{ fontFamily: 'Newsreader,serif', fontWeight: 400, fontSize: 24, margin: 0, lineHeight: 1.2 }}>Tarefas e compromissos</h1>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {isManager && (
            <select value={filtroCorretor} onChange={e => setFiltroCorretor(e.target.value)} style={inp}>
              <option value="">Todos os corretores</option>
              {perfis.filter(perfilAtivo).map(p => <option key={p.id} value={p.id}>{nomeNaLista(p)}</option>)}
            </select>
          )}
          <button onClick={() => setForm({ titulo: '', tipo: 'Reunião', data: hojeLocal(), hora: '', local: '', observacao: '' })} style={{ padding: '10px 16px', border: 'none', borderRadius: 8, background: 'var(--terra)', color: '#fff', fontSize: 13, fontWeight: 600 }}>Novo compromisso</button>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 20, borderBottom: '1px solid var(--line)', marginBottom: 16 }}>
        {(['tarefas', 'calendario'] as const).map(t => (
          <button key={t} onClick={() => setAba(t)} style={{ padding: '0 0 12px', border: 'none', background: 'none', fontSize: 13.5, fontWeight: aba === t ? 700 : 500, color: aba === t ? 'var(--ink)' : 'var(--muted)', borderBottom: '2px solid ' + (aba === t ? 'var(--terra)' : 'transparent'), marginBottom: -1 }}>
            {t === 'tarefas' ? 'Tarefas' + (atrasadas.length ? ' (' + atrasadas.length + ' atrasadas)' : '') : 'Calendário'}
          </button>
        ))}
      </div>

      {aba === 'tarefas' ? (
        <>
          {bloco('Atrasadas', atrasadas, '#DC2626')}
          {bloco('A fazer hoje', deHoje.sort(ordemDia), 'var(--terra)', false)}
          {bloco('Futuras', futuras, 'var(--muted)')}
        </>
      ) : (
        <div className="split-pane" style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.2fr) minmax(0,1fr)', gap: 14, alignItems: 'start' }}>
          <div style={{ border: '1px solid var(--line)', borderRadius: 12, background: 'var(--card)', padding: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
              <button onClick={() => setRef(new Date(ref.getFullYear(), ref.getMonth() - 1, 1))} style={navBtn}>‹</button>
              <strong style={{ fontSize: 14 }}>{MESES[ref.getMonth()]} {ref.getFullYear()}</strong>
              <button onClick={() => setRef(new Date(ref.getFullYear(), ref.getMonth() + 1, 1))} style={navBtn}>›</button>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 4 }}>
              {WEEKDAYS.map(w => <span key={w} style={{ fontSize: 10.5, color: 'var(--muted)', textAlign: 'center' }}>{w}</span>)}
              {celulas.map((c, i) => {
                if (!c) return <span key={i} />;
                const m = marcas.get(c.key);
                const sel = c.key === diaSel;
                return (
                  <button key={i} onClick={() => setDiaSel(c.key)} style={{ minHeight: 48, borderRadius: 8, border: '1px solid ' + (sel ? 'var(--terra)' : 'var(--line)'), background: sel ? 'var(--terraSoft)' : c.key === hoje ? 'var(--bg)' : 'none', padding: 4, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3 }}>
                    <span style={{ fontSize: 12.5, fontWeight: c.key === hoje ? 700 : 500 }}>{c.n}</span>
                    <span style={{ display: 'flex', gap: 3 }}>
                      {m?.visita && <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#A855F7' }} />}
                      {m?.comp && <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#CA8A04' }} />}
                      {!!m?.n && <span style={{ fontSize: 9.5, color: 'var(--muted)' }}>{m.n}</span>}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
          {bloco('Agenda de ' + diaSel.split('-').reverse().join('/'), doDia, 'var(--terra)', false)}
        </div>
      )}

      {form && (
        <div onClick={() => setForm(null)} style={overlay}>
          <div onClick={e => e.stopPropagation()} style={card}>
            <p style={{ fontFamily: 'Newsreader,serif', fontSize: 21, margin: '0 0 12px' }}>{form.id ? 'Editar compromisso' : 'Novo compromisso da equipe'}</p>
            <label style={lbl}>Título</label>
            <input value={form.titulo} onChange={e => setForm({ ...form, titulo: e.target.value })} style={campo} />
            <label style={lbl}>Tipo</label>
            <select value={form.tipo} onChange={e => setForm({ ...form, tipo: e.target.value })} style={campo}>
              {['Reunião', 'Treinamento', 'Evento', 'Outro'].map(t => <option key={t}>{t}</option>)}
            </select>
            <div style={{ display: 'flex', gap: 8 }}>
              <div style={{ flex: 1 }}><label style={lbl}>Data</label><input type="date" min={hojeLocal()} value={form.data} onChange={e => setForm({ ...form, data: e.target.value, hora: '' })} style={campo} /></div>
              <div style={{ flex: 1 }}><label style={lbl}>Horário</label>
                <select value={form.hora} disabled={!form.data} onChange={e => setForm({ ...form, hora: e.target.value })} style={campo}><option value="">Escolha…</option>{HORARIOS.map(h => <option key={h}>{h}</option>)}</select>
              </div>
            </div>
            <label style={lbl}>Local ou link (opcional)</label>
            <input value={form.local} onChange={e => setForm({ ...form, local: e.target.value })} style={campo} />
            <label style={lbl}>Observação (opcional)</label>
            <textarea value={form.observacao} onChange={e => setForm({ ...form, observacao: e.target.value })} rows={2} style={{ ...campo, resize: 'vertical' }} />
            <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
              <button disabled={!form.titulo.trim() || !form.data || !form.hora} onClick={async () => {
                const ok = await salvarCompromisso({ titulo: form.titulo.trim(), tipo: form.tipo, inicio: isoLocal(form.data, form.hora), local: form.local || null, observacao: form.observacao || null }, form.id);
                if (ok) setForm(null);
              }} style={{ flex: 1, padding: 11, border: 'none', borderRadius: 8, background: 'var(--terra)', color: '#fff', fontSize: 13, fontWeight: 600, opacity: form.titulo.trim() && form.data && form.hora ? 1 : 0.5 }}>Salvar</button>
              <button onClick={() => setForm(null)} style={{ padding: '11px 16px', border: '1px solid var(--line)', borderRadius: 8, background: 'none', fontSize: 13 }}>Cancelar</button>
            </div>
          </div>
        </div>
      )}

      {verComp && (
        <div onClick={() => setVerComp(null)} style={overlay}>
          <div onClick={e => e.stopPropagation()} style={card}>
            <p style={{ fontSize: 11, letterSpacing: '.12em', textTransform: 'uppercase', color: '#CA8A04', fontWeight: 700, margin: '0 0 6px' }}>{verComp.tipo}</p>
            <p style={{ fontFamily: 'Newsreader,serif', fontSize: 21, margin: 0 }}>{verComp.titulo}</p>
            <p style={{ fontSize: 13.5, margin: '10px 0 0' }}>{new Date(verComp.inicio).toLocaleString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long', hour: '2-digit', minute: '2-digit' })}</p>
            {verComp.local && <p style={{ fontSize: 13, margin: '6px 0 0' }}>📍 {verComp.local}</p>}
            {verComp.observacao && <p style={{ fontSize: 13, color: 'var(--muted)', margin: '8px 0 0' }}>{verComp.observacao}</p>}
            <p style={{ fontSize: 11.5, color: 'var(--muted)', margin: '10px 0 0' }}>Criado por {verComp.autorNome ?? '—'} · todos recebem aviso 1h antes</p>
            {podeEditar(verComp) && (
              <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
                <button onClick={() => { const d = new Date(verComp.inicio); setForm({ id: verComp.id, titulo: verComp.titulo, tipo: verComp.tipo, data: chave(d), hora: String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'), local: verComp.local ?? '', observacao: verComp.observacao ?? '' }); setVerComp(null); }} style={{ flex: 1, padding: 10, border: '1px solid var(--line)', borderRadius: 8, background: 'none', fontSize: 13, fontWeight: 600 }}>Editar</button>
                <button onClick={() => ask('Cancelar "' + verComp.titulo + '"?', 'Some da agenda de todo mundo.', 'Cancelar compromisso', () => { void cancelarCompromisso(verComp.id); setVerComp(null); })} style={{ flex: 1, padding: 10, border: '1px solid var(--line)', borderRadius: 8, background: 'none', fontSize: 13, color: 'var(--terra)' }}>Cancelar compromisso</button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

const inp: React.CSSProperties = { padding: '9px 12px', border: '1px solid var(--line)', borderRadius: 8, background: 'var(--card)', fontSize: 13 };
const navBtn: React.CSSProperties = { border: '1px solid var(--line)', background: 'none', borderRadius: 7, width: 30, height: 30, fontSize: 16 };
const overlay: React.CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(8,17,31,.5)', zIndex: 70, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 };
const card: React.CSSProperties = { width: '100%', maxWidth: 440, background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 14, padding: 22 };
const lbl: React.CSSProperties = { display: 'block', fontSize: 11, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--muted)', margin: '10px 0 5px' };
const campo: React.CSSProperties = { width: '100%', padding: '9px 11px', border: '1px solid var(--line)', borderRadius: 8, background: 'var(--bg)', fontSize: 13.5, boxSizing: 'border-box' };
