/**
 * daily-reward-widget.test.mjs
 *
 * The daily reward now has TWO surfaces, and the coin balance has moved into
 * the trophy chip. Both changes are wiring, so they are pinned as wiring:
 *
 *   1. ONE source of truth. The /rewards card and the corner widget both drive
 *      the same hook AND open the same 14-day board
 *      (src/components/DailyRewardBoard.tsx), and that hook is the only thing
 *      that talks to /api/rewards/daily. A second, drifting copy of the claim
 *      (or of the amount, or of the board) is the failure this prevents — the
 *      claim is a real credit.
 *
 *   1b. The board is a MODAL: clicking the reward opens it, and the single
 *      claim button lives inside it. Escape closes it. (The reported bug was
 *      that the amount on screen was not the amount paid; the shape of the UI
 *      is what makes that visible, so it is pinned too.)
 *
 *   1c. The status read is never served from a cache: the shared fetch guard
 *      caches GET /api/* for two seconds, so a read fired straight after a
 *      claim could report the day that was just claimed.
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

// ONE mutable world for the mocked hook. The components are imported once (the
// ESM graph is cached), so whichever test registers the mock first, every test
// that renders them drives this same object — a per-test copy would be
// invisible to the mock and the renders would silently show stale state.
const REWARD_WORLD = {
  isLoaded: true,
  isSignedIn: true,
  status: null,
  loading: false,
  claiming: false,
  claimedNow: null,
  error: null,
};

const resetWorld = (overrides = {}) =>
  Object.assign(REWARD_WORLD, {
    isLoaded: true,
    isSignedIn: true,
    status: null,
    loading: false,
    claiming: false,
    claimedNow: null,
    error: null,
    ...overrides,
  });

// Prose must not be mistaken for code: these files explain the endpoints and
// the rules in their doc comments.
const stripComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const WIDGET = "src/components/DailyRewardWidget.tsx";
const HOOK = "src/hooks/useDailyReward.ts";
const CARD = "src/components/DailyRewardCard.tsx";
const BOARD = "src/components/DailyRewardBoard.tsx";
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
  assert.match(hook, /fetch\("\/api\/rewards\/daily", \{ cache: "no-store" \}\)/);
  assert.match(hook, /method: "POST"/);
  assert.match(hook, /"Content-Type": "application\/json"/);
  // A claim credits the wallet the navbar and the wager pickers read.
  assert.match(hook, /notifyCoinBalanceChanged/);
});

test("a refused claim keeps its message — the re-read cannot swallow it", () => {
  // The reported bug: pressing Claim appeared to do nothing. `load()` starts by
  // clearing the error, so a refusal set before the re-read was wiped in the
  // same click — the play gate, "already claimed" and "wallet full" were all
  // invisible. The message must be applied AFTER the re-read.
  const hook = read(HOOK);
  const code = stripComments(hook);
  const claimAt = code.indexOf("const claim = useCallback");
  assert.ok(claimAt > 0, "the claim callback must exist");
  const refusalAt = code.indexOf("} else {", claimAt);
  const catchAt = code.indexOf("} catch {", claimAt);
  const refusalBranch = code.slice(refusalAt, catchAt);

  assert.match(refusalBranch, /const message =/, "the refusal must be captured first");
  assert.match(
    refusalBranch,
    /await load\(\);\s*setError\(\(previous\) => previous \?\? message\)/,
    "the refusal message must be set after the re-read that clears errors",
  );
  assert.doesNotMatch(
    refusalBranch,
    /setError\([^)]*\)\s*;\s*await load\(\)/,
    "setting the error before the re-read is the bug this pins",
  );
  // The re-read still happens — a refusal is re-read, never guessed at.
  assert.match(refusalBranch, /await load\(\)/);
});

test("the status read is never served from the shared two-second GET cache", () => {
  // src/components/CsrfFetchGuard.tsx caches GET /api/* responses for 2s and
  // skips anything that asks for `no-store`. A status read is what the board
  // renders, so a cached answer means the board keeps showing a day that was
  // already claimed.
  const hook = read(HOOK);
  assert.match(hook, /cache: "no-store"/);
  const guard = read("src/components/CsrfFetchGuard.tsx");
  assert.match(
    guard,
    /!String\(init\?\.cache \|\| ""\)\.includes\("no-store"\)/,
    "the guard's GET cache is what `no-store` opts out of",
  );
});

// ── The board ───────────────────────────────────────────────────────────────

test("both surfaces open the one shared 14-day board", () => {
  const board = read(BOARD);

  // The board renders the whole cycle the server sent, and never invents a
  // curve of its own.
  assert.match(board, /status\.cycle\.map\(\(amount, index\)/);
  assert.match(board, /status\.cycleDays/);
  assert.ok(
    !/\[\s*30\s*,/.test(stripComments(board)),
    "the board must not inline its own cycle",
  );
  // It is a modal dialog, and it never fetches: it drives the hook it is given.
  assert.match(board, /role="dialog"/);
  assert.match(board, /aria-modal="true"/);
  assert.doesNotMatch(stripComments(board), /fetch\(/);
  assert.match(board, /reward\.claim|onClick=\{claim\}/);

  // The ONE claim button in the app lives in the board.
  assert.match(board, /data-testid="daily-reward-claim"/);
  for (const [name, src] of [
    ["the card", read(CARD)],
    ["the widget", read(WIDGET)],
  ]) {
    assert.match(
      stripComments(src),
      /<DailyRewardBoard open=\{open\} onClose=\{\(\) => setOpen\(false\)\} reward=\{reward\} \/>/,
      `${name} must mount the shared board with the shared reward state`,
    );
    assert.doesNotMatch(
      stripComments(src),
      /data-testid="daily-reward-claim"/,
      `${name} must not carry a second claim button`,
    );
  }

  // Escape closes it, and the page behind stops scrolling while it is open.
  assert.match(board, /event\.key === "Escape"/);
  assert.match(board, /document\.body\.style\.overflow = "hidden"/);

  // It is portalled to <body>: both hosts mount it inside a framer-motion
  // wrapper, and a transformed ancestor would otherwise size the `fixed`
  // overlay to that wrapper and trap it in its stacking context.
  assert.match(board, /createPortal\(/);
  assert.match(board, /document\.body\s*,?\s*\);/);
  const cardHost = read(CARD);
  assert.match(
    cardHost,
    /<DailyRewardBoard/,
    "the card must mount the portalled board, not an in-place overlay",
  );
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
  // It goes through the shared in-flight de-duper (the profile page reads the
  // same URL in the same tick), so the call site is `fetchDeduped`.
  assert.match(code, /fetchDeduped\("\/api\/get-user-tokens"/);
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
  const world = resetWorld({ loading: true });

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
    cycleDays: 14,
    reward: 120,
    today: "2026-10-14",
    cycle: [30, 35, 120, 50, 60, 70, 80, 90, 105, 110, 135, 155, 175, 200],
    balance: 500,
  };

  // 1. Signed out → nothing at all (no sign-in pitch in the corner).
  Object.assign(world, { isLoaded: true, isSignedIn: false });
  assert.equal(render(), "", "a signed-out visitor must get no widget");

  // 2. Session not resolved yet → still nothing, so there is no flash.
  Object.assign(world, { isLoaded: false, isSignedIn: false });
  assert.equal(render(), "", "the widget must not render before the session resolves");

  // 3. Claimable → the opener, carrying the server's amount and cycle day.
  Object.assign(world, {
    isLoaded: true,
    isSignedIn: true,
    status: STATUS,
    loading: false,
  });
  const claimable = render();
  assert.match(claimable, /Claim day 3\s*—\s*120 coins/);
  assert.match(claimable, /data-testid="daily-reward-widget-open"/);
  // The board and the claim button are NOT in the initial markup: the reward
  // opens first, and the claim is one click deeper.
  assert.match(claimable, /Day 3\/14/);
  assert.doesNotMatch(claimable, /data-testid="daily-reward-claim"/);
  assert.doesNotMatch(claimable, /data-testid="daily-reward-board-dialog"/);
  // The amount comes from the server's answer, never from a literal here.
  assert.doesNotMatch(claimable, /Claim day 1/);

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

test("a full wallet is shown BEFORE the claim is pressed", { skip: SKIP_REASON }, async (t) => {
  // The reported follow-up: a player at the wallet ceiling only found out after
  // pressing Claim — the server refused and nothing happened. Both surfaces now
  // carry the verdict up front.
  const world = resetWorld();

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
  const { default: DailyRewardCard } = await import(
    "../src/components/DailyRewardCard.tsx"
  );

  const AT_CEILING = {
    claimable: true,
    playGateSatisfied: true,
    streakDay: 2,
    cycleDay: 2,
    cycleDays: 14,
    reward: 35,
    today: "2026-10-17",
    cycle: [30, 35, 45, 50, 60, 70, 80, 90, 105, 120, 135, 155, 175, 200],
    balance: 100000,
    walletFull: true,
    walletCap: 100000,
  };

  Object.assign(world, { status: AT_CEILING });

  // `formatCoins` follows the RUNNER's locale, so the thousands separator is
  // matched separator-agnostically (fr-FR renders 100 000 with a space).
  const COIN_LIMIT = /100[\s,.\u00A0\u202F]?000 coin limit/;

  // The widget names the reason, the ceiling and what is waiting for them.
  const widget = renderToStaticMarkup(React.createElement(DailyRewardWidget));
  assert.match(widget, /data-testid="daily-reward-widget-wallet-full"/);
  assert.match(widget, /Wallet full/);
  assert.match(widget, COIN_LIMIT);
  assert.match(widget, /35/);
  // …and does NOT offer the claim: that CTA is what led nowhere before.
  assert.doesNotMatch(widget, /Claim day 2/);

  // The /rewards card says the same thing in its claim slot.
  const card = renderToStaticMarkup(React.createElement(DailyRewardCard));
  assert.match(card, /data-testid="daily-reward-wallet-full"/);
  assert.match(card, /Wallet full/);
  assert.match(card, COIN_LIMIT);
  assert.doesNotMatch(card, /Daily reward &#x2014; day 2/);

  // With room again, both surfaces go back to offering the claim.
  Object.assign(world, {
    status: { ...AT_CEILING, walletFull: false, balance: 500 },
  });
  const refilledWidget = renderToStaticMarkup(React.createElement(DailyRewardWidget));
  assert.match(refilledWidget, /Claim day 2\s*—\s*35 coins/);
  assert.doesNotMatch(refilledWidget, /Wallet full/);
  const refilledCard = renderToStaticMarkup(React.createElement(DailyRewardCard));
  assert.doesNotMatch(refilledCard, /Wallet full/);
  assert.match(refilledCard, /day 2 \(35 coins\)/);
});

test("the one claim button is withheld when the wallet is full", () => {
  // The board owns the only claim button in the app, so the verdict has to gate
  // it too — the card and the widget merely open the board.
  const board = read(BOARD);
  const gate = board.indexOf("status.claimable && status.walletFull");
  const claimButton = board.indexOf('data-testid="daily-reward-claim"');
  assert.ok(gate > 0, "the board must read the wallet verdict");
  assert.ok(gate < claimButton, "the wallet-full branch must precede the claim button");
  assert.match(board, /data-testid="daily-reward-wallet-full"/);
  // The server-side refusal stays as the backstop for a stale status read.
  assert.match(read("src/lib/tokens/dailyReward.ts"), /if \(credit < reward\)/);
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
