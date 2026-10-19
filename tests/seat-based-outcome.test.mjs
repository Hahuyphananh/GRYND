/**
 * seat-based-outcome.test.mjs
 *
 * ONE VERDICT RULE FOR EVERY GAME.
 *
 * Every result screen in the casino answers the same question — "did the viewer
 * win?" — and it may only ever answer it the same way: from the SERVER's settled
 * row, read against the seat the SERVER says the viewer holds
 * (src/lib/results/viewerOutcome.ts).
 *
 * The failure this pins shut is the Clerk-id comparison. A signed-out free-play
 * visitor holds no Clerk id at all: the practice gate mints them a `guest_…`
 * identity (src/lib/auth/guestSession.ts), so `winnerId === user?.id` is false
 * for them whatever the row says — a guest who had just won was told they had
 * lost. A client whose Clerk session has not hydrated is the same false loss for
 * that moment.
 *
 * This file does three things:
 *
 *   1. drives the shared rule directly (every seat spelling, every precedence);
 *   2. proves the per-game helpers agree with it — the same row, the same seat,
 *      the same verdict in Speed Typing, Barricade, Tic-Tac-Toe, Solitaire Duel
 *      and Sudoku Duel;
 *   3. guards the result screens themselves: no page may decide a win or a loss
 *      from a client-side identity, and the two pages that used to claim their
 *      seat from a URL parameter must read the server's answer instead.
 *
 * Run:  node --import tsx --test tests/seat-based-outcome.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { seatKeyOf, viewerOutcome } from "../src/lib/results/viewerOutcome.ts";
import { outcomeFor as speedTypingOutcome } from "../src/lib/speed-typing/ui.ts";
import { outcomeFor as barricadeOutcome } from "../src/lib/barricade/ui.ts";
import { outcomeFor as ticTacToeOutcome } from "../src/lib/tic-tac-toe/ui.ts";
import { outcomeFor as solitaireOutcome } from "../src/lib/solitaire-duel/rules.ts";
import { outcomeFor as sudokuOutcome } from "../src/lib/sudoku-duel/rules.ts";

const read = (rel) => fs.readFileSync(rel, "utf8").replace(/\r\n/g, "\n");
/**
 * Source with comments stripped.
 *
 * The guards below look for a FORBIDDEN EXPRESSION in the shipped code. The
 * comments deliberately quote that expression while explaining why it was wrong,
 * so matching against raw text would fail on the explanation rather than on the
 * bug.
 */
const code = (rel) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");

/** A guest identity — a real seat holder that Clerk knows nothing about. */
const GUEST = "guest_9f8c1f0e-2c3b-4a5d-8e7f-6a5b4c3d2e1f";
const CLERK = "user_2abcDEFghiJKL";

// ════════════════════════════════════════════════════════════════════════
// 1. The one rule
// ════════════════════════════════════════════════════════════════════════

test("viewerOutcome: a tie is a draw for BOTH seats, and for a viewer with no seat", () => {
  for (const result of ["tie", "draw"]) {
    for (const seat of ["player1", "player2", 1, 2, null, undefined]) {
      assert.equal(
        viewerOutcome({ result, viewerSeat: seat }),
        "draw",
        `${result} @ ${String(seat)}`,
      );
    }
  }
  // A row that somehow carries both a tie and a winner is still a tie: a tie has
  // no winner, so no id may turn it into one.
  assert.equal(
    viewerOutcome({ result: "tie", winnerId: CLERK, viewerId: CLERK }),
    "draw",
  );
});

test("viewerOutcome: the settled result is read against the viewer's SEAT", () => {
  const cases = [
    ["player1", "player1", "win"],
    ["player1", "player2", "loss"],
    ["player2", "player2", "win"],
    ["player2", "player1", "loss"],
    // The same seat, spelled as the number the Speed Typing DTO uses.
    ["player1", 1, "win"],
    ["player1", 2, "loss"],
    ["player2", 2, "win"],
    ["player2", 1, "loss"],
  ];
  for (const [result, seat, expected] of cases) {
    assert.equal(
      viewerOutcome({ result, viewerSeat: seat }),
      expected,
      `${result} @ ${seat}`,
    );
  }
});

test("viewerOutcome: a row that names no seat yields NO verdict — never a loss", () => {
  for (const result of ["player1", "player2"]) {
    for (const seat of [null, undefined, "", "spectator", 3, 0]) {
      assert.equal(
        viewerOutcome({ result, viewerSeat: seat }),
        null,
        `${result} @ ${JSON.stringify(seat)}`,
      );
    }
  }
});

