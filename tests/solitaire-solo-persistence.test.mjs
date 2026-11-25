// tests/solitaire-solo-persistence.test.mjs
//
// PHASE 2 — completed Solo/Daily games survive the browser session.
//
// The real routes are driven through a fake database and a mocked Clerk
// `auth()` / daily deal. Only the seams are replaced: the submitted log is
// replayed by the REAL engine, and the row the route writes is read back and
// replayed again to prove exact reconstruction.
//
// The completed fixture is a genuine winning line: `solvableDealFromSeed(7)` is
// a deal the generator proved and the bot line solved, so the POST is not
// claiming a win the engine cannot verify.
//
// Run: node --import tsx --test --experimental-test-module-mocks tests/solitaire-solo-persistence.test.mjs

import test, { mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { solitaireDailyResults, solitaireSoloResults } from "../src/db/schema.ts";
import { dealFromSeed } from "../src/lib/solitaire-duel/deck.ts";
import { replayMoves } from "../src/lib/solitaire-duel/rules.ts";
import { solvableDealFromSeed, solveDealLine } from "../src/lib/solitaire-duel/solvable.ts";
import {
  canonicalMoveLog,
  moveLogDigest,
} from "../src/lib/solitaire-duel/soloPersistence.ts";

const read = (rel) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");

// tsx loads app modules as CommonJS, so this specifier can resolve to the CJS
// entry while the test file sees the ESM one. Mock both, as the guest tests do.
const CLERK_SERVER_CJS = pathToFileURL(
  createRequire(import.meta.url).resolve("@clerk/nextjs/server"),
).href;

const USER = "user_solitaire_reviewer";
const SEED = 7;

// ── The completed fixture (a real, engine-verified win) ────────────────────
const SOLO_DEAL = solvableDealFromSeed(SEED);
const SOLO_LINE = solveDealLine(SOLO_DEAL);
const SOLO_LOG = (SOLO_LINE ?? []).map((move) => ({ kind: move.kind, move }));
const SOLO_REPLAY = replayMoves({ deal: SOLO_DEAL, moves: SOLO_LOG });
const SOLO_STATE = SOLO_REPLAY.state;

// ── Fake world ─────────────────────────────────────────────────────────────

let fake;
const request = { userId: USER };
let mocksInstalled = false;

function createFakeDb() {
  const state = { solo: [], daily: [], inserts: [] };

  const insert = (table) => ({
    values(values) {
      const builder = {
        onConflictDoNothing() {
          return builder;
        },
        returning() {
          state.inserts.push({ table, values });

          if (table === solitaireSoloResults) {
            // The unique index is (user_id, seed, log_digest); NULL digests are
            // distinct in Postgres, so abandoned attempts never conflict.
            const clash =
              values.logDigest != null &&
              state.solo.some(
                (row) =>
                  row.userId === values.userId &&
                  row.seed === values.seed &&
                  row.logDigest === values.logDigest,
              );
            if (clash) return Promise.resolve([]);
            const id = randomUUID();
            state.solo.push({ id, createdAt: new Date(), ...values });
            return Promise.resolve([{ id }]);
          }

          if (table === solitaireDailyResults) {
            const clash = state.daily.some(
              (row) =>
                row.userId === values.userId && row.challengeDate === values.challengeDate,
            );
            if (clash) return Promise.resolve([]);
            const id = randomUUID();
            state.daily.push({ id, createdAt: new Date(), ...values });
            return Promise.resolve([{ id }]);
          }

          throw new Error(`fake db: unexpected insert table`);
        },
      };
      return builder;
    },
  });

  // Drizzle nests bound values inside SQL objects. The routes always filter by
  // an identity/date the fake knows, so matching on those values applies the
  // WHERE clause without needing to interpret the SQL tree.
  const valuesOf = (node, out = [], seen = new Set()) => {
    if (!node || typeof node !== "object" || seen.has(node)) return out;
    seen.add(node);
    for (const key of Object.keys(node)) {
      const child = node[key];
      if (typeof child === "string" || typeof child === "number") out.push(child);
      else if (child && typeof child === "object") valuesOf(child, out, seen);
    }
    return out;
  };

  const select = (fields) => {
    const chain = {
      table: null,
      values: [],
      limitCount: null,
      from(table) {
        chain.table = table;
        return chain;
      },
      where(condition) {
        chain.values = valuesOf(condition);
        return chain;
      },
      orderBy() {
        return chain;
      },
      limit(n) {
        chain.limitCount = n;
        return chain;
      },
      then(resolve, reject) {
        try {
          const rows =
            chain.table === solitaireSoloResults
              ? state.solo
              : chain.table === solitaireDailyResults
                ? state.daily
                : null;
          if (!rows) throw new Error("fake db: unexpected select table");

          // Enforce EACH predicate the routes use. Value-shape recognition is
          // enough here: the routes filter by Clerk id, uuid and UTC date, and
          // a match must satisfy all of them (so an id alone cannot expose
          // another player's row).
          // The SQL tree also contains COLUMN names; "user_id" starts with
          // "user_", so exclude it or every filtered read would match nothing.
          const userId = chain.values.find(
            (value) =>
              typeof value === "string" && value.startsWith("user_") && value !== "user_id",
          );
          const rowId = chain.values.find(
            (value) =>
              typeof value === "string" &&
              /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value),
          );
          const dateKey = chain.values.find(
            (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value),
          );
          const filtered = rows.filter(
            (row) =>
              (!userId || row.userId === userId) &&
              (!rowId || row.id === rowId) &&
              (!dateKey || row.challengeDate === dateKey),
          );
          const limited = filtered.slice(0, chain.limitCount ?? filtered.length);
          resolve(
            limited.map((row) =>
              fields
                ? Object.fromEntries(Object.keys(fields).map((key) => [key, row[key]]))
                : row,
            ),
          );
        } catch (error) {
          reject(error);
        }
      },
    };
    return chain;
  };

  return { state, db: { insert, select } };
}

