import { pgTable, uuid, text, boolean, integer, numeric, timestamp, date, pgEnum, jsonb, index, uniqueIndex, primaryKey } from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';

export const roleEnum = pgEnum('role', ['dono', 'gerente', 'corretor']);
// Situação da imobiliária no SaaS. 'bloqueada' = sem acesso ao CRM (manual ou por inadimplência).
export const imobiliariaStatusEnum = pgEnum('imobiliaria_status', ['ativa', 'bloqueada']);
export const bloqueioMotivoEnum = pgEnum('bloqueio_motivo', ['manual', 'inadimplencia']);
export const pagamentoMetodoEnum = pgEnum('pagamento_metodo', ['pix', 'boleto', 'cartao', 'transferencia', 'dinheiro', 'outro']);
export const modoWhatsappEnum = pgEnum('modo_whatsapp', ['central', 'corretor']);
export const sessaoEscopoEnum = pgEnum('sessao_escopo', ['central', 'corretor']);
export const sessaoStatusEnum = pgEnum('sessao_status', ['desconectada', 'conectando', 'conectada']);
export const canalEnum = pgEnum('canal', ['WhatsApp', 'Instagram', 'Facebook', 'Indicacao', 'Manual', 'Site']);
export const direcaoEnum = pgEnum('direcao', ['in', 'out']);
export const mensagemCanalEnum = pgEnum('mensagem_canal', ['corretor', 'followup', 'ia']);
// null = a IA nunca tocou nesse lead. 'transferido' = a IA terminou e mandou pra roleta.
// 'pausado' = um humano assumiu no meio.
export const iaStatusEnum = pgEnum('ia_status', ['atendendo', 'transferido', 'pausado']);
export const aoEsgotarEnum = pgEnum('ao_esgotar', ['nada', 'descartar', 'mover']);
export const execucaoStatusEnum = pgEnum('execucao_status', ['ativa', 'pausada', 'encerrada']);
export const roletaFinalidadeEnum = pgEnum('roleta_finalidade', ['venda', 'locacao', 'ambos']);
export const leadFinalidadeEnum = pgEnum('lead_finalidade', ['venda', 'locacao']);

/** Janela de atendimento de um dia da semana (minutos desde a meia-noite, fuso São Paulo).
 *  Índice 0 = domingo … 6 = sábado. Controla quando o corretor pode ficar "No Plantão". */
export interface DiaAtendimento { ativo: boolean; abreMin: number; fechaMin: number }

export const HORARIO_ATENDIMENTO_PADRAO: DiaAtendimento[] = [
  { ativo: false, abreMin: 8 * 60, fechaMin: 18 * 60 },       // Dom
  { ativo: true, abreMin: 8 * 60, fechaMin: 18 * 60 + 20 },   // Seg
  { ativo: true, abreMin: 8 * 60, fechaMin: 18 * 60 + 20 },   // Ter
  { ativo: true, abreMin: 8 * 60, fechaMin: 18 * 60 + 20 },   // Qua
  { ativo: true, abreMin: 8 * 60, fechaMin: 19 * 60 + 20 },   // Qui
  { ativo: true, abreMin: 8 * 60, fechaMin: 18 * 60 + 20 },   // Sex
  { ativo: true, abreMin: 8 * 60, fechaMin: 15 * 60 + 20 },   // Sáb
];

export const imobiliarias = pgTable('imobiliarias', {
  id: uuid('id').primaryKey().defaultRandom(),
  nome: text('nome').notNull(),
  // Configurável pelo Dono/Gerente no painel — antes era hardcoded em lib/schedule.
  horarioAtendimento: jsonb('horario_atendimento').$type<DiaAtendimento[]>().notNull().default(HORARIO_ATENDIMENTO_PADRAO),
  // 'corretor' = cada corretor usa o próprio WhatsApp (padrão atual);
  // 'central'  = um número da imobiliária, todo mundo atende pelo CRM, dono/gerente veem tudo.
  modoWhatsapp: modoWhatsappEnum('modo_whatsapp').notNull().default('corretor'),
  // "Modo direto por WhatsApp" (só faz sentido junto com modoWhatsapp='central'): ao atribuir
  // um lead pela roleta, (1) manda os dados dele por WhatsApp (mesmo número central) pro
  // celular PESSOAL do corretor — ele assume o atendimento pelo próprio número, fora do CRM —
  // (2) a roleta IGNORA se o corretor está "em plantão" (todo membro não bloqueado é candidato,
  // a qualquer hora) e (3) o front pula o popup de Aceitar/Recusar (a atribuição é definitiva).
  notificarCorretorWhatsapp: boolean('notificar_corretor_whatsapp').notNull().default(false),
  // Liberado pelo dono do SaaS (painel Plataforma). Sem isso a imobiliária nem vê o Agente de IA.
  iaLiberada: boolean('ia_liberada').notNull().default(false),
  // true = a IA roda na chave OpenAI do SaaS; false = a imobiliária precisa cadastrar a própria.
  iaUsaChaveSaas: boolean('ia_usa_chave_saas').notNull().default(true),
  // Assistente de voz (Gemini Live) dentro do CRM: liberado pela plataforma, com cota de minutos
  // por mês; nome e voz a imobiliária escolhe.
  assistenteLiberado: boolean('assistente_liberado').notNull().default(false),
  assistenteMinutosMes: integer('assistente_minutos_mes').notNull().default(60),
  assistenteNome: text('assistente_nome').notNull().default('Assistente'),
  assistenteVoz: text('assistente_voz').notNull().default('Charon'),

  // --- Gestão da assinatura (painel Dono do SaaS) ---
  status: imobiliariaStatusEnum('status').notNull().default('ativa'),
  bloqueioMotivo: bloqueioMotivoEnum('bloqueio_motivo'),
  plano: text('plano').notNull().default('Padrão'),
  mensalidade: numeric('mensalidade', { precision: 12, scale: 2 }).notNull().default('0'),
  // Teto de corretores (perfil 'corretor'). 0 = ilimitado.
  limiteCorretores: integer('limite_corretores').notNull().default(0),
  // Data do próximo vencimento da mensalidade (YYYY-MM-DD). null = sem cobrança configurada.
  proximoVencimento: date('proximo_vencimento', { mode: 'string' }),
  // Dias de tolerância após o vencimento antes do bloqueio automático.
  diasCarencia: integer('dias_carencia').notNull().default(5),
  // Quantas rebatidas cada corretor pode puxar do bolsão por dia (0 = ilimitado).
  limiteRebatidasDia: integer('limite_rebatidas_dia').notNull().default(5),
  observacoes: text('observacoes'),
  // Dados cadastrais que a própria imobiliária edita em Ajustes → Imobiliária.
  cnpj: text('cnpj'),
  endereco: text('endereco'),
  // Token do webhook de captação de site/landing page (formulário Lovable etc.) — por imobiliária.
  capturaToken: text('captura_token').unique(),

  criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
});

/** Administrador da plataforma (dono do SaaS) — NÃO pertence a nenhuma imobiliária.
 *  Acessa só o painel /plataforma. Bootstrap via env PLATFORM_ADMIN_EMAIL/PASSWORD. */
export const adminsPlataforma = pgTable('admins_plataforma', {
  id: uuid('id').primaryKey().defaultRandom(),
  nome: text('nome').notNull(),
  email: text('email').notNull().unique(),
  senhaHash: text('senha_hash').notNull(),
  criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
});

