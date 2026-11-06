// tests/guest-progress-ui.test.mjs
//
// Phase 2F — the guest progression interface.
//
// What is under test:
//
//   1. The VIEW MODEL: a new guest with no results, a guest with results, a
//      guest with several games, an expired/missing cookie (401/403) and a real
//      API failure all map to the right screen state. A missing cookie must
//      never look like an error, and an unreadable payload must never look like
//      "you have played nothing".
//   2. The PANEL: it reads only the session-scoped endpoint, asks for no guest
//      id, shows the Guest identity, loading/empty/no-session states, an account
//      invitation and a games link, is responsive, and never renders Elo,
//      trophies, balances or leaderboard positions.
//   3. The PROFILE: the panel is rendered in /profil's signed-out branch only;
//      the signed-in profile is untouched.
//   4. The COPY: every `guestProgress.*` key exists in EN, FR and ES.
//
// Run: node --import tsx --test tests/guest-progress-ui.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  GUEST_GAME_LABELS,
  buildGuestGameRows,
  buildGuestHistoryRows,
  guestGameLabel,
  guestWinRate,
  normalizeGuestProgressResponse,
} from "../src/lib/guest/guestProgressView.ts";
import { APP_TEXT_TRANSLATIONS } from "../src/lib/appTextTranslations.js";

const read = (rel) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");

/** Source without comments, so prose about "no Elo" never satisfies a check. */
const code = (rel) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const PANEL = "src/components/guest/GuestProgressPanel.tsx";
const VIEW_MODEL = "src/lib/guest/guestProgressView.ts";
const PROFILE = "src/app/profil/PageClient.jsx";

// ── Fixtures ────────────────────────────────────────────────────────────────

const EMPTY = {
  profile: { createdAt: null, lastSeenAt: null },
  totals: { matches: 0, wins: 0, losses: 0, draws: 0 },
  games: [],
  history: [],
};

const ONE_GAME = {
  profile: { createdAt: "2026-10-01T10:00:00.000Z", lastSeenAt: "2026-11-01T10:00:00.000Z" },
  totals: { matches: 3, wins: 2, losses: 1, draws: 0 },
  games: [{ gameKey: "tic-tac-toe", matches: 3, wins: 2, losses: 1, draws: 0 }],
  history: [
    {
      gameKey: "tic-tac-toe",
      result: "win",
      aiDifficulty: "normal",
      playedAt: "2026-11-01T10:00:00.000Z",
    },
    {
      gameKey: "tic-tac-toe",
      result: "loss",
      aiDifficulty: "hard",
      playedAt: "2026-10-31T10:00:00.000Z",
    },
  ],
};

const MULTI_GAME = {
  profile: { createdAt: "2026-10-01T10:00:00.000Z", lastSeenAt: "2026-11-02T10:00:00.000Z" },
  totals: { matches: 7, wins: 3, losses: 2, draws: 2 },
  games: [
    { gameKey: "battleship", matches: 2, wins: 1, losses: 1, draws: 0 },
    { gameKey: "dominoes", matches: 3, wins: 1, losses: 1, draws: 1 },
    { gameKey: "odds", matches: 2, wins: 1, losses: 0, draws: 1 },
  ],
  history: [
    { gameKey: "odds", result: "draw", aiDifficulty: null, playedAt: "2026-11-02T10:00:00.000Z" },
    { gameKey: "dominoes", result: "win", aiDifficulty: "normal", playedAt: "2026-11-01T10:00:00.000Z" },
    { gameKey: "battleship", result: "loss", aiDifficulty: "hard", playedAt: "2026-10-30T10:00:00.000Z" },
  ],
};

const ok = (data) => ({ success: true, data });

// ── 1. View model: the five required situations ─────────────────────────────

test("a new guest with no results is a valid empty record, not an error", () => {
  const view = normalizeGuestProgressResponse(200, ok(EMPTY));
  assert.equal(view.status, "ready");
  assert.deepEqual(view.data.totals, { matches: 0, wins: 0, losses: 0, draws: 0 });
  assert.deepEqual(buildGuestGameRows(view.data), []);
  assert.deepEqual(buildGuestHistoryRows(view.data), []);
});

test("a guest with results gets totals, a per-game row and a history", () => {
  const view = normalizeGuestProgressResponse(200, ok(ONE_GAME));
  assert.equal(view.status, "ready");
  assert.equal(view.data.totals.matches, 3);

  const rows = buildGuestGameRows(view.data);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].label, "Tic-Tac-Toe");
  assert.equal(rows[0].matches, 3);
  // 2 wins / 1 loss over DECIDED matches only.
  assert.equal(rows[0].winRate, 66.7);

  const history = buildGuestHistoryRows(view.data);
  assert.equal(history.length, 2);
  assert.deepEqual(history.map((row) => row.result), ["win", "loss"]);
  assert.equal(history[0].label, "Tic-Tac-Toe");
});

