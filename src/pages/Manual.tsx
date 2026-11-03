import { useAppStore } from '../store/appStore';

const FAQ = [
  { id: 'criativos', q: 'Criativos dos anúncios (Drive)', a: 'Em Campanhas, o dono/gerente cola o link da pasta do Google Drive com os criativos (compartilhada como "Qualquer pessoa com o link"). O CRM acha o criativo de cada anúncio pelo NOME do arquivo — nomeie igual ao anúncio do Facebook, ex.: "[CN 38] [SETE SÓIS].png". No card do lead aparece "Anúncio que trouxe esse lead" com a imagem ou o vídeo; clique pra ver grande. Toda meia-noite o CRM relê a pasta sozinho (e no dia a dia a cada 10 minutos de uso). Pra forçar outro arquivo numa campanha, use "Trocar criativo".' },
  { id: 'senha', q: 'Senha: esqueci / trocar / redefinir', a: 'Trocar a sua senha: clique no seu nome (barra lateral ou canto de cima) → "Meu perfil e senha". Esqueceu? Na tela de entrada use "Esqueci minha senha": o dono e o gerente recebem o aviso. Dono/gerente redefinem em Equipe → "Redefinir senha": geram uma senha automática ou digitam uma, e copiam a mensagem pronta pro WhatsApp. No próximo acesso a pessoa é obrigada a criar uma senha só dela. Membro novo (senha 123456) também cria a dele no primeiro acesso.' },
  { id: 'entraram', q: 'Leads que entraram (Dashboard)', a: 'No Dashboard, o dono e o gerente veem quem chegou hoje e ontem: a hora, a campanha ou canal, a cidade, a etapa e com qual corretor está. Os botões Hoje / Ontem / Hoje + ontem trocam o período. Lead SEM CORRETOR aparece destacado; clique na caixa "Sem corretor" pra ver só esses e em "Distribuir agora" pra ir ao Bolsão. Clicar num lead abre o card.' },
  { id: 'kanban', q: 'Kanban de Leads', a: 'Cada coluna é uma etapa real do seu processo comercial. Arraste o card para mover o lead — o tempo na coluna reinicia e o histórico registra a mudança. Colunas podem ser criadas, renomeadas e reordenadas pelo Dono.' },
  { id: 'roleta', q: 'Roleta de Atendimento', a: 'A roleta distribui leads novos na ordem da fila, pulando quem estiver indisponível. Na "Ordem de prioridade" de cada roleta aparece quem está ONLINE ou OFFLINE e a hora do check-in (quando ficou online). Dono e gerente clicam no status pra colocar ou tirar alguém, e arrastam a linha pra mudar a ordem. Fora do expediente só o dono consegue colocar um corretor online: ele recebe leads até a meia-noite e depois sai sozinho. Quando o dono ou o gerente coloca o corretor online, não conta advertência de "depois das 14h".' },
  { id: 'bolsao', q: 'Bolsão e Rebatidas', a: 'Leads sem corretor, descartados ou sem resposta caem no bolsão. Qualquer corretor pode puxar rebatidas dentro do limite definido pelo gerente.' },
  { id: 'followup', q: 'Follow-up Automático', a: 'Sequências de mensagens com atraso configurável e variáveis. Se o lead responde, a sequência pausa automaticamente. Imagem do anúncio sozinha: num passo de Texto clique em "Inserir criativo da campanha" (ou escreva {criativo}) — cada lead recebe a imagem do anúncio de onde ELE veio, com a mensagem como legenda. Precisa da pasta de criativos conectada em Campanhas e o arquivo com o mesmo nome do anúncio na Meta. Lead sem criativo (veio do WhatsApp ou nome não bate) recebe só o texto; vídeo vai a capa. O passo a passo completo está na OBS laranja da tela de Follow-up.' },
  { id: 'responder', q: 'Responder uma mensagem (igual ao WhatsApp)', a: 'Nas Conversas ou no chat do card, clique 2 vezes no balão da mensagem (ou na setinha que aparece ao passar o mouse; no celular ela fica sempre visível). Aparece "Respondendo…" em cima do campo; escreva e envie. O lead recebe no WhatsApp como resposta citando aquela mensagem, e no CRM o balão mostra a citação — clique nela pra pular até a original. Pra desistir, clique no X. Quando o lead responde uma mensagem específica pelo celular, a citação também aparece no CRM. Vale pra texto, foto, áudio, arquivo e mensagens prontas.' },
  { id: 'credito', q: 'Análise de Crédito', a: 'Pastas enviadas ao banco aparecem com status. Pendências devolvidas geram alerta no topo do módulo e tarefa para o corretor responsável.' },
  { id: 'relatorios', q: 'Relatórios', a: 'Tudo o que a v1 tinha, organizado em seções: visão geral (leads, SLA, conversão, vendas), funil completo (clique numa barra pra ver os leads e abrir o card), status do funil, leads novos com renda, ranking de consultores, atendimento da roleta, origem e campanhas (com gasto e CAC), follow-up e devoluções. Filtre por mês OU por um intervalo de datas, por cidade, por corretor e por uma ou várias campanhas (com busca e "Marcar todas"). O ranking conta o que cada corretor fez no período, inclusive rebatidas puxadas e etapas em leads antigos. Exportar CSV baixa os números do filtro.' },
];

export default function Manual() {
  const faqOpen = useAppStore(s => s.faqOpen);
  const setFaqOpen = useAppStore(s => s.setFaqOpen);
  return (
    <div style={{ maxWidth: 760 }}>
      <p style={{ fontSize: 11, letterSpacing: '.18em', textTransform: 'uppercase', color: 'var(--muted)', margin: '0 0 4px' }}>Ajuda</p>
      <h1 style={{ fontFamily: 'Newsreader,serif', fontWeight: 400, fontSize: 24, margin: '0 0 16px', lineHeight: 1.2 }}>Manual da plataforma</h1>
      <div style={{ border: '1px solid var(--line)', borderRadius: 12, background: 'var(--card)', overflow: 'hidden' }}>
        {FAQ.map(f => {
          const open = faqOpen === f.id;
          return (
            <div key={f.id} style={{ borderBottom: '1px solid var(--line)' }}>
              <button onClick={() => setFaqOpen(f.id)} style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 14, padding: '18px 20px', background: 'none', border: 'none', textAlign: 'left' }}>
                <span style={{ width: 8, height: 8, transform: 'rotate(45deg)', flex: 'none', background: open ? 'var(--terra)' : 'var(--line)' }} />
                <span style={{ flex: 1, fontSize: 14.5, fontWeight: 600 }}>{f.q}</span>
                <span style={{ color: 'var(--muted)', fontSize: 15 }}>{open ? '–' : '+'}</span>
              </button>
              {open && <p style={{ margin: 0, padding: '0 20px 20px 48px', fontSize: 13.5, lineHeight: 1.75, color: 'var(--muted)' }}>{f.a}</p>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