/** Pagamento de mensalidade registrado manualmente pelo dono do SaaS.
 *  Registrar um pagamento empurra imobiliarias.proximoVencimento em +1 mês e reativa
 *  a imobiliária se ela estava bloqueada por inadimplência. */
export const pagamentos = pgTable('pagamentos', {
  id: uuid('id').primaryKey().defaultRandom(),
  imobiliariaId: uuid('imobiliaria_id').notNull().references(() => imobiliarias.id, { onDelete: 'cascade' }),
  valor: numeric('valor', { precision: 12, scale: 2 }).notNull(),
  // Mês de competência a que o pagamento se refere (YYYY-MM).
  competencia: text('competencia').notNull(),
  pagoEm: date('pago_em', { mode: 'string' }).notNull(),
  metodo: pagamentoMetodoEnum('metodo').notNull().default('pix'),
  observacao: text('observacao'),
  registradoPor: uuid('registrado_por').references(() => adminsPlataforma.id, { onDelete: 'set null' }),
  criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
}, table => ({
  imobiliariaIdx: index('pagamentos_imobiliaria_id_idx').on(table.imobiliariaId),
}));

/** Conexão do Facebook Lead Ads de uma imobiliária — o workflow n8n dinâmico lê a lista de
 *  conexões ativas de TODAS as imobiliárias e busca leads de cada uma com o token dela.
 *  O access_token é cifrado em repouso (AES-256-GCM, ver lib/crypto). */
export const integracoesFacebook = pgTable('integracoes_facebook', {
  id: uuid('id').primaryKey().defaultRandom(),
  imobiliariaId: uuid('imobiliaria_id').notNull().references(() => imobiliarias.id, { onDelete: 'cascade' }),
  nomeConta: text('nome_conta').notNull(),
  pageId: text('page_id').notNull(),
  // null = todos os formulários da página (conexão feita pelo botão 'Conectar com Facebook').
  formId: text('form_id'),
  // 'manual' = token colado à mão (automação n8n varre o formulário) | 'oauth' = login com Facebook (webhook em tempo real).
  origem: text('origem').notNull().default('manual'),
  tokenCifrado: text('token_cifrado').notNull(),
  tokenIv: text('token_iv').notNull(),
  tokenTag: text('token_tag').notNull(),
  ativo: boolean('ativo').notNull().default(true),
  ultimaSyncEm: timestamp('ultima_sync_em', { withTimezone: true }),
  ultimoErro: text('ultimo_erro'),
  criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
}, table => ({
  imobiliariaIdx: index('integracoes_facebook_imobiliaria_id_idx').on(table.imobiliariaId),
}));

export const perfis = pgTable('perfis', {
  id: uuid('id').primaryKey().defaultRandom(),
  imobiliariaId: uuid('imobiliaria_id').notNull().references(() => imobiliarias.id, { onDelete: 'cascade' }),
  nome: text('nome').notNull(),
  email: text('email').notNull().unique(),
  senhaHash: text('senha_hash').notNull(),
  role: roleEnum('role').notNull().default('corretor'),
  telefone: text('telefone'),
  bloqueado: boolean('bloqueado').notNull().default(false),
  emPlantao: boolean('em_plantao').notNull().default(false),
  // --- Regras herdadas do CRM OKA (v1) ---
  okaId: uuid('oka_id'),
  avatarUrl: text('avatar_url'),
  emAlmoco: boolean('em_almoco').notNull().default(false),
  advertenciasSemana: integer('advertencias_semana').notNull().default(0),
  advertenciaSemanaInicio: date('advertencia_semana_inicio', { mode: 'string' }),
  ultimoLeadRecebidoEm: timestamp('ultimo_lead_recebido_em', { withTimezone: true }),
  // "Remover da equipe" (só dono): perde o acesso e some das listas, mas o nome fica no histórico.
  removidoEm: timestamp('removido_em', { withTimezone: true }),
  criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
}, table => ({
  imobiliariaIdx: index('perfis_imobiliaria_id_idx').on(table.imobiliariaId),
}));

export const colunasKanban = pgTable('colunas_kanban', {
  id: uuid('id').primaryKey().defaultRandom(),
  imobiliariaId: uuid('imobiliaria_id').notNull().references(() => imobiliarias.id, { onDelete: 'cascade' }),
  titulo: text('titulo').notNull(),
  ordem: integer('ordem').notNull().default(0),
  cor: text('cor'),
  // Colunas "de sistema" têm slug (novo, credito, venda, rebatida...) — outras telas (Dashboard,
  // Análise de Crédito, Bolsão, roleta) dependem dele. Colunas criadas pelo usuário têm slug null.
  slug: text('slug'),
  criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
}, table => ({
  imobiliariaIdx: index('colunas_kanban_imobiliaria_id_idx').on(table.imobiliariaId),
}));