test("a guest with several games is grouped by game with its own record", () => {
  const view = normalizeGuestProgressResponse(200, ok(MULTI_GAME));
  assert.equal(view.status, "ready");

  const rows = buildGuestGameRows(view.data);
  assert.deepEqual(
    rows.map((row) => [row.gameKey, row.label, row.matches]),
    [
      ["battleship", "Battleship", 2],
      ["dominoes", "Dominoes", 3],
      ["odds", "Odds", 2],
    ],
  );
  // A draw is not part of the win-rate denominator.
  assert.equal(rows[2].winRate, 100);
  assert.equal(rows[1].winRate, 50);

  const history = buildGuestHistoryRows(view.data);
  assert.equal(history.length, 3);
  assert.equal(new Set(history.map((row) => row.gameKey)).size, 3);
});

test("an expired or missing guest cookie is an empty session, never an error", () => {
  assert.deepEqual(normalizeGuestProgressResponse(401, null), { status: "no_guest" });
  // Signed-in callers get 403 from the guest-only route; the panel is not shown
  // to them, but the mapping must still not be an error screen.
  assert.deepEqual(normalizeGuestProgressResponse(403, null), { status: "no_guest" });
});

test("a genuine API failure is an error, not fake lost progress", () => {
  assert.deepEqual(normalizeGuestProgressResponse(500, null), { status: "error" });
  assert.deepEqual(normalizeGuestProgressResponse(502, { success: false }), { status: "error" });
  assert.deepEqual(normalizeGuestProgressResponse(200, { success: false }), { status: "error" });
  // A readable status with an unreadable body must not render as zeroes.
  assert.deepEqual(normalizeGuestProgressResponse(200, ok({ totals: {} })), { status: "error" });
  assert.deepEqual(
    normalizeGuestProgressResponse(200, ok({ ...EMPTY, totals: { matches: "3" } })),
    { status: "error" },
  );
});

test("labels never fall back to an unknown raw key and the rate is honest", () => {
  assert.equal(guestGameLabel("tic-tac-toe"), "Tic-Tac-Toe");
  assert.equal(guestGameLabel("battleship"), "Battleship");
  assert.equal(guestGameLabel("unknown-game"), "unknown-game");
  assert.deepEqual(Object.keys(GUEST_GAME_LABELS).sort(), [
    "battleship",
    "dominoes",
    "odds",
    "tic-tac-toe",
  ]);

  assert.equal(guestWinRate({ matches: 0, wins: 0, losses: 0, draws: 0 }), null);
  assert.equal(guestWinRate({ matches: 2, wins: 0, losses: 0, draws: 2 }), null);
  assert.equal(guestWinRate({ matches: 4, wins: 3, losses: 1, draws: 0 }), 75);
});

// ── 2. Panel contracts ──────────────────────────────────────────────────────

test("the panel reads only the caller's own session-scoped endpoint", () => {
  const panel = code(PANEL);
  assert.match(panel, /"\/api\/guest\/progress"/);
  assert.match(panel, /credentials: "same-origin"/);
  assert.match(panel, /cache: "no-store"/);
  // No identity parameter: the cookie is the identity.
  assert.doesNotMatch(panel, /guestId|userId=/);
  // No account or shared data sources.
  assert.doesNotMatch(panel, /\/api\/user-stats|\/api\/leaderboard|\/api\/user\b/);
});

test("the panel identifies the visitor as a Guest", () => {
  const panel = code(PANEL);
  assert.match(panel, /data-testid="guest-badge"/);
  assert.match(panel, /guestProgress\.badge/);
});

