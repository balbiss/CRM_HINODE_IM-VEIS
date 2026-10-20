ALTER TABLE "integracoes_facebook" ALTER COLUMN "form_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "integracoes_facebook" ADD COLUMN "origem" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "fb_lead_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "leads_imobiliaria_fb_lead_id_uq" ON "leads" USING btree ("imobiliaria_id","fb_lead_id");