export const leads = pgTable('leads', {
  id: uuid('id').primaryKey().defaultRandom(),
  imobiliariaId: uuid('imobiliaria_id').notNull().references(() => imobiliarias.id, { onDelete: 'cascade' }),
  nome: text('nome').notNull(),
  telefone: text('telefone').notNull(),
  email: text('email'),
  // Foto de perfil do WhatsApp (URL) — preenchida pela automação de captação quando disponível.
  fotoUrl: text('foto_url'),
  // Imóvel que o lead escolheu no site / na campanha (quando veio de um imóvel específico).
  imovelInteresseId: uuid('imovel_interesse_id'),
  imovelTitulo: text('imovel_titulo'),
  imovelSub: text('imovel_sub'),
  valor: numeric('valor', { precision: 14, scale: 2 }).default('0'),
  canal: canalEnum('canal').notNull().default('Manual'),
  colunaId: uuid('coluna_id').references(() => colunasKanban.id, { onDelete: 'set null' }),
  corretorId: uuid('corretor_id').references(() => perfis.id, { onDelete: 'set null' }),
  campanha: text('campanha'),
  // ID do lead no Facebook (leadgen_id) — evita duplicar quando a Meta reenvia o mesmo aviso.
  fbLeadId: text('fb_lead_id'),
  segundoCadastro: boolean('segundo_cadastro').notNull().default(false),
  // Compra (venda) ou aluguel (locacao) — do formulário do site/facebook ou do número de WhatsApp.
  // Usado pra rotear o lead pra roleta certa.
  finalidade: leadFinalidadeEnum('finalidade'),
  // Por qual número de WhatsApp o lead entrou (quando veio pelo WhatsApp).
  sessaoWhatsappId: uuid('sessao_whatsapp_id'),
  // Cadência de chamada ("Chamada 1", "Chamada 2"…). O corretor mexe na mão OU a régua de
  // follow-up atualiza a cada passo enviado.
  cadencia: text('cadencia'),
  motivoDescarte: text('motivo_descarte'),
  rendaDeclarada: numeric('renda_declarada', { precision: 14, scale: 2 }),
  entrouNaColunaEm: timestamp('entrou_na_coluna_em', { withTimezone: true }).notNull().defaultNow(),
  // --- Agente de IA (SDR) ---
  iaStatus: iaStatusEnum('ia_status'),
  // Respostas que a IA já coletou, por chave de pergunta ({ finalidade: 'Comprar', bairro: 'Centro' }).
  iaDados: jsonb('ia_dados').$type<Record<string, string>>().notNull().default({}),
  iaResumo: text('ia_resumo'),
  iaTurnos: integer('ia_turnos').notNull().default(0),
  iaMsgsCliente: integer('ia_msgs_cliente').notNull().default(0),
  iaUltimaAtividadeEm: timestamp('ia_ultima_atividade_em', { withTimezone: true }),
  // Mensagem do cliente ainda sem resposta da IA (garante o turno mesmo se o servidor reiniciar).
  iaAguardandoDesde: timestamp('ia_aguardando_desde', { withTimezone: true }),
  // --- Importação por planilha ---
  // Lote de onde o lead veio. Enquanto `importacaoPendente`, o lead fica guardado: fora do
  // Kanban, da roleta automática e do "distribuir pendentes" — só o dono/gerente distribui.
  loteImportacaoId: uuid('lote_importacao_id').references(() => lotesImportacao.id, { onDelete: 'set null' }),
  importacaoPendente: boolean('importacao_pendente').notNull().default(false),
  // --- Regras herdadas do CRM OKA (v1) ---
  // id do lead no CRM OKA (Supabase) — deixa a importação idempotente e rastreável.
  okaId: uuid('oka_id'),
  temperatura: text('temperatura'), // 'quente' | 'morno' | 'frio'
  telefoneAlternativo: text('telefone_alternativo'),
  bairroInteresse: text('bairro_interesse'),
  tipoImovelInteresse: text('tipo_imovel_interesse'),
  referencia: text('referencia'),
  linkDrive: text('link_drive'),
  saldoFgts: numeric('saldo_fgts', { precision: 14, scale: 2 }),
  valorEntrada: numeric('valor_entrada', { precision: 14, scale: 2 }),
  dataNascimento: date('data_nascimento', { mode: 'string' }),
  // ano em que o lembrete de aniversário já foi mandado (não repete no mesmo ano)
  lembreteAniversarioAno: integer('lembrete_aniversario_ano'),
  lembretePosVendaEm: timestamp('lembrete_pos_venda_em', { withTimezone: true }),
  // Cadência de chamada numérica da v1: 0 = Início … 5 = Chamada 5.
  cadenciaChamada: integer('cadencia_chamada').notNull().default(0),
  dataUltimaChamada: timestamp('data_ultima_chamada', { withTimezone: true }),
  // Próximo contato marcado (na v1: lembrete_follow_up). Todo lead com corretor tem um.
  proximoContatoEm: timestamp('proximo_contato_em', { withTimezone: true }),
  tentativasContato: integer('tentativas_contato').notNull().default(0),
  // Visita / FID / compromisso do lead
  dataVisita: timestamp('data_visita', { withTimezone: true }),
  tipoVisita: text('tipo_visita'),
  statusVisita: text('status_visita'),
  // Descarte: normal grava descartadoEm na hora; extremo fica pendente até aprovação.
  descartadoEm: timestamp('descartado_em', { withTimezone: true }),
  descartadoPor: uuid('descartado_por'),
  descartePendenteAprovacao: boolean('descarte_pendente_aprovacao').notNull().default(false),
  // Venda: só vai pra coluna VENDA depois de registrada e aprovada.
  vendaPendenteAprovacao: boolean('venda_pendente_aprovacao').notNull().default(false),
  valorVenda: numeric('valor_venda', { precision: 14, scale: 2 }),
  dataFechamento: timestamp('data_fechamento', { withTimezone: true }),
  dataVendaInformada: date('data_venda_informada', { mode: 'string' }),
  empreendimento: text('empreendimento'),
  torre: text('torre'),
  unidade: text('unidade'),
  // "Visto" da gestão na Análise de Crédito (null = alerta vermelho aceso).
  creditoAprovadoEm: timestamp('credito_aprovado_em', { withTimezone: true }),
  primeiroContatoEm: timestamp('primeiro_contato_em', { withTimezone: true }),
  dataAtribuicao: timestamp('data_atribuicao', { withTimezone: true }),
  ultimaAcaoEm: timestamp('ultima_acao_em', { withTimezone: true }),
  slaVencido: boolean('sla_vencido').notNull().default(false),
  favorito: boolean('favorito').notNull().default(false),
  conversaFixada: boolean('conversa_fixada').notNull().default(false),
  recadastroEm: timestamp('recadastro_em', { withTimezone: true }),
  recadastroOrigem: text('recadastro_origem'),
  criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
}, table => ({
  okaIdx: uniqueIndex('leads_oka_id_uq').on(table.okaId).where(sql`${table.okaId} is not null`),
  // Postgres não indexa FK automaticamente — sem isso, toda listagem de leads (a query mais
  // comum do app) fazia sequential scan na tabela inteira (ficou visível só depois que a tabela
  // passou a ter 10k+ linhas reais, nunca doeu com o seed de demonstração de 10 linhas).
  imobiliariaIdx: index('leads_imobiliaria_id_idx').on(table.imobiliariaId),
  corretorIdx: index('leads_corretor_id_idx').on(table.corretorId),
  colunaIdx: index('leads_coluna_id_idx').on(table.colunaId),
  fbLeadIdx: uniqueIndex('leads_imobiliaria_fb_lead_id_uq').on(table.imobiliariaId, table.fbLeadId),
}));

// Etiquetas coloridas por imobiliária (multi-tenant) — atribuídas a leads via lead_tags.
export const tags = pgTable('tags', {
  id: uuid('id').primaryKey().defaultRandom(),
  imobiliariaId: uuid('imobiliaria_id').notNull().references(() => imobiliarias.id, { onDelete: 'cascade' }),
  nome: text('nome').notNull(),
  cor: text('cor').notNull().default('#123C87'),
  ordem: integer('ordem').notNull().default(0),
  criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
}, table => ({
  imobiliariaIdx: index('tags_imobiliaria_id_idx').on(table.imobiliariaId),
}));

export const leadTags = pgTable('lead_tags', {
  leadId: uuid('lead_id').notNull().references(() => leads.id, { onDelete: 'cascade' }),
  tagId: uuid('tag_id').notNull().references(() => tags.id, { onDelete: 'cascade' }),
}, table => ({
  pk: primaryKey({ columns: [table.leadId, table.tagId] }),
  leadIdx: index('lead_tags_lead_id_idx').on(table.leadId),
  tagIdx: index('lead_tags_tag_id_idx').on(table.tagId),
}));

// A disponibilidade em si mora em perfis.emPlantao — esta tabela guarda só a ordem da fila.
/** Uma roleta = uma "equipe" de distribuição. A imobiliária pode ter várias, cada uma com
 *  regras de entrada (canais + finalidade + número de WhatsApp). A marcada como `padrao` pega
 *  tudo que não se encaixa em nenhuma outra. */
