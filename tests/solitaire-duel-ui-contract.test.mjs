/**
 * solitaire-duel-ui-contract.test.mjs
 *
 * THE FRONTEND CONTRACT, checked at the source level.
 *
 * The behavioural suites (deck/rules/store/interactions) prove what the game
 * DOES. This one proves the shape of the seams a future edit is most likely to
 * break silently:
 *
 *   1. the routes are thin wrappers over the EXISTING store, and the move route
 *      forwards two fields and nothing else
 *   2. the client cannot submit a winner, a result, a progress figure, a
 *      completion, a score, an Elo value or a trophy — there is no field and no
 *      code path for one
 *   3. the board renders the server's projection and never deals, shuffles or
 *      invents a card
 *   4. the countdown, the timer and the progress all come from server values,
 *      and gameplay is gated on the server's GO instant
 *   5. the realtime vocabulary in src/lib/solitaire-duel/rooms.ts and the
 *      literals in the standalone realtime server cannot drift apart
 *   6. the platform's ad rules still hold for the new routes
 *
 * Run:  node --import tsx --test tests/solitaire-duel-ui-contract.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { GAME_KEY, GAME_ROUTE, VARIANT } from "../src/lib/solitaire-duel/constants.ts";
import {
  SOLITAIRE_DUEL_EVENTS,
  SOLITAIRE_DUEL_MATCH_ROOM_PREFIX,
  solitaireDuelMatchRoom,
} from "../src/lib/solitaire-duel/rooms.ts";

const read = (path) => fs.readFileSync(path, "utf8").replace(/\r\n/g, "\n");
/** Source with comments removed, so prose about a rule can't trip an assertion. */
const code = (path) =>
  read(path)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

const LOBBY_PAGE = "src/app/casino/solitaire-duel/PageClient.tsx";
const LOBBY_ROUTE = "src/app/casino/solitaire-duel/page.tsx";
const MATCH_PAGE = "src/app/casino/solitaire-duel/[matchId]/PageClient.tsx";
const MATCH_PAGE_ROUTE = "src/app/casino/solitaire-duel/[matchId]/page.tsx";
const BOARD = "src/components/solitaire-duel/SolitaireBoard.tsx";
const CARD = "src/components/solitaire-duel/PlayingCard.tsx";
const INTERACTIONS = "src/lib/solitaire-duel/interactions.ts";
const REALTIME_SERVER = "realtime-server/server.js";

const ROUTE_FILES = {
  createOrJoin: "src/app/api/solitaire-duel/create-or-join/route.ts",
  match: "src/app/api/solitaire-duel/match/[matchId]/route.ts",
  move: "src/app/api/solitaire-duel/match/[matchId]/move/route.ts",
  cancel: "src/app/api/solitaire-duel/match/[matchId]/cancel/route.ts",
  forfeit: "src/app/api/solitaire-duel/match/[matchId]/forfeit/route.ts",
  disconnect: "src/app/api/solitaire-duel/disconnect-forfeit/route.ts",
};

// ── 1. The routes are wrappers over the existing store ────────────────────

test("routes: every path exists and is a thin wrapper over the game's store", () => {
  for (const path of Object.values(ROUTE_FILES)) {
    assert.ok(fs.existsSync(path), `${path} must exist`);
  }
  // Every participant-facing route is gated on a verified age-checked session.
  for (const [name, path] of Object.entries(ROUTE_FILES)) {
    if (name === "disconnect") continue;
    assert.match(code(path), /requireAgeVerifiedUser/, `${name} must gate on the session`);
  }
  // The internal disconnect endpoint is not session-gated: the realtime server
  // has no cookie, so it re-verifies the socket's own Clerk token instead.
  assert.match(code(ROUTE_FILES.disconnect), /verifyToken\(token, \{ secretKey: CLERK_SECRET_KEY \}\)/);

  const rules = code(INTERACTIONS);
  assert.match(rules, /from "\.\/rules"/, "the client model reuses the engine");

  const create = code(ROUTE_FILES.createOrJoin);
  assert.match(
    create,
    /import \{ createOrJoin \} from "\.\.\/\.\.\/\.\.\/\.\.\/lib\/solitaire-duel\/serverStore"/,
  );
  assert.match(create, /await createOrJoin\(\{ userId \}\)/);

  const match = code(ROUTE_FILES.match);
  assert.match(match, /fetchMatch/);
  assert.match(match, /isMatchId/);
  // The seat identity is the platform's SHARED resolver, not a new one.
  assert.match(match, /getSeatIdentity/);

  const move = code(ROUTE_FILES.move);
  assert.match(move, /submitMove/);
  assert.match(move, /matchToDto/);

  assert.match(code(ROUTE_FILES.cancel), /cancelMatch/);
  assert.match(code(ROUTE_FILES.forfeit), /forfeitMatch/);
  assert.match(code(ROUTE_FILES.disconnect), /forfeitMatchOnDisconnect/);
});

