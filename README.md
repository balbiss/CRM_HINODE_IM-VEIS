# CRM Hinode

CRM imobiliário sob medida pra Hinode Imóveis: funil de leads em Kanban, roleta de distribuição
automática entre corretores, follow-up de WhatsApp, análise de crédito, catálogo de imóveis, site
público de imóveis, captação de leads do Facebook/site, etiquetas, tarefas/agenda e histórico do lead.

- **Frontend** (`/`): Vite + React 19 + TypeScript + Zustand + Socket.io-client, PWA.
- **Backend** (`server/`): Node + Express + TypeScript, Drizzle ORM + PostgreSQL, Socket.io, MinIO (S3) para arquivos.
- **WhatsApp**: [WAHA](https://waha.devlike.pro/) (engine GOWS). Opcional — sem ele o CRM funciona, só não envia/recebe no WhatsApp.
- **Produção**: `https://hinode.inoovaweb.com.br` (deploy via GitHub Actions + Docker Swarm/Portainer).

## Documentação

| Documento | Assunto |
|---|---|
| [`docs/DOCUMENTACAO_CRM.md`](docs/DOCUMENTACAO_CRM.md) | Como o CRM funciona: arquitetura, módulos, regras de negócio, papéis de acesso |
| [`docs/INSTALACAO.md`](docs/INSTALACAO.md) | O que é preciso e como instalar (dev local e produção) |

## Início rápido (desenvolvimento local)

Pré-requisitos: **Node 22+**, **Docker** (para Postgres + MinIO).

```bash
# 1. Postgres + MinIO
docker compose up -d

# 2. Backend
cd server
cp .env.example .env            # ajuste os segredos
npm install
npm run db:migrate              # cria/atualiza o schema
npm run db:seed                 # imobiliária + contas + dados de demonstração
npm run dev                     # http://localhost:3001

# 3. Frontend (outro terminal, na raiz)
npm install
npm run dev                     # http://localhost:5173
```

Detalhes completos (variáveis de ambiente, WAHA, deploy em produção, migrações) em
[`docs/INSTALACAO.md`](docs/INSTALACAO.md).

## Scripts

**Frontend** (raiz): `npm run dev` · `npm run build` (`tsc -b && vite build`) · `npm run lint` (oxlint) · `npm run preview`

**Backend** (`server/`): `npm run dev` (tsx watch) · `npm run build` (`tsc`) · `npm start` · `npm run db:generate` (gera migração a partir do schema) · `npm run db:migrate` · `npm run db:seed`
