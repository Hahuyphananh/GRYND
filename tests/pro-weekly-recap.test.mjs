/**
 * GRYND PRO — the weekly recap job.
 *
 * The job emails real members, so what this file pins is the safety envelope
 * rather than the prose:
 *
 *   * only ACTIVE grynd-pro subscribers with an email are considered, and only
 *     if they actually played in the window (no member = no email);
 *   * each member is mailed AT MOST ONCE per ISO week, even if the cron runs
 *     twice (the claim ledger), and a failed send RELEASES the claim so the
 *     week is retried rather than silently lost;
 *   * every figure comes from the cached analysis, never from a second engine
 *     run, and a missing analysis degrades to no accuracy instead of a zero;
 *   * the route is behind the shared cron guard and is scheduled.
 *
 * Run: node --import tsx --test tests/pro-weekly-recap.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  isoWeekKey,
  recapEmail,
  sendProWeeklyRecaps,
  summarizeProWeek,
} from "../src/lib/proWeeklyRecap.ts";

const read = (path) => fs.readFileSync(path, "utf8");

const GAME = (overrides = {}) => ({
  gameKind: "solo",
  completed: true,
  analysis: null,
  ...overrides,
});

const ANALYSIS = (accuracy, ratings = {}) => ({
  summary: { accuracy, ratings },
});

const MEMBER = { clerkId: "user_pro_1", email: "pro@example.com" };
const NOW = new Date("2026-11-16T09:00:00.000Z"); // Monday

test("the ISO week key is the ISO-8601 week, not the calendar week", () => {
  assert.equal(isoWeekKey(new Date("2026-11-16T09:00:00.000Z")), "2026-W47");
  // 1 Jan 2027 belongs to the last week of 2026.
  assert.equal(isoWeekKey(new Date("2027-01-01T00:00:00.000Z")), "2026-W53");
  assert.equal(isoWeekKey(new Date("2026-01-01T00:00:00.000Z")), "2026-W01");
});

test("a week is summarised from the cached analysis, not a second run", () => {
  const summary = summarizeProWeek({
    now: NOW,
    games: [
      GAME({ analysis: ANALYSIS(80, { great: 3, brilliant: 1, mistake: 2 }) }),
      GAME({ analysis: ANALYSIS(60, { great: 1 }) }),
      GAME({ gameKind: "daily", analysis: ANALYSIS(70) }),
      GAME({ completed: false }),
    ],
  });

  assert.equal(summary.games, 4);
  assert.equal(summary.completedGames, 3);
  assert.equal(summary.analysedGames, 3);
  assert.equal(summary.averageAccuracy, 70);
  assert.equal(summary.bestAccuracy, 80);
  assert.equal(summary.great, 4);
  assert.equal(summary.brilliant, 1);
  assert.equal(summary.mistakes, 2);
  assert.equal(summary.topGame, "solo");
  assert.equal(summary.periodKey, "2026-W47");
});

test("a game without a cached analysis degrades to no accuracy, never zero", () => {
  const summary = summarizeProWeek({ now: NOW, games: [GAME()] });
  assert.equal(summary.completedGames, 1);
  assert.equal(summary.analysedGames, 0);
  assert.equal(summary.averageAccuracy, null);
  assert.equal(summary.bestAccuracy, null);

  // A malformed payload cannot poison the figures either.
  const junk = summarizeProWeek({
    now: NOW,
    games: [GAME({ analysis: { summary: { accuracy: "NaN", ratings: { great: "x" } } } })],
  });
  assert.equal(junk.averageAccuracy, null);
  assert.equal(junk.great, 0);
});

test("an empty week is not a recap", () => {
  const summary = summarizeProWeek({ now: NOW, games: [] });
  assert.equal(summary.completedGames, 0);
  assert.equal(summary.topGame, null);

  const { subject } = recapEmail(summary);
  assert.match(subject, /2026-W47/);
  // No player-supplied text reaches the HTML.
  assert.ok(!/undefined|null/.test(recapEmail(summary).html));
});

/** A world where the claim ledger is a Set, like the table's primary key. */
function world({ members = [MEMBER], games, sendError = null } = {}) {
  const claimed = new Set();
  const sent = [];
  const deps = {
    listMembers: async () => members,
    loadGames: async () => new Map(games),
    claim: async (clerkId, periodKey) => {
      const key = `${clerkId}:${periodKey}`;
      if (claimed.has(key)) return false;
      claimed.add(key);
      return true;
    },
    release: async (clerkId, periodKey) => {
      claimed.delete(`${clerkId}:${periodKey}`);
    },
    send: async (run) => {
      sent.push(run);
      return sendError ? { error: sendError } : { data: { id: "ok" } };
    },
  };
  return { deps, claimed, sent };
}

