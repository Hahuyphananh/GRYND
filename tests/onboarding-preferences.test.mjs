// tests/onboarding-preferences.test.mjs
//
// The EDIT surface + final QA contract of the personalization system:
//
//   1. Settings → "Your GRYND Preferences" (view + update, ONE store)
//   2. Questionnaire re-editing (first-time vs edit mode, replace semantics)
//   3. The existing-user invitation stays a useful, dismissible feature
//   4. The one-line personalized copy shown after the questionnaire
//   5. The RPS first-game flow is untouched
//   6. Data integrity (auth, validation, replace, indexes, timestamps)
//   7. Backwards compatibility for every user state (A–F)
//   8. Error handling (no traps, no loops, /casino and gameplay unaffected)
//   9. Accessibility (labels, states, focus, target sizes)
//  10. Localization (every new string, in all three locales)

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const { WELCOME_MESSAGE_KEYS, recommendGames, shouldShowPersonalizedSection, welcomeMessageKey } =
  await import("../src/lib/gameRecommendations.js");

const { QUESTIONNAIRE_QUESTIONS, getAllowedAnswers, validateQuestionnaireAnswers } =
  await import("../src/lib/onboardingQuestionnaire.js");

const { GAME_CATALOG } = await import("../src/lib/gameTags.js");

const {
  isQuestionnaireSettled,
  questionnaireDestination,
  shouldRouteWelcomeToQuestionnaire,
  shouldShowQuestionnaireInvite,
} = await import("../src/lib/onboardingFlow.js");

const { t } = await import("../src/lib/appTextTranslations.js");

const SETTINGS = "src/app/settings/PageClient.jsx";
const Q_CLIENT = "src/app/welcome/questionnaire/PageClient.tsx";
const Q_PAGE = "src/app/welcome/questionnaire/page.tsx";
const Q_ROUTE = "src/app/api/onboarding/questionnaire/route.ts";
const Q_DISMISS = "src/app/api/onboarding/questionnaire/dismiss/route.ts";
const Q_STATUS = "src/app/api/onboarding/status/route.ts";
const Q_COMPLETE = "src/app/api/onboarding/complete/route.ts";
const FIRST_GAME = "src/app/api/onboarding/first-game-complete/route.ts";
const RPS = "src/app/casino/rps/play-ai/PageClient.tsx";
const WELCOME_CLIENT = "src/app/welcome/PageClient.tsx";
const LOBBY = "src/app/casino/PageClient.jsx";
const MIGRATION = "src/db/migrations/0157_onboarding_responses.sql";
const MIGRATION_DISMISS = "src/db/migrations/0158_questionnaire_dismissal.sql";
const SCHEMA = "src/db/schema.ts";
const LOCALES = ["en", "fr", "es"];

const source = (relPath) =>
  fs.readFileSync(path.join(process.cwd(), relPath), "utf8").replace(/\r\n/g, "\n");

const settings = source(SETTINGS);
const questionnaire = source(Q_CLIENT);
const route = source(Q_ROUTE);
const welcome = source(WELCOME_CLIENT);
const lobby = source(LOBBY);

/** A complete, valid questionnaire submission. */
const FULL_ANSWERS = {
  motivation: ["competition"],
  game_types: ["strategy", "pvp_duels"],
  experience: "experienced",
  priorities: ["ranking_up"],
  discovery: "tiktok",
};

// ── 1. Settings → "Your GRYND Preferences" ───────────────────────────────

