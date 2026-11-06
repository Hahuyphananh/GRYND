// tests/guest-progress.test.mjs
//
// Phase 2B — GUEST PROGRESSION FOUNDATION + TIC-TAC-TOE PILOT.
// Phase 2C — the same two tables and writer, with Dominoes practice added to the
// closed allowlist and wired into that store's AI settlement (section 8).
// Phase 2D — the same again for Battleship, whose every terminal path (played
// finish, timeout forfeit, abandonment) funnels through one settlement helper
// (section 9).
// Phase 2E — Odds, whose AI duel rounds are resolved by the server from its own
// stored state; the dead second Clerk gate on its practice routes is removed so
// a verified guest can actually reach them (section 10).
//
// What is under test, in one line: a signed-out guest's finished Tic-Tac-Toe
// practice match is persisted from the SERVER's own outcome into two new
// tables, exactly once, and can be read back only by that guest's verified
// cookie — while every account-facing system (Elo, trophies, user stats,
// tokens, leaderboards) stays completely untouched.
//
// The real modules are driven through a fake database, a fake cookie jar and a
// mocked Clerk `auth()`; only the seams are replaced, so the SQL shapes the
// writer asks for (the profile upsert, the ON CONFLICT DO NOTHING insert) and
// the reads the endpoint performs are the code's actual calls.
//
// The fake's `where()` extracts the guest id from the Drizzle condition by
// walking the SQL object for the bound parameter — that is what lets the
// isolation test prove the endpoint filters by the cookie identity instead of
// returning everybody's rows.
//
// Run: node --import tsx --test --experimental-test-module-mocks tests/guest-progress.test.mjs