export const roletas = pgTable('roletas', {
  id: uuid('id').primaryKey().defaultRandom(),
  imobiliariaId: uuid('imobiliaria_id').notNull().references(() => imobiliarias.id, { onDelete: 'cascade' }),
  nome: text('nome').notNull(),
  ativa: boolean('ativa').notNull().default(true),
  ordem: integer('ordem').notNull().default(0),
  padrao: boolean('padrao').notNull().default(false),
  // [] = todos os canais. Ex: ['WhatsApp'] | ['Facebook','Instagram'] | ['Site']
  canais: jsonb('canais').$type<string[]>().notNull().default([]),
  finalidade: roletaFinalidadeEnum('finalidade').notNull().default('ambos'),
  // Se setado, essa roleta só pega leads que entraram por ESSE número de WhatsApp.
  sessaoWhatsappId: uuid('sessao_whatsapp_id').references(() => sessoesWhatsapp.id, { onDelete: 'set null' }),
  // Número central pelo qual o Agente de IA faz o PRIMEIRO CONTATO com leads de formulário
  // (Facebook/Instagram/Site) que caem nesta roleta. Sem ele: o 1º número conectado em que a IA atende.
  numeroPrimeiroContatoId: uuid('numero_primeiro_contato_id').references(() => sessoesWhatsapp.id, { onDelete: 'set null' }),
  // Fila fixa (modo "avisar corretor por WhatsApp"): quem recebeu o último lead desta roleta.
  // O próximo é quem vem depois dele na ordem (posição), dando a volta no fim da lista.
  ultimoCorretorId: uuid('ultimo_corretor_id').references(() => perfis.id, { onDelete: 'set null' }),
  criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
}, table => ({
  imobIdx: index('roletas_imobiliaria_id_idx').on(table.imobiliariaId),
}));

/** Corretores que participam de uma roleta (muitos-pra-muitos). `posicao` e `ultimaAtribuicao`
 *  são POR roleta — o mesmo corretor tem uma posição diferente em cada roleta que participa. */
export const filasAtendimento = pgTable('filas_atendimento', {
  id: uuid('id').primaryKey().defaultRandom(),
  imobiliariaId: uuid('imobiliaria_id').notNull().references(() => imobiliarias.id, { onDelete: 'cascade' }),
  roletaId: uuid('roleta_id').references(() => roletas.id, { onDelete: 'cascade' }),
  corretorId: uuid('corretor_id').notNull().references(() => perfis.id, { onDelete: 'cascade' }),
  posicao: integer('posicao').notNull().default(0),
  // Quando esse corretor recebeu o último lead DESSA roleta — o próximo vai pro que faz mais tempo.
  ultimaAtribuicao: timestamp('ultima_atribuicao', { withTimezone: true }),
}, table => ({
  membroUq: uniqueIndex('filas_roleta_corretor_uq').on(table.roletaId, table.corretorId),
}));

/** Sessão de WhatsApp (WAHA). 'central' = número único da imobiliária;
 *  'corretor' = espelho do WhatsApp de um corretor específico. */
export const sessoesWhatsapp = pgTable('sessoes_whatsapp', {
  id: uuid('id').primaryKey().defaultRandom(),
  imobiliariaId: uuid('imobiliaria_id').notNull().references(() => imobiliarias.id, { onDelete: 'cascade' }),
  escopo: sessaoEscopoEnum('escopo').notNull(),
  corretorId: uuid('corretor_id').references(() => perfis.id, { onDelete: 'cascade' }),
  sessionName: text('session_name').notNull().unique(),
  status: sessaoStatusEnum('status').notNull().default('desconectada'),
  numero: text('numero'),
  // Rótulo do número ("Vendas", "Locação", "Campanha Facebook") — só pra sessão central.
  rotulo: text('rotulo'),
  // O Agente de IA atende neste número? (só vale pra número central; desligado = lead vai direto pra roleta)
  iaAtende: boolean('ia_atende').notNull().default(true),
  // API oficial (app Conecta Zap, Coexistência) no MESMO número — híbrido: com a janela de 24h
  // aberta a resposta sai pela oficial; fora dela sai pelo WAHA; WAHA fora → modelo (template).
  // O token é cifrado em repouso (lib/crypto). `status` acima continua sendo o do WAHA.
  oficialPhoneNumberId: text('oficial_phone_number_id').unique(),
  oficialWabaId: text('oficial_waba_id'),
  oficialNumero: text('oficial_numero'),
  oficialTokenCifrado: text('oficial_token_cifrado'),
  oficialTokenIv: text('oficial_token_iv'),
  oficialTokenTag: text('oficial_token_tag'),
  oficialAtiva: boolean('oficial_ativa').notNull().default(false),
  oficialErro: text('oficial_erro'),
  // Modelo aprovado pra 1ª mensagem quando o WAHA está fora e a janela de 24h fechada ({{1}} = nome).
  oficialTemplate: text('oficial_template'),
  oficialTemplateIdioma: text('oficial_template_idioma'),
  criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
}, table => ({
  imobiliariaIdx: index('sessoes_whatsapp_imobiliaria_id_idx').on(table.imobiliariaId),
}));

/** Número desconhecido que falou com o WhatsApp de um corretor (modo 'corretor'). Não vira lead
 *  sozinho: fica aqui até o corretor escolher "trazer pro CRM" ou "é pessoal". Só o próprio
 *  corretor vê, e nenhum conteúdo de mensagem é guardado — só quem é e quando falou. */
export const contatosPendentes = pgTable('contatos_pendentes', {
  id: uuid('id').primaryKey().defaultRandom(),
  imobiliariaId: uuid('imobiliaria_id').notNull().references(() => imobiliarias.id, { onDelete: 'cascade' }),
  corretorId: uuid('corretor_id').notNull().references(() => perfis.id, { onDelete: 'cascade' }),
  sessaoWhatsappId: uuid('sessao_whatsapp_id').notNull().references(() => sessoesWhatsapp.id, { onDelete: 'cascade' }),
  telefone: text('telefone').notNull(),
  nome: text('nome'),
  qtdMensagens: integer('qtd_mensagens').notNull().default(1),
  ultimaMensagemEm: timestamp('ultima_mensagem_em', { withTimezone: true }).notNull().defaultNow(),
}, table => ({
  corretorTelefoneIdx: uniqueIndex('contatos_pendentes_corretor_telefone_idx').on(table.corretorId, table.telefone),
}));

/** Números que o corretor marcou como "pessoal": o espelhamento ignora pra sempre (nem pendente vira). */
export const contatosIgnorados = pgTable('contatos_ignorados', {
  id: uuid('id').primaryKey().defaultRandom(),
  imobiliariaId: uuid('imobiliaria_id').notNull().references(() => imobiliarias.id, { onDelete: 'cascade' }),
  corretorId: uuid('corretor_id').notNull().references(() => perfis.id, { onDelete: 'cascade' }),
  telefone: text('telefone').notNull(),
  nome: text('nome'),
  criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
}, table => ({
  corretorTelefoneIdx: uniqueIndex('contatos_ignorados_corretor_telefone_idx').on(table.corretorId, table.telefone),
}));

