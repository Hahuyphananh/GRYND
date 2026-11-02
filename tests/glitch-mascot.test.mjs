/**
 * glitch-mascot.test.mjs
 *
 * The GLITCH appearance rules, pinned.
 *
 * Two halves, in the style the rest of this repo already uses:
 *
 *   1. BEHAVIOUR. `resolveGlitchRequest` and friends are pure, so every
 *      cooldown, session cap and suppression rule is asserted by moving `now`
 *      rather than by waiting. These are the promises the provider relies on:
 *      at most three floating appearances a session, at least 90 s apart, never
 *      a repeated event, never during a match.
 *
 *   2. WIRING. A handful of static-source assertions for the things a unit test
 *      cannot see: that the provider is mounted exactly ONCE, that it is never
 *      imported by a game-board route, that it removes its window listener, and
 *      that it never outranks the toast/result/ad layers.
 *
 * Run: npm run test:glitch
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";

import {
  createGlitchSession,
  glitchSuppressionReason,
  GLITCH_DEFAULT_CONFIG,
  GLITCH_EVENT_NAME,
  GLITCH_DEFAULT_FLOATING_AUTO_HIDE_MS,
  GLITCH_EXPRESSIONS,
  GLITCH_PRIORITY,
  isActiveMatchRoute,
  isGlitchPlacement,
  normalizeGlitchEventDetail,
  recordGlitchAppearance,
  resolveAutoHideMs,
  resolveGlitchRequest,
} from "../src/lib/mascot/glitchCadence.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const read = (rel) => readFileSync(join(root, rel), "utf8");

/** Somewhere GLITCH is allowed to float. */
const QUIET = { pathname: "/" };

/** Shorthand: a clean session, a hint, nothing on screen. */
function decide({ request = {}, current = null, session, now = 0, context = QUIET, config } = {}) {
  return resolveGlitchRequest({
    request: { message: "hi", priority: GLITCH_PRIORITY.HINT, ...request },
    current,
    session: session ?? createGlitchSession(),
    now,
    context,
    config,
  });
}

/** A session that has already shown one floating hint at t=0. */
function sessionAfterHint() {
  return recordGlitchAppearance(
    createGlitchSession(),
    { message: "hi", priority: GLITCH_PRIORITY.HINT, placement: "bottom-left", eventId: "hint:1" },
    0
  );
}

// ── Priorities ────────────────────────────────────────────────────────────

test("priority 0 (ambient) is off unless explicitly allowed", () => {
  assert.equal(decide({ request: { priority: 0 } }).reason, "ambient-disabled");
  // Opted in, it behaves like any other appearance.
  assert.equal(decide({ request: { priority: 0 }, config: { allowAmbient: true } }).action, "show");
});

test("a priority 1 hint shows when the session is clean", () => {
  assert.deepEqual(decide({ request: { priority: 1, eventId: "first" } }), {
    action: "show",
    reason: "allowed",
  });
});

test("an unknown or malformed priority never appears", () => {
  assert.equal(decide({ request: { priority: 9 } }).reason, "invalid-priority");
  assert.equal(decide({ request: { priority: 1.5 } }).reason, "invalid-priority");
  assert.equal(decide({ request: { priority: "2" } }).reason, "invalid-priority");
});

// ── Cooldowns and the global interval ─────────────────────────────────────

test("a hint has a 5 minute cooldown", () => {
  const session = sessionAfterHint();
  // Past the 90 s floor but inside the 5 min cooldown → still blocked.
  assert.equal(decide({ session, now: 120_000, request: { priority: 1 } }).reason, "cooldown");
  assert.equal(decide({ session, now: 299_000, request: { priority: 1 } }).reason, "cooldown");
  assert.equal(decide({ session, now: 300_000, request: { priority: 1 } }).action, "show");
});

test("a milestone has a 2 minute cooldown, independent of the hint's", () => {
  const session = sessionAfterHint();
  // 91 s: the global floor is satisfied and nothing priority-2 is recorded yet.
  assert.equal(decide({ session, now: 91_000, request: { priority: 2 } }).action, "show");

  const withMilestone = recordGlitchAppearance(
    session,
    { message: "hi", priority: 2, placement: "bottom-left" },
    91_000
  );
  assert.equal(
    decide({ session: withMilestone, now: 150_000, request: { priority: 2 } }).reason,
    "min-interval"
  );
  assert.equal(
    decide({ session: withMilestone, now: 91_000 + 120_000, request: { priority: 2 } }).action,
    "show"
  );
});

