import { GoogleGenAI, MediaResolution, Modality, Type, type FunctionDeclaration, type LiveConnectConfig } from '@google/genai';

/** Assistente de voz do CRM (Gemini Live). O navegador fala direto com o Google usando um token
 *  temporário que ESTE servidor gera, já travado no modelo, no roteiro e nas ferramentas — a chave
 *  nunca sai daqui e o usuário não consegue trocar o roteiro.
 *  As ferramentas rodam no navegador, com os dados e as ações que a própria pessoa já tem no CRM
 *  (corretor só enxerga os leads dele). Ações que mudam algo exigem confirmação. */

export const MODELO = process.env.GEMINI_LIVE_MODEL || 'gemini-3.8-live';
export const VOZES = ['Charon', 'Puck', 'Kore', 'Fenrir', 'Aoede', 'Leda', 'Orus', 'Zephyr'] as const;

// Versão da API onde o token temporário vale (a documentação já citou v1alpha e v1beta).
export const VERSAO_API = process.env.GEMINI_API_VERSION || 'v1alpha';

export const assistenteConfigurado = () => !!process.env.GEMINI_API_KEY;

const TELAS = ['dash', 'kanban', 'conversas', 'clientes', 'imoveis', 'agenda', 'roleta', 'rebatidas', 'followup', 'templates', 'integracoes', 'agente-ia', 'relatorios', 'manual', 'configuracoes'];

const str = (description: string, extra: Record<string, unknown> = {}) => ({ type: Type.STRING, description, ...extra });
const num = (description: string) => ({ type: Type.NUMBER, description });

