/**
 * hillstrike-online-ui.test.mjs
 *
 * The contracts the ONLINE Hillstrike surface has to keep — the half of the game
 * that a browser test cannot see cheaply.
 *
 * Three things this file exists to prove:
 *
 *   1. SERVER AUTHORITY IS VISIBLE IN THE TRANSPORT. The match view's only
 *      gameplay request is one engine ACTION (shoot, drive or build) plus
 *      `expectedVersion`; no trajectory, impact, damage, HP, position, turn,
 *      winner or completion flag is ever posted, and nothing on the page decides
 *      who won.
 *   2. THE LIVE CHANNEL IS THE EXISTING ONE. Hillstrike uses the platform's
 *      Socket.IO per-match room vocabulary (`hillstrike:match:<id>`,
 *      `hillstrike:ready`, the generic `lobby:updated` relay) and the realtime
 *      server's existing grace-timer forfeit path — no new realtime service.
 *   3. FREE PRACTICE IS UNTOUCHED AND UNRATED. The vs-AI board is a browser-only
 *      game: it never calls the online routes, so it can never move Elo, a trophy
 *      or a match row.
 *
 * Text-level assertions here are exactly the ones a browser test cannot make:
 * that a forbidden field never appears in a request body, and that a preview is
 * not mistaken for a result.
 *
 * Run:  node --import tsx --test tests/hillstrike-online-ui.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  durationSeconds,
  hpFor,
  hpLabel,
  isIncomingSnapshotStale,
  isTerminalStatus,
  loggedShotLabel,
  outcomeFor,
  resultReasonLabel,
  seatLabel,
  seatName,
  statusLabel,
  turnLabel,
} from "../src/lib/hillstrike/ui.ts";
import {
  HILLSTRIKE_LOBBY_ROOM,
  HILLSTRIKE_MATCH_ROOM_PREFIX,
  HILLSTRIKE_MATCH_UPDATED,
  HILLSTRIKE_READY,
  broadcastMatchUpdate,
  hillstrikeMatchRoom,
} from "../src/lib/hillstrike/rooms.ts";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

/** The same source with `//` and block commentary removed. */
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

const MATCH_PAGE = "src/app/casino/hillstrike/[matchId]/PageClient.tsx";
const MATCH_ROUTE = "src/app/casino/hillstrike/[matchId]/page.tsx";
const LOBBY_PAGE = "src/app/casino/hillstrike/PageClient.tsx";
const LOBBY_ROUTE = "src/app/casino/hillstrike/page.tsx";
const PRACTICE_PAGE = "src/app/casino/hillstrike/play-ai/PageClient.tsx";
const SHOT_ROUTE = "src/app/api/hillstrike/match/[matchId]/shot/route.ts";
const STORE = "src/lib/hillstrike/serverStore.ts";
const UI = "src/lib/hillstrike/ui.ts";
const REALTIME = "realtime-server/server.js";

const page = read(MATCH_PAGE);
const pageCode = stripComments(page);
const lobby = read(LOBBY_PAGE);
const lobbyCode = stripComments(lobby);
const practice = read(PRACTICE_PAGE);
const practiceCode = stripComments(practice);
const shotRoute = read(SHOT_ROUTE);
const store = read(STORE);

/* -------------------------------------------------------------------------- *
 * 1. Server authority is visible in the transport
 * -------------------------------------------------------------------------- */