import test, { mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { guestPracticeResults, guestProfiles } from "../src/db/schema.ts";

const read = (rel) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");

// tsx loads the app modules as CommonJS, so their `@clerk/nextjs/server` import
// resolves to the package CJS entry while this file sees the ESM one — the mock
// registry keys on the resolved file, so both are mocked (tests/guest-session-cookie).
const CLERK_SERVER_CJS = pathToFileURL(
  createRequire(import.meta.url).resolve("@clerk/nextjs/server"),
).href;

const GUEST_A = "guest_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const GUEST_B = "guest_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const CLERK_USER = "user_registered_practice_player";
const BOT = "tic_tac_toe_ai_bot";
const MATCH_1 = "77777777-7777-4777-8777-777777777777";
const MATCH_2 = "88888888-8888-4888-8888-888888888888";
const MATCH_3 = "99999999-9999-4999-8999-999999999999";
const DOMINOES_BOT = "dominoes_ai_bot";
const BATTLESHIP_BOT = "battleship_ai_bot";

let fake;
const jar = new Map();
const request = { userId: null };
let ratingCalls = [];
let trophyCalls = [];

// ONE stable database object for the whole file. Dynamic `import()` caches
// modules, so the app modules the tests load stay singletons — a mock bound to
// a per-test object would go stale the moment `reset()` swapped the fake out.
const stableDb = {
  insert: (...args) => fake.db.insert(...args),
  select: (...args) => fake.db.select(...args),
};
let mocksInstalled = false;

// ── Fake database ───────────────────────────────────────────────────────────

function createFakeDb() {
  const state = { profiles: new Map(), results: [], inserts: [], selects: [] };

  const insertInto = (table, values, mode) => {
    state.inserts.push({ table, values, mode });

    if (table === guestProfiles) {
      const existing = state.profiles.get(values.guestId);
      if (existing) existing.lastSeenAt = values.lastSeenAt;
      else
        state.profiles.set(values.guestId, {
          createdAt: values.createdAt,
          lastSeenAt: values.lastSeenAt,
        });
      return;
    }

    if (table === guestPracticeResults) {
      // ON CONFLICT (game_key, match_id) DO NOTHING
      const duplicate = state.results.some(
        (row) => row.gameKey === values.gameKey && row.matchId === values.matchId,
      );
      if (duplicate) return;
      state.results.push({ id: state.results.length + 1, ...values });
    }
  };

  const insert = (table) => ({
    values(values) {
      const builder = {
        onConflictDoUpdate(options) {
          builder.options = options;
          insertInto(table, values, "update");
          return Promise.resolve();
        },
        onConflictDoNothing(options) {
          builder.options = options;
          insertInto(table, values, "nothing");
          return Promise.resolve();
        },
        then(resolve, reject) {
          try {
            insertInto(table, values, "plain");
            return Promise.resolve().then(resolve, reject);
          } catch (error) {
            return Promise.reject(error).then(resolve, reject);
          }
        },
      };
      return builder;
    },
  });

  // Drizzle binds `eq(column, value)` values as parameters nested in a SQL
  // object. Finding the guest id in that tree is how the fake applies the
  // WHERE clause the store and the endpoint actually wrote.
  const guestIdOf = (node, seen = new Set()) => {
    if (!node || typeof node !== "object" || seen.has(node)) return null;
    seen.add(node);
    if (typeof node.value === "string" && node.value.startsWith("guest_")) return node.value;
    for (const key of Object.keys(node)) {
      const found = guestIdOf(node[key], seen);
      if (found) return found;
    }
    return null;
  };

  const runSelect = (chain) => {
    // Fail loudly: a WHERE clause the fake cannot read would otherwise look
    // like "this guest has no rows" and quietly pass an isolation test.
    if (!chain.guestId) {
      throw new Error("fake db: could not read the guest id from the WHERE clause");
    }

    if (chain.table === guestProfiles) {
      const profile = state.profiles.get(chain.guestId);
      return profile
        ? [{ createdAt: profile.createdAt, lastSeenAt: profile.lastSeenAt }]
        : [];
    }

    const rows = state.results.filter((row) => row.guestId === chain.guestId);

    if (chain.grouped) {
      const counts = new Map();
      for (const row of rows) {
        const key = `${row.gameKey}\u0000${row.result}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      return [...counts.entries()].map(([key, count]) => {
        const [gameKey, result] = key.split("\u0000");
        return { gameKey, result, count };
      });
    }

    return [...rows]
      .sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime() || b.id - a.id,
      )
      .slice(0, chain.limitCount ?? rows.length)
      .map((row) => ({
        gameKey: row.gameKey,
        result: row.result,
        aiDifficulty: row.aiDifficulty ?? null,
        playedAt: row.createdAt,
      }));
  };

  const select = () => {
    const chain = {
      table: null,
      guestId: null,
      grouped: false,
      limitCount: null,
      from(table) {
        chain.table = table;
        return chain;
      },
      where(condition) {
        chain.guestId = guestIdOf(condition);
        return chain;
      },
      groupBy() {
        chain.grouped = true;
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
          resolve(runSelect(chain));
        } catch (error) {
          reject(error);
        }
      },
    };
    state.selects.push(chain);
    return chain;
  };

  return { state, db: { insert, select }, tx: { insert } };
}

// ── Mock installation ───────────────────────────────────────────────────────

function reset({ userId = null, cookie = null } = {}) {
  fake = createFakeDb();
  jar.clear();
  request.userId = userId;
  ratingCalls = [];
  trophyCalls = [];
  if (cookie) jar.set("grynd_guest", cookie);
}

// Installed ONCE, process-wide, before any app module is imported. The mocks
// read the mutable `jar` / `request` / `fake`, so every test still gets a
// clean world through `reset()`.
function installMocks() {
  if (mocksInstalled) return;
  mocksInstalled = true;

  mock.module("next/headers", {
    namedExports: {
      cookies: async () => ({
        get: (name) => (jar.has(name) ? { name, value: jar.get(name) } : undefined),
        set: (name, value) => jar.set(name, value),
      }),
      headers: async () =>
        new Headers({ host: "grynd.test", "x-forwarded-proto": "https" }),
    },
  });

  const clerkServer = { namedExports: { auth: async () => ({ userId: request.userId }) } };
  mock.module("@clerk/nextjs/server", clerkServer);
  mock.module(CLERK_SERVER_CJS, clerkServer);

  mock.module("../src/lib/auth/requireAgeVerified.ts", {
    namedExports: {
      requireAgeVerifiedUser: async () => ({ response: null, userId: request.userId }),
    },
  });

  // The ONLY database the code under test can reach.
  mock.module("../src/db/client.ts", { namedExports: { db: stableDb } });

  // Official settlement writers: mocked so the test can prove they are NEVER
  // called on the guest path.
  mock.module("../src/lib/rating.js", {
    namedExports: {
      applyRatingResult: async (...args) => {
        ratingCalls.push(args);
        return { applied: true };
      },
    },
  });
  mock.module("../src/lib/trophyStore.js", {
    namedExports: {
      applyTrophyResult: async () => {
        trophyCalls.push(1);
        return { applied: true };
      },
    },
  });
}

installMocks();

const guestSession = () => import("../src/lib/auth/guestSession.ts");
const progressStore = () => import("../src/lib/guest/practiceProgress.ts");
const progressRoute = () => import("../src/app/api/guest/progress/route.ts");

async function cookieFor(guestId) {
  const { serializeGuestCookie } = await guestSession();
  return serializeGuestCookie(guestId);
}

// ── 1. Validation of the authoritative inputs ────────────────────────────────

test("only an HMAC guest id for a supported game can become a result", async (t) => {
  reset();
  installMocks(t);
  const { normalizeGuestPracticeResult } = await progressStore();

  const accepted = normalizeGuestPracticeResult({
    guestId: GUEST_A,
    gameKey: "tic-tac-toe",
    matchId: MATCH_1,
    result: "win",
    aiDifficulty: "Hard",
  });
  assert.deepEqual(accepted, {
    guestId: GUEST_A,
    gameKey: "tic-tac-toe",
    matchId: MATCH_1,
    result: "win",
    aiDifficulty: "hard",
  });

  for (const guestId of [CLERK_USER, BOT, "guest_", "", null, 42, `${GUEST_A}extra!`]) {
    assert.equal(
      normalizeGuestPracticeResult({
        guestId,
        gameKey: "tic-tac-toe",
        matchId: MATCH_1,
        result: "win",
      }),
      null,
      `${String(guestId)} must never be recorded as a guest`,
    );
  }

  for (const result of ["victory", "WIN", "", null]) {
    assert.equal(
      normalizeGuestPracticeResult({
        guestId: GUEST_A,
        gameKey: "tic-tac-toe",
        matchId: MATCH_1,
        result,
      }),
      null,
      `"${String(result)}" is not a persisted outcome`,
    );
  }

  // A game whose guest progression has not been designed is a no-op, not a row.
  assert.equal(
    normalizeGuestPracticeResult({
      guestId: GUEST_A,
      gameKey: "chess",
      matchId: MATCH_1,
      result: "win",
    }),
    null,
  );

  // match_id is varchar(64) and the id must be present.
  assert.equal(
    normalizeGuestPracticeResult({
      guestId: GUEST_A,
      gameKey: "tic-tac-toe",
      matchId: "x".repeat(65),
      result: "win",
    }),
    null,
  );
  assert.equal(
    normalizeGuestPracticeResult({
      guestId: GUEST_A,
      gameKey: "tic-tac-toe",
      matchId: "",
      result: "win",
    }),
    null,
  );

  // An unrecognisable difficulty is dropped rather than stored raw.
  const junkDifficulty = normalizeGuestPracticeResult({
    guestId: GUEST_A,
    gameKey: "tic-tac-toe",
    matchId: MATCH_1,
    result: "draw",
    aiDifficulty: "not a tier!",
  });
  assert.equal(junkDifficulty.aiDifficulty, null);
});

// ── 2. Lazy profile creation + one persisted result ──────────────────────────

test("the first finished practice match creates the profile and one result", async (t) => {
  reset();
  installMocks(t);
  const { recordGuestPracticeResult } = await progressStore();

  assert.equal(fake.state.profiles.size, 0, "nothing exists before a match is finished");

  const ok = await recordGuestPracticeResult(fake.tx, {
    guestId: GUEST_A,
    gameKey: "tic-tac-toe",
    matchId: MATCH_1,
    result: "win",
    aiDifficulty: "normal",
  });

  assert.equal(ok, true);
  assert.deepEqual([...fake.state.profiles.keys()], [GUEST_A]);
  assert.equal(fake.state.results.length, 1);
  assert.equal(fake.state.results[0].result, "win");
  assert.equal(fake.state.results[0].gameKey, "tic-tac-toe");
  assert.equal(fake.state.results[0].matchId, MATCH_1);
  assert.equal(fake.state.results[0].aiDifficulty, "normal");

  // Profile upsert first (FK), then the result insert with its conflict clause.
  assert.deepEqual(
    fake.state.inserts.map((entry) => entry.mode),
    ["update", "nothing"],
  );
});

test("a non-guest identity, or an unsupported game, writes nothing at all", async (t) => {
  reset();
  installMocks(t);
  const { recordGuestPracticeResult, recordGuestPracticeResultSafely } =
    await progressStore();

  for (const guestId of [CLERK_USER, BOT, "not-a-guest"]) {
    assert.equal(
      await recordGuestPracticeResult(fake.tx, {
        guestId,
        gameKey: "tic-tac-toe",
        matchId: MATCH_1,
        result: "win",
      }),
      false,
    );
    assert.equal(
      await recordGuestPracticeResultSafely(fake.tx, {
        guestId,
        gameKey: "tic-tac-toe",
        matchId: MATCH_1,
        result: "win",
      }),
      false,
    );
  }

  assert.equal(
    await recordGuestPracticeResult(fake.tx, {
      guestId: GUEST_A,
      gameKey: "chess",
      matchId: MATCH_1,
      result: "win",
    }),
    false,
  );

  assert.deepEqual(fake.state.inserts, []);
  assert.equal(fake.state.profiles.size, 0);
  assert.equal(fake.state.results.length, 0);
});

// ── 3. Idempotency ──────────────────────────────────────────────────────────

test("a repeated settlement produces exactly one result", async (t) => {
  reset();
  installMocks(t);
  const { recordGuestPracticeResult } = await progressStore();

  const first = await recordGuestPracticeResult(fake.tx, {
    guestId: GUEST_A,
    gameKey: "tic-tac-toe",
    matchId: MATCH_1,
    result: "win",
  });
  // A retry with a contradicting outcome must not rewrite history.
  const retry = await recordGuestPracticeResult(fake.tx, {
    guestId: GUEST_A,
    gameKey: "tic-tac-toe",
    matchId: MATCH_1,
    result: "loss",
  });

  assert.equal(first, true);
  assert.equal(retry, true);
  assert.equal(fake.state.results.length, 1);
  assert.equal(fake.state.results[0].result, "win");
  assert.equal(fake.state.profiles.size, 1);

  // A different match is a different result.
  await recordGuestPracticeResult(fake.tx, {
    guestId: GUEST_A,
    gameKey: "tic-tac-toe",
    matchId: MATCH_2,
    result: "draw",
  });
  assert.equal(fake.state.results.length, 2);
});

test("the settlement-safe writer never throws and contains a database failure", async (t) => {
  reset();
  installMocks(t);
  const { recordGuestPracticeResultSafely } = await progressStore();

  // A driver that fails the moment the first insert is attempted.
  const brokenTx = {
    insert() {
      return {
        values() {
          throw new Error("relation does not exist");
        },
      };
    },
  };
  assert.equal(
    await recordGuestPracticeResultSafely(brokenTx, {
      guestId: GUEST_A,
      gameKey: "tic-tac-toe",
      matchId: MATCH_1,
      result: "win",
    }),
    false,
  );

  // A failure INSIDE the savepoint must be contained by it, not by luck.
  let savepointUsed = false;
  const savepointTx = {
    insert: fake.tx.insert,
    async transaction(callback) {
      savepointUsed = true;
      await callback(fake.tx);
    },
  };
  assert.equal(
    await recordGuestPracticeResultSafely(savepointTx, {
      guestId: GUEST_A,
      gameKey: "tic-tac-toe",
      matchId: MATCH_1,
      result: "win",
    }),
    true,
  );
  assert.equal(savepointUsed, true);

  const failingSavepointTx = {
    insert: fake.tx.insert,
    async transaction() {
      throw new Error("savepoint failed");
    },
  };
  assert.equal(
    await recordGuestPracticeResultSafely(failingSavepointTx, {
      guestId: GUEST_B,
      gameKey: "tic-tac-toe",
      matchId: MATCH_2,
      result: "draw",
    }),
    false,
  );
});

// ── 4. Derived statistics ────────────────────────────────────────────────────

test("wins, losses and draws are derived per game and overall", async (t) => {
  reset();
  installMocks(t);
  const { summarizeGuestProgress } = await progressStore();

  const summary = summarizeGuestProgress([
    { gameKey: "tic-tac-toe", result: "win" },
    { gameKey: "tic-tac-toe", result: "win" },
    { gameKey: "tic-tac-toe", result: "loss" },
    { gameKey: "tic-tac-toe", result: "draw" },
    { gameKey: "dominoes", result: "loss" },
  ]);

  assert.deepEqual(summary.totals, { matches: 5, wins: 2, losses: 2, draws: 1 });
  assert.deepEqual(summary.games, [
    { gameKey: "dominoes", matches: 1, wins: 0, losses: 1, draws: 0 },
    { gameKey: "tic-tac-toe", matches: 4, wins: 2, losses: 1, draws: 1 },
  ]);

  // Deterministic ordering, and unknown outcome strings are not fabricated.
  assert.deepEqual(
    summarizeGuestProgress([{ gameKey: "tic-tac-toe", result: "forfeit" }]).totals,
    { matches: 0, wins: 0, losses: 0, draws: 0 },
  );
});

// ── 5. The endpoint ─────────────────────────────────────────────────────────

test("the endpoint returns only the authenticated guest's own progression", async (t) => {
  reset();
  installMocks(t);
  const { recordGuestPracticeResult } = await progressStore();

  // Guest A's two matches (through the real writer).
  await recordGuestPracticeResult(fake.tx, {
    guestId: GUEST_A,
    gameKey: "tic-tac-toe",
    matchId: MATCH_1,
    result: "win",
    aiDifficulty: "easy",
  });
  await recordGuestPracticeResult(fake.tx, {
    guestId: GUEST_A,
    gameKey: "tic-tac-toe",
    matchId: MATCH_2,
    result: "loss",
    aiDifficulty: null,
  });

  // Somebody else's history, present in the same database.
  const later = new Date(Date.now() + 60_000);
  fake.state.profiles.set(GUEST_B, { createdAt: later, lastSeenAt: later });
  fake.state.results.push({
    id: 99,
    guestId: GUEST_B,
    gameKey: "tic-tac-toe",
    matchId: "99999999-9999-4999-8999-999999999999",
    result: "win",
    aiDifficulty: null,
    createdAt: later,
  });

  jar.set("grynd_guest", await cookieFor(GUEST_A));
  const { GET } = await progressRoute();

  // The handler takes no parameters: an id in the URL or a header is simply
  // never read.
  const res = await GET({
    url: `http://grynd.test/api/guest/progress?guestId=${GUEST_B}`,
    headers: new Headers({ "x-guest-id": GUEST_B }),
  });
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.success, true);
  assert.deepEqual(body.data.totals, { matches: 2, wins: 1, losses: 1, draws: 0 });
  assert.deepEqual(body.data.games, [
    { gameKey: "tic-tac-toe", matches: 2, wins: 1, losses: 1, draws: 0 },
  ]);
  assert.equal(body.data.history.length, 2);
  assert.equal(body.data.history[0].result, "loss", "newest first");
  assert.equal(body.data.history[1].aiDifficulty, "easy");
  assert.ok(body.data.profile.createdAt, "the guest's own profile is reported");

  const serialized = JSON.stringify(body);
  assert.doesNotMatch(serialized, new RegExp(GUEST_B), "another guest's data leaked");
  assert.doesNotMatch(serialized, /matchId|"match_id"|99999999/, "internal match ids leaked");
  assert.doesNotMatch(serialized, /"id":/, "internal row ids leaked");
});

