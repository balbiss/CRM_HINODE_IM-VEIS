# Fluxos n8n do CRM Hinode Imóveis — guia de instalação

Este diretório tem os **4 workflows do n8n** que o CRM usa, prontos pra importar, e tudo o que é
preciso pra instalar e configurar numa instância nova. Foi escrito pra que uma pessoa técnica **ou
outra IA** consiga seguir do zero, sem contexto anterior.

> **Nenhum segredo está versionado.** Senhas, chaves e endereços aparecem como **marcadores**
> (`__ASSIM__`), que você troca antes de importar (passo 3). Nunca faça commit dos JSONs já
> preenchidos: o repositório é público.

---

## 1. Visão geral

| Arquivo | Workflow | Quem chama | O que faz |
|---|---|---|---|
| `fluxos/01-agente-ia-sdr.json` | Agente de IA (SDR) | backend do CRM, a cada rodada da conversa | Monta o prompt com a config da imobiliária + histórico, chama a OpenAI com saída JSON estrita e **devolve o JSON na mesma requisição** |
| `fluxos/02-agente-ia-transcrever-audio.json` | Transcrever áudio | backend do CRM, quando chega áudio num lead que a IA atende | Baixa o áudio e devolve o texto (OpenAI `gpt-4o-mini-transcribe`) |
| `fluxos/03-aviso-lead-corretor.json` | Aviso de lead ao corretor | roleta do CRM, se a imobiliária ligou "Avisar o corretor por WhatsApp" | Manda o lead pro celular do corretor pelo número central (WAHA) e reporta sucesso/erro ao CRM |
| `fluxos/04-captacao-facebook.json` | Captação Facebook (dinâmico) | agendado, a cada 5 min | Busca leads novos dos formulários da Meta de **todas** as imobiliárias e cria no CRM |

```
                       ┌──────────────── backend do CRM (Express) ────────────────┐
 WhatsApp ── WAHA ──►  │ webhook /api/whatsapp/webhook                             │
                       │   └─ lib/agenteIa.ts  ── POST ──► [01 Agente de IA]  ─────┼─► OpenAI
                       │        (decide TUDO)  ◄── JSON ──                         │
                       │   └─ áudio ─────────── POST ──► [02 Transcrever] ─────────┼─► OpenAI
                       │ lib/roleta.ts ──────── POST ──► [03 Aviso corretor] ──────┼─► WAHA ─► celular do corretor
                       │ /api/avisos-corretor/resultado ◄─── resultado ────────────┘
                       │ /api/integracoes/facebook/ativas ◄── [04 Captação] ───────┼─► Graph API (Meta)
                       │ /api/captacao/facebook ◄──────────── leads ──────────────┘
                       └──────────────────────────────────────────────────────────┘
```

**Regra de arquitetura (não quebrar):** o n8n só monta prompt, chama a OpenAI e devolve. **Quem
decide** (quando passar pra roleta, pra qual roleta, descartar, mandar foto, pausar) é o backend,
em `server/src/lib/agenteIa.ts`. O WhatsApp da conversa com o cliente também é enviado pelo backend,
nunca pelo n8n. Se a IA errar uma regra, a correção vai pro código, não pro prompt.

---

## 2. Pré-requisitos

- **n8n 1.x** (testado com webhook v2.1, HTTP Request v4.4/4.5, Code v2, If v2.3, Switch v3.4).
- **Backend do CRM** publicado e acessível por HTTPS (ex.: `https://api-v2.visitaia.com.br`).
- **WAHA** (WhatsApp HTTP API) com o número central da imobiliária conectado. Usado só pelo fluxo 03.
  O CRM manda no payload o `sessionName` do número certo (a imobiliária pode ter vários números — ver
  "Várias caixas de entrada" abaixo). Sem `sessionName` (versões antigas do CRM), o fluxo usa
  `imob-<imobiliariaId>`, que é o nome do 1º número central que o CRM cria na tela de Integrações.
- **Chave da OpenAI** (a do SaaS). Imobiliárias com "chave própria" mandam a delas a cada chamada.
- **App da Meta** com acesso aos formulários (token por conexão, cadastrado na tela de Integrações). Só pro fluxo 04.

---

## 3. Marcadores a trocar

