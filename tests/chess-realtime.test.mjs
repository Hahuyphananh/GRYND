/**
 * Chess — event-driven state sync contract.
 *
 * Chess gameplay used to poll `/api/chess/game-state?gameId=…` every 2s. It is
 * now event-driven: a move is still written by the authoritative
 * `POST /api/chess/move`, the resulting `chess_moves` row is published to
 * Supabase Realtime, and both players apply it with no recurring HTTP read.
 * Transitions a move row cannot express arrive as a Socket.IO `chess:state`
 * room "poke" that triggers ONE authoritative fetch.
 *
 * These are source-contract tests: the behaviour lives inside a React
 * component and a SQL migration, so the exact strings and the migration's
 * publish list are pinned here.
 *
 * Run:  node --import tsx --test tests/chess-realtime.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (p) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");

const pvp = read("src/app/casino/chess-game/[gameId]/PageClient.jsx");
const waiting = read("src/app/casino/chess/[tableAmount]/PageClient.jsx");
const migration = read("src/db/migrations/0205_realtime_publish_chess_moves.sql");
const journal = JSON.parse(read("src/db/migrations/meta/_journal.json"));

// ── 1. The recurring poll is gone ──────────────────────────────────────────

test("the chess game page no longer polls game-state on an interval", () => {
  // The old loop was `setInterval(() => { … fetchState() }, 2000)`.
  assert.ok(
    !pvp.includes("}, 2000)"),
    "no 2000ms interval may remain on the chess game page",
  );
  assert.ok(
    !/setInterval\([^)]*fetchState/.test(pvp),
    "fetchState must never be driven by an interval",
  );
  // fetchState must not be scheduled by any timer.
  assert.ok(
    !pvp.includes("setInterval(() => {\n      if (cancelled) return;"),
    "the old polling effect must be gone",
  );
});

test("exactly one authoritative game-state read happens on load", () => {
  // ONE-shot fetch on mount…
  assert.ok(
    pvp.includes("void fetchStateRef.current?.();"),
    "an initial authoritative fetch must run once on load",
  );
  // …through the same endpoint that stays a valid fallback/debug route.
  assert.ok(
    pvp.includes("/api/chess/game-state?gameId="),
    "the authoritative game-state endpoint must still be used",
  );
});

test("the local clock ticker is preserved (UI only, not a network poll)", () => {
  assert.ok(
    pvp.includes("setInterval(() => setClockNow(Date.now()), 1000)"),
    "the 1s local clock is pure UI computation and must stay",
  );
});

// ── 2. Moves still go through the authoritative API ────────────────────────

test("moves are still sent through POST /api/chess/move", () => {
  assert.ok(
    pvp.includes('fetch("/api/chess/move"'),
    "the authoritative move route must remain the only way to move",
  );
  for (const route of ["game-state", "move", "end-game"]) {
    assert.ok(
      fs.existsSync(`src/app/api/chess/${route}/route.js`),
      `the authoritative /api/chess/${route} route must be kept`,
    );
  }
});

// ── 3. The realtime move stream ────────────────────────────────────────────

test("the page subscribes to chess_moves INSERTs scoped to this game", () => {
  assert.ok(pvp.includes("useRealtimeSubscription({"), "must use the shared hook");
  assert.ok(pvp.includes('table: "chess_moves"'), "must subscribe to chess_moves");
  assert.ok(pvp.includes('event: "INSERT"'), "only appended moves are events");
  assert.ok(
    pvp.includes("filter: `game_id=eq.${gameId}`"),
    "the subscription must be scoped to this game",
  );
  assert.ok(
    pvp.includes("enabled: Boolean(gameId) && !gameFinished"),
    "the channel must close once the game is finished",
  );
});

test("a duplicate realtime delivery is a no-op", () => {
  assert.ok(
    pvp.includes("appliedMoveIdRef"),
    "the highest applied move id must be tracked",
  );
  assert.match(
    pvp,
    /if \(moveId <= appliedMoveIdRef\.current\) return;/,
    "a move id already applied must be ignored",
  );
});

test("the finished game stops the realtime subscription", () => {
  assert.match(
    pvp,
    /setGameFinished\(true\)/,
    "the finished state must be mirrored into React state",
  );
});

// ── 4. The transition "poke" ───────────────────────────────────────────────

test("transitions the move stream cannot express arrive as a chess:state poke", () => {
  assert.ok(
    pvp.includes("roomId: `chess:game:${gameId}`") &&
      pvp.includes('event: "chess:state"'),
    "the page must join/emit the per-game poke room",
  );
  assert.ok(
    pvp.includes('socket.on("chess:state", handleStatePoke)'),
    "the page must act on the opponent's poke",
  );
  // A poke triggers ONE authoritative fetch, never a poll.
  assert.match(
    pvp,
    /const handleStatePoke = \(\) => scheduleRefresh\(\);/,
    "a poke must reconcile exactly once",
  );
  // On mount the page announces its arrival once, so an already-waiting host
  // learns the opponent joined (the move stream cannot express that).
  assert.ok(
    pvp.includes(
      'socket.emit("room_event", { roomId: stateRoomId, event: "chess:state" })',
    ),
    "mounting the game must poke the per-game state room once",
  );
});

// ── 5. The matchmaking waiting page ────────────────────────────────────────

test("the waiting page no longer polls game-state every 2s", () => {
  assert.ok(
    !waiting.includes("}, 2000)"),
    "no 2000ms interval may remain on the waiting page",
  );
  assert.ok(
    !waiting.includes("pollIntervalRef"),
    "the poll interval ref must be gone",
  );
});

test("the waiting page reacts to the lobby push with one authoritative read", () => {
  assert.ok(
    waiting.includes('roomId = "lobby:chess"'),
    "it must join the chess lobby room the joiner pushes to",
  );
  assert.ok(
    waiting.includes('socket.on("lobby:updated", handleLobbyUpdate)'),
    "the joiner's lobby:updated hint must be handled",
  );
  assert.ok(
    waiting.includes("/api/chess/game-state?gameId=${activeGameId}"),
    "the hint must drive ONE authoritative game-state read",
  );
  // Matchmaking itself is untouched: the same routes still create/cancel.
  assert.ok(waiting.includes('fetch("/api/chess/create-game"'));
  assert.ok(waiting.includes('fetch("/api/chess/cancel-game"'));
});

// ── 6. The publication migration ───────────────────────────────────────────

test("0205 is registered in the drizzle journal with an ordered timestamp", () => {
  const entry = journal.entries.find(
    (e) => e.tag === "0205_realtime_publish_chess_moves",
  );
  assert.ok(entry, "0205 must be in _journal.json or db:migrate skips it");
  assert.equal(
    entry.idx,
    journal.entries.findIndex((e) => e.tag === entry.tag),
    "idx must match the entry's position",
  );
  assert.equal(entry.version, journal.version);
  const prev = journal.entries[entry.idx - 1];
  assert.ok(prev && entry.when > prev.when, "timestamps must stay ordered");
});

test("0205 publishes ONLY chess_moves", () => {
  const arrays = [
    ...migration.matchAll(/target_tables text\[\] := ARRAY\[([^\]]+)\]/g),
  ].map((m) =>
    m[1]
      .split(",")
      .map((s) => s.trim().replace(/^'|'$/g, ""))
      .filter(Boolean),
  );
  assert.ok(arrays.length >= 1, "the publication block must list the table");
  for (const list of arrays) {
    assert.deepEqual(list, ["chess_moves"]);
  }
  // The read policy must exist, or Realtime delivers nothing under RLS.
  assert.match(migration, /CREATE POLICY realtime_public_read ON public\.chess_moves/);
});

test("0205 never publishes the staked chess_games row", () => {
  // chess_games carries bet_amount / payout / player ids — the migration's
  // prose may mention it, but it must never appear in a target list.
  const arrays = [
    ...migration.matchAll(/target_tables text\[\] := ARRAY\[([^\]]+)\]/g),
  ].map((m) => m[1]);
  for (const list of arrays) {
    assert.ok(
      !list.includes("chess_games"),
      "chess_games must never be published",
    );
  }
  assert.ok(
    !migration.includes("ADD TABLE public.chess_games"),
    "chess_games must never be added to the publication",
  );
});

test("the migration is guarded and idempotent", () => {
  assert.ok(
    migration.includes("pg_publication WHERE pubname = 'supabase_realtime'"),
    "must no-op without a realtime publication",
  );
  assert.ok(
    migration.includes("pg_publication_tables"),
    "must not re-add a table already published",
  );
  assert.ok(
    migration.includes("DROP POLICY IF EXISTS realtime_public_read"),
    "must be safe to re-run",
  );
});