test("nothing floats twice within the 90 second floor", () => {
  const session = sessionAfterHint();
  assert.equal(decide({ session, now: 30_000, request: { priority: 2 } }).reason, "min-interval");
  assert.equal(decide({ session, now: 89_999, request: { priority: 2 } }).reason, "min-interval");
  assert.equal(decide({ session, now: 90_000, request: { priority: 2 } }).action, "show");
});

test("priority 3 bypasses the cooldowns, not the session cap", () => {
  const session = sessionAfterHint();
  // Same instant that blocks a hint and a milestone…
  assert.equal(decide({ session, now: 5_000, request: { priority: 1 } }).reason, "min-interval");
  assert.equal(decide({ session, now: 5_000, request: { priority: 2 } }).reason, "min-interval");
  // …lets a tutorial-critical message through.
  assert.equal(decide({ session, now: 5_000, request: { priority: 3 } }).action, "show");
});

// ── Session limits and duplicates ─────────────────────────────────────────

test("three floating appearances per session, then nothing", () => {
  let session = createGlitchSession();
  for (let i = 0; i < GLITCH_DEFAULT_CONFIG.maxPerSession; i += 1) {
    session = recordGlitchAppearance(
      session,
      { message: "hi", priority: 3, placement: "bottom-left", eventId: `m${i}` },
      i * 1_000
    );
  }
  assert.equal(session.shown.length, 3);
  // Priority 3 clears every cooldown, so the cap is the only thing left.
  assert.equal(
    decide({ session, now: 999_999, request: { priority: 3, eventId: "m9" } }).reason,
    "session-limit"
  );
});

test("the same eventId is never shown twice in a session", () => {
  const session = sessionAfterHint();
  const result = decide({
    session,
    now: 600_000,
    request: { eventId: "hint:1", priority: 3 },
  });
  assert.equal(result.reason, "duplicate-event");
});

test("recording is immutable and counts one appearance per floating message", () => {
  const empty = createGlitchSession();
  const once = recordGlitchAppearance(
    empty,
    { message: "hi", priority: 1, placement: "bottom-left", eventId: "a" },
    1_000
  );

  // The session that was passed in is untouched — the provider swaps references.
  assert.equal(empty.shown.length, 0);
  assert.equal(once.shown.length, 1);
  assert.equal(once.lastFloatingAt, 1_000);
  assert.deepEqual(once.shownEventIds, ["a"]);
  assert.equal(once.lastFloatingAtByPriority[1], 1_000);

  // A repeated eventId is not appended twice.
  const again = recordGlitchAppearance(once, { message: "hi", priority: 1, eventId: "a" }, 2_000);
  assert.deepEqual(again.shownEventIds, ["a"]);
});

// ── Inline is page content, not an impression ─────────────────────────────

test("inline messages are not rate limited and do not spend the budget", () => {
  const exhausted = {
    startedAt: 0,
    shown: [{}, {}, {}],
    shownEventIds: ["x"],
    lastFloatingAt: 0,
    lastFloatingAtByPriority: { 1: 0 },
  };

  // No cooldown, no cap, and the same eventId may render again on a re-render.
  assert.equal(
    decide({ session: exhausted, now: 0, request: { placement: "inline", eventId: "x" } }).action,
    "show"
  );

  // Inline is never recorded, so it cannot consume a floating slot.
  assert.equal(
    recordGlitchAppearance(exhausted, { message: "hi", placement: "inline" }, 5_000),
    exhausted
  );
});

// ── Suppression ───────────────────────────────────────────────────────────

