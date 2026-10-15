CREATE SCHEMA "desk";
--> statement-breakpoint
CREATE TABLE "desk"."api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"label" text NOT NULL,
	"scope" text NOT NULL,
	"client_id" uuid,
	"hash" text NOT NULL,
	"prefix" text NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_keys_hash_unique" UNIQUE("hash")
);
--> statement-breakpoint
CREATE TABLE "desk"."channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"external_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "desk"."clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"company" text,
	"timezone" text DEFAULT 'America/New_York' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"vault_note" text,
	"notes" text,
	"request_seq" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clients_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "desk"."contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"name" text NOT NULL,
	"email" text,
	"role" text DEFAULT 'member' NOT NULL,
	"telegram_id" text,
	"slack_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "desk"."pauses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"retainer_id" uuid NOT NULL,
	"month" text NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "desk"."requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"title" text NOT NULL,
	"type" text,
	"trigger" text,
	"result" text,
	"status" text DEFAULT 'new' NOT NULL,
	"position" integer,
	"size_days" integer,
	"parent_id" uuid,
	"needs_call" boolean DEFAULT false NOT NULL,
	"source" text DEFAULT 'owner' NOT NULL,
	"submitted_by" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reply_due_at" timestamp with time zone,
	"first_response_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"deliverable_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "requests_size_days" CHECK ("desk"."requests"."size_days" is null or "desk"."requests"."size_days" between 2 and 5)
);
--> statement-breakpoint
CREATE TABLE "desk"."retainers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"status" text DEFAULT 'onboarding' NOT NULL,
	"monthly_rate_cents" integer NOT NULL,
	"currency" text DEFAULT 'usd' NOT NULL,
	"active_limit" integer DEFAULT 1 NOT NULL,
	"library_access" boolean DEFAULT true NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"kickoff_at" timestamp with time zone,
	"current_period_end" timestamp with time zone NOT NULL,
	"cancel_at" timestamp with time zone,
	"billing_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "retainers_active_limit_positive" CHECK ("desk"."retainers"."active_limit" between 1 and 10)
);
--> statement-breakpoint
CREATE TABLE "desk"."updates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"author" text NOT NULL,
	"kind" text DEFAULT 'note' NOT NULL,
	"body" text NOT NULL,
	"visibility" text DEFAULT 'internal' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "desk"."api_keys" ADD CONSTRAINT "api_keys_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "desk"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "desk"."channels" ADD CONSTRAINT "channels_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "desk"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "desk"."contacts" ADD CONSTRAINT "contacts_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "desk"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "desk"."pauses" ADD CONSTRAINT "pauses_retainer_id_retainers_id_fk" FOREIGN KEY ("retainer_id") REFERENCES "desk"."retainers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "desk"."requests" ADD CONSTRAINT "requests_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "desk"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "desk"."retainers" ADD CONSTRAINT "retainers_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "desk"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "desk"."updates" ADD CONSTRAINT "updates_request_id_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "desk"."requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "channels_kind_external" ON "desk"."channels" USING btree ("kind","external_id");--> statement-breakpoint
CREATE INDEX "contacts_client_idx" ON "desk"."contacts" USING btree ("client_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pauses_retainer_month" ON "desk"."pauses" USING btree ("retainer_id","month");--> statement-breakpoint
CREATE UNIQUE INDEX "requests_client_number" ON "desk"."requests" USING btree ("client_id","number");--> statement-breakpoint
CREATE INDEX "requests_client_status_idx" ON "desk"."requests" USING btree ("client_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "retainers_one_open_per_client" ON "desk"."retainers" USING btree ("client_id") WHERE "desk"."retainers"."status" <> 'ended';--> statement-breakpoint
CREATE INDEX "updates_request_idx" ON "desk"."updates" USING btree ("request_id","created_at");