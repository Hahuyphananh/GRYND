// tests/mini-golf-sync.test.mjs
//
// Mini Golf production-hardening regressions:
//
//   * stale-state ordering — a slower snapshot must never overwrite a newer
//     authoritative one in the match view (poll vs. socket-push vs. post-shot
//     resync all race). Pure rule lives in src/lib/mini-golf/ui.ts.
//   * free-practice isolation — an AI match never mirrors canonical-queue
//     lifecycle transitions (it never had a queue row), and the write paths
//     guard it instead of logging "Match lifecycle not found".
//   * request validation — the disconnect-forfeit endpoint rejects a malformed
//     match id with a 400 instead of letting Postgres throw a 500.
//
// Run:  node --import tsx --test tests/mini-golf-sync.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const { isIncomingSnapshotStale, rollingProgress, animationDurationMs, lastBotTurnRecap } =
  await import("../src/lib/mini-golf/ui.ts");

const read = (rel) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");
const strip = (src) => src.replace(/\r\n/g, "\n");

const STORE = "src/lib/mini-golf/serverStore.ts";
const MATCH_PAGE = "src/app/casino/mini-golf/[matchId]/PageClient.tsx";
const DISCONNECT = "src/app/api/mini-golf/disconnect-forfeit/route.ts";

// ── 1. Snapshot ordering ─────────────────────────────────────────────────

test("a null current snapshot is never stale (first load)", () => {
  assert.equal(isIncomingSnapshotStale(null, { version: 1, status: "playing" }), false);
  assert.equal(isIncomingSnapshotStale(undefined, { version: 1, status: "playing" }), false);
});

test("a strictly newer version always wins; an older one never overwrites", () => {
  assert.equal(
    isIncomingSnapshotStale({ version: 5, status: "playing" }, { version: 6, status: "playing" }),
    false,
  );
  assert.equal(
    isIncomingSnapshotStale({ version: 6, status: "playing" }, { version: 5, status: "playing" }),
    true,
  );
});

test("same version: a terminal snapshot can never be rolled back to a live one", () => {
  // Forfeit / cancel finalise WITHOUT bumping version.
  assert.equal(
    isIncomingSnapshotStale({ version: 4, status: "finished" }, { version: 4, status: "playing" }),
    true,
  );
  assert.equal(
    isIncomingSnapshotStale({ version: 4, status: "cancelled" }, { version: 4, status: "playing" }),
    true,
  );
  // The forward direction is always accepted…
  assert.equal(
    isIncomingSnapshotStale({ version: 4, status: "playing" }, { version: 4, status: "finished" }),
    false,
  );
  // …and two live snapshots at the same version are indistinguishable.
  assert.equal(
    isIncomingSnapshotStale({ version: 4, status: "playing" }, { version: 4, status: "playing" }),
    false,
  );
});

test("a malformed incoming payload is rejected, never adopted", () => {
  assert.equal(isIncomingSnapshotStale({ version: 3 }, {}), true);
  assert.equal(isIncomingSnapshotStale({ version: 3 }, { version: "nope" }), true);
  assert.equal(isIncomingSnapshotStale({ version: 3 }, null), true);
});

// ── 1b. Rolling animation: the glide ─────────────────────────────────────
// The server trajectory is an evenly spaced polyline, so walking it by arc
// length alone plays every shot at a constant speed and stops dead. The client
// eases progress with the simulator's own damping so the ball visibly slows.

test("rollingProgress reproduces the simulator's deceleration", () => {
  // Exact endpoints, so a rollout starts and finishes exactly where the
  // server's trajectory does.
  assert.equal(rollingProgress(0, 240), 0);
  assert.equal(rollingProgress(1, 240), 1);

  // Monotonic: the ball never travels backwards in time.
  let prev = -1;
  for (let t = 0; t <= 1.0001; t += 0.05) {
    const u = rollingProgress(t, 240);
    assert.ok(u >= prev, `progress must not decrease (t=${t.toFixed(2)})`);
    prev = u;
  }

  // Front-loaded: a damped ball has covered most of its roll before half the
  // time is up — that curve is what reads as a glide rather than a slide.
  assert.ok(rollingProgress(0.5, 240) > 0.9, "a rolling ball covers most of its distance early");
  // A longer roll (more simulated frames) decelerates more sharply.
  assert.ok(rollingProgress(0.5, 60) < rollingProgress(0.5, 400));
  // Out-of-range / malformed input is clamped, never NaN.
  assert.equal(rollingProgress(-1, 240), 0);
  assert.equal(rollingProgress(2, 240), 1);
  assert.equal(rollingProgress(NaN, 240), 0);
});

// ── 1c. Practice-bot turn recap ─────────────────────────────────────────
// The bot's whole turn resolves in one poll, so only its LAST shot is ever
// animated. The recap is derived from the chronological shot log so the human
// can still see what the run did.

const RECAP_HOLES = [
  {
    index: 1,
    par: 2,
    template: "test",
    geometry: {
      width: 400,
      height: 560,
      tee: { x: 200, y: 500 },
      cup: { x: 200, y: 60, r: 14 },
      walls: [],
      bumpers: [],
      sand: [],
      water: [],
    },
  },
];

const recapShot = (playerId, holeNumber, restPosition, pocketed = false) => ({
  playerId,
  holeNumber,
  result: { restPosition, pocketed },
});

