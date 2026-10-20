ALTER TABLE "agentes_ia" ADD COLUMN "consultar_imoveis" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "agentes_ia" ADD COLUMN "informar_preco" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "agentes_ia" ADD COLUMN "fotos_por_imovel" integer DEFAULT 3 NOT NULL;