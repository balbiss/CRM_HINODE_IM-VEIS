ALTER TABLE "compromissos_equipe" ADD COLUMN "oka_id" uuid;--> statement-breakpoint
ALTER TABLE "descartes_leads" ADD COLUMN "oka_id" uuid;--> statement-breakpoint
ALTER TABLE "eventos_lead" ADD COLUMN "oka_id" uuid;--> statement-breakpoint
ALTER TABLE "mensagens_whatsapp" ADD COLUMN "oka_id" uuid;--> statement-breakpoint
ALTER TABLE "tarefas" ADD COLUMN "oka_id" uuid;--> statement-breakpoint
ALTER TABLE "compromissos_equipe" ADD CONSTRAINT "compromissos_equipe_oka_id_unique" UNIQUE("oka_id");--> statement-breakpoint
ALTER TABLE "descartes_leads" ADD CONSTRAINT "descartes_leads_oka_id_unique" UNIQUE("oka_id");--> statement-breakpoint
ALTER TABLE "eventos_lead" ADD CONSTRAINT "eventos_lead_oka_id_unique" UNIQUE("oka_id");--> statement-breakpoint
ALTER TABLE "mensagens_whatsapp" ADD CONSTRAINT "mensagens_whatsapp_oka_id_unique" UNIQUE("oka_id");--> statement-breakpoint
ALTER TABLE "tarefas" ADD CONSTRAINT "tarefas_oka_id_unique" UNIQUE("oka_id");