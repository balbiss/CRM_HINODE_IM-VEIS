# CRM Hinode — Documentação

> Apelido interno: **CRM Hinode**. Rebuild v2, independente, do CRM em produção da imobiliária
> "Hinode Imóveis" (o sistema original em produção é outro projeto, "CRM OKA" — este aqui **não
> compartilha banco, código nem infraestrutura** com ele).
>
> O código deste repositório foi construído originalmente como base pra um produto **multi-tenant**
> (várias imobiliárias no mesmo sistema — ver `integracoes_facebook`, `roletas`, painel
> `/plataforma`), mas **este deploy específico é single-tenant**: só a Hinode Imóveis usa, o painel
> Plataforma fica dormente de propósito, e a captação de leads do Facebook usa o workflow n8n fixo
> já em produção (não o fluxo dinâmico multi-empresa que o código também suporta). Ver §10 e §13.

Repositório: [`github.com/balbiss/CRM_HINODE_IM-VEIS`](https://github.com/balbiss/CRM_HINODE_IM-VEIS) — toda atualização de código deste projeto é commitada e enviada pra lá.

**🟢 EM PRODUÇÃO:** [`https://hinode.inoovaweb.com.br`](https://hinode.inoovaweb.com.br) (deploy via
GitHub Actions → GHCR → Docker Swarm/Portainer, mesma VPS do CRM OKA). Instalação: [`INSTALACAO.md`](INSTALACAO.md).

Última atualização: 2026-09-07.

---

## 1. O que é

Um CRM imobiliário sob medida para a Hinode Imóveis: kanban de leads com roleta de distribuição
automática entre corretores, follow-up de WhatsApp, análise de crédito, gestão de equipe, etiquetas,
tarefas/agenda, site público de imóveis, tudo com controle de acesso por papel (Dono / Gerente /
Corretor, enum `perfis.role`).

O schema/código suporta **múltiplas imobiliárias** no mesmo banco (toda tabela tem
`imobiliaria_id`) — mas neste deploy só existe uma linha em `imobiliarias`, a da Hinode. O painel
`/plataforma` (gestão de várias imobiliárias clientes, cobrança/inadimplência) existe no código mas
fica **dormente** aqui de propósito.

## 2. Stack

**Frontend** (`/` — raiz):
- Vite + React 19 + TypeScript, React Router
- Zustand (estado global único: `src/store/appStore.ts`)
- Socket.io-client (realtime)
- PWA via `vite-plugin-pwa` (`registerType: 'autoUpdate'`)
- Sem Tailwind — estilos inline via objeto JS gerado de string CSS (`src/lib/css.ts`)
- Build servido por nginx (`Dockerfile` na raiz + `nginx.conf`)

**Backend** (`server/`):
- Node 22 + Express + TypeScript (`tsx` em dev, `tsc` build → `dist/`)
- Drizzle ORM + driver `postgres` (postgres-js) + PostgreSQL 16
- Socket.io (rooms por imobiliária, handshake por JWT)
- JWT (`jsonwebtoken`) + `bcryptjs`; validação com `zod`
- MinIO (S3-compatible) para imagens/vídeo/áudio/PDF — Postgres guarda só a URL
- `ffmpeg` no container (converte áudio do navegador webm/opus → ogg/opus pro WhatsApp)

**WhatsApp:** [WAHA](https://waha.devlike.pro/) (`devlikeapro/waha`, engine **GOWS**). Opcional.

## 3. Estrutura de pastas

```
nova-crm/                      # pasta local ainda se chama nova-crm — só a marca visível mudou
├── src/                       # frontend
│   ├── pages/                 # uma página por rota (+ pages/site/SitePublico.tsx = site público)
│   ├── components/            # Sidebar, Topbar, AppShell, LeadModal, AlertModal, CardTagBar, ...
│   ├── store/appStore.ts      # Zustand — TODO o estado + todas as chamadas de API
│   └── lib/                   # api.ts, socket.ts, css.ts, format.ts, nav.ts, schedule.ts,
│                              # data.ts (tipos + mocks restantes), remoteLeads.ts, selectors.ts
├── server/
│   ├── src/
│   │   ├── db/                # schema.ts (Drizzle), client.ts, migrate.ts, seed.ts
│   │   ├── routes/            # um router por recurso (ver tabela §6)
│   │   ├── lib/               # roleta.ts, followup.ts, schedule.ts, waha.ts, bootstrapPlataforma.ts, ...
│   │   └── middleware/auth.ts # requireAuth, requireRole
│   ├── drizzle/               # migrações SQL geradas (0000 … 0023)
│   └── Dockerfile             # roda `npm run db:migrate && node dist/index.js`
├── docker-compose.yml         # Postgres (55432) + MinIO (59000/59001) para dev
├── Dockerfile                 # build do frontend → nginx
└── docs/
```

## 4. Multi-tenancy — como o isolamento funciona

- **Toda tabela tem `imobiliaria_id`.** Toda query nas rotas é escopada por
  `req.auth!.imobiliariaId`, que vem do JWT — nunca de um parâmetro do cliente.
- **JWT de tenant:** `{ sub, imobiliariaId, role, nome }`, assinado por `signToken`. Middleware
  `requireAuth` (`server/src/middleware/auth.ts`) valida o token **e** o status da imobiliária
  (imobiliária suspensa → 403). `requireRole('dono','gerente')` restringe rotas administrativas.
- **JWT da plataforma** é separado (`/api/plataforma/*`), para o admin do SaaS.
- **Realtime:** cada socket entra na room `imobiliaria:<id>`; eventos só chegam a quem é do mesmo tenant.
- **Colunas do Kanban:** o backend usa `colunaId` (UUID por imobiliária); o frontend usa um slug fixo
  de 7 valores. `src/lib/remoteLeads.ts` faz a ponte casando pelo **título** da coluna
  (`colIdToSlug` / `slugToColunaId`). O seed cria as colunas com os títulos que o front espera.

## 5. Papéis e controle de acesso

| Recurso | Dono | Gerente | Corretor |
|---|---|---|---|
| Ver leads | todos | todos | só os seus |
| Criar/mover lead | ✅ | ✅ | ✅ (os seus) |
| **Excluir lead** | ✅ | ✅ | ❌ |
| Atribuir lead a corretor (`PATCH /leads/:id {corretorId}`) | ✅ | ✅ | ❌ |
| Equipe (CRUD de perfis) | ✅ (cria gerente/corretor) | ✅ (só corretor) | ❌ |
| Roletas (criar/editar/membros) | ✅ | ✅ | ❌ |
| Imóveis / Links Úteis / Treinamentos | CRUD | CRUD | só leitura |
| Templates de mensagem | próprios | próprios | próprios (ninguém vê os do outro) |
| Config (horário, limite de rebatidas) | ✅ | ✅ | ❌ |
| Site público (editar) | ✅ | ✅ | ❌ |
| Follow-up | cria os próprios fluxos | idem | cria os próprios fluxos |
| Menu `mgrOnly` (Equipe, Ajustes, Site, Roleta…) | visível | visível | escondido |

## 6. Rotas do backend (`server/src/index.ts`)

| Prefixo | Arquivo | Resumo |
|---|---|---|
| `/api/auth` | `auth.ts` | login, logout, hidratação de sessão |
| `/api/leads` | `leads.ts` | CRUD + mover no funil, aceitar/recusar, rebatidas (puxar), descarte |
| `/api/colunas` | `colunas.ts` | colunas do Kanban da imobiliária |
| `/api/filas` | `filas.ts` | disponibilidade (plantão), distribuir, embaralhar, log da roleta |
| `/api/roletas` | `roletas.ts` | CRUD de roletas + membros + canais/finalidade/número |
| `/api/perfis` | `perfis.ts` | equipe: convidar, editar, bloquear, excluir, roletas do corretor |
| `/api/mensagens` | `mensagens.ts` | histórico e envio de mensagens de um lead |
| `/api/whatsapp` | `whatsapp.ts` | sessões WAHA (conectar/QR/rótulo), webhook de mensagens, despacho |
| `/api/tarefas` | `tarefas.ts` | tarefas/agenda; varredura de vencidas a cada 60s |
| `/api/followup` | `followup.ts` | fluxos de follow-up, passos, execuções ("Em andamento") |
| `/api/sites` | `sites.ts` | site público: `GET /publico/:slug`, `POST /publico/:slug/contato`, editor |
| `/api/captacao` | `captacao.ts` | `POST /facebook` e `POST /site` — entrada de lead sem JWT (segredo compartilhado) |
| `/api/integracoes` | `integracoes.ts` | conexões Facebook por imobiliária (token cifrado); `GET /facebook/ativas` p/ automação |
| `/api/imoveis` | `imoveis.ts` | catálogo (CRUD) |
| `/api/tags` | `tags.ts` | etiquetas (nome + cor) |
| `/api/templates` | `templates.ts` | templates de mensagem pessoais |
| `/api/links-uteis` · `/api/treinamentos` | idem | bibliotecas da imobiliária |
| `/api/notificacoes` | `notificacoes.ts` | notificações pessoais |
| `/api/config` | `config.ts` | horário de atendimento, `limiteRebatidasDia` |
| `/api/uploads` | `uploads.ts` | `POST` multipart → `{ url, nome }` (MinIO) |
| `/api/push` | `push.ts` | Web Push (VAPID) |
| `/api/plataforma` | `plataforma.ts` | painel do dono do SaaS (imobiliárias, cobrança) |
| `/health` | — | `{ "ok": true }` |

## 7. Regras de negócio

### 7.1 Roleta / distribuição (`server/src/lib/roleta.ts`)

- **Múltiplas roletas por imobiliária.** Cada roleta tem: `ativa`, `ordem`, `padrao` (fallback),
  `canais` (`[]` = todos), `finalidade` (`venda` / `locacao` / `ambos`), `sessaoWhatsappId` (número).
- **`escolherRoleta(imobId, { canal, finalidade, sessaoWhatsappId })`**: entre as roletas ativas,
  filtra por número (tem que bater), canal e finalidade; pontua a especificidade (número 4 / canal 2 /
  finalidade 1); a de maior pontuação vence, empate pela `ordem`. Nada casa → roleta `padrao`.
- **`distribuirLead`**: escolhe a roleta, pega o próximo membro **daquela roleta** que está
  `emPlantao=true`, grava em `distribuicao_log` (origem `roleta` + `roletaId`).
- **`POST /api/leads` NÃO distribui automaticamente** — por decisão: o gerente decide. Distribuição
  automática só ocorre via `POST /api/filas/distribuir` (leads pendentes) ou quando um corretor entra
  em plantão. `PATCH /api/leads/:id {corretorId}` é atribuição manual (permitida a dono/gerente).
- **Venda × locação** é detectado pelo número de WhatsApp que recebeu + campo do formulário
  (`normalizarFinalidade`: `alug|loca|rent`→locação, `compr|venda|sale|buy`→venda).

### 7.2 Plantão / horário comercial (`src/lib/schedule.ts` + `server/src/lib/schedule.ts`)

- Cada corretor liga "No Plantão" manualmente todo dia — ninguém começa o dia disponível.
- Janela definida pela imobiliária (dias + horário). Fora da janela ou bloqueado, o toggle é recusado
  no front (toast) **e** no backend (`PATCH /api/filas/disponibilidade` → 403).
- O `AppShell` reavalia a cada 60s e desliga quem estava online quando o expediente encerra.
- Paleta Hinode: **terracota** (`--terra`, #B5652F) é a cor primária (botões, links, marca). Cor de
  botão de plantão e de status positivo (badges Ativo/Fidelizado): **oliva** (`--olive`/`--plantao`).

### 7.3 Fila de leads pendentes (aceite/recusa)

Quando um lead cai para um corretor (socket `lead:updated` em que o lead passou a ser dele), ele entra
numa **fila** (`leadsPendentes[]` no `appStore`). O `AlertModal` mostra **um lead por vez** com
contador regressivo e "+N na fila"; aceitar abre o chat, recusar (ou estourar o tempo) devolve o lead
para a roleta (`POST /api/leads/:id/recusar`). Isso substituiu o modelo antigo de um alerta só, que se
perdia quando vários leads chegavam juntos.

### 7.4 Bolsão / rebatidas (`server/src/routes/leads.ts` + `config.ts`)

- Lead descartado vai para a coluna **Rebatida** com `corretorId: null` e o **motivo** gravado
  (`PATCH /api/leads/:id {motivoDescarte}`).
- **"Puxar rebatida":** o corretor puxa uma rebatida (a mais antiga) para a carteira. Bloqueado (409)
  se ele tem **qualquer tarefa atrasada** ou já atingiu o **limite diário** (`limiteRebatidasDia`,
  configurável por dono/gerente em Ajustes, default 5). Registrado em `distribuicao_log` origem
  `rebatida-puxada`.

### 7.5 Follow-up de WhatsApp (`server/src/lib/followup.ts` + `routes/followup.ts`)

- Cada corretor cria **um ou mais fluxos** (réguas). Cada passo tem: `tipo` (texto/áudio/imagem/pdf),
  conteúdo/anexo, **atraso livre** (número + minutos/horas/dias — não são presets), e um
  `cadenciaLabel` opcional que atualiza `leads.cadencia`.
- **Janela de envio:** horário permitido (`janelaInicioMin`/`janelaFimMin`) + dias da semana em que
  **não** pode enviar (`janelaDias`). Fuso São Paulo (Brasil sem horário de verão, offset fixo −3).
- Um fluxo pode ter `disparaEmLeadNovo` (só um por corretor) — dispara quando o lead é atribuído.
- Antes da 1ª mensagem automática, checa se o número existe no WhatsApp
  (`GET /api/contacts/check-exists` no WAHA). Número inválido interrompe a execução.
- **Pausa quando o lead responde** (`pausarPorResposta`, chamado pelo webhook em `!fromMe`).
- `varrerFollowups(io)` roda a cada 60s no `index.ts` (junto com a varredura de tarefas vencidas).
- A página Follow-up tem duas abas: **Meus fluxos** (editor linear de passos, com upload de anexo) e
  **Em andamento** (execuções ativas — não é coluna do Kanban).
- Ativar/desativar o follow-up de um lead é feito no card/ficha do lead.

### 7.6 Imóvel de interesse

Quando um lead escolhe um imóvel no site público **ou** vem de uma campanha com `imovelId`, o backend
**denormaliza** título, valor e foto do imóvel para o lead (`leads.imovelInteresseId` +
`imovelTitulo`/`valor`/`imovelSub`/`fotoUrl`). A ficha do lead e a página Clientes mostram os dados
reais do imóvel (antes aparecia "R$ 0").

## 8. Site público por imobiliária (`server/src/routes/sites.ts` + `src/pages/site/SitePublico.tsx`)

- Cada imobiliária tem um `slug` e um `config` (jsonb): nome de exibição, logo, cor primária, hero,
  seção "sobre", destaques, depoimentos, textos de contato, rodapé.
- Rota pública: `hinode.inoovaweb.com.br/s/:slug`. Lista os imóveis com `publicarNoSite = true`.
- Formulário de contato → `POST /api/sites/publico/:slug/contato` → cria lead canal `Site`, com
  `finalidade` (Comprar/Alugar) e `imovelId` quando o visitante clicou num imóvel.
- **CORS:** `index.ts` roteia `/api/captacao/site` e `/api/sites/publico` para `corsPublico`
  (origin `*`, métodos GET/POST/OPTIONS); o resto usa `corsRestrito`.
- Responsivo mobile via detecção JS (`window.innerWidth` + listener), não só media query — o cache do
  PWA servia CSS velho.

## 9. WhatsApp / WAHA (`server/src/routes/whatsapp.ts` + `lib/waha.ts`)

- **Vários números por imobiliária.** `POST /api/whatsapp/sessoes` cria uma sessão nova
  (`imob-<id>` para a 1ª, `imob-<id>-<base36>` para as demais) com um `rotulo`; passar `{id}` reconecta.
  `PATCH /sessoes/:id {rotulo}` renomeia.
- Webhook: `@lid` → número real em `payload._data.Info.SenderAlt`. O webhook carimba
  `lead.sessaoWhatsappId` na criação e faz backfill.
- Mensagens podem ser filtradas por número no CRM.
- Sem `WAHA_URL`/`WAHA_API_KEY` configurados, o modo "número central" fica só visual.

## 10. Captação de leads

- **Site:** `POST /api/captacao/site` (segredo `CAPTACAO_SECRET`).
- **Facebook:** `POST /api/captacao/facebook` — aceita `imobiliariaId` **opcional** no corpo (se
  omitido, cai pra primeira/única imobiliária do banco) + `imovelId`, `mensagem`, `interesse`,
  `finalidade`. `criarLead` é compartilhada e faz a denormalização do imóvel.
- **Neste deploy**, quem chama esse endpoint é um workflow n8n dedicado
  (`HINODE - FACEBOOK FORM - CAPTAÇÃO LEADS`, `form_id` fixo, busca via Graph API a cada 5 min) —
  **não** manda `imobiliariaId` (nem precisa, só existe uma).
- **Integrações Facebook** (`server/src/routes/integracoes.ts`, tela `Integracoes.tsx`): cada
  imobiliária pode colar o próprio token do Graph API + page id + form id (cifrado em repouso,
  AES-256-GCM, `INTEGRACOES_ENC_KEY`); a automação leria `GET /api/integracoes/facebook/ativas`
  (segredo `INTEGRACOES_SECRET`) e faria polling de todas as imobiliárias num workflow só — esse é o
  desenho pra uma versão multi-tenant vendável do CRM (outro projeto,
  `github.com/balbiss/CRM_FORMULARIO_META`). **Não usado neste deploy**: `INTEGRACOES_SECRET` fica
  sem valor, a seção "Facebook Lead Ads" da tela de Integrações mostra "nenhuma conexão" — não afeta
  o fluxo real, que já funciona via o workflow n8n fixo acima.

## 11. Upload de arquivos (MinIO)

- Binário nunca vai pro Postgres — só a URL. `POST /api/uploads` (multipart, campo `file`, imagem/
  vídeo/áudio/PDF) → `{ url, nome }`. Bucket criado no boot (`ensureBucket`).
- Em produção é só apontar as variáveis `MINIO_*` para o MinIO real — nenhum código muda.

## 12. Realtime (Socket.io)

Room por imobiliária. Eventos principais: `lead:created`, `lead:updated`, `roletas:mudou`,
`config:rebatidas`, `tarefa:mudou`, `tarefa:venceu`, `followup:mudou`, `mensagem:created`,
`perfil:criado`/`atualizado`/`removido`. O front faz upsert local sem recarregar.

## 13. Painel Plataforma (`/plataforma`) — dormente neste deploy

Feito pra um dono de SaaS gerenciar várias imobiliárias clientes (criar, suspender, cobrança). Rotas
irmãs (não aninhadas) no `main.tsx`, auth própria (`admins_plataforma`, não confunde com `perfis` do
tenant), `bootstrapAdminPlataforma()` só cria o admin inicial se `PLATFORM_ADMIN_EMAIL`/
`PLATFORM_ADMIN_PASSWORD` estiverem setados. **Neste deploy essas env vars ficam vazias de propósito**
— a tela `/plataforma/login` continua acessível (rota pública), mas login nunca funciona (nenhum admin
existe). Zero risco, zero efeito no resto do app — nunca configurar essas variáveis aqui.

## 14. Migrações (Drizzle)

- Alterou `server/src/db/schema.ts` → `cd server && npm run db:generate` gera o SQL em
  `server/drizzle/` → `npm run db:migrate` aplica.
- Em produção o `CMD` do container roda `npm run db:migrate` **antes** de subir o servidor.
- Migração hand-editada: `0021_zippy_dakota_north.sql` tem INSERT/UPDATE de dados (cria a roleta
  "Geral" para imobiliárias existentes e liga os membros) antes do índice único.
- Migrações relevantes recentes: 0019 (reforma do follow-up), 0020 (`sites` + `imoveis.publicarNoSite`),
  0021 (roletas + finalidade), 0022 (`leads.imovelInteresseId`), 0023 (`imobiliarias.limiteRebatidasDia`).

## 15. Dados de demonstração (seed) vs. dado real de produção

- `npm run db:seed` é **destrutivo** (limpa as tabelas). Cria a imobiliária "Hinode Imóveis", 7 perfis
  de demonstração (dono `hinodeimoveis.crm@gmail.com` / `280896Ab@`; demais `123456`), 7 colunas,
  roleta "Geral", 10 leads, 6 imóveis, links úteis. **Só pra dev local — nunca rodar em produção.**
- **Produção não usa o seed de demonstração.** Tem dado real, importado à parte da produção original
  (CRM OKA): 12 perfis reais da equipe Hinode + os leads reais (preservando corretor/coluna/campanha
  de origem). Ver `server/src/db/importar-oka.ts` (migração completa v1→v2, idempotente por `oka_id`, token via env, nunca commitado
  com segredo) e `docs/INSTALACAO.md` §5.

## 16. Gotchas (para não repetir)

- **`npm run build` de verdade** pega erros que `tsc --noEmit` deixa passar (project references).
- **PWA `autoUpdate`:** depois de um deploy, o usuário precisa dar hard-refresh para pegar o JS novo.
  Preferir responsividade em JS a depender de media query (o cache serve CSS velho).
- **Dev local:** processos `tsx watch` órfãos de sessões antigas continuam rodando as varreduras de
  60s (follow-up/tarefas) e podem "roubar" execuções pendentes — matar todos antes de testar sweeps.
- **`VITE_API_URL=""`** (path relativo) exige `??`, não `||` (string vazia é falsy).
- **Nome de serviço Docker com `_`** quebra o SDK S3 do MinIO ("invalid hostname") — usar hífen.
- **Índice em toda coluna de FK** desde a 1ª migração (Postgres não indexa FK sozinho).

## 17. Convenção

Manter este arquivo e [`INSTALACAO.md`](INSTALACAO.md) atualizados a cada mudança relevante (feature,
decisão de arquitetura, regra de negócio, bug corrigido) — instrução permanente do dono.

## 18. Atualização de outubro/2026 — funções trazidas do Visita IA CRM v2

Em 19/10/2026 o código do Visita IA CRM v2 (repo `CRM_META_IA_VISITA_IA_V2`, mesma base deste CRM)
foi copiado pra cá, mantendo a marca Hinode Imóveis (laranja/carvão, ícones, textos), o deploy
Portainer/GHCR e os ajustes que só existiam aqui (lotes de "Carregar mais" no Kanban/Bolsão,
contador "entraram hoje/ontem" no Bolsão e o Relatório por corretor, agora em
`src/components/RelatorioCorretor.tsx` + `GET /api/relatorios/corretor`). Os dois repositórios
continuam independentes: nada é sincronizado sozinho.

Migrações novas: `0024` a `0044` (só tabelas novas e colunas que aceitam vazio ou têm padrão).
Ensaiadas antes numa cópia local com os 10 mil leads importados do CRM OKA.

O que entrou (detalhe de uso em `docs/MANUAL_FUNCOES.md`; detalhe dos fluxos n8n em `n8n/README.md`):

| Função | Onde no código | Precisa de configuração no servidor |
|---|---|---|
| Agente de IA (SDR): atende, qualifica, entende áudio, manda catálogo com fotos, só então roleta | `lib/agenteIa.ts`, `lib/catalogoIa.ts`, `routes/agenteIa.ts`, tela `/agente-ia` | `N8N_AGENTE_IA_WEBHOOK_URL`, `N8N_AGENTE_IA_TRANSCRICAO_URL`, `N8N_AGENTE_IA_SECRET` + liberar a imobiliária (`imobiliarias.ia_liberada`) |
| Assistente de voz (Gemini Live): consulta, navega, configura o CRM por voz, câmera | `lib/assistente.ts`, `routes/assistente.ts`, `src/components/assistente/`, `src/lib/assistente/` | `GEMINI_API_KEY` + liberar (`imobiliarias.assistente_liberado`) |
| WhatsApp API oficial híbrida (oficial + não oficial no mesmo número central), modelos | `lib/whatsappOficial.ts`, `routes/whatsappOficial.ts`, `components/WhatsappOficial.tsx` | `WA_APP_ID`, `WA_APP_SECRET`, `WA_CONFIG_ID`, `HUB_WA_KEY` + sistema cadastrado no hub |
| Conectar com Facebook (leads em tempo real pelo hub agencia.inoovaweb.com.br) | `lib/facebook.ts`, `lib/facebookSaude.ts`, `routes/facebookWebhook.ts`, `routes/integracoes.ts` | `FB_APP_ID`, `FB_APP_SECRET`, `FB_VERIFY_TOKEN`, `HUB_LEADS_URL`, `HUB_LEADS_KEY`, `FRONTEND_URL` |
| Aviso de lead no WhatsApp pessoal do corretor + histórico | `routes/avisosCorretor.ts`, tela `/avisos-corretor` | `N8N_AVISO_CORRETOR_WEBHOOK_URL`, `N8N_AVISO_RESULTADO_SECRET` |
| WhatsApp de cada corretor: número desconhecido vira "contato pendente" | `routes/contatosWhatsapp.ts`, `components/ContatosPendentes.tsx` | — |
| Importar planilha (Excel/CSV) com lote guardado e distribuição | `routes/importacoes.ts`, tela `/importacoes` | — |
| Lead repetido vira recadastro no mesmo card; etiqueta "Fora do horário"; data/hora de entrada | `routes/captacao.ts`, `lib/telefone.ts`, `lib/foraDoHorario.ts` | — |
| Recusas da roleta no histórico + Relatórios completos por período | `routes/relatorios.ts`, `lib/roleta.ts` | — |
| Várias caixas de entrada (números centrais), IA por número | `lib/numeros.ts` | — |
| Ajustes salvam no servidor (perfil, senha, imobiliária, uso) | `routes/config.ts`, `pages/Configuracoes.tsx` | — |

Sem as variáveis da última coluna, a função correspondente fica desligada sem quebrar nada
(ex.: sem `N8N_AGENTE_IA_WEBHOOK_URL` o lead vai direto pra roleta, como antes).

## 2026-11-02 — Relatórios iguais à v1, roleta com check-in e liberação do dono, card em blocos

**Relatórios** (`pages/Relatorios.tsx`, `components/relatorios/ui.tsx`, `routes/relatoriosOka.ts`, `routes/relatorios.ts`, `lib/filtroRelatorio.ts`)
- Filtros da v1: mês OU intervalo (de/até), cidade (bairro de interesse, sem diferenciar acento), corretor (gestão) e
  várias campanhas (busca + "Marcar todas"). Valem pra tela toda, menos o Relatório de Campanhas (compara todas) e o
  Relatório individual (período próprio). "Origem" = campanha do lead ou, sem campanha, o canal.
- Seções: Visão geral · Funil e etapas (funil completo clicável → `GET /api/relatorios-oka/leads` → abre o card) ·
  Equipe (ranking, atendimento da roleta, recusas, rebatidas do dia) · Origem e campanhas (volume, temperatura,
  campanhas com % por etapa, aprovação de crédito, gasto/CAC, por dia, horário, canais) · Pós-atendimento · Individual.
- **Ranking de consultores conta a atividade do período** (a v1 zerava rebatidas/etapas porque só olhava leads
  criados no período e a coluna atual). Base: tabela `lead_etapas`, gravada por TRIGGER no banco a cada mudança de
  coluna/corretor (migração 0050), + eventos da v1 importada + `distribuicao_log` (rebatida puxada).
  `importar-oka` desliga o trigger durante a carga pra não criar histórico falso.

**Roleta** (`lib/roletaOka.ts`, `routes/filas.ts`, `routes/roletas.ts`, `pages/Roleta.tsx`) — migração 0051
- `perfis.checkin_em`: hora em que ficou online (mostrado como "Check-in" na Ordem de prioridade).
- `perfis.plantao_liberado_ate`: fora do expediente SÓ o dono coloca alguém online; vale até 00:00. Enquanto vale,
  o desligamento automático não derruba e a roleta entrega lead só pra quem foi liberado; à meia-noite sai sozinho.
- Dono/gerente ligando OUTRO corretor não gera advertência de "depois das 14h".
- Tela: Ordem de prioridade igual à v1 (posição, check-in, STATUS ONLINE/OFFLINE clicável, arrastar pra reordenar).
- Teste com relógio controlado: `server/src/db/teste-liberacao-dono.ts` (só roda em banco local).

**Card do lead** (`components/LeadDetalhesOka.tsx`): aba Detalhes em blocos sem título, azul claro / branco
alternados (cores `--blocoAzul`/`--blocoAzulBorda`): contato · próximo contato e compromisso · cadência e status do
Kanban · financeiro · transferir/venda/devolver · documentos e perfil do interesse.

**Dashboard — "Leads que entraram"** (`components/LeadsEntraram.tsx`, só dono/gerente): quem chegou hoje e ontem
(fuso de Brasília) com hora, campanha/canal, cidade, etapa e corretor; resumo Entraram / Com corretor / Sem corretor /
Devolvidos; "Sem corretor" filtra a lista e "Distribuir agora" leva ao Bolsão (aba Leads Novos). Substitui com mais
detalhe o cartão "Leads Novos (Hoje + Ontem)" da v1. Usa os leads já carregados no navegador.
Também: funil completo dos Relatórios redesenhado (só etapas com lead em linhas, zeradas em etiquetas, venda separada).

## 2026-11-02 — WAHA próprio da v2 (GOWS)

- Stack Portainer `waha-hinode` (Id 36, .cloud), arquivo em `deploy/waha-hinode.yml` (senhas via variáveis da stack,
  não ficam no repo). Imagem `devlikeapro/waha:latest-2026.10.1`, motor **GOWS** (sem navegador, ~100–200 MB por número),
  limite 1 GB, rede `inoovaweb`, sem domínio público.
- Backend da v2: `WAHA_URL=http://waha-hinode_waha:3000`, `WAHA_API_KEY` própria, `WAHA_ENGINE=GOWS`.
- Separado do `waha-oka` (stack 34, WEBJS), que continua atendendo o CRM OKA (v1) — um não derruba mais o outro.
- Motivo: WEBJS abre um Chromium por número (~700 MB) e não cabe a equipe toda na VPS; a 2026.10.1 trouxe correções
  de @lid no GOWS (o bug "no LID found" de setembro). EM TESTE: conectar um número de teste, mandar/receber texto,
  áudio e foto. Se falhar, voltar as 3 variáveis do backend pro waha-oka.

## 2026-11-02 — Senhas e avatar no Kanban

- **Redefinir senha** (Equipe, dono/gerente; gerente só de corretor; ninguém a própria): `POST /api/perfis/:id/redefinir-senha`
  com `{senha?}` — sem senha gera uma fácil de ditar (`hin` + 5, sem 0/O/1/l). Janela mostra a senha uma vez + "Copiar
  mensagem pronta pro WhatsApp".
- **Senha provisória** (`perfis.senha_provisoria`, migração 0052): marcada ao redefinir e ao convidar membro (123456).
  Login e `/me` devolvem `senhaProvisoria`; o front abre "Crie sua senha" obrigatório (não fecha, só "Sair").
  `PATCH /api/auth/senha` limpa a marca e recusa senha nova igual à atual.
- **Meu perfil** (`components/MeuPerfil.tsx`): qualquer papel troca a própria senha clicando no nome (barra lateral) ou
  em "Meu perfil e senha" no menu do topo. "Ajustes" some do menu do topo pra corretor (já era só gestão).
- Kanban usa o mesmo avatar por origem do card (`ChatAvatar` com `canal`); `LeadAvatar` removido.

## 2026-11-02 — Criativos dos anúncios a partir do Google Drive

- `imobiliarias.criativos_pasta_url` (migração 0053). Tela Campanhas → "Pasta de criativos no Google Drive" (dono/gerente).
- `lib/criativos.ts`: lê a pasta pública pela listagem `drive.google.com/embeddedfolderview` (sem login nem chave de API),
  com subpastas (3 níveis, 800 arquivos), cache 10 min. Casa lead ↔ arquivo pelo nome do anúncio: sem acento/espaço/
  extensão, tira `Importação (ID: …)`, o que vem depois de `|` e ` - AD3`; igual, ou o arquivo mais longo que é começo do nome.
  Teste com a pasta real da Hinode: 104 arquivos, 92% dos leads dos últimos 30 dias com criativo.
- Miniaturas: o Google responde 429 quando o navegador pede várias a partir de outro site → o servidor baixa uma vez e
  guarda no MinIO (`criativos/<id>.jpg`); a tela usa `GET /api/criativos/miniatura/:id` (público, só ids das pastas conectadas).
  Vídeo toca no player do Drive (`/file/d/<id>/preview`).
- Robô: toda meia-noite (Brasília) e 2 min após o boot relê as pastas e guarda as miniaturas novas.
- `GET /api/criativos/lead/:id` (bloco "Anúncio que trouxe esse lead" no card), `POST /api/criativos/casar` (Campanhas).
- Facebook: `campanha` do lead passou a ser o NOME DO ANÚNCIO (`ad_name || campaign_name`), igual à v1.

## 2026-11-02 — Follow-up com {criativo} e "Responder" mensagem no chat

- **`{criativo}` no follow-up** (`lib/followup.ts` → `criativoParaLead` em `lib/criativos.ts`): o passo com `{criativo}`
  manda a imagem do anúncio de onde o lead veio (casa `lead.campanha` com a pasta do Drive, igual ao card). A imagem sai do
  MinIO (`criativos/envio/<id>.jpg`, Drive `thumbnail?sz=w1600`, baixada 1x); criativo em vídeo → manda a capa. Sem criativo:
  vai só o texto; passo só com `{criativo}` e sem criativo é **pulado** (`registrarEnvio(..., pulado=true)` não conta chamada
  nem ritmo). Editor: botão "Inserir criativo da campanha" + OBS com passo a passo (`AvisoCriativo` em `pages/Followup.tsx`).
- **Responder mensagem**: coluna `mensagens_whatsapp.resposta_a` (migração 0054, FK pra própria tabela, set null).
  `POST /api/mensagens/:leadId` aceita `respostaA` (precisa ser da mesma conversa) e manda citado:
  oficial = `context.message_id` (só se a citada tiver wamid); WAHA = `reply_to` (id WAHA, ou montado
  `true|false_<chatId>_<chave>` quando a citada entrou pela oficial). Recebidas: WAHA `replyTo.id`/`contextInfo.stanzaID`,
  oficial `context.id` → acha a citada pelo `wa_message_id` ou `wa_chave`.
  Front: `components/RespostaMensagem.tsx` (2 cliques no balão / setinha; barra "Respondendo…"; citação clicável) nas
  Conversas e no chat do card; estado `respondendo` no store, `enviarMensagem` anexa sozinho (texto, anexo, áudio, prontas).

## 2026-11-02 — Pedidos do dono: follow-up a partir de um passo, valores do APROVADO, editor maior

- **Follow-up a partir de um passo**: `POST /api/followup/execucoes` aceita `passoInicial` (0 = 1º passo; de um passo do
  meio sai em `janelaEnvio(agora)`); `PATCH /api/followup/execucoes/:id` com `status: 'ativa'` aceita `passo` (retomar
  em outro passo). Iniciar fecha qualquer régua **pausada** do lead antes. `GET /api/followup/execucoes/lead/:leadId/ultima`
  devolve a última régua (mesmo encerrada) — o card sugere continuar do passo seguinte ao último enviado (caso "cliente
  respondeu → corretor conversou → cliente sumiu de novo"). Front: `components/FollowupDoLead.tsx` (aba Follow-up do card).
- **APROVADO pede valores**: colunas `leads.aprovado_financiamento/subsidio/fgts/aprovado_em` (migração 0055).
  `PATCH /api/leads/:id/mover` pra coluna slug `aprovado` sem `valorFinanciamento` → 409 `motivo: 'aprovado'`; o
  modal (`ModaisRegrasOka`) pede Financiamento (obrigatório), Subsídio, FGTS + próximo contato (dispensa a data se o card
  já tem um no futuro). Evento no Histórico: "Movido para APROVADO — Financiamento R$ X · Subsídio R$ Y · FGTS R$ Z".
  Card mostra o bloco "Valores aprovados" (`LeadDetalhesOka`). Só a rota de mover tem a trava.
- **Editor de follow-up**: título "PASSO N" em cada passo; texto e legenda (antes legenda era campo de 1 linha) em caixa
  que cresce com o conteúdo (`TextoQueCresce` em `pages/Followup.tsx`).

## 2026-11-02 — Horário de cada passo do follow-up (pedido do dono)

- `followup_passos.hora_envio` ("HH:MM" Brasília, 08:00–20:00; migração 0056). Vazio = regra antiga (encaixa nas levas).
- `vencimentoComHora` / `vencimentoDoPasso` em `lib/followup.ts`: com hora, o passo sai no dia do atraso ("1 dia depois"
  = dia seguinte) exatamente nessa hora; hoje já passou → amanhã; domingo → segunda. Iniciar/retomar direto num passo com
  hora usa a próxima ocorrência dela. `escolherLote` deixa passar fora das levas quando o passo tem hora.
- Editor: select "Horário" em cada passo (`HORAS_ENVIO`), `atrasoTexto` vira ex. "1 dia depois às 10:30". OBS do
  {criativo} explica que pode ir em qualquer passo.

## 2026-11-11 — Conector do Claude (MCP) pro dono/gerente

Pedido do dono (plano Claude Pro): consultar o CRM conversando, pelo Claude Code ou claude.ai. Port do conector da v1
(`server/src/routes/mcp.js` do CRM OKA), adaptado pra v2.

- **Onde:** `server/src/routes/mcp.ts`, montado na raiz do backend (`app.use(mcpRouter)` em `index.ts`). Domínio próprio
  (`MCP_PUBLIC_URL`, padrão `https://mcp-v2.inoovaweb.cloud`) roteado pelo Traefik direto pro backend (todas as rotas):
  `/mcp`, `/oauth/register|authorize|token`, `/.well-known/oauth-protected-resource[/mcp]`,
  `/.well-known/oauth-authorization-server`. DNS com hífen: subdomínio com "_" não ganha certificado.
- **Login:** OAuth 2.1 próprio (registro dinâmico RFC 7591, PKCE S256 obrigatório, access 1h, refresh 30 dias que troca a
  cada uso). Tela de login valida e-mail/senha do CRM com bcrypt (igual `/api/auth/login`), 8 erros por IP+e-mail a cada
  15 min = bloqueio temporário. Só **dono/gerente**, não bloqueado, não removido, imobiliária ativa — reconferido em TODA
  chamada (`perfilLiberado`), então bloquear em Equipe corta na hora. Tabelas `mcp_oauth_clientes/codigos/tokens`
  (migration 0058), tokens guardados só como sha256. Revogar tudo de alguém: `update mcp_oauth_tokens set revogado_em = now()
  where perfil_id = ...`.
- **8 ferramentas, só leitura:** resumo_do_periodo, desempenho_dos_corretores, campanhas, follow_up_automatico,
  carteira_atual, buscar_lead, aprovacoes_pendentes, agenda. As de relatório/aprovações/compromissos chamam por dentro
  (`http://127.0.0.1:PORT`) as MESMAS rotas das telas (`/api/relatorios`, `/api/relatorios-oka`, `/api/aprovacoes`,
  `/api/compromissos`) com um JWT de 2 min no nome de quem logou → números iguais à tela Relatórios. carteira_atual,
  buscar_lead, fluxos de follow-up e visitas da agenda são SQL direto, sempre filtrado pela imobiliária do usuário.
  Filtro opcional `corretor` (por nome, parcial).
- **Teste:** `mcptest.mjs` (30 checagens: 401 sem token, metadados, registro, login errado, corretor barrado, PKCE,
  code de uso único, initialize, 8 tools, refresh rotativo) — passou local (PGlite + seed).
- Manual: item "Perguntar ao Claude sobre o CRM (conector MCP)".

## 2026-11-12 — Lead com 2 telefones ("confirme o seu telefone")

Dono: na v1 o card mostra os 2 números do formulário; na v2 só aparecia um. O formulário da Meta da Hinode tem a
pergunta "confirme o seu telefone"; a v2 só reconhecia campos com nome padrão (phone_number/telefone/whatsapp) e
mandava esse pro histórico ("Respostas do formulário: ...").
- `lib/facebook.ts` `mapearCampos`: 2º campo com cara de telefone (nome com telefone/phone/celular/whats/contato/confirm
  e valor só com 10–13 dígitos) vira `telefoneAlternativo` quando é número diferente do principal (`mesmoNumero`). Sem
  telefone principal, ele vira o principal.
- `criarLead` grava `telefoneAlternativo`; no recadastro, número novo que o card não tem vira alternativo (se vazio).
  Rota n8n `/api/captacao/facebook` aceita `telefoneAlternativo`.
- Migration 0059 (backfill): preenche o alternativo a partir do histórico "confirme o seu telefone: N" dos leads que já
  entraram (6 de 53 em produção tinham número diferente).
- Card (`LeadDetalhesOka`): botão "Trocar com o principal" abaixo do alternativo (troca os dois numa chamada só).
- Mesmo dia, v1: o botão "Usar este" copiava o 2º número pro principal e o principal sumia; agora troca os dois.

## 2026-11-13 — Pedidos do dono no 1º dia da v2 oficial

- **WhatsApp acha o lead na imobiliária inteira** (`routes/whatsapp.ts` `processarMensagem`): igual à v1
  (`buscar_lead_por_telefone`). Busca por últimos 8 dígitos + `mesmoNumero`; prefere o lead de quem conectou o número,
  senão o que já existe (ativo antes de descartado, mais recente). Lead de outra pessoa/sem corretor → a conversa entra
  NESSE card + aviso "Possível duplicidade" pro dono/gerente. Antes criava card "de WhatsApp" duplicado sem campanha
  (9 casos na 1ª noite: WhatsApp do Oka estava no perfil "Oka corretor" e os leads no "Oka" dono). `sessaoWhatsappId`
  só é preso quando o número é de quem cuida do card.
- **Higienização** (v1 `mensagens_select_por_papel` / `interacoes_select`): corretor só vê mensagens
  (`GET /api/mensagens`, `/api/mensagens/:leadId`) e histórico (`GET /api/leads/:id/eventos`) a partir de
  `coalesce(data_atribuicao, criado_em)`; no histórico, `criado` e `formulario` sempre aparecem. Dono/gerente veem tudo.
- **Data das mensagens**: "Hoje/Ontem" contava períodos de 24h (`floor((agora - data)/24h)`) → mensagem de ontem 17h vista
  hoje 10h aparecia "Hoje". Novo `diasAtras()` em `lib/format.ts` conta dias de calendário (chat e lista de Conversas).
- **Agenda**: busca por nome/telefone na aba Tarefas; Calendário só com visitas/FID e compromissos da equipe.
