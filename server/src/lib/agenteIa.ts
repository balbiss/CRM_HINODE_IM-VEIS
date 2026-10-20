import { and, asc, desc, eq, or, sql } from 'drizzle-orm';
import type { Server as SocketServer } from 'socket.io';
import { db } from '../db/client.js';
import {
  agentesIa, colunasKanban, iaTurnos, imobiliarias, imoveis, leads, leadTags, mensagensWhatsapp, perfis, sessoesWhatsapp, tags,
  HORARIO_ATENDIMENTO_PADRAO, type CriterioIa, type DiaAtendimento, type PerguntaIa,
} from '../db/schema.js';
import { isBusinessHoursOpen } from './schedule.js';
import { registrarEvento } from './eventos.js';
import { distribuirLead, escolherRoleta } from './roleta.js';
import { numeroCentralDoLead } from './numeros.js';
import { resolverChatId } from './waha.js';
import { enviarAoLead, enviarModelo, presencaNoNumero, soPorModelo } from './whatsappOficial.js';
import { imoveisParaIa, type ImovelSugerido } from './catalogoIa.js';
import { decifrar } from './crypto.js';

/* Agente de IA (SDR).
 * Regra de ouro: enquanto a IA atende, o lead fica SEM corretor; quando ela termina, o CRM chama
 * a MESMA roleta de sempre (distribuirLead) — follow-up, aviso ao corretor, push etc. continuam
 * disparando de lá, sem mudança. A IA (via n8n) só conversa e extrai campos; quem decide quando
 * passar e pra qual roleta é este arquivo. */

export const PERGUNTAS_PADRAO: PerguntaIa[] = [
  { chave: 'finalidade', rotulo: 'Finalidade', pergunta: 'Se procura imóvel para comprar ou para alugar', obrigatoria: true, opcoes: ['Comprar', 'Alugar'] },
  { chave: 'tipo_imovel', rotulo: 'Tipo de imóvel', pergunta: 'Que tipo de imóvel procura (casa, apartamento, terreno, sala comercial...)', obrigatoria: true },
  { chave: 'regiao', rotulo: 'Região', pergunta: 'Em qual bairro, região ou cidade', obrigatoria: true },
  { chave: 'faixa_valor', rotulo: 'Faixa de valor', pergunta: 'Quanto pretende investir (ou o valor de aluguel que cabe no bolso)', obrigatoria: true },
  { chave: 'renda', rotulo: 'Renda familiar', pergunta: 'A renda familiar mensal aproximada (principalmente se for financiar), perguntando com delicadeza', obrigatoria: false },
  { chave: 'pagamento', rotulo: 'Forma de pagamento', pergunta: 'Como pretende pagar (financiamento, à vista, FGTS, consórcio)', obrigatoria: false },
  { chave: 'prazo', rotulo: 'Prazo', pergunta: 'Para quando precisa do imóvel', obrigatoria: false },
];

const DEBOUNCE_MS = 8000;
const timers = new Map<string, NodeJS.Timeout>();
const processando = new Set<string>();
const repetir = new Set<string>();
// Mensagens que a própria IA acabou de mandar: quando o WAHA devolve o "eco" (fromMe) pelo
// webhook, não pode ser confundido com um humano respondendo (senão a IA pausaria a si mesma).
const ecos = new Map<string, { texto: string; ate: number }[]>();
// Ritmo do primeiro contato (mensagem ativa pra quem nunca falou com o número) — anti-bloqueio.
const proximoSlot = new Map<string, number>();
const primeiroAgendado = new Set<string>();
const INTERVALO_PRIMEIRO_CONTATO_MS = 20000;

type Config = typeof agentesIa.$inferSelect;
type Lead = typeof leads.$inferSelect;

export async function configIa(imobiliariaId: string): Promise<{ cfg: Config; usaChaveSaas: boolean; nomeImob: string } | null> {
  const [imob] = await db.select({ liberada: imobiliarias.iaLiberada, usaChaveSaas: imobiliarias.iaUsaChaveSaas, nome: imobiliarias.nome })
    .from(imobiliarias).where(eq(imobiliarias.id, imobiliariaId)).limit(1);
  if (!imob?.liberada) return null;
  const [cfg] = await db.select().from(agentesIa).where(eq(agentesIa.imobiliariaId, imobiliariaId)).limit(1);
  if (!cfg?.ativo) return null;
  return { cfg, usaChaveSaas: imob.usaChaveSaas, nomeImob: imob.nome };
}

const perguntasDe = (cfg: Config) => (cfg.perguntas?.length ? cfg.perguntas : PERGUNTAS_PADRAO);

export function ehEcoDaIa(leadId: string, texto: string | null): boolean {
  const lista = ecos.get(leadId);
  if (!lista || !texto) return false;
  const agora = Date.now();
  const vivos = lista.filter(e => e.ate > agora);
  const i = vivos.findIndex(e => e.texto.trim() === texto.trim());
  if (i >= 0) vivos.splice(i, 1);
  if (vivos.length) ecos.set(leadId, vivos); else ecos.delete(leadId);
  return i >= 0;
}

function dadosIniciais(lead: Lead, perguntas: PerguntaIa[]): Record<string, string> {
  const dados: Record<string, string> = { ...(lead.iaDados || {}) };
  if (lead.finalidade && perguntas.some(p => p.chave === 'finalidade') && !dados.finalidade) {
    dados.finalidade = lead.finalidade === 'locacao' ? 'Alugar' : 'Comprar';
  }
  return dados;
}

/** Lead que chegou de um imóvel específico (site ou campanha): o anúncio já responde compra/aluguel,
 *  tipo, bairro e valor — a IA começa sabendo isso em vez de perguntar de novo. */
async function dadosDoImovelDeInteresse(lead: Lead, perguntas: PerguntaIa[], dados: Record<string, string>) {
  if (!lead.imovelInteresseId) return dados;
  const [im] = await db.select().from(imoveis).where(eq(imoveis.id, lead.imovelInteresseId)).limit(1);
  if (!im) return dados;
  const tem = (chave: string) => perguntas.some(p => p.chave === chave) && !dados[chave];
  const novo = { ...dados };
  const aluguel = /alug|loca/i.test(im.finalidade);
  if (tem('finalidade')) novo.finalidade = aluguel ? 'Alugar' : 'Comprar';
  if (tem('tipo_imovel')) novo.tipo_imovel = im.tipo;
  // "Tv. Padre Eutíquio, Batista Campos" → "Batista Campos"
  const bairro = (im.endereco || '').split(',').pop()?.trim();
  if (tem('regiao') && (bairro || im.cidade)) novo.regiao = [bairro, im.cidade].filter(Boolean).join(', ');
  const preco = Number(im.preco) || 0;
  if (tem('faixa_valor') && preco) {
    novo.faixa_valor = 'em torno de R$ ' + preco.toLocaleString('pt-BR', { maximumFractionDigits: 0 }) + (aluguel ? '/mês' : '') + ' (valor do imóvel que escolheu)';
  }
  return novo;
}