test("move route: the request is two fields, and nothing else is read", () => {
  const src = code(ROUTE_FILES.move);

  assert.match(src, /move: body\?\.move/);
  assert.match(src, /expectedPly: body\?\.expectedPly/);

  // No result-shaped field is ever read off the request.
  for (const field of [
    "body?.winner",
    "body?.result",
    "body?.progress",
    "body?.completed",
    "body?.score",
    "body?.elo",
    "body?.rating",
    "body?.trophy",
    "body?.status",
    "body?.board",
    "body?.foundations",
    "body?.tableau",
    "body?.view",
    "body?.seat",
  ]) {
    assert.equal(
      src.includes(field),
      false,
      `${field} must never be read by the move route`,
    );
  }
});

// ── 2. The client submits moves and nothing competitive ───────────────────

test("client: the only request body this game sends is a move", () => {
  const src = code(MATCH_PAGE);

  // The one POST that carries gameplay.
  assert.match(src, /body: JSON\.stringify\(\{ move, expectedPly \}\)/);
  // ...and the bare invalidation poke.
  assert.match(src, /SOLITAIRE_DUEL_EVENTS\.READY, \{ matchId \}/);

  // Nothing competitive is ever sent.
  for (const forbidden of [
    "JSON.stringify({ winner",
    "JSON.stringify({ result",
    "JSON.stringify({ score",
    "JSON.stringify({ progress",
    "JSON.stringify({ completed",
    "JSON.stringify({ elo",
    "JSON.stringify({ trophy",
  ]) {
    assert.equal(src.includes(forbidden), false, `${forbidden} must not exist`);
  }
  assert.doesNotMatch(src, /\bwinner:\s/, "the client never names a winner");
  assert.doesNotMatch(src, /\beloDelta\b|\bratingDelta\b|\btrophyDelta\b/);
});

