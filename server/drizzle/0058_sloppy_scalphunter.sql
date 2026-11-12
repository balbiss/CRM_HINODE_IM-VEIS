CREATE TABLE IF NOT EXISTS "mcp_oauth_clientes" (
	"id" text PRIMARY KEY NOT NULL,
	"secret_hash" text,
	"redirect_uris" text[] NOT NULL,
	"nome" text,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mcp_oauth_codigos" (
	"codigo_hash" text PRIMARY KEY NOT NULL,
	"cliente_id" text NOT NULL,
	"perfil_id" uuid NOT NULL,
	"redirect_uri" text NOT NULL,
	"code_challenge" text NOT NULL,
	"expira_em" timestamp with time zone NOT NULL,
	"usado_em" timestamp with time zone,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mcp_oauth_tokens" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"tipo" text NOT NULL,
	"cliente_id" text NOT NULL,
	"perfil_id" uuid NOT NULL,
	"expira_em" timestamp with time zone NOT NULL,
	"revogado_em" timestamp with time zone,
	"ultimo_uso_em" timestamp with time zone,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mcp_oauth_codigos" ADD CONSTRAINT "mcp_oauth_codigos_cliente_id_mcp_oauth_clientes_id_fk" FOREIGN KEY ("cliente_id") REFERENCES "public"."mcp_oauth_clientes"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mcp_oauth_codigos" ADD CONSTRAINT "mcp_oauth_codigos_perfil_id_perfis_id_fk" FOREIGN KEY ("perfil_id") REFERENCES "public"."perfis"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mcp_oauth_tokens" ADD CONSTRAINT "mcp_oauth_tokens_cliente_id_mcp_oauth_clientes_id_fk" FOREIGN KEY ("cliente_id") REFERENCES "public"."mcp_oauth_clientes"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mcp_oauth_tokens" ADD CONSTRAINT "mcp_oauth_tokens_perfil_id_perfis_id_fk" FOREIGN KEY ("perfil_id") REFERENCES "public"."perfis"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_oauth_tokens_perfil_idx" ON "mcp_oauth_tokens" USING btree ("perfil_id");