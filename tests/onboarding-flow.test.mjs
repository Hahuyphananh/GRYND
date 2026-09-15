// tests/onboarding-flow.test.mjs
//
// The onboarding FLOW rules (src/lib/onboardingFlow.js) plus the source
// contracts that keep the three onboarding states independent:
//
//   onboarding_completed_at    → /welcome tutorial      (0142)
//   first_game_completed_at    → onboarding RPS match   (0143)
//   questionnaire_completed_at → questionnaire          (0157)
//   questionnaire_dismissed_at → invitation declined    (0158)
//
// The decision helpers are pure, so every scenario below (new account,
// answer, skip, existing account, invite clicks, refresh, direct navigation,
// unauthorized access) is asserted without rendering a page — and the routing
// assertions pin the wiring so the pages can't drift from the rules.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const {
  QUESTIONNAIRE_INVITE_SESSION_KEY,
  isQuestionnaireSettled,
  questionnaireDestination,
  shouldRouteWelcomeToQuestionnaire,
  shouldShowQuestionnaireInvite,
} = await import("../src/lib/onboardingFlow.js");

const read = (relPath) => fs.readFileSync(path.join(process.cwd(), relPath), "utf8");

const WELCOME_PAGE = "src/app/welcome/page.tsx";
const WELCOME_CLIENT = "src/app/welcome/PageClient.tsx";
const QUESTIONNAIRE_PAGE = "src/app/welcome/questionnaire/page.tsx";
const QUESTIONNAIRE_CLIENT = "src/app/welcome/questionnaire/PageClient.tsx";
const QUESTIONNAIRE_ROUTE = "src/app/api/onboarding/questionnaire/route.ts";
const DISMISS_ROUTE = "src/app/api/onboarding/questionnaire/dismiss/route.ts";
const STATUS_ROUTE = "src/app/api/onboarding/status/route.ts";
const FIRST_GAME_ROUTE = "src/app/api/onboarding/first-game-complete/route.ts";
const LOBBY = "src/app/casino/PageClient.jsx";
const SETTINGS = "src/app/settings/PageClient.jsx";
const SYNC = "src/app/sync/PageClient.tsx";
const PROXY = "src/proxy.ts";
const MIGRATION = "src/db/migrations/0158_questionnaire_dismissal.sql";
const LOCALES = ["en", "fr", "es"];

const { t } = await import("../src/lib/appTextTranslations.js");

// ── Shared state helper ────────────────────────────────────────────────────

/** Server state of a brand-new account (nothing completed, nothing declined). */
const NEW_ACCOUNT = {
  onboardingCompleted: false,
  questionnaireCompleted: false,
  questionnaireDismissed: false,
};

/** Server state of an account that finished the old tutorial before the
 *  questionnaire existed (the 0142/0143 backfill shape). */
const EXISTING_ACCOUNT = {
  onboardingCompleted: true,
  questionnaireCompleted: false,
  questionnaireDismissed: false,
};

// ── Scenario 1: completely new account ─────────────────────────────────────

test("1. a brand-new account is sent to the questionnaire before the tutorial", () => {
  assert.equal(
    shouldRouteWelcomeToQuestionnaire({
      ...NEW_ACCOUNT,
      replay: false,
      fromQuestionnaire: false,
    }),
    true
  );
  // New signups start at the questionnaire (the /sync hand-off).
  assert.match(read(SYNC), /isNewUser \? "\/welcome\/questionnaire" : "\/"/);
  // …and it is reachable before the age gate.
  assert.match(read(PROXY), /"\/welcome\/questionnaire\(\.\*\)"/);
  // The lobby does NOT invite them (that invitation is for existing players).
  assert.equal(
    shouldShowQuestionnaireInvite({
      isSignedIn: true,
      ...NEW_ACCOUNT,
      handledThisSession: false,
    }),
    false
  );
});

// ── Scenario 2: new account completes the questionnaire ────────────────────

test("2. completing the questionnaire continues into the existing tutorial", () => {
  const destination = questionnaireDestination({
    from: "welcome",
    onboardingCompleted: false,
  });
  assert.equal(destination, "/welcome?from=questionnaire");

  // /welcome reads the marker and never bounces back → no loop.
  assert.match(read(WELCOME_PAGE), /params\?\.from === "questionnaire"/);
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
  // Answered accounts are never invited again.
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
  assert.equal(
    isQuestionnaireSettled({ questionnaireCompleted: true, questionnaireDismissed: false }),
    true
  );
});

// ── Scenario 3: new account skips ──────────────────────────────────────────

