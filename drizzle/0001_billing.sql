CREATE TABLE "billing_events" (
	"id" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"kind" text NOT NULL,
	"retainer_id" uuid,
	"invoice_id" text,
	"amount_cents" integer,
	"currency" text,
	"paid_at" timestamp with time zone,
	"outcome" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "billing_events" ADD CONSTRAINT "billing_events_retainer_id_retainers_id_fk" FOREIGN KEY ("retainer_id") REFERENCES "public"."retainers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "billing_events_retainer_idx" ON "billing_events" USING btree ("retainer_id","created_at");