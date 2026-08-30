-- 0121: Grynd+ perks — monthly grant + the columns the membership perks use.
--
--   * token_subscription_plans.monthly_tokens = 100000 — the Grynd+ monthly
--     token grant, credited per paid invoice by the webhook.
--   * users.chat_color — custom chat name color, only settable by members
--     (enforced in /api/user/chat-color).
--   * quick_queue_requests.premium — marks queued requests from members so
--     the matcher pairs them first (priority matchmaking).
-- Idempotent: safe to run repeatedly.

UPDATE "token_subscription_plans"
SET "monthly_tokens" = 100000,
    "updated_at"     = now()
WHERE "key" = 'grynd-plus';
--> statement-breakpoint
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "chat_color" varchar(7);
--> statement-breakpoint
ALTER TABLE "quick_queue_requests"
  ADD COLUMN IF NOT EXISTS "premium" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
