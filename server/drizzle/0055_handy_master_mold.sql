ALTER TABLE "leads" ADD COLUMN "aprovado_financiamento" numeric(14, 2);--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "aprovado_subsidio" numeric(14, 2);--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "aprovado_fgts" numeric(14, 2);--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "aprovado_em" timestamp with time zone;