test("viewerOutcome: a guest id is a seat id like any other", () => {
  // The whole bug in one line: the guest WON a row whose winnerId is their own
  // guest id, and no Clerk id is involved anywhere.
  assert.equal(
    viewerOutcome({ winnerId: GUEST, viewerId: GUEST, viewerSeat: "player1" }),
    "win",
  );
  assert.equal(
    viewerOutcome({ winnerId: CLERK, viewerId: GUEST, viewerSeat: "player1" }),
    "loss",
  );
  // And the seat path needs no id at all, which is why it covers a guest.
  assert.equal(
    viewerOutcome({ result: "player1", viewerSeat: "player1" }),
    "win",
  );
});

test("viewerOutcome: the settled result outranks the id fallback", () => {
  // A row whose winnerId is stale/misleading still reads as settled: `result` is
  // what settlement wrote, and it is compared by seat.
  assert.equal(
    viewerOutcome({
      result: "player1",
      winnerId: CLERK,
      viewerSeat: "player2",
      viewerId: CLERK,
    }),
    "loss",
  );
  // The id path is only reached by a row that names a winner WITHOUT a result —
  // a legacy row, or another writer's settlement.
  assert.equal(
    viewerOutcome({ result: null, winnerId: CLERK, viewerId: CLERK }),
    "win",
  );
  assert.equal(
    viewerOutcome({ result: null, winnerId: CLERK, viewerId: GUEST }),
    "loss",
  );
  // A winner with nobody to compare against is not a verdict.
  assert.equal(viewerOutcome({ winnerId: CLERK, viewerId: null }), null);
  assert.equal(viewerOutcome({ winnerId: null, viewerId: CLERK }), null);
  // And a string this platform does not know is not a verdict either.
  assert.equal(
    viewerOutcome({ result: "cancelled", viewerSeat: "player1" }),
    null,
  );
});

test("seatKeyOf: both spellings normalise, anything else is no seat", () => {
  assert.equal(seatKeyOf("player1"), "player1");
  assert.equal(seatKeyOf("player2"), "player2");
  assert.equal(seatKeyOf(1), "player1");
  assert.equal(seatKeyOf(2), "player2");
  for (const bad of [null, undefined, 0, 3, "1", "PLAYER1", "player3"]) {
    assert.equal(seatKeyOf(bad), null, `expected no seat for ${String(bad)}`);
  }
});

// ════════════════════════════════════════════════════════════════════════
// 2. Every game's helper agrees with the one rule
// ════════════════════════════════════════════════════════════════════════

test("parity: every game derives the same verdict from the same settled row", () => {
  /** The rows a settlement can write, plus the seats a viewer can hold. */
  const rows = [
    "player1",
    "player2",
    "tie",
    "draw",
    null,
  ];
  const seats = ["player1", "player2", null];

  for (const result of rows) {
    for (const seat of seats) {
      const expected = viewerOutcome({ result, viewerSeat: seat });

      // Speed Typing speaks seats as NUMBERS; everyone else speaks seat KEYS.
      const numericSeat =
        seat === "player1" ? 1 : seat === "player2" ? 2 : null;
      assert.equal(
        speedTypingOutcome({ result, viewerSeat: numericSeat }),
        expected,
        `speed-typing: ${result} @ ${seat}`,
      );

      assert.equal(
        ticTacToeOutcome({ result, viewerSeat: seat }),
        expected ?? "draw",
        `tic-tac-toe: ${result} @ ${seat}`,
      );

      assert.equal(
        solitaireOutcome(seat, result ?? undefined),
        expected,
        `solitaire-duel: ${result} @ ${seat}`,
      );
      assert.equal(
        sudokuOutcome(seat, result ?? undefined),
        expected,
        `sudoku-duel: ${result} @ ${seat}`,
      );

      // Barricade has no draw state at all (its settlement always names a seat),
      // so the draw rows are outside its domain; a named winner must still match.
      if (result === "player1" || result === "player2") {
        assert.equal(
          barricadeOutcome({ result, viewerSeat: seat }),
          expected,
          `barricade: ${result} @ ${seat}`,
        );
      }
    }
  }
});