test("Settings shows the saved preferences, reusing the questionnaire catalog", () => {
  // It reuses the SAME question catalog as the flow — no second option list.
  assert.match(
    settings,
    /import \{ QUESTIONNAIRE_QUESTIONS \} from "\.\.\/\.\.\/lib\/onboardingQuestionnaire";/
  );
  assert.match(settings, /const preferenceRows = QUESTIONNAIRE_QUESTIONS\.map\(\(question\) => \{/);
  // Labels come from the questionnaire's own translation keys.
  assert.match(settings, /title: t\(question\.titleKey\)/);
  assert.match(settings, /\.map\(\(option\) => t\(option\.labelKey\)\)/);
  // A real label/value structure, not a blob of text.
  assert.match(settings, /<dl className="mb-4 grid gap-3 sm:grid-cols-2">/);
  assert.match(settings, /<dt className=/);
  assert.match(settings, /<dd className=/);
  // Only questions with a valid saved answer render a row.
  assert.match(settings, /\.filter\(\(row\) => row\.labels\.length > 0\)/);
});

test("Settings reads the preferences once, from the one questionnaire API", () => {
  assert.match(settings, /const \[gamePreferences, setGamePreferences\] = useState\(null\);/);
  // Exactly one preferences fetch in the file…
  assert.equal(settings.split("/api/onboarding/questionnaire").length - 1, 1);
  assert.match(
    settings,
    /fetch\("\/api\/onboarding\/questionnaire", \{ credentials: "include" \}\)/
  );
  // …and it is a read, never a write (updating happens in the questionnaire).
  assert.doesNotMatch(settings, /method: "PUT"[\s\S]{0,120}questionnaire/);
  assert.doesNotMatch(settings, /questionnaire\/dismiss/);
  // Failures load as "not answered" so the card offers setup instead of
  // rendering preferences it doesn't have.
  assert.match(settings, /setGamePreferences\(\{ ok: false, completed: false, answers: \{\} \}\);/);
});

test("Settings offers the right action for each state", () => {
  // Not answered (or unreadable) → the setup CTA.
  assert.match(settings, /t\("onboarding\.preferences\.empty"\)/);
  assert.match(settings, /t\("onboarding\.preferences\.error"\)/);
  assert.match(settings, /t\("onboarding\.preferences\.cta"\)/);
  // Answered → the summary plus an update action.
  assert.match(settings, /t\("onboarding\.preferences\.note"\)/);
  assert.match(settings, /t\("onboarding\.preferences\.update"\)/);
  // Both point at the SAME questionnaire, in edit mode, returning here.
  assert.equal(settings.split('href="/welcome/questionnaire?from=settings"').length - 1, 2);
  // Loading state exists, so the card never renders blank.
  assert.match(settings, /gamePreferences === null && \(/);
  assert.match(settings, /t\("ui\.loading"\)/);
});

test("the Settings card replaced the bare Help & Support link (no duplicate entry point)", () => {
  assert.match(settings, /t\("onboarding\.preferences\.title"\)/);
  // The old one-line link is gone, and its string with it.
  assert.doesNotMatch(settings, /onboarding\.questionnaire\.settingsLink/);
  for (const locale of LOCALES) {
    assert.equal(
      t(locale, "onboarding.questionnaire.settingsLink"),
      "onboarding.questionnaire.settingsLink",
      `${locale} still carries the dead settingsLink string`
    );
  }
  // Help & Support keeps its other, unrelated entries.
  assert.match(settings, /t\("onboarding\.replay"\)/);
  assert.match(settings, /href="\/contact"/);
});

// ── 2. Re-editing: first time vs edit mode ───────────────────────────────

test("the questionnaire has exactly two modes, decided by the server", () => {
  // The mode comes from the server's completed flag, never from the URL — so
  // Settings can open the flow for a first-time player and still get the
  // first-run experience.
  assert.match(questionnaire, /const \[completed, setCompleted\] = useState\(false\);/);
  assert.match(questionnaire, /setCompleted\(data\.completed === true\);/);
  assert.match(questionnaire, /const mode: "first" \| "edit" = completed \? "edit" : "first";/);
});

test("edit mode pre-selects the saved answers and says so", () => {
  // Prefill (server snapshot, with a local draft on top).
  assert.match(questionnaire, /let nextAnswers: Answers = serverAnswers;/);
  assert.match(questionnaire, /nextAnswers = \{ \.\.\.serverAnswers, \.\.\.parsed\.answers \}/);
  // Copy: an explicit edit badge, a save-changes button and a replace note.
  assert.match(questionnaire, /t\("onboarding\.questionnaire\.edit\.badge"\)/);
  assert.match(questionnaire, /\? t\("onboarding\.questionnaire\.edit\.save"\)/);
  assert.match(questionnaire, /\? t\("onboarding\.questionnaire\.edit\.note"\)/);
  // …and the first-run copy is still the first-run copy.
  assert.match(questionnaire, /t\("onboarding\.questionnaire\.finish"\)/);
  assert.match(questionnaire, /t\("onboarding\.questionnaire\.skip"\)/);
  assert.match(questionnaire, /t\("onboarding\.questionnaire\.editNote"\)/);
});

test("cancelling an edit writes nothing; skipping a first run records the dismissal", () => {
  // Cancel is pure navigation to the same destination as saving.
  assert.match(
    questionnaire,
    /<Link\n\s+href=\{destination\}\n\s+className="flex h-11 items-center rounded-full px-3 text-xs font-bold text-\[#9dd8ff\]\/70/
  );
  assert.match(questionnaire, /t\("onboarding\.questionnaire\.edit\.cancel"\)/);
  // The two controls are mutually exclusive on `mode`.
  assert.match(questionnaire, /\{mode === "edit" \? \(/);
  // The dismissal POST lives only in the first-run skip callback.
  assert.equal(questionnaire.split("/api/onboarding/questionnaire/dismiss").length - 1, 1);
  assert.match(questionnaire, /const skip = useCallback\(\(\) => \{/);
  // Skip never marks the questionnaire answered.
  assert.doesNotMatch(questionnaire, /method: "POST"[\s\S]{0,200}questionnaire"/);
});

test("saving replaces the previous answers and can't create duplicate rows", () => {
  // The flow PUTs the whole answer set to the one endpoint.
  assert.match(questionnaire, /method: "PUT",/);
  assert.match(questionnaire, /body: JSON\.stringify\(\{ answers \}\)/);
  // The endpoint replaces atomically: delete + insert inside ONE transaction…
  assert.match(route, /await db\.transaction\(async \(tx\) => \{/);
  assert.match(route, /await tx\n?\s*\.delete\(onboardingResponses\)/);
  assert.match(route, /await tx\.insert\(onboardingResponses\)\.values\(/);
  assert.match(
    route,
    /export async function POST\(request: Request\) \{\n\s+return submit\(request\);/
  );
  assert.match(
    route,
    /export async function PUT\(request: Request\) \{\n\s+return submit\(request\);/
  );
  // …and a submission is never partial.
  assert.match(
    questionnaire,
    /if \(!QUESTIONNAIRE_QUESTIONS\.every\(\(q\) => isAnswered\(q\)\)\) return;/
  );
  assert.match(questionnaire, /if \(!allAnswered\) \{/);
});

test("validation rejects anything the catalog doesn't offer", () => {
  const rejected = [
    [
      {
        motivation: ["nope"],
        game_types: ["strategy"],
        experience: "new",
        priorities: ["fun"],
        discovery: "tiktok",
      },
      "invalid_answer",
    ],
    [{ game_types: ["strategy"] }, "missing_answer"],
    [{ ...FULL_ANSWERS, extra: ["x"] }, "unknown_question"],
    [{ ...FULL_ANSWERS, game_types: ["strategy", "strategy"] }, "duplicate_answer"],
    [
      { ...FULL_ANSWERS, game_types: ["strategy", "pvp_duels", "casual", "fast_paced"] },
      "too_many_answers",
    ],
    [{ ...FULL_ANSWERS, experience: "wizard" }, "invalid_answer"],
    [null, "invalid_payload"],
    ["nope", "invalid_payload"],
  ];
  for (const [payload, code] of rejected) {
    const result = validateQuestionnaireAnswers(payload);
    assert.equal(result.ok, false, `${JSON.stringify(payload)} should be rejected`);
    assert.equal(result.code, code);
  }
  // A valid multi-select answer is accepted, normalized to catalog order.
  const ok = validateQuestionnaireAnswers({
    ...FULL_ANSWERS,
    game_types: ["competitive", "pvp_duels"],
  });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.answers.game_types, ["pvp_duels", "competitive"]);
});

// ── 3. The existing-user invitation ──────────────────────────────────────

test("the invitation reads like a feature, and Maybe Later keeps Settings open", () => {
  // Duration + reversibility, so it reads as useful rather than mandatory.
  assert.match(lobby, /t\("onboarding\.questionnaire\.invite\.note"\)/);
  assert.match(lobby, /onClick=\{dismissQuestionnaireInvite\}/);
  assert.match(lobby, /fetch\("\/api\/onboarding\/questionnaire\/dismiss"/);
  // Dismissing never blocks the lobby and never marks it answered.
  assert.equal(
    isQuestionnaireSettled({ questionnaireCompleted: false, questionnaireDismissed: true }),
    true
  );
  assert.equal(
    shouldShowQuestionnaireInvite({
      isSignedIn: true,
      onboardingCompleted: true,
      questionnaireCompleted: false,
      questionnaireDismissed: true,
      handledThisSession: false,
    }),
    false
  );
  // …and the setup is still reachable from Settings afterwards.
  assert.match(settings, /href="\/welcome\/questionnaire\?from=settings"/);
  // The card is not a modal and never covers the grid or a match.
  assert.doesNotMatch(lobby, /questionnaireInvite &&[\s\S]{0,60}fixed inset-0/);
});

// ── 4. Personalized copy after the questionnaire ─────────────────────────

test("one warm follow-up line, decided deterministically by the answers", () => {
  assert.equal(
    welcomeMessageKey({ ...FULL_ANSWERS, experience: "new" }),
    WELCOME_MESSAGE_KEYS.beginner
  );
  assert.equal(
    welcomeMessageKey({ ...FULL_ANSWERS, experience: "casual" }),
    WELCOME_MESSAGE_KEYS.casual
  );
  assert.equal(
    welcomeMessageKey({ ...FULL_ANSWERS, experience: "experienced" }),
    WELCOME_MESSAGE_KEYS.competitive
  );
  assert.equal(
    welcomeMessageKey({ ...FULL_ANSWERS, experience: "highly_competitive" }),
    WELCOME_MESSAGE_KEYS.competitive
  );
  // A rewards goal (or motivation) wins over the experience tone.
  assert.equal(
    welcomeMessageKey({ ...FULL_ANSWERS, priorities: ["earning_tokens"] }),
    WELCOME_MESSAGE_KEYS.rewards
  );
  assert.equal(
    welcomeMessageKey({ ...FULL_ANSWERS, motivation: ["rewards"] }),
    WELCOME_MESSAGE_KEYS.rewards
  );
  // Incomplete or missing answers → no line at all.
  assert.equal(welcomeMessageKey({ experience: "new" }), null);
  assert.equal(welcomeMessageKey(null), null);
  assert.equal(welcomeMessageKey(undefined), null);
});

test("the welcome hero shows it only on the hand-off from the questionnaire", () => {
  assert.match(
    welcome,
    /const \[welcomeLine, setWelcomeLine\] = useState<string \| null>\(null\);/
  );
  assert.match(welcome, /if \(fromQuestionnaire && data\.questionnaireCompleted === true\) \{/);
  assert.match(welcome, /setWelcomeLine\(welcomeMessageKey\(answersData\.answers\)\);/);
  // Best-effort: a failure leaves the step exactly as it was.
  assert.match(welcome, /\/\/ no personalized line — the tutorial is unaffected/);
  assert.match(welcome, /\{welcomeLine && \(/);
  // English copy for the examples the product asked for.
  assert.equal(t("en", WELCOME_MESSAGE_KEYS.competitive), "Let's get you into the action.");
  assert.equal(t("en", WELCOME_MESSAGE_KEYS.beginner), "Let's get you comfortable with GRYND.");
  assert.equal(t("en", WELCOME_MESSAGE_KEYS.rewards), "Let's find some games you'll enjoy.");
  // Nothing about profiling, analytics or "we noticed you…" copy.
  for (const locale of LOCALES) {
    for (const key of Object.values(WELCOME_MESSAGE_KEYS)) {
      const copy = t(locale, key).toLowerCase();
      assert.doesNotMatch(copy, /profil|analytic|track|we noticed|hidden/, `${locale} ${key}`);
    }
  }
});

// ── 5. The RPS first-game flow is untouched ──────────────────────────────

test("the onboarding first game is still the unchanged RPS Free Play match", () => {
  // Same URL, same page-level gate, same endpoint, same one-time XP.
  assert.match(welcome, /const FIRST_GAME_URL = "\/casino\/rps\/play-ai\?onboarding=1";/);
  assert.match(source(RPS), /api\/onboarding\/first-game-complete/);
  assert.match(source(RPS), /if \(tutorial\.mode !== "active" \|\| !matchOver\) return;/);
  const firstGame = source(FIRST_GAME);
  assert.match(firstGame, /isNull\(users\.firstGameCompletedAt\)/);
  assert.match(firstGame, /FIRST_GAME_BONUS_XP/);
  assert.match(firstGame, /addExp\(/);
  // The questionnaire never touches that flag, and never fakes the match.
  assert.doesNotMatch(route, /firstGameCompletedAt/);
  assert.doesNotMatch(questionnaire, /first-game-complete/);
  assert.doesNotMatch(lobby, /first-game-complete/);
  // Choosing "Skip for now" in the questionnaire still reaches the tutorial.
  assert.equal(
    questionnaireDestination({ from: "welcome", onboardingCompleted: false }),
    "/welcome?from=questionnaire"
  );
});

// ── 6. Data integrity ────────────────────────────────────────────────────

test("answers belong to the Clerk session — a client user id is never read", () => {
  assert.match(route, /const \{ userId \} = await auth\(\);/);
  assert.match(route, /async function loadUser\(clerkId: string\)/);
  assert.match(route, /where\(eq\(users\.clerkId, clerkId\)\)/);
  assert.match(route, /const user = await loadUser\(userId\);/);
  assert.match(route, /where\(eq\(onboardingResponses\.userId, user\.id\)\)/);
  // No request input at all on the data path.
  assert.doesNotMatch(route, /searchParams/);
  assert.doesNotMatch(route, /request\.json\(\)[\s\S]{0,80}userId/);
  assert.doesNotMatch(route, /body\??\.(user|userId|user_id)/);
  assert.match(route, /if \(!userId\) return unauthorized\(\);/);
  assert.match(route, /status: 401/);
});

test("the migration has the right shape, indexes and constraints", () => {
  const sql = source(MIGRATION);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS onboarding_responses/);
  assert.match(sql, /user_id integer NOT NULL REFERENCES users\(id\) ON DELETE CASCADE/);
  assert.match(sql, /question_key varchar\(64\) NOT NULL/);
  assert.match(sql, /answer varchar\(64\) NOT NULL/);
  assert.match(sql, /created_at timestamptz NOT NULL DEFAULT NOW\(\)/);
  assert.match(sql, /updated_at timestamptz NOT NULL DEFAULT NOW\(\)/);
  // One row per (user, question, answer) — uncontrolled duplicates impossible…
  assert.match(
    sql,
    /CREATE UNIQUE INDEX IF NOT EXISTS onboarding_responses_unique_answer_idx\n\s+ON onboarding_responses \(user_id, question_key, answer\)/
  );
  // …and reading a profile is a single indexed lookup.
  assert.match(
    sql,
    /CREATE INDEX IF NOT EXISTS onboarding_responses_user_idx\n\s+ON onboarding_responses \(user_id, question_key\)/
  );
  // Completion is its own column, with no backfill (existing rows stay NULL).
  assert.match(
    sql,
    /ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "questionnaire_completed_at" timestamptz/
  );
  assert.doesNotMatch(sql, /UPDATE\s+"users"\s+SET\s+"questionnaire_completed_at"/i);
  assert.match(
    source(MIGRATION_DISMISS),
    /ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "questionnaire_dismissed_at" timestamptz/
  );

  // The Drizzle schema mirrors it, so typed queries and the SQL can't drift.
  const schema = source(SCHEMA);
  assert.match(schema, /export const onboardingResponses = pgTable\(/);
  assert.match(schema, /unique\("onboarding_responses_unique_answer_idx"\)\.on\(/);
  assert.match(schema, /index\("onboarding_responses_user_idx"\)\.on\(/);
  assert.match(schema, /references\(\(\) => users\.id, \{ onDelete: "cascade" \}\)/);
  assert.match(schema, /questionnaireCompletedAt: timestamp\("questionnaire_completed_at"/);
  assert.match(schema, /questionnaireDismissedAt: timestamp\("questionnaire_dismissed_at"/);

  // Journaled, or db:migrate silently skips them (the journal carries a UTF-8
  // BOM, so it is stripped before parsing — same as the other suites).
  const journal = JSON.parse(source("src/db/migrations/meta/_journal.json").replace(/^\uFEFF/, ""));
  const tags = journal.entries.map((entry) => entry.tag);
  assert.ok(tags.includes("0157_onboarding_responses"));
  assert.ok(tags.includes("0158_questionnaire_dismissal"));
});

test("completion is stamped once, per user, with sensible timestamps", () => {
  // Only a first successful submission stamps it (so "when did they first
  // answer" stays meaningful), and it is scoped to the caller's row.
  assert.match(route, /set\(\{ questionnaireCompletedAt: new Date\(\) \}\)/);
  assert.match(
    route,
    /and\(eq\(users\.id, user\.id\), isNull\(users\.questionnaireCompletedAt\)\)/
  );
  // Rows carry both timestamps on insert.
  assert.match(route, /createdAt: new Date\(\),/);
  assert.match(route, /updatedAt: new Date\(\),/);
  // Exactly one preference row shape is written, straight from the catalog.
  assert.match(route, /groupStoredResponses/);
  assert.match(route, /validateQuestionnaireAnswers\(body\?\.answers\)/);
});

// ── 7. Backwards compatibility (states A–F) ──────────────────────────────

test("A. brand-new account: questionnaire → tutorial → first game → For You", () => {
  assert.equal(
    shouldRouteWelcomeToQuestionnaire({
      onboardingCompleted: false,
      questionnaireCompleted: false,
      questionnaireDismissed: false,
      replay: false,
      fromQuestionnaire: false,
    }),
    true
  );
  assert.equal(
    questionnaireDestination({ from: "welcome", onboardingCompleted: false }),
    "/welcome?from=questionnaire"
  );
  assert.equal(
    shouldRouteWelcomeToQuestionnaire({
      onboardingCompleted: false,
      questionnaireCompleted: true,
      questionnaireDismissed: false,
      replay: false,
      fromQuestionnaire: true,
    }),
    false
  );
  assert.equal(shouldShowPersonalizedSection(recommendGames(FULL_ANSWERS)), true);
  const statusRoute = source(Q_STATUS);
  assert.match(statusRoute, /firstGameCompleted,/);
  assert.match(statusRoute, /questionnaireCompleted,/);
});

test("B. existing account: normal site → invitation → questionnaire → For You", () => {
  assert.equal(
    shouldRouteWelcomeToQuestionnaire({
      onboardingCompleted: true,
      questionnaireCompleted: false,
      questionnaireDismissed: false,
      replay: false,
      fromQuestionnaire: false,
    }),
    false
  );
  assert.equal(
    shouldShowQuestionnaireInvite({
      isSignedIn: true,
      onboardingCompleted: true,
      questionnaireCompleted: false,
      questionnaireDismissed: false,
      handledThisSession: false,
    }),
    true
  );
  assert.equal(questionnaireDestination({ from: "lobby", onboardingCompleted: true }), "/casino");
  assert.equal(shouldShowPersonalizedSection(recommendGames(FULL_ANSWERS)), true);
});

test("C. existing account that skips: nothing blocks, preferences stay reachable", () => {
  const dismissed = {
    onboardingCompleted: true,
    questionnaireCompleted: false,
    questionnaireDismissed: true,
  };
  assert.equal(isQuestionnaireSettled(dismissed), true);
  assert.equal(
    shouldShowQuestionnaireInvite({ isSignedIn: true, ...dismissed, handledThisSession: false }),
    false
  );
  assert.equal(
    shouldRouteWelcomeToQuestionnaire({ ...dismissed, replay: false, fromQuestionnaire: false }),
    false
  );
  // Not personalized, so the lobby is exactly the default one.
  assert.deepEqual(recommendGames(null).recommendations.map((g) => g.id).length > 0, true);
  assert.equal(shouldShowPersonalizedSection(recommendGames(null)), false);
  // And the escape hatch is permanent.
  assert.match(settings, /href="\/welcome\/questionnaire\?from=settings"/);
});

test("D. existing account that already answered: normal site → For You", () => {
  assert.equal(
    shouldShowQuestionnaireInvite({
      isSignedIn: true,
      onboardingCompleted: true,
      questionnaireCompleted: true,
      questionnaireDismissed: false,
      handledThisSession: false,
    }),
    false
  );
  assert.equal(shouldShowPersonalizedSection(recommendGames(FULL_ANSWERS)), true);
  // Answering never re-triggers onboarding.
  assert.equal(
    shouldRouteWelcomeToQuestionnaire({
      onboardingCompleted: true,
      questionnaireCompleted: true,
      questionnaireDismissed: false,
      replay: false,
      fromQuestionnaire: false,
    }),
    false
  );
});

test("E. changing preferences changes the recommendations", () => {
  // One answer changed, nothing else: the ranking and the primary picks both
  // move, and each answer floats exactly its own tag to the top.
  const strategy = recommendGames({ game_types: ["strategy"] });
  const chance = recommendGames({ game_types: ["luck_chance"] });
  assert.notDeepEqual(
    strategy.recommendations.map((g) => g.id),
    chance.recommendations.map((g) => g.id)
  );
  assert.notDeepEqual(strategy.primaryGameIds, chance.primaryGameIds);
  const taggedCount = (tag) => GAME_CATALOG.filter((g) => g.tags.includes(tag)).length;
  assert.ok(
    strategy.recommendations
      .slice(0, taggedCount("strategy"))
      .every((g) => g.tags.includes("strategy"))
  );
  assert.ok(
    chance.recommendations.slice(0, taggedCount("chance")).every((g) => g.tags.includes("chance"))
  );
  assert.equal(chance.recommendations[0].id, "roulette");

  // With the rest of the profile filled in, both the full order and the three
  // primary picks still differ — the change reaches the lobby section.
  const fullStrategy = recommendGames({ ...FULL_ANSWERS, game_types: ["strategy"] });
  const fullChance = recommendGames({ ...FULL_ANSWERS, game_types: ["luck_chance"] });
  assert.deepEqual(fullStrategy.primaryGameIds, ["poker", "chess", "tower-arena"]);
  assert.ok(fullStrategy.primaryGameIds.every((id) => !fullChance.primaryGameIds.includes(id)));
  assert.ok(fullChance.recommendations[0].score > recommendGames(null).recommendations[0].score);
  // The lobby section is derived from a fresh server read on every mount, so
  // the next visit to /casino reflects the new answers.
  assert.match(
    lobby,
    /fetch\("\/api\/onboarding\/recommendations", \{ credentials: "include" \}\)/
  );
});

test("F. no preferences: the existing casino experience, unchanged", () => {
  const baseline = recommendGames(null);
  assert.equal(baseline.personalized, false);
  assert.equal(baseline.complete, false);
  assert.deepEqual(
    baseline.recommendations.map((g) => g.score),
    baseline.recommendations.map(() => 0)
  );
  assert.equal(shouldShowPersonalizedSection(baseline), false);
  // The lobby still renders All Games, filters and sorts (covered in depth by
  // tests/lobby-for-you.test.mjs — this is the "not personalized" invariant).
  assert.match(lobby, /t\("home\.all_games"\)/);
  assert.match(lobby, /const showForYou =\n\s+forYouGames\.length > 0/);
});

// ── 8. Error handling ────────────────────────────────────────────────────

test("failures never trap, loop, or break gameplay", () => {
  // The load-error screen always offers a way out, not just a retry.
  assert.match(questionnaire, /t\("onboarding\.questionnaire\.error\.retry"\)/);
  assert.match(questionnaire, /t\("onboarding\.questionnaire\.error\.continue"\)/);
  assert.match(questionnaire, /href=\{destination\}/);
  // A failed save offers retry AND skip.
  assert.match(questionnaire, /t\("onboarding\.questionnaire\.saveFailed"\)/);
  assert.match(questionnaire, /onClick=\{\(\) => void submit\(\)\}/);

  // No loop is reachable: the questionnaire never sends anyone to itself, and
  // /welcome is exempt on the hand-off.
  for (const from of [undefined, "welcome", "lobby", "settings"]) {
    for (const onboardingCompleted of [true, false]) {
      assert.doesNotMatch(
        questionnaireDestination({ from, onboardingCompleted }),
        /^\/welcome\/questionnaire/
      );
    }
  }
  assert.match(source("src/app/welcome/page.tsx"), /params\?\.from === "questionnaire"/);

  // Onboarding completion state is never WRITTEN by the questionnaire (it is
  // read once, only to tell the flow whether the tutorial is still ahead).
  assert.doesNotMatch(route, /set\(\{[^}]*onboardingCompletedAt/);
  assert.match(route, /onboardingCompleted: user\.onboardingCompletedAt != null,/);
  assert.doesNotMatch(source(Q_DISMISS), /onboardingCompletedAt|firstGameCompletedAt/);
  assert.match(source(Q_COMPLETE), /onboardingCompletedAt/);
  // /casino and the game pages never redirect anywhere for personalization.
  assert.doesNotMatch(lobby, /window\.location\.(replace|href)/);
});

// ── 9. Accessibility ─────────────────────────────────────────────────────

test("the questionnaire is keyboard- and screen-reader-friendly", () => {
  // Single-select is a real radiogroup; multi-select is a labeled group with
  // pressed state, and the limit is announced by disabling the extra options.
  assert.match(questionnaire, /role="radiogroup"/);
  assert.match(questionnaire, /role="radio"/);
  assert.match(questionnaire, /aria-checked=\{selected\}/);
  assert.match(questionnaire, /aria-pressed=\{selected\}/);
  assert.match(questionnaire, /aria-labelledby="questionnaire-question"/);
  assert.match(questionnaire, /id="questionnaire-question"/);
  assert.match(questionnaire, /disabled=\{atLimit\}/);
  // Icon-only controls carry names.
  assert.match(questionnaire, /aria-label=\{t\("onboarding\.questionnaire\.back"\)\}/);
  // Progress is announced politely, and focus moves to the question.
  assert.match(questionnaire, /role="status" aria-live="polite"/);
  assert.match(questionnaire, /contentRef\.current\?\.focus\(\);/);
  // Arrow keys move between questions.
  assert.match(questionnaire, /e\.key === "ArrowRight"/);
  assert.match(questionnaire, /e\.key === "ArrowLeft"/);
  // Decorative icons are hidden from assistive tech.
  assert.match(questionnaire, /<IconPencil size=\{12\} aria-hidden="true" \/>/);
  // Validation and saving are announced.
  assert.match(questionnaire, /role="alert"/);
  assert.match(questionnaire, /t\("onboarding\.questionnaire\.savingHint"\)/);
});

test("touch targets are at least ~44px on the questionnaire and the Settings card", () => {
  // Option rows (~48px) and the primary footer buttons (~56px).
  assert.match(questionnaire, /rounded-2xl border px-4 py-3\.5 text-left/);
  assert.match(questionnaire, /rounded-2xl bg-\[#00e5ff\] px-8 py-4 text-base/);
  assert.match(
    questionnaire,
    /rounded-2xl bg-gradient-to-r from-\[#FFD700\] to-\[#FFB300\] px-8 py-4/
  );
  // Icon-only back button, skip and cancel are h-11 (44px).
  assert.match(questionnaire, /flex h-11 w-11 items-center justify-center rounded-full/);
  assert.match(questionnaire, /flex h-11 items-center rounded-full px-3/);
  assert.match(questionnaire, /h-11 rounded-full px-3 text-xs font-bold/);
  // The Settings card's two actions clear the bar too.
  assert.equal(settings.split("px-4 py-3 text-sm").length - 1, 2);
  // Every focusable control has a visible focus ring.
  assert.match(questionnaire, /focus-visible:ring-2 focus-visible:ring-\[#00e5ff\]/);
});

// ── 10. Localization ─────────────────────────────────────────────────────

test("every new user-facing string exists in en, fr and es", () => {
  const keys = [
    "onboarding.questionnaire.edit.badge",
    "onboarding.questionnaire.edit.save",
    "onboarding.questionnaire.edit.note",
    "onboarding.questionnaire.edit.cancel",
    "onboarding.questionnaire.invite.note",
    "onboarding.preferences.title",
    "onboarding.preferences.empty",
    "onboarding.preferences.emptyHint",
    "onboarding.preferences.cta",
    "onboarding.preferences.update",
    "onboarding.preferences.note",
    "onboarding.preferences.error",
    ...Object.values(WELCOME_MESSAGE_KEYS),
  ];
  for (const locale of LOCALES) {
    for (const key of keys) {
      const value = t(locale, key);
      assert.notEqual(value, key, `${locale} is missing ${key}`);
      assert.equal(typeof value, "string");
      assert.ok(value.trim().length > 0, `${locale} ${key} is empty`);
    }
  }
  // The locales aren't just English copies.
  const english = keys.map((key) => t("en", key));
  for (const locale of ["fr", "es"]) {
    const translated = keys.map((key) => t(locale, key));
    assert.notDeepEqual(translated, english, `${locale} looks untranslated`);
    const distinct = translated.filter((value) => !english.includes(value)).length;
    assert.ok(distinct >= keys.length - 1, `${locale} shares too many strings with English`);
  }
});

test("no new English literal is hardcoded in the edit surfaces", () => {
  const cardStart = settings.indexOf('t("onboarding.preferences.title")');
  const cardBlock = settings.slice(cardStart - 200, settings.indexOf("{/* Help & support */}"));
  assert.doesNotMatch(
    cardBlock,
    />\s*(Your GRYND Preferences|Update preferences|Set up my preferences|You haven't personalized)/
  );
  // Every visible string in the card is a t(...) call.
  assert.doesNotMatch(cardBlock, /<h2[^>]*>\s*[A-Za-z]/);
  const markedBlock = questionnaire.slice(
    questionnaire.indexOf('{mode === "edit" && ('),
    questionnaire.indexOf("rounded-full px-3 text-xs font-bold")
  );
  assert.doesNotMatch(markedBlock, />\s*(Editing your preferences|Save changes|Cancel)\s*</);
});

test("the catalog is the only source of question and option ids", () => {
  // Neither surface re-lists options: both go through QUESTIONNAIRE_QUESTIONS.
  assert.match(questionnaire, /QUESTIONNAIRE_QUESTIONS\.map\(\(q, i\) => \(/);
  assert.match(settings, /QUESTIONNAIRE_QUESTIONS\.map\(\(question\) => \{/);
  // The stable ids the API validates against are the ones the UI renders.
  for (const question of QUESTIONNAIRE_QUESTIONS) {
    assert.equal(getAllowedAnswers(question.key).length, question.options.length);
    assert.ok(question.titleKey.startsWith("onboarding.questionnaire."));
    for (const option of question.options) {
      assert.ok(option.labelKey.startsWith("onboarding.questionnaire."));
    }
  }
});