const stableDb = {
  insert: (...args) => fake.db.insert(...args),
  select: (...args) => fake.db.select(...args),
};

// The Daily route's deal is server-derived; pin it to the same solved fixture so
// the test exercises the real route without paying for a second search.
const DAILY_DEAL = SOLO_DEAL;

function installMocks() {
  if (mocksInstalled) return;
  mocksInstalled = true;

  const clerkServer = { namedExports: { auth: async () => ({ userId: request.userId }) } };
  mock.module("@clerk/nextjs/server", clerkServer);
  mock.module(CLERK_SERVER_CJS, clerkServer);
  mock.module("../src/db/client.ts", { namedExports: { db: stableDb } });
  mock.module("../src/lib/solitaire-duel/daily.ts", {
    namedExports: {
      dailyDealFor: () => DAILY_DEAL,
      dailyDealSeed: () => SEED,
    },
  });
}

installMocks();

function reset({ userId = USER, daily = [] } = {}) {
  fake = createFakeDb();
  fake.state.daily.push(...daily);
  request.userId = userId;
}

const soloRoute = () => import("../src/app/api/solitaire/solo/route.ts");
const dailyRoute = () => import("../src/app/api/solitaire/daily/route.ts");
const reviewRoute = () => import("../src/app/api/solitaire/review/route.ts");

const reviewGet = (mode, id) =>
  new Request(`http://grynd.test/api/solitaire/review?mode=${mode}&id=${id}`);

