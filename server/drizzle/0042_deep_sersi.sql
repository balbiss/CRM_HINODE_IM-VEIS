ALTER TABLE "mensagens_whatsapp" ADD COLUMN "wa_chave" text;--> statement-breakpoint
ALTER TABLE "sessoes_whatsapp" ADD COLUMN "oficial_phone_number_id" text;--> statement-breakpoint
ALTER TABLE "sessoes_whatsapp" ADD COLUMN "oficial_waba_id" text;--> statement-breakpoint
ALTER TABLE "sessoes_whatsapp" ADD COLUMN "oficial_numero" text;--> statement-breakpoint
ALTER TABLE "sessoes_whatsapp" ADD COLUMN "oficial_token_cifrado" text;--> statement-breakpoint
ALTER TABLE "sessoes_whatsapp" ADD COLUMN "oficial_token_iv" text;--> statement-breakpoint
ALTER TABLE "sessoes_whatsapp" ADD COLUMN "oficial_token_tag" text;--> statement-breakpoint
ALTER TABLE "sessoes_whatsapp" ADD COLUMN "oficial_ativa" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "sessoes_whatsapp" ADD COLUMN "oficial_erro" text;--> statement-breakpoint
ALTER TABLE "sessoes_whatsapp" ADD COLUMN "oficial_template" text;--> statement-breakpoint
ALTER TABLE "sessoes_whatsapp" ADD COLUMN "oficial_template_idioma" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mensagens_wa_chave_uq" ON "mensagens_whatsapp" USING btree ("lead_id","wa_chave") WHERE "mensagens_whatsapp"."wa_chave" is not null;--> statement-breakpoint
ALTER TABLE "sessoes_whatsapp" ADD CONSTRAINT "sessoes_whatsapp_oficial_phone_number_id_unique" UNIQUE("oficial_phone_number_id");