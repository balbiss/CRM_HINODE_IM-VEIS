CREATE TABLE IF NOT EXISTS "assistente_memorias" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"imobiliaria_id" uuid NOT NULL,
	"perfil_id" uuid NOT NULL,
	"texto" text NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "assistente_sessoes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"imobiliaria_id" uuid NOT NULL,
	"perfil_id" uuid NOT NULL,
	"iniciada_em" timestamp with time zone DEFAULT now() NOT NULL,
	"ultimo_sinal_em" timestamp with time zone DEFAULT now() NOT NULL,
	"segundos" integer DEFAULT 0 NOT NULL,
	"encerrada" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
ALTER TABLE "imobiliarias" ADD COLUMN "assistente_liberado" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "imobiliarias" ADD COLUMN "assistente_minutos_mes" integer DEFAULT 60 NOT NULL;--> statement-breakpoint
ALTER TABLE "imobiliarias" ADD COLUMN "assistente_nome" text DEFAULT 'Assistente' NOT NULL;--> statement-breakpoint
ALTER TABLE "imobiliarias" ADD COLUMN "assistente_voz" text DEFAULT 'Charon' NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "assistente_memorias" ADD CONSTRAINT "assistente_memorias_imobiliaria_id_imobiliarias_id_fk" FOREIGN KEY ("imobiliaria_id") REFERENCES "public"."imobiliarias"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "assistente_memorias" ADD CONSTRAINT "assistente_memorias_perfil_id_perfis_id_fk" FOREIGN KEY ("perfil_id") REFERENCES "public"."perfis"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "assistente_sessoes" ADD CONSTRAINT "assistente_sessoes_imobiliaria_id_imobiliarias_id_fk" FOREIGN KEY ("imobiliaria_id") REFERENCES "public"."imobiliarias"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "assistente_sessoes" ADD CONSTRAINT "assistente_sessoes_perfil_id_perfis_id_fk" FOREIGN KEY ("perfil_id") REFERENCES "public"."perfis"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "assistente_memorias_perfil_idx" ON "assistente_memorias" USING btree ("perfil_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "assistente_sessoes_imob_idx" ON "assistente_sessoes" USING btree ("imobiliaria_id","iniciada_em");