test("every /casino board route is an active match; lobbies are not", () => {
  const boards = [
    "/casino/lane-runner/abc123",
    "/casino/keno-pvp/abc123",
    "/casino/barrier-blitz/abc123",
    "/casino/barrier-blitz/play-ai",
    "/casino/chess/ai",
    "/casino/rps/play-ai",
    "/casino/rps/ai",
    "/casino/precision/test",
    "/casino/precision/game/abc123",
    "/casino/odds/game/abc123",
    "/casino/pool-masters/game/abc123",
    "/casino/uno/game/abc123",
  ];
  for (const pathname of boards) {
    assert.equal(isActiveMatchRoute(pathname), true, `${pathname} should suppress`);
  }

  const allowed = [
    "/",
    "/casino",
    "/casino/chess",
    "/casino/odds",
    "/casino/hex-duel/history",
    "/leaderboard",
    "/profile/me",
    "",
  ];
  for (const pathname of allowed) {
    assert.equal(isActiveMatchRoute(pathname), false, `${pathname} should be allowed`);
  }
});

test("each suppression signal maps to its own reason", () => {
  assert.equal(glitchSuppressionReason(QUIET), null);
  assert.equal(glitchSuppressionReason({ creatorMode: true }), "creator-mode");
  assert.equal(glitchSuppressionReason({ pathname: "/casino/chess/ai" }), "match");
  assert.equal(glitchSuppressionReason({ blockingOverlay: true }), "modal");
  assert.equal(glitchSuppressionReason({ adNearCorner: true }), "ad");
  assert.equal(glitchSuppressionReason({ alertVisible: true }), "alert");
  assert.equal(glitchSuppressionReason({ busy: true }), "busy");
});

test("a suppressed request is ignored and spends nothing", () => {
  const suppressed = decide({ context: { pathname: "/casino/uno/game/abc" } });
  assert.deepEqual(suppressed, { action: "ignore", reason: "suppressed:match" });

  // Same session, clean surface: the blocked request left no trace.
  const session = createGlitchSession();
  assert.equal(decide({ session, now: 0 }).action, "show");
});

// ── Overlap ───────────────────────────────────────────────────────────────

test("one bubble at a time: equal or lower priority waits, higher replaces", () => {
  const showingHint = { priority: 1 };
  assert.equal(decide({ current: showingHint, request: { priority: 1 } }).reason, "busy");
  assert.equal(decide({ current: showingHint, request: { priority: 0 }, config: { allowAmbient: true } }).reason, "busy");
  assert.equal(decide({ current: showingHint, request: { priority: 2 } }).action, "replace");

  const showingMilestone = { priority: 2 };
  assert.equal(decide({ current: showingMilestone, request: { priority: 1 } }).reason, "busy");
});

// ── Request and event validation ──────────────────────────────────────────

test("an invalid request is refused before any timing is considered", () => {
  assert.equal(decide({ request: { message: "" } }).reason, "empty-message");
  assert.equal(decide({ request: { message: undefined } }).reason, "empty-message");
  assert.equal(decide({ request: { placement: "centre" } }).reason, "invalid-placement");
  assert.equal(decide({ request: { expression: "angry" } }).reason, "invalid-expression");
  assert.equal(decide({ request: { eventId: "x".repeat(121) } }).reason, "invalid-event-id");
  assert.equal(decide({ request: { eventId: 7 } }).reason, "invalid-event-id");
  assert.equal(decide({ request: { autoHideMs: -1 } }).reason, "invalid-auto-hide");
  assert.equal(resolveGlitchRequest().reason, "invalid-request");
});

test("window event payloads are validated, never trusted", () => {
  assert.equal(normalizeGlitchEventDetail(null), null);
  assert.equal(normalizeGlitchEventDetail("hello"), null);
  assert.equal(normalizeGlitchEventDetail([{ message: "hi" }]), null);
  assert.equal(normalizeGlitchEventDetail({}), null);
  assert.equal(normalizeGlitchEventDetail({ message: "   " }), null);
  assert.equal(normalizeGlitchEventDetail({ message: "x".repeat(201) }), null);
  assert.equal(normalizeGlitchEventDetail({ message: "hi", priority: 9 }), null);
  assert.equal(normalizeGlitchEventDetail({ message: "hi", expression: "angry" }), null);
  assert.equal(normalizeGlitchEventDetail({ message: "hi", placement: "centre" }), null);

  const ok = normalizeGlitchEventDetail({ message: "  Focus up.  ", priority: 2, expression: "focused" });
  assert.equal(ok.message, "Focus up.");
  assert.equal(ok.priority, 2);
  assert.equal(ok.expression, "focused");
  assert.equal(ok.dismissible, false);

  assert.equal(GLITCH_EVENT_NAME, "grynd:glitch");
});

