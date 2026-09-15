-- 0158: Questionnaire invitation — server-authoritative "Maybe Later".
--
--   * Existing accounts (onboarding_completed_at already set by 0142) that
--     have NOT answered the questionnaire get a single, dismissible invitation
--     instead of being sent back through the welcome tutorial.
--   * Dismissing it writes users.questionnaire_dismissed_at, so the invitation
--     never nags on later visits / devices / sessions. The questionnaire
--     itself stays reachable through the Settings entry point, so dismissing
--     it costs the player nothing.
--   * NULL (the default for every existing row) means "never dismissed" —
--     which is exactly what makes an account eligible for the invitation, so
--     there is deliberately NO backfill here.
--
-- The three onboarding states stay independent:
--   onboarding_completed_at   → welcome/tutorial finished (0142)
--   first_game_completed_at   → onboarding RPS match finished (0143)
--   questionnaire_completed_at → questionnaire submitted (0157)
--   questionnaire_dismissed_at → invitation declined, never answered (0158)

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "questionnaire_dismissed_at" timestamptz;
