CREATE TABLE IF NOT EXISTS "product_reviews" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"rating" integer NOT NULL,
	"title" varchar(120),
	"body" text,
	"game" varchar(50),
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"moderated_at" timestamp,
	"moderated_by_clerk_id" varchar(255),
	CONSTRAINT "product_reviews_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
ALTER TABLE "product_reviews" ADD CONSTRAINT "product_reviews_user_id_users_id_fk"
	FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_product_reviews_user" ON "product_reviews" ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_product_reviews_status" ON "product_reviews" ("status", "created_at");
