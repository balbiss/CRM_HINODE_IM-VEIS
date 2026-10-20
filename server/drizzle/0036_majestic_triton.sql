ALTER TABLE "roletas" ADD COLUMN "numero_primeiro_contato_id" uuid;--> statement-breakpoint
ALTER TABLE "sessoes_whatsapp" ADD COLUMN "ia_atende" boolean DEFAULT true NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "roletas" ADD CONSTRAINT "roletas_numero_primeiro_contato_id_sessoes_whatsapp_id_fk" FOREIGN KEY ("numero_primeiro_contato_id") REFERENCES "public"."sessoes_whatsapp"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
