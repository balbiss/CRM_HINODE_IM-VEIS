CREATE TABLE IF NOT EXISTS "conhecimento_itens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"imobiliaria_id" uuid NOT NULL,
	"categoria" text NOT NULL,
	"titulo" text NOT NULL,
	"conteudo" text DEFAULT '' NOT NULL,
	"anexo_url" text,
	"anexo_nome" text,
	"anexo_texto" text,
	"anexo_status" text,
	"criado_por" uuid,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "conhecimento_perguntas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"imobiliaria_id" uuid NOT NULL,
	"perfil_id" uuid,
	"pergunta" text NOT NULL,
	"resposta" text DEFAULT '' NOT NULL,
	"sem_resposta" boolean DEFAULT false NOT NULL,
	"resolvida" boolean DEFAULT false NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "fluxos_pagamento" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"imobiliaria_id" uuid NOT NULL,
	"empreendimento" text NOT NULL,
	"construtora" text DEFAULT '' NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"observacoes" text DEFAULT '' NOT NULL,
	"ativo" boolean DEFAULT true NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "conhecimento_itens" ADD CONSTRAINT "conhecimento_itens_imobiliaria_id_imobiliarias_id_fk" FOREIGN KEY ("imobiliaria_id") REFERENCES "public"."imobiliarias"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "conhecimento_itens" ADD CONSTRAINT "conhecimento_itens_criado_por_perfis_id_fk" FOREIGN KEY ("criado_por") REFERENCES "public"."perfis"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "conhecimento_perguntas" ADD CONSTRAINT "conhecimento_perguntas_imobiliaria_id_imobiliarias_id_fk" FOREIGN KEY ("imobiliaria_id") REFERENCES "public"."imobiliarias"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "conhecimento_perguntas" ADD CONSTRAINT "conhecimento_perguntas_perfil_id_perfis_id_fk" FOREIGN KEY ("perfil_id") REFERENCES "public"."perfis"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "fluxos_pagamento" ADD CONSTRAINT "fluxos_pagamento_imobiliaria_id_imobiliarias_id_fk" FOREIGN KEY ("imobiliaria_id") REFERENCES "public"."imobiliarias"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conhecimento_itens_imob_idx" ON "conhecimento_itens" USING btree ("imobiliaria_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conhecimento_perguntas_imob_idx" ON "conhecimento_perguntas" USING btree ("imobiliaria_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fluxos_pagamento_imob_idx" ON "fluxos_pagamento" USING btree ("imobiliaria_id");