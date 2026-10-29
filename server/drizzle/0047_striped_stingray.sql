CREATE TABLE IF NOT EXISTS "followup_envios" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"execucao_id" uuid NOT NULL,
	"passo_ordem" integer NOT NULL,
	"conteudo_enviado" text,
	"wa_message_id" text,
	"mensagem_id" uuid,
	"respondeu_apos" boolean DEFAULT false NOT NULL,
	"oka_id" uuid,
	"enviado_em" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "followup_envios_oka_id_unique" UNIQUE("oka_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "followup_ritmo_corretor" (
	"corretor_id" uuid PRIMARY KEY NOT NULL,
	"liberado_em" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "followup_execucoes" ADD COLUMN "oka_id" uuid;--> statement-breakpoint
ALTER TABLE "followup_execucoes" ADD COLUMN "iniciado_por" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "followup_execucoes" ADD COLUMN "resultado" text;--> statement-breakpoint
ALTER TABLE "followup_execucoes" ADD COLUMN "tentativas_erro" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "followup_execucoes" ADD COLUMN "reservado_em" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "followup_execucoes" ADD COLUMN "enviando_passo" integer;--> statement-breakpoint
ALTER TABLE "followup_execucoes" ADD COLUMN "enviando_desde" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "followup_execucoes" ADD COLUMN "finalizado_em" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "followup_fluxos" ADD COLUMN "oka_id" uuid;--> statement-breakpoint
ALTER TABLE "followup_fluxos" ADD COLUMN "campanha" text;--> statement-breakpoint
ALTER TABLE "followup_fluxos" ADD COLUMN "motivo_descarte_esgotar" text DEFAULT 'Sem Resposta' NOT NULL;--> statement-breakpoint
ALTER TABLE "followup_fluxos" ADD COLUMN "arquivado_em" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "followup_fluxos" ADD COLUMN "ativo_na_v1" boolean;--> statement-breakpoint
ALTER TABLE "followup_passos" ADD COLUMN "oka_id" uuid;--> statement-breakpoint
ALTER TABLE "followup_passos" ADD COLUMN "base_atraso" text DEFAULT 'passo_anterior' NOT NULL;--> statement-breakpoint
ALTER TABLE "followup_passos" ADD COLUMN "so_horario_comercial" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "followup_passos" ADD COLUMN "data_hora_fixa" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "followup_passos" ADD COLUMN "anexo_tipo" text;--> statement-breakpoint
ALTER TABLE "followup_passos" ADD COLUMN "anexo_mimetype" text;--> statement-breakpoint
ALTER TABLE "imobiliarias" ADD COLUMN "followup_automatico_ativo" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "imoveis" ADD COLUMN "referencia_anuncio" text;--> statement-breakpoint
ALTER TABLE "imoveis" ADD COLUMN "oka_id" uuid;--> statement-breakpoint
ALTER TABLE "links_uteis" ADD COLUMN "oka_id" uuid;--> statement-breakpoint
ALTER TABLE "templates_mensagem" ADD COLUMN "anexos" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "templates_mensagem" ADD COLUMN "oka_id" uuid;--> statement-breakpoint
ALTER TABLE "treinamentos" ADD COLUMN "oka_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "followup_envios" ADD CONSTRAINT "followup_envios_execucao_id_followup_execucoes_id_fk" FOREIGN KEY ("execucao_id") REFERENCES "public"."followup_execucoes"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "followup_ritmo_corretor" ADD CONSTRAINT "followup_ritmo_corretor_corretor_id_perfis_id_fk" FOREIGN KEY ("corretor_id") REFERENCES "public"."perfis"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "followup_envios_execucao_id_idx" ON "followup_envios" USING btree ("execucao_id");--> statement-breakpoint
ALTER TABLE "followup_execucoes" ADD CONSTRAINT "followup_execucoes_oka_id_unique" UNIQUE("oka_id");--> statement-breakpoint
ALTER TABLE "followup_fluxos" ADD CONSTRAINT "followup_fluxos_oka_id_unique" UNIQUE("oka_id");--> statement-breakpoint
ALTER TABLE "followup_passos" ADD CONSTRAINT "followup_passos_oka_id_unique" UNIQUE("oka_id");--> statement-breakpoint
ALTER TABLE "imoveis" ADD CONSTRAINT "imoveis_oka_id_unique" UNIQUE("oka_id");--> statement-breakpoint
ALTER TABLE "links_uteis" ADD CONSTRAINT "links_uteis_oka_id_unique" UNIQUE("oka_id");--> statement-breakpoint
ALTER TABLE "templates_mensagem" ADD CONSTRAINT "templates_mensagem_oka_id_unique" UNIQUE("oka_id");--> statement-breakpoint
ALTER TABLE "treinamentos" ADD CONSTRAINT "treinamentos_oka_id_unique" UNIQUE("oka_id");