/**
 * barricade-online-ui.test.mjs
 *
 * The contracts the ONLINE Barricade surface has to keep — the half of the game
 * that a browser test cannot see cheaply.
 *
 * Three things this file exists to prove:
 *
 *   1. SERVER AUTHORITY IS VISIBLE IN THE TRANSPORT. The match view's only
 *      gameplay request is an action ADDRESS plus `expectedVersion`; no board,
 *      pawn, reserve, turn, winner or result is ever posted, and nothing on the
 *      page decides who won.
 *   2. THE LIVE CHANNEL IS THE EXISTING ONE. Barricade uses the platform's
 *      Socket.IO per-match room vocabulary (`barricade:match:<id>`,
 *      `barricade:ready`, the generic `lobby:updated` relay) and the realtime
 *      server's existing grace-timer forfeit path — no new realtime service.
 *   3. THE FREE PRACTICE SURFACE IS UNTOUCHED and Barricade stays unstaked.
 *
 * Text-level assertions here are exactly the ones a browser test cannot make:
 * that a forbidden field never appears in a request body, that the room-name
 * literals in the TypeScript vocabulary and in the plain CommonJS realtime
 * server still agree, and that the migration is idempotent and money-free.
 *
 * Run:  node --import tsx --test tests/barricade-online-ui.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

import {
  isIncomingSnapshotStale,
  isTerminalStatus,
  loggedActionLabel,
  outcomeFor,
  resultReasonLabel,
  seatLabel,
  seatName,
  statusLabel,
  turnLabel,
  wallInventoryLabel,
  wallsFor,
} from "../src/lib/barricade/ui.ts";
import {
  BARRICADE_LOBBY_ROOM,
  BARRICADE_MATCH_ROOM_PREFIX,
  BARRICADE_MATCH_UPDATED,
  BARRICADE_READY,
  barricadeMatchRoom,
  broadcastMatchUpdate,
} from "../src/lib/barricade/rooms.ts";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

/** The same source with `//` and `/* … *​/` commentary removed. */
function stripComments(source) {
  let out = "";
  let index = 0;
  while (index < source.length) {
    if (source.startsWith("/*", index)) {
      const end = source.indexOf("*/", index + 2);
      index = end === -1 ? source.length : end + 2;
      continue;
    }
    if (source.startsWith("//", index)) {
      const end = source.indexOf("\n", index);
      index = end === -1 ? source.length : end + 1;
      continue;
    }
    out += source[index];
    index += 1;
  }
  return out;
}

const MATCH_PAGE = "src/app/casino/barricade/[matchId]/PageClient.tsx";
const MATCH_ROUTE = "src/app/casino/barricade/[matchId]/page.tsx";
const LOBBY_PAGE = "src/app/casino/barricade/PageClient.tsx";
const LOBBY_ROUTE = "src/app/casino/barricade/page.tsx";
const PRACTICE_PAGE = "src/app/casino/barricade/play-ai/PageClient.tsx";
const MOVE_ROUTE = "src/app/api/barricade/match/[matchId]/move/route.ts";
const REALTIME = "realtime-server/server.js";
const MIGRATION = "src/db/migrations/0207_barricade_pvp.sql";

const page = read(MATCH_PAGE);
const pageCode = stripComments(page);
const lobby = read(LOBBY_PAGE);
const lobbyCode = stripComments(lobby);
const practice = read(PRACTICE_PAGE);
const moveRoute = read(MOVE_ROUTE);
const realtime = read(REALTIME);
const migration = read(MIGRATION);
/** The migration's SQL with both comment styles removed. */
const migrationSql = stripComments(migration)
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("--"))
  .join("\n");
const schema = read("src/db/schema.ts");

/* -------------------------------------------------------------------------- *
 * 1. Server authority is visible in the transport
 * -------------------------------------------------------------------------- */

test("barricade online: the only gameplay request is an address plus a version", () => {
  // The whole body. No mark, no board, no reserve, no turn, no winner.
  assert.ok(
    pageCode.includes("JSON.stringify({ action, expectedVersion })"),
    "the move request must carry exactly the action address and the version",
  );
  // Nothing a client might be tempted to claim may appear in a request body.
  for (const forbidden of ["winnerId", "gameState", "wallsRemaining", "expectedTurn"]) {
    assert.equal(
      new RegExp(`JSON\\.stringify\\(\\{[^}]*\\b${forbidden}\\b`).test(pageCode),
      false,
      `${forbidden} must never be sent by the match view`,
    );
  }
  // The version is read from the snapshot, never invented.
  assert.ok(pageCode.includes("const expectedVersion = current.version"));
});