test("hillstrike online: the only gameplay request is one action plus a version", () => {
  // The whole body. No trajectory, no damage, no HP, no winner.
  assert.ok(
    pageCode.includes("JSON.stringify({ action, expectedVersion: current.version })"),
    "the request must carry exactly the action and the version",
  );
  // The three actions are the entire gameplay vocabulary a client may send.
  for (const shape of [
    'sendAction({ type: "shoot", ...aim })',
    'sendAction({ type: "move", direction })',
    'sendAction({ type: "build" })',
  ]) {
    assert.ok(pageCode.includes(shape), `the view must send ${shape}`);
  }
  for (const forbidden of [
    "winnerId",
    "gameState",
    "impact",
    "hp",
    "lives",
    "damage",
    "terrain",
    "matchCompleted",
    "turn",
  ]) {
    assert.equal(
      new RegExp(`JSON\\.stringify\\(\\{[^}]*\\b${forbidden}\\b`).test(pageCode),
      false,
      `${forbidden} must never be sent by the match view`,
    );
  }
  // The version is read from the snapshot, never invented.
  assert.ok(pageCode.includes("expectedVersion: current.version"));
  // A rejected action is explained from the response, not guessed locally.
  assert.ok(pageCode.includes("data?.error || \"That action was rejected.\""));
});

test("hillstrike online: the view renders the server's snapshot, not its own verdict", () => {
  for (const field of [
    "match?.viewerSeat",
    "match?.opponentSeat",
    "match?.gameState",
    "match?.isViewerTurn",
    "match?.actionsRemaining",
    "match?.openingShotPending",
    "match?.result",
    "match?.winnerId",
    "match?.resultReason",
    "match?.version",
    "match?.seed",
  ]) {
    assert.ok(pageCode.includes(field), `the match view must read ${field}`);
  }
  // The winner is the server's decision — the page never compares a local one.
  assert.equal(/\.winner\s*===/.test(pageCode), false);
  assert.ok(pageCode.includes('String(current.status) !== "playing"'));
  assert.ok(pageCode.includes("!current.isViewerTurn"));
});

test("hillstrike online: the animation is the SERVER's trajectory, and the preview is only a preview", () => {
  // The accepted action's animation is built from the snapshot the server returned.
  assert.ok(pageCode.includes("nextState?.lastAction"), "the resolved action is the snapshot's");
  assert.ok(pageCode.includes('record.type === "shoot"'), "only a shot has a flight to wait for");
  assert.ok(pageCode.includes("from: previousState.battlefield"));
  assert.ok(pageCode.includes("to: nextState.battlefield"));
  assert.ok(pageCode.includes("adopt(data.data.match)"));
  // The one use of the simulator is the dotted aiming preview…
  assert.ok(pageCode.includes("simulateShot({"));
  assert.ok(pageCode.includes("return { path: simulation.path, impact: simulation.impact };"));
  // …and the page never resolves an action itself: only the server does that.
  assert.equal(
    /\bapplyAction\b/.test(pageCode),
    false,
    "the online view must never resolve an action locally",
  );
  assert.equal(
    /\bvalidateAction\b/.test(pageCode),
    false,
    "the online view must not pre-judge an action's legality as truth",
  );
});

test("hillstrike online: the action route reads nothing but the action and the version", () => {
  assert.ok(shotRoute.includes("body?.action"), "the route reads the action");
  assert.ok(shotRoute.includes("expectedVersion: body?.expectedVersion"));
  for (const forbidden of [
    "body.board",
    "body.winner",
    "body.result",
    "body.gameState",
    "body.hp",
    "body.lives",
    "body.damage",
    "body.impact",
    "body.terrain",
    "body.blocks",
    "body.turn",
  ]) {
    assert.equal(
      shotRoute.includes(forbidden),
      false,
      `the action route must ignore ${forbidden}`,
    );
  }
  // The response is the server's resolved action and the new snapshot.
  assert.ok(shotRoute.includes("match: matchToDto(result.match, userId)"));
  assert.ok(shotRoute.includes("action: result.action"));
  assert.ok(shotRoute.includes("broadcastMatchUpdate(matchId"));
});

test("hillstrike online: a stale or duplicated shot can never be applied twice", () => {
  // Client side: monotonic snapshots and a version echoed back with every shot.
  assert.ok(pageCode.includes("isIncomingSnapshotStale"));
  assert.ok(pageCode.includes("expectedVersion"));
  // Server side: the row lock, the required version check and the log index.
  assert.ok(store.includes('.for("update")'));
  assert.ok(store.includes("expectedVersion"));
  assert.ok(store.includes("isUniqueViolation"));
  assert.ok(store.includes("actionIndex"));
  // The store resolves with the shared engine, never with its own maths.
  assert.ok(store.includes("validateAction("));
  assert.ok(store.includes("applyAction("));
});

