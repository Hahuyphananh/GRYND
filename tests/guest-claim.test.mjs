// tests/guest-claim.test.mjs
//
// Phase 4 — GUEST → ACCOUNT CONVERSION.
//
// What is under test, in one line: a signed-in account can atomically link the
// practice record held by this browser's HMAC-signed guest cookie, exactly once,
// without any guest row being rewritten and without a single rated result,
// trophy, coin, wager or statistic being granted.
//
// The REAL modules run against an in-memory fake of the three guest tables and
// a mocked Clerk session + cookie jar, so the SQL shapes the claim writer asks
// for (the FOR UPDATE profile lock, the claim lookups, the single insert) and
// the route's actual status codes are what is asserted.
//
// Run: npm run test:guest-claim

import test, { mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { guestClaims, guestPracticeResults, guestProfiles } from "../src/db/schema.ts";

const read = (rel) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const CLERK_SERVER_CJS = pathToFileURL(
  createRequire(import.meta.url).resolve("@clerk/nextjs/server"),
).href;

const GUEST_A = "guest_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const GUEST_B = "guest_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const ACCOUNT_A = "user_claim_account_a";
const ACCOUNT_B = "user_claim_account_b";
const MATCH_1 = "11111111-1111-4111-8111-111111111111";
const MATCH_2 = "22222222-2222-4222-8222-222222222222";

// ── Fake database ───────────────────────────────────────────────────────────

let fake;
const jar = new Map();
const request = { userId: null };

function createFakeDb() {
  const state = {
    profiles: new Map(),
    results: [],
    claims: new Map(),
    insertedTables: [],
    selects: [],
    forUpdates: 0,
    failNextInsert: false,
  };

  const collectValues = (node, out = [], seen = new Set()) => {
    if (!node || typeof node !== "object" || seen.has(node)) return out;
    seen.add(node);
    if (typeof node.value === "string" || typeof node.value === "number") {
      out.push(node.value);
    }
    for (const key of Object.keys(node)) collectValues(node[key], out, seen);
    return out;
  };

  const rowsFor = (chain) => {
    const values = chain.values;

    if (chain.table === guestProfiles) {
      const guestId = values.find((v) => typeof v === "string" && v.startsWith("guest_"));
      return state.profiles.has(guestId) ? [{ guestId }] : [];
    }

    if (chain.table === guestClaims) {
      const claim = [...state.claims.values()].find(
        (row) => values.includes(row.guestId) || values.includes(row.claimedByUserId),
      );
      return claim ? [{ ...claim }] : [];
    }

    if (chain.table === guestPracticeResults) {
      const guestId = values.find((v) => typeof v === "string" && v.startsWith("guest_"));
      const rows = state.results.filter((row) => row.guestId === guestId);
      if (!chain.grouped) return rows;

      const counts = new Map();
      for (const row of rows) {
        counts.set(row.result, (counts.get(row.result) ?? 0) + 1);
      }
      return [...counts.entries()].map(([result, count]) => ({ result, count }));
    }

    throw new Error(`fake db: unexpected table ${String(chain.table)}`);
  };

  const select = () => {
    const chain = {
      table: null,
      values: [],
      grouped: false,
      from(table) {
        chain.table = table;
        return chain;
      },
      where(condition) {
        chain.values = collectValues(condition);
        return chain;
      },
      groupBy() {
        chain.grouped = true;
        return chain;
      },
      limit() {
        return chain;
      },
      for() {
        state.forUpdates += 1;
        return chain;
      },
      then(resolve, reject) {
        try {
          resolve(rowsFor(chain));
        } catch (error) {
          reject(error);
        }
      },
    };
    state.selects.push(chain);
    return chain;
  };

  const insert = (table) => ({
    async values(values) {
      state.insertedTables.push(table);

      if (state.failNextInsert) {
        state.failNextInsert = false;
        throw new Error("simulated transaction failure");
      }

      if (table !== guestClaims) {
        throw new Error("claim writer must only insert into guest_claims");
      }

      const unique = Object.assign(new Error("duplicate key value"), { code: "23505" });
      if (state.claims.has(values.guestId)) throw unique;
      if ([...state.claims.values()].some((row) => row.claimedByUserId === values.claimedByUserId)) {
        throw unique;
      }

      state.claims.set(values.guestId, { ...values });
    },
  });

  const snapshot = () => ({
    claims: new Map(state.claims),
    results: state.results.map((row) => ({ ...row })),
    profiles: new Map(state.profiles),
  });

  const restore = (saved) => {
    state.claims = saved.claims;
    state.results = saved.results;
    state.profiles = saved.profiles;
  };

  const db = {
    select,
    insert,
    async transaction(callback) {
      const saved = snapshot();
      try {
        return await callback(db);
      } catch (error) {
        restore(saved);
        throw error;
      }
    },
  };

  return { state, db };
}

// ONE stable db object for the process: dynamically imported app modules cache
// their imports, so the mock must read the mutable `fake` through this proxy.
const stableDb = {
  select: (...args) => fake.db.select(...args),
  insert: (...args) => fake.db.insert(...args),
  transaction: (...args) => fake.db.transaction(...args),
};

let mocksInstalled = false;

function installMocks() {
  if (mocksInstalled) return;
  mocksInstalled = true;

  mock.module("next/headers", {
    namedExports: {
      cookies: async () => ({
        get: (name) => (jar.has(name) ? { name, value: jar.get(name) } : undefined),
        set: (name, value) => jar.set(name, value),
      }),
      headers: async () => new Headers({ host: "grynd.test", "x-forwarded-proto": "https" }),
    },
  });

  const clerkServer = { namedExports: { auth: async () => ({ userId: request.userId }) } };
  mock.module("@clerk/nextjs/server", clerkServer);
  mock.module(CLERK_SERVER_CJS, clerkServer);

  mock.module("../src/db/client.ts", { namedExports: { db: stableDb } });

  // Deterministic limiter; the real one is exercised by its own tests.
  mock.module("../src/lib/security/rateLimit.ts", {
    namedExports: {
      consumeRateLimit: async () => ({ allowed: true, resetAt: Date.now() + 60_000 }),
    },
  });
}

installMocks();

const guestSession = () => import("../src/lib/auth/guestSession.ts");
const claimModule = () => import("../src/lib/guest/claim.ts");
const claimRoute = () => import("../src/app/api/guest/claim/route.ts");

async function cookieFor(guestId) {
  const { serializeGuestCookie } = await guestSession();
  return serializeGuestCookie(guestId);
}

function seedGuest(guestId, results = []) {
  fake.state.profiles.set(guestId, { createdAt: new Date(), lastSeenAt: new Date() });
  results.forEach((result, index) => {
    fake.state.results.push({
      id: fake.state.results.length + 1,
      guestId,
      gameKey: "tic-tac-toe",
      matchId: index === 0 ? MATCH_1 : MATCH_2,
      result,
      aiDifficulty: "normal",
      createdAt: new Date(),
    });
  });
}

function reset({ userId = null, cookie = null } = {}) {
  fake = createFakeDb();
  jar.clear();
  request.userId = userId;
  if (cookie) jar.set("grynd_guest", cookie);
}

async function signedInAs(userId, guestId) {
  reset({ userId });
  if (guestId) jar.set("grynd_guest", await cookieFor(guestId));
}

// ── 1. Identity validation ──────────────────────────────────────────────────

test("only a Clerk id and an HMAC guest id can start a claim", async () => {
  reset();
  const { isClerkUserId, claimGuestProgression, getClaimState } = await claimModule();

  assert.equal(isClerkUserId(ACCOUNT_A), true);
  for (const value of [GUEST_A, "user_", "", null, 42, "user_has space", "guest_" + "a".repeat(32)]) {
    assert.equal(isClerkUserId(value), false, `${String(value)} is not a Clerk id`);
  }

  for (const [userId, guestId] of [
    [GUEST_A, GUEST_B],
    [ACCOUNT_A, ACCOUNT_B.replace("claim", "guest")],
    [ACCOUNT_A, "guest_"],
    [null, GUEST_A],
    [ACCOUNT_A, null],
  ]) {
    const before = fake.state.insertedTables.length;
    assert.equal((await claimGuestProgression({ userId, guestId })).status, "invalid_identity");
    assert.equal((await getClaimState({ userId, guestId })).status, "invalid_identity");
    assert.equal(fake.state.insertedTables.length, before, "invalid input writes nothing");
  }
});

// ── 2. The happy path ───────────────────────────────────────────────────────

test("a signed-in account claims the browser's guest record exactly once", async () => {
  await signedInAs(ACCOUNT_A, GUEST_A);
  seedGuest(GUEST_A, ["win", "loss", "win"]);
  const { claimGuestProgression } = await claimModule();

  const first = await claimGuestProgression({ userId: ACCOUNT_A, guestId: GUEST_A });
  assert.equal(first.status, "claimed");
  assert.deepEqual(first.totals, { matches: 3, wins: 2, losses: 1, draws: 0 });
  assert.equal(fake.state.claims.size, 1);

  const claim = fake.state.claims.get(GUEST_A);
  assert.equal(claim.claimedByUserId, ACCOUNT_A);
  assert.equal(claim.matchCount, 3);

  // Idempotent: the same account claiming again is a success, not a new row.
  const retry = await claimGuestProgression({ userId: ACCOUNT_A, guestId: GUEST_A });
  assert.equal(retry.status, "already_claimed");
  assert.equal(fake.state.claims.size, 1);

  // The guest rows and their provenance are untouched.
  assert.deepEqual(
    fake.state.results.map((row) => [row.guestId, row.result]),
    [
      [GUEST_A, "win"],
      [GUEST_A, "loss"],
      [GUEST_A, "win"],
    ],
  );
  // The claim is the ONLY write the operation performed.
  assert.ok(fake.state.insertedTables.every((table) => table === guestClaims));
});

test("a claim does not create account statistics, ratings or rewards", async () => {
  await signedInAs(ACCOUNT_A, GUEST_A);
  seedGuest(GUEST_A, ["win", "win"]);
  const { claimGuestProgression } = await claimModule();

  await claimGuestProgression({ userId: ACCOUNT_A, guestId: GUEST_A });

  // Nothing was written to any table other than guest_claims, and the claim
  // writer imports no ranking, trophy, economy or statistics module.
  assert.deepEqual(
    [...new Set(fake.state.insertedTables)],
    [guestClaims],
    "a claim must only insert the provenance row",
  );

  const src = stripComments(read("src/lib/guest/claim.ts"));
  const imports = src.split("\n").filter((line) => line.trim().startsWith("import ")).join("\n");
  for (const forbidden of [
    "rating",
    "trophyStore",
    "playerRatings",
    "playerTrophies",
    "userStats",
    "tokens",
    "quests",
    "leaderboard",
  ]) {
    assert.doesNotMatch(imports, new RegExp(forbidden), `claim must not import ${forbidden}`);
  }
  assert.doesNotMatch(src, /applyRatingResult\(|applyTrophyResult\(|creditTokens\(/);
  assert.doesNotMatch(src, /insert\(users\)|update\(users\)|insert\(userStats\)/);
});

// ── 3. Duplicate and conflicting claims ─────────────────────────────────────

test("another account can never take over an existing claim", async () => {
  await signedInAs(ACCOUNT_A, GUEST_A);
  seedGuest(GUEST_A, ["win"]);
  const { claimGuestProgression, getClaimState } = await claimModule();

  assert.equal((await claimGuestProgression({ userId: ACCOUNT_A, guestId: GUEST_A })).status, "claimed");

  const stolen = await claimGuestProgression({ userId: ACCOUNT_B, guestId: GUEST_A });
  assert.equal(stolen.status, "guest_already_claimed");
  assert.equal(fake.state.claims.size, 1);
  assert.equal(fake.state.claims.get(GUEST_A).claimedByUserId, ACCOUNT_A);

  // And the status read reveals nothing about the owner or their record.
  const state = await getClaimState({ userId: ACCOUNT_B, guestId: GUEST_A });
  assert.deepEqual(state, { status: "guest_already_claimed" });
  assert.doesNotMatch(JSON.stringify(state), new RegExp(ACCOUNT_A));
  assert.doesNotMatch(JSON.stringify(state), /match|win|loss|draw/i);
});

test("an account can hold only one claimed guest record", async () => {
  const { claimGuestProgression } = await claimModule();

  await signedInAs(ACCOUNT_A, GUEST_A);
  seedGuest(GUEST_A, ["win"]);
  assert.equal((await claimGuestProgression({ userId: ACCOUNT_A, guestId: GUEST_A })).status, "claimed");

  // The same account, now holding a different browser's guest cookie.
  jar.set("grynd_guest", await cookieFor(GUEST_B));
  seedGuest(GUEST_B, ["loss"]);
  const second = await claimGuestProgression({ userId: ACCOUNT_A, guestId: GUEST_B });

  assert.equal(second.status, "account_already_claimed");
  assert.equal(fake.state.claims.size, 1);
  assert.equal(fake.state.claims.has(GUEST_B), false);
});

test("a losing racer sees the winner's claim and never writes a second row", async () => {
  await signedInAs(ACCOUNT_A, GUEST_A);
  seedGuest(GUEST_A, ["win"]);
  const { claimGuestProgression } = await claimModule();

  // The interleaving where ACCOUNT_B's claim committed between this call's read
  // and its insert. Both the FOR UPDATE pre-check and (if that window were
  // narrower) the unique key resolve to the same conflict, never a second row.
  fake.state.claims.set(GUEST_A, {
    guestId: GUEST_A,
    claimedByUserId: ACCOUNT_B,
    claimedAt: new Date(),
    matchCount: 1,
    winCount: 1,
    lossCount: 0,
    drawCount: 0,
  });

  const outcome = await claimGuestProgression({ userId: ACCOUNT_A, guestId: GUEST_A });

  assert.equal(outcome.status, "guest_already_claimed");
  assert.equal(fake.state.claims.get(GUEST_A).claimedByUserId, ACCOUNT_B);
  assert.equal(fake.state.claims.size, 1);
  assert.equal(fake.state.insertedTables.length, 0, "the loser writes nothing");
});

test("the claim writer locks the guest row inside a transaction", () => {
  const src = stripComments(read("src/lib/guest/claim.ts"));
  assert.match(src, /db\.transaction\(/);
  assert.match(src, /\.where\(eq\(guestProfiles\.guestId, guestId\)\)[\s\S]{0,40}?\.for\("update"\)/);
  assert.match(src, /isUniqueViolation/);
  assert.match(src, /code === "23505"/);
});

// ── 4. Nothing to claim, and failure ────────────────────────────────────────

test("a guest without a finished practice match claims nothing", async () => {
  await signedInAs(ACCOUNT_A, GUEST_A);
  const { claimGuestProgression, getClaimState } = await claimModule();

  assert.equal((await getClaimState({ userId: ACCOUNT_A, guestId: GUEST_A })).status, "no_progress");
  assert.deepEqual(await claimGuestProgression({ userId: ACCOUNT_A, guestId: GUEST_A }), {
    status: "no_progress",
  });
  assert.equal(fake.state.claims.size, 0);
  assert.equal(fake.state.profiles.size, 0, "a claim never creates a guest profile");
});

test("a failed transaction rolls back and leaves the guest record claimable", async () => {
  await signedInAs(ACCOUNT_A, GUEST_A);
  seedGuest(GUEST_A, ["win", "loss"]);
  const { claimGuestProgression } = await claimModule();

  fake.state.failNextInsert = true;
  await assert.rejects(() =>
    claimGuestProgression({ userId: ACCOUNT_A, guestId: GUEST_A }),
  );

  assert.equal(fake.state.claims.size, 0, "no partial claim survives");
  assert.deepEqual(
    fake.state.results.map((row) => row.result),
    ["win", "loss"],
    "the original practice rows are untouched",
  );

  // Retry succeeds, which is what the route's error copy promises.
  const retry = await claimGuestProgression({ userId: ACCOUNT_A, guestId: GUEST_A });
  assert.equal(retry.status, "claimed");
  assert.equal(fake.state.claims.size, 1);
});

// ── 5. The endpoint ─────────────────────────────────────────────────────────

test("the claim endpoint requires a signed-in account and a valid guest cookie", async () => {
  const { GET, POST } = await claimRoute();

  reset();
  assert.equal((await GET()).status, 401);
  assert.equal((await POST()).status, 401);

  // Signed in, but no guest cookie at all.
  reset({ userId: ACCOUNT_A });
  assert.equal((await GET()).status, 200);
  assert.equal((await (await GET()).json()).data.status, "no_guest");
  const noCookie = await POST();
  assert.equal(noCookie.status, 401);
  assert.equal((await noCookie.json()).code, "guest_session_required");

  // A forged / invented cookie is not an identity.
  jar.set("grynd_guest", `${GUEST_A}.forged-signature`);
  assert.equal((await POST()).status, 401);
  jar.set("grynd_guest", `guest_nothex.${"A".repeat(43)}`);
  assert.equal((await POST()).status, 401);

  assert.equal(fake.state.claims.size, 0);
});

test("the claim endpoint claims only the cookie's guest, never a body id", async () => {
  await signedInAs(ACCOUNT_A, GUEST_A);
  seedGuest(GUEST_A, ["win"]);
  seedGuest(GUEST_B, ["win", "win", "win"]);
  const { POST } = await claimRoute();

  const response = await POST({
    json: async () => ({ guestId: GUEST_B, userId: ACCOUNT_B }),
    url: `http://grynd.test/api/guest/claim?guestId=${GUEST_B}`,
  });
  const body = await response.json();

  assert.equal(response.status, 201);
  assert.equal(body.data.status, "claimed");
  assert.equal(body.data.totals.matches, 1, "the cookie's one match, not guest B's three");
  assert.equal(fake.state.claims.has(GUEST_A), true);
  assert.equal(fake.state.claims.has(GUEST_B), false);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
});

test("the endpoint reports duplicates, conflicts and failures precisely", async () => {
  await signedInAs(ACCOUNT_A, GUEST_A);
  seedGuest(GUEST_A, ["win", "draw"]);
  const { POST, GET } = await claimRoute();

  const first = await POST();
  assert.equal(first.status, 201);

  jar.set("grynd_guest", await cookieFor(GUEST_A));
  const retry = await POST();
  assert.equal(retry.status, 200, "a retry by the owner is an idempotent success");
  assert.equal((await retry.json()).data.status, "already_claimed");

  // Status read for the owner includes the preserved counts.
  const status = await (await GET()).json();
  assert.equal(status.data.status, "claimed_by_you");
  assert.deepEqual(status.data.totals, { matches: 2, wins: 1, losses: 0, draws: 1 });

  // A different account holding the same cookie gets a conflict and no data.
  request.userId = ACCOUNT_B;
  const conflict = await POST();
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).code, "guest_already_claimed");

  // A storage failure is a retryable 500, not a partial claim.
  request.userId = ACCOUNT_B;
  jar.set("grynd_guest", await cookieFor(GUEST_B));
  seedGuest(GUEST_B, ["win"]);
  fake.state.failNextInsert = true;
  const failed = await POST();
  assert.equal(failed.status, 500);
  assert.equal((await failed.json()).code, "claim_failed");
  assert.equal(fake.state.claims.has(GUEST_B), false);
});

test("the claim route takes no identity from the request", () => {
  const src = stripComments(read("src/app/api/guest/claim/route.ts"));
  assert.match(src, /await auth\(\)/);
  assert.match(src, /await readGuestId\(\)/);
  assert.match(src, /const guestId = await readGuestId\(\)/);
  assert.doesNotMatch(src, /searchParams/);
  assert.doesNotMatch(src, /\.json\(\)/);
  assert.doesNotMatch(src, /headers\(\)/);
  assert.doesNotMatch(src, /\b(?:req|request)\b/);
  assert.doesNotMatch(src, /req\.json|request\.json/);
});

// ── 6. Migration + journal ──────────────────────────────────────────────────

test("the claim migration enforces one guest ↔ one account and is additive", () => {
  const sqlText = read("src/db/migrations/0241_guest_claims.sql");

  assert.match(sqlText, /CREATE TABLE IF NOT EXISTS "guest_claims"/);
  assert.match(sqlText, /"guest_id" varchar\(64\) PRIMARY KEY/);
  assert.match(sqlText, /REFERENCES "guest_profiles" \("guest_id"\) ON DELETE CASCADE/);
  assert.match(sqlText, /REFERENCES "users" \("clerk_id"\) ON DELETE CASCADE/);
  assert.match(sqlText, /CONSTRAINT "guest_claims_one_guest_per_account"\s*\n?\s*UNIQUE \("claimed_by_user_id"\)/);
  assert.match(sqlText, /CONSTRAINT "guest_claims_counts_valid"/);
  assert.match(sqlText, /"win_count" \+ "loss_count" \+ "draw_count" = "match_count"/);

  assert.doesNotMatch(sqlText, /DROP\s+(TABLE|COLUMN|INDEX)/i);
  assert.doesNotMatch(sqlText, /ALTER\s+TABLE/i);
  assert.doesNotMatch(sqlText, /DELETE\s+FROM|TRUNCATE/i);

  const schema = read("src/db/schema.ts");
  assert.match(schema, /export const guestClaims = pgTable\(\s*"guest_claims"/);
  assert.match(schema, /guest_claims_one_guest_per_account/);
  assert.match(schema, /guest_claims_counts_valid/);
});

test("the claim migration is registered after every existing migration", () => {
  const journal = JSON.parse(read("src/db/migrations/meta/_journal.json"));
  const entries = journal.entries;
  const entry = entries.find((candidate) => candidate.tag === "0241_guest_claims");

  assert.ok(entry, "0241_guest_claims must be in _journal.json");
  assert.equal(entry.idx, entries.indexOf(entry));
  assert.equal(entry.version, "7");
  assert.equal(entry.breakpoints, true);
  // The claim migration was appended in order; later additive migrations
  // (0242_platform_sessions) may legitimately follow it.
  assert.ok(entry.idx > 0);
  assert.ok(entry.idx <= entries.length - 1);

  const maxPriorWhen = Math.max(
    ...entries.filter((other) => other.idx < entry.idx).map((other) => other.when),
  );
  assert.ok(entry.when > maxPriorWhen);
  for (let i = 1; i < entries.length; i += 1) assert.equal(entries[i].idx, i);

  assert.ok(
    fs.existsSync(path.join(process.cwd(), "src/db/migrations/0241_guest_claims.sql")),
  );
});

// ── 7. Auth-flow integration ────────────────────────────────────────────────

test("the post-auth flow offers the claim without changing Clerk or onboarding", () => {
  const sync = read("src/app/sync/PageClient.tsx");
  assert.match(sync, /hasClaimableGuestRecord/);
  assert.match(sync, /\/api\/guest\/claim/);
  assert.match(sync, /\/welcome\/claim\?next=/);
  // The existing destination logic is still there, and the claim step only
  // wraps it — onboarding is not skipped or duplicated.
  assert.match(sync, /isNewUser && !\(await hasCompletedOnboarding\(\)\)/);
  assert.match(sync, /"\/welcome\/questionnaire"\s*:\s*"\/"/);

  // Clerk's own signup screen is untouched.
  const signUp = read("src/app/sign-up/[[...sign-up]]/PageClient.jsx");
  assert.match(signUp, /<SignUp/);
  assert.match(signUp, /fallbackRedirectUrl="\/sync"/);

  // The offer page claims with the shared panel and only follows same-site paths.
  const claimPage = read("src/app/welcome/claim/PageClient.tsx");
  assert.match(claimPage, /<GuestClaimPanel/);
  assert.match(claimPage, /startsWith\("\/"\)/);
  assert.match(claimPage, /value\.startsWith\("\/\/"\)/);

  // The account profile offers the same panel; the signed-out panel is untouched.
  const profil = read("src/app/profil/PageClient.jsx");
  assert.match(profil, /import GuestClaimPanel/);
  assert.match(profil, /<GuestClaimPanel \/>/);
  assert.match(profil, /<GuestProgressPanel \/>/);
});