test("a missing, forged or expired guest cookie cannot read progress", async (t) => {
  reset();
  installMocks(t);
  const { GET } = await progressRoute();

  const anonymous = await GET();
  assert.equal(anonymous.status, 401);

  jar.set("grynd_guest", `${GUEST_A}.forged-signature`);
  const forged = await GET();
  assert.equal(forged.status, 401);
  assert.equal((await forged.json()).success, false);

  // A correctly signed cookie for an id that is not a guest id is refused by
  // the session reader itself, so there is nothing to read.
  jar.set("grynd_guest", `${CLERK_USER}.${"A".repeat(43)}`);
  const nonGuest = await GET();
  assert.equal(nonGuest.status, 401);

  // No query ever ran: an unauthenticated call cannot even reach the database.
  assert.deepEqual(fake.state.selects, []);
});

test("a signed-in visitor is refused and keeps their account statistics", async (t) => {
  reset({ userId: CLERK_USER });
  installMocks(t);
  const { GET } = await progressRoute();

  const res = await GET();
  const body = await res.json();

  assert.equal(res.status, 403);
  assert.equal(body.success, false);
  assert.equal(body.error, "Guest session required");
  assert.equal(body.reason, "signed_in_use_account_stats");
  assert.equal(body.data, undefined);
  assert.deepEqual(fake.state.selects, [], "no guest row is read for an account");
});