export const mensagensWhatsapp = pgTable('mensagens_whatsapp', {
  id: uuid('id').primaryKey().defaultRandom(),
  leadId: uuid('lead_id').notNull().references(() => leads.id, { onDelete: 'cascade' }),
  direcao: direcaoEnum('direcao').notNull(),
  // id da mensagem no WhatsApp (WAHA) — evita duplicar ao processar o webhook 2x.
  waMessageId: text('wa_message_id'),
  // ID interno da mensagem no WhatsApp (o mesmo no WAHA e dentro do wamid da API oficial). No
  // número híbrido a mesma mensagem chega pelos dois lados — esta chave faz só uma entrar.
  waChave: text('wa_chave'),
  // "visto" do WhatsApp (evento message.ack): 1=enviando, 2=no servidor, 3=entregue, 4=lido, 5=reproduzido.
  ackStatus: integer('ack_status'),
  // Mensagem recebida já foi vista por alguém do CRM? (pro contador de não lidas em Conversas)
  lida: boolean('lida').notNull().default(false),
  // quem enviou (corretor), quando a mensagem sai pelo número central.
  enviadoPor: uuid('enviado_por').references(() => perfis.id, { onDelete: 'set null' }),
  // Mensagem pode ser só texto, só anexo, ou os dois — por isso texto virou opcional.
  texto: text('texto'),
  // Arquivo em si mora no MinIO (mesmo padrão de imóveis/templates/treinamentos) — aqui só a URL.
  anexoUrl: text('anexo_url'),
  anexoTipo: text('anexo_tipo'), // 'imagem' | 'video' | 'audio' | 'documento'
  // Nome original do arquivo (importante pra PDF — o lead manda "Contrato.pdf" e tem que baixar com esse nome).
  anexoNome: text('anexo_nome'),
  // Áudio do cliente transcrito (feito quando o Agente de IA está atendendo) — a IA lê e o corretor também.
  transcricao: text('transcricao'),
  canal: mensagemCanalEnum('canal').notNull().default('corretor'),
  // id da mensagem no CRM OKA (v1) — importação idempotente
  okaId: uuid('oka_id').unique(),
  enviadoEm: timestamp('enviado_em', { withTimezone: true }).notNull().defaultNow(),
}, table => ({
  leadIdx: index('mensagens_lead_id_idx').on(table.leadId),
  // Trava de duplicidade: o webhook do WAHA pode chegar 2x (retry, múltiplos eventos).
  waMsgIdx: uniqueIndex('mensagens_wa_message_id_uq').on(table.waMessageId).where(sql`${table.waMessageId} is not null`),
  waChaveIdx: uniqueIndex('mensagens_wa_chave_uq').on(table.leadId, table.waChave).where(sql`${table.waChave} is not null`),
}));

/** Tarefa / compromisso ligado (ou não) a um lead — pra Agenda e pros lembretes. */
export const tarefas = pgTable('tarefas', {
  id: uuid('id').primaryKey().defaultRandom(),
  imobiliariaId: uuid('imobiliaria_id').notNull().references(() => imobiliarias.id, { onDelete: 'cascade' }),
  leadId: uuid('lead_id').references(() => leads.id, { onDelete: 'set null' }),
  corretorId: uuid('corretor_id').references(() => perfis.id, { onDelete: 'set null' }),
  titulo: text('titulo').notNull(),
  descricao: text('descricao'),
  venceEm: timestamp('vence_em', { withTimezone: true }).notNull(),
  concluida: boolean('concluida').notNull().default(false),
  concluidaEm: timestamp('concluida_em', { withTimezone: true }),
  // vira true quando a varredura já avisou o corretor que a tarefa venceu (não avisa de novo).
  avisada: boolean('avisada').notNull().default(false),
  okaId: uuid('oka_id').unique(),
  criadoPor: uuid('criado_por').references(() => perfis.id, { onDelete: 'set null' }),
  criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
}, table => ({
  imobiliariaIdx: index('tarefas_imobiliaria_id_idx').on(table.imobiliariaId),
  corretorIdx: index('tarefas_corretor_id_idx').on(table.corretorId),
  leadIdx: index('tarefas_lead_id_idx').on(table.leadId),
}));

/** Linha do tempo de um lead — um registro por evento (criado, mudou de coluna, distribuído,
 *  mensagem, tarefa, nota manual, descarte). O nome do ator é gravado como snapshot. */
export type PerguntaIa = { chave: string; rotulo: string; pergunta: string; obrigatoria: boolean; opcoes?: string[] };
/** Etiqueta que a IA pode aplicar, e quando. */
export type EtiquetaIa = { tagId: string; quando: string };
/** Critério de desqualificação: 'descartar' = vai pro bolsão sem passar pela roleta;
 *  'seguir' = só aplica a etiqueta (se tiver) e segue o fluxo normal. */
export type CriterioIa = {
  chave: string; descricao: string; acao: 'descartar' | 'seguir'; tagId?: string | null;
  // "Antes de descartar, tentar": a IA faz essa tentativa de salvar o lead UMA vez (ex.: compor renda).
  tentativa?: string | null;
};

/** Configuração do Agente de IA (SDR) de cada imobiliária. Campos em vez de prompt livre:
 *  quem monta o prompt é o workflow n8n, a partir daqui. */
export const agentesIa = pgTable('agentes_ia', {
  imobiliariaId: uuid('imobiliaria_id').primaryKey().references(() => imobiliarias.id, { onDelete: 'cascade' }),
  ativo: boolean('ativo').notNull().default(false),
  nomeAgente: text('nome_agente').notNull().default('Ana'),
  tom: text('tom').notNull().default('cordial'),
  apresentacao: text('apresentacao').notNull().default(''),
  instrucoesExtras: text('instrucoes_extras').notNull().default(''),
  perguntas: jsonb('perguntas').$type<PerguntaIa[]>().notNull().default([]),
  etiquetas: jsonb('etiquetas').$type<EtiquetaIa[]>().notNull().default([]),
  criterios: jsonb('criterios').$type<CriterioIa[]>().notNull().default([]),
  mensagemPassagem: text('mensagem_passagem').notNull().default('Perfeito! Vou passar suas informações para um dos nossos corretores.'),
  maxMensagens: integer('max_mensagens').notNull().default(12),
  atenderWhatsapp: boolean('atender_whatsapp').notNull().default(true),
  // Canais de formulário em que a IA faz o PRIMEIRO contato ('Facebook' | 'Instagram' | 'Site').
  primeiroContatoCanais: jsonb('primeiro_contato_canais').$type<string[]>().notNull().default([]),
  minutosSemResposta: integer('minutos_sem_resposta').notNull().default(20),
  minutosAbandono: integer('minutos_abandono').notNull().default(120),
  // Jeito humano: segundos de silêncio do cliente antes de responder (junta mensagens picadas),
  // e marcar como lido + "digitando…" proporcional ao tamanho da resposta.
  esperaSegundos: integer('espera_segundos').notNull().default(8),
  // Catálogo: a IA sugere imóveis do cadastro que combinam e manda as fotos quando o cliente quer ver.
  consultarImoveis: boolean('consultar_imoveis').notNull().default(true),
  informarPreco: boolean('informar_preco').notNull().default(true),
  fotosPorImovel: integer('fotos_por_imovel').notNull().default(3),
  // Despedida de quem foi desqualificado: 'ia' = a IA explica com educação que no momento não se
  // encaixa; 'fixa' = manda mensagemDesqualificado, sem citar motivo nenhum.
  despedidaModo: text('despedida_modo').notNull().default('ia'),
  mensagemDesqualificado: text('mensagem_desqualificado').notNull().default('Obrigada pelas informações! Registrei tudo aqui e, se surgir uma opção que combine com o que você procura, nossa equipe entra em contato. 😊'),
  simularDigitacao: boolean('simular_digitacao').notNull().default(true),
  // Chave OpenAI própria da imobiliária (AES-256-GCM, mesmo esquema do token do Facebook).
  chaveCifrada: text('chave_cifrada'),
  chaveIv: text('chave_iv'),
  chaveTag: text('chave_tag'),
  modelo: text('modelo').notNull().default('gpt-4.1-mini'),
  atualizadoEm: timestamp('atualizado_em', { withTimezone: true }).notNull().defaultNow(),
});

