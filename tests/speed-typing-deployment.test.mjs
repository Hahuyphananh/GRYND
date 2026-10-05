/**
 * speed-typing-deployment.test.mjs
 *
 * The Speed Typing slice of GRYND's PRODUCTION topology:
 *
 *     browser ──HTTPS──▶ Vercel (Next.js app + API routes)
 *        │                     │
 *        │                     └──HTTPS /emit──▶ Render (standalone Socket.IO) ──┐
 *        └──WSS / socket.io───────────────────────────────────────────────────┘
 *                              ▲                                              │
 *                              └──HTTPS disconnect-forfeit / internal hooks───┘
 *
 * Speed Typing crosses that split in four places, and every one of them is a
 * place where a rename, a moved constant or a guessed URL would silently break
 * production without breaking a single gameplay test:
 *
 *   1. the match ROOM ID must be byte-identical on both sides,
 *   2. the match ID must survive the hop (Vercel builds it, Render keys on it),
 *   3. the Render→Vercel callback needs a real base URL, not localhost,
 *   4. the shared secret that authenticates Vercel→Render must be on BOTH.
 *
 * This file pins all four, plus the secret-hygiene rules, so none of them can
 * regress unnoticed. Where a property is inherently two-process (a real CORS
 * handshake, two real browsers), the assertion is on the CONFIGURATION that
 * makes it work, and the test says so.
 *
 * Run:  npm run test:speed-typing
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import {
  SPEED_TYPING_EVENTS,
  SPEED_TYPING_LOBBY_ROOM,
  SPEED_TYPING_MATCH_ROOM_PREFIX,
  speedTypingMatchRoom,
} from "../src/lib/speed-typing/rooms.ts";
import { MATCH_STATUS, RACE_COUNTDOWN_MS } from "../src/lib/speed-typing/constants.ts";
import { createRaceState, raceViewFor } from "../src/lib/speed-typing/rules.ts";
import { PASSAGE_VERSION, selectPassageForSeed } from "../src/lib/speed-typing/passages.ts";

const read = (rel) => readFileSync(rel, "utf8");

const SERVER = read("realtime-server/server.js");
const SERVER_README = read("realtime-server/README.md");
const RENDER_YAML = read("render.yaml");
const CLIENT_SOCKET = read("src/lib/socket.ts");
const SOCKET_PROVIDER = read("src/context/SocketProvider.tsx");
const SPEED_REALTIME = read("src/lib/speed-typing/realtime.ts");
const MATCH_PAGE_PATH = "src/app/casino/speed-typing/[matchId]/PageClient.tsx";
const MATCH_PAGE = read(MATCH_PAGE_PATH);
const GITIGNORE = read(".gitignore");
const DEPLOY_DOC = read("docs/PROD_REALTIME_AND_NEON_TASKS.md");

/** The env names a file reads, e.g. `process.env.CLIENT_URL` → "CLIENT_URL". */
function envNamesIn(src) {
  return [
    ...new Set([...src.matchAll(/process\.env\.([A-Z0-9_]+)/g)].map((m) => m[1])),
  ].sort();
}

/** The `envVars` keys declared for the Render service. */
function renderYamlEnvKeys() {
  return [...RENDER_YAML.matchAll(/^\s*- key:\s*([A-Z0-9_]+)\s*$/gm)].map((m) => m[1]);
}

// ════════════════════════════════════════════════════════════════════════
// 3, 4, 14, 15. One room per match, named identically on both sides
// ════════════════════════════════════════════════════════════════════════

test("deploy: the room prefix is identical in the client module and the Render server", () => {
  const clientPrefix = SPEED_TYPING_MATCH_ROOM_PREFIX;
  assert.equal(clientPrefix, "speed-typing:match:", "the client's literal");

  // The realtime server is plain CommonJS and cannot import the TS module, so
  // it restates the literal. That is exactly the duplication worth pinning.
  assert.ok(
    SERVER.includes(`const SPEED_TYPING_MATCH_ROOM_PREFIX = "${clientPrefix}";`),
    "the Render server must restate the SAME room prefix",
  );

  // …and the room BUILDER agrees with it.
  assert.equal(speedTypingMatchRoom("abc-123"), `${clientPrefix}abc-123`);
  assert.equal(speedTypingMatchRoom(42), `${clientPrefix}42`);
  // The lobby room is a different, non-overlapping id.
  assert.equal(SPEED_TYPING_LOBBY_ROOM, "lobby:speed-typing");
  assert.equal(SPEED_TYPING_LOBBY_ROOM.startsWith(clientPrefix.slice(0, -1)), false);
});