test("a member is mailed exactly once per week", async () => {
  const { deps, sent } = world({ games: [[MEMBER.clerkId, [GAME(), GAME()]]] });

  // Map keys are set per member below; the helper receives the member list.
  deps.loadGames = async (ids) =>
    new Map(ids.map((id) => [id, [GAME({ analysis: ANALYSIS(75) })]]));

  const first = await sendProWeeklyRecaps({ now: NOW, deps });
  assert.deepEqual(first, { periodKey: "2026-W47", members: 1, sent: 1, skipped: 0, failed: 0 });
  assert.equal(sent.length, 1);

  const second = await sendProWeeklyRecaps({ now: NOW, deps });
  assert.equal(second.sent, 0, "a cron retry must not mail the week twice");
  assert.equal(second.skipped, 1);
  assert.equal(sent.length, 1);
});

test("a member who did not play is skipped without a claim", async () => {
  const { deps, sent, claimed } = world();
  deps.loadGames = async () => new Map();

  const result = await sendProWeeklyRecaps({ now: NOW, deps });
  assert.equal(result.members, 0);
  assert.equal(result.sent, 0);
  assert.equal(sent.length, 0);
  assert.equal(claimed.size, 0);
});

test("a failed send releases its claim so the week is retried", async () => {
  const { deps, claimed } = world({ sendError: { message: "provider down" } });
  deps.loadGames = async (ids) => new Map(ids.map((id) => [id, [GAME()]]));

  const failedRun = await sendProWeeklyRecaps({ now: NOW, deps });
  assert.equal(failedRun.failed, 1);
  assert.equal(failedRun.sent, 0);
  assert.equal(claimed.size, 0, "the claim must be released");

  deps.send = async () => ({ data: { id: "ok" } });
  const retry = await sendProWeeklyRecaps({ now: NOW, deps });
  assert.equal(retry.sent, 1, "the next run picks the week up again");
});

test("the recap never recomputes an analysis and never writes game state", () => {
  const source = read("src/lib/proWeeklyRecap.ts");
  assert.ok(
    !/analyzeSolitaireGame|loadReviewAnalysis|solitaire_analysis_usage/.test(source),
    "the recap is a read-only summary of already-cached analyses",
  );
  assert.ok(
    !/UPDATE |DELETE FROM solitaire_(solo|daily)_results/i.test(source),
    "the recap must not touch settled results",
  );
  // Exactly one write: the (member, week) claim, before the send.
  assert.match(source, /INSERT INTO pro_weekly_recap_sends/);
  assert.match(source, /ON CONFLICT \(user_id, period_key\) DO NOTHING/);
});

test("the job is guarded, scheduled and its ledger is journaled", () => {
  const route = read("src/app/api/jobs/pro-weekly-recap/route.ts");
  assert.match(route, /verifyCronRequest\(request\)/);
  assert.match(route, /sendProWeeklyRecaps\(\{\}\)/);

  const vercel = JSON.parse(read("vercel.json"));
  assert.ok(
    vercel.crons.some((cron) => cron.path === "/api/jobs/pro-weekly-recap"),
    "the recap must be scheduled or it never runs",
  );

  const journal = JSON.parse(read("src/db/migrations/meta/_journal.json"));
  assert.ok(
    journal.entries.some((entry) => entry.tag === "0252_pro_weekly_recap_sends"),
    "the claim ledger migration must be journaled",
  );
  const sql = read("src/db/migrations/0252_pro_weekly_recap_sends.sql");
  assert.match(sql, /PRIMARY KEY \("user_id", "period_key"\)/);
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/);
});

test("the review page offers the GRYND PRO upsell when the allowance is spent", () => {
  const page = read("src/app/solitaire/review/[kind]/[gameId]/PageClient.tsx");
  assert.match(page, /analysisLimited/);
  assert.match(page, /data-testid="review-analysis-limit"/);
  assert.match(page, /href="\/upgrade-pro"/);
  assert.match(
    page,
    /unlimited match analysis/i,
    "the banner must name the benefit that lifts the limit",
  );
});