/** Coloca o lead nas mãos da IA (em vez de mandar direto pra roleta). */
export async function iniciarIa(io: SocketServer, imobiliariaId: string, leadId: string, origem: 'whatsapp' | 'formulario'): Promise<Lead | null> {
  const conf = await configIa(imobiliariaId);
  if (!conf) return null;
  const [lead] = await db.select().from(leads).where(eq(leads.id, leadId)).limit(1);
  if (!lead || lead.corretorId) return null;
  // Lead de formulário ainda não falou com nenhum número: escolhe por qual a IA vai chamar — o
  // definido na roleta em que ele vai cair, senão o 1º conectado em que a IA atende. Nenhum = roleta direto.
  let sessaoPrimeiroContato: string | null = null;
  if (origem === 'formulario') {
    const roleta = await escolherRoleta(imobiliariaId, { canal: lead.canal, finalidade: lead.finalidade, sessaoWhatsappId: null });
    const num = await numeroCentralDoLead({ imobiliariaId, sessaoWhatsappId: null }, { preferidoId: roleta?.numeroPrimeiroContatoId, soComIa: true });
    if (!num) return null;
    sessaoPrimeiroContato = num.id;
  }
  const perguntas = perguntasDe(conf.cfg);
  const [row] = await db.update(leads).set({
    ...(sessaoPrimeiroContato ? { sessaoWhatsappId: sessaoPrimeiroContato } : {}),
    iaStatus: 'atendendo',
    iaDados: await dadosDoImovelDeInteresse(lead, perguntas, dadosIniciais(lead, perguntas)),
    iaUltimaAtividadeEm: new Date(),
  }).where(eq(leads.id, leadId)).returning();
  registrarEvento(imobiliariaId, leadId, 'ia', origem === 'whatsapp'
    ? 'Agente de IA começou o atendimento'
    : 'Agente de IA vai fazer o primeiro contato pelo WhatsApp', 'Agente de IA');
  io.to('imobiliaria:' + imobiliariaId).emit('lead:updated', row);

  if (origem === 'formulario') {
    const agora = Date.now();
    const slot = Math.max(agora, (proximoSlot.get(imobiliariaId) || 0) + INTERVALO_PRIMEIRO_CONTATO_MS);
    proximoSlot.set(imobiliariaId, slot);
    primeiroAgendado.add(leadId);
    setTimeout(() => { primeiroAgendado.delete(leadId); void rodarTurno(io, leadId, 'primeiro_contato'); }, slot - agora + 3000);
  }
  return row;
}

/** Mensagem nova do cliente num lead que a IA está atendendo: junta as picadas e responde. */
export async function mensagemDoCliente(io: SocketServer, leadId: string) {
  const [row] = await db.update(leads).set({
    iaMsgsCliente: sql`${leads.iaMsgsCliente} + 1`,
    iaUltimaAtividadeEm: new Date(),
    iaAguardandoDesde: sql`coalesce(${leads.iaAguardandoDesde}, now())`,
  }).where(eq(leads.id, leadId)).returning({ imobiliariaId: leads.imobiliariaId });
  // Cada mensagem nova reinicia a contagem: a IA só responde depois de X segundos de silêncio.
  const [cfg] = row ? await db.select({ s: agentesIa.esperaSegundos }).from(agentesIa)
    .where(eq(agentesIa.imobiliariaId, row.imobiliariaId)).limit(1) : [];
  agendar(io, leadId, (cfg?.s ?? DEBOUNCE_MS / 1000) * 1000);
}

/** Marcador em iaDados de que a tentativa de resgate de um critério já foi feita. */
const TENTOU = '_tentou_';
// Turno em que as perguntas obrigatórias ficaram completas (marcador interno em iaDados).
const COMPLETO = '_completo_turno';
// Cliente dando a conversa por encerrada ("era isso", "obrigado", "depois eu vejo"...).
const CLIENTE_ENCERROU = /\b(era (s[oó] )?isso|s[oó] isso|obrigad[oa]|valeu|agrade[cç]o|depois (eu )?(vejo|olho|falo)|por enquanto [eé] s[oó]|t[aá] bom assim|tudo certo)\b/i;

/** Pra quem quer ALUGAR, a pergunta padrão de pagamento (financiamento/FGTS/consórcio) não faz
 *  sentido: vira a garantia do aluguel. Só mexe na pergunta padrão (chave "pagamento"). */
function perguntasDoCaso(perguntas: PerguntaIa[], dados: Record<string, string>, finalidadeLead: string | null): PerguntaIa[] {
  const aluguel = /alug|loca/i.test(dados.finalidade || '') || finalidadeLead === 'locacao';
  if (!aluguel) return perguntas;
  return perguntas.map(p => p.chave === 'pagamento'
    ? { ...p, rotulo: 'Garantia do aluguel', pergunta: 'Como pretende dar a garantia do aluguel (fiador, caução ou seguro-fiança)', opcoes: undefined }
    : p);
}

const dormir = (ms: number) => new Promise(res => setTimeout(res, ms));
// ~18 caracteres por segundo, entre 1,8 s e 9 s — parece gente digitando, sem deixar o cliente esperando demais.
const tempoDigitacao = (texto: string) => Math.min(9000, Math.max(1800, texto.length * 55));

/** Quebra a resposta em até 3 balões (a IA separa com linha em branco), como alguém no WhatsApp. */
function baloesDe(resposta: string) {
  const partes = resposta.split(/\n\s*\n/).map(s => s.trim()).filter(Boolean);
  return partes.length <= 3 ? partes : [...partes.slice(0, 2), partes.slice(2).join('\n\n')];
}

function agendar(io: SocketServer, leadId: string, ms: number) {
  const t = timers.get(leadId);
  if (t) clearTimeout(t);
  timers.set(leadId, setTimeout(() => { timers.delete(leadId); void rodarTurno(io, leadId, 'mensagem'); }, ms));
}

/** Um humano assumiu (respondeu pelo CRM ou pelo celular) → a IA sai de cena nesse lead. */
export async function pausarIa(io: SocketServer, leadId: string, motivo: string) {
  const t = timers.get(leadId);
  if (t) { clearTimeout(t); timers.delete(leadId); }
  const [row] = await db.update(leads).set({ iaStatus: 'pausado', iaAguardandoDesde: null })
    .where(and(eq(leads.id, leadId), eq(leads.iaStatus, 'atendendo'))).returning();
  if (!row) return;
  registrarEvento(row.imobiliariaId, leadId, 'ia', 'Agente de IA pausado: ' + motivo, 'Agente de IA');
  io.to('imobiliaria:' + row.imobiliariaId).emit('lead:updated', row);
}

const MOTIVOS: Record<string, string> = {
  completo: 'qualificação completa',
  pediu_humano: 'o cliente pediu pra falar com uma pessoa',
  sem_interesse: 'o cliente disse que não tem interesse',
  limite: 'limite de mensagens da IA atingido',
  sem_resposta: 'o cliente não respondeu ao primeiro contato',
  abandono: 'o cliente parou de responder',
  numero_invalido: 'o número não tem WhatsApp',
  erro: 'a IA teve um erro',
  ia_desligada: 'o Agente de IA foi desligado',
  manual: 'passado manualmente',
};

