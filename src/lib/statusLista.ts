import type { RemoteColuna } from './remoteLeads';

/** Status que NÃO aparecem na lista do card (pedido do dono 11-07). Continuam existindo no Kanban;
 *  descarte tem fluxo próprio (botão Descartar, com motivo). */
const FORA_DA_LISTA = new Set(['proposta', 'parou', 'descarte', 'descadastrar']);

const chave = (t: string) => t.trim().toLocaleUpperCase('pt-BR');

/** Lista do "Status do Kanban" no card: sem repetidos (mesmo nome = uma linha só, vale a coluna do sistema),
 *  sem os status escondidos e em ordem alfabética. `valor` é o id a marcar como atual — se o lead está numa
 *  coluna repetida, marca a "oficial" de mesmo nome; se está num status escondido, ele aparece só pra esse lead. */
export function opcoesDeStatus(colunas: RemoteColuna[], atualId: string) {
  const ordenadas = [...colunas].sort((a, b) => Number(!a.slug) - Number(!b.slug) || a.ordem - b.ordem);
  const porNome = new Map<string, RemoteColuna>();
  for (const c of ordenadas) if (!porNome.has(chave(c.titulo))) porNome.set(chave(c.titulo), c);
  const atual = colunas.find(c => c.id === atualId);
  const atualCanonica = atual ? porNome.get(chave(atual.titulo)) ?? atual : undefined;
  const opcoes = [...porNome.values()]
    .filter(c => !(c.slug && FORA_DA_LISTA.has(c.slug)) || c.id === atualCanonica?.id)
    .sort((a, b) => chave(a.titulo).localeCompare(chave(b.titulo), 'pt-BR'))
    .map(c => ({ id: c.id, titulo: c.titulo }));
  return { opcoes, valor: atualCanonica?.id ?? atualId };
}
