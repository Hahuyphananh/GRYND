/**
 * tests/daily-archive.test.mjs
 *
 * The PRO Daily Archive: today's deal stays free, a past deal is PRO.
 *
 * WHAT IS TESTED FOR REAL (pure):
 *   * the calendar helpers that decide whether a date is a real UTC day, which
 *     days the archive window lists, and that today is never in it;
 *   * the deterministic deal for a past date is the SAME deal the server dealt
 *     that day (dailyDealFor is a pure function of the date key).
 *
 * WHAT IS TESTED STRUCTURALLY (source contracts, no live database):
 *   * the play route resolves the date on the SERVER and refuses a free caller
 *     for a past date with PRO_REQUIRED, while today needs no membership;
 *   * the submission route replays against the requested date's deal and
 *     records that date, so an archive run cannot overwrite today's result;
 *   * the archive list reveals no dates to a free caller;
 *   * the page reads ?date= and the panel links back through the same page.
 *
 * NO DATABASE / STRIPE / BROWSER IS USED. A green run proves the rules and
 * contracts, not that a live subscription was checked.
 *
 * Run: node --import tsx --test tests/daily-archive.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  DAILY_ARCHIVE_DAYS,
  dailyArchiveDateKeys,
  isPastDailyDateKey,
  isValidDailyDateKey,
} from "../src/lib/solitaire-duel/dailyArchive.ts";
import { dailyDealFor, dailyDealSeed } from "../src/lib/solitaire-duel/daily.ts";
import { dailyDateKey, shiftDateKey } from "../src/lib/solitaire-duel/soloStats.js";

const read = (rel) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");
const TODAY = "2026-11-15";

test("a date key is only valid when it names a real UTC calendar day", () => {
  assert.equal(isValidDailyDateKey("2026-11-15"), true);
  assert.equal(isValidDailyDateKey("2024-02-29"), true); // leap day
  assert.equal(isValidDailyDateKey("2026-02-31"), false); // rolls into March
  assert.equal(isValidDailyDateKey("2026-13-01"), false);
  assert.equal(isValidDailyDateKey("15-11-2026"), false);
  assert.equal(isValidDailyDateKey("2026-11-15T00:00:00Z"), false);
  assert.equal(isValidDailyDateKey(null), false);
  assert.equal(isValidDailyDateKey(""), false);
});

test("past means strictly before today, in UTC", () => {
  assert.equal(isPastDailyDateKey("2026-11-14", TODAY), true);
  assert.equal(isPastDailyDateKey("2025-01-01", TODAY), true);
  assert.equal(isPastDailyDateKey(TODAY, TODAY), false);
  assert.equal(isPastDailyDateKey("2026-11-16", TODAY), false);
  assert.equal(isPastDailyDateKey("2026-02-31", TODAY), false);
});

test("the archive window is the past N days, newest first, without today", () => {
  const days = dailyArchiveDateKeys(TODAY);
  assert.equal(days.length, DAILY_ARCHIVE_DAYS);
  assert.equal(days[0], "2026-11-14");
  assert.equal(days[1], "2026-11-13");
  assert.ok(!days.includes(TODAY), "today is the free challenge, not the archive");
  assert.equal(new Set(days).size, days.length);

  const first = shiftDateKey(TODAY, -DAILY_ARCHIVE_DAYS);
  assert.equal(days[days.length - 1], first);

  // Bounded: a caller cannot ask for an unbounded list.
  assert.equal(dailyArchiveDateKeys(TODAY, 0).length, 0);
  assert.equal(dailyArchiveDateKeys(TODAY, 10_000).length, 365);
});

test("an archived date derives the exact deal the server dealt that day", () => {
  const dateKey = "2026-03-04";
  const first = dailyDealFor(dateKey);
  const second = dailyDealFor(dateKey);
  assert.deepEqual(first, second, "the mapping is deterministic");
  assert.equal(dailyDealSeed(dateKey), dailyDealSeed(dateKey));
  assert.notEqual(dailyDealSeed(dateKey), dailyDealSeed("2026-03-05"));
  assert.ok(Array.isArray(first.tableau) && first.tableau.length > 0);
});

test("the play route keeps today free and gates a past date on the SERVER", () => {
  const source = read("src/app/api/solitaire/daily/route.ts");

  assert.match(source, /import \{ getMembershipTier \}/);
  assert.match(source, /searchParams\.get\("date"\)/);
  assert.match(source, /archived = dateKey !== todayKey/);
  // The past-date gate is a subscription read, not a request field.
  assert.match(source, /getMembershipTier\(userId\)/);
  assert.match(source, /PRO_REQUIRED/);
  assert.match(source, /Past Daily Challenges are a GRYND PRO feature/);

  // Future dates cannot be requested at all.
  assert.match(source, /has not been dealt yet/);

  // Today's path still deals from the server clock and needs no tier.
  assert.match(source, /const todayKey = dailyDateKey\(\)/);
  assert.match(source, /dailyDealFor\(dateKey\)/);
});

test("the submission route records the requested date, never today's row", () => {
  const source = read("src/app/api/solitaire/daily/route.ts");

  assert.match(source, /dateKey\?: unknown/);
  assert.match(source, /const dateKey = typeof requestedDate === "string" \? requestedDate : todayKey/);
  assert.match(source, /challengeDate: dateKey/);
  // The replay uses the SAME date's deal, so an archive run is not verified
  // against today's cards.
  assert.match(source, /const deal = dailyDealFor\(dateKey\)/);
  // The unique (user, date) index still makes a repeated archive run a no-op.
  assert.match(source, /onConflictDoNothing/);
});

test("the archive list reveals no dates to a free caller", () => {
  const source = read("src/app/api/solitaire/daily/archive/route.ts");

  assert.match(source, /getMembershipTier\(userId\)/);
  assert.match(source, /pro: false, locked: true, today, days: \[\]/);
  assert.match(source, /dailyArchiveDateKeys\(today\)/);
  // Only the caller's own rows are read.
  assert.match(source, /eq\(solitaireDailyResults\.userId, userId\)/);
});

test("the page carries ?date= and the archive panel links through it", () => {
  const page = read("src/app/daily/PageClient.tsx");
  assert.match(page, /searchParams|window\.location\.search/);
  assert.match(page, /\/api\/solitaire\/daily\?date=/);
  assert.match(page, /<DailyArchivePanel \/>/);
  assert.match(page, /daily-archive-locked/);

  const panel = read("src/components/play/DailyArchivePanel.tsx");
  assert.match(panel, /\/api\/solitaire\/daily\/archive/);
  assert.match(panel, /\/daily\?date=/);
  assert.match(panel, /Today&apos;s deal stays free for everyone/);

  // The game submits the date it was dealt, so an archive run records that day.
  const game = read("src/components/solitaire-duel/SoloSolitaireGame.tsx");
  assert.match(game, /dateKey: finished\.dateKey, moves: finished\.log/);
});

test("the free daily response does not become an archive by accident", () => {
  const route = read("src/app/api/solitaire/daily/route.ts");
  // The free path is the same GET with no `date`; it must not require a tier.
  const getBody = route.slice(route.indexOf("export async function GET"), route.indexOf("export async function POST"));
  assert.ok(!/getMembershipTier/.test(getBody.split("if (archived)")[0]));
  assert.match(getBody, /const dateKey = requested \?\? todayKey/);
});
