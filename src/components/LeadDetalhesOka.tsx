import { perfilAtivo, nomeNaLista } from '../lib/remoteLeads';
import { useEffect, useState } from 'react';
import { SelectStatus } from './SelectStatus';
import { opcoesDeStatus } from '../lib/statusLista';
import { useAppStore } from '../store/appStore';
import { useRoleInfo } from '../lib/selectors';
import { STATUS_VISITA, type Lead } from '../lib/data';
import { BRL } from '../lib/format';
import { HORARIOS, hojeLocal, isoLocal } from './ModaisRegrasOka';

/** Aba "Detalhes" do card com os campos e as ações da v1 (CRM OKA): temperatura, dados do cliente,
 *  próximo contato, compromisso (visita/FID), cadência de chamada, coluna, venda, devolver e transferir.
 *  Cada campo salva ao sair dele e vira registro automático no Histórico (o servidor grava). */
export function LeadDetalhesOka({ lead: L }: { lead: Lead }) {
  const { isManager } = useRoleInfo();
  const colunas = useAppStore(s => s.colunasRemotas);
  const perfis = useAppStore(s => s.perfisRemotos);
  const move = useAppStore(s => s.move);
  const patchLead = useAppStore(s => s.patchLead);
  const registrarCadencia = useAppStore(s => s.registrarCadencia);
  const removerCompromisso = useAppStore(s => s.removerCompromisso);
  const transferirLeads = useAppStore(s => s.transferirLeads);
  const setVendaLeadId = useAppStore(s => s.setVendaLeadId);
  const setDescarteLeadId = useAppStore(s => s.setDescarteLeadId);
  const ask = useAppStore(s => s.ask);
  const creditoVisto = useAppStore(s => s.creditoVisto);
  const creditoPendencia = useAppStore(s => s.creditoPendencia);
  const [pendObs, setPendObs] = useState<string | null>(null);
  const emCredito = colunas.find(c => c.id === L.colunaId)?.slug === 'credito';

  const vendaFechada = !!L.dataFechamento && !L.vendaPendente;
  const travado = vendaFechada || !!L.vendaPendente;

  const salvar = (campo: string, valor: unknown, atual: unknown) => {
    if ((valor ?? '') === (atual ?? '')) return;
    void patchLead(L.id, { [campo]: valor === '' ? null : valor });
  };
  const salvarNumero = (campo: string, texto: string, atual: number | null | undefined) => {
    const n = texto.trim() === '' ? null : Number(texto.replace(/\./g, '').replace(',', '.'));
    if (n !== null && Number.isNaN(n)) return;
    if (n === (atual ?? null)) return;
    void patchLead(L.id, { [campo]: n });
  };

  // próximo contato / compromisso: data e hora separadas (hora só depois da data, como na v1)
  const [pcData, setPcData] = useState(''); const [pcHora, setPcHora] = useState('');
  const [vData, setVData] = useState(''); const [vHora, setVHora] = useState('');
  useEffect(() => { setPcData(''); setPcHora(''); setVData(''); setVHora(''); }, [L.id]);

  const fmt = (iso?: string | null) => iso ? new Date(iso).toLocaleString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
  const proxVencido = !!L.proximoContatoEm && +new Date(L.proximoContatoEm) < Date.now();

  return (
    <div>
      {vendaFechada && <Faixa cor="var(--olive)">Venda fechada{L.valorVenda ? ' · ' + BRL(L.valorVenda) : ''}{L.dataFechamento ? ' · ' + new Date(L.dataFechamento).toLocaleDateString('pt-BR') : ''} — o card não muda mais de coluna.</Faixa>}
      {L.vendaPendente && <Faixa cor="var(--terra)">Venda de {L.valorVenda ? BRL(L.valorVenda) : '—'} aguardando aprovação do gerente/dono.</Faixa>}
      {L.descartePendente && <Faixa cor="var(--terra)">Descarte "{L.motivo}" aguardando aprovação do gerente/dono.</Faixa>}
      {L.descartadoEm && !L.descartePendente && <Faixa cor="var(--muted)">Descartado: {L.motivo || '—'}</Faixa>}

      {emCredito && (
        <div style={{ border: '1px solid ' + (L.creditoAprovadoEm ? 'var(--olive)' : '#DC2626'), borderRadius: 10, padding: '12px 14px', marginBottom: 14 }}>
          <p style={{ margin: 0, fontSize: 13, fontWeight: 700, color: L.creditoAprovadoEm ? 'var(--olive)' : '#DC2626' }}>
            {L.creditoAprovadoEm ? 'Análise de Crédito: visto em ' + fmt(L.creditoAprovadoEm) : 'Análise de Crédito: aguardando o visto da gestão'}
          </p>
          {isManager && (
            pendObs === null ? (
              <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
                {!L.creditoAprovadoEm && <button onClick={() => creditoVisto(L.id)} style={{ ...btnPrim, background: 'var(--olive)' }}>Visto</button>}
                <button onClick={() => setPendObs('')} style={{ ...btnSec, color: 'var(--terra)' }}>Retornar com pendência</button>
              </div>
            ) : (
              <div style={{ marginTop: 10 }}>
                <textarea autoFocus value={pendObs} onChange={e => setPendObs(e.target.value)} rows={2} placeholder="O que está faltando? (aparece pro corretor)" style={{ ...inputCss, resize: 'vertical' }} />
                <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                  <button disabled={!pendObs.trim()} onClick={async () => { if (await creditoPendencia(L.id, pendObs.trim())) setPendObs(null); }} style={{ ...btnPrim, opacity: pendObs.trim() ? 1 : 0.5 }}>Devolver ao corretor</button>
                  <button onClick={() => setPendObs(null)} style={btnSec}>Cancelar</button>
                </div>
              </div>
            )
          )}
        </div>
      )}

      {/* Temperatura (Quente/Morno/Frio) e favorito saíram do card a pedido do dono (11/2026). */}
      {/* Blocos sem título, um de cada cor (pedido do dono, 11/2026): azul claro / branco alternados
          pro corretor achar cada assunto de olho — contato, follow-up/visita, funil, financeiro, ações, documentos. */}
      <div style={{ display: 'grid', gap: 10 }}>
        {/* 1. CONTATO — azul */}
        <Bloco cor="azul">
          <div data-modal-grid style={grid}>
            <div>
              <label style={rotuloCss}>Campanha original do lead</label>
              <div style={{ ...inputCss, color: 'var(--muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={L.campanha}>{L.campanha || '—'}</div>
            </div>
            <Campo rotulo="Nome completo" valor={L.nome} onSalvar={v => v.trim() && salvar('nome', v.trim(), L.nome)} />
            <Campo rotulo="Telefone / WhatsApp" valor={L.tel} onSalvar={v => v.trim().length >= 8 && salvar('telefone', v.trim(), L.tel)} />
            <Campo rotulo="E-mail" valor={L.email} onSalvar={v => salvar('email', v.trim() || undefined, L.email || undefined)} />
            <div>
              <Campo rotulo="Telefone alternativo" valor={L.telefoneAlternativo ?? ''} onSalvar={v => salvar('telefoneAlternativo', v.trim(), L.telefoneAlternativo)} />
              {/* 2º número do formulário ("confirme o seu telefone"): trocar NÃO apaga nenhum dos dois (na v1 o "Usar este" perdia o outro) */}
              {L.telefoneAlternativo?.trim() && (
                <button type="button" onClick={() => void patchLead(L.id, { telefone: L.telefoneAlternativo!.trim(), telefoneAlternativo: L.tel })}
                  style={{ marginTop: 4, background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: 11.5, color: 'var(--terra)', fontWeight: 600 }}>
                  ⇅ Trocar com o principal
                </button>
              )}
            </div>
            <Campo rotulo="Data de nascimento" tipo="date" valor={L.dataNascimento ?? ''} onSalvar={v => salvar('dataNascimento', v, L.dataNascimento)} />
          </div>
        </Bloco>

        {/* 2. FOLLOW-UP E VISITA — branco */}
        <Bloco cor="branco">
          <div data-modal-grid style={grid}>
            <div>
              <label style={rotuloCss}>Próximo contato</label>
              <p style={{ fontSize: 12.5, margin: '0 0 8px', color: proxVencido ? 'var(--terra)' : 'var(--muted)', fontWeight: proxVencido ? 700 : 500 }}>
                {L.proximoContatoEm ? (proxVencido ? 'Atrasado desde ' : 'Marcado pra ') + fmt(L.proximoContatoEm) : 'Nada marcado'}
              </p>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <input type="date" min={hojeLocal()} value={pcData} onChange={e => { setPcData(e.target.value); setPcHora(''); }} style={{ ...inputCss, width: 'auto', flex: '1 1 130px' }} />
                <select value={pcHora} disabled={!pcData} onChange={e => setPcHora(e.target.value)} style={{ ...inputCss, width: 'auto', flex: '1 1 90px', opacity: pcData ? 1 : 0.5 }}>
                  <option value="">Horário…</option>{HORARIOS.map(h => <option key={h}>{h}</option>)}
                </select>
                <button
                  disabled={!pcData || !pcHora}
                  onClick={async () => { if (await patchLead(L.id, { proximoContatoEm: isoLocal(pcData, pcHora) })) { setPcData(''); setPcHora(''); } }}
                  style={{ ...btnPrim, opacity: pcData && pcHora ? 1 : 0.5 }}
                >Agendar</button>
              </div>
            </div>
            <div>
              <label style={rotuloCss}>Agendar compromisso (visita / FID)</label>
              {L.dataVisita ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
                  <span style={{ fontSize: 12.5, fontWeight: 700 }}>{L.tipoVisita || 'VISITA'} · {fmt(L.dataVisita)}</span>
                  <select value={L.statusVisita || 'AGENDADA'} onChange={e => salvar('statusVisita', e.target.value, L.statusVisita)} style={{ ...inputCss, width: 'auto', padding: '5px 8px', fontSize: 12 }}>
                    {STATUS_VISITA.map(([v, r]) => <option key={v} value={v}>{r}</option>)}
                  </select>
                  <button onClick={() => ask('Remover o compromisso?', 'A data some do card e da agenda (fica registrado no histórico).', 'Remover', () => { void removerCompromisso(L.id); })} style={{ border: 'none', background: 'none', padding: 0, fontSize: 12, fontWeight: 600, color: 'var(--terra)' }}>remover</button>
                </div>
              ) : <p style={{ fontSize: 12.5, margin: '0 0 8px', color: 'var(--muted)' }}>Nenhum compromisso marcado</p>}
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <select defaultValue="VISITA" id={'tipo-' + L.id} style={{ ...inputCss, width: 'auto', flex: '0 0 auto' }}>
                  <option value="VISITA">VISITA</option><option value="FID">FID</option>
                </select>
                <input type="date" min={hojeLocal()} value={vData} onChange={e => { setVData(e.target.value); setVHora(''); }} style={{ ...inputCss, width: 'auto', flex: '1 1 130px' }} />
                <select value={vHora} disabled={!vData} onChange={e => setVHora(e.target.value)} style={{ ...inputCss, width: 'auto', flex: '1 1 90px', opacity: vData ? 1 : 0.5 }}>
                  <option value="">Horário…</option>{HORARIOS.map(h => <option key={h}>{h}</option>)}
                </select>
                <button
                  disabled={!vData || !vHora}
                  onClick={async () => {
                    const tipo = (document.getElementById('tipo-' + L.id) as HTMLSelectElement | null)?.value ?? 'VISITA';
                    if (await patchLead(L.id, { dataVisita: isoLocal(vData, vHora), tipoVisita: tipo, statusVisita: 'AGENDADA' })) { setVData(''); setVHora(''); }
                  }}
                  style={{ ...btnPrim, opacity: vData && vHora ? 1 : 0.5 }}
                >{L.dataVisita ? 'Reagendar' : 'Agendar'}</button>
              </div>
            </div>
          </div>
        </Bloco>

        {/* 3. CADÊNCIA E STATUS DO KANBAN — azul */}
        <Bloco cor="azul">
          <div data-modal-grid style={grid}>
            <div>
              <label style={rotuloCss}>Cadência de chamada</label>
              <select value={L.cadenciaChamada ?? 0} onChange={e => registrarCadencia(L.id, Number(e.target.value))} style={inputCss}>
                {[0, 1, 2, 3, 4, 5].map(n => <option key={n} value={n}>{n === 0 ? 'Início' : 'Chamada ' + n}</option>)}
              </select>
              <span style={{ display: 'block', fontSize: 11.5, color: 'var(--muted)', marginTop: 5 }}>Última chamada: {fmt(L.dataUltimaChamada)}</span>
            </div>
            <div>
              <label style={rotuloCss}>Status do Kanban</label>
              {(() => {
                const { opcoes, valor } = opcoesDeStatus(colunas, L.colunaId);
                return <SelectStatus value={valor} opcoes={opcoes} disabled={travado} onChange={id => move(L.id, id)} style={inputCss} />;
              })()}
            </div>
          </div>
        </Bloco>

        {/* valores aprovados no crédito (preenchidos ao mover pra APROVADO) */}
        {L.aprovadoFinanciamento != null && (
          <Bloco cor="branco">
            <label style={rotuloCss}>Valores aprovados{L.aprovadoEm ? ' · ' + fmt(L.aprovadoEm) : ''}</label>
            <div data-modal-grid style={grid3}>
              {([['Financiamento', L.aprovadoFinanciamento], ['Subsídio', L.aprovadoSubsidio], ['FGTS', L.aprovadoFgts]] as const).map(([r, v]) => (
                <div key={r} style={{ padding: '10px 12px', borderRadius: 8, background: 'var(--oliveSoft)' }}>
                  <span style={{ display: 'block', fontSize: 11, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--muted)' }}>{r}</span>
                  <span style={{ display: 'block', fontSize: 15, fontWeight: 700, marginTop: 3 }}>{v != null ? v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) : '—'}</span>
                </div>
              ))}
            </div>
          </Bloco>
        )}

        {/* 4. FINANCEIRO — branco */}
        <Bloco cor="branco">
          <div data-modal-grid style={grid3}>
            <Campo rotulo="Renda bruta familiar (R$)" valor={L.renda ? String(L.renda) : ''} onSalvar={v => { const n = Number(v.replace(/\./g, '').replace(',', '.')); if (v.trim() && !Number.isNaN(n) && n !== L.renda) void patchLead(L.id, { rendaDeclarada: n }); }} />
            <Campo rotulo="Saldo FGTS (R$)" valor={L.saldoFgts != null ? String(L.saldoFgts) : ''} onSalvar={v => salvarNumero('saldoFgts', v, L.saldoFgts)} />
            <Campo rotulo="Valor de entrada (R$)" valor={L.valorEntrada != null ? String(L.valorEntrada) : ''} onSalvar={v => salvarNumero('valorEntrada', v, L.valorEntrada)} />
          </div>
        </Bloco>

        {/* 5. CORRETOR E AÇÕES — azul */}
        <Bloco cor="azul">
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div style={{ flex: '1 1 220px', minWidth: 0 }}>
              <label style={rotuloCss}>{isManager ? 'Transferir para' : 'Corretor responsável'}</label>
              {isManager ? (
                <select
                  value={L.corretorId ?? ''}
                  onChange={e => {
                    const alvo = perfis.find(p => p.id === e.target.value);
                    if (alvo) ask('Transferir ' + L.nome + '?', 'O lead vai pra ' + alvo.nome + ', que recebe o aviso. Próximo contato e visita marcados são zerados.', 'Transferir', () => { void transferirLeads([L.id], alvo.id); });
                  }}
                  style={inputCss}
                >
                  <option value="" disabled>{L.corretorId ? '—' : 'Sem corretor'}</option>
                  {perfis.filter(perfilAtivo).map(p => <option key={p.id} value={p.id}>{nomeNaLista(p)}</option>)}
                </select>
              ) : (
                <div style={{ ...inputCss, color: 'var(--muted)' }}>{L.corretor || 'Sem corretor'}</div>
              )}
            </div>
            {!vendaFechada && !L.vendaPendente && !L.descartePendente && (
              <button onClick={() => setVendaLeadId(L.id)} style={{ ...btnPrim, background: 'var(--olive)' }}>Registrar venda</button>
            )}
            {!travado && !L.descartePendente && !L.descartadoEm && (
              <button onClick={() => setDescarteLeadId(L.id)} style={{ ...btnSec, background: 'var(--card)', color: 'var(--terra)' }}>Devolver / descartar</button>
            )}
          </div>
        </Bloco>

        {/* 6. DOCUMENTOS E PERFIL DO INTERESSE — branco */}
        <Bloco cor="branco">
          <div data-modal-grid style={grid}>
            <div style={{ gridColumn: '1 / -1' }}>
              <label style={rotuloCss}>Link do Drive (documentos)</label>
              <div style={{ display: 'flex', gap: 6 }}>
                <div style={{ flex: 1, minWidth: 0 }}><CampoSolto valor={L.linkDrive ?? ''} placeholder="https://drive.google.com/…" onSalvar={v => salvar('linkDrive', v.trim(), L.linkDrive)} /></div>
                {L.linkDrive && /^https?:\/\//.test(L.linkDrive) && <a href={L.linkDrive} target="_blank" rel="noreferrer" style={{ ...btnSec, display: 'flex', alignItems: 'center', textDecoration: 'none', color: 'var(--ink)' }}>Abrir</a>}
              </div>
            </div>
            <Campo rotulo="Bairro / cidade de interesse" valor={L.bairroInteresse ?? ''} onSalvar={v => salvar('bairroInteresse', v.trim(), L.bairroInteresse)} />
            <Campo rotulo="Tipo de imóvel" valor={L.tipoImovelInteresse ?? ''} onSalvar={v => salvar('tipoImovelInteresse', v.trim(), L.tipoImovelInteresse)} />
            <Campo rotulo="Referência" valor={L.referencia ?? ''} onSalvar={v => salvar('referencia', v.trim(), L.referencia)} />
          </div>
        </Bloco>
      </div>
    </div>
  );
}

function Campo({ rotulo, valor, onSalvar, tipo = 'text' }: { rotulo: string; valor: string; onSalvar: (v: string) => void; tipo?: string }) {
  const [v, setV] = useState(valor);
  useEffect(() => setV(valor), [valor]);
  return (
    <div>
      <label style={rotuloCss}>{rotulo}</label>
      <input
        type={tipo} value={v} onChange={e => setV(e.target.value)}
        onBlur={() => { if (v !== valor) onSalvar(v); }}
        onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
        style={inputCss}
      />
    </div>
  );
}

function Bloco({ cor, children }: { cor: 'azul' | 'branco'; children: React.ReactNode }) {
  const azul = cor === 'azul';
  return (
    <div style={{ border: '1px solid ' + (azul ? 'var(--blocoAzulBorda)' : 'var(--line)'), borderRadius: 12, padding: '14px 16px', background: azul ? 'var(--blocoAzul)' : 'var(--card)' }}>
      {children}
    </div>
  );
}

function CampoSolto({ valor, onSalvar, placeholder }: { valor: string; onSalvar: (v: string) => void; placeholder?: string }) {
  const [v, setV] = useState(valor);
  useEffect(() => setV(valor), [valor]);
  return (
    <input value={v} placeholder={placeholder} onChange={e => setV(e.target.value)}
      onBlur={() => { if (v !== valor) onSalvar(v); }}
      onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
      style={inputCss} />
  );
}

function Faixa({ cor, children }: { cor: string; children: React.ReactNode }) {
  return <div style={{ border: '1px solid ' + cor, color: cor, borderRadius: 9, padding: '10px 13px', fontSize: 13, fontWeight: 600, marginBottom: 14 }}>{children}</div>;
}

const grid: React.CSSProperties = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 };
const grid3: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 };
const rotuloCss: React.CSSProperties = { display: 'block', fontSize: 10.5, letterSpacing: '.09em', textTransform: 'uppercase', color: 'var(--muted)', fontWeight: 700, marginBottom: 6 };
const inputCss: React.CSSProperties = { width: '100%', padding: '10px 12px', border: '1px solid var(--line)', borderRadius: 8, background: 'var(--card)', fontSize: 13.5, boxSizing: 'border-box' };
const btnPrim: React.CSSProperties = { padding: '10px 16px', border: 'none', borderRadius: 8, background: 'var(--terra)', color: '#fff', fontSize: 13, fontWeight: 600 };
const btnSec: React.CSSProperties = { padding: '10px 16px', border: '1px solid var(--line)', borderRadius: 8, background: 'none', fontSize: 13, fontWeight: 600 };
