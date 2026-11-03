ALTER TABLE "mensagens_whatsapp" ADD COLUMN "resposta_a" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mensagens_whatsapp" ADD CONSTRAINT "mensagens_whatsapp_resposta_a_mensagens_whatsapp_id_fk" FOREIGN KEY ("resposta_a") REFERENCES "public"."mensagens_whatsapp"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