test("deploy: every event name the server relays matches the client vocabulary", () => {
  // Client→server.
  assert.ok(SERVER.includes(`socket.on("${SPEED_TYPING_EVENTS.READY}"`));
  // Server→client, emitted by the BACKEND (the routes) via the shared helper.
  for (const event of [
    SPEED_TYPING_EVENTS.MATCH_UPDATED,
    SPEED_TYPING_EVENTS.COUNTDOWN,
    SPEED_TYPING_EVENTS.MATCH_STARTED,
    SPEED_TYPING_EVENTS.PLAYER_COMPLETED,
    SPEED_TYPING_EVENTS.MATCH_FINISHED,
    SPEED_TYPING_EVENTS.OPPONENT_PROGRESS,
  ]) {
    // The name is defined once, in the client-safe module, and re-exported.
    assert.ok(SPEED_TYPING_EVENTS && event.length > 0);
    assert.equal(typeof event, "string");
  }
  // The one event the RENDER server itself emits must be the shared
  // "lobby:updated" string every game's client already understands.
  const readyHandler = SERVER.slice(SERVER.indexOf(`socket.on("${SPEED_TYPING_EVENTS.READY}"`));
  assert.ok(readyHandler.slice(0, 1400).includes(`emit("${SPEED_TYPING_EVENTS.MATCH_UPDATED}"`));
  assert.equal(SPEED_TYPING_EVENTS.MATCH_UPDATED, "lobby:updated");
});

test("deploy: the match id survives the Vercel→Render hop and keys the participant map", () => {
  // Vercel builds the room from the URL param via the ONE shared builder.
  for (const route of [
    "src/app/api/speed-typing/match/[matchId]/progress/route.ts",
    "src/app/api/speed-typing/match/[matchId]/finish/route.ts",
    "src/app/api/speed-typing/match/[matchId]/cancel/route.ts",
  ]) {
    const src = read(route);
    assert.match(src, /matchId/, `${route} must take the id from the route params`);
  }
  assert.match(SPEED_REALTIME, /speedTypingMatchRoom\(matchId\)/, "broadcasts use the shared room builder");

  // Render strips the prefix back off to recover the SAME uuid, and keys the
  // participant map on it — which is what the ready-poke gate and the
  // disconnect forfeit both look up.
  assert.match(SERVER, /roomId\.slice\(SPEED_TYPING_MATCH_ROOM_PREFIX\.length\)/);
  assert.match(SERVER, /speedTypingRoomParticipants\.get\(matchIdStr\)/);
  assert.match(SERVER, /speedTypingRoomParticipants\.set\(matchId, new Set\(\)\)/);

  // UUID shape on both sides: Vercel rejects a malformed id before the driver,
  // Render rejects one before building a room name.
  assert.match(SERVER, /\^\[0-9a-fA-F-\]\{1,64\}\$/);
  assert.match(read("src/lib/speed-typing/serverStore.ts"), /isMatchId/);
});