test("3. skipping is supported, never marks the questionnaire answered", () => {
  const client = read(QUESTIONNAIRE_CLIENT);
  // Skip posts the dismissal (server-authoritative "Maybe Later")…
  assert.match(client, /api\/onboarding\/questionnaire\/dismiss/);
  assert.match(client, /keepalive: true/);
  // …and never the completion endpoint or the answers endpoint with a partial
  // payload.
  assert.doesNotMatch(client, /api\/onboarding\/complete/);
  // A skipped (dismissed) account is settled: no re-ask, and no bounce loop.
  assert.equal(
    isQuestionnaireSettled({ questionnaireCompleted: false, questionnaireDismissed: true }),
    true
  );
  assert.equal(
    shouldRouteWelcomeToQuestionnaire({
      onboardingCompleted: false,
      questionnaireCompleted: false,
      questionnaireDismissed: true,
      replay: false,
      fromQuestionnaire: false,
    }),
    false
  );
  // The dismissal endpoint deliberately does not touch completion.
  const dismiss = read(DISMISS_ROUTE);
  assert.match(dismiss, /set\(\{ questionnaireDismissedAt: new Date\(\) \}\)/);
  assert.doesNotMatch(dismiss, /questionnaireCompletedAt/);
});

// ── Scenario 4: new account completes the welcome tutorial ─────────────────

test("4. finishing the tutorial flips only onboarding_completed_at", () => {
  // The tutorial's own completion endpoint is untouched by this work.
  const complete = read("src/app/api/onboarding/complete/route.ts");
  assert.match(complete, /set\(\{ onboardingCompletedAt: new Date\(\) \}\)/);
  assert.doesNotMatch(complete, /questionnaire/);

  // Afterwards, an unanswered (but not dismissed) account becomes eligible for
  // the lightweight invitation instead of being sent through the tutorial.
  assert.equal(
    shouldRouteWelcomeToQuestionnaire({
      ...EXISTING_ACCOUNT,
      replay: false,
      fromQuestionnaire: false,
    }),
    false
  );
  assert.equal(
    shouldShowQuestionnaireInvite({
      isSignedIn: true,
      ...EXISTING_ACCOUNT,
      handledThisSession: false,
    }),
    true
  );
});

// ── Scenario 5: the RPS onboarding match is unchanged ─────────────────────