test("auto-hide: floating fades on its own, inline stays", () => {
  assert.equal(resolveAutoHideMs("bottom-left", undefined), GLITCH_DEFAULT_FLOATING_AUTO_HIDE_MS);
  assert.equal(resolveAutoHideMs("bottom-left", null), null);
  assert.equal(resolveAutoHideMs("bottom-left", 4_000), 4_000);
  assert.equal(resolveAutoHideMs("inline", undefined), null);
});

// ── The two expression lists must not drift ───────────────────────────────

test("the cadence mirror matches the asset allow-list", async () => {
  const assets = await import("../src/lib/mascot/glitchAssets.ts");
  assert.deepEqual([...GLITCH_EXPRESSIONS], [...assets.GLITCH_EXPRESSIONS]);
  for (const expression of GLITCH_EXPRESSIONS) {
    assert.equal(typeof assets.glitchAsset(expression).src, "string");
  }
});

// ── Wiring ────────────────────────────────────────────────────────────────

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.(tsx|jsx|ts|js)$/.test(entry.name)) out.push(full);
  }
  return out;
}

test("the provider is mounted exactly once, in the root layout", () => {
  const layout = read("src/app/layout.tsx");
  assert.equal((layout.match(/<GlitchProvider\s*\/>/g) ?? []).length, 1);
  assert.match(layout, /import GlitchProvider from "\.\.\/components\/mascot\/GlitchProvider"/);

  // Nothing else in src may import or mount the floating provider: a second
  // mount would mean a second session budget and two bubbles. (A comment that
  // merely names it does not count — only a real import or JSX mount does.)
  const referencing = walk(join(root, "src"))
    .filter((file) => /import\s+GlitchProvider|import\s*\{[^}]*\bGlitchProvider\b|<GlitchProvider/.test(readFileSync(file, "utf8")))
    .map((file) => relative(root, file).split(sep).join("/"))
    .sort();
  assert.deepEqual(referencing, ["src/app/layout.tsx"]);
});

test("no game BOARD mounts the floating provider itself", () => {
  // The games HUB (app/casino/PageClient.jsx) is a permitted surface: it is a
  // lobby, not a board, and its hint goes through the provider by design. Every
  // other file under app/casino is a game route, where a mount would mean a
  // second session budget and a mascot over play.
  const HUB = "src/app/casino/PageClient.jsx";
  const offenders = walk(join(root, "src", "app", "casino"))
    .map((file) => relative(root, file).split(sep).join("/"))
    .filter((rel) => rel !== HUB)
    .filter((rel) => readFileSync(join(root, rel), "utf8").includes("GlitchProvider"));
  assert.deepEqual(offenders, []);
});

test("the provider cleans up after itself", () => {
  const source = read("src/components/mascot/GlitchProvider.tsx");
  assert.match(source, /window\.removeEventListener\(GLITCH_EVENT_NAME/);
  assert.match(source, /clearTimeout/);
  assert.match(source, /query\.removeEventListener\("change"/);
});

test("the floating layer stays under toasts, results and ads", () => {
  const say = read("src/components/mascot/GlitchSay.tsx");
  assert.match(say, /z-\[80\]/);
  // A mascot must never outrank an interruption or an advertisement.
  assert.doesNotMatch(say, /z-\[(9[5-9]|[1-9]\d{2,})\]/);
  // Click-through except the dismiss control.
  assert.match(say, /pointer-events-none/);
  assert.match(say, /pointer-events-auto/);
});

test("the provider is not a dialog and owns no timing constants", () => {
  const source = read("src/components/mascot/GlitchProvider.tsx");
  // `[aria-modal="true"]` is a suppression PROBE (someone else's overlay); the
  // provider must never put dialog semantics on its own markup.
  assert.doesNotMatch(source, /aria-modal=\{/);
  assert.doesNotMatch(source, /role="dialog"/);
  assert.doesNotMatch(source, /body\.style\.overflow/);
  assert.doesNotMatch(source, /new Audio|<audio/);
  // The limits live in one place: glitchCadence.js.
  assert.doesNotMatch(source, /90_000|300_000|120_000/);
});

test("inline is refused by the provider and page-owned instead", () => {
  const source = read("src/components/mascot/GlitchProvider.tsx");
  assert.match(source, /placement === "inline"/);
});
