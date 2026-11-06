// tests/platform-integration.test.mjs
//
// Phase 5 — EXTERNAL PLATFORM INTEGRATION.
//
// Verified here:
//   · only configured platform origins can mint or frame a session;
//   · tokens are opaque, hashed at rest, short-lived, revocable and scoped to
//     one platform + one game + one origin;
//   · the embedded guest identity is server-minted and is NOT the 30-day
//     `grynd_guest` cookie;
//   · `frame-ancestors` is relaxed only for /embed/*, and only to the allowlist;
//   · postMessage origins/envelopes are validated exactly, with no wildcard;
//   · only Tic-Tac-Toe practice routes accept a platform bearer token;
//   · no account/PvP/wallet/claim path accepts a platform token.
//
// Run: npm run test:platform

import test, { mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

import { platformSessions } from "../src/db/schema.ts";

const read = (rel) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");
const strip = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const PLATFORM = "testportal";
const ORIGIN = "https://portal.example";
const SECRET = "s".repeat(40);

process.env.GRYND_PLATFORM_ALLOWLIST = `${PLATFORM}=${ORIGIN}`;
process.env.GRYND_PLATFORM_SECRET_TESTPORTAL = SECRET;

const CLERK_SERVER_CJS = pathToFileURL(
  createRequire(import.meta.url).resolve("@clerk/nextjs/server"),
).href;

// ── Fake database ───────────────────────────────────────────────────────────

let fake;
const request = { authorization: "", userId: null };
const jar = new Map();

function createFakeDb() {
  const state = { sessions: new Map(), inserts: [] };

  const collect = (node, out = [], seen = new Set()) => {
    if (!node || typeof node !== "object" || seen.has(node)) return out;
    seen.add(node);
    if (typeof node.value === "string") out.push(node.value);
    for (const key of Object.keys(node)) collect(node[key], out, seen);
    return out;
  };

  const select = () => {
    const chain = {
      table: null,
      values: [],
      from(table) {
        chain.table = table;
        return chain;
      },
      where(condition) {
        chain.values = collect(condition);
        return chain;
      },
      limit() {
        return chain;
      },
      then(resolve, reject) {
        try {
          if (chain.table !== platformSessions) {
            throw new Error("platform tests: unexpected table read");
          }
          const row = [...state.sessions.values()].find((candidate) =>
            chain.values.includes(candidate.tokenHash),
          );
          resolve(row ? [{ ...row }] : []);
        } catch (error) {
          reject(error);
        }
      },
    };
    return chain;
  };

  const insert = (table) => ({
    async values(values) {
      if (table !== platformSessions) {
        throw new Error("platform tests: unexpected table write");
      }
      state.inserts.push(values);
      state.sessions.set(values.tokenHash, { ...values });
    },
  });

  const update = (table) => ({
    set(patch) {
      return {
        where(condition) {
          const values = collect(condition);
          const row = [...state.sessions.values()].find((candidate) =>
            values.includes(candidate.tokenHash),
          );
          if (row) Object.assign(row, patch);
          return {
            async returning() {
              return row ? [{ tokenHash: row.tokenHash }] : [];
            },
          };
        },
      };
    },
  });

  return { state, db: { select, insert, update } };
}

const stableDb = {
  select: (...args) => fake.db.select(...args),
  insert: (...args) => fake.db.insert(...args),
  update: (...args) => fake.db.update(...args),
};

let mocksInstalled = false;

function installMocks() {
  if (mocksInstalled) return;
  mocksInstalled = true;

  mock.module("next/headers", {
    namedExports: {
      headers: async () => {
        const store = new Headers({ host: "grynd.test", "x-forwarded-proto": "https" });
        if (request.authorization) store.set("authorization", request.authorization);
        return store;
      },
      cookies: async () => ({
        get: (name) => (jar.has(name) ? { name, value: jar.get(name) } : undefined),
        set: (name, value) => jar.set(name, value),
      }),
    },
  });

  const clerkServer = { namedExports: { auth: async () => ({ userId: request.userId }) } };
  mock.module("@clerk/nextjs/server", clerkServer);
  mock.module(CLERK_SERVER_CJS, clerkServer);

  mock.module("../src/lib/auth/requireAgeVerified.ts", {
    namedExports: { requireAgeVerifiedUser: async () => ({ response: null, userId: request.userId }) },
  });

  mock.module("../src/db/client.ts", { namedExports: { db: stableDb } });

  mock.module("../src/lib/security/rateLimit.ts", {
    namedExports: {
      consumeRateLimit: async () => ({ allowed: true, resetAt: Date.now() + 60_000 }),
    },
  });
}

installMocks();

function reset() {
  fake = createFakeDb();
  jar.clear();
  request.authorization = "";
  request.userId = null;
}

const configModule = () => import("../src/lib/platform/config.ts");
const framingModule = () => import("../src/lib/platform/framing.ts");
const messagingModule = () => import("../src/lib/platform/messaging.ts");
const sessionModule = () => import("../src/lib/platform/session.ts");
const mintRoute = () => import("../src/app/api/platform/session/route.ts");
const validateRoute = () => import("../src/app/api/platform/session/validate/route.ts");
const endRoute = () => import("../src/app/api/platform/session/end/route.ts");

function mintRequest(body, secret = SECRET) {
  return new Request("http://grynd.test/api/platform/session", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

// ── 1. Configuration ────────────────────────────────────────────────────────

test("only explicitly configured https origins and secrets are usable", async () => {
  const { parsePlatformAllowlist, normalizePlatformOrigin, getPlatformConfig, getPlatformOrigins } =
    await configModule();

  assert.deepEqual(
    parsePlatformAllowlist("crazygames=https://www.crazygames.com, itch=https://itch.io"),
    [
      { platform: "crazygames", origin: "https://www.crazygames.com" },
      { platform: "itch", origin: "https://itch.io" },
    ],
  );

  for (const bad of [
    "*",
    "https://*.example.com",
    "http://portal.example",
    "https://portal.example/path",
    "https://user:pass@portal.example",
    "not a url",
  ]) {
    assert.equal(normalizePlatformOrigin(bad), null, `${bad} must not be accepted`);
  }

  // No allowlist → no config, no origins.
  assert.equal(getPlatformConfig("testportal", {}), null);
  assert.deepEqual(getPlatformOrigins({}), []);
  // Allowlist without secret → still unusable.
  assert.equal(
    getPlatformConfig("testportal", { GRYND_PLATFORM_ALLOWLIST: `${PLATFORM}=${ORIGIN}` }),
    null,
  );
  // Secret too short → unusable.
  assert.equal(
    getPlatformConfig("testportal", {
      GRYND_PLATFORM_ALLOWLIST: `${PLATFORM}=${ORIGIN}`,
      GRYND_PLATFORM_SECRET_TESTPORTAL: "short",
    }),
    null,
  );
  // An unknown platform is never inferred from the origin.
  assert.equal(
    getPlatformConfig("other", {
      GRYND_PLATFORM_ALLOWLIST: `${PLATFORM}=${ORIGIN}`,
      GRYND_PLATFORM_SECRET_TESTPORTAL: SECRET,
    }),
    null,
  );

  assert.deepEqual(getPlatformOrigins({ GRYND_PLATFORM_ALLOWLIST: `${PLATFORM}=${ORIGIN}` }), [
    ORIGIN,
  ]);
});

// ── 2. Framing / CSP ────────────────────────────────────────────────────────

test("embed framing is narrowed to the allowlist and never wildcarded", async () => {
  const { isEmbedPath, buildFrameAncestors, replaceFrameAncestors, applyEmbedFramePolicy } =
    await framingModule();

  assert.equal(isEmbedPath("/embed/testportal/tic-tac-toe"), true);
  assert.equal(isEmbedPath("/casino/tic-tac-toe"), false);
  assert.equal(isEmbedPath("/embedding"), false);

  assert.equal(buildFrameAncestors([]), "'self'");
  assert.equal(buildFrameAncestors(["*"]), "'self'", "a literal * must never be emitted");
  assert.equal(
    buildFrameAncestors([ORIGIN, ORIGIN, "https://itch.io"]),
    `${ORIGIN} https://itch.io`,
  );

  assert.equal(
    replaceFrameAncestors("default-src 'self'; frame-ancestors 'self'; base-uri 'self';", ORIGIN),
    `default-src 'self'; frame-ancestors ${ORIGIN}; base-uri 'self';`,
  );

  // Standalone response: untouched.
  const standalone = new Headers({
    "X-Frame-Options": "SAMEORIGIN",
    "Content-Security-Policy": "default-src 'self'; frame-ancestors 'self';",
  });
  applyEmbedFramePolicy({ headers: standalone }, "/games/tic-tac-toe/play");
  assert.equal(standalone.get("X-Frame-Options"), "SAMEORIGIN");
  assert.match(standalone.get("Content-Security-Policy"), /frame-ancestors 'self'/);

  // Embed response: XFO removed, ancestors narrowed, nothing else touched.
  const embed = new Headers({
    "X-Frame-Options": "SAMEORIGIN",
    "Content-Security-Policy": "default-src 'self'; frame-ancestors 'self'; base-uri 'self';",
  });
  applyEmbedFramePolicy({ headers: embed }, "/embed/testportal/tic-tac-toe");
  assert.equal(embed.get("X-Frame-Options"), null);
  const csp = embed.get("Content-Security-Policy");
  assert.match(csp, new RegExp(`frame-ancestors ${ORIGIN}`));
  assert.match(csp, /base-uri 'self'/);
  assert.doesNotMatch(csp, /frame-ancestors \*/);

  // No configured platform: the embed is still not externally framable.
  const blocked = new Headers({
    "Content-Security-Policy": "default-src 'self'; frame-ancestors 'self';",
  });
  applyEmbedFramePolicy({ headers: blocked }, "/embed/testportal/tic-tac-toe", {});
  assert.match(blocked.get("Content-Security-Policy"), /frame-ancestors 'self'/);
});

// ── 3. postMessage contract ─────────────────────────────────────────────────

test("postMessage accepts the exact origin and envelope only", async () => {
  const { parsePlatformMessage, buildPlatformMessage, platformTargetOrigin } =
    await messagingModule();

  const good = {
    origin: ORIGIN,
    data: { source: "grynd-platform", version: 1, type: "grynd:start" },
  };
  assert.equal(parsePlatformMessage(good, ORIGIN)?.type, "grynd:start");
  assert.equal(parsePlatformMessage({ ...good, origin: "https://evil.example" }, ORIGIN), null);
  assert.equal(parsePlatformMessage({ ...good, origin: `${ORIGIN}.evil.example` }, ORIGIN), null);
  assert.equal(parsePlatformMessage({ ...good, data: { ...good.data, version: 2 } }, ORIGIN), null);
  assert.equal(parsePlatformMessage({ ...good, data: { ...good.data, source: "other" } }, ORIGIN), null);
  assert.equal(parsePlatformMessage({ ...good, data: { ...good.data, type: "grynd:exit" } }, ORIGIN), null);
  assert.equal(parsePlatformMessage(null, ORIGIN), null);

  assert.deepEqual(buildPlatformMessage("grynd:ready", { gameKey: "tic-tac-toe" }), {
    source: "grynd-platform",
    version: 1,
    type: "grynd:ready",
    gameKey: "tic-tac-toe",
  });

  assert.equal(platformTargetOrigin(ORIGIN), ORIGIN);
  assert.equal(platformTargetOrigin("http://portal.example"), null);
  assert.equal(platformTargetOrigin("*"), null);
  assert.equal(platformTargetOrigin(""), null);
});

// ── 4. Sessions ─────────────────────────────────────────────────────────────

test("a session is opaque, hashed at rest, scoped and expiring", async () => {
  reset();
  const { createPlatformSession, validatePlatformToken, PLATFORM_SESSION_TTL_MS } =
    await sessionModule();

  const now = new Date("2026-01-01T00:00:00.000Z");
  const created = await createPlatformSession({
    platform: PLATFORM,
    gameKey: "tic-tac-toe",
    origin: ORIGIN,
    now,
  });

  assert.match(created.sessionToken, /^[A-Za-z0-9_-]{40,}$/);
  assert.match(created.guestId, /^guest_[0-9a-f]{32}$/);
  assert.notEqual(created.guestId, created.sessionToken);
  assert.equal(
    created.expiresAt.getTime() - now.getTime(),
    PLATFORM_SESSION_TTL_MS,
  );

  // The raw token is never stored — only its SHA-256 hash.
  const stored = [...fake.state.sessions.values()][0];
  assert.notEqual(stored.tokenHash, created.sessionToken);
  assert.match(stored.tokenHash, /^[0-9a-f]{64}$/);

  const valid = await validatePlatformToken(created.sessionToken, {
    platform: PLATFORM,
    gameKey: "tic-tac-toe",
    now,
  });
  assert.equal(valid?.guestId, created.guestId);
  assert.equal(valid?.platformOrigin, ORIGIN);

  // Wrong game / platform / origin never validate.
  assert.equal(
    await validatePlatformToken(created.sessionToken, { gameKey: "dominoes", now }),
    null,
  );
  assert.equal(
    await validatePlatformToken(created.sessionToken, { platform: "other", now }),
    null,
  );
  assert.equal(await validatePlatformToken(`${created.sessionToken}x`, { now }), null);
  assert.equal(await validatePlatformToken("", { now }), null);

  // Expiry is enforced server-side.
  const later = new Date(now.getTime() + PLATFORM_SESSION_TTL_MS + 1);
  assert.equal(await validatePlatformToken(created.sessionToken, { now: later }), null);
});

test("a session can be revoked, and revocation is idempotent", async () => {
  reset();
  const { createPlatformSession, validatePlatformToken, endPlatformSession } = await sessionModule();
  const created = await createPlatformSession({
    platform: PLATFORM,
    gameKey: "tic-tac-toe",
    origin: ORIGIN,
  });

  assert.equal(await endPlatformSession(created.sessionToken), true);
  assert.equal(await validatePlatformToken(created.sessionToken), null);
  // Unknown token: reports nothing to revoke, never throws.
  assert.equal(await endPlatformSession("x".repeat(43)), false);
  assert.equal(await endPlatformSession(""), false);
});

test("minting fails closed for an unconfigured platform, origin or game", async () => {
  reset();
  const { createPlatformSession } = await sessionModule();

  await assert.rejects(
    () =>
      createPlatformSession({
        platform: "unknown",
        gameKey: "tic-tac-toe",
        origin: ORIGIN,
      }),
    /platform_not_configured/,
  );
  await assert.rejects(
    () =>
      createPlatformSession({
        platform: PLATFORM,
        gameKey: "tic-tac-toe",
        origin: "https://evil.example",
      }),
    /origin_not_authorized/,
  );
  await assert.rejects(
    () =>
      createPlatformSession({
        platform: PLATFORM,
        gameKey: "chess",
        origin: ORIGIN,
      }),
    /game_not_supported/,
  );
  assert.equal(fake.state.sessions.size, 0);
});

// ── 5. Routes ───────────────────────────────────────────────────────────────

test("the mint route requires the platform secret, origin and supported game", async () => {
  reset();
  const { POST } = await mintRoute();
  const body = { platform: PLATFORM, gameKey: "tic-tac-toe", origin: ORIGIN };

  assert.equal((await POST(mintRequest(body, ""))).status, 401);
  assert.equal((await POST(mintRequest(body, "wrong-secret"))).status, 401);
  assert.equal((await POST(mintRequest({ ...body, platform: "unknown" }))).status, 403);
  assert.equal(
    (await POST(mintRequest({ ...body, origin: "https://evil.example" }))).status,
    403,
  );
  assert.equal((await POST(mintRequest({ ...body, gameKey: "chess" }))).status, 400);
  assert.equal(fake.state.sessions.size, 0);

  const ok = await POST(mintRequest(body));
  const payload = await ok.json();
  assert.equal(ok.status, 201);
  assert.equal(payload.success, true);
  assert.equal(payload.data.platform, PLATFORM);
  assert.equal(payload.data.gameKey, "tic-tac-toe");
  assert.match(payload.data.embedPath, new RegExp(`^/embed/${PLATFORM}/tic-tac-toe\\?session=`));
  assert.ok(payload.data.sessionToken);
  // The response must not leak the guest identity or the secret.
  assert.equal(payload.data.guestId, undefined);
  assert.doesNotMatch(JSON.stringify(payload), new RegExp(SECRET));
  assert.equal(ok.headers.get("Cache-Control"), "no-store");
});

test("validate returns metadata only and end revokes the session", async () => {
  reset();
  const { createPlatformSession } = await sessionModule();
  const created = await createPlatformSession({
    platform: PLATFORM,
    gameKey: "tic-tac-toe",
    origin: ORIGIN,
  });

  const validate = await validateRoute();
  const missing = await validate.POST(new Request("http://grynd.test/api/platform/session/validate", { method: "POST" }));
  assert.equal(missing.status, 401);

  const validRequest = new Request("http://grynd.test/api/platform/session/validate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: created.sessionToken }),
  });
  const valid = await validate.POST(validRequest);
  const validBody = await valid.json();
  assert.equal(valid.status, 200);
  assert.equal(validBody.data.valid, true);
  assert.equal(validBody.data.gameKey, "tic-tac-toe");
  assert.equal(validBody.data.guestId, undefined, "the guest identity is not exposed");
  assert.doesNotMatch(JSON.stringify(validBody), new RegExp(created.sessionToken));

  // Origin assertion when supplied.
  const wrongOrigin = await validate.POST(
    new Request("http://grynd.test/api/platform/session/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: created.sessionToken, origin: "https://evil.example" }),
    }),
  );
  assert.equal(wrongOrigin.status, 403);

  const end = await endRoute();
  const ended = await end.POST(
    new Request("http://grynd.test/api/platform/session/end", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: created.sessionToken }),
    }),
  );
  assert.equal(ended.status, 200);

  const after = await validate.POST(validRequest);
  assert.equal(after.status, 401, "a revoked session is rejected");
});

