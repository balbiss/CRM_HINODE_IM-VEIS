# Instalação — CRM Hinode

Cobre o que é preciso, como rodar em **desenvolvimento local** e como fazer **deploy em produção**.
Visão geral da arquitetura em [`DOCUMENTACAO_CRM.md`](DOCUMENTACAO_CRM.md).

---

## 1. O que é preciso

| Componente | Versão | Para quê | Obrigatório? |
|---|---|---|---|
| **Node.js** | 22+ | frontend e backend | ✅ |
| **PostgreSQL** | 16 | banco de dados | ✅ |
| **MinIO** (ou outro S3) | qualquer | imagens/vídeo/áudio/PDF | ✅ (upload quebra sem ele) |
| **Docker + Docker Compose** | recente | subir Postgres + MinIO em dev | ✅ em dev (em prod é serviço próprio no Swarm) |
| **WAHA** | `devlikeapro/waha`, engine GOWS | enviar/receber WhatsApp | ⬜ opcional — o CRM roda sem, só não usa WhatsApp |
| **n8n** | community | captação de leads do Facebook | ⬜ opcional (já existe workflow ativo em produção) |
| `ffmpeg` | — | converter áudio do navegador p/ nota de voz do WhatsApp | já vem no `server/Dockerfile`; em dev, instalar se for testar áudio |

## 2. Desenvolvimento local

### 2.1 Subir Postgres + MinIO

```bash
docker compose up -d
```

`docker-compose.yml` expõe:
- Postgres em **`localhost:55432`** (user `nova`, senha `nova_dev_local`, db `nova_app`)
- MinIO API em **`localhost:59000`**, console em **`localhost:59001`** (user `nova_minio`, senha `nova_dev_local_minio`)

### 2.2 Backend

```bash
cd server
cp .env.example .env
npm install
npm run db:migrate     # aplica todas as migrações de server/drizzle/
npm run db:seed        # OPCIONAL: cria imobiliária + contas + dados de demonstração (DESTRUTIVO)
npm run dev            # http://localhost:3001  (tsx watch, reinicia ao salvar)
```

`.env` mínimo para dev:

```env
DATABASE_URL=postgres://nova:nova_dev_local@localhost:55432/nova_app
JWT_SECRET=qualquer-coisa-local
JWT_EXPIRES_IN=8h
PORT=3001
CORS_ORIGIN=http://localhost:5173

MINIO_ENDPOINT=http://localhost:59000
MINIO_ACCESS_KEY=nova_minio
MINIO_SECRET_KEY=nova_dev_local_minio
MINIO_BUCKET=hinode-imoveis
MINIO_PUBLIC_URL=http://localhost:59000/hinode-imoveis

CAPTACAO_SECRET=dev-secret
# deixados vazios de propósito — o CRM Hinode usa o workflow n8n já existente (form_id fixo),
# não o fluxo dinâmico multi-tenant de Integrações
INTEGRACOES_SECRET=
INTEGRACOES_ENC_KEY=      # gere: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"

# opcionais em dev — em produção o WAHA fica configurado (reaproveita o waha-oka.inoovaweb.cloud
# já usado pelo CRM OKA)
WAHA_URL=
WAHA_API_KEY=
PUBLIC_URL=
WAHA_WEBHOOK_SECRET=

# painel "Plataforma" (/plataforma) — deixado sem admin de propósito, é dormente pra este cliente
PLATFORM_ADMIN_EMAIL=
PLATFORM_ADMIN_PASSWORD=
PLATFORM_ADMIN_NAME=Administrador
```

### 2.3 Frontend

```bash
# na raiz do repo, outro terminal
npm install
npm run dev     # http://localhost:5173
```

O frontend lê `VITE_API_URL` (default `http://localhost:3001`) em `src/lib/api.ts`. Em dev não precisa
setar nada.

### 2.4 Contas criadas pelo seed de demonstração

O `db:seed` cria dados fictícios pra testar a interface localmente (não usar em produção — a
produção já tem dado real da equipe e dos leads da Hinode, importado à parte, ver seção 5).

| Papel | Email | Senha |
|---|---|---|
| Dono | `hinodeimoveis.crm@gmail.com` | `280896Ab@` |
| Gerente / Corretores de demonstração | `<nome>@novaimob.com.br` | `123456` |

O painel Plataforma (`/plataforma`) usa a conta de `PLATFORM_ADMIN_EMAIL`/`PLATFORM_ADMIN_PASSWORD`
(criada no boot se a tabela estiver vazia) — não configurado em produção de propósito.

## 3. Variáveis de ambiente (referência)

### Backend (`server/.env`)