function detectarFinalidade(valor?: string): 'venda' | 'locacao' | null {
  if (!valor) return null;
  if (/alug|loca/i.test(valor)) return 'locacao';
  if (/compr|vend|invest/i.test(valor)) return 'venda';
  return null;
}

const DIAS_CLIENTE = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
const hora = (min: number) => Math.floor(min / 60) + 'h' + (min % 60 ? String(min % 60).padStart(2, '0') : '');

/** "seg a sex das 8h às 18h20, sáb das 8h às 12h" — agrupa dias seguidos com o mesmo horário. */
function horarioParaCliente(dias: DiaAtendimento[] | null | undefined) {
  const cfg = dias && dias.length === 7 ? dias : HORARIO_ATENDIMENTO_PADRAO;
  const ordem = [1, 2, 3, 4, 5, 6, 0];
  const grupos: { de: number; ate: number; abre: number; fecha: number }[] = [];
  for (const i of ordem) {
    const d = cfg[i];
    if (!d?.ativo) continue;
    const ult = grupos[grupos.length - 1];
    if (ult && ult.abre === d.abreMin && ult.fecha === d.fechaMin && ordem.indexOf(ult.ate) === ordem.indexOf(i) - 1) ult.ate = i;
    else grupos.push({ de: i, ate: i, abre: d.abreMin, fecha: d.fechaMin });
  }
  return grupos.map(g => (g.de === g.ate ? DIAS_CLIENTE[g.de] : DIAS_CLIENTE[g.de] + ' a ' + DIAS_CLIENTE[g.ate])
    + ' das ' + hora(g.abre) + ' às ' + hora(g.fecha)).join(', ');
}

/** Depois de entregar pra roleta, conta ao cliente a situação REAL (quem vai atender, ou quando). */
async function avisarSituacao(io: SocketServer, leadId: string, corretorId: string | null) {
  const [lead] = await db.select().from(leads).where(eq(leads.id, leadId)).limit(1);
  if (!lead) return;
  let texto: string;
  if (corretorId) {
    const [c] = await db.select({ nome: perfis.nome }).from(perfis).where(eq(perfis.id, corretorId)).limit(1);
    const primeiro = (c?.nome || '').trim().split(/\s+/)[0];
    texto = primeiro
      ? 'Quem vai continuar seu atendimento é ' + primeiro + ', já já fala com você por aqui 😊'
      : 'Um dos nossos corretores já vai falar com você por aqui 😊';
  } else {
    const [imob] = await db.select({ h: imobiliarias.horarioAtendimento }).from(imobiliarias).where(eq(imobiliarias.id, lead.imobiliariaId)).limit(1);
    texto = isBusinessHoursOpen(imob?.h)
      ? 'Nossos corretores estão em atendimento agora, mas assim que um ficar livre ele fala com você por aqui 😊'
      : 'Nosso atendimento é ' + horarioParaCliente(imob?.h) + '. Assim que abrirmos, um corretor fala com você por aqui 😊';
  }
  await dormir(1500);
  await enviarPelaIa(io, lead, texto).catch(e => console.error('agente IA situação:', (e as Error).message));
}

// Resposta a quem escreve de novo enquanto espera um corretor: no máximo 1 por hora, e não
// responde agradecimento/confirmação ("ok", "tá bom", "obrigado"), que ninguém responderia.
const ultimaEspera = new Map<string, number>();
const SO_CONFIRMACAO = /^(ok+|okay|blz|beleza|t[aá] ?bom|t[aá] ?certo|certo|combinado|obrigad[oa]|obg|valeu|vlw|show|perfeito|sim|👍|🙏|😊|❤️|🙂)[\s!.]*$/i;

export async function clienteAguardandoCorretor(io: SocketServer, lead: Lead, texto: string | null) {
  if (lead.corretorId || lead.iaStatus !== 'transferido' || lead.motivoDescarte) return;
  if (!texto || SO_CONFIRMACAO.test(texto.trim())) return;
  const ult = ultimaEspera.get(lead.id) || 0;
  if (Date.now() - ult < 60 * 60000) return;
  ultimaEspera.set(lead.id, Date.now());
  const [imob] = await db.select({ h: imobiliarias.horarioAtendimento }).from(imobiliarias).where(eq(imobiliarias.id, lead.imobiliariaId)).limit(1);
  const resposta = isBusinessHoursOpen(imob?.h)
    ? 'Recebi sua mensagem! Assim que um corretor ficar livre ele fala com você por aqui 😊'
    : 'Recebi sua mensagem! Nosso atendimento é ' + horarioParaCliente(imob?.h) + ', assim que abrirmos um corretor fala com você 😊';
  await dormir(3000);
  await enviarPelaIa(io, lead, resposta).catch(() => {});
}

/** Fim do atendimento da IA: grava o resumo e entrega pra roleta de sempre. */
export async function passarParaRoleta(io: SocketServer, leadId: string, motivo: keyof typeof MOTIVOS | string) {
  const t = timers.get(leadId);
  if (t) { clearTimeout(t); timers.delete(leadId); }
  const [lead] = await db.select().from(leads).where(eq(leads.id, leadId)).limit(1);
  if (!lead || (lead.iaStatus !== 'atendendo' && lead.iaStatus !== 'pausado')) return;
  const [cfg] = await db.select().from(agentesIa).where(eq(agentesIa.imobiliariaId, lead.imobiliariaId)).limit(1);
  const perguntas = cfg ? perguntasDe(cfg) : PERGUNTAS_PADRAO;
  const dados = lead.iaDados || {};
  const resumo = resumoDe(perguntas, dados);
  const finalidade = lead.finalidade ?? detectarFinalidade(dados.finalidade);

  const [row] = await db.update(leads).set({ iaStatus: 'transferido', iaResumo: resumo, finalidade, iaAguardandoDesde: null })
    .where(eq(leads.id, leadId)).returning();
  registrarEvento(lead.imobiliariaId, leadId, 'ia',
    'Agente de IA passou pra roleta — ' + (MOTIVOS[motivo] || motivo) + (resumo ? '. ' + resumo.replace(/\n/g, ' · ') : ''),
    'Agente de IA');
  io.to('imobiliaria:' + lead.imobiliariaId).emit('lead:updated', row);
  const corretorId = await distribuirLead(io, lead.imobiliariaId, leadId);
  // O cliente estava conversando: conta o que acontece agora. (Sem resposta/abandono = ele não
  // está esperando nada; manual/IA desligada = a equipe está no controle.)
  if (['completo', 'pediu_humano', 'limite', 'erro'].includes(motivo)) void avisarSituacao(io, leadId, corretorId);
}

function resumoDe(perguntas: PerguntaIa[], dados: Record<string, string>) {
  return perguntas.filter(p => dados[p.chave]).map(p => p.rotulo + ': ' + dados[p.chave]).join('\n') || null;
}

/** Desqualificado com ação "descartar": NÃO passa pela roleta — vai pro bolsão (Rebatidas) com o
 *  motivo, igual a um descarte manual. Fica disponível pra um corretor puxar se a IA errou. */
