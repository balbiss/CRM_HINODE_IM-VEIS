CREATE TYPE "public"."ia_status" AS ENUM('atendendo', 'transferido', 'pausado');--> statement-breakpoint
ALTER TYPE "public"."mensagem_canal" ADD VALUE IF NOT EXISTS 'ia';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agentes_ia" (
	"imobiliaria_id" uuid PRIMARY KEY NOT NULL,
	"ativo" boolean DEFAULT false NOT NULL,
	"nome_agente" text DEFAULT 'Ana' NOT NULL,
	"tom" text DEFAULT 'cordial' NOT NULL,
	"apresentacao" text DEFAULT '' NOT NULL,
	"instrucoes_extras" text DEFAULT '' NOT NULL,
	"perguntas" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"mensagem_passagem" text DEFAULT 'Perfeito! Já passei suas informações para um dos nossos corretores, que vai falar com você em instantes.' NOT NULL,
	"max_mensagens" integer DEFAULT 12 NOT NULL,
	"atender_whatsapp" boolean DEFAULT true NOT NULL,
	"primeiro_contato_canais" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"minutos_sem_resposta" integer DEFAULT 20 NOT NULL,
	"minutos_abandono" integer DEFAULT 120 NOT NULL,
	"chave_cifrada" text,
	"chave_iv" text,
	"chave_tag" text,
	"modelo" text DEFAULT 'gpt-4.1-mini' NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ia_turnos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"imobiliaria_id" uuid NOT NULL,
	"lead_id" uuid,
	"lead_nome" text NOT NULL,
	"entrada" text,
	"resposta" text,
	"campos" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"decisao" text NOT NULL,
	"erro" text,
	"tokens" integer DEFAULT 0 NOT NULL,
	"chave_saas" boolean DEFAULT true NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "imobiliarias" ADD COLUMN "ia_liberada" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "imobiliarias" ADD COLUMN "ia_usa_chave_saas" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "ia_status" "ia_status";--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "ia_dados" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "ia_resumo" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "ia_turnos" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "ia_msgs_cliente" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "ia_ultima_atividade_em" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "ia_aguardando_desde" timestamp with time zone;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agentes_ia" ADD CONSTRAINT "agentes_ia_imobiliaria_id_imobiliarias_id_fk" FOREIGN KEY ("imobiliaria_id") REFERENCES "public"."imobiliarias"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ia_turnos" ADD CONSTRAINT "ia_turnos_imobiliaria_id_imobiliarias_id_fk" FOREIGN KEY ("imobiliaria_id") REFERENCES "public"."imobiliarias"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ia_turnos" ADD CONSTRAINT "ia_turnos_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ia_turnos_imobiliaria_id_idx" ON "ia_turnos" USING btree ("imobiliaria_id");