export const FERRAMENTAS: FunctionDeclaration[] = [
  {
    name: 'ver_configuracao',
    description: 'Mostra a configuração atual de uma área do CRM (só dono/gerente). Chame SEMPRE antes de alterar, pra saber os campos, ids e valores atuais.',
    parameters: { type: Type.OBJECT, properties: { area: str('agente_ia | site | imoveis | roletas | followups | templates', { enum: ['agente_ia', 'site', 'imoveis', 'roletas', 'followups', 'templates'] }) }, required: ['area'] },
  },
  {
    name: 'alterar_configuracao',
    description: 'PREPARA uma mudança de configuração (não grava ainda): mostra o antes → depois e pede confirmação. mudancas_json = objeto JSON só com os campos que mudam, com os mesmos nomes de campo que ver_configuracao devolveu. Listas (perguntas, criterios, passos, corretores) vão inteiras, já com a alteração. Áreas: agente_ia, site (campos do config + publicado), imovel (alvoId = id do imóvel), roleta (alvoId; campos nome, ativa, padrao, canais, finalidade e corretores = lista de nomes), followup (alvoId; nome, ativo, disparaEmLeadNovo, aoEsgotar e passos = [{conteudo, atrasoMinutos}]), template (alvoId; titulo, texto).',
    parameters: { type: Type.OBJECT, properties: { area: str('agente_ia | site | imovel | roleta | followup | template', { enum: ['agente_ia', 'site', 'imovel', 'roleta', 'followup', 'template'] }), alvoId: str('id do item (imóvel, roleta, follow-up ou template); vazio pra agente_ia e site'), mudancas_json: str('Objeto JSON com os campos que mudam') }, required: ['area', 'mudancas_json'] },
  },
  {
    name: 'criar_item',
    description: 'PREPARA a criação (não cria ainda) de um imóvel, template, roleta ou follow-up e pede confirmação. imovel: {tipo, finalidade (Venda|Aluguel), titulo, preco, cidade, endereco, quartos, suites, banheiros, vagas, area, descricao, situacao, aceitaFinanciamento}. template: {titulo, texto}. roleta/followup: {nome}.',
    parameters: { type: Type.OBJECT, properties: { area: str('imovel | template | roleta | followup', { enum: ['imovel', 'template', 'roleta', 'followup'] }), dados_json: str('Objeto JSON com os dados') }, required: ['area', 'dados_json'] },
  },
  {
    name: 'publicar_imovel_no_site',
    description: 'PREPARA publicar ou tirar um imóvel do site da imobiliária (pede confirmação).',
    parameters: { type: Type.OBJECT, properties: { imovelId: str('id do imóvel (de ver_configuracao imoveis)'), publicar: { type: Type.BOOLEAN, description: 'true publica, false tira do site' } }, required: ['imovelId', 'publicar'] },
  },
  {
    name: 'o_que_esta_na_tela',
    description: 'Diz o que o usuário está vendo agora no CRM: qual tela, o texto e os números visíveis nela, e o lead que estiver aberto (com a aba e as últimas mensagens, se for o chat). Use SEMPRE que ele falar "esse", "essa", "aqui", "isso", "ele/ela" sem dizer o nome, "essa tela", "esse número", "esse relatório", ou pedir opinião/resumo do que está vendo.',
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: 'buscar_leads',
    description: 'Procura leads no CRM (só os que o usuário pode ver). Use pra qualquer pergunta sobre leads: quantos, quais, de quem, de qual campanha, parados, sem resposta etc. Todos os filtros são opcionais.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        texto: str('Parte do nome, telefone, e-mail, imóvel ou campanha.'),
        etapa: str('Nome da etapa/coluna do funil (ex.: "Lead Novo", "Visita agendada").'),
        etiqueta: str('Nome de uma etiqueta (ex.: "Quente").'),
        corretor: str('Nome do corretor responsável.'),
        canal: str('Origem: Facebook, Instagram, WhatsApp, Site...'),
        criadosNosUltimosDias: num('Só leads que entraram nos últimos N dias (1 = hoje).'),
        paradosHaDias: num('Só leads há pelo menos N dias na mesma etapa.'),
        limite: num('Quantos no máximo (padrão 10).'),
      },
    },
  },
  {
    name: 'detalhes_lead',
    description: 'Tudo sobre um lead: dados, etapa, corretor, etiquetas, resumo do Agente de IA, últimas mensagens do WhatsApp e tarefas. Use antes de responder perguntas sobre um lead específico.',
    parameters: { type: Type.OBJECT, properties: { leadId: str('id do lead (vem de buscar_leads)') }, required: ['leadId'] },
  },
  {
    name: 'resumo_painel',
    description: 'Números gerais do funil no período: total de leads novos, por etapa, por canal, por campanha e por corretor.',
    parameters: { type: Type.OBJECT, properties: { periodo: str('hoje | 7dias | 30dias | tudo', { enum: ['hoje', '7dias', '30dias', 'tudo'] }) } },
  },
  {
    name: 'listar_tarefas',
    description: 'Tarefas do usuário (ou da equipe, se for gestor).',
    parameters: { type: Type.OBJECT, properties: { quais: str('atrasadas | hoje | semana | abertas', { enum: ['atrasadas', 'hoje', 'semana', 'abertas'] }) } },
  },
  {
    name: 'abrir_tela',
    description: 'Navega o CRM até uma tela.',
    parameters: { type: Type.OBJECT, properties: { tela: str('Tela do CRM', { enum: TELAS }) }, required: ['tela'] },
  },
  {
    name: 'abrir_lead',
    description: 'Abre a ficha de um lead na tela (aba detalhes, chat ou histórico).',
    parameters: { type: Type.OBJECT, properties: { leadId: str('id do lead'), aba: str('detalhes | chat | historico', { enum: ['detalhes', 'chat', 'historico'] }) }, required: ['leadId'] },
  },
  {
    name: 'criar_tarefa',
    description: 'PREPARA uma tarefa (não cria ainda): mostra um cartão pedindo confirmação.',
    parameters: {
      type: Type.OBJECT,
      properties: { titulo: str('O que fazer'), quando: str('Data e hora no formato ISO 8601 com fuso -03:00'), leadId: str('id do lead, se a tarefa for sobre um lead'), descricao: str('Detalhes (opcional)') },
      required: ['titulo', 'quando'],
    },
  },
  {
    name: 'mover_lead',
    description: 'PREPARA a mudança de etapa de um lead no funil (não move ainda): pede confirmação.',
    parameters: { type: Type.OBJECT, properties: { leadId: str('id do lead'), etapa: str('Nome da etapa de destino') }, required: ['leadId', 'etapa'] },
  },
  {
    name: 'enviar_mensagem',
    description: 'PREPARA uma mensagem de WhatsApp pro lead (não envia ainda): mostra o texto e pede confirmação.',
    parameters: { type: Type.OBJECT, properties: { leadId: str('id do lead'), texto: str('Texto exato da mensagem') }, required: ['leadId', 'texto'] },
  },
  {
    name: 'confirmar_acao',
    description: 'Executa a ação que está esperando confirmação. Só chame depois que o usuário disser claramente que sim (ex.: "sim", "pode", "confirma").',
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: 'cancelar_acao',
    description: 'Descarta a ação que está esperando confirmação.',
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: 'lembrar',
    description: 'Guarda uma anotação pessoal do usuário pra lembrar depois (ex.: "o João só visita aos sábados").',
    parameters: { type: Type.OBJECT, properties: { texto: str('O que lembrar, numa frase completa') }, required: ['texto'] },
  },
  {
    name: 'recordar',
    description: 'Procura nas anotações que o usuário pediu pra lembrar.',
    parameters: { type: Type.OBJECT, properties: { consulta: str('Palavra ou assunto (vazio = as mais recentes)') } },
  },
  {
    name: 'esquecer',
    description: 'Apaga uma anotação guardada (use o id que veio de recordar).',
    parameters: { type: Type.OBJECT, properties: { id: str('id da anotação') }, required: ['id'] },
  },
  {
    name: 'mostrar_painel',
    description: 'Mostra um painel na tela com informação útil (lista, resumo, números). Use quando a resposta tiver mais de 3 itens.',
    parameters: { type: Type.OBJECT, properties: { titulo: str('Título curto'), conteudo: str('Texto do painel; uma linha por item') }, required: ['titulo', 'conteudo'] },
  },
  {
    name: 'fechar_janela',
    description: 'Fecha a janela/ficha que está aberta na tela do CRM (ficha do lead, a conversa aberta dentro da ficha, janelas de importar ou de novo lead). Use quando o usuário pedir pra fechar a ficha, a conversa ou "essa janela".',
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: 'fechar_paineis',
    description: 'Fecha só os painéis de informação que VOCÊ (assistente) abriu com mostrar_painel. Não fecha a ficha do lead — pra isso use fechar_janela.',
    parameters: { type: Type.OBJECT, properties: {} },
  },
];

