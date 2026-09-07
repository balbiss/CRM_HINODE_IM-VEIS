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
  de origem). Ver `server/src/db/import-oka-leads.ts` (script pontual, token via env, nunca commitado
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
