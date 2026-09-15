-- 0157: Onboarding questionnaire — normalized preference responses.
--
--   * onboarding_responses stores ONE ROW PER ANSWER, keyed by the stable
--     question_key / answer ids from src/lib/onboardingQuestionnaire.js.
--     Multi-select questions simply have several rows for the same
--     question_key. Display copy is never stored — it lives in
--     src/lib/appTextTranslations.js, so the questionnaire can be
--     re-localized (or reworded) without a migration.
--   * users.questionnaire_completed_at is deliberately SEPARATE from
--     onboarding_completed_at: finishing the questionnaire never marks the
--     welcome tutorial complete, and vice-versa. Both are independent, and
--     neither implies the other.
--   * No backfill. NULL means "never answered", which is exactly the state
--     existing accounts must be in so they can still be prompted.

CREATE TABLE IF NOT EXISTS onboarding_responses (
  id serial PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  question_key varchar(64) NOT NULL,
  answer varchar(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

-- One row per (user, question, answer): a re-submission replaces answers and
-- can never produce uncontrolled duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS onboarding_responses_unique_answer_idx
  ON onboarding_responses (user_id, question_key, answer);

-- Reading a user's whole preference profile is the hot path (questionnaire
-- prefill, later the lobby/settings surfaces).
CREATE INDEX IF NOT EXISTS onboarding_responses_user_idx
  ON onboarding_responses (user_id, question_key);

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "questionnaire_completed_at" timestamptz;