/* -------------------------------------------------------------------------- *
 * 2. The live channel is the existing realtime mechanism
 * -------------------------------------------------------------------------- */

test("hillstrike online: the room vocabulary matches the realtime server exactly", () => {
  const realtime = read(REALTIME);
  const prefixLiteral = new RegExp(
    `HILLSTRIKE_MATCH_ROOM_PREFIX = "${HILLSTRIKE_MATCH_ROOM_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}";`,
  );
  assert.ok(prefixLiteral.test(realtime), "the realtime server must use the same room prefix");
  assert.equal(HILLSTRIKE_MATCH_ROOM_PREFIX, "hillstrike:match:");
  assert.equal(hillstrikeMatchRoom("abc"), "hillstrike:match:abc");
  // The generic relay event string is the one every other game uses.
  assert.equal(HILLSTRIKE_MATCH_UPDATED, "lobby:updated");
  assert.equal(HILLSTRIKE_READY, "hillstrike:ready");
  assert.equal(HILLSTRIKE_LOBBY_ROOM, "lobby:hillstrike");

  const previousIo = globalThis.io;
  globalThis.io = undefined;
  assert.equal(broadcastMatchUpdate("abc", { status: "playing" }), false);
  globalThis.io = previousIo;
});

test("hillstrike online: the client joins its match room and pokes the opponent", () => {
  assert.ok(pageCode.includes("hillstrikeMatchRoom(matchId)"));
  assert.ok(pageCode.includes('socket.emit("join_room", { roomId })'));
  // Re-joining on reconnect is what cancels the server's grace timer.
  assert.ok(pageCode.includes('socket.on("connect", join)'));
  assert.ok(pageCode.includes("HILLSTRIKE_MATCH_UPDATED"));
  assert.ok(pageCode.includes("socket?.emit(HILLSTRIKE_READY, { matchId })"));
  // A refresh is the reconnect path: the snapshot is re-read, never rebuilt.
  assert.ok(pageCode.includes("cache: \"no-store\""));
});

test("hillstrike online: the lobby asks the server to seat the caller and nothing else", () => {
  assert.ok(
    lobbyCode.includes("JSON.stringify({})"),
    "the matchmaking request carries nothing — Hillstrike is unstaked",
  );
  assert.ok(lobbyCode.includes("/api/hillstrike/create-or-join"));
  assert.ok(lobbyCode.includes("/api/hillstrike/available"));
  // A fresh lobby is a WAIT, not a board: navigation happens only once the
  // server reports the match is playing.
  assert.ok(lobbyCode.includes("setWaitingMatchId(String(data.data.matchId))"));
  assert.ok(lobbyCode.includes("status === MATCH_STATUS.PLAYING"));
  // The free practice route stays one click away and is not the online flow.
  assert.ok(lobbyCode.includes('const PRACTICE_PATH = "/casino/hillstrike/play-ai"'));
  // No stake picker, no money vocabulary.
  for (const banned of ["stake", "wager", "coins", "pot"]) {
    assert.equal(
      new RegExp(`\\b${banned}\\b`, "i").test(lobbyCode),
      false,
      `the lobby must not mention ${banned}`,
    );
  }
});

test("hillstrike online: the routes exist where the views expect them", () => {
  const routes = [
    MATCH_ROUTE,
    LOBBY_ROUTE,
    "src/app/api/hillstrike/create-or-join/route.ts",
    "src/app/api/hillstrike/available/route.ts",
    "src/app/api/hillstrike/disconnect-forfeit/route.ts",
    SHOT_ROUTE,
    "src/app/api/hillstrike/match/[matchId]/forfeit/route.ts",
    "src/app/api/hillstrike/match/[matchId]/cancel/route.ts",
  ];
  for (const path of routes) {
    assert.ok(read(path).length > 200, `${path} must exist`);
  }
  // Both pages are noindex: a lobby is an app, and a live match is behind auth.
  assert.match(read(LOBBY_ROUTE), /index: false/);
  assert.match(read(MATCH_ROUTE), /index: false/);
});