test("client: the outcome, the progress and the clock are the server's", () => {
  const src = code(MATCH_PAGE);

  // The result screen is driven by the snapshot's own verdict...
  assert.match(src, /viewerOutcome\(seat, match\?\.result\)/);
  // ...the progress figures by the DTO's own numbers...
  assert.match(src, /match\?\.progress/);
  assert.match(src, /match\?\.opponent/);
  assert.match(src, /progressLabel\(/);
  // ...and the clock by the server's GO instant and the viewer's OWN
  // inactivity clock, anchored to the server's clock rather than the browser's.
  assert.match(src, /skewRef\.current = serverNow - Date\.now\(\)/);
  assert.match(src, /goAtOverride \?\? match\?\.goAtMs/);
  assert.match(src, /match\?\.inactivityForfeitAtMs/);
  assert.match(src, /match\?\.inactivityAlarmAtMs/);
  // The 15-minute alarm is raised from the server's alarm instant.
  assert.match(src, /solitaire-inactivity-alarm/);
  // The clock is a stopwatch until the last five minutes, then the forfeit
  // countdown — the switch point is driven by the 5-minute threshold.
  assert.match(src, /data-mode=\{countdownActive \? "countdown" : "stopwatch"\}/);
  assert.match(src, /INACTIVITY_COUNTDOWN_MS/);
  assert.match(src, /IconStopwatch/);
  // The opponent's own idle clock is surfaced to the active seat.
  assert.match(src, /match\?\.opponentInactivityAlarmAtMs/);
  assert.match(src, /solitaire-opponent-idle-alarm/);
  // No local winner arithmetic anywhere.
  assert.doesNotMatch(src, /winnerId\s*===.*user\?\.id\s*\?/, "no local winner compare");
});

test("client: gameplay is gated on the server's GO instant, never on mount", () => {
  const src = code(MATCH_PAGE);
  assert.match(
    src,
    /const canPlayNow = phase === "racing" && !expired && !pending/,
    "the board is interactive only while the server says the race is live",
  );
  assert.match(src, /interactive=\{canPlayNow\}/);
  assert.match(src, /if \(phase !== "racing" \|\| expired\) return;/);
  // The countdown is derived from the server's GO instant.
  assert.match(src, /Math\.max\(0, goAtMs - serverNowMs\)/);
});

test("client: a rejected move resyncs rather than keeping a local guess", () => {
  const src = code(MATCH_PAGE);
  assert.match(src, /setNotice\(data\?\.error \|\| "That move was refused"\)/);
  assert.match(src, /void load\(\);/, "a refusal must resync from the server");
  // No optimistic board mutation: the board is only ever set from a snapshot.
  assert.doesNotMatch(src, /applyMove/, "the page never applies a move locally");
  assert.doesNotMatch(src, /setView\(/, "there is no local board state to drift");
});

test("client: a rematch asks the server for a brand new match", () => {
  const src = code(MATCH_PAGE);
  // A rated duel rematches through the lobby queue...
  assert.match(src, /"\/api\/solitaire-duel\/create-or-join"/);
  // ...while a practice match rematches INTO practice, with the same bot tier,
  // rather than dropping an unrated player into the rated queue.
  assert.match(src, /"\/api\/solitaire-duel\/create-ai"/);
  assert.match(src, /matchRef\.current\?\.isAi/);
  // A new match id resets every per-match value, so nothing is inherited.
  assert.match(src, /loadedRef\.current = false;/);
  assert.match(src, /skewRef\.current = 0;/);
  assert.match(src, /queuedDrawsRef\.current = 0;/);
  assert.match(src, /playAgain=\{\{ label: isPractice \? "NEW DEAL" : "REMATCH", onClick: requeue \}\}/);
  // The shared result screen, and the platform's own exit actions.
  assert.match(src, /PvpResultScreen/);
  assert.match(src, /href: "\/casino"/);
  assert.match(src, /router\.push\("\/casino\/solitaire-duel"\)/);
});

test("client: practice offers a restart that asks the server for a new deal", () => {
  const src = code(MATCH_PAGE);
  // The restart is a server call, never a local re-deal: the client cannot
  // produce a solvable deal on its own.
  assert.match(src, /fetch\(`\$\{apiMatch\}\/restart`/);
  assert.match(src, /data-testid="solitaire-restart"/);
  // Practice only — a rated duel must never abandon a live match and re-deal.
  assert.match(src, /const isPractice = Boolean\(match\?\.isAi\)/);
  assert.match(src, /const canRestart = isPractice && !restarting && !leaving/);
  // The new match id arrives from the server's response, not from local state.
  assert.match(src, /router\.push\(`\/casino\/solitaire-duel\/\$\{data\.data\.matchId\}`\)/);
});

// ── 3. The board renders the projection ──────────────────────────────────

test("board: the server's view is rendered as given, never dealt locally", () => {
  const board = code(BOARD);
  const card = code(CARD);

  assert.match(code(MATCH_PAGE), /view=\{view\}/, "the page hands the server's view in");
  assert.match(board, /view: SolitaireView \| null/);
  // The board renders the projection's own tableau, slot for slot.
  assert.match(board, /board\.tableau\?\.\[column\]/);
  assert.match(board, /board\.foundations\?\.\[suit\]/);
  assert.match(board, /board\.stockCount/);
  assert.match(board, /board\.waste/);
  for (const path of [board, card, INTERACTIONS]) {
    assert.doesNotMatch(path, /Math\.random/, "no client randomness anywhere");
    assert.doesNotMatch(path, /dealFromSeed|initialStateFromDeal|seeds/);
    assert.doesNotMatch(path, /from ".*serverStore"/, "the client never imports the store");
  }
  // A face-down position carries no identity, so the card cannot draw one.
  assert.match(card, /if \(!faceUp \|\| !card\)/);
  assert.match(
    board,
    /const card = slot\.faceUp \? slot\.card : null/,
    "a hidden slot must resolve to no card at all",
  );
});

test("board: it proposes moves and owns no competitive state", () => {
  const board = code(BOARD);
  assert.match(board, /onMove: \(move: SolitaireMove\) => void/);
  assert.match(board, /onMove\(result\.move\)/);
  for (const forbidden of ["progressPercent", "foundationCards", "revealedTableau", "winnerId"] ) {
    assert.equal(
      board.includes(forbidden),
      false,
      `the board must not read ${forbidden} — scores belong to the server`,
    );
  }
});

// ── 4. Platform wiring ───────────────────────────────────────────────────

test("platform: the lobby and match routes mount the shared chrome", () => {
  const lobbyRoute = code(LOBBY_ROUTE);
  assert.match(lobbyRoute, /import PageClient from "\.\/PageClient"/);
  assert.match(lobbyRoute, /<PageClient \/>/);
  // The lobby keeps the platform's ad tag...
  assert.match(lobbyRoute, /AdSenseScript/);

  const matchRoute = code(MATCH_PAGE_ROUTE);
  assert.match(matchRoute, /import PageClient from "\.\/PageClient"/);
  assert.match(matchRoute, /return <PageClient \/>;/);
  // ...while a live board must never be framed by an ad.
  assert.doesNotMatch(matchRoute, /AdSenseScript|AdSlot/);

  const lobby = code(LOBBY_PAGE);
  assert.match(lobby, /import PvpLobbyPage from "\.\.\/\.\.\/\.\.\/components\/lobby\/PvpLobby"/);
  assert.match(lobby, /<PvpLobbyPage/);
  assert.match(lobby, /rulesKey="solitaire-duel"/);
  assert.match(lobby, /\/api\/solitaire-duel\/create-or-join/);
  assert.match(lobby, /router\.push\(`\/casino\/solitaire-duel\/\$\{data\.data\.matchId\}`\)/);
});

test("platform: the match page reports through the shared session host", () => {
  const src = code(MATCH_PAGE);
  assert.match(src, /<GameSessionHost/);
  assert.match(src, /gameLabel="solitaire-duel"/);
  assert.match(src, /autoStart=\{status === "playing"\}/);
  assert.match(src, /autoStop=\{terminal\}/);
  // The shared waiting takeover and the shared result screen.
  assert.match(src, /<MatchWaiting/);
  assert.match(src, /<PvpResultScreen/);
  // The platform's one socket provider.
  assert.match(src, /useSocket/);
  assert.match(src, /solitaireDuelMatchRoom\(matchId\)/);
});

test("platform: no gambling surface exists anywhere in the game", () => {
  const clientFiles = [LOBBY_PAGE, MATCH_PAGE, BOARD, CARD];
  for (const path of clientFiles) {
    // The rules copy DENIES gambling in words, so those negations are removed
    // before the mechanical scan — what is left must contain no mechanic at all.
    const src = code(path)
      .toLowerCase()
      .replace(/no (wagers|betting|tokens|payouts|stake|balance)\.?/g, "");
    // No stake, pot, balance or payout MECHANIC — and no token economy.
    for (const forbidden of [
      "betamount",
      "stakeamount",
      "payout",
      "balance",
      "houseedge",
      "deposit",
      "escrow",
    ]) {
      assert.equal(
        src.includes(forbidden),
        false,
        `${path} must not carry a ${forbidden} concept`,
      );
    }
  }
  // The only place the word appears is the copy that DENIES it, which is the
  // product rule this game is built around.
  const lobby = code(LOBBY_PAGE);
  assert.match(lobby, /no wagers, no betting, no tokens and no payouts/i);
  assert.doesNotMatch(lobby, /place a bet|bet amount|wager amount|stake amount/i);
});

// ── 5. The realtime vocabulary cannot drift ──────────────────────────────

test("realtime: the room prefix and the event names match the server", () => {
  assert.equal(GAME_KEY, "solitaire-duel");
  assert.equal(GAME_ROUTE, "/casino/solitaire-duel");
  assert.equal(VARIANT, "klondike-1");
  assert.equal(SOLITAIRE_DUEL_MATCH_ROOM_PREFIX, "solitaire-duel:match:");
  assert.equal(solitaireDuelMatchRoom("abc"), "solitaire-duel:match:abc");
  assert.equal(SOLITAIRE_DUEL_EVENTS.MATCH_UPDATED, "lobby:updated");

  const server = code(REALTIME_SERVER);
  // The standalone server is plain CommonJS and restates the literal; the two
  // must agree or the live channel silently breaks.
  assert.match(server, new RegExp(`"${SOLITAIRE_DUEL_MATCH_ROOM_PREFIX}"`));
  assert.match(server, new RegExp(`"${SOLITAIRE_DUEL_EVENTS.READY}"`));
  assert.match(server, /trackSolitaireDuelJoin\(String\(roomId\), socket\.data\.userId\)/);
  assert.match(server, /trackSolitaireDuelLeave\(String\(roomId\), socket\.data\.userId\)/);
  // A dropped socket settles through the game's own endpoint, after a grace
  // window a reconnect cancels.
  assert.match(server, /\/api\/solitaire-duel\/disconnect-forfeit/);
  assert.match(server, /cancelDisconnectGraceTimer\(`solitaire-duel:\$\{matchId\}:\$\{userId\}`\)/);
});

test("realtime: the server broadcasts only DERIVED opponent numbers", () => {
  const realtime = code("src/lib/solitaire-duel/realtime.ts");
  // The one place an opponent payload is built is the engine's own projection.
  assert.match(realtime, /opponentProgressFor\(seat, state\)/);
  assert.match(realtime, /import \{ opponentProgressFor \} from "\.\/rules"/);
  // Coalesced, so a foundation run cannot become a broadcast storm.
  assert.match(realtime, /PROGRESS_BROADCAST_MIN_MS/);
});

// ── 6. Names and copy ───────────────────────────────────────────────────

test("copy: the routes state the format", () => {
  assert.match(read(LOBBY_ROUTE), /title: "Solitaire Duel \| GRYND"/);
  const lobbyDescription = read(LOBBY_ROUTE);
  for (const trait of [/exact same/i, /klondike/i, /no wagers/i]) {
    assert.match(lobbyDescription, trait);
  }
  const matchRoute = read(MATCH_PAGE_ROUTE);
  assert.match(matchRoute, /title: "Solitaire Duel Match \| GRYND"/);
  assert.match(matchRoute, /same Klondike deal/i);
});