async function descartarPelaIa(io: SocketServer, leadId: string, crit: CriterioIa, perguntas: PerguntaIa[]) {
  const [lead] = await db.select().from(leads).where(eq(leads.id, leadId)).limit(1);
  if (!lead) return;
  const [rebatida] = await db.select({ id: colunasKanban.id }).from(colunasKanban)
    .where(and(eq(colunasKanban.imobiliariaId, lead.imobiliariaId), eq(colunasKanban.slug, 'rebatida'))).limit(1);
  const [row] = await db.update(leads).set({
    iaStatus: 'transferido', iaAguardandoDesde: null,
    iaResumo: resumoDe(perguntas, lead.iaDados || {}),
    motivoDescarte: 'Desqualificado pela IA: ' + crit.descricao,
    ...(rebatida ? { colunaId: rebatida.id, entrouNaColunaEm: new Date() } : {}),
  }).where(eq(leads.id, leadId)).returning();
  registrarEvento(lead.imobiliariaId, leadId, 'descarte', 'Agente de IA desqualificou o lead: ' + crit.descricao + ' — foi pro bolsão (Rebatidas)', 'Agente de IA');
  io.to('imobiliaria:' + lead.imobiliariaId).emit('lead:updated', row);
}

async function aplicarEtiquetas(io: SocketServer, lead: Lead, tagIds: string[]) {
  if (!tagIds.length) return;
  const validas = (await db.select({ id: tags.id }).from(tags).where(eq(tags.imobiliariaId, lead.imobiliariaId))).map(t => t.id);
  const aplicar = [...new Set(tagIds)].filter(id => validas.includes(id));
  if (!aplicar.length) return;
  await db.insert(leadTags).values(aplicar.map(tagId => ({ leadId: lead.id, tagId }))).onConflictDoNothing();
  const atuais = await db.select({ tagId: leadTags.tagId }).from(leadTags).where(eq(leadTags.leadId, lead.id));
  io.to('imobiliaria:' + lead.imobiliariaId).emit('lead:tags', { leadId: lead.id, tagIds: atuais.map(a => a.tagId) });
}

const sessaoCentral = (lead: Lead) => numeroCentralDoLead(lead);

export async function temCentralConectada(imobiliariaId: string) {
  const [s] = await db.select({ id: sessoesWhatsapp.id }).from(sessoesWhatsapp)
    .where(and(eq(sessoesWhatsapp.imobiliariaId, imobiliariaId), eq(sessoesWhatsapp.escopo, 'central'),
      or(eq(sessoesWhatsapp.status, 'conectada'), eq(sessoesWhatsapp.oficialAtiva, true)))).limit(1);
  return !!s;
}

/** Ficha do imóvel que fecha o envio das fotos (formatação do WhatsApp: *negrito*). */
function fichaImovel(im: ImovelSugerido) {
  const aluguel = /alug/i.test(im.finalidade);
  const linhas = [
    '🏠 *' + im.titulo + '*',
    im.local ? '📍 ' + im.local : '',
    im.preco ? '💰 R$ ' + im.preco.toLocaleString('pt-BR', { maximumFractionDigits: 0 }) + (aluguel ? '/mês' : '') : '💰 Valores: o corretor te passa',
    [im.condominio ? 'Condomínio R$ ' + im.condominio.toLocaleString('pt-BR', { maximumFractionDigits: 0 }) : '',
      im.iptu ? 'IPTU R$ ' + im.iptu.toLocaleString('pt-BR', { maximumFractionDigits: 0 }) : ''].filter(Boolean).join(' · '),
    [im.quartos ? '🛏 ' + im.quartos + ' quarto' + (im.quartos > 1 ? 's' : '') + (im.suites ? ' (' + im.suites + ' suíte' + (im.suites > 1 ? 's' : '') + ')' : '') : '',
      im.vagas ? '🚗 ' + im.vagas + ' vaga' + (im.vagas > 1 ? 's' : '') : '', im.area ? '📐 ' + im.area + ' m²' : ''].filter(Boolean).join(' · '),
    im.destaques.length ? '✨ ' + im.destaques.join(', ') : '',
    '✅ ' + im.situacao + (im.aceitaFinanciamento && !aluguel ? ' · aceita financiamento' : ''),
  ];
  return linhas.filter(Boolean).join('\n');
}

/** Foto de imóvel mandada pela IA. A legenda é obrigatória: é por ela que o eco do WhatsApp é
 *  reconhecido (sem isso a foto voltaria como "humano respondendo" e pausaria a IA). */
async function enviarFotoPelaIa(io: SocketServer, lead: Lead, url: string, legenda: string, chatIdPronto?: string) {
  const sessao = await sessaoCentral(lead);
  if (!sessao) throw new Error('nenhum número central conectado');
  const lista = ecos.get(lead.id) || [];
  lista.push({ texto: legenda, ate: Date.now() + 120000 });
  ecos.set(lead.id, lista);
  // janela de 24h aberta → API oficial; senão WAHA (número híbrido)
  const { id, chave } = await enviarAoLead(sessao, lead, { texto: legenda, anexoUrl: url, anexoTipo: 'imagem' }, { chatIdWaha: chatIdPronto });
  const [row] = await db.insert(mensagensWhatsapp).values({
    leadId: lead.id, direcao: 'out', canal: 'ia', waMessageId: id, waChave: chave, ackStatus: 2, texto: legenda, anexoUrl: url, anexoTipo: 'imagem',
  }).onConflictDoNothing().returning();
  if (row) io.to('imobiliaria:' + lead.imobiliariaId).emit('mensagem:created', row);
}

async function enviarPelaIa(io: SocketServer, lead: Lead, texto: string, chatIdPronto?: string) {
  const sessao = await sessaoCentral(lead);
  if (!sessao) throw new Error('nenhum número central conectado');
  const lista = ecos.get(lead.id) || [];
  lista.push({ texto, ate: Date.now() + 120000 });
  ecos.set(lead.id, lista);
  const { id, chave } = await enviarAoLead(sessao, lead, { texto }, { chatIdWaha: chatIdPronto });
  const [row] = await db.insert(mensagensWhatsapp).values({
    leadId: lead.id, direcao: 'out', canal: 'ia', waMessageId: id, waChave: chave, ackStatus: 2, texto,
  }).onConflictDoNothing().returning();
  if (!lead.sessaoWhatsappId) await db.update(leads).set({ sessaoWhatsappId: sessao.id }).where(eq(leads.id, lead.id));
  if (row) io.to('imobiliaria:' + lead.imobiliariaId).emit('mensagem:created', row);
}

/** Transcreve o áudio do cliente (workflow n8n separado, mesma chave do agente). null se não der. */
export async function transcreverAudio(imobiliariaId: string, audioUrl: string): Promise<string | null> {
  const url = process.env.N8N_AGENTE_IA_TRANSCRICAO_URL;
  if (!url) return null;
  const conf = await configIa(imobiliariaId);
  if (!conf) return null;
  let openaiKey: string | null = null;
  if (!conf.usaChaveSaas) {
    const { cfg } = conf;
    if (!cfg.chaveCifrada || !cfg.chaveIv || !cfg.chaveTag) return null;
    openaiKey = decifrar({ cifrado: cfg.chaveCifrada, iv: cfg.chaveIv, tag: cfg.chaveTag });
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 60000);
  try {
    const r = await fetch(url, {
      method: 'POST', signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', 'x-agente-secret': process.env.N8N_AGENTE_IA_SECRET || '' },
      body: JSON.stringify({ audioUrl, openaiKey }),
    });
    const j = await r.json() as { ok?: boolean; texto?: string };
    return j.ok && j.texto?.trim() ? j.texto.trim() : null;
  } catch (e) {
    console.error('agente IA transcrição:', (e as Error).message);
    return null;
  } finally {
    clearTimeout(t);
  }
}