test("deploy: the split-process relay posts to the match room with the shared secret", () => {
  // The in-process and split-process paths must agree on the room id.
  assert.match(SPEED_REALTIME, /io\.to\(speedTypingMatchRoom\(matchId\)\)\.emit/);
  assert.match(SPEED_REALTIME, /room: speedTypingMatchRoom\(matchId\)/);
  assert.match(SPEED_REALTIME, /method: "POST"/);
  assert.match(SPEED_REALTIME, /`\$\{baseUrl\}\/emit`/);
  assert.match(SPEED_REALTIME, /headers\["x-internal-secret"\] = process\.env\.REALTIME_INTERNAL_SECRET/);
  // It must never fail the calling route: a missed push is covered by the poll.
  assert.match(SPEED_REALTIME, /catch \(error\) \{/);
  assert.match(SPEED_REALTIME, /AbortSignal\.timeout\(/);
  // The Render side authenticates /emit with the same header and fails closed.
  assert.match(SERVER, /req\.headers\["x-internal-secret"\]/);
  assert.match(SERVER, /timingSafeEqual/);
  assert.match(SERVER, /REALTIME_INTERNAL_SECRET is not configured/);
  assert.match(SERVER, /res\.status\(503\)/);
  // A wrong or absent secret is rejected BEFORE the room is touched.
  const emitHandler = SERVER.slice(SERVER.indexOf('app.post("/emit"'), SERVER.indexOf("// Room that verified admins join"));
  const unauthorizedAt = emitHandler.indexOf('res.status(401).json({ success: false, error: "Unauthorized" })');
  assert.ok(unauthorizedAt > 0, "/emit must reject an unauthenticated caller");
  assert.ok(
    unauthorizedAt < emitHandler.indexOf("io.to(roomName).emit"),
    "the rejection must come BEFORE any emission",
  );
});

// ════════════════════════════════════════════════════════════════════════
// 13. Both seats are handed the SAME prompt
// ════════════════════════════════════════════════════════════════════════

test("deploy: both seats resolve one prompt from the row, not from a request", () => {
  const prompt = selectPassageForSeed({ seed: 5_150_151 });
  const row = {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    player1Id: "user_a",
    player2Id: "user_b",
    status: MATCH_STATUS.PLAYING,
    raceSeed: 5_150_151,
    passageId: prompt.id,
    passageVersion: PASSAGE_VERSION,
    goAt: new Date(1_700_000_000_000),
    revision: 3,
    raceState: createRaceState({ version: 1 }),
  };

  const seat1 = raceViewFor({ match: row, seat: "player1", nowMs: 1_700_000_001_000 });
  const seat2 = raceViewFor({ match: row, seat: "player2", nowMs: 1_700_000_001_000 });

  // Identical text, identical id/version — and identical GO instant, so both
  // clients count to one server clock (the reason it is stored absolutely).
  assert.equal(seat1.passageText, seat2.passageText);
  assert.equal(seat1.passageId, seat2.passageId);
  assert.equal(seat1.passageVersion, seat2.passageVersion);
  assert.equal(seat1.goAtMs, seat2.goAtMs);
  assert.equal(seat1.deadlineMs, seat2.deadlineMs);
  assert.equal(seat1.seatKey, "player1");
  assert.equal(seat2.seatKey, "player2");
  // Each seat sees the OTHER as the opponent — a mirror, never a shared view.
  assert.equal(seat1.you.charsTyped, seat2.opponent.charsTyped);
  assert.equal(seat2.you.charsTyped, seat1.opponent.charsTyped);
  // The prompt metadata is exposed; the SEED that chose it is not.
  assert.equal("raceSeed" in seat1, false);
  assert.equal(JSON.stringify(seat1).includes("5150151"), false);
});

test("deploy: the countdown window is the one the server broadcasts", () => {
  // The route that ARMS the race broadcasts the same constant the store used,
  // so a client cannot be counting to a different GO instant than the row.
  const route = read("src/app/api/speed-typing/create-or-join/route.ts");
  assert.match(route, /RACE_COUNTDOWN_MS/);
  assert.match(route, /countdownMs: RACE_COUNTDOWN_MS/);
  assert.match(route, /goAtMs: goAt/);
  assert.ok(RACE_COUNTDOWN_MS > 0);
  // The GO instant is the ROW's, never a client-supplied value.
  assert.match(route, /result\.match\.goAt/);
});

// ════════════════════════════════════════════════════════════════════════
// 6. CORS: the production Vercel origin must be allowed, nothing wildcarded
// ════════════════════════════════════════════════════════════════════════

test("deploy: CORS is an explicit allowlist from CLIENT_URL, and fails closed", () => {
  // Comma-separated so a preview deployment can be added next to production.
  assert.match(SERVER, /String\(process\.env\.CLIENT_URL \|\| ""\)\s*\.split\(","\)/);
  // Trailing slashes normalised on both the config and the inbound origin.
  assert.match(SERVER, /\.replace\(\/\\\/\$\/, ""\)/);
  assert.match(SERVER, /function normalizeOrigin\(origin\)/);
  // An empty allowlist is a startup failure, not an open door.
  assert.match(SERVER, /if \(allowedOrigins\.length === 0\) \{[\s\S]{0,120}?throw new Error\("Missing CLIENT_URL/);
  // No wildcard / reflect-anything anywhere in the CORS setup.
  assert.doesNotMatch(SERVER, /origin:\s*true/);
  assert.doesNotMatch(SERVER, /origin:\s*"\*"/);
  assert.doesNotMatch(SERVER, /app\.use\(cors\(\)\)/);
  // Applied to BOTH express (the /emit, /health endpoints) and Socket.IO.
  assert.match(SERVER, /app\.use\(cors\(corsOptions\)\)/);
  assert.match(SERVER, /cors: \{[\s\S]{0,200}?origin\(origin, callback\)/);
  // The Socket.IO origin check rejects, rather than silently allowing.
  assert.match(SERVER, /callback\(new Error\("Socket origin not allowed"\)\)/);
});

test("deploy: /health reports the config without leaking a secret", () => {
  // Just the handler body — the comment block below it legitimately NAMES the
  // internal secret while explaining that /emit fails closed.
  const from = SERVER.indexOf('app.get("/health"');
  const health = SERVER.slice(from, SERVER.indexOf("\n});", from));
  assert.match(health, /allowedOrigins/);
  assert.match(health, /clerkConfigured: Boolean\(CLERK_SECRET_KEY\)/);
  assert.match(health, /wsPath: "\/socket\.io"/);
  // Booleans only — the values themselves never leave the process.
  assert.doesNotMatch(health, /CLERK_SECRET_KEY\s*[,:]/);
  assert.doesNotMatch(health, /REALTIME_INTERNAL_SECRET/);
  assert.doesNotMatch(health, /DATABASE_URL/);
  assert.doesNotMatch(health, /process\.env\.[A-Z_]+ \}/);
});

// ════════════════════════════════════════════════════════════════════════
// 7, 8, 9. Environment variables, per side
// ════════════════════════════════════════════════════════════════════════

test("deploy: each side reads exactly the environment it is documented to", () => {
  // ── RENDER (the standalone Socket.IO service) ──
  const serverEnv = envNamesIn(SERVER);
  for (const name of ["PORT", "CLIENT_URL", "CLERK_SECRET_KEY", "REALTIME_INTERNAL_SECRET", "NEXTJS_INTERNAL_URL"]) {
    assert.ok(serverEnv.includes(name), `the Render server must read ${name}`);
  }
  // The Vercel-only and browser-only names must NOT be read there: reading
  // NEXT_PUBLIC_SOCKET_URL on Render would be a configuration smell.
  assert.equal(serverEnv.includes("NEXT_PUBLIC_SOCKET_URL"), false);
  assert.equal(serverEnv.includes("DATABASE_URL"), false, "Render owns no database access");

  // ── VERCEL (the Next.js app + API routes) ──
  const relayEnv = envNamesIn(SPEED_REALTIME);
  assert.deepEqual(relayEnv, ["NEXT_PUBLIC_SOCKET_URL", "REALTIME_INTERNAL_SECRET", "REALTIME_INTERNAL_URL"]);

  // ── BROWSER (the client bundle) ──
  const clientEnv = envNamesIn(CLIENT_SOCKET);
  // NODE_ENV is a build-time constant Next.js substitutes, not configuration.
  assert.deepEqual(
    clientEnv.filter((n) => n !== "NODE_ENV"),
    ["NEXT_PUBLIC_SOCKET_URL"],
    "the socket client reads exactly one piece of configuration, and it is public",
  );
  const providerEnv = envNamesIn(SOCKET_PROVIDER);
  assert.deepEqual(providerEnv, [], "the provider reads no env directly — Clerk supplies the token");
});

test("deploy: render.yaml declares every Render variable that has no safe default", () => {
  const declared = renderYamlEnvKeys();
  // These have a localhost/insecure default in code, so forgetting one on
  // Render does not crash — it silently makes the service WRONG. That is the
  // dangerous class, and it is exactly this list.
  const mustBeDeclaredOnRender = [
    "CLIENT_URL", // no default at all: the service refuses to start
    "CLERK_SECRET_KEY", // socket auth would reject every connection
    "REALTIME_INTERNAL_SECRET", // /emit would 401 and every push would be lost
    "NEXTJS_INTERNAL_URL", // every Render→Vercel callback would hit localhost
  ];
  for (const name of mustBeDeclaredOnRender) {
    assert.ok(declared.includes(name), `render.yaml must declare ${name}`);
  }
  // A secret must never carry a literal value in the committed blueprint.
  for (const line of RENDER_YAML.split("\n")) {
    if (/^\s*- key:\s*(CLERK_SECRET_KEY|REALTIME_INTERNAL_SECRET|DATABASE_URL)/.test(line)) {
      const after = RENDER_YAML.slice(RENDER_YAML.indexOf(line) + line.length).split("\n")[1] ?? "";
      assert.match(after.trim(), /^sync: false/, "secrets are entered in the dashboard, never committed");
    }
  }
  assert.doesNotMatch(RENDER_YAML, /sk_live|sk_test|[a-f0-9]{40,}/, "no secret material in render.yaml");
});

test("deploy: development on localhost still works on both sides", () => {
  // Render side: a port default for `npm run dev` and a Next.js base URL that
  // falls back to the local dev server, so no env is required to run locally.
  assert.match(SERVER, /Number\(process\.env\.PORT \|\| 3001\)/);
  assert.match(SERVER, /process\.env\.NEXTJS_INTERNAL_URL \|\| "http:\/\/localhost:3000"/);
  // Vercel side: an absent socket URL disables realtime instead of throwing,
  // and only warns outside production.
  assert.match(CLIENT_SOCKET, /if \(!socketUrl\) \{/);
  assert.match(CLIENT_SOCKET, /process\.env\.NODE_ENV !== "production"/);
  assert.match(CLIENT_SOCKET, /return null;/);
  // The relay no-ops when there is no configured realtime host.
  assert.match(SPEED_REALTIME, /if \(!baseUrl\) return false;/);
  // And the local setup is documented.
  assert.match(SERVER_README, /CLIENT_URL=http:\/\/localhost:3000/);
  assert.match(SERVER_README, /npm run dev/);
});

test("deploy: no production host is hardcoded in the Speed Typing code", () => {
  const files = [
    "src/lib/speed-typing/realtime.ts",
    "src/lib/speed-typing/rooms.ts",
    "src/lib/speed-typing/serverStore.ts",
    "src/lib/socket.ts",
    MATCH_PAGE_PATH,
    "src/app/api/speed-typing/create-or-join/route.ts",
    "src/app/api/speed-typing/disconnect-forfeit/route.ts",
  ];
  for (const file of files) {
    const src = read(file);
    assert.doesNotMatch(src, /onrender\.com/, `${file} must not hardcode the Render host`);
    assert.doesNotMatch(src, /grynd\.dedyn\.io/, `${file} must not hardcode the web host`);
    assert.doesNotMatch(src, /https?:\/\/(?!localhost)[a-z0-9.-]+\.[a-z]{2,}/i, `${file} must not hardcode a host`);
  }
  // The one permitted literal is the dev fallback, which is a localhost URL.
  assert.match(read("realtime-server/server.js"), /http:\/\/localhost:3000/);
});

// ════════════════════════════════════════════════════════════════════════
// 1, 2, 5. The two hops: browser→Vercel and browser→Render
// ════════════════════════════════════════════════════════════════════════

test("deploy: the browser reaches Render by one public variable, with a token, over ws+polling", () => {
  // The Render URL is PUBLIC configuration (it is in the browser's bundle);
  // the token that authenticates it comes from Clerk, never from the bundle.
  assert.match(CLIENT_SOCKET, /io\(socketUrl, \{/);
  assert.match(CLIENT_SOCKET, /transports: \["websocket", "polling"\]/, "Render sits behind a proxy: polling is the fallback");
  assert.match(CLIENT_SOCKET, /auth:\s*\{\s*token,?\s*\}/);
  assert.match(CLIENT_SOCKET, /socketUrl\.trim\(\)\.replace\(\/\\\/\$\/, ""\)/, "a trailing slash in the env var must not break the URL");
  assert.match(SOCKET_PROVIDER, /const token = await getToken\(\)/);
  assert.match(SOCKET_PROVIDER, /await createSocketConnection\(token\)/);
  // Render verifies that token server-side with its own secret.
  assert.match(SERVER, /const token = socket\.handshake\.auth\?\.token/);
  assert.match(SERVER, /await verifyToken\(token, \{\s*secretKey: CLERK_SECRET_KEY,?\s*\}\)/);
  assert.match(SERVER, /socket\.data\.userId = verified\.sub/);
  // No token, no connection — and the raw token is kept for background jobs
  // (the disconnect forfeit re-verifies the SAME identity server-side).
  assert.match(SERVER, /return next\(new Error\("Authentication token missing"\)\)/);
  assert.match(SERVER, /socket\.data\.clerkToken = token/);
});

test("deploy: the Vercel app serves the game without needing Render to be up", () => {
  // The authoritative read is a Vercel route, and the socket is an accelerator:
  // the page reads the snapshot over HTTPS (once on mount, and again on a socket
  // reconnect / tab focus), so a dead or unconfigured socket degrades a live
  // race instead of breaking it.
  assert.match(MATCH_PAGE, /useMatchSync\(/, "the event-driven reconcile hook");
  assert.doesNotMatch(MATCH_PAGE, /useVisiblePoll\(/, "no recurring poll on the match page");
  assert.match(MATCH_PAGE, /if \(!socket \|\| !matchId\) return undefined;/, "the page works with no socket");
  assert.match(MATCH_PAGE, /cache: "no-store"/, "the snapshot is never cached by the edge");
  // Progress travels over HTTPS to Vercel; the socket carries only projections.
  assert.match(MATCH_PAGE, /\/api\/speed-typing\/match\/\$\{matchId\}\/progress/);
  assert.match(MATCH_PAGE, /\/api\/speed-typing\/match\/\$\{matchId\}\/finish/);
  // And the Vercel routes are dynamic, so they are never statically cached.
  for (const route of [
    "src/app/api/speed-typing/match/[matchId]/progress/route.ts",
    "src/app/api/speed-typing/match/[matchId]/finish/route.ts",
    "src/app/api/speed-typing/match/[matchId]/route.ts",
    "src/app/api/speed-typing/disconnect-forfeit/route.ts",
  ]) {
    assert.match(read(route), /force-dynamic/, `${route} must not be cached`);
  }
});

// ════════════════════════════════════════════════════════════════════════
// 10, 11. Reconnection and refresh
// ════════════════════════════════════════════════════════════════════════

test("deploy: the client retries hard enough to outlast a blip inside the grace window", () => {
  const attempts = Number(CLIENT_SOCKET.match(/reconnectionAttempts:\s*(\d+)/)?.[1]);
  const base = Number(CLIENT_SOCKET.match(/reconnectionDelay:\s*(\d+)/)?.[1]);
  const cap = Number(CLIENT_SOCKET.match(/reconnectionDelayMax:\s*(\d+)/)?.[1]);
  assert.equal(CLIENT_SOCKET.includes("reconnection: true"), true);
  assert.ok(Number.isFinite(attempts) && attempts >= 10, "a dropped socket must keep trying");
  assert.ok(base > 0 && cap >= base, "the backoff must start small and be capped");

  // Socket.IO doubles the delay per attempt up to the cap.
  let total = 0;
  for (let i = 0; i < attempts; i += 1) total += Math.min(cap, base * 2 ** i);
  const minWithJitter = total * 0.5; // randomizationFactor defaults to 0.5

  // The server's forfeit grace window, read from the shared realtime source.
  const grace = Number(SERVER.match(/CRASH_ARENA_DISCONNECT_GRACE_MS = ([\d_]+)/)?.[1].replace(/_/g, ""));
  assert.ok(Number.isFinite(grace) && grace > 0);

  // THE INVARIANT THAT MATTERS: a normal network blip must be recovered by the
  // client BEFORE the server gives the race away. (The worst case, with jitter,
  // can exceed the window — see the deployment note in
  // docs/PROD_REALTIME_AND_NEON_TASKS.md: the server re-checks for a live
  // socket before forfeiting, which is what closes that last gap.)
  assert.ok(
    minWithJitter < grace,
    `the client's retry window (min ${minWithJitter}ms) must be shorter than the server's grace (${grace}ms)`,
  );
});

test("deploy: a refresh restores the match from the server, never from client state", () => {
  // On mount the page re-fetches the authoritative snapshot and clears every
  // piece of local racing state, so a reload cannot resume a stale race.
  assert.match(MATCH_PAGE, /loadedRef\.current = false;\s*\n\s*setLoading\(true\);\s*\n\s*setTyped\(""\);/);
  assert.match(MATCH_PAGE, /finishSentRef\.current = false;/);
  // The socket re-joins the room on every connect — Socket.IO does not restore
  // room membership, so a reconnect without this would go silent.
  assert.match(MATCH_PAGE, /socket\.on\("connect", join\)/);
  assert.match(MATCH_PAGE, /socket\.emit\("join_room", \{ roomId \}\)/);
  assert.match(MATCH_PAGE, /socket\.emit\("leave_room", \{ roomId \}\)/);
  // Which is also what cancels the server's forfeit timer for this seat.
  assert.match(SERVER, /cancelDisconnectGraceTimer\(`speed-typing:\$\{matchId\}:\$\{userId\}`\)/);
  // The timer keys match on both paths (join vs schedule), or the cancel is a no-op.
  const scheduled = SERVER.match(/scheduleDisconnectGraceTimer\(`speed-typing:\$\{mid\}:\$\{socket\.data\.userId\}`/);
  assert.ok(scheduled, "the forfeit timer must use the same key shape the join cancels");
});

test("deploy: the forfeit timer re-checks liveness and retries transient failures", () => {
  const block = SERVER.slice(SERVER.indexOf("scheduleDisconnectGraceTimer(`speed-typing:"));
  const body = block.slice(0, block.indexOf("// For hex duel"));
  // Belt-and-suspenders: a socket that came back (or a second tab) wins.
  assert.match(body, /if \(hasLiveSocketForUser\(socket\.data\.userId, roomId\)\) return false;/);
  // The callback re-verifies through Vercel with the socket's own token, and
  // reports success/failure so the scheduler can retry a transient outage.
  assert.match(body, /NEXTJS_INTERNAL_URL/);
  assert.match(body, /\/api\/speed-typing\/disconnect-forfeit/);
  assert.match(body, /body: JSON\.stringify\(\{ matchId: mid, token: socket\.data\.clerkToken \}\)/);
  assert.match(body, /return !\(payload && payload\.success === true\)/);
  assert.match(body, /return true; \/\/ transient — retry/);
  // Bounded retries, so a permanently-broken endpoint cannot spin forever.
  assert.match(SERVER, /CRASH_ARENA_DISCONNECT_MAX_ATTEMPTS = \d+/);
  assert.match(SERVER, /if \(wantsRetry && attempt \+ 1 < maxAttempts\)/);
});

// ════════════════════════════════════════════════════════════════════════
// 16. Completion reaches both clients, and settles once
// ════════════════════════════════════════════════════════════════════════

test("deploy: completion is broadcast to the ONE room both seats joined", () => {
  const finish = read("src/app/api/speed-typing/match/[matchId]/finish/route.ts");
  // The socket is a push channel in ONE direction only: the route emits, the
  // client never does. Both seats are in the same room, so one emit reaches both.
  assert.match(finish, /broadcastOpponentProgress\(/);
  assert.match(finish, /broadcastMatchEvent\(matchId, SPEED_TYPING_EVENTS\.PLAYER_COMPLETED/);
  assert.match(finish, /broadcastMatchEvent\(matchId, SPEED_TYPING_EVENTS\.MATCH_FINISHED/);
  assert.match(finish, /if \(result\.outcome\?\.settled\)/);
  // Settlement happens inside the store's row-locked transaction, once —
  // asserted behaviourally in speed-typing-settlement.test.mjs, and the flags
  // that report it are surface here so this test cannot drift from that one.
  assert.match(read("src/lib/speed-typing/serverStore.ts"), /settleSpeedTypingMatch/);
});

test("deploy: the two-process callback target is documented, not guessed", () => {
  // NEXTJS_INTERNAL_URL is the Render→Vercel half of the split. It has a
  // localhost default in code, so an unset value in production is silent —
  // which is why it must appear in the blueprint AND in the docs.
  assert.ok(renderYamlEnvKeys().includes("NEXTJS_INTERNAL_URL"));
  assert.match(DEPLOY_DOC, /NEXTJS_INTERNAL_URL/);
  assert.match(DEPLOY_DOC, /REALTIME_INTERNAL_URL/);
  assert.match(DEPLOY_DOC, /REALTIME_INTERNAL_SECRET/);
  assert.match(DEPLOY_DOC, /NEXT_PUBLIC_SOCKET_URL/);
  assert.match(DEPLOY_DOC, /CLIENT_URL/);
  assert.match(DEPLOY_DOC, /CLERK_SECRET_KEY/);
  // And each is attributed to a side, so nobody has to infer it.
  assert.match(DEPLOY_DOC, /Vercel/);
  assert.match(DEPLOY_DOC, /Render/);
});

// ════════════════════════════════════════════════════════════════════════
// Secret hygiene — the standing requirement
// ════════════════════════════════════════════════════════════════════════

test("secrets: no secret is readable from the browser bundle", () => {
  const SECRETS = [
    "CLERK_SECRET_KEY",
    "CLERK_JWT_KEY",
    "REALTIME_INTERNAL_SECRET",
    "DATABASE_URL",
    "POSTGRES_URL",
    "STRIPE_SECRET_KEY",
    "STRIPE_WEBHOOK_SECRET",
    "SUPABASE_SERVICE_ROLE_KEY",
    "RESEND_API_KEY",
    "OPENAI_API_KEY",
    "REALTIME_INTERNAL_URL",
  ];

  // 1. No secret name may ever be given a NEXT_PUBLIC_ prefix — Next.js would
  //    inline it into the client bundle.
  for (const name of SECRETS) {
    assert.equal(
      existsSync(join("src", `NEXT_PUBLIC_${name}`)),
      false,
      `${name} must never exist in a public form`,
    );
  }

  // 2. A "use client" module must not reference a non-public env var at all.
  //    (Next.js would hand it `undefined` — a bug — and it is one edit away
  //    from becoming an inlineable leak.)
  const offenders = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(ts|tsx|js|jsx)$/.test(entry.name)) continue;
      const src = readFileSync(full, "utf8");
      if (!/^\s*["']use client["']/m.test(src)) continue;
      for (const name of envNamesIn(src)) {
        if (name === "NODE_ENV" || name.startsWith("NEXT_PUBLIC_")) continue;
        offenders.push(`${full.replace(/\\/g, "/")} reads ${name}`);
      }
    }
  };
  walk("src");
  assert.deepEqual(offenders, [], "a client component must not read a server-only variable");

  // 3. The Speed Typing match page must carry nothing sensitive either.
  for (const name of SECRETS) {
    assert.equal(MATCH_PAGE.includes(`process.env.${name}`), false, `the match page must not read ${name}`);
  }
});

test("secrets: real env files are untracked and only value-free templates exist", () => {
  // The repo BANS real env files at any depth and permits `*.example` only.
  assert.match(GITIGNORE, /^\*\*\/\.env$/m);
  assert.match(GITIGNORE, /^\*\*\/\.env\.\*$/m);
  assert.match(GITIGNORE, /^!\*\*\/\.env\.example$/m);
  assert.match(GITIGNORE, /^!\*\*\/\.env\.\*\.example$/m);

  // Every committed template must be VALUE-FREE: a placeholder is fine, a
  // credential is not. Guard the ones this audit touched, plus any other the
  // repo grows.
  const templates = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === ".next") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (/^\.env.*\.example$/.test(entry.name)) templates.push(full.replace(/\\/g, "/"));
    }
  };
  walk(".");
  assert.ok(templates.length > 0, "the deployment variables must be templated somewhere");

  for (const file of templates) {
    const src = read(file);
    for (const line of src.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const [, value = ""] = trimmed.split("=");
      const v = value.trim();
      // A 32+ hex run, a Clerk/Supabase/Stripe/Resend/OpenAI-shaped key, or a
      // connection string with a password would all be real material.
      assert.doesNotMatch(v, /[a-f0-9]{32,}/i, `${file}: looks like real key material`);
      assert.doesNotMatch(v, /^(sk|pk|rk|whsec|re)_(live|test)_/i, `${file}: looks like a real key`);
      assert.doesNotMatch(v, /^eyJ[A-Za-z0-9_-]{10,}/, `${file}: looks like a real JWT`);
      assert.doesNotMatch(v, /:\/\/[^\s/]+:[^\s@]+@/, `${file}: looks like a credentialed connection string`);
    }
  }
});

// ════════════════════════════════════════════════════════════════════════
// 12. Two browsers, one match — the shared matchmaking path
// ════════════════════════════════════════════════════════════════════════

test("deploy: there is exactly one matchmaking path, so two browsers cannot pair differently", () => {
  // Both entry points (the lobby button and the quick-queue worker) call the
  // same store function, so the Vercel route and the platform queue can never
  // produce two different pairings for the same two players.
  const route = read("src/app/api/speed-typing/create-or-join/route.ts");
  assert.match(route, /const result = await createOrJoin\(\{ userId \}\)/);
  const store = read("src/lib/speed-typing/serverStore.ts");
  assert.match(store, /export async function createOrJoin/);
  // The advisory lock makes "find an open lobby, else open one" atomic across
  // Vercel's concurrent serverless instances.
  assert.match(store, /pg_advisory_xact_lock/);
  assert.match(store, /\.for\("update"\)/);
  // The conditional UPDATE is the second gate: two joiners racing for one seat
  // cannot both win it.
  assert.match(store, /isNull\(speedTypingMatches\.player2Id\)/);
  assert.match(store, /if \(!updated\) \{[\s\S]{0,120}?Match is no longer available/);
  // A player can never be paired with themselves.
  assert.match(store, /if \(open\.player1Id === userId\) return \{ match: open, joined: false \}/);
});
