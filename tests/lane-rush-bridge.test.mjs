/**
 * Lane Rush — shared bridge tests.
 *
 * Covers the additive SHARED BRIDGE section of
 * `src/lib/lane-rush-duel/constants.js`:
 *   • exactly 10 rows;
 *   • every row has exactly ONE bad tile (all other tiles safe);
 *   • ONE bridge per match, shared by both seats (no per-player input);
 *   • the bridge never regenerates during the match (pure function of the
 *     committed seeds);
 *   • untouched safe/bad information is never exposed to the client;
 *   • the existing difficulty-based tile counts are preserved.
 *
 * Run:  node --import tsx --test tests/lane-rush-bridge.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  BRIDGE_FLAGS_PER_PLAYER,
  BRIDGE_ROWS,
  BRIDGE_TILE_CHOICE_SECONDS,
  badTileIndex,
  bridgeClientView,
  bridgeFlagsUsedBySeat,
  bridgeTileCountFor,
  bridgeTurnAfterJump,
  buildSharedBridge,
  canPlaceFlag,
  decideBridgeBotAction,
  flagPlacement,
  flagsLeftForSeat,
  flagsOf,
  landedSafelyOn,
  isBridgeTileBad,
  isTileBroken,
  resolveJump,
  seatRow,
} from "../src/lib/lane-rush-duel/constants.js";

const SEEDS = Object.freeze({
  serverSeed: "server-seed-abc123",
  clientSeed: "client-seed-xyz789",
  nonce: 4242,
});

// ── Bridge configuration ──────────────────────────────────────────────────

test("bridge config: 10 rows, 2 flags per player, 15s per tile choice", () => {
  assert.equal(BRIDGE_ROWS, 10);
  assert.equal(BRIDGE_FLAGS_PER_PLAYER, 2);
  assert.equal(BRIDGE_TILE_CHOICE_SECONDS, 15);
});

test("difficulty keeps the existing tile counts (easy 4 / medium 3 / hard 2)", () => {
  assert.equal(bridgeTileCountFor("easy"), 4);
  assert.equal(bridgeTileCountFor("medium"), 3);
  assert.equal(bridgeTileCountFor("hard"), 2);
  // Unknown / missing difficulty falls back to the easy width.
  assert.equal(bridgeTileCountFor("nonsense"), 4);
  assert.equal(bridgeTileCountFor(), 4);
  assert.equal(bridgeTileCountFor(undefined), 4);
});

// ── Exactly 10 rows, exactly one bad tile per row ─────────────────────────

test("the bridge has exactly 10 rows with one in-range bad tile each", () => {
  const bridge = buildSharedBridge({ ...SEEDS, difficulty: "easy" });

  assert.equal(bridge.rows, 10);
  assert.equal(bridge.rows, BRIDGE_ROWS);
  assert.equal(bridge.badTiles.length, 10);
  assert.equal(bridge.tiles, 4);

  for (let row = 0; row < BRIDGE_ROWS; row += 1) {
    const bad = badTileIndex(bridge, row);
    assert.ok(Number.isInteger(bad), `row ${row} has no bad tile`);
    assert.ok(bad >= 0 && bad < bridge.tiles, `row ${row} bad tile out of range`);
  }
});

test("every row has EXACTLY one bad tile — every other tile is safe", () => {
  for (const difficulty of ["easy", "medium", "hard"]) {
    const bridge = buildSharedBridge({ ...SEEDS, difficulty });
    for (let row = 0; row < bridge.rows; row += 1) {
      let badCount = 0;
      for (let tile = 0; tile < bridge.tiles; tile += 1) {
        if (isBridgeTileBad(bridge, row, tile)) badCount += 1;
      }
      assert.equal(
        badCount,
        1,
        `${difficulty} row ${row}: expected 1 bad tile, found ${badCount}`,
      );
      assert.equal(bridge.tiles - badCount, bridge.tiles - 1); // the rest are safe
    }
  }
});

test("the row's bad tile never repeats the previous row's position", () => {
  // Deterministic, auditable deduction rule — exactly one candidate removed.
  for (const difficulty of ["easy", "medium", "hard"]) {
    const bridge = buildSharedBridge({ ...SEEDS, difficulty });
    for (let row = 1; row < bridge.rows; row += 1) {
      assert.notEqual(
        bridge.badTiles[row],
        bridge.badTiles[row - 1],
        `${difficulty}: row ${row} repeated row ${row - 1}`,
      );
    }
  }
});

test("invalid rows / tiles are rejected by the server-side helpers", () => {
  const bridge = buildSharedBridge({ ...SEEDS });
  assert.equal(badTileIndex(bridge, -1), null);
  assert.equal(badTileIndex(bridge, BRIDGE_ROWS), null);
  assert.equal(badTileIndex(bridge, 1.5), null);
  assert.equal(badTileIndex(null, 0), null);
  assert.equal(isBridgeTileBad(bridge, BRIDGE_ROWS, 0), false);
  assert.equal(isBridgeTileBad(bridge, 0, -1), false);
  assert.equal(isBridgeTileBad(bridge, 0, 99), false);
});

// ── One bridge per match, shared by both players ──────────────────────────

test("ONE bridge per match: both seats derive the identical bridge", () => {
  // buildSharedBridge takes no seat/player argument at all: the same
  // committed match seeds are all a seat needs, so both players necessarily
  // reference the same bridge (there is no per-player bridge to generate).
  assert.equal(buildSharedBridge.length, 1); // single opts object, no seat param

  const asSeenByPlayer1 = buildSharedBridge({ ...SEEDS, difficulty: "medium" });
  const asSeenByPlayer2 = buildSharedBridge({ ...SEEDS, difficulty: "medium" });

  assert.deepEqual(asSeenByPlayer2.badTiles, asSeenByPlayer1.badTiles);
  assert.equal(asSeenByPlayer2.commitment, asSeenByPlayer1.commitment);
  assert.equal(asSeenByPlayer2.tiles, asSeenByPlayer1.tiles);
});

test("a different match (different seeds/nonce) gets a different bridge", () => {
  const base = buildSharedBridge({ ...SEEDS, difficulty: "easy" });
  const otherNonce = buildSharedBridge({ ...SEEDS, nonce: 4243, difficulty: "easy" });
  const otherClientSeed = buildSharedBridge({
    ...SEEDS,
    clientSeed: "another-client-seed",
    difficulty: "easy",
  });

  const differ = (a, b) =>
    a.badTiles.some((tile, i) => tile !== b.badTiles[i]);

  assert.ok(differ(base, otherNonce), "nonce must change the layout");
  assert.ok(differ(base, otherClientSeed), "client seed must change the layout");
  assert.notEqual(base.commitment, otherNonce.commitment);
});

// ── The bridge never regenerates during a match ───────────────────────────

test("the bridge never regenerates: re-deriving mid-match returns the same rows", () => {
  const atMatchStart = buildSharedBridge({ ...SEEDS, difficulty: "hard" });

  // Every later re-derivation (after fails, falls back to row 1, successful
  // jumps, turn changes) uses the same committed seeds and must return the
  // identical bridge — nothing about match progress is an input.
  const afterFails = buildSharedBridge({ ...SEEDS, difficulty: "hard" });
  const muchLater = buildSharedBridge({ ...SEEDS, difficulty: "hard" });

  assert.deepEqual(afterFails.badTiles, atMatchStart.badTiles);
  assert.deepEqual(muchLater.badTiles, atMatchStart.badTiles);
  assert.equal(muchLater.commitment, atMatchStart.commitment);
});

// ── No solution leakage to the client ─────────────────────────────────────

test("the client view exposes no hidden solution for untouched rows", () => {
  const bridge = buildSharedBridge({ ...SEEDS, difficulty: "easy" });
  const view = bridgeClientView(bridge);

  // Geometry only — the solution array never rides along.
  assert.equal("badTiles" in view, false);
  assert.equal(view.rows, BRIDGE_ROWS);
  assert.equal(view.tiles, 4);
  assert.equal(view.commitment, bridge.commitment);
  assert.deepEqual(view.broken, []);
  assert.deepEqual(view.revealedRows, []);

  const serialized = JSON.stringify(view);
  for (const bad of bridge.badTiles) {
    // No per-row bad tile appears anywhere when nothing is broken yet.
    assert.equal(
      serialized.includes(`"row":${bad}`),
      false,
      `row index ${bad} leaked before any tile was broken`,
    );
  }
});

test("only a genuinely broken bad tile becomes public (and stays public)", () => {
  const bridge = buildSharedBridge({ ...SEEDS, difficulty: "medium" });
  const trueBad = badTileIndex(bridge, 3);
  const wrongTile = trueBad === 0 ? 1 : 0;

  // A wrong (row, tile) pair reveals nothing — it cannot leak or grief the
  // hidden solution.
  const attemptedLeak = bridgeClientView(bridge, {
    broken: [{ row: 3, tile: wrongTile }],
  });
  assert.deepEqual(attemptedLeak.broken, []);
  assert.deepEqual(attemptedLeak.revealedRows, []);

  // A real broken tile is public knowledge, deduped and ordered by row...
  const view = bridgeClientView(bridge, {
    broken: [
      { row: 5, tile: badTileIndex(bridge, 5) },
      { row: 3, tile: trueBad },
      [3, trueBad], // duplicate pair
    ],
  });
  assert.deepEqual(view.broken, [
    { row: 3, tile: trueBad },
    { row: 5, tile: badTileIndex(bridge, 5) },
  ]);
  assert.deepEqual(view.revealedRows, [3, 5]);

  // ...and stays broken for the rest of the match (stable re-derivation).
  const later = bridgeClientView(bridge, {
    broken: [{ row: 3, tile: trueBad }],
  });
  assert.deepEqual(later.broken, [{ row: 3, tile: trueBad }]);

  // Rows with no public knowledge still carry nothing.
  assert.equal(JSON.stringify(view).includes('"row":0'), false);
});

// ── Commitment (provable fairness) ────────────────────────────────────────

test("the commitment is a stable sha256 hex over the seeds + layout", () => {
  const bridge = buildSharedBridge({ ...SEEDS, difficulty: "easy" });
  assert.match(bridge.commitment, /^[0-9a-f]{64}$/);
  assert.equal(
    buildSharedBridge({ ...SEEDS, difficulty: "easy" }).commitment,
    bridge.commitment,
  );
  assert.notEqual(
    buildSharedBridge({ ...SEEDS, difficulty: "hard" }).commitment,
    bridge.commitment,
  );
});

test("difficulty is validated and defaults to easy", () => {
  assert.equal(buildSharedBridge({ ...SEEDS }).difficulty, "easy");
  assert.equal(buildSharedBridge({ ...SEEDS, difficulty: "nope" }).difficulty, "easy");
  assert.equal(buildSharedBridge({ ...SEEDS, difficulty: "nope" }).tiles, 4);
});

// ═══════════════════════════════════════════════════════════════════════
// Bridge MATCH STATE + RULES (the new game)
// ═══════════════════════════════════════════════════════════════════════

test("seatRow / flagsOf / flagsLeftForSeat read the persisted bridge state", () => {
  const match = {
    p1Row: 3,
    p2Row: 0,
    p1Flags: [{ row: 0, tile: 1 }],
    p2Flags: [],
  };
  assert.equal(seatRow(match, "player1"), 3);
  assert.equal(seatRow(match, "player2"), 0);
  assert.deepEqual(flagsOf(match, "player1"), [{ row: 0, tile: 1 }]);
  assert.deepEqual(flagsOf(match, "player2"), []);
  assert.equal(bridgeFlagsUsedBySeat(match, "player1"), 1);
  assert.equal(flagsLeftForSeat(match, "player1"), BRIDGE_FLAGS_PER_PLAYER - 1);
  assert.equal(flagsLeftForSeat(match, "player2"), BRIDGE_FLAGS_PER_PLAYER);
  // Missing / malformed state reads as the start of the bridge.
  assert.equal(seatRow({}, "player1"), 0);
  assert.equal(seatRow({ p1Row: 99 }, "player1"), BRIDGE_ROWS);
  assert.deepEqual(flagsOf({}, "player1"), []);
  assert.equal(flagsLeftForSeat({ p1Flags: [1, 2, 3] }, "player1"), 0);
});

test("a safe jump crosses one row and the SAME player keeps the turn", () => {
  const bridge = buildSharedBridge({ ...SEEDS, difficulty: "easy" });
  const bad = badTileIndex(bridge, 0);
  const safeTile = bad === 0 ? 1 : 0;

  const res = resolveJump({ bridge, broken: [], row: 0, tile: safeTile });
  assert.equal(res.outcome, "safe");
  assert.equal(res.from, 0);
  assert.equal(res.to, 1);
  assert.equal(res.brokeTile, null);
  assert.deepEqual(res.broken, []); // safe tiles are NOT revealed
});

test("the bad tile breaks, the player falls to row 1, and the tile stays broken", () => {
  const bridge = buildSharedBridge({ ...SEEDS, difficulty: "medium" });
  const bad = badTileIndex(bridge, 4);

  const fell = resolveJump({ bridge, broken: [], row: 4, tile: bad });
  assert.equal(fell.outcome, "fell");
  assert.equal(fell.to, 0); // back to row 1 (nothing crossed)
  assert.deepEqual(fell.brokeTile, { row: 4, tile: bad });
  assert.deepEqual(fell.broken, [{ row: 4, tile: bad }]);

  // A later player hitting the SAME tile finds it already broken — the list
  // stays deduplicated and the tile never becomes safe again.
  const again = resolveJump({
    bridge,
    broken: fell.broken,
    row: 4,
    tile: bad,
  });
  assert.equal(again.outcome, "fell");
  assert.deepEqual(again.broken, [{ row: 4, tile: bad }]);
  assert.equal(isTileBroken(again.broken, 4, bad), true);
  assert.equal(isTileBroken(again.broken, 4, bad === 0 ? 1 : 0), false);
});

test("crossing row 10 wins; out-of-range tiles are rejected", () => {
  const bridge = buildSharedBridge({ ...SEEDS, difficulty: "hard" });
  const lastRow = BRIDGE_ROWS - 1;
  const bad = badTileIndex(bridge, lastRow);
  const safeTile = bad === 0 ? 1 : 0;

  const win = resolveJump({
    bridge,
    broken: [],
    row: lastRow,
    tile: safeTile,
  });
  assert.equal(win.outcome, "won");
  assert.equal(win.to, BRIDGE_ROWS);

  const badTileIdx = resolveJump({ bridge, broken: [], row: 0, tile: 99 });
  assert.equal(badTileIdx.error, "Invalid tile index");
  assert.equal(resolveJump({ bridge, broken: [], row: 0, tile: -1 }).error, "Invalid tile index");
  assert.equal(resolveJump({ bridge, broken: [], row: 0, tile: 1.5 }).error, "Invalid tile index");
});

test("flags: only a tile the seat PERSONALLY landed on safely", () => {
  const bridge = buildSharedBridge({ ...SEEDS, difficulty: "easy" });
  const fresh = { p1Row: 0, p2Row: 0, p1Flags: [], p2Flags: [], actions: [] };

  // Standing at the start = nothing landed on safely yet, so nothing is legal.
  assert.equal(
    canPlaceFlag({ match: fresh, seat: "player1", row: 0, tile: 0, bridge }).ok,
    false,
  );

  // Player 1 crossed row 0 on tile 1 and row 1 on tile 2 (their own history).
  const crossed = {
    ...fresh,
    p1Row: 2,
    actions: [
      { seat: "player1", action: "jump", row: 0, tile: 1, outcome: "safe" },
      { seat: "player1", action: "jump", row: 1, tile: 2, outcome: "safe" },
    ],
  };
  assert.equal(
    canPlaceFlag({ match: crossed, seat: "player1", row: 0, tile: 1, bridge }).ok,
    true,
    "the tile they landed on is flaggable",
  );
  assert.equal(
    canPlaceFlag({ match: crossed, seat: "player1", row: 1, tile: 2, bridge }).ok,
    true,
  );
  // Crossing a row is NOT enough: a tile this seat never stepped on is refused.
  assert.equal(
    canPlaceFlag({ match: crossed, seat: "player1", row: 1, tile: 3, bridge }).ok,
    false,
    "a tile they never landed on cannot be flagged",
  );
  // …nor the row ahead of them (never landed there at all).
  assert.equal(
    canPlaceFlag({ match: crossed, seat: "player1", row: 2, tile: 0, bridge }).ok,
    false,
  );
  // The OPPONENT's landing is not this seat's landing.
  assert.equal(
    canPlaceFlag({ match: crossed, seat: "player2", row: 0, tile: 1, bridge }).ok,
    false,
  );
  // A FALL is not a safe landing, so the tile that broke them is refused.
  const fell = {
    ...crossed,
    actions: [
      ...crossed.actions,
      { seat: "player1", action: "jump", row: 2, tile: 0, outcome: "fell" },
    ],
  };
  assert.equal(
    canPlaceFlag({ match: fell, seat: "player1", row: 2, tile: 0, bridge }).ok,
    false,
  );
  // Out-of-range coordinates are refused before anything else.
  assert.equal(
    canPlaceFlag({ match: crossed, seat: "player1", row: -1, tile: 1, bridge }).ok,
    false,
  );
  assert.equal(
    canPlaceFlag({ match: crossed, seat: "player1", row: 0, tile: 99, bridge }).ok,
    false,
  );
});

test("flags: the budget is a hard 2 per match and a flag can never repeat", () => {
  const bridge = buildSharedBridge({ ...SEEDS, difficulty: "easy" });
  const actions = [0, 1, 2].map((r) => ({
    seat: "player1",
    action: "jump",
    row: r,
    tile: 1,
    outcome: "safe",
  }));
  const match = {
    p1Row: 3,
    p2Row: 0,
    p2Flags: [],
    actions,
    p1Flags: [
      { row: 0, tile: 1 },
      { row: 1, tile: 1 },
    ],
  };

  assert.equal(flagsLeftForSeat(match, "player1"), 0);
  assert.equal(
    canPlaceFlag({ match, seat: "player1", row: 2, tile: 1, bridge }).error,
    "No flags left this match",
    "a third flag must be refused even though the tile is legal",
  );

  // The same tile cannot be flagged twice.
  const oneFlag = { ...match, p1Flags: [{ row: 0, tile: 1 }] };
  assert.equal(
    canPlaceFlag({ match: oneFlag, seat: "player1", row: 0, tile: 1, bridge }).error,
    "That tile is already flagged",
  );
  // The other seat's budget is untouched by yours.
  assert.equal(flagsLeftForSeat(oneFlag, "player2"), BRIDGE_FLAGS_PER_PLAYER);
});

test("flags: placement is append-only — never moved, never removed, never reordered", () => {
  const existing = [
    { row: 0, tile: 1, seat: "player1", at: "t0" },
    { row: 1, tile: 2, seat: "player1", at: "t1" },
  ];
  const match = { p1Flags: existing, p2Flags: [] };

  const { field, flags } = flagPlacement({
    match,
    seat: "player1",
    row: 4,
    tile: 3,
    at: "t2",
  });
  assert.equal(field, "p1Flags");
  assert.deepEqual(flags.slice(0, 2), existing, "existing flags keep their exact place");
  assert.equal(flags.length, 3);
  assert.deepEqual(flags[2], { row: 4, tile: 3, seat: "player1", at: "t2" });
  // Pure: the stored list it was given is not mutated.
  assert.equal(match.p1Flags.length, 2);
  // The other seat's list is never involved.
  assert.equal(flagPlacement({ match, seat: "player2", row: 0, tile: 0 }).field, "p2Flags");
  assert.deepEqual(flagPlacement({ match, seat: "player2", row: 0, tile: 0 }).flags.length, 1);
});

test("flags: a new match starts with none (static per-match reset)", () => {
  // Flags live on the MATCH row, so a fresh match has none by construction and
  // every reader treats a missing list as empty.
  assert.deepEqual(flagsOf({}, "player1"), []);
  assert.deepEqual(flagsOf({ p1Flags: null }, "player2"), []);
  assert.equal(flagsLeftForSeat({}, "player1"), BRIDGE_FLAGS_PER_PLAYER);
  assert.equal(flagsLeftForSeat({}, "player2"), BRIDGE_FLAGS_PER_PLAYER);
  assert.equal(
    bridgeFlagsUsedBySeat({ p1Flags: [{ row: 0, tile: 1 }, { row: 1, tile: 2 }] }, "player1"),
    2,
  );
  // Nothing carried over is flaggable without a landing in THIS match.
  assert.equal(canPlaceFlag({ match: {}, seat: "player1", row: 0, tile: 0 }).ok, false);
});

test("flags: validation is not an oracle — a refused flag says nothing about the tile", () => {
  const bridge = buildSharedBridge({ ...SEEDS, difficulty: "medium" });
  const match = {
    p1Row: 1,
    p2Row: 0,
    p1Flags: [],
    p2Flags: [],
    actions: [{ seat: "player1", action: "jump", row: 0, tile: 1, outcome: "safe" }],
  };

  // Row 3 was never landed on. Asking to flag the row's BAD tile and asking to
  // flag a safe tile must be indistinguishable, so the endpoint cannot be used
  // to probe the hidden solution.
  const row = 3;
  const bad = badTileIndex(bridge, row);
  const safe = bad === 0 ? 1 : 0;
  const onBad = canPlaceFlag({ match, seat: "player1", row, tile: bad, bridge });
  const onSafe = canPlaceFlag({ match, seat: "player1", row, tile: safe, bridge });
  assert.equal(onBad.ok, false);
  assert.equal(onSafe.ok, false);
  assert.equal(onBad.error, onSafe.error);

  // Same on a row they DID land on: only the tile they actually chose is
  // accepted, and any other tile gets the identical refusal.
  // (They landed on tile 1 of row 0, so row 0's bad tile is necessarily some
  // other tile.)
  assert.notEqual(badTileIndex(bridge, 0), 1);
  assert.equal(
    canPlaceFlag({ match, seat: "player1", row: 0, tile: 0, bridge }).error,
    onBad.error,
  );
});

test("flags: a flag can only ever mark a SAFE tile — never the row's bad tile", () => {
  const bridge = buildSharedBridge({ ...SEEDS, difficulty: "hard" });
  // A perfect climb: every landing is safe by construction.
  const actions = [];
  for (let row = 0; row < BRIDGE_ROWS; row += 1) {
    const bad = badTileIndex(bridge, row);
    actions.push({
      seat: "player1",
      action: "jump",
      row,
      tile: bad === 0 ? 1 : 0,
      outcome: "safe",
    });
  }
  const match = {
    p1Row: BRIDGE_ROWS,
    p2Row: 0,
    p1Flags: [],
    p2Flags: [],
    actions,
  };

  for (let row = 0; row < BRIDGE_ROWS; row += 1) {
    const bad = badTileIndex(bridge, row);
    const safe = bad === 0 ? 1 : 0;
    assert.equal(
      canPlaceFlag({ match, seat: "player1", row, tile: safe, bridge }).ok,
      true,
    );
    assert.equal(
      canPlaceFlag({ match, seat: "player1", row, tile: bad, bridge }).ok,
      false,
      `row ${row}: the bad tile can never be flagged`,
    );
  }
});

test("the bot picks a legal tile on its own row and never ignores a broken tile on hard", () => {
  const bridge = buildSharedBridge({ ...SEEDS, difficulty: "hard" });
  const row = 3;
  const bad = badTileIndex(bridge, row);
  const match = {
    p2Row: row,
    p2Flags: [],
    p1Flags: [],
    broken: [{ row, tile: bad }],
    // The bot's OWN safe landings — the only tiles it may flag.
    actions: [0, 1, 2].map((r) => ({
      seat: "player2",
      action: "jump",
      row: r,
      tile: badTileIndex(bridge, r) === 0 ? 1 : 0,
      outcome: "safe",
    })),
  };

  let sawFlag = false;
  for (let i = 0; i < 60; i += 1) {
    const decision = decideBridgeBotAction({ match, seat: "player2", bridge });
    assert.ok(decision, "the bot always has a move while the pair has not been crossed");
    assert.ok(["jump", "flag"].includes(decision.action));
    if (decision.action === "flag") {
      sawFlag = true;
      // A flag must be one of the bot's own landings (and thus never the bad
      // tile it watched break).
      assert.equal(
        landedSafelyOn(match, "player2", decision.row, decision.tile),
        true,
        "flags go on a tile the bot landed on itself",
      );
      continue;
    }
    assert.equal(decision.row, row, "a jump is always on the bot's current row");
    assert.ok(decision.tile >= 0 && decision.tile < bridge.tiles);
    assert.notEqual(decision.tile, bad, "hard must respect the broken tile it saw");
  }
  assert.ok(sawFlag, "hard bots should use their memory flags");

  // Done: nothing crossed the whole bridge → no move.
  assert.equal(
    decideBridgeBotAction({ match: { p2Row: BRIDGE_ROWS }, seat: "player2", bridge }),
    null,
  );
});

test("a full bot-vs-bot run always ends with exactly one player crossing the bridge", () => {
  // Deterministic RNG so the property is reproducible.
  const rng = (seed) => {
    let s = seed >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  };

  for (let game = 0; game < 25; game += 1) {
    const random = rng(game + 1);
    const bridge = buildSharedBridge({
      serverSeed: `${SEEDS.serverSeed}:${game}`,
      clientSeed: SEEDS.clientSeed,
      nonce: game,
      difficulty: ["easy", "medium", "hard"][game % 3],
    });
    let match = { p1Row: 0, p2Row: 0, p1Flags: [], p2Flags: [], broken: [], actions: [] };
    let turn = game % 2 === 0 ? "player1" : "player2";
    let winner = null;
    let steps = 0;

    while (!winner && steps < 2000) {
      steps += 1;
      const seat = turn;
      const decision = decideBridgeBotAction({ match, seat, bridge, random });
      assert.ok(decision, `no move for ${seat} in game ${game}`);

      if (decision.action === "flag") {
        const check = canPlaceFlag({
          match,
          seat,
          row: decision.row,
          tile: decision.tile,
          bridge,
        });
        assert.ok(check.ok, `illegal bot flag in game ${game}: ${check.error}`);
        const field = seat === "player1" ? "p1Flags" : "p2Flags";
        match = {
          ...match,
          [field]: [...match[field], { row: decision.row, tile: decision.tile }],
        };
        continue; // flagging does not consume the turn
      }

      const from = seatRow(match, seat);
      const res = resolveJump({
        bridge,
        broken: match.broken,
        row: from,
        tile: decision.tile,
      });
      const rowField = seat === "player1" ? "p1Row" : "p2Row";
      // Record the landing: the flag gate validates against this history.
      match = {
        ...match,
        [rowField]: res.to,
        broken: res.broken,
        actions: [
          ...match.actions,
          {
            seat,
            action: "jump",
            row: from,
            tile: decision.tile,
            outcome: res.outcome,
          },
        ],
      };

      if (res.outcome === "won") {
        winner = seat;
        break;
      }
      // A safe jump keeps the turn; a fall hands it over.
      if (res.outcome === "fell") turn = seat === "player1" ? "player2" : "player1";
    }

    assert.ok(winner, `game ${game} never finished`);
    assert.equal(seatRow(match, winner), BRIDGE_ROWS);
    assert.ok(
      seatRow(match, winner === "player1" ? "player2" : "player1") < BRIDGE_ROWS,
      "the loser must not have crossed the bridge",
    );
  }
});

// ── Server tile-selection rules ───────────────────────────────────────────
// `bridgeTurnAfterJump` is the ONE place the server derives what a resolved
// jump does to the row + the turn (the store persists exactly these values),
// so these tests pin the production transition rather than a copy of it.

test("rule: a SAFE tile advances one row and the SAME player keeps the turn", () => {
  const match = {
    player1Id: "p1",
    player2Id: "p2",
    currentTurnUserId: "p1",
    p1Row: 3,
    p2Row: 1,
  };
  const turn = bridgeTurnAfterJump({
    match,
    seat: "player1",
    outcome: { outcome: "safe", to: 4 },
  });
  assert.equal(turn.ended, false);
  assert.equal(turn.rowField, "p1Row");
  assert.equal(turn.row, 4); // exactly one row
  assert.equal(turn.turnUserId, "p1"); // unchanged → may choose again
  assert.equal(turn.seatStillUp, true);
});

test("rule: a BAD tile resets the attempt to Row 1 and hands over the turn", () => {
  for (const [seat, seatId, opponentId, field] of [
    ["player1", "p1", "p2", "p1Row"],
    ["player2", "p2", "p1", "p2Row"],
  ]) {
    const match = {
      player1Id: "p1",
      player2Id: "p2",
      currentTurnUserId: seatId,
      p1Row: 5,
      p2Row: 5,
    };
    const turn = bridgeTurnAfterJump({
      match,
      seat,
      outcome: { outcome: "fell", to: 0, brokeTile: { row: 5, tile: 1 } },
    });
    assert.equal(turn.ended, false);
    assert.equal(turn.rowField, field);
    assert.equal(turn.row, 0, `${seat}: a fall must send them back to Row 1`);
    assert.equal(turn.turnUserId, opponentId);
    assert.equal(turn.seatStillUp, false);
  }
});

test("rule: crossing Row 10 wins immediately and ends the match", () => {
  const match = {
    player1Id: "p1",
    player2Id: "p2",
    currentTurnUserId: "p2",
    p1Row: 2,
    p2Row: 8,
  };
  const turn = bridgeTurnAfterJump({
    match,
    seat: "player2",
    outcome: { outcome: "won", to: BRIDGE_ROWS },
  });
  assert.equal(turn.ended, true);
  assert.equal(turn.rowField, "p2Row");
  assert.equal(turn.row, BRIDGE_ROWS);
  assert.equal(turn.turnUserId, null); // the match is over — no turn
});

test("rule: composed with resolveJump — only a fall switches the turn", () => {
  const bridge = buildSharedBridge({ ...SEEDS, difficulty: "easy" });

  for (const row of [0, 1, 5, BRIDGE_ROWS - 1]) {
    const bad = badTileIndex(bridge, row);
    const safe = bad === 0 ? 1 : 0;
    const match = {
      player1Id: "p1",
      player2Id: "p2",
      currentTurnUserId: "p1",
      p1Row: row,
      p2Row: 0,
    };

    const safeTurn = bridgeTurnAfterJump({
      match,
      seat: "player1",
      outcome: resolveJump({ bridge, broken: [], row, tile: safe }),
    });
    assert.equal(safeTurn.row, row + 1, `row ${row}: safe must advance one row`);
    if (row === BRIDGE_ROWS - 1) {
      // Crossing the LAST row wins instead of continuing.
      assert.equal(safeTurn.ended, true);
      assert.equal(safeTurn.turnUserId, null);
      assert.equal(safeTurn.row, BRIDGE_ROWS);
    } else {
      assert.equal(safeTurn.turnUserId, "p1", `row ${row}: safe must keep the turn`);
    }

    const fallTurn = bridgeTurnAfterJump({
      match,
      seat: "player1",
      outcome: resolveJump({ bridge, broken: [], row, tile: bad }),
    });
    assert.equal(fallTurn.turnUserId, "p2", `row ${row}: a fall must hand over`);
    assert.equal(fallTurn.row, 0, `row ${row}: a fall must reset progress`);
  }
});

// ── Permanent broken-tile state ───────────────────────────────────────────
// A tile a player falls through is broken for the REST of the match, is public
// to both players, and is the ONLY thing a jump ever reveals — safe tiles stay
// hidden and untouched rows leak nothing.

test("broken state: only the tile that was stepped on breaks — a safe tile reveals nothing", () => {
  const bridge = buildSharedBridge({ ...SEEDS, difficulty: "easy" });

  // A safe choice on row 0 breaks NOTHING.
  const bad0 = badTileIndex(bridge, 0);
  const safe0 = bad0 === 0 ? 1 : 0;
  const safeJump = resolveJump({ bridge, broken: [], row: 0, tile: safe0 });
  assert.equal(safeJump.outcome, "safe");
  assert.equal(safeJump.brokeTile, null);
  assert.deepEqual(safeJump.broken, [], "a safe tile must not become permanent knowledge");

  // The bad tile on the SAME row breaks exactly that one tile.
  const fall = resolveJump({ bridge, broken: safeJump.broken, row: 0, tile: bad0 });
  assert.equal(fall.outcome, "fell");
  assert.deepEqual(fall.brokeTile, { row: 0, tile: bad0 });
  assert.deepEqual(fall.broken, [{ row: 0, tile: bad0 }]);
  assert.equal(fall.broken.length, 1, "exactly ONE tile breaks per fall");
});

test("broken state: a broken tile stays broken for the rest of the match", () => {
  const bridge = buildSharedBridge({ ...SEEDS, difficulty: "medium" });
  const bad = badTileIndex(bridge, 2);

  // First fall.
  const first = resolveJump({ bridge, broken: [], row: 2, tile: bad });
  let broken = first.broken;
  assert.deepEqual(broken, [{ row: 2, tile: bad }]);

  // Any number of later choices (safe ones on other rows) never clear it…
  for (const row of [0, 1, 3, 4, 5, BRIDGE_ROWS - 1]) {
    const safeTile = badTileIndex(bridge, row) === 0 ? 1 : 0;
    const res = resolveJump({ bridge, broken, row, tile: safeTile });
    assert.equal(res.brokeTile, null);
    assert.deepEqual(res.broken, [{ row: 2, tile: bad }], "a broken tile is never healed");
    broken = res.broken;
  }

  // …and stepping on it again still ends the attempt (it never becomes safe).
  const again = resolveJump({ bridge, broken, row: 2, tile: bad });
  assert.equal(again.outcome, "fell");
  assert.equal(isTileBroken(again.broken, 2, bad), true);
  // The list stays deduplicated — a repeat visit breaks nothing new.
  assert.deepEqual(again.broken, [{ row: 2, tile: bad }]);
});

test("broken state: every broken tile is the bridge's genuine bad tile (the bridge never changes)", () => {
  const bridge = buildSharedBridge({ ...SEEDS, difficulty: "hard" });

  // Walk the whole bridge, falling on each row's bad tile in turn (as a player
  // would across attempts) and collecting the public broken list.
  let broken = [];
  for (let row = 0; row < BRIDGE_ROWS; row += 1) {
    const bad = badTileIndex(bridge, row);
    broken = resolveJump({ bridge, broken, row, tile: bad }).broken;
  }

  assert.equal(broken.length, BRIDGE_ROWS);
  for (const entry of broken) {
    // The broken entry identifies the SAME layout that buildSharedBridge
    // produced for this match — it can never drift or regenerate.
    assert.equal(
      isBridgeTileBad(bridge, entry.row, entry.tile),
      true,
      `broken (${entry.row},${entry.tile}) is not the bridge's bad tile`,
    );
    assert.equal(badTileIndex(bridge, entry.row), entry.tile);
  }
  // Safe tiles are still NOT in the list.
  for (let row = 0; row < BRIDGE_ROWS; row += 1) {
    const bad = badTileIndex(bridge, row);
    for (let tile = 0; tile < bridge.tiles; tile += 1) {
      if (tile === bad) continue;
      assert.equal(
        isTileBroken(broken, row, tile),
        false,
        `safe tile (${row},${tile}) must never be revealed`,
      );
    }
  }
});

test("broken state: both players receive the SAME public view, nothing on untouched rows", () => {
  const bridge = buildSharedBridge({ ...SEEDS, difficulty: "easy" });
  const bad = badTileIndex(bridge, 6);
  const broken = resolveJump({ bridge, broken: [], row: 6, tile: bad }).broken;

  // The view is built from match state only — there is no seat input, so both
  // players necessarily see the identical broken tile.
  const asSeenByPlayer1 = bridgeClientView(bridge, { broken });
  const asSeenByPlayer2 = bridgeClientView(bridge, { broken });
  assert.deepEqual(asSeenByPlayer1, asSeenByPlayer2);
  assert.deepEqual(asSeenByPlayer1.broken, [{ row: 6, tile: bad }]);
  assert.deepEqual(asSeenByPlayer1.revealedRows, [6]);

  // Untouched rows expose NOTHING: no hidden bad tile, no safe/bad flags.
  assert.equal("badTiles" in asSeenByPlayer1, false);
  // The view is geometry + commitment + the public broken set, and nothing else.
  assert.deepEqual(Object.keys(asSeenByPlayer1).sort(), [
    "broken",
    "commitment",
    "difficulty",
    "revealedRows",
    "rows",
    "tiles",
  ]);
  // …and no array in it can describe a whole 10-row solution.
  for (const [key, value] of Object.entries(asSeenByPlayer1)) {
    if (Array.isArray(value)) {
      assert.ok(
        value.length < BRIDGE_ROWS,
        `${key} must not carry a per-row solution`,
      );
    }
  }
});

test("rule: an expired 15s window ends the attempt and hands over the turn", () => {
  for (const [seat, seatId, opponentId, field] of [
    ["player1", "p1", "p2", "p1Row"],
    ["player2", "p2", "p1", "p2Row"],
  ]) {
    const match = {
      player1Id: "p1",
      player2Id: "p2",
      currentTurnUserId: seatId,
      p1Row: 6,
      p2Row: 4,
    };
    const turn = bridgeTurnAfterJump({
      match,
      seat,
      outcome: { outcome: "timed_out", to: 0 },
    });
    assert.equal(turn.ended, false);
    assert.equal(turn.rowField, field);
    assert.equal(turn.row, 0, `${seat}: a timeout sends them back to Row 1`);
    assert.equal(turn.turnUserId, opponentId);
    assert.equal(turn.seatStillUp, false);
    // Pure: the input is untouched, and the OTHER seat keeps its progress.
    assert.equal(match.p1Row, 6);
    assert.equal(match.p2Row, 4);
  }
});

test("rule: a timeout resets only the stalled seat and breaks no tile", () => {
  // Same row/turn consequence as a bad tile, but the timeout carries no tile:
  // nothing on the bridge changes and the opponent's row is unaffected.
  const match = {
    player1Id: "p1",
    player2Id: "p2",
    currentTurnUserId: "player1",
    p1Row: 9,
    p2Row: 8,
  };
  const turn = bridgeTurnAfterJump({
    match,
    seat: "player1",
    outcome: { outcome: "timed_out", to: 0 },
  });
  assert.equal(turn.rowField, "p1Row");
  assert.equal(turn.row, 0);
  assert.equal(turn.turnUserId, "p2");
  // Not a win — being nearly across the bridge does not survive the window.
  assert.equal(turn.ended, false);
});

test("rule: every row of the bridge has a safe and a bad landing, and the last row wins", () => {
  const bridge = buildSharedBridge({ ...SEEDS, difficulty: "medium" });
  const match = {
    player1Id: "p1",
    player2Id: "p2",
    currentTurnUserId: "p1",
    p1Row: 0,
    p2Row: 0,
  };

  // Walking the whole bridge on safe tiles from the start wins on row 10.
  let row = 0;
  let steps = 0;
  const crossed = [];
  while (row < BRIDGE_ROWS) {
    const bad = badTileIndex(bridge, row);
    const tile = bad === 0 ? 1 : 0;
    const outcome = resolveJump({ bridge, broken: [], row, tile });
    const turn = bridgeTurnAfterJump({ match, seat: "player1", outcome });
    if (row === BRIDGE_ROWS - 1) {
      assert.equal(turn.ended, true); // the last row wins
    } else {
      assert.equal(turn.turnUserId, "p1"); // never loses the turn on a safe jump
    }
    crossed.push(turn.row);
    row = turn.row;
    steps += 1;
    assert.ok(steps <= BRIDGE_ROWS, "a safe walk must terminate at row 10");
  }
  assert.equal(row, BRIDGE_ROWS);
  assert.deepEqual(crossed, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});