test("barricade online: the view renders the server's snapshot, not its own verdict", () => {
  for (const field of [
    "match?.viewerSeat",
    "match?.opponentSeat",
    "match?.gameState",
    "match?.isViewerTurn",
    "match?.wallsRemaining",
    "match?.result",
    "match?.winnerId",
    "match?.resultReason",
    "match?.ply",
  ]) {
    assert.ok(pageCode.includes(field), `the match view must read ${field}`);
  }
  // The winner is the server's decision — the page never compares a local one.
  assert.equal(/\.winner\s*===/.test(pageCode), false);
  assert.ok(pageCode.includes('String(current.status) !== "playing"'));
  assert.ok(pageCode.includes("!current.isViewerTurn"));
});

test("barricade online: the move route reads nothing but the action and the version", () => {
  // Shape-checked imports and the two fields it forwards.
  assert.ok(moveRoute.includes("action: body?.action"));
  assert.ok(moveRoute.includes("expectedVersion: body?.expectedVersion"));
  for (const forbidden of ["body.board", "body.winner", "body.result", "body.gameState", "body.turn"]) {
    assert.equal(
      moveRoute.includes(forbidden),
      false,
      `the move route must ignore ${forbidden}`,
    );
  }
  // The action is validated by the shared engine inside the store's transaction.
  assert.ok(moveRoute.includes("broadcastMatchUpdate(matchId"));
});

test("barricade online: a stale or duplicated action can never be applied twice", () => {
  // Client side: monotonic snapshots and a version echoed back with every action.
  assert.ok(pageCode.includes("isIncomingSnapshotStale"));
  assert.ok(pageCode.includes("expectedVersion"));
  // Server side: the row lock, the version check and the structural log index.
  const store = read("src/lib/barricade/serverStore.ts");
  assert.ok(store.includes('.for("update")'));
  assert.ok(store.includes("expectedVersion"));
  assert.ok(
    store.includes("isUniqueViolation"),
    "a replayed ply must be reported as a clean conflict, not a 500",
  );
});

/* -------------------------------------------------------------------------- *
 * 2. The live channel is the existing realtime mechanism
 * -------------------------------------------------------------------------- */

test("barricade online: the room vocabulary matches the realtime server exactly", () => {
  // The TypeScript vocabulary and the plain CommonJS server restate the same
  // literals (the server cannot import TypeScript) — this is the pin.
  const prefixLiteral = new RegExp(
    `BARRICADE_MATCH_ROOM_PREFIX\\s*=\\s*"${BARRICADE_MATCH_ROOM_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`,
  );
  assert.ok(prefixLiteral.test(realtime), "the realtime server must use the same room prefix");
  assert.equal(BARRICADE_MATCH_ROOM_PREFIX, "barricade:match:");
  assert.equal(barricadeMatchRoom("abc"), "barricade:match:abc");
  // The generic relay event string is the one every other game uses, so the
  // existing `room_event` relay routes it with no server change.
  assert.equal(BARRICADE_MATCH_UPDATED, "lobby:updated");
  assert.equal(BARRICADE_READY, "barricade:ready");
  assert.equal(BARRICADE_LOBBY_ROOM, "lobby:barricade");
});

test("barricade online: the client joins its match room and pokes the opponent", () => {
  assert.ok(pageCode.includes("barricadeMatchRoom(matchId)"));
  assert.ok(pageCode.includes('socket.emit("join_room", { roomId })'));
  // Re-joining on reconnect is what cancels the server's grace timer.
  assert.ok(pageCode.includes('socket.on("connect", join)'));
  assert.ok(pageCode.includes("BARRICADE_MATCH_UPDATED"));
  assert.ok(pageCode.includes("BARRICADE_READY"));
  // Polling stays the backstop, and a hidden tab issues no reads.
  assert.ok(pageCode.includes("document.hidden"));
  assert.ok(pageCode.includes("ACTIVE_POLL_MS"));
});