test("parity: the id fallback is identical everywhere, guest ids included", () => {
  // A row that names a winner without a result string: the helper compares the
  // id the SERVER gave the viewer's seat — a guest id counts.
  for (const [winnerId, viewerId, expected] of [
    [GUEST, GUEST, "win"],
    [GUEST, CLERK, "loss"],
    [CLERK, GUEST, "loss"],
  ]) {
    assert.equal(
      viewerOutcome({ winnerId, viewerId }),
      expected,
      `shared: ${winnerId} vs ${viewerId}`,
    );
    assert.equal(
      speedTypingOutcome({ winnerId, viewerSeatId: viewerId }),
      expected,
      `speed-typing: ${winnerId} vs ${viewerId}`,
    );
    assert.equal(
      barricadeOutcome({ winnerId, userId: viewerId, viewerSeat: null }),
      expected,
      `barricade: ${winnerId} vs ${viewerId}`,
    );
    assert.equal(
      ticTacToeOutcome({ winnerId, userId: viewerId, viewerSeat: null }),
      expected,
      `tic-tac-toe: ${winnerId} vs ${viewerId}`,
    );
  }
});

// ════════════════════════════════════════════════════════════════════════
// 3. The result screens: the seat is the server's, never the client's
// ════════════════════════════════════════════════════════════════════════

const CLIENT_PAGE = "src/app/casino/memory-grid/[matchId]/PageClient.tsx";
const MINES_PAGE = "src/app/casino/mines-pvp/[matchId]/PageClient.tsx";
const LANE_PAGE = "src/app/casino/lane-runner/[matchId]/PageClient.jsx";
const GOLF_PAGE = "src/app/casino/mini-golf/[matchId]/PageClient.tsx";
const CHESS_PAGE = "src/app/casino/chess-game/[gameId]/PageClient.jsx";
const HEX_PAGE = "src/app/casino/hex-duel/game/[matchId]/PageClient.tsx";

/** The comparison this whole change exists to remove. */
const CLERK_VERDICT = /(winnerId|winnerClerkId)\s*===?\s*user\?\.id/;

test("authority: the four screens that compared against Clerk now read the seat", () => {
  const pages = {
    "memory-grid": code(CLIENT_PAGE),
    "mines-pvp": code(MINES_PAGE),
    "lane-runner": code(LANE_PAGE),
    "mini-golf": code(GOLF_PAGE),
  };
  for (const [game, source] of Object.entries(pages)) {
    assert.match(
      source,
      /viewerOutcome\(\{/,
      `${game} must resolve its verdict through the shared rule`,
    );
    assert.match(
      source,
      /import \{ viewerOutcome[^}]*\} from "\.\.\/\.\.\/\.\.\/\.\.\/lib\/results\/viewerOutcome"/,
      `${game} must import the platform's one verdict rule`,
    );
    assert.doesNotMatch(
      source,
      CLERK_VERDICT,
      `${game} must never decide a loss from Clerk's id`,
    );
    // The seat it hands the rule is the snapshot's own (`viewerSeat` /
    // `viewerIsPlayer1`), i.e. the server's answer.
    assert.match(
      source,
      /(viewerSeat|viewerIsPlayer1)/,
      `${game} must take its seat from the server's payload`,
    );
  }
});

test("authority: no result screen in the casino derives a loss from a client id", () => {
  /** Every match view under src/app/casino (the result screens live there). */
  const walk = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return walk(full);
      return /^PageClient\.(jsx|tsx)$/.test(entry.name) ? [full] : [];
    });

  const offenders = [];
  for (const file of walk("src/app/casino")) {
    if (CLERK_VERDICT.test(code(file))) offenders.push(file);
  }
  assert.deepEqual(
    offenders,
    [],
    `these result screens still decide a verdict from Clerk's id: ${offenders.join(", ")}`,
  );
  // The scan is only meaningful if it actually looked at the match views.
  assert.ok(walk("src/app/casino").length >= 15, "expected to scan the casino pages");
});

test("authority: chess reads its side from the server's viewerRole, not the URL", () => {
  const chess = code(CHESS_PAGE);
  // The URL parameter survives as the pre-load hint only…
  assert.match(chess, /const urlColor = searchParams\.get\("color"\)/);
  // …and the payload's own role wins the moment it lands.
  assert.match(chess, /gameData\?\.viewerRole === "white" \|\| gameData\?\.viewerRole === "black"/);
  assert.match(chess, /\? gameData\.viewerRole\s*\n?\s*: urlColor/);
  // The verdict itself still compares the row's winner against the row's own id
  // for that seat.
  assert.match(chess, /gameData\.winnerId === myId/);
  assert.doesNotMatch(chess, CLERK_VERDICT);
});