const post = (url, body) =>
  new Request(`http://grynd.test${url}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

// ── Canonical log + digest ─────────────────────────────────────────────────

test("a verified log is stored in the engine's canonical shape and order", () => {
  const raw = [
    { kind: "draw", move: { kind: "draw", injected: "ignored" } },
    {
      kind: "waste-to-foundation",
      move: { kind: "waste-to-foundation", suit: "hearts", extra: 1 },
    },
  ];
  const canonical = canonicalMoveLog(raw);

  assert.equal(canonical.ok, true);
  assert.deepEqual(canonical.log, [
    { kind: "draw", move: { kind: "draw" } },
    { kind: "waste-to-foundation", move: { kind: "waste-to-foundation", suit: "hearts" } },
  ]);
});

test("a malformed or kind-mismatched entry is refused at its index", () => {
  const mismatch = canonicalMoveLog([
    { kind: "draw", move: { kind: "draw" } },
    { kind: "waste-to-tableau", move: { kind: "draw" } },
  ]);
  assert.deepEqual(mismatch, { ok: false, rejectedAt: 1 });

  assert.deepEqual(canonicalMoveLog([{ kind: "draw", move: { kind: "nope" } }]), {
    ok: false,
    rejectedAt: 0,
  });
  assert.equal(canonicalMoveLog("not-a-list").ok, false);
});

test("the digest is stable, order-sensitive, and blind to extra raw fields", () => {
  const canonical = canonicalMoveLog(SOLO_LOG);
  assert.equal(canonical.ok, true);

  const digest = moveLogDigest(canonical.log);
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.equal(moveLogDigest(canonical.log), digest);

  const reordered = [...canonical.log].reverse();
  assert.notEqual(moveLogDigest(reordered), digest);

  const noisy = canonicalMoveLog(
    SOLO_LOG.map((entry) => ({ ...entry, move: { ...entry.move, noise: true } })),
  );
  assert.equal(moveLogDigest(noisy.log), digest);
});

// ── Solitude: completed persistence ─────────────────────────────────────────

test("a completed solo game stores the verified log and reconstructs exactly", async () => {
  reset();
  const { POST } = await soloRoute();

  const response = await POST(post("/api/solitaire/solo", { seed: SEED, moves: SOLO_LOG, elapsedMs: 61_000 }));
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.data.completed, true);
  assert.equal(payload.data.reviewable, true);
  assert.equal(payload.data.recorded, true);
  assert.equal(fake.state.solo.length, 1);

  const row = fake.state.solo[0];
  assert.equal(row.completed, true);
  assert.equal(row.moves, SOLO_LOG.length);
  assert.deepEqual(row.moveLog, canonicalMoveLog(SOLO_LOG).log);
  assert.equal(row.logDigest, moveLogDigest(row.moveLog));

  // Read the persisted record back with the server's own reconstruction path.
  const replayed = replayMoves({ deal: dealFromSeed(Number(row.seed)), moves: row.moveLog });
  assert.equal(replayed.ok, true);
  assert.equal(replayed.state.completed, true);
  assert.equal(replayed.state.ply, SOLO_LOG.length);
  assert.deepEqual(replayed.state, SOLO_STATE);
});

test("an illegal log is rejected and nothing is written", async () => {
  reset();
  const { POST } = await soloRoute();

  const response = await POST(
    post("/api/solitaire/solo", {
      seed: SEED,
      moves: [{ kind: "waste-to-foundation", move: { kind: "waste-to-foundation", suit: "hearts" } }],
    }),
  );

  assert.equal(response.status, 422);
  assert.equal(fake.state.solo.length, 0);
  assert.equal(fake.state.inserts.length, 0);
});

test("a log from another deal is rejected on the submitted seed", async () => {
  reset();
  const { POST } = await soloRoute();

  const response = await POST(post("/api/solitaire/solo", { seed: SEED + 1, moves: SOLO_LOG }));
  assert.equal(response.status, 422);
  assert.equal(fake.state.solo.length, 0);
});

test("an abandoned (undo-truncated) game keeps its summary but no review log", async () => {
  reset();
  const { POST } = await soloRoute();

  const truncated = SOLO_LOG.slice(0, -5);
  assert.ok(truncated.length > 0);
  assert.deepEqual(canonicalMoveLog(truncated).log, truncated);

  // First a real completion, so the stats comparison has both kinds of row.
  await POST(post("/api/solitaire/solo", { seed: SEED, moves: SOLO_LOG, elapsedMs: 61_000 }));
  // Same deal, shorter final log: exactly what an undo-then-abandon produces.
  const response = await POST(
    post("/api/solitaire/solo", { seed: SEED, moves: truncated, elapsedMs: 30_000 }),
  );
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.data.completed, false);
  assert.equal(payload.data.reviewable, false);

  const abandoned = fake.state.solo.find((row) => row.completed === false);
  assert.ok(abandoned);
  assert.equal(abandoned.moveLog, null);
  assert.equal(abandoned.logDigest, null);
  assert.equal(abandoned.moves, truncated.length);

  // Existing solo statistics still count both attempts.
  assert.equal(payload.data.summary.games, 2);
  assert.equal(payload.data.summary.completed, 1);
  assert.equal(payload.data.summary.completionRate, 50);
});

test("a retried completed submission is idempotent", async () => {
  reset();
  const { POST } = await soloRoute();
  const body = { seed: SEED, moves: SOLO_LOG, elapsedMs: 61_000 };

  const first = await (await POST(post("/api/solitaire/solo", body))).json();
  const secondResponse = await POST(post("/api/solitaire/solo", body));
  const second = await secondResponse.json();

  assert.equal(first.data.recorded, true);
  assert.equal(second.data.recorded, false);
  assert.equal(second.data.duplicate, true);
  assert.equal(fake.state.solo.length, 1, "the retry must not create a second result");
  assert.equal(fake.state.solo[0].moveLog.length, SOLO_LOG.length);
});

test("the solo route requires an authenticated player", async () => {
  reset({ userId: null });
  const { POST } = await soloRoute();

  const response = await POST(post("/api/solitaire/solo", { seed: SEED, moves: SOLO_LOG }));
  assert.equal(response.status, 401);
  assert.equal(fake.state.solo.length, 0);
});

// ── Daily persistence ──────────────────────────────────────────────────────

test("a completed daily game stores its log exactly once", async () => {
  reset();
  const { POST } = await dailyRoute();

  const response = await POST(post("/api/solitaire/daily", { moves: SOLO_LOG, elapsedMs: 42_000 }));
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.data.recorded, true);
  assert.equal(payload.data.reviewable, true);
  assert.equal(fake.state.daily.length, 1);

  const row = fake.state.daily[0];
  assert.deepEqual(row.moveLog, canonicalMoveLog(SOLO_LOG).log);
  assert.equal(row.logDigest, moveLogDigest(row.moveLog));

  const replayed = replayMoves({ deal: DAILY_DEAL, moves: row.moveLog });
  assert.equal(replayed.ok, true);
  assert.equal(replayed.state.completed, true);
  assert.deepEqual(replayed.state, SOLO_STATE);
});

test("an incomplete daily attempt is refused and writes nothing", async () => {
  reset();
  const { POST } = await dailyRoute();

  const response = await POST(
    post("/api/solitaire/daily", { moves: SOLO_LOG.slice(0, -1), elapsedMs: 20_000 }),
  );

  assert.equal(response.status, 422);
  assert.equal(fake.state.daily.length, 0);
});

test("an illegal daily log is refused", async () => {
  reset();
  const { POST } = await dailyRoute();

  const response = await POST(
    post("/api/solitaire/daily", {
      moves: [{ kind: "draw", move: { kind: "tableau-to-foundation" } }],
    }),
  );
  assert.equal(response.status, 422);
  assert.equal(fake.state.daily.length, 0);
});

test("a duplicate daily submission cannot attach a different log", async () => {
  reset({
    daily: [
      {
        id: "legacy",
        userId: USER,
        // The route derives today's date; the fake row uses the same value the
        // route will compute.
        challengeDate: (await import("../src/lib/solitaire-duel/soloStats.js")).dailyDateKey(),
        completed: true,
        moves: 10,
        elapsedMs: 1_000,
        moveLog: null,
        logDigest: null,
        createdAt: new Date(),
      },
    ],
  });
  const { POST } = await dailyRoute();

  const response = await POST(post("/api/solitaire/daily", { moves: SOLO_LOG, elapsedMs: 42_000 }));
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.data.duplicate, true);
  assert.equal(payload.data.recorded, false);
  assert.equal(payload.data.reviewable, false, "the legacy row has no log and is not updated");
  assert.equal(fake.state.daily.length, 1);
  assert.equal(fake.state.daily[0].moveLog, null, "a submitted log must never overwrite the result");
});

test("the daily route still requires an authenticated player", async () => {
  reset({ userId: null });
  const { POST } = await dailyRoute();

  const response = await POST(post("/api/solitaire/daily", { moves: SOLO_LOG }));
  assert.equal(response.status, 401);
  assert.equal(fake.state.daily.length, 0);
});

// ── Retrieval: the server returns the exact deal + log to its owner ────────

test("a stored solo game is fetched by its owner and rebuilds the same board", async () => {
  reset();
  const { POST } = await soloRoute();
  await POST(post("/api/solitaire/solo", { seed: SEED, moves: SOLO_LOG, elapsedMs: 61_000 }));
  const row = fake.state.solo[0];

  const { GET } = await reviewRoute();
  const response = await GET(reviewGet("solo", row.id));
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.data.mode, "solo");
  assert.equal(payload.data.seed, SEED);
  assert.deepEqual(payload.data.deal, SOLO_DEAL);
  assert.deepEqual(payload.data.moves, canonicalMoveLog(SOLO_LOG).log);

  const replayed = replayMoves({ deal: payload.data.deal, moves: payload.data.moves });
  assert.equal(replayed.ok, true);
  assert.equal(replayed.state.completed, true);
  assert.deepEqual(replayed.state, SOLO_STATE);
});

test("a stored daily game is fetched by its owner with its date and deal", async () => {
  reset();
  const { POST } = await dailyRoute();
  await POST(post("/api/solitaire/daily", { moves: SOLO_LOG, elapsedMs: 42_000 }));
  const row = fake.state.daily[0];

  const { GET } = await reviewRoute();
  const response = await GET(reviewGet("daily", row.id));
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.data.mode, "daily");
  assert.equal(payload.data.dateKey, row.challengeDate);
  assert.deepEqual(payload.data.deal, DAILY_DEAL);
  assert.deepEqual(payload.data.moves, canonicalMoveLog(SOLO_LOG).log);
  assert.equal(replayMoves({ deal: payload.data.deal, moves: payload.data.moves }).state.completed, true);
});

test("another player cannot fetch the game, and an unlogged row is not reviewable", async () => {
  reset();
  const { POST } = await soloRoute();
  await POST(post("/api/solitaire/solo", { seed: SEED, moves: SOLO_LOG }));
  const row = fake.state.solo[0];
  const { GET } = await reviewRoute();

  request.userId = "user_somebody_else";
  assert.equal((await GET(reviewGet("solo", row.id))).status, 404);

  request.userId = USER;
  assert.equal((await GET(reviewGet("solo", row.id))).status, 200);

  // A completed legacy row with no log must never read as an empty review.
  row.moveLog = null;
  assert.equal((await GET(reviewGet("solo", row.id))).status, 404);

  // Malformed query / signed-out caller.
  assert.equal((await GET(reviewGet("bogus", row.id))).status, 400);
  request.userId = null;
  assert.equal((await GET(reviewGet("solo", row.id))).status, 401);
});

// ── Account review history ──────────────────────────────────────────────────

const historyRoute = () => import("../src/app/api/solitaire/history/route.ts");

const historyGet = (query = "") =>
  new Request(`http://grynd.test/api/solitaire/history${query}`);

test("the review history requires an account", async () => {
  reset({ userId: null });
  const { GET } = await historyRoute();
  assert.equal((await GET(historyGet())).status, 401);
});

test("the history lists only the caller's reviewable games, newest first", async () => {
  reset();
  const solo = await soloRoute();
  const soloRecord = await (
    await solo.POST(post("/api/solitaire/solo", { seed: SEED, moves: SOLO_LOG, elapsedMs: 61_000 }))
  ).json();
  const soloId = soloRecord.data.id;

  const daily = await dailyRoute();
  const dailyRecord = await (
    await daily.POST(post("/api/solitaire/daily", { moves: SOLO_LOG, elapsedMs: 42_000 }))
  ).json();
  const dailyId = dailyRecord.data.id;

  // Rows that must NOT appear: an abandoned attempt, a legacy completed row
  // with no stored log, and another player's reviewable game.
  fake.state.solo.push(
    {
      id: randomUUID(), userId: USER, seed: String(SEED), completed: false,
      moves: 3, elapsedMs: 1_000, moveLog: null, logDigest: null, createdAt: new Date(),
    },
    {
      id: randomUUID(), userId: USER, seed: String(SEED + 2), completed: true,
      moves: 10, elapsedMs: 9_000, moveLog: null, logDigest: null, createdAt: new Date(),
    },
    {
      id: randomUUID(), userId: "user_somebody_else", seed: String(SEED), completed: true,
      moves: SOLO_LOG.length, elapsedMs: 5_000, moveLog: SOLO_LOG,
      logDigest: "f".repeat(64), createdAt: new Date(),
    },
  );

  const { GET } = await historyRoute();
  const response = await GET(historyGet());
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(
    payload.data.games.map((game) => game.id).sort(),
    [soloId, dailyId].sort(),
    "exactly the two recorded games, and nobody else's",
  );

  const soloGame = payload.data.games.find((game) => game.gameKind === "solo");
  const dailyGame = payload.data.games.find((game) => game.gameKind === "daily");
  assert.equal(soloGame.seed, SEED);
  assert.equal(soloGame.moves, SOLO_LOG.length);
  assert.equal(soloGame.elapsedMs, 61_000);
  assert.equal(soloGame.dateKey, null);
  const { dailyDateKey } = await import("../src/lib/solitaire-duel/soloStats.js");
  assert.equal(dailyGame.dateKey, dailyDateKey());
  assert.equal(dailyGame.seed, null);

  // A directory, never a log: no game data moves through the list.
  for (const game of payload.data.games) {
    assert.equal("moveLog" in game, false);
    assert.equal("deal" in game, false);
    assert.equal("moves" in game, true);
  }
  const times = payload.data.games.map((game) => Date.parse(game.completedAt));
  assert.deepEqual(times, [...times].sort((a, b) => b - a));
});

test("the history honours and clamps its limit", async () => {
  reset();
  for (let index = 0; index < 5; index += 1) {
    fake.state.solo.push({
      id: randomUUID(), userId: USER, seed: String(SEED), completed: true,
      moves: 10, elapsedMs: 1_000 + index, moveLog: [{ kind: "draw", move: { kind: "draw" } }],
      logDigest: String(index).padStart(64, "0"),
      createdAt: new Date(Date.parse("2026-11-01T00:00:00.000Z") + index * 1_000),
    });
  }

  const { GET } = await historyRoute();
  const one = await (await GET(historyGet("?limit=1"))).json();
  assert.equal(one.data.games.length, 1, "a one-game page is exactly one game");

  // The merge is ordered newest-first on ONE timeline. The fake database does
  // not execute SQL ordering, so this also proves the route's own sort.
  const all = await (await GET(historyGet("?limit=999"))).json();
  assert.equal(all.data.games.length, 5, "the cap and the row count agree");
  assert.deepEqual(
    all.data.games.map((game) => game.elapsedMs),
    [1_004, 1_003, 1_002, 1_001, 1_000],
  );

  const nonsense = await (await GET(historyGet("?limit=abc"))).json();
  assert.equal(nonsense.data.games.length, 5, "a nonsense limit falls back, never fails");
});

// ── Guest flow, contracts, migration ───────────────────────────────────────

test("guest practice retains the completed game locally instead of uploading it", () => {
  const client = read("src/components/solitaire-duel/SoloSolitaireGame.tsx");

  assert.match(client, /LOCAL_COMPLETED_KEY/);
  assert.match(client, /MAX_LOCAL_COMPLETED/);
  assert.match(client, /appendLocalCompleted/);
  // The stored payload is seed/date + the FINAL log, not a board snapshot.
  assert.match(client, /log: finished\.log/);
  assert.match(client, /if \(finished\.won\)/);
  assert.match(client, /seed: finished\.seed/);
  assert.match(client, /dateKey: finished\.dateKey/);
  // It is written on the 401 (guest) branch only.
  assert.match(client, /if \(response\.status === 401\)[\s\S]*appendLocalCompleted/);
});

test("the routes only insert, and never touch ranked tables or result logs", () => {
  for (const file of ["src/app/api/solitaire/solo/route.ts", "src/app/api/solitaire/daily/route.ts"]) {
    const source = read(file);
    assert.match(source, /replayMoves/);
    assert.match(source, /canonicalMoveLog/);
    assert.match(source, /moveLogDigest/);
    assert.doesNotMatch(source, /\.update\(|\.delete\(/);
    assert.doesNotMatch(source, /solitaire_duel_matches|solitaireDuelMatches/);
    assert.doesNotMatch(source, /eloStore|applyRating|recordRating|ratingHistory/);
  }
});

test("account deletion erases both single-player history tables", () => {
  const source = read("src/lib/security/deleteUserData.ts");
  assert.match(source, /solitaireSoloResults\.userId, clerkId/);
  assert.match(source, /solitaireDailyResults\.userId, clerkId/);
});

test("the schema and migration expose the stored log and its unique key", () => {
  const schema = read("src/db/schema.ts");
  assert.match(schema, /moveLog: jsonb\("move_log"\)/);
  assert.match(schema, /logDigest: varchar\("log_digest", \{ length: 64 \}\)/);
  assert.match(schema, /solitaire_solo_results_user_seed_log_unique/);

  const migration = read("src/db/migrations/0248_solitaire_move_history.sql");
  assert.match(migration, /ADD COLUMN IF NOT EXISTS "move_log" jsonb/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS "log_digest" varchar\(64\)/);
  assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS "solitaire_solo_results_user_seed_log_unique"/);
  assert.match(migration, /CHECK \("move_log" IS NULL OR "completed"\)/);
  assert.doesNotMatch(migration, /DROP TABLE|DELETE FROM|TRUNCATE/i);

  const journal = JSON.parse(read("src/db/migrations/meta/_journal.json"));
  const entry = journal.entries.find((row) => row.tag === "0248_solitaire_move_history");
  assert.ok(entry);
  assert.equal(entry.idx, 229);
  assert.equal(entry.version, "7");
  assert.equal(entry.breakpoints, true);
});