test("5. the existing first-game completion semantics are untouched", () => {
  const route = read(FIRST_GAME_ROUTE);
  // The atomic one-time claim + XP grant stay exactly as they were.
  assert.match(route, /isNull\(users\.firstGameCompletedAt\)/);
  assert.match(route, /FIRST_GAME_BONUS_XP/);
  assert.match(route, /addExp\(/);
  // Nothing in this feature writes first_game_completed_at.
  for (const file of [QUESTIONNAIRE_ROUTE, DISMISS_ROUTE]) {
    assert.doesNotMatch(read(file), /firstGameCompletedAt:\s*new Date\(\)/);
  }
  // The RPS page still calls that endpoint from a real terminal state.
  const rps = read("src/app/casino/rps/play-ai/PageClient.tsx");
  assert.match(rps, /api\/onboarding\/first-game-complete/);
  assert.match(rps, /if \(tutorial\.mode !== "active" \|\| !matchOver\) return;/);
});

// ── Scenario 6: existing account, no questionnaire ────────────────────────

test("6. an existing account is never sent back through the tutorial", () => {
  assert.equal(
    shouldRouteWelcomeToQuestionnaire({
      ...EXISTING_ACCOUNT,
      replay: false,
      fromQuestionnaire: false,
    }),
    false
  );
  const lobby = read(LOBBY);
  assert.match(lobby, /shouldShowQuestionnaireInvite\(\{/);
  // The invitation only renders for signed-in users with the tutorial done.
  assert.match(lobby, /onboardingCompleted: ok \? data\.onboardingCompleted === true : null/);
});

// ── Scenario 7: existing account clicks "Customize My GRYND" ──────────────

test("7. Customize My GRYND opens the questionnaire and returns to the lobby", () => {
  const lobby = read(LOBBY);
  assert.match(lobby, /href="\/welcome\/questionnaire\?from=lobby"/);
  assert.match(lobby, /onboarding\.questionnaire\.invite\.primary/);
  // An existing player submitting from the lobby goes to the lobby, not into
  // onboarding.
  assert.equal(questionnaireDestination({ from: "lobby", onboardingCompleted: true }), "/casino");
  // The page accepts that origin.
  assert.match(read(QUESTIONNAIRE_PAGE), /params\?\.from === "lobby"/);
});

// ── Scenario 8: existing account clicks "Maybe Later" ─────────────────────

test("8. Maybe Later dismisses server-side and never repeats", () => {
  const lobby = read(LOBBY);
  assert.match(lobby, /onboarding\.questionnaire\.invite\.secondary/);
  assert.match(lobby, /onClick=\{dismissQuestionnaireInvite\}/);
  // Session suppressor + server flag, matching the existing lobby pattern.
  assert.match(lobby, /sessionStorage\.setItem\(QUESTIONNAIRE_INVITE_SESSION_KEY, "1"\)/);
  assert.match(lobby, /fetch\("\/api\/onboarding\/questionnaire\/dismiss"/);

  // Once dismissed it is settled for good, in both surfaces.
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
  // Dismissal needs the same session-flag semantics on the questionnaire page.
  assert.match(read(QUESTIONNAIRE_CLIENT), /onboarding\.questionnaire\.skip/);

  // The migration keeps the invitation eligible by default (no backfill), and
  // the status route reports the flag independently.
  const sql = read(MIGRATION);
  assert.match(
    sql,
    /ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "questionnaire_dismissed_at" timestamptz/
  );
  assert.doesNotMatch(sql, /UPDATE\s+"users"\s+SET\s+"questionnaire_dismissed_at"/i);
  assert.match(read(STATUS_ROUTE), /questionnaireDismissedAt: users\.questionnaireDismissedAt/);
  const journal = JSON.parse(read("src/db/migrations/meta/_journal.json").replace(/^\uFEFF/, ""));
  assert.ok(
    journal.entries.some((e) => e.tag === "0158_questionnaire_dismissal"),
    "journal entry missing — db:migrate would skip the migration"
  );
});

// ── Scenario 9: existing account that already answered ───────────────────

test("9. an answered account never sees the questionnaire again", () => {
  const answered = {
    onboardingCompleted: true,
    questionnaireCompleted: true,
    questionnaireDismissed: false,
  };
  assert.equal(
    shouldShowQuestionnaireInvite({ isSignedIn: true, ...answered, handledThisSession: false }),
    false
  );
  assert.equal(
    shouldRouteWelcomeToQuestionnaire({ ...answered, replay: false, fromQuestionnaire: false }),
    false
  );
  // Only an explicit Settings entry point can reopen it.
  assert.match(read(SETTINGS), /href="\/welcome\/questionnaire\?from=settings"/);
  // …and that entry point is the "Your GRYND Preferences" card, which shows
  // the saved answers rather than a bare link.
  assert.match(read(SETTINGS), /t\("onboarding\.preferences\.title"\)/);
  assert.equal(
    questionnaireDestination({ from: "settings", onboardingCompleted: true }),
    "/settings"
  );
});

// ── Scenario 10/11: refresh mid-flow ──────────────────────────────────────

test("10. refreshing during the questionnaire keeps the answers", () => {
  const client = read(QUESTIONNAIRE_CLIENT);
  assert.match(client, /grynd:questionnaire:draft:/);
  assert.match(client, /sessionStorage\.setItem\(draftKey/);
  assert.match(client, /sessionStorage\.getItem\(draftKey\)/);
  // The server snapshot still prefills underneath the local draft.
  assert.match(client, /api\/onboarding\/questionnaire/);
  assert.match(client, /nextAnswers = \{ \.\.\.serverAnswers, \.\.\.parsed\.answers \}/);
});

test("11. the existing tutorial's refresh resume is untouched", () => {
  const client = read(WELCOME_CLIENT);
  assert.match(client, /grynd:welcome:step:/);
  assert.match(
    client,
    /if \(Number\.isInteger\(saved\) && saved > 0 && saved <= TOTAL_STEPS - 1\)/
  );
});

// ── Scenario 12/13: direct navigation ─────────────────────────────────────

test("12. direct navigation to /welcome only bounces unanswered new accounts", () => {
  assert.equal(
    shouldRouteWelcomeToQuestionnaire({
      ...NEW_ACCOUNT,
      replay: false,
      fromQuestionnaire: false,
    }),
    true
  );
  // Replay (Settings) always shows the tutorial, never the questionnaire.
  assert.equal(
    shouldRouteWelcomeToQuestionnaire({
      ...NEW_ACCOUNT,
      replay: true,
      fromQuestionnaire: false,
    }),
    false
  );
  assert.match(
    read(WELCOME_CLIENT),
    /import \{ shouldRouteWelcomeToQuestionnaire \} from "\.\.\/\.\.\/lib\/onboardingFlow"/
  );
  assert.match(
    read(WELCOME_CLIENT),
    /window\.location\.replace\("\/welcome\/questionnaire\?from=welcome"\)/
  );
});

test("13. direct navigation to the questionnaire works and prefills", () => {
  const page = read(QUESTIONNAIRE_PAGE);
  assert.match(page, /params\?\.from === "welcome"/);
  assert.match(page, /params\?\.from === "settings"/);
  const client = read(QUESTIONNAIRE_CLIENT);
  // Prefill from the server (edit mode) rather than starting blank.
  assert.match(client, /credentials: "include",/);
  // Statically reachable before sign-in is complete: the page itself bounces
  // signed-out visitors home instead of erroring.
  assert.match(client, /if \(!isSignedIn\) \{\s+window\.location\.replace\("\/"\);/);
});

// ── Scenario 14: unauthorized API access ──────────────────────────────────

test("14. the write endpoints reject unauthenticated callers", () => {
  for (const file of [QUESTIONNAIRE_ROUTE, DISMISS_ROUTE]) {
    const src = read(file);
    assert.match(src, /const \{ userId \} = await auth\(\);/);
    assert.match(src, /if \(!userId\)/);
    // 401 (or a helper that returns 401) — never a silent write.
    assert.match(src, /status: 401|unauthorized\(\)/);
  }
  assert.match(read(DISMISS_ROUTE), /export async function POST/);
  // /api/onboarding/status is a public read and deliberately reports the
  // logged-out visitor as fully onboarded/settled (documented behavior), so
  // nothing prompts them — that is also the "unauthorized" answer for it.
  const status = read(STATUS_ROUTE);
  assert.match(status, /if \(!userId\) \{/);
  assert.match(status, /questionnaireDismissed: true,/);
});

// ── State separation + loop safety ────────────────────────────────────────

test("the four onboarding states stay independent", () => {
  // Submitting answers must never clear the dismissal flag (or vice versa):
  // the two questionnaire states are written by different endpoints.
  assert.doesNotMatch(read(QUESTIONNAIRE_ROUTE), /questionnaireDismissedAt/);
  assert.doesNotMatch(read(DISMISS_ROUTE), /questionnaireCompletedAt/);
  assert.doesNotMatch(read(QUESTIONNAIRE_ROUTE), /set\(\{[^}]*onboardingCompletedAt/);

  // Every flag is reported separately by the status API.
  const status = read(STATUS_ROUTE);
  for (const key of [
    /onboardingCompleted:/,
    /firstGameCompleted,/,
    /questionnaireCompleted,/,
    /questionnaireDismissed,/,
  ]) {
    assert.match(status, key);
  }
  // …and the anonymous branch settles all four so nobody is prompted.
  const anonymousBlock = status.slice(0, status.indexOf("const rows"));
  for (const key of [
    /onboardingCompleted: true/,
    /firstGameCompleted: true/,
    /questionnaireCompleted: true/,
    /questionnaireDismissed: true/,
  ]) {
    assert.match(anonymousBlock, key);
  }
});

test("the questionnaire can never loop with /welcome", () => {
  // 1. The questionnaire never sends you back to itself.
  for (const from of [undefined, "welcome", "lobby", "settings"]) {
    for (const onboardingCompleted of [true, false]) {
      const destination = questionnaireDestination({ from, onboardingCompleted });
      assert.doesNotMatch(destination, /^\/welcome\/questionnaire/);
    }
  }
  // 2. /welcome never bounces a player who just came from the questionnaire.
  const states = [
    { onboardingCompleted: true, questionnaireCompleted: false, questionnaireDismissed: false },
    { onboardingCompleted: false, questionnaireCompleted: true, questionnaireDismissed: false },
    { onboardingCompleted: false, questionnaireCompleted: false, questionnaireDismissed: true },
    { onboardingCompleted: false, questionnaireCompleted: false, questionnaireDismissed: false },
  ];
  for (const state of states) {
    assert.equal(
      shouldRouteWelcomeToQuestionnaire({ ...state, replay: false, fromQuestionnaire: true }),
      false
    );
  }
  // 3. A settled questionnaire is never bounced anywhere either.
  assert.equal(
    shouldRouteWelcomeToQuestionnaire({
      onboardingCompleted: false,
      questionnaireCompleted: true,
      questionnaireDismissed: false,
      replay: false,
      fromQuestionnaire: false,
    }),
    false
  );
});

test("every invitation string exists in all three locales", () => {
  for (const locale of LOCALES) {
    for (const key of [
      "onboarding.questionnaire.invite.title",
      "onboarding.questionnaire.invite.body",
      "onboarding.questionnaire.invite.primary",
      "onboarding.questionnaire.invite.secondary",
      "onboarding.questionnaire.invite.note",
    ]) {
      assert.notEqual(t(locale, key), key, `${locale} is missing ${key}`);
    }
  }
  // The English invitation copy matches the agreed wording.
  assert.equal(t("en", "onboarding.questionnaire.invite.title"), "Make GRYND yours");
  assert.equal(
    t("en", "onboarding.questionnaire.invite.body"),
    "Tell us what kind of games you like and we'll personalize your GRYND experience."
  );
  assert.equal(t("en", "onboarding.questionnaire.invite.primary"), "Customize My GRYND");
  assert.equal(t("en", "onboarding.questionnaire.invite.secondary"), "Maybe Later");
});
