ALTER TABLE "agentes_ia" ADD COLUMN "etiquetas" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "agentes_ia" ADD COLUMN "criterios" jsonb DEFAULT '[]'::jsonb NOT NULL;