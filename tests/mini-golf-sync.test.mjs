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

const { isIncomingSnapshotStale } = await import("../src/lib/mini-golf/ui.ts");

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