// ── 6. Guest gate scope ─────────────────────────────────────────────────────

test("a platform bearer is accepted only for the game its route names", async () => {
  reset();
  const { createPlatformSession } = await sessionModule();
  const created = await createPlatformSession({
    platform: PLATFORM,
    gameKey: "tic-tac-toe",
    origin: ORIGIN,
  });
  request.authorization = `Bearer ${created.sessionToken}`;

  const { requirePracticePlayer } = await import("../src/lib/auth/guestSession.ts");

  const scoped = await requirePracticePlayer({ platformGame: "tic-tac-toe" });
  assert.equal(scoped.response, null);
  assert.equal(scoped.playerId, created.guestId);
  assert.equal(scoped.isGuest, true);

  // No route opt-in → the token is ignored and no cookie exists → 401.
  const unscoped = await requirePracticePlayer();
  assert.equal((await unscoped.response)?.status, 401);

  // A different game's route cannot use the token.
  const wrongGame = await requirePracticePlayer({ platformGame: "dominoes" });
  assert.equal((await wrongGame.response)?.status, 401);

  // The guest identity is server-minted: it never came from the cookie jar, and
  // no guest cookie was minted as a side effect.
  assert.equal(jar.has("grynd_guest"), false);
});

test("an embedded session cannot obtain an account identity", () => {
  const src = strip(read("src/lib/auth/guestSession.ts"));
  assert.match(src, /readPlatformGuest\(platformGame\)/);
  // Platform identity returns a guest seat; it never touches Clerk or the
  // account path.
  assert.match(src, /playerId: platform\.guestId, isGuest: true/);
  const platformSession = strip(read("src/lib/platform/session.ts"));
  assert.doesNotMatch(platformSession, /clerk|userId|user_id/i);
});