const UF_DDD: Record<string, string> = {
  11: 'SP — São Paulo capital', 12: 'SP — Vale do Paraíba (São José dos Campos)', 13: 'SP — Baixada Santista (Santos)', 14: 'SP — Bauru',
  15: 'SP — Sorocaba', 16: 'SP — Ribeirão Preto', 17: 'SP — São José do Rio Preto', 18: 'SP — Presidente Prudente', 19: 'SP — Campinas',
  21: 'RJ — Rio de Janeiro', 22: 'RJ — Norte Fluminense / Região dos Lagos', 24: 'RJ — Sul Fluminense / Serrana', 27: 'ES — Vitória', 28: 'ES — Sul do Espírito Santo',
  31: 'MG — Belo Horizonte', 32: 'MG — Juiz de Fora', 33: 'MG — Governador Valadares', 34: 'MG — Triângulo Mineiro (Uberlândia)', 35: 'MG — Sul de Minas',
  37: 'MG — Centro-Oeste de Minas (Divinópolis)', 38: 'MG — Norte de Minas (Montes Claros)',
  41: 'PR — Curitiba', 42: 'PR — Ponta Grossa', 43: 'PR — Londrina', 44: 'PR — Maringá', 45: 'PR — Oeste do Paraná (Cascavel / Foz do Iguaçu)', 46: 'PR — Sudoeste do Paraná',
  47: 'SC — Norte de SC (Joinville / Blumenau / Balneário Camboriú)', 48: 'SC — Florianópolis', 49: 'SC — Oeste de SC (Chapecó / Lages)',
  51: 'RS — Porto Alegre', 53: 'RS — Pelotas', 54: 'RS — Serra Gaúcha (Caxias do Sul)', 55: 'RS — Centro/Oeste do RS (Santa Maria)',
  61: 'DF — Brasília', 62: 'GO — Goiânia', 63: 'TO — Tocantins', 64: 'GO — Sul de Goiás (Rio Verde)', 65: 'MT — Cuiabá', 66: 'MT — interior do Mato Grosso',
  67: 'MS — Mato Grosso do Sul', 68: 'AC — Acre', 69: 'RO — Rondônia',
  71: 'BA — Salvador', 73: 'BA — Sul da Bahia (Ilhéus / Itabuna)', 74: 'BA — Norte da Bahia (Juazeiro)', 75: 'BA — Feira de Santana', 77: 'BA — Oeste/Sudoeste da Bahia', 79: 'SE — Sergipe',
  81: 'PE — Recife', 82: 'AL — Alagoas', 83: 'PB — Paraíba', 84: 'RN — Rio Grande do Norte', 85: 'CE — Fortaleza', 86: 'PI — Teresina', 87: 'PE — Sertão de Pernambuco',
  88: 'CE — interior do Ceará', 89: 'PI — interior do Piauí',
  91: 'PA — Belém e região', 92: 'AM — Manaus', 93: 'PA — Oeste do Pará (Santarém)', 94: 'PA — Sudeste do Pará (Marabá)', 95: 'RR — Roraima', 96: 'AP — Amapá',
  97: 'AM — interior do Amazonas', 98: 'MA — São Luís', 99: 'MA — interior do Maranhão',
};

/** Pista de região pelo DDD do telefone (é só pista: a pessoa pode morar em outro lugar). */
export function regiaoPorDDD(telefone: string): string | null {
  const d = telefone.replace(/\D/g, '');
  if (d.length >= 12 && d.startsWith('55')) return UF_DDD[d.slice(2, 4)] ? 'DDD ' + d.slice(2, 4) + ' (' + UF_DDD[d.slice(2, 4)] + ')' : null;
  if (d.length === 10 || d.length === 11) return UF_DDD[d.slice(0, 2)] ? 'DDD ' + d.slice(0, 2) + ' (' + UF_DDD[d.slice(0, 2)] + ')' : null;
  if (d.length > 11 && !d.startsWith('55')) return 'número de fora do Brasil';
  return null;
}

type RespostaN8n = {
  ok?: boolean; resposta?: string; campos?: Record<string, unknown>; encerrar?: boolean; pediuHumano?: boolean; semInteresse?: boolean;
  etiquetas?: string[]; desqualificacao?: string | null; tentativaResgate?: string | null; textoDesqualificacao?: string | null;
  enviarFotos?: string | null; imovelInteresse?: string | null;
  tokens?: number; erro?: string;
};

async function chamarN8n(payload: unknown): Promise<RespostaN8n> {
  const url = process.env.N8N_AGENTE_IA_WEBHOOK_URL;
  if (!url) throw new Error('N8N_AGENTE_IA_WEBHOOK_URL não configurada');
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 60000);
  try {
    const r = await fetch(url, {
      method: 'POST', signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', 'x-agente-secret': process.env.N8N_AGENTE_IA_SECRET || '' },
      body: JSON.stringify(payload),
    });
    const txt = await r.text();
    if (!r.ok) throw new Error('n8n ' + r.status + ' ' + txt.slice(0, 200));
    const j = JSON.parse(txt) as RespostaN8n;
    if (j.ok === false) throw new Error(j.erro || 'n8n devolveu erro');
    return j;
  } finally {
    clearTimeout(t);
  }
}

async function registrarTurno(lead: Lead, dados: {
  entrada: string | null; resposta: string | null; campos: Record<string, string>; decisao: string; erro?: string | null; tokens?: number; chaveSaas: boolean;
}) {
  await db.insert(iaTurnos).values({
    imobiliariaId: lead.imobiliariaId, leadId: lead.id, leadNome: lead.nome,
    entrada: dados.entrada, resposta: dados.resposta, campos: dados.campos, decisao: dados.decisao,
    erro: dados.erro ?? null, tokens: dados.tokens ?? 0, chaveSaas: dados.chaveSaas,
  }).catch(e => console.error('ia turno log:', (e as Error).message));
}

// Conta mensagens do cliente (e não compara horário: o Postgres guarda microssegundos e o Date do
// JS só milissegundos — a última mensagem lida parecia "nova" e toda resposta era refeita 2x).
async function mensagensDoCliente(leadId: string) {
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(mensagensWhatsapp)
    .where(and(eq(mensagensWhatsapp.leadId, leadId), eq(mensagensWhatsapp.direcao, 'in')));
  return r?.n ?? 0;
}