const PAPEL: Record<string, string> = { dono: 'dono da imobiliária', gerente: 'gerente', corretor: 'corretor' };

export function roteiro(o: { nomeAssistente: string; nomeUsuario: string; papel: string; nomeImob: string; memorias: { id: string; texto: string }[]; historico: { quem: string; texto: string }[] }) {
  const agora = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', weekday: 'long', day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  return [
    `Você é ${o.nomeAssistente}, o assistente de voz do CRM da imobiliária ${o.nomeImob}.`,
    `Está falando com ${o.nomeUsuario}, ${PAPEL[o.papel] || o.papel}. Agora é ${agora} (horário de Brasília).`,
    'Fale sempre em português do Brasil, de forma natural, educada e objetiva — respostas curtas, como numa conversa por voz. Chame o usuário pelo primeiro nome de vez em quando.',
    'Regras:',
    '- Só diga que fez algo (abriu, fechou, criou, moveu, enviou) depois que a ferramenta devolver feito: true. Se ela devolver erro, ou se não existir ferramenta pra aquilo, diga com sinceridade que não conseguiu.',
    '- Nunca invente dados. Para qualquer informação do CRM, use as ferramentas (buscar_leads, detalhes_lead, resumo_painel, listar_tarefas). Se não achar, diga que não encontrou.',
    '- Nunca fale ids em voz alta; use o nome do lead. Quando houver dois leads com nomes parecidos, pergunte qual.',
    o.papel === 'corretor'
      ? '- O usuário é corretor: ele só enxerga os próprios leads, e as ferramentas já trazem só esses.'
      : '- O usuário é gestor e enxerga a imobiliária toda.',
    '- Ações que mudam algo (criar_tarefa, mover_lead, enviar_mensagem) só PREPARAM um cartão na tela. Depois de preparar, leia em voz alta o que vai ser feito e pergunte "confirma?". Só chame confirmar_acao quando o usuário disser claramente que sim; se ele disser não ou mudar de ideia, chame cancelar_acao. O usuário também pode confirmar clicando no cartão ou com o gesto de joinha.',
    '- Mensagens de WhatsApp: escreva como um corretor educado escreveria, curtas, sem prometer valores ou condições que você não viu no CRM.',
    '- Quando a resposta for uma lista grande, mostre num painel (mostrar_painel) e fale só o resumo.',
    '- Se pedirem pra abrir uma tela ou um lead, use abrir_tela / abrir_lead.',
    '- Use lembrar quando o usuário pedir pra guardar algo E também por conta própria quando ele contar algo que vale lembrar depois (preferência de cliente, combinado, prazo, informação útil do trabalho) — avise numa frase curta que anotou. Use recordar quando ele perguntar sobre algo guardado.',
    '- Câmera: quando o usuário liga a câmera, você recebe uma imagem por segundo e consegue ver o usuário e o que ele mostrar. Comente o que vê só quando for útil ou quando ele perguntar. Sem câmera ligada, diga que não está vendo nada.',
    '- Configurar o CRM (Agente de IA, site, imóveis, roletas, follow-ups, templates): só dono e gerente. Primeiro ver_configuracao da área, depois alterar_configuracao / criar_item / publicar_imovel_no_site — tudo só prepara um cartão com o antes → depois; leia as mudanças e peça confirmação. Nunca apague nada por voz: pra excluir, abra a tela. Imóvel: obrigatórios são só tipo, finalidade, título e preço — com isso prepare o cadastro na hora (monte um título curto se ele não disser) e, depois de confirmado, ofereça completar o resto (área, banheiros, fotos pela tela). Só pergunte antes se faltar algum obrigatório.',
    '- Contexto da tela: você não vê a tela como imagem; pra saber o que o usuário está olhando, chame o_que_esta_na_tela. Quando ele se referir a algo sem dar nome ("esse lead", "manda pra ele", "o que acha desse relatório"), chame primeiro o_que_esta_na_tela e use o que vier dela.',
    '- Janelas: abrir_lead abre a ficha; fechar_janela fecha a ficha ou a janela aberta; fechar_paineis fecha só os seus painéis.',
    '- Você não tem acesso à internet, só ao CRM.',
    o.memorias.length
      ? 'Anotações que o usuário já pediu pra lembrar (mais recentes primeiro):\n' + o.memorias.map(m => `- ${m.texto}`).join('\n')
      : '',
    o.historico.length
      ? 'Final das suas últimas conversas com este usuário (continue de onde pararam se fizer sentido; não repita cumprimento longo):\n' + o.historico.map(f => (f.quem === 'voce' ? 'Usuário: ' : f.quem === 'assistente' ? 'Você: ' : '(sistema) ') + f.texto).join('\n')
      : '',
  ].filter(Boolean).join('\n');
}

export function configSessao(o: { voz: string; instrucoes: string }): LiveConnectConfig {
  return {
    responseModalities: [Modality.AUDIO],
    speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: o.voz } }, languageCode: 'pt-BR' },
    systemInstruction: o.instrucoes,
    tools: [{ functionDeclarations: FERRAMENTAS }],
    // imagens da câmera em resolução baixa: bem mais barato e suficiente pra ver a pessoa
    mediaResolution: MediaResolution.MEDIA_RESOLUTION_LOW,
    inputAudioTranscription: {},
    outputAudioTranscription: {},
  };
}

/** Token temporário de uma sessão só, que vale pra começar em 1 min e dura até 30 min. */
export async function criarTokenTemporario(config: LiveConnectConfig) {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY!, httpOptions: { apiVersion: VERSAO_API } });
  const token = await ai.authTokens.create({
    config: {
      uses: 1,
      expireTime: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      newSessionExpireTime: new Date(Date.now() + 60 * 1000).toISOString(),
      liveConnectConstraints: { model: MODELO, config },
      httpOptions: { apiVersion: VERSAO_API },
    },
  });
  if (!token.name) throw new Error('o Google não devolveu o token');
  return token.name;
}