test("authority: hex-duel reads its side from the server's amHost, not the URL", () => {
  const hex = code(HEX_PAGE);
  // `?host=1` is the pre-load hint (parsed from the route the lobby opened —
  // the match page no longer creates games, so there is no `hostParam` to
  // compare; the same query flag now arrives as `isHostRoute`)…
  assert.match(hex, /useState<boolean>\(\(\) => isHostRoute \|\| isAiMatch\)/);
  // …and the status route's `amHost` (computed from the verified session)
  // overrides it.
  assert.match(hex, /typeof data\.game\?\.amHost === "boolean"/);
  assert.match(hex, /setIsPlayer1\(data\.game\.amHost\)/);
  assert.doesNotMatch(hex, CLERK_VERDICT);
});

test("authority: precision's seat is stamped by the server, not sessionStorage", () => {
  // The match view used to read its seat from `precision:localSeat` in
  // sessionStorage — written by the lobby and DEFAULTING TO SEAT 1. A seat-2
  // winner who reloaded in a fresh tab was told they had lost. The seat now comes
  // from the get-match route's own verified identity, and the match view carries
  // it across the shared socket broadcasts.
  const route = code("src/app/api/precision/get-match/route.ts");
  assert.match(route, /export function seatForViewer\(/);
  assert.match(route, /viewerSeat: seatForViewer\(match, gate\.playerId\)/);
  assert.match(route, /if \(!playerId\) return null/);

  const hook = code("src/hooks/usePrecisionMatchState.ts");
  assert.match(hook, /const serverSeatRef = useRef<1 \| 2 \| null>\(null\)/);
  assert.match(hook, /if \(next\.viewerSeat === 1 \|\| next\.viewerSeat === 2\)/);
  assert.match(hook, /\{ \.\.\.next, viewerSeat: serverSeatRef\.current \}/);

  // And the verdict reads that seat, with the stored hand-off only as fallback.
  const popup = code("src/hooks/usePrecisionEndPopup.ts");
  assert.match(popup, /const mySeat = state\.viewerSeat \?\? localSeat/);
  assert.match(popup, /const result = state\.winnerSeat === mySeat \? "win" : "loss"/);
  assert.doesNotMatch(
    popup,
    /state\.winnerSeat === localSeat \? "win" : "loss"/,
    "the verdict must not read the client's stored seat directly",
  );
});

test("authority: the other games' seats already come from the server's payload", () => {
  // These never consulted the client's identity for a verdict; each reads the
  // seat or the viewer-relative result the server sends. Pinned so a future
  // edit cannot quietly replace one with a Clerk comparison.
  const sources = {
    "keno-pvp": "src/app/casino/keno-pvp/[matchId]/PageClient.jsx",
    "dice-flush": "src/app/casino/dice-flush/PageClient.tsx",
    "uno": "src/app/casino/uno/game/[gameId]/PageClient.jsx",
    "pool-masters": "src/app/casino/pool-masters/game/[matchId]/PageClient.tsx",
    "dots-and-boxes": "src/app/casino/dots-and-boxes/game/[gameId]/PageClient.tsx",
    "four-in-a-row": "src/app/casino/four-in-a-row/game/[gameId]/PageClient.tsx",
    "rps": "src/app/casino/rps/game/[gameId]/PageClient.tsx",
  };
  for (const [game, file] of Object.entries(sources)) {
    assert.doesNotMatch(
      code(file),
      CLERK_VERDICT,
      `${game} must not decide a verdict from Clerk's id`,
    );
  }
  // Spot-check the mechanism each one relies on, so the guard cannot pass by
  // the field simply disappearing.
  assert.match(read(sources["keno-pvp"]), /const me = match\.viewerIsPlayer1 \? "player1" : "player2"/);
  assert.match(read(sources["keno-pvp"]), /const iWon = result === me;/);
  assert.match(read(sources["dice-flush"]), /const viewerSeatId = viewerId \?\? user\?\.id;/);
  assert.match(read(sources["uno"]), /d\.winner === d\.role/);
  assert.match(read(sources["pool-masters"]), /data\.viewerSeat/);
  assert.match(read(sources["dots-and-boxes"]), /game\.role === "host"/);
  assert.match(read(sources["four-in-a-row"]), /game\.role === "host"/);
  assert.match(read(sources["rps"]), /winner === "you"/);
});