test("lastBotTurnRecap summarises the bot's trailing run and where it stopped", () => {
  const shots = [
    recapShot("human", 1, { x: 10, y: 10 }),
    recapShot("bot", 1, { x: 120, y: 300 }),
    recapShot("bot", 1, { x: 200, y: 200 }),
  ];
  const recap = lastBotTurnRecap({ shots, botPlayerId: "bot", holes: RECAP_HOLES });
  assert.equal(recap.hole, 1);
  assert.equal(recap.strokes, 2, "only the bot's trailing run counts");
  assert.equal(recap.pocketed, false);
  // distance from (200,200) to the cup at (200,60) is 140px.
  assert.equal(Math.round(recap.restDistance), 140);
});

test("lastBotTurnRecap marks a holed-out run", () => {
  const shots = [
    recapShot("human", 1, { x: 1, y: 1 }),
    recapShot("bot", 1, { x: 5, y: 5 }),
    recapShot("bot", 1, { x: 200, y: 60 }, true),
  ];
  const recap = lastBotTurnRecap({ shots, botPlayerId: "bot", holes: RECAP_HOLES });
  assert.equal(recap.strokes, 2);
  assert.equal(recap.pocketed, true);
});

test("lastBotTurnRecap scopes a run that crosses a hole boundary to the latest hole", () => {
  const holes = [RECAP_HOLES[0], { ...RECAP_HOLES[0], index: 2 }];
  const shots = [
    recapShot("bot", 1, { x: 1, y: 1 }),
    recapShot("bot", 2, { x: 50, y: 50 }),
    recapShot("bot", 2, { x: 60, y: 60 }),
  ];
  const recap = lastBotTurnRecap({ shots, botPlayerId: "bot", holes });
  assert.equal(recap.hole, 2);
  assert.equal(recap.strokes, 2, "strokes are scoped to the hole the run ended on");
});

test("lastBotTurnRecap is null-safe on a partial payload", () => {
  assert.equal(lastBotTurnRecap({ shots: null, botPlayerId: "bot", holes: RECAP_HOLES }), null);
  assert.equal(lastBotTurnRecap({ shots: [], botPlayerId: "bot", holes: RECAP_HOLES }), null);
  assert.equal(
    lastBotTurnRecap({
      shots: [recapShot("human", 1, { x: 0, y: 0 })],
      botPlayerId: "bot",
      holes: RECAP_HOLES,
    }),
    null,
  );
  // No bot id (a human duel) → nothing to recap.
  assert.equal(
    lastBotTurnRecap({
      shots: [recapShot("bot", 1, { x: 0, y: 0 })],
      botPlayerId: "",
      holes: RECAP_HOLES,
    }),
    null,
  );
});

test("animationDurationMs scales with the roll and stays inside its clamp", () => {
  const tapIn = [{ x: 0, y: 0 }, { x: 20, y: 0 }];
  const longRoll = [{ x: 0, y: 0 }, { x: 900, y: 0 }];
  assert.ok(animationDurationMs(longRoll) > animationDurationMs(tapIn));
  assert.ok(animationDurationMs(tapIn) >= 400);
  assert.ok(animationDurationMs([{ x: 0, y: 0 }]) >= 400);
  assert.ok(animationDurationMs([{ x: 0, y: 0 }, { x: 1e9, y: 0 }]) <= 2600);
  // The simulated frame count paces a short trajectory too, so a slow tap-in
  // does not snap to a stop.
  assert.ok(animationDurationMs(tapIn, { frames: 300 }) > animationDurationMs(tapIn));
});

test("the match view adopts snapshots through the guard", () => {
  const src = strip(read(MATCH_PAGE));
  assert.match(src, /import\s*\{[\s\S]*?isIncomingSnapshotStale[\s\S]*?\}\s*from\s*"\.\.\/\.\.\/\.\.\/\.\.\/lib\/mini-golf\/ui"/);
  assert.match(src, /setMatch\(\(prev: any\) =>\s*\n?\s*isIncomingSnapshotStale\(prev, data\.data\) \? prev : data\.data,?\s*\n?\s*\);/);
});

// ── 2. Free-practice isolation from the canonical queue ──────────────────

test("createAiMatch never creates a canonical-queue lifecycle row", () => {
  const src = strip(read(STORE));
  const fn = src.slice(src.indexOf("export async function createAiMatch"));
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  assert.doesNotMatch(body, /mirrorQueueCreated/);
});

test("every settlement mirror is guarded against AI matches", () => {
  const src = strip(read(STORE));
  const marker = "await settleMatch(tx, match, outcome);";
  const indices = [...src.matchAll(new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))].map(
    (m) => m.index,
  );
  assert.equal(indices.length, 3, "shoot + forfeit + disconnect all settle");
  for (const index of indices) {
    const window = src.slice(index, index + 420);
    assert.match(
      window,
      /if \(!match\.isAi\) \{/,
      `settlement at ${index} mirrors the queue without an AI guard`,
    );
  }
});

test("practice still advances the bot with no queue transition at all", () => {
  const src = strip(read(STORE));
  const fn = src.slice(src.indexOf("export async function advanceAiTurns"));
  assert.match(fn, /Deliberately NO settleMatch \/ mirrorQueueTransition here/);
});

// ── 3. disconnect-forfeit input validation ───────────────────────────────

test("disconnect-forfeit validates the match id before touching the store", () => {
  const src = strip(read(DISCONNECT));
  assert.match(src, /import\s*\{[^}]*isMatchId[^}]*\}\s*from\s*"[^"]*serverStore"/);
  const guard = src.indexOf("if (!isMatchId(matchId))");
  const call = src.indexOf("forfeitMatchOnDisconnect(");
  assert.ok(guard > -1, "matchId must be validated");
  assert.ok(call > -1 && guard < call, "validation must happen before the store call");
  assert.match(src.slice(guard, guard + 160), /status: 400/);
});