/** Log de cada rodada da IA — pra mostrar à imobiliária o que ela entendeu e por que passou. */
export const iaTurnos = pgTable('ia_turnos', {
  id: uuid('id').primaryKey().defaultRandom(),
  imobiliariaId: uuid('imobiliaria_id').notNull().references(() => imobiliarias.id, { onDelete: 'cascade' }),
  leadId: uuid('lead_id').references(() => leads.id, { onDelete: 'set null' }),
  leadNome: text('lead_nome').notNull(),
  entrada: text('entrada'),
  resposta: text('resposta'),
  campos: jsonb('campos').$type<Record<string, string>>().notNull().default({}),
  decisao: text('decisao').notNull(),
  erro: text('erro'),
  // Consumo da chamada à OpenAI (pra cobrança quando a chave é do SaaS).
  tokens: integer('tokens').notNull().default(0),
  chaveSaas: boolean('chave_saas').notNull().default(true),
  criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
}, table => ({
  imobiliariaIdx: index('ia_turnos_imobiliaria_id_idx').on(table.imobiliariaId),
}));

export const eventosLead = pgTable('eventos_lead', {
  id: uuid('id').primaryKey().defaultRandom(),
  imobiliariaId: uuid('imobiliaria_id').notNull().references(() => imobiliarias.id, { onDelete: 'cascade' }),
  leadId: uuid('lead_id').notNull().references(() => leads.id, { onDelete: 'cascade' }),
  tipo: text('tipo').notNull(),
  descricao: text('descricao').notNull(),
  atorNome: text('ator_nome'),
  okaId: uuid('oka_id').unique(),
  criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
}, table => ({
  leadIdx: index('eventos_lead_lead_id_idx').on(table.leadId),
}));

/** Resultado de cada tentativa de aviso ao corretor por WhatsApp (via n8n) — reportado pelo
 *  próprio n8n depois de tentar mandar (sucesso ou erro), não pelo CRM na hora de disparar
 *  (o CRM só empurra pro webhook, quem sabe se mandou de verdade é quem chama o WAHA).
 *  Nome de lead/corretor gravados como snapshot (sobrevivem se o registro original sumir). */
export const avisosCorretorWhatsapp = pgTable('avisos_corretor_whatsapp', {
  id: uuid('id').primaryKey().defaultRandom(),
  imobiliariaId: uuid('imobiliaria_id').notNull().references(() => imobiliarias.id, { onDelete: 'cascade' }),
  leadId: uuid('lead_id').references(() => leads.id, { onDelete: 'set null' }),
  leadNome: text('lead_nome').notNull(),
  corretorId: uuid('corretor_id').references(() => perfis.id, { onDelete: 'set null' }),
  corretorNome: text('corretor_nome').notNull(),
  sucesso: boolean('sucesso').notNull(),
  erro: text('erro'),
  criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
}, table => ({
  imobiliariaIdx: index('avisos_corretor_whatsapp_imobiliaria_id_idx').on(table.imobiliariaId),
}));

/** Régua de follow-up que um corretor monta. Cada corretor tem quantas quiser; no máximo uma
 *  marcada como `disparaEmLeadNovo` dispara sozinha quando um lead cai pra ele. */
export const followupFluxos = pgTable('followup_fluxos', {
  id: uuid('id').primaryKey().defaultRandom(),
  imobiliariaId: uuid('imobiliaria_id').notNull().references(() => imobiliarias.id, { onDelete: 'cascade' }),
  corretorId: uuid('corretor_id').references(() => perfis.id, { onDelete: 'cascade' }),
  nome: text('nome').notNull(),
  ativo: boolean('ativo').notNull().default(true),
  disparaEmLeadNovo: boolean('dispara_em_lead_novo').notNull().default(false),
  // Janela de envio (minutos desde a meia-noite, fuso São Paulo) + dias permitidos (0=domingo…6=sábado).
  janelaInicioMin: integer('janela_inicio_min').notNull().default(480),
  janelaFimMin: integer('janela_fim_min').notNull().default(1200),
  janelaDias: jsonb('janela_dias').notNull().default([false, true, true, true, true, true, false]),
  aoEsgotar: aoEsgotarEnum('ao_esgotar').notNull().default('nada'),
  aoEsgotarColunaId: uuid('ao_esgotar_coluna_id').references(() => colunasKanban.id, { onDelete: 'set null' }),
  criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
}, table => ({
  corretorIdx: index('followup_fluxos_corretor_id_idx').on(table.corretorId),
}));

export const followupPassos = pgTable('followup_passos', {
  id: uuid('id').primaryKey().defaultRandom(),
  fluxoId: uuid('fluxo_id').notNull().references(() => followupFluxos.id, { onDelete: 'cascade' }),
  ordem: integer('ordem').notNull().default(0),
  tipo: text('tipo').notNull().default('texto'), // 'texto' | 'audio' | 'imagem' | 'pdf'
  conteudo: text('conteudo').notNull().default(''),
  anexoUrl: text('anexo_url'),
  anexoNome: text('anexo_nome'),
  // Atraso relativo ao passo anterior. `atrasoMinutos` é o valor real; `atrasoTexto` é só o rótulo.
  atrasoMinutos: integer('atraso_minutos').notNull().default(0),
  atrasoTexto: text('atraso_texto').notNull().default('na hora'),
  // Rótulo de cadência ("Chamada 1", "Chamada 2"…) — ao enviar o passo, grava em `leads.cadencia`.
  cadenciaLabel: text('cadencia_label'),
}, table => ({
  fluxoIdx: index('followup_passos_fluxo_id_idx').on(table.fluxoId),
}));

export const followupExecucoes = pgTable('followup_execucoes', {
  id: uuid('id').primaryKey().defaultRandom(),
  imobiliariaId: uuid('imobiliaria_id').notNull().references(() => imobiliarias.id, { onDelete: 'cascade' }),
  leadId: uuid('lead_id').notNull().references(() => leads.id, { onDelete: 'cascade' }),
  fluxoId: uuid('fluxo_id').notNull().references(() => followupFluxos.id, { onDelete: 'cascade' }),
  corretorId: uuid('corretor_id').references(() => perfis.id, { onDelete: 'set null' }),
  passoAtual: integer('passo_atual').notNull().default(0),
  status: execucaoStatusEnum('status').notNull().default('ativa'),
  proximoEnvioEm: timestamp('proximo_envio_em', { withTimezone: true }),
  motivoFim: text('motivo_fim'),
  iniciadoEm: timestamp('iniciado_em', { withTimezone: true }).notNull().defaultNow(),
}, table => ({
  leadIdx: index('followup_execucoes_lead_id_idx').on(table.leadId),
  corretorIdx: index('followup_execucoes_corretor_id_idx').on(table.corretorId),
  // No máximo uma execução "viva" (ativa ou pausada) por lead.
  umaVivaPorLead: uniqueIndex('followup_execucoes_lead_viva_uq').on(table.leadId).where(sql`status <> 'encerrada'`),
}));

