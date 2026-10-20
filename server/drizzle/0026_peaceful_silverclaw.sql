CREATE TABLE IF NOT EXISTS "contatos_ignorados" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"imobiliaria_id" uuid NOT NULL,
	"corretor_id" uuid NOT NULL,
	"telefone" text NOT NULL,
	"nome" text,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "contatos_pendentes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"imobiliaria_id" uuid NOT NULL,
	"corretor_id" uuid NOT NULL,
	"sessao_whatsapp_id" uuid NOT NULL,
	"telefone" text NOT NULL,
	"nome" text,
	"qtd_mensagens" integer DEFAULT 1 NOT NULL,
	"ultima_mensagem_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "contatos_ignorados" ADD CONSTRAINT "contatos_ignorados_imobiliaria_id_imobiliarias_id_fk" FOREIGN KEY ("imobiliaria_id") REFERENCES "public"."imobiliarias"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "contatos_ignorados" ADD CONSTRAINT "contatos_ignorados_corretor_id_perfis_id_fk" FOREIGN KEY ("corretor_id") REFERENCES "public"."perfis"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "contatos_pendentes" ADD CONSTRAINT "contatos_pendentes_imobiliaria_id_imobiliarias_id_fk" FOREIGN KEY ("imobiliaria_id") REFERENCES "public"."imobiliarias"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "contatos_pendentes" ADD CONSTRAINT "contatos_pendentes_corretor_id_perfis_id_fk" FOREIGN KEY ("corretor_id") REFERENCES "public"."perfis"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "contatos_pendentes" ADD CONSTRAINT "contatos_pendentes_sessao_whatsapp_id_sessoes_whatsapp_id_fk" FOREIGN KEY ("sessao_whatsapp_id") REFERENCES "public"."sessoes_whatsapp"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "contatos_ignorados_corretor_telefone_idx" ON "contatos_ignorados" USING btree ("corretor_id","telefone");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "contatos_pendentes_corretor_telefone_idx" ON "contatos_pendentes" USING btree ("corretor_id","telefone");