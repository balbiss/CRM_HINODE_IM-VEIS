CREATE TABLE IF NOT EXISTS "recusas_lead" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"imobiliaria_id" uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	"corretor_id" uuid NOT NULL,
	"motivo" text NOT NULL,
	"redistribuido_para_id" uuid,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "recusas_lead" ADD CONSTRAINT "recusas_lead_imobiliaria_id_imobiliarias_id_fk" FOREIGN KEY ("imobiliaria_id") REFERENCES "public"."imobiliarias"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "recusas_lead" ADD CONSTRAINT "recusas_lead_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "recusas_lead" ADD CONSTRAINT "recusas_lead_corretor_id_perfis_id_fk" FOREIGN KEY ("corretor_id") REFERENCES "public"."perfis"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "recusas_lead" ADD CONSTRAINT "recusas_lead_redistribuido_para_id_perfis_id_fk" FOREIGN KEY ("redistribuido_para_id") REFERENCES "public"."perfis"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "recusas_lead_imobiliaria_id_idx" ON "recusas_lead" USING btree ("imobiliaria_id");