test("reading guest progress never invokes rating or trophy settlement", async (t) => {
  reset();
  installMocks(t);
  const { recordGuestPracticeResult } = await progressStore();
  await recordGuestPracticeResult(fake.tx, {
    guestId: GUEST_A,
    gameKey: "tic-tac-toe",
    matchId: MATCH_1,
    result: "win",
  });

  jar.set("grynd_guest", await cookieFor(GUEST_A));
  const { GET } = await progressRoute();
  assert.equal((await GET()).status, 200);

  assert.deepEqual(ratingCalls, []);
  assert.deepEqual(trophyCalls, []);
});

// ── 6. Tic-Tac-Toe settlement wiring ────────────────────────────────────────

test("the settlement records the server's own guest outcome inside the transaction", () => {
  const src = read("src/lib/tic-tac-toe/serverStore.ts");

  // Still the one practice branch, still the pre-existing daily-reward marker.
  assert.match(src, /if \(match\.isAi\) \{/);
  assert.match(src, /await markDailyRewardWin\(tx, winnerId\);/);

  // The guest write is inside that branch, fed by the locked row and `outcome`.
  assert.match(src, /const guestId = \[match\.player1Id, match\.player2Id\]\.find\(/);
  assert.match(src, /isGuestId\(id\)/);
  assert.match(src, /await recordGuestPracticeResultSafely\(tx, \{/);
  assert.match(src, /gameKey: GUEST_PRACTICE_GAME_KEY,/);
  assert.match(src, /matchId: match\.id,/);
  assert.match(src, /outcome\.result === RESULT\.TIE/);
  assert.match(src, /result: practiceResult,/);
  assert.match(src, /aiDifficulty: match\.aiDifficulty,/);

  // No client input: the writer is never fed a body field.
  assert.doesNotMatch(src, /recordGuestPracticeResultSafely\(tx, \{\s*guestId: (?:body|req|request)/);

  // The practice branch ends before any official settlement call.
  assert.ok(
    src.indexOf("recordGuestPracticeResultSafely(tx, {") <
      src.indexOf("await applyRatingResult({"),
    "the guest write must sit in the AI branch, before the rated path",
  );

  // The registered-user settlement path is intact.
  assert.match(src, /applyTrophyResult\(\{/);
  assert.match(src, /refundMatchWagers\(/);
  assert.match(src, /await tx\s*\.update\(users\)/);
});

test("the guest progression module never touches official progression systems", () => {
  const src = read("src/lib/guest/practiceProgress.ts");

  // No import of any ranking, reward or economy module…
  const imports = src
    .split("\n")
    .filter((line) => line.trim().startsWith("import "))
    .join("\n");
  for (const forbidden of [
    "rating",
    "trophyStore",
    "playerRatings",
    "playerTrophies",
    "userStats",
    "tokens",
    "canonicalQueueLifecycle",
  ]) {
    assert.doesNotMatch(
      imports,
      new RegExp(forbidden),
      `guest progression must not import ${forbidden}`,
    );
  }
  // …and no call to the official writers.
  assert.doesNotMatch(src, /applyRatingResult\(|applyTrophyResult\(/);

  // The writer only ever inserts into the two guest tables.
  assert.match(src, /insert\(guestProfiles\)/);
  assert.match(src, /insert\(guestPracticeResults\)/);
  assert.match(src, /onConflictDoNothing\(\{/);
  assert.match(src, /target: \[guestPracticeResults\.gameKey, guestPracticeResults\.matchId\]/);
});

test("the endpoint never reads an identity from the request", () => {
  const src = read("src/app/api/guest/progress/route.ts");

  assert.match(src, /const gate = await requirePracticePlayer\(\);/);
  assert.match(src, /if \(!gate\.isGuest \|\| !gate\.playerId\)/);
  assert.match(src, /loadGuestProgress\(gate\.playerId, \{/);
  // No request-derived identity anywhere in the CODE (comments may name what
  // the handler deliberately does not do).
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(code, /from "next\/headers"/);
  assert.doesNotMatch(code, /searchParams/);
  assert.doesNotMatch(code, /\.json\(\)/);
  assert.doesNotMatch(code, /\bguestId\b/);
  assert.doesNotMatch(code, /\brequest\b/);
  assert.doesNotMatch(code, /\breq\b/);
});

// ── 7. Migration + journal contract ─────────────────────────────────────────

test("the guest migrations carry their constraints, index and journal entries", () => {
  const profiles = read("src/db/migrations/0239_guest_profiles.sql");
  const results = read("src/db/migrations/0240_guest_practice_results.sql");

  assert.match(profiles, /CREATE TABLE IF NOT EXISTS "guest_profiles"/);
  assert.match(profiles, /"guest_id" varchar\(64\) PRIMARY KEY/);
  assert.match(profiles, /"last_seen_at" timestamp NOT NULL DEFAULT now\(\)/);
  assert.match(profiles, /guest_profiles_guest_id_format/);
  assert.match(profiles, /\^guest_\[A-Za-z0-9_-\]\{1,58\}\$/);
  // Claim columns are postponed to the conversion phase: no column of that name.
  assert.doesNotMatch(profiles, /^\s*"claimed_by_user_id"/m);
  assert.doesNotMatch(profiles, /^\s*"claimed_at"/m);

  assert.match(results, /CREATE TABLE IF NOT EXISTS "guest_practice_results"/);
  assert.match(results, /REFERENCES "guest_profiles" \("guest_id"\) ON DELETE CASCADE/);
  assert.match(results, /"match_id" varchar\(64\) NOT NULL/);
  assert.match(results, /"game_key" varchar\(32\) NOT NULL/);
  assert.match(results, /"result" varchar\(8\) NOT NULL/);
  assert.match(
    results,
    /guest_practice_results_game_match_unique"\s*\n?\s*UNIQUE \("game_key", "match_id"\)/,
  );
  assert.match(results, /CHECK \("result" IN \('win', 'loss', 'draw'\)\)/);
  assert.match(results, /CREATE INDEX IF NOT EXISTS "guest_practice_results_guest_idx"/);
  assert.match(results, /\("guest_id", "created_at" DESC\)/);

  // Additive only: no destructive DDL anywhere in either file.
  for (const sqlText of [profiles, results]) {
    assert.doesNotMatch(sqlText, /DROP\s+(TABLE|COLUMN|INDEX)/i);
    assert.doesNotMatch(sqlText, /ALTER\s+TABLE/i);
    assert.doesNotMatch(sqlText, /TRUNCATE|DELETE\s+FROM/i);
  }

  // Schema mirrors the DDL.
  const schema = read("src/db/schema.ts");
  assert.match(schema, /export const guestProfiles = pgTable\(\s*"guest_profiles"/);
  assert.match(schema, /export const guestPracticeResults = pgTable\(\s*"guest_practice_results"/);
  assert.match(schema, /guest_practice_results_game_match_unique/);
  assert.match(schema, /guest_practice_results_result_valid/);
  assert.match(schema, /guest_practice_results_guest_idx/);
});

test("both migrations are registered with monotonic journal timestamps", () => {
  const journal = JSON.parse(read("src/db/migrations/meta/_journal.json"));
  const entries = journal.entries;

  for (const tag of ["0239_guest_profiles", "0240_guest_practice_results"]) {
    const entry = entries.find((candidate) => candidate.tag === tag);
    assert.ok(entry, `${tag} must be in _journal.json or db:migrate skips it`);
    assert.equal(entry.idx, entries.indexOf(entry), `${tag}'s idx must be its position`);
    assert.equal(entry.version, "7");
    assert.equal(entry.breakpoints, true);

    const maxPriorWhen = Math.max(
      ...entries.filter((other) => other.idx < entry.idx).map((other) => other.when),
    );
    assert.ok(
      entry.when > maxPriorWhen,
      `${tag} must be newer than every migration before it`,
    );

    assert.ok(
      fs.existsSync(path.join(process.cwd(), "src/db/migrations", `${tag}.sql`)),
      `${tag}.sql must exist`,
    );
  }

  // Order matters: the results table references guest_profiles.
  const profilesIdx = entries.find((e) => e.tag === "0239_guest_profiles").idx;
  const resultsIdx = entries.find((e) => e.tag === "0240_guest_practice_results").idx;
  assert.ok(resultsIdx > profilesIdx, "guest_practice_results must migrate after guest_profiles");

  for (let i = 1; i < entries.length; i += 1) {
    assert.equal(entries[i].idx, i, "journal idx must be contiguous");
  }
});

// ── 8. Dominoes (Phase 2C) ──────────────────────────────────────────────────

test("dominoes is on the closed allowlist and stores a win, a loss and a draw", async (t) => {
  reset();
  installMocks(t);
  const {
    recordGuestPracticeResult,
    GUEST_PRACTICE_DOMINOES_GAME_KEY,
    GUEST_PRACTICE_GAME_KEYS,
  } = await progressStore();

  assert.equal(GUEST_PRACTICE_DOMINOES_GAME_KEY, "dominoes");
  // Phase 2D appended battleship and Phase 2E odds; the list stays closed and
  // ordered.
  assert.deepEqual([...GUEST_PRACTICE_GAME_KEYS], [
    "tic-tac-toe",
    "dominoes",
    "battleship",
    "odds",
  ]);

  for (const [result, matchId] of [
    ["win", MATCH_1],
    ["loss", MATCH_2],
    ["draw", MATCH_3],
  ]) {
    assert.equal(
      await recordGuestPracticeResult(fake.tx, {
        guestId: GUEST_A,
        gameKey: "dominoes",
        matchId,
        result,
        aiDifficulty: "hard",
      }),
      true,
    );
  }

  assert.deepEqual(
    fake.state.results.map((row) => [row.gameKey, row.result, row.aiDifficulty]),
    [
      ["dominoes", "win", "hard"],
      ["dominoes", "loss", "hard"],
      ["dominoes", "draw", "hard"],
    ],
  );
});

test("a duplicated dominoes settlement cannot rewrite the outcome", async (t) => {
  reset();
  installMocks(t);
  const { recordGuestPracticeResult } = await progressStore();

  const first = await recordGuestPracticeResult(fake.tx, {
    guestId: GUEST_A,
    gameKey: "dominoes",
    matchId: MATCH_1,
    result: "win",
  });
  const retry = await recordGuestPracticeResult(fake.tx, {
    guestId: GUEST_A,
    gameKey: "dominoes",
    matchId: MATCH_1,
    result: "loss",
  });

  assert.equal(first, true);
  assert.equal(retry, true);
  assert.equal(fake.state.results.length, 1);
  assert.equal(fake.state.results[0].result, "win");
  assert.equal(fake.state.profiles.size, 1);
});

test("a non-guest seat or an unlisted game writes no dominoes result", async (t) => {
  reset();
  installMocks(t);
  const { recordGuestPracticeResult, recordGuestPracticeResultSafely } =
    await progressStore();

  for (const guestId of [CLERK_USER, DOMINOES_BOT, "guest_", ""]) {
    assert.equal(
      await recordGuestPracticeResult(fake.tx, {
        guestId,
        gameKey: "dominoes",
        matchId: MATCH_1,
        result: "win",
      }),
      false,
    );
    assert.equal(
      await recordGuestPracticeResultSafely(fake.tx, {
        guestId,
        gameKey: "dominoes",
        matchId: MATCH_1,
        result: "win",
      }),
      false,
    );
  }

  // A game still outside the closed list writes nothing.
  assert.equal(
    await recordGuestPracticeResult(fake.tx, {
      guestId: GUEST_A,
      gameKey: "checkers",
      matchId: MATCH_1,
      result: "win",
    }),
    false,
  );
  assert.deepEqual(fake.state.inserts, []);
});

test("a settled dominoes result maps onto the guest's own seat", async (t) => {
  reset();
  installMocks(t);
  const { practiceOutcomeForSeat } = await import("../src/lib/dominoes/serverStore.ts");

  assert.equal(practiceOutcomeForSeat("player1", "player1"), "win");
  assert.equal(practiceOutcomeForSeat("player1", "player2"), "loss");
  assert.equal(practiceOutcomeForSeat("player2", "player2"), "win");
  assert.equal(practiceOutcomeForSeat("player2", "player1"), "loss");
  assert.equal(practiceOutcomeForSeat("draw", "player1"), "draw");
  assert.equal(practiceOutcomeForSeat("draw", "player2"), "draw");
  // An unknown or absent result is never recorded as a draw.
  assert.equal(practiceOutcomeForSeat(null, "player1"), null);
  assert.equal(practiceOutcomeForSeat("player3", "player2"), null);
});

test("guest A cannot read guest B's dominoes progress", async (t) => {
  reset();
  installMocks(t);
  const { recordGuestPracticeResult, loadGuestProgress } = await progressStore();

  await recordGuestPracticeResult(fake.tx, {
    guestId: GUEST_A,
    gameKey: "dominoes",
    matchId: MATCH_1,
    result: "win",
  });
  await recordGuestPracticeResult(fake.tx, {
    guestId: GUEST_B,
    gameKey: "dominoes",
    matchId: MATCH_2,
    result: "loss",
  });

  const a = await loadGuestProgress(GUEST_A);
  assert.equal(a.totals.matches, 1);
  assert.equal(a.totals.wins, 1);
  assert.equal(a.games[0].gameKey, "dominoes");
  assert.equal(a.history.length, 1);

  const b = await loadGuestProgress(GUEST_B);
  assert.equal(b.totals.matches, 1);
  assert.equal(b.totals.losses, 1);
  assert.equal(b.games[0].gameKey, "dominoes");
});

test("a dominoes guest write failure is contained by the safe writer", async (t) => {
  reset();
  installMocks(t);
  const { recordGuestPracticeResultSafely } = await progressStore();

  const brokenTx = {
    insert() {
      return {
        values() {
          throw new Error("relation does not exist");
        },
      };
    },
  };

  assert.equal(
    await recordGuestPracticeResultSafely(brokenTx, {
      guestId: GUEST_A,
      gameKey: "dominoes",
      matchId: MATCH_1,
      result: "win",
    }),
    false,
  );
  assert.equal(fake.state.results.length, 0);
});

test("the dominoes settlement records the guest's own AI outcome inside the transaction", () => {
  const src = read("src/lib/dominoes/serverStore.ts");

  // Still the one practice branch, with the pre-existing daily-reward marker.
  assert.match(src, /if \(match\.isAi\) \{/);
  assert.match(src, /await markDailyRewardWin\(tx, winnerId\)\.catch\(\(\) => \{\}\);/);

  // The guest id comes from the LOCKED row's seats — never from a request.
  assert.match(src, /const guestId = \[match\.player1Id, match\.player2Id\]\.find\(/);
  assert.match(src, /isGuestId\(id\)/);
  assert.match(
    src,
    /const guestSeat: Seat = match\.player1Id === guestId \? SEATS\[0\] : SEATS\[1\];/,
  );
  assert.match(src, /await recordGuestPracticeResultSafely\(tx, \{/);
  assert.match(src, /gameKey: GUEST_PRACTICE_DOMINOES_GAME_KEY,/);
  assert.match(src, /matchId: String\(match\.id\),/);
  assert.match(src, /result: practiceResult,/);
  assert.match(src, /aiDifficulty: match\.aiDifficulty,/);
  assert.doesNotMatch(
    src,
    /recordGuestPracticeResultSafely\(tx, \{\s*guestId: (?:body|req|request)/,
  );

  // Inside the AI branch, ahead of the rated path it returns before.
  assert.ok(
    src.indexOf("recordGuestPracticeResultSafely(tx, {") <
      src.indexOf("await applyRatingResult({"),
    "the guest write must sit in the AI branch, before the rated path",
  );
  // The rated call sites are unchanged: still exactly four `dominoes` literals.
  assert.equal((src.match(/gameKey: "dominoes",/g) ?? []).length, 4);
  // The seeding outcome is mapped, not guessed, and only a known one is written.
  assert.match(src, /practiceOutcomeForSeat\(outcome\.result, guestSeat\)/);
  assert.match(src, /if \(practiceResult\) \{/);
});

// ── 9. Battleship (Phase 2D) ────────────────────────────────────────────────

// The store's own function bodies, so settlement wiring is checked where it
// lives instead of with a file-wide grep a comment could satisfy.
function functionSource(src, signature) {
  const start = src.indexOf(signature);
  assert.ok(start >= 0, `${signature} must exist`);
  const rest = src.slice(start + signature.length);
  const end = rest.search(/\n(?:export )?(?:async )?function |\n\/\/ ──/);
  return end === -1 ? rest : rest.slice(0, end);
}

test("battleship is on the closed allowlist and stores a win, a loss and a draw", async (t) => {
  reset();
  installMocks(t);
  const {
    recordGuestPracticeResult,
    GUEST_PRACTICE_BATTLESHIP_GAME_KEY,
  } = await progressStore();

  assert.equal(GUEST_PRACTICE_BATTLESHIP_GAME_KEY, "battleship");

  for (const [result, matchId] of [
    ["win", MATCH_1],
    ["loss", MATCH_2],
    ["draw", MATCH_3],
  ]) {
    assert.equal(
      await recordGuestPracticeResult(fake.tx, {
        guestId: GUEST_A,
        gameKey: "battleship",
        matchId,
        result,
        aiDifficulty: "normal",
      }),
      true,
    );
  }

  assert.deepEqual(
    fake.state.results.map((row) => [row.gameKey, row.result, row.aiDifficulty]),
    [
      ["battleship", "win", "normal"],
      ["battleship", "loss", "normal"],
      ["battleship", "draw", "normal"],
    ],
  );
});

test("a settled battleship winner maps onto the guest's own seat", async () => {
  reset();
  installMocks();
  const { practiceOutcomeForSeat } = await import("../src/lib/battleship/serverStore.ts");

  assert.equal(practiceOutcomeForSeat("player1", "player1"), "win");
  assert.equal(practiceOutcomeForSeat("player1", "player2"), "loss");
  assert.equal(practiceOutcomeForSeat("player2", "player2"), "win");
  assert.equal(practiceOutcomeForSeat("player2", "player1"), "loss");
  // `null` is the store's own draw; an unknown seat is never a draw.
  assert.equal(practiceOutcomeForSeat(null, "player1"), "draw");
  assert.equal(practiceOutcomeForSeat(null, "player2"), "draw");
  assert.equal(practiceOutcomeForSeat("player3", "player1"), null);
  assert.equal(practiceOutcomeForSeat("draw", "player1"), null);
});

test("a guest battleship match is recorded from the locked row, exactly once", async (t) => {
  reset();
  installMocks(t);
  const { settleGuestPracticeTx } = await import("../src/lib/battleship/serverStore.ts");
  const row = {
    id: MATCH_1,
    player1Id: GUEST_A,
    player2Id: BATTLESHIP_BOT,
    aiDifficulty: "hard",
  };

  // The guest occupied seat 1 and the engine named seat 1 the winner.
  await settleGuestPracticeTx(fake.tx, row, "player1");
  // A duplicated completion (a retry, or a sweep after a live request) cannot
  // rewrite the recorded outcome …
  await settleGuestPracticeTx(fake.tx, row, "player2");
  assert.equal(fake.state.results.length, 1);
  assert.equal(fake.state.results[0].result, "win");

  // … while a loss and the engine's mutual-destruction draw are other matches.
  await settleGuestPracticeTx(fake.tx, { ...row, id: MATCH_2 }, "player2");
  await settleGuestPracticeTx(fake.tx, { ...row, id: MATCH_3 }, null);

  assert.deepEqual(
    fake.state.results.map((stored) => [stored.gameKey, stored.matchId, stored.result]),
    [
      ["battleship", MATCH_1, "win"],
      ["battleship", MATCH_2, "loss"],
      ["battleship", MATCH_3, "draw"],
    ],
  );
  assert.equal(fake.state.profiles.size, 1, "one profile for the guest, not one per match");
});

test("a registered seat, a bot-only row or an unfinished result writes nothing", async (t) => {
  reset();
  installMocks(t);
  const { settleGuestPracticeTx } = await import("../src/lib/battleship/serverStore.ts");

  const base = { id: MATCH_1, aiDifficulty: "hard" };

  // Registered-user regression: an account's practice match keeps its behaviour
  // (no guest row, and no rating or trophy on the way).
  await settleGuestPracticeTx(
    fake.tx,
    { ...base, player1Id: CLERK_USER, player2Id: BATTLESHIP_BOT },
    "player1",
  );
  // Neither seat is a guest.
  await settleGuestPracticeTx(
    fake.tx,
    { ...base, player1Id: BATTLESHIP_BOT, player2Id: BATTLESHIP_BOT },
    "player1",
  );
  // No decisive verdict (an unfinished match) is never recorded as a draw.
  await settleGuestPracticeTx(
    fake.tx,
    { ...base, player1Id: GUEST_A, player2Id: BATTLESHIP_BOT },
    "player3",
  );

  assert.deepEqual(fake.state.inserts, []);
  assert.equal(fake.state.results.length, 0);
  assert.deepEqual(ratingCalls, []);
  assert.deepEqual(trophyCalls, []);
});

test("guest A cannot read guest B's battleship progress", async (t) => {
  reset();
  installMocks(t);
  const { recordGuestPracticeResult, loadGuestProgress } = await progressStore();

  await recordGuestPracticeResult(fake.tx, {
    guestId: GUEST_A,
    gameKey: "battleship",
    matchId: MATCH_1,
    result: "win",
  });
  await recordGuestPracticeResult(fake.tx, {
    guestId: GUEST_B,
    gameKey: "battleship",
    matchId: MATCH_2,
    result: "loss",
  });

  const a = await loadGuestProgress(GUEST_A);
  assert.deepEqual(a.totals, { matches: 1, wins: 1, losses: 0, draws: 0 });
  assert.equal(a.games[0].gameKey, "battleship");

  const b = await loadGuestProgress(GUEST_B);
  assert.deepEqual(b.totals, { matches: 1, wins: 0, losses: 1, draws: 0 });
  assert.equal(b.games[0].gameKey, "battleship");
});

test("a battleship guest write failure cannot fail the settlement", async (t) => {
  reset();
  installMocks(t);
  const { settleGuestPracticeTx } = await import("../src/lib/battleship/serverStore.ts");

  const brokenTx = {
    insert() {
      return {
        values() {
          throw new Error("relation does not exist");
        },
      };
    },
  };

  await assert.doesNotReject(
    settleGuestPracticeTx(
      brokenTx,
      { id: MATCH_1, player1Id: GUEST_A, player2Id: BATTLESHIP_BOT, aiDifficulty: "hard" },
      "player1",
    ),
  );
  assert.equal(fake.state.results.length, 0);
});

test("every battleship completion path settles through the one guest funnel", () => {
  const src = read("src/lib/battleship/serverStore.ts");

  // The practice branch runs the guest write and returns before the rated path.
  assert.match(
    src,
    /if \(row\.isAi\) \{[\s\S]{0,160}?await settleGuestPracticeTx\(tx, row, winnerSeat\);\s*return;/,
  );

  const settle = functionSource(src, "async function settleRatedMatchTx(");
  assert.match(settle, /if \(row\.isAi\)/);
  assert.match(settle, /settleGuestPracticeTx\(tx, row, winnerSeat\)/);
  assert.match(settle, /await applyRatingResult\(\{/);
  assert.match(settle, /await applyTrophyResult\(\{/);
  // Exactly the two rated writers still carry the canonical game key.
  assert.equal((src.match(/gameKey: "battleship",/g) ?? []).length, 2);

  // Played finish (engine), timeout/abandonment forfeit and the both-seats-
  // timeout draw all reach that funnel — no terminal path settles on its own.
  assert.match(
    functionSource(src, "async function resolveLockedRoundTx("),
    /await settleRatedMatchTx\(tx, updated, resolution\.state\.winner\);/,
  );
  assert.match(
    functionSource(src, "async function finishMatchTx("),
    /await settleRatedMatchTx\(tx, updated, winnerSeat\);/,
  );
  assert.match(
    functionSource(src, "async function drawMatchTx("),
    /await settleRatedMatchTx\(tx, updated, null\);/,
  );
  // The durable sweep and the realtime abandonment path settle through those.
  const due = functionSource(src, "export async function resolveDueTimeouts(");
  assert.match(due, /finishMatchTx\(tx, row, winner, "timeout_forfeit", now\)/);
  assert.match(due, /drawMatchTx\(tx, row, "timeout_forfeit", now\)/);
  assert.match(
    functionSource(src, "export async function forfeitMatchOnDisconnect("),
    /finishMatchTx\(tx, row, winner, "abandoned", now\)/,
  );
  // A cancelled lobby is not a completed match, so it writes no practice result.
  const cancel = functionSource(src, "async function cancelLobbyTx(");
  assert.doesNotMatch(cancel, /settleRatedMatchTx|settleGuestPracticeTx/);

  // The guest helper reads only the locked row and the store's own verdict: no
  // request-derived identity, winner or board can reach it.
  const guestFn = functionSource(src, "export async function settleGuestPracticeTx(");
  assert.match(guestFn, /const guestId = \[row\.player1Id, row\.player2Id\]\.find\(/);
  assert.match(guestFn, /isGuestId\(id\)/);
  assert.match(guestFn, /gameKey: GUEST_PRACTICE_BATTLESHIP_GAME_KEY,/);
  assert.match(guestFn, /matchId: String\(row\.id\),/);
  assert.match(guestFn, /result: practiceResult,/);
  assert.match(guestFn, /aiDifficulty: row\.aiDifficulty,/);
  const guestCode = guestFn
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(guestCode, /\b(?:body|req|request|searchParams|winnerId)\b/);
});

// ── 10. Odds (Phase 2E) ─────────────────────────────────────────────────────

const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("odds is on the closed allowlist and stores a win, a loss and a draw", async (t) => {
  reset();
  installMocks(t);
  const {
    recordGuestPracticeResult,
    GUEST_PRACTICE_ODDS_GAME_KEY,
    GUEST_PRACTICE_GAME_KEYS,
  } = await progressStore();

  assert.equal(GUEST_PRACTICE_ODDS_GAME_KEY, "odds");
  assert.deepEqual([...GUEST_PRACTICE_GAME_KEYS], [
    "tic-tac-toe",
    "dominoes",
    "battleship",
    "odds",
  ]);

  for (const [result, matchId] of [
    ["win", MATCH_1],
    ["loss", MATCH_2],
    ["draw", MATCH_3],
  ]) {
    assert.equal(
      await recordGuestPracticeResult(fake.tx, {
        guestId: GUEST_A,
        gameKey: "odds",
        matchId,
        result,
        aiDifficulty: "hard",
      }),
      true,
    );
  }

  assert.deepEqual(
    fake.state.results.map((row) => [row.gameKey, row.result]),
    [
      ["odds", "win"],
      ["odds", "loss"],
      ["odds", "draw"],
    ],
  );
});

test("an odds duel is recorded only from the server's finished verdict", async (t) => {
  reset();
  installMocks(t);
  const { oddsPracticeOutcomeForGuest, settleGuestOddsPracticeTx } = await import(
    "../src/lib/odds/guestSettlement.ts"
  );

  const row = { id: 61, player1Id: GUEST_A, isAi: true, aiDifficulty: "hard" };

  assert.equal(
    oddsPracticeOutcomeForGuest({ gameOver: true, winner: "player1" }, row),
    "win",
  );
  assert.equal(
    oddsPracticeOutcomeForGuest({ gameOver: true, winner: "player2" }, row),
    "loss",
  );
  // `null` is the engine's exact tie, and only a FINISHED state makes it a draw.
  assert.equal(oddsPracticeOutcomeForGuest({ gameOver: true, winner: null }, row), "draw");
  assert.equal(
    oddsPracticeOutcomeForGuest({ gameOver: false, winner: "player1" }, row),
    null,
  );
  assert.equal(oddsPracticeOutcomeForGuest({ gameOver: true }, row), null);
  assert.equal(oddsPracticeOutcomeForGuest(null, row), null);
  // A non-AI row and an account seat are never guest practice evidence.
  assert.equal(
    oddsPracticeOutcomeForGuest(
      { gameOver: true, winner: "player1" },
      { ...row, isAi: false },
    ),
    null,
  );
  assert.equal(
    oddsPracticeOutcomeForGuest(
      { gameOver: true, winner: "player1" },
      { ...row, player1Id: CLERK_USER },
    ),
    null,
  );

  await settleGuestOddsPracticeTx(fake.tx, row, { gameOver: true, winner: "player1" });
  // The client's `/ai/end` after `/ai/pick` already finished the duel is a
  // no-op, and a contradicting retry cannot rewrite the stored result.
  await settleGuestOddsPracticeTx(fake.tx, row, { gameOver: true, winner: "player2" });

  assert.deepEqual(
    fake.state.results.map((stored) => [stored.gameKey, stored.matchId, stored.result]),
    [["odds", "61", "win"]],
  );
  assert.equal(fake.state.profiles.size, 1);
});

test("a guest odds settlement failure cannot fail the duel", async (t) => {
  reset();
  installMocks(t);
  const { settleGuestOddsPracticeTx } = await import("../src/lib/odds/guestSettlement.ts");

  const brokenTx = {
    insert() {
      return {
        values() {
          throw new Error("relation does not exist");
        },
      };
    },
  };

  await assert.doesNotReject(
    settleGuestOddsPracticeTx(
      brokenTx,
      { id: 62, player1Id: GUEST_A, isAi: true, aiDifficulty: "hard" },
      { gameOver: true, winner: "player1" },
    ),
  );
  assert.equal(fake.state.results.length, 0);
});

test("guest A cannot read guest B's odds progress", async (t) => {
  reset();
  installMocks(t);
  const { recordGuestPracticeResult, loadGuestProgress } = await progressStore();

  await recordGuestPracticeResult(fake.tx, {
    guestId: GUEST_A,
    gameKey: "odds",
    matchId: MATCH_1,
    result: "win",
  });
  await recordGuestPracticeResult(fake.tx, {
    guestId: GUEST_B,
    gameKey: "odds",
    matchId: MATCH_2,
    result: "loss",
  });

  const a = await loadGuestProgress(GUEST_A);
  assert.deepEqual(a.totals, { matches: 1, wins: 1, losses: 0, draws: 0 });
  assert.equal(a.games[0].gameKey, "odds");

  const b = await loadGuestProgress(GUEST_B);
  assert.deepEqual(b.totals, { matches: 1, wins: 0, losses: 1, draws: 0 });
  assert.equal(b.games[0].gameKey, "odds");
});

test("every odds AI route resolves a guest seat and settles from stored state", () => {
  const routes = [
    "src/app/api/odds/ai/start/route.ts",
    "src/app/api/odds/ai/pick/route.ts",
    "src/app/api/odds/ai/end/route.ts",
    "src/app/api/odds/ai/status/route.ts",
    "src/app/api/odds/ai/leave/route.ts",
  ];
  for (const file of routes) {
    const route = stripComments(read(file));
    assert.match(route, /requirePracticePlayer\(/, `${file} must use the practice gate`);
    assert.match(route, /const userId = gate\.playerId/, `${file} must seat the gate identity`);
    // The dead gate Phase 2E removes: `auth()` after `requirePracticePlayer()`
    // rejected every guest the practice gate had just accepted.
    assert.doesNotMatch(route, /await auth\(\)/, `${file} must not re-check Clerk identity`);
    assert.doesNotMatch(route, /body\??\.(userId|clerkId|playerId)\b/);
  }

  assert.match(
    stripComments(read("src/app/api/odds/ai/pick/route.ts")),
    /await settleGuestOddsPracticeTx\(tx, game, updatedState\)/,
  );
  assert.match(
    stripComments(read("src/app/api/odds/ai/end/route.ts")),
    /await settleGuestOddsPracticeTx\(tx, game, finalState\)/,
  );
  // Creating and abandoning a duel are not completed matches.
  assert.doesNotMatch(
    stripComments(read("src/app/api/odds/ai/start/route.ts")),
    /settleGuestOddsPracticeTx/,
  );
  assert.doesNotMatch(
    stripComments(read("src/app/api/odds/ai/leave/route.ts")),
    /settleGuestOddsPracticeTx/,
  );

  // The recorded verdict is the SERVER's state, and the helper reads no request.
  const guestSrc = stripComments(read("src/lib/odds/guestSettlement.ts"));
  assert.match(guestSrc, /state\.winner/);
  assert.match(guestSrc, /state\.gameOver !== true/);
  assert.match(guestSrc, /gameKey: GUEST_PRACTICE_ODDS_GAME_KEY,/);
  assert.match(guestSrc, /matchId: String\(row\.id\),/);
  assert.match(guestSrc, /aiDifficulty: row\.aiDifficulty,/);
  assert.doesNotMatch(guestSrc, /\b(?:body|req|request|searchParams|winnerId)\b/);
  // No ladder or economy writer may be reached from a guest practice result.
  assert.doesNotMatch(
    guestSrc,
    /applyRatingResult|applyTrophyResult|escrowMatchWagers|settlePayout|markDailyRewardWin/,
  );
});