| Marcador | Onde aparece | Valor | Precisa bater com (no backend) |
|---|---|---|---|
| `__SEGREDO_AGENTE_IA__` | fluxos 01 e 02 | uma string aleatória longa (`openssl rand -hex 16`) | env `N8N_AGENTE_IA_SECRET` (o backend manda no header `x-agente-secret`) |
| `__SEGREDO_AVISO_CORRETOR__` | fluxo 03 | string aleatória | o `?secret=` no final de `N8N_AVISO_CORRETOR_WEBHOOK_URL` |
| `__SEGREDO_RESULTADO_AVISO__` | fluxo 03 | string aleatória | env `N8N_AVISO_RESULTADO_SECRET` |
| `__URL_API_CRM__` | fluxos 03 e 04 | URL pública do backend, **sem barra no fim** (ex.: `https://api-v2.visitaia.com.br`) | — |
| `__URL_WAHA__` | fluxo 03 | URL do WAHA, sem barra no fim (ex.: `https://waha.visitaia.com.br`) | env `WAHA_URL` |

Trocando todos de uma vez, antes de importar (numa pasta **fora do git**):

```bash
mkdir -p /tmp/fluxos-preenchidos && cp n8n/fluxos/*.json /tmp/fluxos-preenchidos/
cd /tmp/fluxos-preenchidos
sed -i \
  -e 's|__SEGREDO_AGENTE_IA__|COLE_AQUI|g' \
  -e 's|__SEGREDO_AVISO_CORRETOR__|COLE_AQUI|g' \
  -e 's|__SEGREDO_RESULTADO_AVISO__|COLE_AQUI|g' \
  -e 's|__URL_API_CRM__|https://api-v2.exemplo.com.br|g' \
  -e 's|__URL_WAHA__|https://waha.exemplo.com.br|g' \
  *.json
grep -l '__[A-Z_]*__' *.json   # não pode listar nada
```

---

## 4. Credenciais no n8n

Crie antes de importar (**Credentials → Add credential**), com **exatamente estes nomes**, pra
importação já ligar sozinha. Se o nome for outro, é só escolher a credencial em cada nó depois.

| Nome da credencial | Tipo | Campos | Usada em |
|---|---|---|---|
| `OpenAI (chave do SaaS)` | OpenAI API | API Key = chave da OpenAI do SaaS | 01, 02 |
| `WAHA (X-Api-Key)` | Header Auth | Name `X-Api-Key`, Value = env `WAHA_API_KEY` do backend | 03 |
| `CRM — x-integracoes-secret` | Header Auth | Name `x-integracoes-secret`, Value = env `INTEGRACOES_SECRET` | 04 |
| `CRM — x-captacao-secret` | Header Auth | Name `x-captacao-secret`, Value = env `CAPTACAO_SECRET` | 04 |

---

## 5. Importar e publicar

1. **Workflows → Import from File** → escolha cada JSON **já preenchido** (passo 3).
   Pela linha de comando do servidor n8n também dá: `n8n import:workflow --input=arquivo.json`.
2. Abra cada workflow e confira que os nós com credencial estão ligados (ícone de alerta = sem credencial).
3. **Publique/ative** cada um (botão *Publish* / toggle *Active*). Webhook só responde em produção
   depois de publicado. **Toda edição depois disso fica em rascunho até publicar de novo.**
4. Anote as URLs de produção. Com `path` fixo, a URL é **só** `https://SEU-N8N/webhook/<path>`, sem
   o `webhookId` no meio (algumas telas/ferramentas mostram a URL com o id; essa versão dá 404):

| Fluxo | URL de produção |
|---|---|
| 01 | `https://SEU-N8N/webhook/hinode-agente-ia` |
| 02 | `https://SEU-N8N/webhook/hinode-transcrever-audio` |
| 03 | `https://SEU-N8N/webhook/hinode-aviso-corretor` |

---

## 6. Variáveis de ambiente do backend

No serviço do backend (Coolify/Portainer/`.env`), e depois **redeploy**:

| Variável | Valor |
|---|---|
| `N8N_AGENTE_IA_WEBHOOK_URL` | URL de produção do fluxo 01 |
| `N8N_AGENTE_IA_TRANSCRICAO_URL` | URL de produção do fluxo 02 |
| `N8N_AGENTE_IA_SECRET` | o mesmo valor de `__SEGREDO_AGENTE_IA__` |
| `N8N_AVISO_CORRETOR_WEBHOOK_URL` | URL do fluxo 03 **com** `?secret=` + valor de `__SEGREDO_AVISO_CORRETOR__` |
| `N8N_AVISO_RESULTADO_SECRET` | o mesmo valor de `__SEGREDO_RESULTADO_AVISO__` |
| `INTEGRACOES_SECRET`, `CAPTACAO_SECRET` | os mesmos valores das credenciais Header Auth do fluxo 04 |

Sem `N8N_AGENTE_IA_WEBHOOK_URL`, o agente fica desligado na prática: todo turno dá erro e o lead vai
direto pra roleta, sem cliente perdido. Sem `N8N_AGENTE_IA_TRANSCRICAO_URL`, áudio não é transcrito
e a IA pede pro cliente escrever. Sem `N8N_AVISO_CORRETOR_WEBHOOK_URL`, o aviso ao corretor não sai
(fica um evento "Webhook de aviso ao corretor não configurado" no lead).

