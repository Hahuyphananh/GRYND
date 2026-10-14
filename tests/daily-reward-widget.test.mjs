/**
 * daily-reward-widget.test.mjs
 *
 * The daily reward now has TWO surfaces, and the coin balance has moved into
 * the trophy chip. Both changes are wiring, so they are pinned as wiring:
 *
 *   1. ONE source of truth. The /rewards card and the corner widget both drive
 *      the same hook, and that hook is the only thing that talks to
 *      /api/rewards/daily. A second, drifting copy of the claim (or of the
 *      amount) is the failure this prevents — the claim is a real credit.
 *   2. The widget is mounted on the home page and the games hub, exactly once
 *      each, and nowhere else.
 *   3. It sits in the top-right but UNDER the navbar: a fixed offset that
 *      clears the navbar's tallest height (h-24 = 96px), a z-index below the
 *      navbar's, and an inline layout below `md` where a fixed card would cover
 *      the page.
 *   4. The navbar shows the coin balance UNDER the trophy total, reads it from
 *      the one wallet endpoint, re-reads it when a credit the client knows
 *      about fires, and shows a dash — never a fabricated 0 — when it has not
 *      been read yet.
 *
 * Static-source assertions, in the style of tests/rewards-page-contract.test.mjs:
 * they pin the wiring AND the prohibitions, which is what a browser check
 * cannot prove the absence of.
 *
 * Run: npm run test:daily-reward-widget
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const MODULE_MOCKING_AVAILABLE = typeof mock?.module === "function";
const SKIP_REASON = MODULE_MOCKING_AVAILABLE
  ? false
  : "module mocking is off — run: npm run test:daily-reward-widget";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const read = (rel) => readFileSync(join(root, rel), "utf8");

// Prose must not be mistaken for code: these files explain the endpoints and
// the rules in their doc comments.
const stripComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const WIDGET = "src/components/DailyRewardWidget.tsx";
const HOOK = "src/hooks/useDailyReward.ts";
const CARD = "src/components/DailyRewardCard.tsx";
const NAV = "src/components/navigation-bar.jsx";
const HOME = "src/app/PageClient.jsx";
const HUB = "src/app/casino/PageClient.jsx";

// ── One source of truth ─────────────────────────────────────────────────────

test("both reward surfaces drive the same hook, which owns the HTTP", () => {
  const widget = read(WIDGET);
  const card = read(CARD);
  const hook = read(HOOK);

  for (const [name, src] of [
    ["the widget", widget],
    ["the card", card],
  ]) {
    assert.match(
      src,
      /import \{ useDailyReward \} from "\.\.\/hooks\/useDailyReward"/,
      `${name} must use the shared hook`,
    );
    // No surface reaches the reward API itself: the request shape (the JSON
    // content type a bodyless POST needs, the refusal handling, the balance
    // notification) lives in exactly one place.
    assert.doesNotMatch(
      stripComments(src),
      /fetch\(/,
      `${name} must not fetch the reward itself`,
    );
  }

  // The hook is where the two calls live, and they are the documented ones.
  assert.match(hook, /fetch\("\/api\/rewards\/daily"\)/);
  assert.match(hook, /method: "POST"/);
  assert.match(hook, /"Content-Type": "application\/json"/);
  // A claim credits the wallet the navbar and the wager pickers read.
  assert.match(hook, /notifyCoinBalanceChanged/);
});

// ── Where the widget lives ──────────────────────────────────────────────────

test("the widget is on the home page and the games hub, once each", () => {
  for (const page of [HOME, HUB]) {
    const src = read(page);
    const renders = src.match(/<DailyRewardWidget\s*\/>/g) || [];
    assert.equal(renders.length, 1, `${page} must render the widget exactly once`);
    assert.match(
      src,
      /import DailyRewardWidget from "[^"]*components\/DailyRewardWidget"/,
      `${page} must import the widget`,
    );
    // It is mounted straight after the navbar, so the inline (below `md`)
    // layout starts at the top of the page content rather than mid-page.
    const code = stripComments(src);
    assert.ok(
      code.indexOf("<NavigationBar") < code.indexOf("<DailyRewardWidget />"),
      `${page} must place the widget after the navbar`,
    );
  }
});

test("the widget stays under the navbar in the top-right", () => {
  const widget = read(WIDGET);

  // Fixed to the viewport's right edge from `md` up, and never above the
  // navbar in the stacking order (the navbar is z-40, the mobile menu z-50).
  assert.match(widget, /md:fixed/);
  assert.match(widget, /md:right-4/);

  const top = widget.match(/md:top-\[(\d+)px\]/);
  assert.ok(top, "the widget must pin its top offset");
  // The navbar is h-16 (64px) / sm:h-20 (80px) / md:h-24 (96px) — the fixed
  // offset has to clear the tallest of them or the widget sits behind it.
  assert.ok(
    Number(top[1]) >= 96,
    `top offset ${top[1]}px does not clear the navbar's 96px (md:h-24)`,
  );
  assert.match(widget, /md:z-30/);

  // Below `md` a fixed 288px card would cover the page it is meant to help, so
  // the same element is inline there.
  assert.match(widget, /mt-3 px-4 md:mt-0 md:px-0/);

  // Signed out (or before the session resolves) it renders nothing at all.
  assert.match(widget, /if \(!isLoaded \|\| !isSignedIn\) return null;/);
});

// ── The navbar chip ─────────────────────────────────────────────────────────

test("the coin balance renders under the trophy total, on both nav surfaces", () => {
  const nav = read(NAV);

  // Desktop chip: one Link, trophies first, coins beneath it.
  const chip = nav.slice(
    nav.indexOf('data-testid="nav-trophies"'),
    nav.indexOf('data-testid="nav-coins"'),
  );
  assert.ok(chip.length > 0, "the coins must sit inside the trophies chip");
  assert.ok(
    chip.includes("<IconTrophy") && chip.includes("profile.totalTrophies"),
    "the trophy total must come first in the chip",
  );
  assert.match(nav, /data-testid="nav-coins"/);
  assert.match(nav, /<IconCoins/);
  // The two rows are stacked, so the coins read as the line UNDER the total.
  assert.match(nav, /className="flex flex-col leading-tight"/);

  // Mobile menu: the same pair, same order.
  const mobile = nav.slice(nav.indexOf('data-testid="nav-trophies-mobile"'));
  assert.ok(
    mobile.indexOf('data-testid="nav-trophies-mobile"') <
      mobile.indexOf('data-testid="nav-coins-mobile"'),
    "the mobile coins line must follow the trophies line",
  );
});

test("the navbar reads the one wallet, and re-reads it after a credit", () => {
  const nav = read(NAV);
  const code = stripComments(nav);

  // The balance comes from the existing endpoint — no second currency path.
  assert.match(code, /fetch\("\/api\/get-user-tokens"/);
  assert.match(code, /balance: \(\(\) => \{/);
  assert.match(code, /Number\(data\.data\.balance\)/);

  // A claim announces itself, and the chip re-reads from that event.
  assert.match(
    code,
    /import \{ COIN_BALANCE_EVENT \} from "\.\.\/hooks\/useCoinBalance"/,
  );
  assert.match(
    code,
    /addEventListener\(COIN_BALANCE_EVENT, balanceHandler\)/,
  );
  assert.match(
    code,
    /removeEventListener\(COIN_BALANCE_EVENT, balanceHandler\)/,
  );
});

// ── What the widget actually renders ────────────────────────────────────────
//
// The static checks above prove the wiring; this one drives the REAL component
// through every state the server can report. The hook is mocked (it is the only
// thing that talks to the API), so the branches are data — one import of the
// widget covers all of them.

test("the widget renders each reward state, and nothing when signed out", { skip: SKIP_REASON }, async (t) => {
  // Mutable world: the mocked hook reads this on every render.
  const world = {
    isLoaded: true,
    isSignedIn: true,
    status: null,
    loading: true,
    claiming: false,
    claimedNow: null,
    error: null,
  };

  t.mock.module("../src/hooks/useDailyReward.ts", {
    namedExports: {
      useDailyReward: () => ({
        ...world,
        load: async () => {},
        claim: async () => {},
      }),
    },
  });

  const React = (await import("react")).default;
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { default: DailyRewardWidget } = await import(
    "../src/components/DailyRewardWidget.tsx"
  );

  const render = () =>
    renderToStaticMarkup(React.createElement(DailyRewardWidget));

  const STATUS = {
    claimable: true,
    playGateSatisfied: true,
    streakDay: 10,
    cycleDay: 3,
    reward: 120,
    today: "2026-10-14",
    cycle: [25, 50, 120, 150, 180, 200, 250],
    balance: 500,
  };

  // 1. Signed out → nothing at all (no sign-in pitch in the corner).
  Object.assign(world, { isLoaded: true, isSignedIn: false });
  assert.equal(render(), "", "a signed-out visitor must get no widget");

  // 2. Session not resolved yet → still nothing, so there is no flash.
  Object.assign(world, { isLoaded: false, isSignedIn: false });
  assert.equal(render(), "", "the widget must not render before the session resolves");

  // 3. Claimable → the button, carrying the server's amount and cycle day.
  Object.assign(world, {
    isLoaded: true,
    isSignedIn: true,
    status: STATUS,
    loading: false,
  });
  const claimable = render();
  assert.match(claimable, /Claim 120 coins/);
  assert.match(claimable, /data-testid="daily-reward-widget-claim"/);
  assert.match(claimable, /Day 3\/7/);
  // The amount comes from the server's answer, never from a literal here.
  assert.doesNotMatch(claimable, /Claim 25 coins/);

  // 4. The play gate → the instruction, and the link that satisfies it.
  Object.assign(world, {
    status: { ...STATUS, claimable: false, playGateSatisfied: false },
  });
  const locked = render();
  assert.match(locked, /Play one game to unlock today&#x27;s reward/);
  assert.match(locked, /href="\/games"/);
  assert.doesNotMatch(locked, /daily-reward-widget-claim/);

  // 5. Already claimed today → the wait message.
  Object.assign(world, {
    status: { ...STATUS, claimable: false },
  });
  assert.match(render(), /Claimed today/);

  // 6. Just claimed here → the payout, announced.
  Object.assign(world, { status: { ...STATUS, claimable: false }, claimedNow: 120 });
  const claimed = render();
  assert.match(claimed, /Claimed\s*120 coins/);
  assert.match(claimed, /role="status"/);

  // 7. A failed read → an alert, and no invented reward.
  Object.assign(world, {
    status: null,
    loading: false,
    claimedNow: null,
    error: "We couldn't load your daily reward.",
  });
  const failed = render();
  assert.match(failed, /Your daily reward isn&#x27;t available right now/);
  assert.match(failed, /Try again/);
  assert.doesNotMatch(failed, /Claim /);
});

test("an unread wallet shows a dash, never a fabricated zero", () => {
  const nav = read(NAV);
  // `null` is the "not read yet" state, and it is what the chip tests for.
  assert.match(nav, /balance = Number\.isFinite\(coins\) && coins >= 0 \? coins : null/);
  assert.match(nav, /profile\.balance === null/);
  assert.ok(
    (nav.match(/"—"/g) || []).length >= 2,
    "both nav surfaces must show a dash for an unknown balance",
  );
});
