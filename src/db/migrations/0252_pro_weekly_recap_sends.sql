-- 0252_pro_weekly_recap_sends.sql
--
-- GRYND PRO — the once-per-week resume of a member's solitaire week, and the
-- ledger that makes sending it exactly-once.
--
-- WHY A LEDGER
--   The recap is mailed by a cron job. A scheduler retry, a manual re-run or an
--   overlapping deploy must not mail the same member twice, and the email
--   provider's own dedupe cannot be relied on (the SMTP fallback has none).
--   A row per (member, ISO week) is claimed BEFORE the send; a second run finds
--   the row and skips. A send that fails releases its claim so the next run can
--   retry instead of losing the week.
--
-- WHAT IS NOT STORED
--   No copy of the recap itself and no figures — the summary is derived from
--   the settled games and `solitaire_analysis_cache` on each run. This table
--   only answers "has this member already had their week N?".
--
-- RETENTION
--   Rows are tiny; the nightly retention sweep drops claims older than eight
--   weeks (the window the scheduler could still retry).
--
-- RLS: default-deny, like the analysis cache and the usage counter. Only the
-- Next.js server touches it.
--
-- Idempotent + additive: CREATE TABLE IF NOT EXISTS, no drops, no backfill.

CREATE TABLE IF NOT EXISTS "pro_weekly_recap_sends" (
  -- Clerk user id of the GRYND PRO member.
  "user_id" varchar(255) NOT NULL,
  -- ISO week the recap describes, e.g. 2026-W46.
  "period_key" varchar(10) NOT NULL,
  "sent_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "pro_weekly_recap_sends_pk" PRIMARY KEY ("user_id", "period_key")
);

ALTER TABLE "pro_weekly_recap_sends" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "pro_weekly_recap_sends_no_client_access" ON "pro_weekly_recap_sends";
CREATE POLICY "pro_weekly_recap_sends_no_client_access" ON "pro_weekly_recap_sends"
  FOR ALL
  TO PUBLIC
  USING (false)
  WITH CHECK (false);

COMMENT ON TABLE "pro_weekly_recap_sends" IS
  'One claim row per PRO member per ISO week; prevents a cron retry from mailing the same weekly recap twice';
