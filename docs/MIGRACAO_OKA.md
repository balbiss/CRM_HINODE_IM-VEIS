# Migração CRM OKA (v1) → CRM Hinode (v2)

Objetivo: o dono da Hinode passa a usar a v2 **com as mesmas regras da v1**, sem perder as
funções novas da v2 (Agente de IA, assistente de voz, número central, site, importar planilha) e
**sem mexer no que já foi configurado na v2** (números de WhatsApp, contatos pessoais, pessoas,
roletas, imóveis, Facebook, etiquetas). Referência das regras: `src/routes/manual.tsx` do repo
`imocrm-your-real-estate-crm` (v1).

## Como a importação trata o que já existe na v2

- Script: `server/src/db/importar-oka.ts` (também traz mensagens prontas, fluxos/passos/execuções de follow-up, imóveis, links úteis e treinamentos; lê página por página) (`OKA_SUPABASE_TOKEN=... npx tsx src/db/importar-oka.ts`,
  `--so=equipe,colunas,leads,mensagens,historico,tarefas,descartes,compromissos,roleta` pra rodar partes).
- Idempotente: cada registro guarda `oka_id`. Rodar de novo só atualiza/completa — a virada é
  "roda antes, confere, roda de novo na hora".
- **Pessoas que já existem na v2** mantêm nome, telefone, senha e papel da v2; a v1 só preenche
  campo vazio e traz estado de roleta/almoço/remoção. Quem só existe na v1 entra com a senha da v1
  (bcrypt, funciona igual).
- **Colunas**: as 21 da v1 entram com slug; colunas que só a v2 tem ficam.
- **Lead que já entrou na v2** e existe na v1 com o mesmo telefone vira um card só (sem duplicar).
- Não toca: `sessoes_whatsapp`, `contatos_pendentes/ignorados`, `roletas`, `imoveis`,
  `agentes_ia`, `integracoes_facebook`, `tags`.
- Ensaio local (28/10/2026, banco de teste): 14 pessoas, 21 colunas, 11.230 leads, 74.744 mensagens,
  157 mil eventos de histórico, 8.415 tarefas, 4.290 descartes, 123 mil registros da roleta.
  Contagem por coluna e por corretor bateu com a v1.

## Fases

| # | Fase | Status |
|---|---|---|
| 1 | Modelo de dados (campos da v1 no lead/perfil, descartes, compromissos, campanhas, gastos) + importação completa | ✅ feito, testado local |
| 2 | Kanban: próximo contato ao mudar de coluna, cadência de chamada (17h / 11h do próximo dia útil), temperatura, venda só com registro + aprovação, descarte normal/extremo + aprovação, devolver ao bolsão, transferir | ✅ no ar na v2 (28/10), e2e 28/28 |
| 3 | Análise de Crédito: alerta até "Visto", "Retornar com pendência", modal bloqueante, lembrete de hora em hora | ⏳ |
| 4 | Roleta da v1: toggle "disponível", desliga sozinha no fim do expediente (18:20 / qui 19:30 / sáb 15:20 / dom fechada), almoço, advertências, SLA 5 min, aviso de lead novo 20s | ⏳ |
| 5 | Distribuição de Leads (6 abas), "+ Mais Rebatidas" (50/dia, 10/clique, trava com tarefa atrasada), presos, reativar, recadastro entra na roleta quando abrir | ⏳ |
| 6 | Follow-up da v1: levas 9h30/16h, 1ª mensagem na hora, cancela em 24h, para ao sair da coluna FOLLOW-UP AUTOMÁTICO, fluxo Geral, modelo, arquivar + importar fluxos/execuções | ✅ no ar na v2 (29/10), e2e 46/47; fluxos entram desligados até a virada (`--virada`) |
| 7 | Agenda: todo lead com corretor tem próximo contato, compromissos da equipe (aviso 1h antes), aniversário, pós-venda 30 dias, etiqueta 🤖 | ⏳ |
| 8 | Dashboard (leitura do período, caminho do lead, campanhas), Relatórios (ranking, funil, CAC), tela Campanhas | ⏳ |
| 9 | WhatsApp por corretor (WAHA/Baileys/oficial híbrida), WhatsApp do dono não vira lead, alerta de duplicidade | ⏳ |
| 10 | Copiar mídia do Supabase (`whatsapp_media`) pro MinIO, ensaio em produção, virada (domínio crm.hinodeimoveis.com.br → v2), v1 só leitura por 2–4 semanas | ⏳ |