test("loading, empty, no-session and error states are all handled", () => {
  const panel = code(PANEL);
  // Shared states: skeleton while loading, ErrorState + retry on failure.
  assert.match(panel, /<AsyncState/);
  assert.match(panel, /isLoading=\{view\.status === "loading"\}/);
  assert.match(panel, /error=\{view\.status === "error"/);
  assert.match(panel, /onRetry=\{retry\}/);
  assert.match(panel, /Array\.from\(\{ length: 4 \}/);
  // Empty record vs no cookie are different, explicit screens.
  assert.match(panel, /guestProgress\.empty\.title/);
  assert.match(panel, /data-testid="guest-no-session"/);
  assert.match(panel, /guestProgress\.noSession\.title/);
  // A request failure is retryable, not swallowed.
  assert.match(panel, /setView\(\{ status: "error" \}\)/);
});

test("the panel shows totals, a per-game breakdown and recent history", () => {
  const panel = code(PANEL);
  for (const key of ["totals.matches", "totals.wins", "totals.losses", "totals.draws"]) {
    assert.match(panel, new RegExp(`guestProgress\\.${key.replace(".", "\\.")}`));
  }
  assert.match(panel, /data-testid="guest-games"/);
  assert.match(panel, /buildGuestGameRows\(data\)/);
  assert.match(panel, /data-testid="guest-history"/);
  assert.match(panel, /data-testid="guest-history-item"/);
  assert.match(panel, /buildGuestHistoryRows\(data\)/);
});

test("the panel invites an account and links to other games", () => {
  const panel = code(PANEL);
  assert.match(panel, /href="\/sign-up\?redirect_url=\/profil"/);
  assert.match(panel, /data-testid="guest-cta-signup"/);
  assert.match(panel, /guestProgress\.invite\.cta/);
  assert.match(panel, /href="\/games"/);
  assert.match(panel, /data-testid="guest-cta-games"/);
  assert.match(panel, /guestProgress\.discover/);
});

test("the guest surface shows no official Elo, trophy or reward data", () => {
  const panel = code(PANEL);
  const view = code(VIEW_MODEL);
  for (const forbidden of [
    /elo/i,
    /troph/i,
    /leaderboard/i,
    /balance/i,
    /\btoken/i,
    /rating/i,
    /applyRatingResult|applyTrophyResult|markDailyRewardWin/,
  ]) {
    assert.doesNotMatch(panel, forbidden, `${PANEL} must not render ${forbidden}`);
    assert.doesNotMatch(view, forbidden, `${VIEW_MODEL} must not carry ${forbidden}`);
  }
});

test("the panel is responsive on mobile and desktop", () => {
  const panel = code(PANEL);
  // Two tiles per row on phones, four from `sm` up.
  assert.match(panel, /grid grid-cols-2 gap-3 sm:grid-cols-4/);
  // The win-rate column only appears when there is room for it.
  assert.match(panel, /hidden py-2 text-right font-semibold sm:table-cell/);
  assert.match(panel, /hidden py-2 text-right tabular-nums text-\[#d8fbff\] sm:table-cell/);
  // Invitation stacks on mobile, sits beside the copy on desktop.
  assert.match(panel, /flex flex-col gap-3[\s\S]{0,120}sm:flex-row/);
  // No fixed page widths that would overflow a phone.
  assert.doesNotMatch(panel, /\bw-\[(?:4|5|6|7|8|9)\d{2}px\]/);
});

test("the view model rejects data instead of patching it", () => {
  const view = code(VIEW_MODEL);
  assert.match(view, /isGuestProgressData/);
  assert.match(view, /body\.success !== true/);
  // A stray result label is never presented as a win.
  assert.match(view, /isGuestPracticeOutcome\(row\.result\) \? row\.result : "draw"/);
});

// ── 3. Profile integration ──────────────────────────────────────────────────

test("the guest panel lives in the signed-out branch of /profil only", () => {
  const profile = read(PROFILE);
  const guestBranch = profile.indexOf("if (!isSignedIn) {");
  const panel = profile.indexOf("<GuestProgressPanel />");
  const accountBranch = profile.indexOf("const equippedFrame");

  assert.ok(guestBranch >= 0, "the signed-out branch must still exist");
  assert.ok(panel > guestBranch, "the panel must be inside the signed-out branch");
  assert.ok(accountBranch > panel, "the account profile starts after the guest branch");
});

test("the registered-user profile experience is preserved", () => {
  const profile = read(PROFILE);
  // The account branch still renders its own title, stats tabs and all the
  // existing sections; the guest panel is not part of it.
  assert.match(profile, /t\("profile\.title", "Your Profile"\)/);
  assert.match(profile, /<UserStatsTabs/);
  assert.match(profile, /<ContactMessageHistory/);
  const account = profile.slice(profile.indexOf("const equippedFrame"));
  assert.doesNotMatch(account, /GuestProgressPanel/);
});

// ── 4. Copy ────────────────────────────────────────────────────────────────

test("every guest copy key exists in EN, FR and ES", () => {
  const panel = read(PANEL);
  const keys = new Set(
    [...panel.matchAll(/t\(\s*"(guestProgress\.[A-Za-z0-9_.]+)"/g)].map((match) => match[1]),
  );
  // The outcome labels are addressed through a template literal.
  for (const outcome of ["win", "loss", "draw"]) {
    keys.add(`guestProgress.outcome.${outcome}`);
  }

  assert.ok([...keys].filter((key) => !key.startsWith("guestProgress.outcome.")).length >= 20);

  const resolve = (bundle, key) =>
    key.split(".").reduce((node, part) => node?.[part], bundle);

  for (const lang of ["en", "fr", "es"]) {
    const bundle = APP_TEXT_TRANSLATIONS[lang];
    assert.ok(bundle, `missing locale ${lang}`);
    for (const key of keys) {
      const value = resolve(bundle, key);
      assert.equal(typeof value, "string", `${lang} is missing ${key}`);
      assert.ok(value.trim().length > 0, `${lang}.${key} is empty`);
    }
  }
});