test("barricade online: disconnects resolve through the existing grace-timer path", () => {
  // The realtime server tracks participants and schedules the forfeit…
  for (const needle of [
    "trackBarricadeJoin",
    "trackBarricadeLeave",
    'socket.on("barricade:ready"',
    "barricadeRoomParticipants",
    "cancelDisconnectGraceTimer(`barricade:${matchId}:${userId}`)",
    "scheduleDisconnectGraceTimer(`barricade:${mid}:${socket.data.userId}`",
  ]) {
    assert.ok(realtime.includes(needle), `the realtime server must wire ${needle}`);
  }
  // …and calls the existing Next.js endpoint, not a new service.
  assert.ok(realtime.includes("/api/barricade/disconnect-forfeit"));
  const disconnectRoute = read("src/app/api/barricade/disconnect-forfeit/route.ts");
  assert.ok(disconnectRoute.includes("verifyToken"), "the caller's token is re-verified");
  assert.ok(disconnectRoute.includes("forfeitMatchOnDisconnect"));
  // The ready poke is participant-gated, like every other game's.
  assert.ok(realtime.includes('"barricade:rejectReady"'));
});

test("barricade online: every gameplay route is behind the age-verified account gate", () => {
  const routes = [
    "src/app/api/barricade/create-or-join/route.ts",
    "src/app/api/barricade/available/route.ts",
    "src/app/api/barricade/match/[matchId]/route.ts",
    "src/app/api/barricade/match/[matchId]/move/route.ts",
    "src/app/api/barricade/match/[matchId]/forfeit/route.ts",
    "src/app/api/barricade/match/[matchId]/cancel/route.ts",
  ];
  for (const route of routes) {
    assert.ok(existsSync(new URL(`../${route}`, import.meta.url)), `${route} must exist`);
    assert.ok(read(route).includes("requireAgeVerifiedUser"), `${route} must be gated`);
  }
  // A non-uuid id is refused before it can reach a Postgres uuid cast.
  assert.ok(read(routes[2]).includes("isMatchId(matchId)"));
  // Barricade online has no spectator mode.
  assert.ok(read(routes[2]).includes("fetchMatch"));
});

/* -------------------------------------------------------------------------- *
 * 3. Direct match creation and joining, without public matchmaking
 * -------------------------------------------------------------------------- */

test("barricade online: the lobby creates, joins and cancels, and stays unlisted", () => {
  assert.ok(lobbyCode.includes('fetch("/api/barricade/create-or-join"'));
  assert.ok(lobbyCode.includes('fetch("/api/barricade/available"'));
  assert.ok(lobbyCode.includes("/cancel`"));
  // The proxy rejects a bodyless POST without a JSON content-type (415).
  assert.ok(lobbyCode.includes('headers: { "Content-Type": "application/json" }'));
  // Online play needs a real account; practice is the guest path.
  assert.ok(lobbyCode.includes("canPlay={Boolean(isSignedIn)}"));
  assert.ok(lobbyCode.includes("onResume"));
  // Barricade is unstaked: no wager/balance surface is wired into the lobby.
  for (const money of ["wager:", "wagerAmount", "stake:", "balance", "stakes"]) {
    assert.equal(lobbyCode.includes(money), false, `the lobby must have no ${money}`);
  }
  // Both new pages are noindex, so they are not advertised as landing pages.
  for (const route of [LOBBY_ROUTE, MATCH_ROUTE]) {
    assert.ok(read(route).includes("index: false"), `${route} must be noindex`);
  }
});

test("barricade online: the lobby URLs are the ones that actually resolve", () => {
  // Bare /casino/barricade permanently redirects to the public landing page
  // /games/barricade, and Barricade has no landing page yet (its catalogue entry
  // is a separate, later change) — so every lobby link must use the canonical
  // lobby URL, which is rewritten to /casino/barricade internally. The browser
  // smoke check (qa/barricade-online-browser-check.mjs) walks this in a real tab.
  assert.ok(practice.includes('const ONLINE_PATH = "/games/barricade/play"'));
  assert.ok(page.includes('const LOBBY_PATH = "/games/barricade/play"'));
  assert.equal(
    /push\("\/casino\/barricade"\)/.test(practice + page),
    false,
    "a bare /casino/barricade link would 404 through the landing-page redirect",
  );
  // A match URL keeps the house convention (/casino/<slug>/<id>), which is what
  // 308-redirects to /games/<slug>/<id> and rewrites back to the match view.
  assert.ok(lobbyCode.includes("router.push(`/casino/barricade/${data.data.matchId}`)"));
});

