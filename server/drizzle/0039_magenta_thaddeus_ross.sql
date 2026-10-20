CREATE TABLE IF NOT EXISTS "lotes_importacao" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"imobiliaria_id" uuid NOT NULL,
	"nome" text NOT NULL,
	"criado_por_nome" text,
	"tag_id" uuid,
	"novos" integer DEFAULT 0 NOT NULL,
	"duplicados" integer DEFAULT 0 NOT NULL,
	"invalidos" integer DEFAULT 0 NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "lote_importacao_id" uuid;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "importacao_pendente" boolean DEFAULT false NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lotes_importacao" ADD CONSTRAINT "lotes_importacao_imobiliaria_id_imobiliarias_id_fk" FOREIGN KEY ("imobiliaria_id") REFERENCES "public"."imobiliarias"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lotes_importacao" ADD CONSTRAINT "lotes_importacao_tag_id_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lotes_importacao_imobiliaria_id_idx" ON "lotes_importacao" USING btree ("imobiliaria_id");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "leads" ADD CONSTRAINT "leads_lote_importacao_id_lotes_importacao_id_fk" FOREIGN KEY ("lote_importacao_id") REFERENCES "public"."lotes_importacao"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
