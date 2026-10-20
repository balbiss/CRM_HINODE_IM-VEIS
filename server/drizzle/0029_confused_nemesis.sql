ALTER TABLE "agentes_ia" ADD COLUMN "espera_segundos" integer DEFAULT 15 NOT NULL;--> statement-breakpoint
ALTER TABLE "agentes_ia" ADD COLUMN "simular_digitacao" boolean DEFAULT true NOT NULL;