test("barricade online: a signed-out visitor never polls an account-gated route", () => {
  // The lobby list needs an account, so the poll is gated rather than left to
  // hammer a 401 every few seconds on a route a signed-out visitor can read.
  assert.ok(lobbyCode.includes("useSocketAwarePoll(fetchLobbies, socket, Boolean(isSignedIn))"));
  // The match view is told to sign in instead of polling the snapshot.
  assert.ok(pageCode.includes('signedOut = identityLoaded && !user'));
  assert.ok(pageCode.includes('setLoadError("Sign in to play this Barricade match.")'));
  // The list does not sit on its loading skeleton forever without an account.
  assert.ok(lobbyCode.includes("if (isSignedIn === false) setLobbiesLoading(false);"));
});

test("barricade online: free practice still works exactly as before", () => {
  // Practice remains entirely client-side: no fetch, no API, no socket.
  const practiceCode = stripComments(practice);
  for (const network of ["fetch(", "/api/", "socket.io", "useSWR"]) {
    assert.equal(
      practiceCode.includes(network),
      false,
      `free practice must stay offline (${network})`,
    );
  }
  assert.ok(practiceCode.includes("createInitialState"), "practice keeps its own engine loop");
  assert.ok(practiceCode.includes("chooseAiAction"), "practice keeps its own bot");
  // The online duel is one navigation away, and nothing else about practice changed.
  assert.ok(practiceCode.includes("router.push(ONLINE_PATH)"));
  assert.ok(practiceCode.includes('const ONLINE_PATH = "/games/barricade/play"'));
});

test("barricade online: Dice Flush is untouched and no other game was modified", () => {
  // Dice Flush still exists, still has its lobby and its API.
  assert.ok(existsSync(new URL("../src/app/casino/dice-flush", import.meta.url)));
  assert.ok(existsSync(new URL("../src/app/casino/dice-flush/page.tsx", import.meta.url)));
  assert.ok(existsSync(new URL("../src/app/api/dice-flush", import.meta.url)));
  // Nothing Barricade-related leaked into another game's store or UI.
  for (const file of [
    "src/lib/dice-flush/serverStore.js",
    "src/lib/tic-tac-toe/serverStore.ts",
    "src/app/casino/dice-flush/PageClient.tsx",
  ]) {
    if (!existsSync(new URL(`../${file}`, import.meta.url))) continue;
    const source = stripComments(read(file));
    assert.equal(
      /barricade/i.test(source),
      false,
      `${file} must not reference Barricade`,
    );
  }
});

/* -------------------------------------------------------------------------- *
 * 4. Persistence: an idempotent, money-free, anti-replay schema
 * -------------------------------------------------------------------------- */

test("barricade online: the schema declares the match row and the replay log", () => {
  assert.ok(schema.includes('"barricade_matches"'));
  assert.ok(schema.includes('"barricade_moves"'));
  assert.ok(
    schema.includes('unique("barricade_moves_ply_unique").on(table.matchId, table.ply)'),
    "one persisted action per turn number must be a storage invariant",
  );
  // No money columns anywhere in the model — only the Barricade block is read.
  const block = schema.slice(
    schema.indexOf("export const barricadeMatches"),
    schema.indexOf("export const solitaireDuelMatches"),
  );
  assert.ok(
    block.includes('"barricade_moves"') && block.includes('"barricade_matches"'),
    "the block must be the Barricade one",
  );
  assert.equal(/wager|stake|payout|prize|pot_amount/i.test(stripComments(block)), false);
});

test("barricade online: the migration is idempotent, constrained and money-free", () => {
  assert.ok(migrationSql.includes("CREATE TABLE IF NOT EXISTS \"barricade_matches\""));
  assert.ok(migrationSql.includes("CREATE TABLE IF NOT EXISTS \"barricade_moves\""));
  assert.ok(migrationSql.includes("CREATE UNIQUE INDEX IF NOT EXISTS"));
  assert.ok(
    migrationSql.includes("\"match_id\", \"ply\""),
    "the replay log needs the unique (match_id, ply) index",
  );
  assert.ok(migrationSql.includes("REFERENCES \"barricade_matches\"(\"id\") ON DELETE CASCADE"));
  assert.equal(
    /wager|stake|payout|prize|token/i.test(migrationSql),
    false,
    "Barricade must not introduce a money column",
  );
  // The journal records it, so `npm run db:migrate` applies it.
  const journal = JSON.parse(read("src/db/migrations/meta/_journal.json"));
  assert.ok(journal.entries.some((entry) => entry.tag === "0207_barricade_pvp"));
});

/* -------------------------------------------------------------------------- *
 * 5. The pure view-model helpers
 * -------------------------------------------------------------------------- */