/* -------------------------------------------------------------------------- *
 * 3. Free practice stays separate and unrated
 * -------------------------------------------------------------------------- */

test("hillstrike practice: the vs-AI board never touches the online surface", () => {
  assert.equal(
    /\/api\/hillstrike/.test(practiceCode),
    false,
    "practice must not call any online route",
  );
  assert.equal(/fetch\(/.test(practiceCode), false, "practice needs no network at all");
  assert.ok(practiceCode.includes("chooseAiAction"));
  assert.ok(practiceCode.includes("applyAction"));
  assert.ok(practiceCode.includes("validateAction"));
  assert.ok(practiceCode.includes("createInitialState"));
  // And it is still described as free and unrated.
  assert.match(practice, /Free practice/i);
  assert.match(practice, /no rating/i);
});

/* -------------------------------------------------------------------------- *
 * 4. The view-model helpers
 * -------------------------------------------------------------------------- */

test("ui: seat, status, reason and HP copy", () => {
  assert.equal(seatName("player1"), "Cyan");
  assert.equal(seatName("player2"), "Magenta");
  assert.equal(seatLabel("player1", "player1"), "You");
  assert.equal(seatLabel("player2", "player1"), "Opponent");
  assert.equal(seatLabel(null, "player1"), "—");
  assert.equal(statusLabel("waiting"), "Waiting for an opponent");
  assert.equal(statusLabel("finished"), "Finished");
  assert.equal(statusLabel("nonsense"), "Loading");
  assert.equal(isTerminalStatus("finished"), true);
  assert.equal(isTerminalStatus("playing"), false);
  assert.equal(hpFor({ player1: 62, player2: 100 }, "player1"), 62);
  assert.equal(hpFor({ player1: 0, player2: 100 }, "player1"), 0);
  assert.equal(hpFor({ player2: 100 }, "player1"), 0, "a missing seat reads as zero");
  assert.equal(hpFor({ player1: "nonsense" }, "player1"), 0);
  assert.equal(hpFor(null, "player1"), 0);
  assert.equal(hpFor({ player1: 60 }, null), 0);
  assert.equal(hpLabel(76), "76 HP");
  assert.equal(hpLabel(0), "0 HP");
  assert.equal(hpLabel(-4), "0 HP", "HP is never drawn negative");
  assert.equal(hpLabel("nonsense"), "0 HP");
  assert.equal(
    resultReasonLabel("hp-depleted", "loss"),
    "Your tank was knocked out.",
  );
  assert.equal(
    resultReasonLabel("hp-depleted", "win"),
    "You knocked out your opponent's tank.",
  );
  assert.equal(
    resultReasonLabel("resigned", "win"),
    "Your opponent resigned the match.",
  );
  assert.equal(
    resultReasonLabel("abandoned", "loss"),
    "You left the match and did not return — it was awarded to your opponent.",
  );
});

test("ui: the turn banner follows the server, never a local guess", () => {
  assert.match(turnLabel({ status: "waiting" }), /waiting for an opponent/i);
  assert.match(turnLabel({ status: "cancelled" }), /cancelled/i);
  assert.match(turnLabel({ status: "finished" }), /complete/i);
  assert.match(
    turnLabel({ status: "playing", viewerSeat: "player1", isViewerTurn: true, actionsRemaining: 3 }),
    /3 actions left/i,
  );
  assert.match(
    turnLabel({ status: "playing", viewerSeat: "player1", isViewerTurn: true, actionsRemaining: 1 }),
    /1 action left/i,
    "the singular is used for the last action",
  );
  assert.match(
    turnLabel({
      status: "playing",
      viewerSeat: "player1",
      isViewerTurn: true,
      openingShotPending: true,
      actionsRemaining: 1,
    }),
    /opening turn is a single action/i,
  );
  assert.match(
    turnLabel({
      status: "playing",
      viewerSeat: "player2",
      isViewerTurn: false,
      opponentName: "Alice",
    }),
    /Alice is taking their turn/,
  );
});

test("ui: the outcome comes from the settled row, read against the server's seat", () => {
  assert.equal(
    outcomeFor({ result: "player1", winnerId: "user_a", viewerSeat: "player1", userId: "user_a" }),
    "win",
  );
  assert.equal(
    outcomeFor({ result: "player2", winnerId: "user_b", viewerSeat: "player1", userId: "user_a" }),
    "loss",
  );
  // A guest/hydration case: the seat alone decides, no Clerk id needed.
  assert.equal(
    outcomeFor({ result: "player2", winnerId: null, viewerSeat: "player2", userId: null }),
    "win",
  );
  // Not decided yet.
  assert.equal(
    outcomeFor({ result: null, winnerId: null, viewerSeat: "player1", userId: "user_a" }),
    null,
  );
});

test("ui: monotonic snapshots and bounded durations", () => {
  assert.equal(isIncomingSnapshotStale(null, { version: 1 }), false);
  assert.equal(isIncomingSnapshotStale({ version: 2 }, { version: 1 }), true);
  assert.equal(isIncomingSnapshotStale({ version: 1 }, { version: 2 }), false);
  assert.equal(
    isIncomingSnapshotStale(
      { version: 3, status: "finished" },
      { version: 3, status: "playing" },
    ),
    true,
    "a terminal snapshot is never rolled back",
  );
  assert.equal(
    isIncomingSnapshotStale(
      { version: 3, status: "playing" },
      { version: 3, status: "finished" },
    ),
    false,
  );
  assert.equal(isIncomingSnapshotStale({ version: 1 }, {}), true, "a versionless payload is stale");

  assert.equal(durationSeconds("2026-01-01T00:00:00Z", "2026-01-01T00:01:30Z"), 90);
  assert.equal(durationSeconds(null, "2026-01-01T00:00:00Z"), null);
  assert.equal(durationSeconds("2026-01-01T00:01:00Z", "2026-01-01T00:00:00Z"), null);
});

test("ui: a logged action is described from the server's own row", () => {
  assert.equal(
    loggedShotLabel({ action: "shoot", angleDeg: 44.6, power: 88, impactKind: "player", damage: 21 }),
    "45° at 88% — direct hit, −21 HP",
  );
  assert.equal(
    loggedShotLabel({ action: "shoot", angleDeg: 12, power: 70, impactKind: "block", damage: 0 }),
    "12° at 70% — tower hit",
  );
  assert.equal(
    loggedShotLabel({ action: "shoot", angleDeg: 90, power: 30, impactKind: "out-of-bounds", damage: 0 }),
    "90° at 30% — out of bounds",
  );
  // A drive and a build have no aim, so they are named for what they were.
  assert.equal(loggedShotLabel({ action: "move" }), "drove the tank");
  assert.equal(loggedShotLabel({ action: "build" }), "built a shield block");
  // v1 (lives) rows still read as a hit rather than as an unaimed shot.
  assert.equal(
    loggedShotLabel({ angleDeg: 45, power: 88, impactKind: "player", livesLost: 1 }),
    "45° at 88% — direct hit, one life",
  );
});

test("ui: the view-model module imports no framework, HTTP or database", () => {
  const source = read(UI);
  assert.doesNotMatch(source, /from "react"/);
  assert.doesNotMatch(source, /next\//);
  assert.doesNotMatch(source, /drizzle|db\/client/);
  assert.doesNotMatch(source, /createBattlefield|applyAction|simulateShot/);
});