export const templatesMensagem = pgTable('templates_mensagem', {
  id: uuid('id').primaryKey().defaultRandom(),
  criadoPor: uuid('criado_por').notNull().references(() => perfis.id, { onDelete: 'cascade' }),
  titulo: text('titulo').notNull(),
  texto: text('texto').notNull(),
  anexoUrl: text('anexo_url'),
});

export const imoveis = pgTable('imoveis', {
  id: uuid('id').primaryKey().defaultRandom(),
  imobiliariaId: uuid('imobiliaria_id').notNull().references(() => imobiliarias.id, { onDelete: 'cascade' }),
  tipo: text('tipo').notNull(),
  finalidade: text('finalidade').notNull(),
  titulo: text('titulo').notNull(),
  endereco: text('endereco'),
  cidade: text('cidade'),
  estado: text('estado'),
  preco: numeric('preco', { precision: 14, scale: 2 }).notNull().default('0'),
  area: numeric('area', { precision: 10, scale: 2 }),
  quartos: integer('quartos').default(0),
  suites: integer('suites').default(0),
  banheiros: integer('banheiros').default(0),
  vagas: integer('vagas').default(0),
  amenidades: jsonb('amenidades').$type<string[]>().default([]),
  descricao: text('descricao'),
  // Pronto para morar | Em obras | Lançamento — "previsaoEntrega" só faz sentido pros dois últimos.
  situacao: text('situacao').notNull().default('Pronto para morar'),
  previsaoEntrega: text('previsao_entrega'),
  aceitaFinanciamento: boolean('aceita_financiamento').notNull().default(true),
  valorCondominio: numeric('valor_condominio', { precision: 12, scale: 2 }),
  valorIptu: numeric('valor_iptu', { precision: 12, scale: 2 }),
  // URLs — os arquivos em si moram no MinIO (S3-compatible), o Postgres só guarda a referência.
  imagens: jsonb('imagens').$type<string[]>().default([]),
  videoUrl: text('video_url'),
  // Aparece no site público da imobiliária?
  publicarNoSite: boolean('publicar_no_site').notNull().default(true),
  // Nomes com que o imóvel aparece no nome das campanhas de anúncio (ex.: "CENARIUM" em
  // "[NC 02][CENARIUM][FORM]"): o lead que chega dessa campanha já vem ligado a este imóvel.
  nomesCampanha: jsonb('nomes_campanha').$type<string[]>().notNull().default([]),
  criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
});

/** Site público (landing de imóveis) de uma imobiliária. `config` é um jsonb com marca, hero,
 *  seções, depoimentos etc. — o schema exato fica no zod da rota, pra dar pra evoluir sem migração. */
export const sites = pgTable('sites', {
  id: uuid('id').primaryKey().defaultRandom(),
  imobiliariaId: uuid('imobiliaria_id').notNull().unique().references(() => imobiliarias.id, { onDelete: 'cascade' }),
  slug: text('slug').notNull().unique(),
  publicado: boolean('publicado').notNull().default(false),
  config: jsonb('config').notNull().default({}),
  atualizadoEm: timestamp('atualizado_em', { withTimezone: true }).notNull().defaultNow(),
});

export const linksUteis = pgTable('links_uteis', {
  id: uuid('id').primaryKey().defaultRandom(),
  imobiliariaId: uuid('imobiliaria_id').notNull().references(() => imobiliarias.id, { onDelete: 'cascade' }),
  categoria: text('categoria').notNull(),
  titulo: text('titulo').notNull(),
  url: text('url').notNull(),
});

export const treinamentos = pgTable('treinamentos', {
  id: uuid('id').primaryKey().defaultRandom(),
  imobiliariaId: uuid('imobiliaria_id').notNull().references(() => imobiliarias.id, { onDelete: 'cascade' }),
  titulo: text('titulo').notNull(),
  descricao: text('descricao'),
  duracaoTexto: text('duracao_texto'),
  categoria: text('categoria'),
  // Vídeo em si mora no MinIO (mesmo padrão de imóveis) — aqui só a URL.
  videoUrl: text('video_url'),
});

/** Assinatura de Web Push de um dispositivo/navegador do usuário — pra notificar mesmo com
 *  o CRM fechado (celular bloqueado, outra aba, outro navegador). */
export const pushSubscriptions = pgTable('push_subscriptions', {
  id: uuid('id').primaryKey().defaultRandom(),
  perfilId: uuid('perfil_id').notNull().references(() => perfis.id, { onDelete: 'cascade' }),
  endpoint: text('endpoint').notNull().unique(),
  p256dh: text('p256dh').notNull(),
  auth: text('auth').notNull(),
  criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
}, table => ({
  perfilIdx: index('push_subscriptions_perfil_id_idx').on(table.perfilId),
}));

export const notificacoes = pgTable('notificacoes', {
  id: uuid('id').primaryKey().defaultRandom(),
  perfilId: uuid('perfil_id').notNull().references(() => perfis.id, { onDelete: 'cascade' }),
  tipo: text('tipo').notNull(),
  titulo: text('titulo').notNull(),
  texto: text('texto'),
  // lead da notificação (clicar abre o card) — avisos de crédito/aniversário/pós-venda dependem disso
  leadId: uuid('lead_id').references(() => leads.id, { onDelete: 'cascade' }),
  lida: boolean('lida').notNull().default(false),
  criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
}, table => ({
  perfilIdx: index('notificacoes_perfil_id_idx').on(table.perfilId),
}));

/** Cada descarte de lead (normal ou extremo), com quem pediu, motivo e observação. */
export const descartesLeads = pgTable('descartes_leads', {
  id: uuid('id').primaryKey().defaultRandom(),
  imobiliariaId: uuid('imobiliaria_id').notNull().references(() => imobiliarias.id, { onDelete: 'cascade' }),
  leadId: uuid('lead_id').notNull().references(() => leads.id, { onDelete: 'cascade' }),
  usuarioId: uuid('usuario_id').references(() => perfis.id, { onDelete: 'set null' }),
  motivo: text('motivo').notNull(),
  observacao: text('observacao'),
  okaId: uuid('oka_id').unique(),
  criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
}, table => ({
  leadIdx: index('descartes_leads_lead_id_idx').on(table.leadId),
}));

/** Compromisso da equipe (reunião, treinamento) — aparece pra todo mundo, aviso 1h antes. */
export const compromissosEquipe = pgTable('compromissos_equipe', {
  id: uuid('id').primaryKey().defaultRandom(),
  imobiliariaId: uuid('imobiliaria_id').notNull().references(() => imobiliarias.id, { onDelete: 'cascade' }),
  titulo: text('titulo').notNull(),
  tipo: text('tipo').notNull().default('reuniao'),
  inicio: timestamp('inicio', { withTimezone: true }).notNull(),
  fim: timestamp('fim', { withTimezone: true }),
  local: text('local'),
  observacao: text('observacao'),
  criadoPor: uuid('criado_por').references(() => perfis.id, { onDelete: 'set null' }),
  canceladoEm: timestamp('cancelado_em', { withTimezone: true }),
  avisoEnviadoEm: timestamp('aviso_enviado_em', { withTimezone: true }),
  okaId: uuid('oka_id').unique(),
  criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
}, table => ({
  imobIdx: index('compromissos_equipe_imobiliaria_id_idx').on(table.imobiliariaId),
}));