async function rodarTurno(io: SocketServer, leadId: string, evento: 'mensagem' | 'primeiro_contato', refeitas = 0) {
  if (processando.has(leadId)) { repetir.add(leadId); return; }
  processando.add(leadId);
  const inicio = new Date();
  let refazer = false;
  try {
    const [lead] = await db.select().from(leads).where(eq(leads.id, leadId)).limit(1);
    if (!lead || lead.iaStatus !== 'atendendo') return;
    if (evento === 'primeiro_contato' && (lead.iaTurnos > 0 || lead.iaMsgsCliente > 0)) return;
    const conf = await configIa(lead.imobiliariaId);
    if (!conf) { await passarParaRoleta(io, leadId, 'ia_desligada'); return; }
    const { cfg } = conf;
    const perguntas = perguntasDe(cfg);

    // Lead de formulário num número em que SÓ a API oficial está no ar (WAHA caiu) e o cliente nunca
    // escreveu: a Meta só deixa abrir a conversa com modelo aprovado. Manda o modelo e a IA segue
    // normalmente quando o cliente responder.
    if (evento === 'primeiro_contato') {
      const sessao = await sessaoCentral(lead);
      if (sessao && await soPorModelo(sessao, leadId)) {
        try {
          const { id, texto } = await enviarModelo(sessao, lead);
          const [row] = await db.insert(mensagensWhatsapp).values({
            leadId, direcao: 'out', canal: 'ia', waMessageId: id, ackStatus: 2, texto,
          }).onConflictDoNothing().returning();
          if (row) io.to('imobiliaria:' + lead.imobiliariaId).emit('mensagem:created', row);
          registrarEvento(lead.imobiliariaId, leadId, 'ia', 'Primeiro contato pelo modelo da API oficial (' + sessao.oficialTemplate + ')', 'Agente de IA');
          // conta como turno: o varredor não manda o modelo de novo, e "sem resposta" segue valendo
          await db.update(leads).set({ iaTurnos: 1, iaUltimaAtividadeEm: new Date() }).where(eq(leads.id, leadId));
        } catch (e) {
          await registrarTurno(lead, { entrada: null, resposta: null, campos: {}, decisao: 'passar:erro', erro: 'modelo: ' + (e as Error).message, chaveSaas: false });
          await passarParaRoleta(io, leadId, 'erro');
        }
        return;
      }
    }

    // Quantas mensagens do cliente a IA "leu" (contadas ANTES de ler o histórico): se aumentar até a
    // hora de enviar, a resposta ficou velha.
    const lidasDoCliente = await mensagensDoCliente(leadId);
    const msgs = (await db.select({ direcao: mensagensWhatsapp.direcao, texto: mensagensWhatsapp.texto, anexoTipo: mensagensWhatsapp.anexoTipo, transcricao: mensagensWhatsapp.transcricao })
      .from(mensagensWhatsapp).where(eq(mensagensWhatsapp.leadId, leadId))
      .orderBy(desc(mensagensWhatsapp.enviadoEm)).limit(20)).reverse();
    const historico = msgs.map(m => ({
      papel: m.direcao === 'in' ? 'cliente' : 'atendente',
      texto: [m.texto, m.transcricao ? '[áudio]: ' + m.transcricao : null].filter(Boolean).join('\n')
        || (m.anexoTipo ? '[o cliente mandou ' + (m.anexoTipo === 'audio' ? 'um áudio que não deu pra entender' : m.anexoTipo) + ']' : ''),
    })).filter(m => m.texto);
    let ultimaSaida = -1;
    historico.forEach((m, i) => { if (m.papel === 'atendente') ultimaSaida = i; });
    const entrada = historico.slice(ultimaSaida + 1).map(m => m.texto).join('\n') || null;
    // Nada novo do cliente depois da última resposta → não responde (evita mandar a mesma coisa 2x).
    if (evento === 'mensagem' && !entrada) {
      await db.update(leads).set({ iaAguardandoDesde: null }).where(eq(leads.id, leadId));
      return;
    }

    let openaiKey: string | null = null;
    if (!conf.usaChaveSaas) {
      if (!cfg.chaveCifrada || !cfg.chaveIv || !cfg.chaveTag) {
        await registrarTurno(lead, { entrada, resposta: null, campos: {}, decisao: 'passar:erro', erro: 'Chave OpenAI própria não cadastrada', chaveSaas: false });
        await passarParaRoleta(io, leadId, 'erro');
        return;
      }
      openaiKey = decifrar({ cifrado: cfg.chaveCifrada, iv: cfg.chaveIv, tag: cfg.chaveTag });
    }

    const dadosAtuais = await dadosDoImovelDeInteresse(lead, perguntas, dadosIniciais(lead, perguntas));
    const faltandoAntes = perguntas.filter(p => p.obrigatoria && !dadosAtuais[p.chave]).map(p => p.chave);
    const nomesTags = new Map((await db.select({ id: tags.id, nome: tags.nome }).from(tags)
      .where(eq(tags.imobiliariaId, lead.imobiliariaId))).map(t => [t.id, t.nome]));
    const etiquetasPermitidas = (cfg.etiquetas || []).filter(e => nomesTags.has(e.tagId))
      .map(e => ({ id: e.tagId, nome: nomesTags.get(e.tagId)!, quando: e.quando }));
    const criterios = cfg.criterios || [];
    // marcadores internos (_tentou_..., _completo_turno) não são dado do cliente
    const dadosCliente = Object.fromEntries(Object.entries(dadosAtuais).filter(([k]) => !k.startsWith('_')));
    const sugeridos = cfg.consultarImoveis
      ? await imoveisParaIa(lead.imobiliariaId, { ...dadosCliente, _texto: entrada || '' }, lead.imovelInteresseId, cfg.informarPreco)
      : [];
    const payload = {
      evento,
      imobiliariaId: lead.imobiliariaId,
      leadId,
      imobiliariaNome: conf.nomeImob,
      agente: {
        nome: cfg.nomeAgente, tom: cfg.tom, apresentacao: cfg.apresentacao, instrucoesExtras: cfg.instrucoesExtras,
        mensagemPassagem: cfg.mensagemPassagem, modelo: cfg.modelo,
        despedidaExplica: cfg.despedidaModo !== 'fixa',
        consultaImoveis: cfg.consultarImoveis, informarPreco: cfg.informarPreco,
      },
      // imagens ficam no CRM: a IA só decide "mandar fotos do IM2", quem envia é o CRM
      imoveis: sugeridos.map(({ imagens, id: _id, ...resto }) => ({ ...resto, qtdFotos: imagens.length })),
      perguntas: perguntasDoCaso(perguntas, dadosCliente, lead.finalidade),
      etiquetas: etiquetasPermitidas,
      criterios: criterios.map(c => ({
        chave: c.chave, descricao: c.descricao,
        tentativa: c.tentativa || null, tentativaFeita: dadosAtuais[TENTOU + c.chave] === 'sim',
      })),
      // marcadores internos (_tentou_...) não vão como "o que já sabemos" do cliente
      dados: dadosCliente,
      faltando: faltandoAntes,
      // Nome da campanha NÃO vai pra IA: é código interno ("[NC 02][CENARIUM][FORM]") e ela poderia
      // repetir isso pro cliente. O que interessa (o imóvel) já foi resolvido na captação.
      lead: { nome: lead.nome, canal: lead.canal, imovel: lead.imovelTitulo, regiaoTelefone: regiaoPorDDD(lead.telefone) },
      historico,
      openaiKey,
    };

    // Jeito humano: lê a mensagem (visto azul), respira, e fica "digitando…" enquanto a IA pensa.
    // Número híbrido: com o WAHA no ar a presença sai por ele; só com a oficial, sai o "visto + digitando" dela.
    let alvo: { sessao: NonNullable<Awaited<ReturnType<typeof sessaoCentral>>>; chatId: string | null } | null = null;
    if (cfg.simularDigitacao) {
      const sessao = await sessaoCentral(lead);
      if (sessao) {
        const rc = sessao.status === 'conectada' ? await resolverChatId(sessao.sessionName, lead.telefone) : null;
        if (rc?.existe !== false) {
          alvo = { sessao, chatId: rc?.chatId ?? null };
          if (evento === 'mensagem') {
            await presencaNoNumero(sessao, leadId, alvo.chatId, 'visto');
            await dormir(1200);
          }
          await presencaNoNumero(sessao, leadId, alvo.chatId, 'digitando');
        }
      }
    }
    const inicioDigitacao = Date.now();

    let r: RespostaN8n;
    try {
      r = await chamarN8n(payload);
    } catch (e1) {
      await dormir(4000);
      try {
        r = await chamarN8n(payload);
      } catch (e2) {
        if (alvo) { await presencaNoNumero(alvo.sessao, leadId, alvo.chatId, 'parar'); await presencaNoNumero(alvo.sessao, leadId, alvo.chatId, 'offline'); }
        await registrarTurno(lead, { entrada, resposta: null, campos: {}, decisao: 'passar:erro', erro: (e2 as Error).message, chaveSaas: !openaiKey });
        await passarParaRoleta(io, leadId, 'erro');
        return;
      }
    }

    // Só aceita campos que existem na configuração (a IA não inventa chave nova).
    const novos: Record<string, string> = {};
    for (const p of perguntas) {
      const v = r.campos?.[p.chave];
      if (typeof v === 'string' && v.trim()) novos[p.chave] = v.trim().slice(0, 200);
    }
    const dados = { ...dadosAtuais, ...novos };
    const critTentado = r.tentativaResgate ? criterios.find(c => c.chave === r.tentativaResgate && c.tentativa) : undefined;
    if (critTentado) dados[TENTOU + critTentado.chave] = 'sim';
    const turnos = lead.iaTurnos + 1;
    const faltando = perguntas.filter(p => p.obrigatoria && !dados[p.chave]);
    // Obrigatórias completas: anota em que turno isso aconteceu (pra não deixar a IA conversando sem fim).
    if (!faltando.length && !dados[COMPLETO]) dados[COMPLETO] = String(turnos);
    const turnosDesdeCompleto = dados[COMPLETO] ? turnos - Number(dados[COMPLETO]) : -1;
    const clienteEncerrou = CLIENTE_ENCERROU.test(entrada || '') && !/\?/.test(entrada || '');

    // Etiquetas: só as que a imobiliária liberou pra IA; desqualificação: só um critério cadastrado.
    const crit = r.desqualificacao ? criterios.find(c => c.chave === r.desqualificacao) : undefined;
    const tagsAplicar = (r.etiquetas || []).filter(id => etiquetasPermitidas.some(e => e.id === id));
    if (crit?.tagId) tagsAplicar.push(crit.tagId);
    await aplicarEtiquetas(io, lead, tagsAplicar);

    let decisao = 'continuar';
    if (r.pediuHumano) decisao = 'passar:pediu_humano';
    else if (crit?.acao === 'descartar') decisao = 'descartar:' + crit.chave;
    else if (r.semInteresse) decisao = 'passar:sem_interesse';
    // Completo = obrigatórias preenchidas E a IA encerrou (não deixou pergunta no ar pro cliente).
    else if (faltando.length === 0 && r.encerrar) decisao = 'passar:completo';
    // Rede de segurança: com as obrigatórias completas, a IA não segura o cliente. Encerra se ele
    // sinalizou que terminou, ou depois de no máximo 2 respostas a mais (fotos, uma desejável...).
    else if (faltando.length === 0 && (clienteEncerrou || turnosDesdeCompleto >= 2)) decisao = 'passar:completo';
    else if (turnos >= cfg.maxMensagens) decisao = 'passar:limite';
    // Encerramento forçado pelo CRM com a IA ainda fazendo pergunta: troca a pergunta pela mensagem
    // de passagem (senão o cliente responde e ninguém da IA lê mais).
    const encerramentoForcado = decisao === 'passar:completo' && !r.encerrar && /\?/.test(r.resposta || '');

    // O texto que o cliente lê é escolhido pela DECISÃO que o CRM executa, nunca solto: a IA já
    // escreveu "vou passar pro corretor" e marcou desqualificação ao mesmo tempo. Descartou →
    // despedida de descarte (a da IA, escrita só pra esse caso, ou o texto fixo); senão → resposta normal.
    const resposta = decisao.startsWith('descartar:')
      ? ((cfg.despedidaModo === 'ia' && r.textoDesqualificacao?.trim()) || cfg.mensagemDesqualificado).trim()
      : (r.resposta || '').trim();
    let erroEnvio: string | null = null;
    const baloes = resposta ? baloesDe(resposta) : [];

    // Catálogo: a IA escolheu um dos imóveis que o CRM passou (código IM1..IM3); o CRM manda as fotos
    // e anota o imóvel de interesse no lead pro corretor.
    // Trava: a IA às vezes OFERECE as fotos ("quer ver?") e já marca pra enviar. Foto só sai se o
    // cliente pediu, ou disse que sim depois de a IA ter oferecido.
    const ultimaDaIa = [...historico].reverse().find(m => m.papel === 'atendente')?.texto || '';
    const clientePediuFoto = /foto|imagem|image|v[eê]r|mostr|manda|envi/i.test(entrada || '')
      || (/foto/i.test(ultimaDaIa) && /\b(sim|quero|pode|claro|manda|bora|opa|ok|beleza|gostei|show)\b/i.test(entrada || ''));
    const imFotos = r.enviarFotos && clientePediuFoto && !decisao.startsWith('descartar')
      ? sugeridos.find(s => s.codigo === r.enviarFotos) : undefined;
    const imInteresse = imFotos ?? (r.imovelInteresse ? sugeridos.find(s => s.codigo === r.imovelInteresse) : undefined);
    // Com fotos, a ordem é: 1º balão ("te mando as fotos 👇") → fotos → ficha → o resto (a próxima pergunta).
    const baloesAntes = encerramentoForcado ? (imFotos ? baloes.slice(0, 1) : []) : imFotos ? baloes.slice(0, 1) : baloes;
    const baloesDepois = imFotos && !encerramentoForcado ? baloes.slice(1) : [];

    try {
      for (let i = 0; i < baloesAntes.length; i++) {
        if (alvo) {
          if (i > 0) await presencaNoNumero(alvo.sessao, leadId, alvo.chatId, 'digitando');
          // no 1º balão desconta o tempo que a IA já passou pensando (o "digitando…" já estava na tela)
          const jaDigitou = i === 0 ? Date.now() - inicioDigitacao : 0;
          await dormir(Math.max(0, tempoDigitacao(baloes[i]) - jaDigitou));
          await presencaNoNumero(alvo.sessao, leadId, alvo.chatId, 'parar');
        }
        // O cliente mandou mais coisa enquanto a IA pensava/digitava: como uma pessoa faria, joga
        // fora a resposta e refaz considerando tudo (no máx. 2x, pra quem não para de digitar).
        if (i === 0 && evento === 'mensagem' && refeitas < 2 && (await mensagensDoCliente(leadId)) > lidasDoCliente) {
          refazer = true;
          break;
        }
        await enviarPelaIa(io, lead, baloes[i], alvo?.chatId ?? undefined);
        if (i < baloesAntes.length - 1) await dormir(700);
      }
    } catch (e) {
      erroEnvio = (e as Error).message;
      if (erroEnvio === 'NUMERO_INEXISTENTE') decisao = 'passar:numero_invalido';
    }
    if (refazer) {
      // nada foi enviado nem decidido: só registra o consumo e refaz (no finally)
      await registrarTurno(lead, { entrada, resposta: null, campos: {}, decisao: 'refeito', tokens: r.tokens || 0, chaveSaas: !openaiKey });
      return;
    }
    if (alvo && !baloes.length) await presencaNoNumero(alvo.sessao, leadId, alvo.chatId, 'parar');

    let fotosEnviadas = 0;
    if (imFotos && !erroEnvio) {
      const fotos = imFotos.imagens.slice(0, Math.max(1, cfg.fotosPorImovel));
      for (let i = 0; i < fotos.length; i++) {
        await dormir(i === 0 ? 1200 : 900);
        try { await enviarFotoPelaIa(io, lead, fotos[i], '📷 ' + (i + 1) + '/' + fotos.length, alvo?.chatId ?? undefined); fotosEnviadas++; } catch (e) {
          console.error('agente IA foto:', (e as Error).message);
        }
      }
      if (fotosEnviadas) {
        await dormir(1500);
        await enviarPelaIa(io, lead, fichaImovel(imFotos), alvo?.chatId ?? undefined).catch(e => console.error('agente IA ficha:', (e as Error).message));
      }
    }
    // Resto da resposta (normalmente a próxima pergunta) só depois das fotos e da ficha.
    for (const b of (imFotos && !erroEnvio ? baloesDepois : [])) {
      if (alvo) {
        await presencaNoNumero(alvo.sessao, leadId, alvo.chatId, 'digitando');
        await dormir(tempoDigitacao(b));
        await presencaNoNumero(alvo.sessao, leadId, alvo.chatId, 'parar');
      }
      await enviarPelaIa(io, lead, b, alvo?.chatId ?? undefined).catch(e => console.error('agente IA balão:', (e as Error).message));
    }
    if (imInteresse && lead.imovelInteresseId !== imInteresse.id) {
      const [atualizado] = await db.update(leads).set({ imovelInteresseId: imInteresse.id, imovelTitulo: imInteresse.titulo, imovelSub: imInteresse.local || null })
        .where(eq(leads.id, leadId)).returning();
      if (atualizado) io.to('imobiliaria:' + atualizado.imobiliariaId).emit('lead:updated', atualizado);
    }

    if ((decisao === 'passar:limite' || encerramentoForcado) && cfg.mensagemPassagem && !erroEnvio) {
      await enviarPelaIa(io, lead, cfg.mensagemPassagem, alvo?.chatId ?? undefined).catch(() => {});
    }
    if (alvo) await presencaNoNumero(alvo.sessao, leadId, alvo.chatId, 'offline');

    await db.update(leads).set({
      iaDados: dados, iaTurnos: turnos, iaUltimaAtividadeEm: new Date(),
      // só limpa o "aguardando" se não chegou mensagem nova do cliente enquanto a IA pensava
      iaAguardandoDesde: sql`case when ${leads.iaAguardandoDesde} <= ${inicio.toISOString()}::timestamptz then null else ${leads.iaAguardandoDesde} end`,
    }).where(eq(leads.id, leadId));

    const camposLog = { ...novos };
    if (tagsAplicar.length) camposLog['etiquetas'] = tagsAplicar.map(id => nomesTags.get(id) || '?').join(', ');
    if (crit) camposLog['desqualificação'] = crit.descricao;
    if (fotosEnviadas) camposLog['fotos enviadas'] = fotosEnviadas + ' de ' + imFotos!.titulo;
    else if (imInteresse) camposLog['imóvel de interesse'] = imInteresse.titulo;
    await registrarTurno(lead, { entrada, resposta: resposta || null, campos: camposLog, decisao, erro: erroEnvio, tokens: r.tokens || 0, chaveSaas: !openaiKey });

    const [atual] = await db.select().from(leads).where(eq(leads.id, leadId)).limit(1);
    if (atual) io.to('imobiliaria:' + atual.imobiliariaId).emit('lead:updated', atual);
    if (decisao.startsWith('passar:')) await passarParaRoleta(io, leadId, decisao.slice(7));
    else if (decisao.startsWith('descartar:') && crit) await descartarPelaIa(io, leadId, crit, perguntas);
  } catch (e) {
    console.error('agente IA:', (e as Error).message);
  } finally {
    processando.delete(leadId);
    if (refazer) {
      repetir.delete(leadId);
      setTimeout(() => void rodarTurno(io, leadId, 'mensagem', refeitas + 1), 1200);
    } else if (repetir.delete(leadId)) agendar(io, leadId, 1500);
  }
}