test("barricade ui: the lifecycle and turn copy follow the server's status", () => {
  assert.equal(statusLabel("waiting"), "Waiting for an opponent");
  assert.equal(statusLabel("playing"), "In progress");
  assert.equal(statusLabel("finished"), "Finished");
  assert.equal(statusLabel("cancelled"), "Cancelled");
  assert.equal(statusLabel(undefined), "Loading");

  assert.match(turnLabel({ status: "waiting" }), /waiting for an opponent/i);
  assert.match(
    turnLabel({ status: "playing", isViewerTurn: true, viewerSeat: "player1" }),
    /your turn/i,
  );
  assert.equal(
    turnLabel({
      status: "playing",
      isViewerTurn: false,
      viewerSeat: "player1",
      opponentName: "Bob",
    }),
    "Bob is deciding…",
  );
  assert.match(turnLabel({ status: "playing", isViewerTurn: false }), /loading/i);

  assert.equal(isTerminalStatus("finished"), true);
  assert.equal(isTerminalStatus("cancelled"), true);
  assert.equal(isTerminalStatus("playing"), false);
});

test("barricade ui: the outcome comes from the settled result, per viewer", () => {
  assert.equal(
    outcomeFor({ result: "player1", winnerId: "u1", viewerSeat: "player1", userId: "u1" }),
    "win",
  );
  assert.equal(
    outcomeFor({ result: "player2", winnerId: "u2", viewerSeat: "player1", userId: "u1" }),
    "loss",
  );
  // The seat is authoritative when it is known; the winner id is the fallback.
  assert.equal(outcomeFor({ winnerId: "u1", viewerSeat: null, userId: "u1" }), "win");
  assert.equal(outcomeFor({ result: null, winnerId: null, viewerSeat: "player1" }), null);
  assert.equal(outcomeFor({ result: "player1", viewerSeat: null }), null);

  assert.match(resultReasonLabel("resigned", "win"), /opponent resigned/i);
  assert.match(resultReasonLabel("abandoned", "loss"), /you left/i);
  assert.match(resultReasonLabel("reached-baseline", "win"), /far baseline/i);
  assert.equal(seatName("player1"), "Blue");
  assert.equal(seatName("player2"), "Purple");
  assert.equal(seatLabel("player2", "player2"), "You");
  assert.equal(seatLabel("player2", "player1"), "Opponent");
});

test("barricade ui: a stale snapshot can never roll the board back", () => {
  const live = { version: 4, status: "playing" };
  assert.equal(isIncomingSnapshotStale(live, { version: 3, status: "playing" }), true);
  assert.equal(isIncomingSnapshotStale(live, { version: 5, status: "playing" }), false);
  assert.equal(isIncomingSnapshotStale(live, { version: 4, status: "playing" }), false);
  // A same-version terminal snapshot must survive a live re-poll.
  assert.equal(
    isIncomingSnapshotStale({ version: 4, status: "finished" }, { version: 4, status: "playing" }),
    true,
  );
  // A malformed payload is not a newer truth.
  assert.equal(isIncomingSnapshotStale(live, { status: "playing" }), true);
  assert.equal(isIncomingSnapshotStale(null, { version: 1, status: "playing" }), false);
});

test("barricade ui: the log and the reserves are read from the server's own columns", () => {
  assert.equal(loggedActionLabel({ actionType: "move", col: 4, row: 1 }), "Pawn to row 2, column 5");
  assert.equal(
    loggedActionLabel({ actionType: "wall", col: 0, row: 0, orientation: "horizontal" }),
    "Barricade — between rows 1 and 2, columns 1–2",
  );
  assert.equal(
    loggedActionLabel({ actionType: "wall", col: 3, row: 2, orientation: "vertical" }),
    "Barricade — between columns 4 and 5, rows 3–4",
  );
  assert.equal(wallInventoryLabel(10), "10 barricades left");
  assert.equal(wallInventoryLabel(1), "1 barricade left");
  assert.equal(wallsFor({ player1: 7, player2: 3 }, "player2"), 3);
  assert.equal(wallsFor(null, "player1"), 0);
  assert.equal(wallsFor({ player1: 7 }, "player2"), 0);
});

test("barricade rooms: a broadcast without a live io instance is a safe no-op", () => {
  // The API route must never fail because the socket fan-out is unreachable
  // (the split-process deployment has no shared `io`).
  assert.equal(broadcastMatchUpdate("11111111-1111-4111-8111-111111111111", { a: 1 }), false);
});
