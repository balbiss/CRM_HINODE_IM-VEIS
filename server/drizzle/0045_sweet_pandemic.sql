CREATE TABLE IF NOT EXISTS "campanhas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"imobiliaria_id" uuid NOT NULL,
	"nome" text NOT NULL,
	"drive_url" text,
	"observacao" text,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "compromissos_equipe" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"imobiliaria_id" uuid NOT NULL,
	"titulo" text NOT NULL,
	"tipo" text DEFAULT 'reuniao' NOT NULL,
	"inicio" timestamp with time zone NOT NULL,
	"fim" timestamp with time zone,
	"local" text,
	"observacao" text,
	"criado_por" uuid,
	"cancelado_em" timestamp with time zone,
	"aviso_enviado_em" timestamp with time zone,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "descartes_leads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"imobiliaria_id" uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	"usuario_id" uuid,
	"motivo" text NOT NULL,
	"observacao" text,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "gastos_campanha" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"imobiliaria_id" uuid NOT NULL,
	"origem" text NOT NULL,
	"mes" text NOT NULL,
	"valor" numeric(14, 2) DEFAULT '0' NOT NULL,
	"atualizado_por" uuid,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "oka_id" uuid;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "temperatura" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "telefone_alternativo" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "bairro_interesse" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "tipo_imovel_interesse" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "referencia" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "link_drive" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "saldo_fgts" numeric(14, 2);--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "valor_entrada" numeric(14, 2);--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "data_nascimento" date;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "lembrete_aniversario_ano" integer;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "lembrete_pos_venda_em" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "cadencia_chamada" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "data_ultima_chamada" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "proximo_contato_em" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "tentativas_contato" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "data_visita" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "tipo_visita" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "status_visita" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "descartado_em" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "descartado_por" uuid;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "descarte_pendente_aprovacao" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "venda_pendente_aprovacao" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "valor_venda" numeric(14, 2);--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "data_fechamento" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "data_venda_informada" date;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "empreendimento" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "torre" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "unidade" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "credito_aprovado_em" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "primeiro_contato_em" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "data_atribuicao" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "ultima_acao_em" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "sla_vencido" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "favorito" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "conversa_fixada" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "recadastro_em" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "recadastro_origem" text;--> statement-breakpoint
ALTER TABLE "notificacoes" ADD COLUMN "lead_id" uuid;--> statement-breakpoint
ALTER TABLE "perfis" ADD COLUMN "oka_id" uuid;--> statement-breakpoint
ALTER TABLE "perfis" ADD COLUMN "avatar_url" text;--> statement-breakpoint
ALTER TABLE "perfis" ADD COLUMN "em_almoco" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "perfis" ADD COLUMN "advertencias_semana" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "perfis" ADD COLUMN "advertencia_semana_inicio" date;--> statement-breakpoint
ALTER TABLE "perfis" ADD COLUMN "ultimo_lead_recebido_em" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "perfis" ADD COLUMN "removido_em" timestamp with time zone;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "campanhas" ADD CONSTRAINT "campanhas_imobiliaria_id_imobiliarias_id_fk" FOREIGN KEY ("imobiliaria_id") REFERENCES "public"."imobiliarias"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "compromissos_equipe" ADD CONSTRAINT "compromissos_equipe_imobiliaria_id_imobiliarias_id_fk" FOREIGN KEY ("imobiliaria_id") REFERENCES "public"."imobiliarias"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "compromissos_equipe" ADD CONSTRAINT "compromissos_equipe_criado_por_perfis_id_fk" FOREIGN KEY ("criado_por") REFERENCES "public"."perfis"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "descartes_leads" ADD CONSTRAINT "descartes_leads_imobiliaria_id_imobiliarias_id_fk" FOREIGN KEY ("imobiliaria_id") REFERENCES "public"."imobiliarias"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "descartes_leads" ADD CONSTRAINT "descartes_leads_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "descartes_leads" ADD CONSTRAINT "descartes_leads_usuario_id_perfis_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."perfis"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "gastos_campanha" ADD CONSTRAINT "gastos_campanha_imobiliaria_id_imobiliarias_id_fk" FOREIGN KEY ("imobiliaria_id") REFERENCES "public"."imobiliarias"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "gastos_campanha" ADD CONSTRAINT "gastos_campanha_atualizado_por_perfis_id_fk" FOREIGN KEY ("atualizado_por") REFERENCES "public"."perfis"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "campanhas_imobiliaria_nome_uq" ON "campanhas" USING btree ("imobiliaria_id","nome");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "compromissos_equipe_imobiliaria_id_idx" ON "compromissos_equipe" USING btree ("imobiliaria_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "descartes_leads_lead_id_idx" ON "descartes_leads" USING btree ("lead_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "gastos_campanha_origem_mes_uq" ON "gastos_campanha" USING btree ("imobiliaria_id","origem","mes");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "notificacoes" ADD CONSTRAINT "notificacoes_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "leads_oka_id_uq" ON "leads" USING btree ("oka_id") WHERE "leads"."oka_id" is not null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notificacoes_perfil_id_idx" ON "notificacoes" USING btree ("perfil_id");