/** Varredura de minuto: nenhum lead fica preso na IA, e nenhum turno se perde num restart. */
export async function varrerIa(io: SocketServer) {
  const ativos = await db.select().from(leads).where(eq(leads.iaStatus, 'atendendo')).orderBy(asc(leads.criadoEm));
  if (!ativos.length) return;
  const confPorImob = new Map<string, Awaited<ReturnType<typeof configIa>>>();
  const agora = Date.now();
  for (const lead of ativos) {
    if (processando.has(lead.id) || timers.has(lead.id) || primeiroAgendado.has(lead.id)) continue;
    if (!confPorImob.has(lead.imobiliariaId)) confPorImob.set(lead.imobiliariaId, await configIa(lead.imobiliariaId));
    const conf = confPorImob.get(lead.imobiliariaId);
    if (!conf) { await passarParaRoleta(io, lead.id, 'ia_desligada'); continue; }

    const ultima = lead.iaUltimaAtividadeEm?.getTime() ?? lead.criadoEm.getTime();
    const min = (agora - ultima) / 60000;
    if (lead.iaAguardandoDesde && agora - lead.iaAguardandoDesde.getTime() > 60000) {
      void rodarTurno(io, lead.id, 'mensagem');
    } else if (lead.iaTurnos === 0 && lead.iaMsgsCliente === 0 && min > 2) {
      void rodarTurno(io, lead.id, 'primeiro_contato');
    } else if (lead.iaMsgsCliente === 0 && lead.iaTurnos > 0 && min > conf.cfg.minutosSemResposta) {
      await passarParaRoleta(io, lead.id, 'sem_resposta');
    } else if (lead.iaMsgsCliente > 0 && !lead.iaAguardandoDesde && min > conf.cfg.minutosAbandono) {
      await passarParaRoleta(io, lead.id, 'abandono');
    }
  }
}
