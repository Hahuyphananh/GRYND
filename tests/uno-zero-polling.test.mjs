/**
 * Neon Flush (Uno) online match — ZERO live-game-state polling contract.
 *
 * The online match used to sync via a 2-second `setInterval` that POSTed
 * /api/uno/check-game and overwrote the whole board. It is now event-driven:
 * the acting player relays `lobby:updated` to the per-match room, the opponent
 * refetches once on that hint, and a single recovery read runs on socket
 * reconnect and on tab-visible. This file pins that so the poll cannot creep
 * back.
 *
 * Run:  node --import tsx --test tests/uno-zero-polling.test.mjs
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const PAGE = "src/app/casino/uno/game/[gameId]/PageClient.jsx";
const src = fs.readFileSync(path.join(process.cwd(), PAGE), "utf8");

const countOf = (haystack, needle) => haystack.split(needle).length - 1;

test("the online match has no recurring game-state GET", () => {
  // No interval may be coupled to the state endpoint.
  assert.doesNotMatch(
    src,
    /setInterval\([\s\S]{0,500}?check-game/,
    "no setInterval may poll the game state",
  );
  assert.doesNotMatch(src, /setInterval\(async/, "no async polling interval");
  assert.doesNotMatch(src, /\}, 2000\);/, "the old 2s cadence is gone");
  assert.doesNotMatch(src, /clearInterval\(waitingPollRef/, "the waiting poll is gone");

  // The only setInterval left is the end-of-game replay countdown (a local UI
  // timer, not HTTP).
  assert.equal(countOf(src, "setInterval("), 1, "only the local replay timer remains");
});

test("state sync is relay + reconnect/visible recovery, never a loop", () => {
  // The acting client relays a hint; the receiver refetches once.
  assert.match(src, /socket\.emit\("room_event", \{/);
  assert.match(src, /roomId: `uno:match:\$\{game\.id\}`/);
  assert.match(src, /event: "lobby:updated"/);
  assert.match(src, /socket\.on\("lobby:updated", refresh\)/);
  assert.match(src, /socket\.off\("lobby:updated", refresh\)/);

  // One shared, interval-free recovery path on reconnect + visible.
  assert.match(src, /import \{ startMatchSync \} from "\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/hooks\/useMatchSync"/);
  assert.equal(countOf(src, "startMatchSync("), 2, "match sync + wait-for-start");

  // Every online action pokes the opponent.
  assert.match(src, /const pokeUnoMatch = \(\) => \{/);
  assert.equal(countOf(src, "pokeUnoMatch();"), 3, "play / draw / resign relay");

  // The waiter is told when the match starts instead of polling every 3s.
  assert.match(src, /const roomId = `uno:match:\$\{gameId\}`/);
  assert.match(src, /const stopWaitingForOpponent = \(\) => \{/);
});

test("the authoritative snapshot is still fetched on mount and after each hint", () => {
  // Initial hydration still reads the server once (allowed, required).
  assert.match(src, /credentials: "include",\s*\n\s*body: JSON\.stringify\(\{\s*\n\s*gameId: id,/);
  // The refetch target is the server route, and it is a POST action/hint — the
  // server stays authoritative; nothing is computed on the client.
  assert.match(src, /fetch\("\/api\/uno\/check-game", \{/);
  assert.match(src, /closeToUnoLobby|returnToLobby/);
});
