import { COLS, type ColId, type Lead } from './data';

export interface RemoteColuna { id: string; titulo: string; ordem: number; cor: string | null; slug: string | null }
export interface RemotePerfil { id: string; nome: string; email: string; role: string; telefone: string | null; bloqueado: boolean; emPlantao: boolean; removidoEm?: string | null; roletaIds?: string[] }
/** Quem ainda trabalha na imobiliária: desligado (bloqueado ou removido) some das listas de escolha. */
export const perfilAtivo = (p: RemotePerfil) => !p.bloqueado && !p.removidoEm;
/** Nome pra lista: o dono aparece como "Nome (Dono)" — o valor continua sendo o nome. */
export const nomeNaLista = (p: RemotePerfil) => (p.role === 'dono' ? p.nome + ' (Dono)' : p.nome);
export interface RemoteLead {
  id: string;
  nome: string;
  telefone: string;
  email: string | null;
  fotoUrl: string | null;
  imovelInteresseId: string | null;
  imovelTitulo: string | null;
  imovelSub: string | null;
  valor: string | null;
  canal: string;
  colunaId: string | null;
  corretorId: string | null;
  campanha: string | null;
  segundoCadastro: boolean;
  cadencia: string | null;
  motivoDescarte: string | null;
  rendaDeclarada: string | null;
  entrouNaColunaEm: string;
  criadoEm: string;
  tagIds?: string[];
  iaStatus?: string | null;
  iaResumo?: string | null;
  sessaoWhatsappId?: string | null;
  temperatura?: 'quente' | 'morno' | 'frio' | null;
  favorito?: boolean;
  telefoneAlternativo?: string | null;
  bairroInteresse?: string | null;
  tipoImovelInteresse?: string | null;
  referencia?: string | null;
  linkDrive?: string | null;
  saldoFgts?: string | null;
  valorEntrada?: string | null;
  dataNascimento?: string | null;
  cadenciaChamada?: number;
  dataUltimaChamada?: string | null;
  proximoContatoEm?: string | null;
  dataVisita?: string | null;
  tipoVisita?: string | null;
  statusVisita?: string | null;
  descartadoEm?: string | null;
  descartePendenteAprovacao?: boolean;
  vendaPendenteAprovacao?: boolean;
  dataFechamento?: string | null;
  valorVenda?: string | null;
  dataVendaInformada?: string | null;
  empreendimento?: string | null;
  torre?: string | null;
  unidade?: string | null;
  creditoAprovadoEm?: string | null;
  jaTeveCorretor?: boolean;
  tentativasContato?: number;
  dataAtribuicao?: string | null;
}

const num = (v: string | null | undefined) => (v == null || v === '' ? null : Number(v));

const CANAL_LABEL: Record<string, string> = { Indicacao: 'Indicação' };

/** slug da coluna de sistema, ou o próprio id quando a coluna é customizada (sem slug). */
export function colToSemantico(colunaId: string | null, colunas: RemoteColuna[]): string {
  const c = colunas.find(x => x.id === colunaId);
  return c?.slug ?? colunaId ?? 'novo';
}

/** id real da coluna que tem esse slug de sistema (pra ações tipo "descartar" = mandar pra 'rebatida'). */
export function slugToColunaId(slug: ColId, colunas: RemoteColuna[]): string | undefined {
  return colunas.find(c => c.slug === slug)?.id
    ?? colunas.find(c => c.titulo === COLS.find(x => x.id === slug)?.title)?.id;
}

export function mapRemoteLead(r: RemoteLead, colunas: RemoteColuna[], perfis: RemotePerfil[]): Lead {
  const dias = Math.max(0, Math.floor((Date.now() - new Date(r.entrouNaColunaEm).getTime()) / 86400000));
  return {
    id: r.id,
    nome: r.nome,
    tel: r.telefone,
    email: r.email ?? '',
    foto: r.fotoUrl ?? '',
    imovelInteresseId: r.imovelInteresseId ?? '',
    imovel: r.imovelTitulo ?? '',
    imovelSub: r.imovelSub ?? '',
    valor: r.valor ? Number(r.valor) : 0,
    canal: CANAL_LABEL[r.canal] ?? r.canal,
    colunaId: r.colunaId ?? '',
    col: colToSemantico(r.colunaId, colunas),
    dias,
    segundo: r.segundoCadastro,
    cadencia: r.cadencia ?? '',
    corretor: perfis.find(p => p.id === r.corretorId)?.nome ?? '',
    campanha: r.campanha ?? '',
    motivo: r.motivoDescarte ?? '',
    renda: r.rendaDeclarada ? Number(r.rendaDeclarada) : 0,
    entrouNaColunaEm: r.entrouNaColunaEm,
    criadoEm: r.criadoEm,
    tags: r.tagIds ?? [],
    iaStatus: r.iaStatus ?? '',
    iaResumo: r.iaResumo ?? '',
    sessaoWhatsappId: r.sessaoWhatsappId ?? null,
    corretorId: r.corretorId,
    temperatura: r.temperatura ?? null,
    favorito: !!r.favorito,
    telefoneAlternativo: r.telefoneAlternativo ?? null,
    bairroInteresse: r.bairroInteresse ?? null,
    tipoImovelInteresse: r.tipoImovelInteresse ?? null,
    referencia: r.referencia ?? null,
    linkDrive: r.linkDrive ?? null,
    saldoFgts: num(r.saldoFgts),
    valorEntrada: num(r.valorEntrada),
    dataNascimento: r.dataNascimento ?? null,
    cadenciaChamada: r.cadenciaChamada ?? 0,
    dataUltimaChamada: r.dataUltimaChamada ?? null,
    proximoContatoEm: r.proximoContatoEm ?? null,
    dataVisita: r.dataVisita ?? null,
    tipoVisita: r.tipoVisita ?? null,
    statusVisita: r.statusVisita ?? null,
    descartadoEm: r.descartadoEm ?? null,
    descartePendente: !!r.descartePendenteAprovacao,
    vendaPendente: !!r.vendaPendenteAprovacao,
    dataFechamento: r.dataFechamento ?? null,
    valorVenda: num(r.valorVenda),
    dataVendaInformada: r.dataVendaInformada ?? null,
    empreendimento: r.empreendimento ?? null,
    torre: r.torre ?? null,
    unidade: r.unidade ?? null,
    creditoAprovadoEm: r.creditoAprovadoEm ?? null,
    jaTeveCorretor: !!r.jaTeveCorretor,
    tentativasContato: r.tentativasContato ?? 0,
    dataAtribuicao: r.dataAtribuicao ?? null,
  };
}

/** v1: card descartado, com descarte esperando aprovação ou com venda esperando aprovação não
 *  aparece no Kanban nem na Agenda (some da tela do corretor até a gestão decidir). */
export function foraDoKanban(l: { descartadoEm?: string | null; descartePendente?: boolean; vendaPendente?: boolean }) {
  return !!l.descartadoEm || !!l.descartePendente || !!l.vendaPendente;
}