// ── 7. Framing headers stay protected globally ──────────────────────────────

test("the proxy keeps global framing protection and relaxes only /embed", () => {
  const proxy = read("src/proxy.ts");
  assert.match(proxy, /response\.headers\.set\("X-Frame-Options", "SAMEORIGIN"\)/);
  assert.match(proxy, /"frame-ancestors 'self'; "/);
  assert.match(proxy, /"\/embed\(\.\*\)"/);
  assert.match(proxy, /applyEmbedFramePolicy\(/);
  // No global relaxation.
  assert.doesNotMatch(proxy, /frame-ancestors \*/);
  assert.doesNotMatch(proxy, /Access-Control-Allow-Origin", "\*"/);

  const realtime = read("realtime-server/server.js");
  assert.match(realtime, /function isOriginAllowed\(origin\)/);
  assert.match(realtime, /allowedOrigins\.includes\(normalized\)/);
  assert.doesNotMatch(realtime, /origin:\s*"\*"/);
});

test("only Tic-Tac-Toe practice routes opt into platform sessions", () => {
  const files = [
    "src/app/api/tic-tac-toe/create-ai/route.ts",
    "src/app/api/tic-tac-toe/match/[matchId]/route.ts",
    "src/app/api/tic-tac-toe/match/[matchId]/move/route.ts",
    "src/app/api/tic-tac-toe/match/[matchId]/cancel/route.ts",
    "src/app/api/tic-tac-toe/match/[matchId]/forfeit/route.ts",
  ];
  for (const file of files) {
    assert.match(
      read(file),
      /requirePracticePlayer\(\{\s*(?:create: true,\s*)?platformGame: "tic-tac-toe",?\s*\}\)/,
      `${file} must scope platform tokens to tic-tac-toe`,
    );
  }

  // Ranked matchmaking never accepts a platform token.
  const ranked = read("src/app/api/tic-tac-toe/create-or-join/route.ts");
  assert.match(ranked, /requireAgeVerifiedUser\(\)/);
  assert.doesNotMatch(ranked, /platformGame|readPlatformGuest/);

  // Guest PvP is not reachable with a platform token.
  const pvp = read("src/lib/auth/guestPvp.ts");
  assert.doesNotMatch(pvp, /readPlatformGuest|platformGame/);
});

// ── 8. Embed client, SDK and docs ───────────────────────────────────────────

test("the embed page validates the session server-side and never uses Clerk", () => {
  const page = strip(read("src/app/embed/[platform]/[gameKey]/page.tsx"));
  assert.match(page, /validatePlatformToken\(token, \{ platform, gameKey \}\)/);
  assert.match(page, /getPlatformConfig\(platform\)/);
  assert.match(page, /session\.platformOrigin !== config\.origin/);
  assert.doesNotMatch(page, /@clerk/);
  assert.match(page, /robots: \{ index: false/);

  const client = strip(read("src/app/embed/[platform]/[gameKey]/EmbedClient.tsx"));
  assert.match(client, /Authorization\", `Bearer \$\{token\}`/);
  assert.match(client, /credentials: "omit"/);
  assert.match(client, /platformTargetOrigin\(platformOrigin\)/);
  assert.match(client, /parsePlatformMessage\(event, targetOrigin\)/);
  assert.match(client, /grynd:session_expired/);
  assert.doesNotMatch(client, /targetOrigin\s*[:=]\s*["']\*["']/);
  // No cookie/claim/account surface in the embedded client.
  assert.doesNotMatch(client, /grynd_guest|\/api\/guest\/claim|useUser|Clerk/);
});

test("the public SDK uses explicit origins and matches the message contract", () => {
  const sdk = read("public/platform-sdk/grynd-platform-v1.js");
  const sdkCode = sdk
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  assert.match(sdkCode, /win\.postMessage\(message, origin\)/);
  assert.doesNotMatch(sdkCode, /["']\*["']/);
  assert.match(sdkCode, /event\.origin !== origin/);
  assert.match(sdkCode, /source !== SOURCE/);
  assert.match(sdkCode, /version !== VERSION/);
  assert.match(sdkCode, /grynd:session_expired/);

  const docs = read("docs/platform-integration.md");
  for (const needle of [
    "GRYND_PLATFORM_ALLOWLIST",
    "GRYND_PLATFORM_SECRET_",
    "Authorization: Bearer",
    "grynd:session_expired",
    "frame-ancestors",
    "Not enabled",
    "does **not** claim",
  ]) {
    assert.ok(docs.includes(needle), `docs must document ${needle}`);
  }
});

// ── 9. Migration + journal ──────────────────────────────────────────────────

test("the platform session migration is additive and stores no raw token or account id", () => {
  const sqlText = read("src/db/migrations/0242_platform_sessions.sql");
  // Column definitions only: the header comments deliberately explain that
  // there is no user_id/raw token, so negative checks run on comment-free SQL.
  const sqlCode = sqlText.replace(/^\s*--.*$/gm, "");

  assert.match(sqlText, /CREATE TABLE IF NOT EXISTS "platform_sessions"/);
  assert.match(sqlText, /"token_hash" varchar\(64\) PRIMARY KEY/);
  assert.match(sqlText, /"platform" varchar\(32\) NOT NULL/);
  assert.match(sqlText, /"game_key" varchar\(32\) NOT NULL/);
  assert.match(sqlText, /"platform_origin" varchar\(255\) NOT NULL/);
  assert.match(sqlText, /"guest_id" varchar\(64\) NOT NULL/);
  assert.match(sqlText, /"expires_at" timestamp NOT NULL/);
  assert.match(sqlText, /"ended_at" timestamp/);
  assert.match(sqlText, /platform_sessions_guest_id_format/);
  assert.match(sqlText, /CREATE INDEX IF NOT EXISTS "platform_sessions_expiry_idx"/);

  assert.doesNotMatch(sqlCode, /\buser_id\b|\bclerk_id\b/i);
  assert.doesNotMatch(sqlCode, /"token"\s|"session_token"/);
  assert.doesNotMatch(sqlCode, /DROP\s+(TABLE|COLUMN|INDEX)/i);
  assert.doesNotMatch(sqlCode, /ALTER\s+TABLE/i);

  const schema = read("src/db/schema.ts");
  assert.match(schema, /export const platformSessions = pgTable\(\s*"platform_sessions"/);
  assert.match(schema, /platform_sessions_expiry_idx/);
  assert.match(schema, /platform_sessions_guest_id_format/);
});

test("the migration is registered last with a contiguous journal", () => {
  const journal = JSON.parse(read("src/db/migrations/meta/_journal.json"));
  const entries = journal.entries;
  const entry = entries.find((candidate) => candidate.tag === "0242_platform_sessions");

  assert.ok(entry);
  assert.equal(entry.idx, entries.indexOf(entry));
  // Phase 6 adds 0243 after this migration, so "registered in sequence" is the
  // invariant; it must not be assumed to be the final migration forever.
  assert.ok(entry.idx > 0);
  assert.ok(entry.idx <= entries.length - 1);
  assert.equal(entry.version, "7");
  assert.equal(entry.breakpoints, true);
  const maxPriorWhen = Math.max(
    ...entries.filter((other) => other.idx < entry.idx).map((other) => other.when),
  );
  assert.ok(entry.when > maxPriorWhen);
  for (let i = 1; i < entries.length; i += 1) assert.equal(entries[i].idx, i);

  assert.ok(fs.existsSync(path.join(process.cwd(), "src/db/migrations/0242_platform_sessions.sql")));
});