/** Campanha de anúncio (o nome que vem no lead) com o link do criativo no Drive. */
export const campanhas = pgTable('campanhas', {
  id: uuid('id').primaryKey().defaultRandom(),
  imobiliariaId: uuid('imobiliaria_id').notNull().references(() => imobiliarias.id, { onDelete: 'cascade' }),
  nome: text('nome').notNull(),
  driveUrl: text('drive_url'),
  observacao: text('observacao'),
  criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
}, table => ({
  nomeIdx: uniqueIndex('campanhas_imobiliaria_nome_uq').on(table.imobiliariaId, table.nome),
}));

/** Quanto foi gasto em cada campanha por mês (YYYY-MM) — base do CAC e do custo por lead. */
export const gastosCampanha = pgTable('gastos_campanha', {
  id: uuid('id').primaryKey().defaultRandom(),
  imobiliariaId: uuid('imobiliaria_id').notNull().references(() => imobiliarias.id, { onDelete: 'cascade' }),
  origem: text('origem').notNull(),
  mes: text('mes').notNull(),
  valor: numeric('valor', { precision: 14, scale: 2 }).notNull().default('0'),
  atualizadoPor: uuid('atualizado_por').references(() => perfis.id, { onDelete: 'set null' }),
  criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
}, table => ({
  origemMesIdx: uniqueIndex('gastos_campanha_origem_mes_uq').on(table.imobiliariaId, table.origem, table.mes),
}));

/** Cada vez que um corretor recusa um lead no popup do CRM (ou deixa o tempo acabar).
 *  Alimenta o Histórico da Roleta e as métricas de aceite em Relatórios. */
export const recusasLead = pgTable('recusas_lead', {
  id: uuid('id').primaryKey().defaultRandom(),
  imobiliariaId: uuid('imobiliaria_id').notNull().references(() => imobiliarias.id, { onDelete: 'cascade' }),
  leadId: uuid('lead_id').notNull().references(() => leads.id, { onDelete: 'cascade' }),
  corretorId: uuid('corretor_id').notNull().references(() => perfis.id, { onDelete: 'cascade' }),
  // 'recusou' = clicou em Recusar; 'sem_resposta' = o tempo do popup acabou
  motivo: text('motivo').notNull(),
  // pra quem a roleta mandou depois (null = ninguém disponível, ficou sem corretor)
  redistribuidoParaId: uuid('redistribuido_para_id').references(() => perfis.id, { onDelete: 'set null' }),
  criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
}, table => ({
  imobIdx: index('recusas_lead_imobiliaria_id_idx').on(table.imobiliariaId),
}));

/** Lote de leads importados de uma planilha (Excel/CSV). Os leads ficam guardados até o
 *  dono/gerente distribuir pelo lote — nada sai pra roleta, IA ou follow-up sozinho. */
export const lotesImportacao = pgTable('lotes_importacao', {
  id: uuid('id').primaryKey().defaultRandom(),
  imobiliariaId: uuid('imobiliaria_id').notNull().references(() => imobiliarias.id, { onDelete: 'cascade' }),
  nome: text('nome').notNull(),
  criadoPorNome: text('criado_por_nome'),
  // etiqueta aplicada em todos os leads do lote ("Planilha: <nome>")
  tagId: uuid('tag_id').references(() => tags.id, { onDelete: 'set null' }),
  novos: integer('novos').notNull().default(0),
  duplicados: integer('duplicados').notNull().default(0),
  invalidos: integer('invalidos').notNull().default(0),
  criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
}, table => ({
  imobIdx: index('lotes_importacao_imobiliaria_id_idx').on(table.imobiliariaId),
}));

export const distribuicaoLog = pgTable('distribuicao_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  imobiliariaId: uuid('imobiliaria_id').notNull().references(() => imobiliarias.id, { onDelete: 'cascade' }),
  leadId: uuid('lead_id').notNull().references(() => leads.id, { onDelete: 'cascade' }),
  corretorId: uuid('corretor_id').notNull().references(() => perfis.id, { onDelete: 'cascade' }),
  origem: text('origem').notNull(),
  roletaId: uuid('roleta_id'),
  criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
});

// --- relations (for query-builder convenience) ---

export const imobiliariasRelations = relations(imobiliarias, ({ many }) => ({
  perfis: many(perfis),
  leads: many(leads),
  colunas: many(colunasKanban),
}));

export const perfisRelations = relations(perfis, ({ one, many }) => ({
  imobiliaria: one(imobiliarias, { fields: [perfis.imobiliariaId], references: [imobiliarias.id] }),
  leads: many(leads),
}));

export const colunasKanbanRelations = relations(colunasKanban, ({ one, many }) => ({
  imobiliaria: one(imobiliarias, { fields: [colunasKanban.imobiliariaId], references: [imobiliarias.id] }),
  leads: many(leads),
}));

export const leadsRelations = relations(leads, ({ one, many }) => ({
  imobiliaria: one(imobiliarias, { fields: [leads.imobiliariaId], references: [imobiliarias.id] }),
  coluna: one(colunasKanban, { fields: [leads.colunaId], references: [colunasKanban.id] }),
  corretor: one(perfis, { fields: [leads.corretorId], references: [perfis.id] }),
  mensagens: many(mensagensWhatsapp),
}));

export const mensagensRelations = relations(mensagensWhatsapp, ({ one }) => ({
  lead: one(leads, { fields: [mensagensWhatsapp.leadId], references: [leads.id] }),
}));

/** Uma conversa com o assistente de voz: conta os segundos usados (cota mensal da imobiliária). */
export const assistenteSessoes = pgTable('assistente_sessoes', {
  id: uuid('id').primaryKey().defaultRandom(),
  imobiliariaId: uuid('imobiliaria_id').notNull().references(() => imobiliarias.id, { onDelete: 'cascade' }),
  perfilId: uuid('perfil_id').notNull().references(() => perfis.id, { onDelete: 'cascade' }),
  iniciadaEm: timestamp('iniciada_em', { withTimezone: true }).notNull().defaultNow(),
  ultimoSinalEm: timestamp('ultimo_sinal_em', { withTimezone: true }).notNull().defaultNow(),
  segundos: integer('segundos').notNull().default(0),
  encerrada: boolean('encerrada').notNull().default(false),
  // O que foi dito (pra ele lembrar da conversa da próxima vez e mostrar o histórico na tela).
  transcricao: jsonb('transcricao').$type<{ quem: string; texto: string }[]>().notNull().default([]),
}, table => ({
  imobIdx: index('assistente_sessoes_imob_idx').on(table.imobiliariaId, table.iniciadaEm),
}));

/** O que o usuário pediu pro assistente lembrar ("o João só visita sábado"). Cada um vê só as suas. */
export const assistenteMemorias = pgTable('assistente_memorias', {
  id: uuid('id').primaryKey().defaultRandom(),
  imobiliariaId: uuid('imobiliaria_id').notNull().references(() => imobiliarias.id, { onDelete: 'cascade' }),
  perfilId: uuid('perfil_id').notNull().references(() => perfis.id, { onDelete: 'cascade' }),
  texto: text('texto').notNull(),
  criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
}, table => ({
  perfilIdx: index('assistente_memorias_perfil_idx').on(table.perfilId),
}));