Depois, no **painel da plataforma** (`/plataforma`) libere o Agente de IA pra imobiliária, e na tela
**Agente de IA** do CRM ligue e configure.

---

## 7. Contratos (o que entra e o que sai)

### 01 — Agente de IA

`POST` com header `x-agente-secret`. O backend monta isso em `rodarTurno()` (`server/src/lib/agenteIa.ts`).

```jsonc
{
  "evento": "mensagem",              // ou "primeiro_contato" (lead de formulário, a IA fala primeiro)
  "imobiliariaId": "uuid", "leadId": "uuid", "imobiliariaNome": "InoovaWeb Imóveis",
  "agente": {
    "nome": "Ana", "tom": "cordial|formal|descontraido", "apresentacao": "...", "instrucoesExtras": "...",
    "mensagemPassagem": "...", "modelo": "gpt-4.1-mini",
    "despedidaExplica": true, "consultaImoveis": true, "informarPreco": true
  },
  "perguntas": [{ "chave": "finalidade", "rotulo": "Finalidade", "pergunta": "...", "obrigatoria": true, "opcoes": ["Comprar", "Alugar"] }],
  "etiquetas": [{ "id": "uuid-da-tag", "nome": "Investidor", "quando": "..." }],
  "criterios": [{ "chave": "renda_baixa", "descricao": "...", "tentativa": "compor renda...", "tentativaFeita": false }],
  "dados": { "finalidade": "Comprar" },           // o que já se sabe (cliente, formulário ou imóvel escolhido)
  "faltando": ["regiao"],
  "lead": { "nome": "Maria", "canal": "Site", "imovel": "Apto 2 quartos no Marco", "regiaoTelefone": "DDD 91 (PA — Belém e região)" },
  "imoveis": [{ "codigo": "IM1", "titulo": "...", "finalidade": "Venda", "local": "...", "preco": 320000,
                "quartos": 2, "suites": 1, "vagas": 1, "area": 62, "destaques": ["..."], "situacao": "...",
                "aceitaFinanciamento": true, "qtdFotos": 3 }],   // até 3, escolhidos pelo CRM (lib/catalogoIa.ts)
  "historico": [{ "papel": "cliente|atendente", "texto": "..." }],   // últimas 20 (áudio vem como "[áudio]: ...")
  "openaiKey": null                  // string = chave própria da imobiliária; null = usa a credencial do SaaS
}
```

Resposta (síncrona, do nó "Devolver ao CRM"):

```jsonc
{
  "ok": true,
  "resposta": "texto pro cliente (2 balões = separados por linha em branco)",
  "campos": { "finalidade": "Comprar", "regiao": "Marco" },
  "encerrar": false, "pediuHumano": false, "semInteresse": false,
  "etiquetas": ["uuid-da-tag"], "desqualificacao": null, "tentativaResgate": null, "textoDesqualificacao": "",
  "enviarFotos": null,        // "IM1" = cliente pediu fotos desse imóvel (o CRM ainda confere se ele pediu mesmo)
  "imovelInteresse": null,    // "IM1" = anotar como imóvel de interesse do lead
  "tokens": 2310
}
// erro: { "ok": false, "erro": "..." }  → o CRM tenta de novo 1x e, se falhar, passa o lead pra roleta
```

### 02 — Transcrever áudio

`POST` com header `x-agente-secret`, body `{ "audioUrl": "https://s3.../x.ogg", "openaiKey": null }`.
Resposta: `{ "ok": true, "texto": "...", "erro": null }`.

### 03 — Aviso ao corretor

`POST <url>?secret=...` (sem esperar resposta), body:
`{ imobiliariaId, leadId, corretorId, roletaId, sessionName, corretorNome, corretorTelefone, lead: { nome, telefone, email, campanha, canal } }`.

`sessionName` = sessão WAHA pela qual o aviso sai. O CRM escolhe: o número por onde o lead chegou →
senão o número da roleta ("Só leads deste número" ou "Número do 1º contato") → senão o 1º número
central conectado.

### Várias caixas de entrada

A imobiliária pode conectar mais de um número central (ex.: Vendas e Locação). O 1º se chama
`imob-<imobiliariaId>`, os outros `imob-<imobiliariaId>-<sufixo>`. O fluxo do agente de IA já
recebe a `session` certa em cada chamada; o do aviso recebe `sessionName`. Nenhum fluxo precisa
saber quantos números existem.
O fluxo devolve o resultado em `POST __URL_API_CRM__/api/avisos-corretor/resultado?secret=...`
com `{ imobiliariaId, leadId, leadNome, corretorId, corretorNome, sucesso, erro }`.