| Variável | Obrigatória | Descrição |
|---|---|---|
| `DATABASE_URL` | ✅ | string de conexão Postgres |
| `JWT_SECRET` | ✅ | segredo de assinatura dos tokens |
| `JWT_EXPIRES_IN` | ⬜ | default `8h` |
| `PORT` | ⬜ | default `3001` |
| `CORS_ORIGIN` | ✅ | origem do frontend (ex: `https://hinode.inoovaweb.com.br`) |
| `MINIO_ENDPOINT` | ✅ | URL da API do MinIO/S3 |
| `MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY` | ✅ | credenciais |
| `MINIO_BUCKET` | ✅ | nome do bucket (criado no boot) |
| `MINIO_PUBLIC_URL` | ✅ | URL pública base dos arquivos |
| `CAPTACAO_SECRET` | ✅ | header `x-captacao-secret` das rotas `/api/captacao/*` (usado pelo workflow n8n de produção) |
| `INTEGRACOES_SECRET` | ⬜ | protege `GET /api/integracoes/facebook/ativas` — não usado neste deploy (fluxo n8n fixo, não dinâmico) |
| `INTEGRACOES_ENC_KEY` | ⬜ | AES-256-GCM base64 (32 bytes) — cifra o token do Facebook em repouso; mantido configurado só pra tela de Integrações não quebrar se alguém clicar |
| `WAHA_URL` | ⬜ | base da instância WAHA (produção: `https://waha-oka.inoovaweb.cloud`, compartilhada com o CRM OKA) |
| `WAHA_API_KEY` | ⬜ | `X-Api-Key` da instância |
| `PUBLIC_URL` | ⬜ | URL pública **deste backend** (o WAHA chama o webhook aqui) |
| `WAHA_WEBHOOK_SECRET` | ⬜ | segredo do webhook (`?secret=`); vazio = usa `CAPTACAO_SECRET` |
| `PLATFORM_ADMIN_EMAIL` / `PLATFORM_ADMIN_PASSWORD` / `PLATFORM_ADMIN_NAME` | ⬜ | admin inicial do painel Plataforma — não configurado neste deploy (dormente) |

### Frontend (build-time)

| Variável | Descrição |
|---|---|
| `VITE_API_URL` | URL do backend. Vazio (`""`) em produção — o front chama caminho relativo no mesmo domínio (Traefik roteia `/api`/`/socket.io` pro backend). **Cuidado**: código que lê essa var precisa usar `??`, não `\|\|` — string vazia é falsy em JS. |

## 4. Produção

Deploy via **GitHub Actions** (nunca build local) → imagens no GHCR → Docker Swarm (Portainer) na
mesma VPS do CRM OKA, roteado por Traefik.

### 4.1 Backend — `server/Dockerfile`

- `node:22-alpine` + `ffmpeg`, `npm ci`, `npm run build`, expõe `3001`.
- `CMD`: **`npm run db:migrate && node dist/index.js`** — as migrações rodam a cada deploy, antes do
  servidor subir.
- Imagem: `ghcr.io/balbiss/crm-hinode-backend:latest`.
- Rota Traefik: `Host(hinode.inoovaweb.com.br) && (PathPrefix(/api) || PathPrefix(/socket.io))` — **sem**
  stripprefix (o backend já espera `/api/...` no path).

### 4.2 Frontend — `Dockerfile` (raiz)

- Estágio build: `node:22-alpine`, `npm ci`, `ARG VITE_API_URL=""`, `npm run build`.
- Estágio final: `nginx:alpine` servindo `/dist` com `nginx.conf` (SPA fallback para `index.html`).
- Imagem: `ghcr.io/balbiss/crm-hinode-frontend:latest`.
- Rota Traefik: `Host(hinode.inoovaweb.com.br)` (catch-all, prioridade mais baixa que o backend).

### 4.3 Disparar deploy

Push em `main` → `.github/workflows/docker-publish-{frontend,backend}.yml` builda e publica
automaticamente. Depois, forçar o serviço Swarm a puxar a imagem nova (Portainer): pegar
`Version.Index` do serviço, tirar o `@sha256` fixo do `Image` (senão não repuxa `:latest`), incrementar
`TaskTemplate.ForceUpdate`, `POST /api/endpoints/1/docker/services/{id}/update?version=<Index>`.

### 4.4 Dependências de infra em produção

- **PostgreSQL**: container dedicado (`hinode_postgres`), isolado — não é o Postgres compartilhado do n8n.
- **MinIO**: container dedicado (`hinode-minio` — nome com **hífen**, não underscore: o AWS SDK/S3
  client rejeita hostname com underscore).
- **WAHA**: reaproveita `https://waha-oka.inoovaweb.cloud`, a mesma instância que já atende o CRM OKA
  (sessão própria, `escopo:'central'`, não confundir com as sessões dos corretores do OKA).
- **n8n**: workflow dedicado já ativo (`HINODE - FACEBOOK FORM - CAPTAÇÃO LEADS`, busca leads via
  Graph API a cada 5 min com `form_id` fixo) — **não** o fluxo dinâmico multi-tenant deste código
  (esse fica só disponível, não configurado, pra esse cliente).

## 5. Dado real de produção

A produção **não** roda com o `db:seed` de demonstração — usa dado real, importado à parte:
- 12 perfis reais da equipe (Dono + Gerente + 10 corretores).
- Leads reais importados do CRM OKA (produção original), preservando corretor/coluna/campanha.
- Novos leads chegam automaticamente pelo workflow n8n de captação do Facebook.

## 6. Comandos úteis

```bash
# gerar uma migração nova depois de editar server/src/db/schema.ts
cd server && npm run db:generate && npm run db:migrate

# build local de verificação (pega erros que o tsc solto não pega)
npm run build                 # frontend (tsc -b && vite build)
cd server && npm run build    # backend (tsc)

# lint do frontend
npm run lint
```
