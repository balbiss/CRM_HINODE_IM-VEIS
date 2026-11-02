CREATE TABLE IF NOT EXISTS "lead_etapas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"imobiliaria_id" uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	"coluna_id" uuid,
	"corretor_id" uuid,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lead_etapas" ADD CONSTRAINT "lead_etapas_imobiliaria_id_imobiliarias_id_fk" FOREIGN KEY ("imobiliaria_id") REFERENCES "public"."imobiliarias"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lead_etapas" ADD CONSTRAINT "lead_etapas_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lead_etapas" ADD CONSTRAINT "lead_etapas_coluna_id_colunas_kanban_id_fk" FOREIGN KEY ("coluna_id") REFERENCES "public"."colunas_kanban"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lead_etapas" ADD CONSTRAINT "lead_etapas_corretor_id_perfis_id_fk" FOREIGN KEY ("corretor_id") REFERENCES "public"."perfis"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lead_etapas_imob_data_idx" ON "lead_etapas" USING btree ("imobiliaria_id","criado_em");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lead_etapas_lead_id_idx" ON "lead_etapas" USING btree ("lead_id");--> statement-breakpoint
CREATE OR REPLACE FUNCTION registrar_lead_etapa() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.coluna_id IS NULL THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' THEN
    INSERT INTO lead_etapas (imobiliaria_id, lead_id, coluna_id, corretor_id, criado_em)
    VALUES (NEW.imobiliaria_id, NEW.id, NEW.coluna_id, NEW.corretor_id, coalesce(NEW.criado_em, now()));
  ELSIF NEW.coluna_id IS DISTINCT FROM OLD.coluna_id
     OR (NEW.corretor_id IS DISTINCT FROM OLD.corretor_id AND NEW.corretor_id IS NOT NULL) THEN
    INSERT INTO lead_etapas (imobiliaria_id, lead_id, coluna_id, corretor_id)
    VALUES (NEW.imobiliaria_id, NEW.id, NEW.coluna_id, NEW.corretor_id);
  END IF;
  RETURN NEW;
END $fn$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS leads_registrar_etapa ON leads;
--> statement-breakpoint
CREATE TRIGGER leads_registrar_etapa AFTER INSERT OR UPDATE OF coluna_id, corretor_id ON leads
  FOR EACH ROW EXECUTE FUNCTION registrar_lead_etapa();