### 04 — Captação Facebook

Lê `GET /api/integracoes/facebook/ativas` → `[{ id, imobiliariaId, formId, accessToken }]`; manda cada lead
em `POST /api/captacao/facebook` com `{ imobiliariaId, nome, telefone, email, mensagem, campanha, canal: "Facebook" }`
e o status em `POST /api/integracoes/facebook/sync-status`. A `campanha` é o **nome da campanha** da Meta
(ex.: `[NC 02][CENARIUM][FORM]`); o CRM usa o nome do meio pra ligar o lead ao imóvel (campo "Nome na campanha").

---

## 8. Testes rápidos

```bash
# 01 — deve responder JSON com "ok": true e uma "resposta"
curl -s https://SEU-N8N/webhook/hinode-agente-ia \
  -H 'Content-Type: application/json' -H 'x-agente-secret: SEU_SEGREDO' \
  -d '{"evento":"mensagem","imobiliariaNome":"Teste","agente":{"nome":"Ana","tom":"cordial","modelo":"gpt-4.1-mini","consultaImoveis":false},
       "perguntas":[{"chave":"finalidade","rotulo":"Finalidade","pergunta":"comprar ou alugar","obrigatoria":true,"opcoes":["Comprar","Alugar"]}],
       "etiquetas":[],"criterios":[],"dados":{},"faltando":["finalidade"],"lead":{"nome":"Teste","canal":"WhatsApp"},
       "imoveis":[],"historico":[{"papel":"cliente","texto":"Oi, quero comprar um apê"}],"openaiKey":null}'

# 02 — precisa de um áudio público (ogg/mp3/wav)
curl -s https://SEU-N8N/webhook/hinode-transcrever-audio \
  -H 'Content-Type: application/json' -H 'x-agente-secret: SEU_SEGREDO' \
  -d '{"audioUrl":"https://.../audio.ogg","openaiKey":null}'
```

Segredo errado = o n8n responde 200 **vazio** e não cria execução (é o `onlyRunIf` do webhook).
Pro fluxo 04, rode manualmente no editor (*Execute workflow*) e veja o status de cada conexão na
tela de Integrações do CRM.

---

## 9. Armadilhas conhecidas

- **URL do webhook sem o id.** Com `path` fixo, a URL de produção é `.../webhook/<path>`. A versão
  `.../webhook/<webhookId>/<path>` dá 404.
- **Editou, tem que publicar de novo.** Mudança feita depois de publicado fica em rascunho, e a
  produção continua com a versão antiga.
- **Saída JSON estrita da OpenAI:** todo campo do schema tem que estar em `required` e o objeto com
  `additionalProperties: false`. Campo novo = mexer no schema do "Montar Prompt" **e** no
  "Interpretar Resposta" **e** no tipo `RespostaN8n` em `server/src/lib/agenteIa.ts`.
- **Áudio `.oga`:** o n8n chama ogg/opus de `oga`, que a OpenAI recusa. O nó "Ajustar Nome do Arquivo" renomeia pra `.ogg`.
- **Chave própria aparece no histórico de execuções** do n8n (vem no payload). Se isso for problema,
  em *Workflow settings* do fluxo 01/02 desligue "Save successful executions".
- **Aviso ao corretor: "no LID found"** no WAHA com contato que nunca falou com o número. Por isso o
  fluxo 03 chama `check-exists` antes e usa o `chatId` que ele devolve (pode vir `@lid`). Não troque
  por `numero@c.us` montado na mão.
- **Captação Facebook:** a marca-d'água (último lead lido) fica no *static data* do workflow. Se
  apagar e reimportar o workflow, na primeira rodada ele busca só os últimos 10 min.
- **Uma instância n8n por ambiente.** Os fluxos 03 e 04 apontam pra UM backend (`__URL_API_CRM__`).
  Pra ter produção e v2 no mesmo n8n, importe duas cópias com nomes/paths diferentes e ajuste a env
  do backend correspondente. É o que está feito hoje: a v1 usa o path `visitaia-aviso-corretor` e a
  v2 usa `hinode-aviso-corretor` (fluxo próprio, segredos próprios). Mudança num não afeta o outro.

---

## 10. Mantendo este diretório atualizado

Os JSONs daqui são a **fonte da verdade** do que deve estar no n8n. Ao mudar um fluxo no n8n,
exporte de novo (*Download* no menu do workflow), **troque os segredos e URLs pelos marcadores** da
seção 3 e faça commit. Antes do commit:

```bash
grep -rnE '[0-9a-f]{24,}|https://api[-a-z0-9]*\.visitaia|waha\.visitaia' n8n/fluxos/ && echo "TEM SEGREDO/URL — não commitar"
```
