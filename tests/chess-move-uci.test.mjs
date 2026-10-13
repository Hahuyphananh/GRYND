/**
 * Chess move storage — the UCI encoding written to `chess_moves.move_uci`.
 *
 * `/api/chess/move` used to store `${from}${to}${promotion || ""}` from the
 * REQUEST, whose `promotion` defaulted to `"q"`. Every ordinary move was
 * therefore persisted as `"e2e4q"` while Stockfish answers `bestmove e2e4`, and
 * because the evaluator compares the two strings for equality, `bestMoves` could
 * never be anything but 0.
 *
 * The encoding is pinned from two angles, following the convention of
 * tests/chess-promotion.test.mjs:
 *
 *   1. BEHAVIOUR — a real chess.js replay through the shared encoder
 *      (`toStoredUci`) for ordinary moves, castling, en passant and all four
 *      promotions, plus a re-run of the OLD expression showing it really did
 *      disagree with the engine's format;
 *   2. the ROUTE's own contract — the stored string is built from the move
 *      chess.js validated and applied, never from the request payload.
 *
 * Run:  node --import tsx --test tests/chess-move-uci.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { Chess } from "chess.js";

import { toStoredUci } from "../src/lib/chessMoveUci.js";

const read = (p) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");

const route = read("src/app/api/chess/move/route.js");

/** What Stockfish prints for a move: lowercase, promotion piece only if any. */
const ENGINE_FORMAT = /^[a-h][1-8][a-h][1-8][qrbn]?$/;
const engineWouldPrint = (played) =>
  `${played.from}${played.to}${played.promotion ?? ""}`.toLowerCase();

/** Replays SAN from the start (or a FEN) and returns the chess.js Move objects. */
function replay(sans, fen) {
  const chess = new Chess(fen);
  return sans.map((san) => {
    const played = chess.move(san);
    assert.ok(played, `fixture move "${san}" must be legal`);
    return played;
  });
}

// ════════════════════════════════════════════════════════════════════
// 1. Ordinary moves — four characters, exactly the engine's format
// ════════════════════════════════════════════════════════════════════

test("an ordinary move stores four-character UCI — the format Stockfish answers with", () => {
  const played = replay(["e4", "e5", "Nf3", "Nc6", "Bc4"]);

  for (const move of played) {
    const stored = toStoredUci(move);
    assert.equal(stored, move.lan, "the stored UCI is chess.js's own lan");
    assert.equal(
      stored,
      engineWouldPrint(move),
      `${move.san} must be stored exactly as the engine would print it`,
    );
    assert.equal(stored.length, 4, `${move.san} must not carry a promotion suffix`);
    assert.match(stored, ENGINE_FORMAT);
    assert.equal(move.promotion, undefined, "none of these moves is a promotion");
  }

  assert.equal(toStoredUci(played[0]), "e2e4");
  assert.equal(toStoredUci(played[1]), "e7e5");
});

test("the OLD encoding disagreeing with the engine is what zeroed bestMoves", () => {
  // The old expression, verbatim: the request's promotion (default "q") was
  // interpolated into every stored move.
  const played = new Chess().move("e4");
  const requestPromotion = "q"; // `const { ..., promotion = "q" } = await req.json()`
  const oldStored = `${played.from}${played.to}${requestPromotion || ""}`;

  assert.equal(oldStored, "e2e4q");
  assert.equal(oldStored.length, 5);
  assert.notEqual(oldStored, toStoredUci(played), "the encoder must not reproduce it");
  // The evaluator compares `engineBestMoveUci === playedUci`, and a bestmove is
  // never five characters — so the old form could never match.
  assert.notEqual(oldStored, engineWouldPrint(played));
  assert.equal(toStoredUci(played), engineWouldPrint(played));
});

// ════════════════════════════════════════════════════════════════════
// 2. Promotions — the piece that was actually played
// ════════════════════════════════════════════════════════════════════

test("a promotion stores its actual promotion piece (all four, both colours)", () => {
  const whiteToPromote = "rnbqkbn1/pppppppP/8/8/8/8/PPPPPPP1/RNBQKBN1 w - - 0 1";
  const blackToPromote = "rnbqkbn1/ppppppp1/8/8/8/8/PPPPPPPp/RNBQKBN1 b - - 0 1";

  for (const piece of ["q", "r", "b", "n"]) {
    const white = replay([`h8=${piece.toUpperCase()}`], whiteToPromote)[0];
    assert.equal(white.promotion, piece, `h8=${piece} really promotes to ${piece}`);
    assert.equal(
      white.flags.includes("p"),
      true,
      "chess.js flags a real promotion with 'p'",
    );
    assert.equal(toStoredUci(white), white.lan);
    assert.equal(toStoredUci(white), `h7h8${piece}`);
    assert.equal(toStoredUci(white), engineWouldPrint(white));
    assert.match(toStoredUci(white), ENGINE_FORMAT);

    const black = replay([`h1=${piece.toUpperCase()}`], blackToPromote)[0];
    assert.equal(black.promotion, piece);
    assert.equal(toStoredUci(black), `h2h1${piece}`);
    assert.equal(toStoredUci(black), engineWouldPrint(black));
  }
});

test("the promotion suffix appears only when a promotion actually happens", () => {
  // A client asking for a knight does not make an ordinary pawn move a
  // promotion — the suffix follows the validated move, not the request.
  const ordinary = new Chess().move("e4");
  assert.equal(ordinary.promotion, undefined, "chess.js sets no promotion here");
  assert.equal(ordinary.flags.includes("p"), false);
  // Even if a stray promotion is attached to an ordinary move's squares, the
  // missing chess.js promotion flag keeps the stored string four characters.
  assert.equal(toStoredUci({ ...ordinary, promotion: "n" }), "e2e4");
  assert.equal(toStoredUci({ from: "e2", to: "e4", promotion: "n", flags: "b" }), "e2e4");

  // …while a real promotion keeps the chosen piece.
  const promoting = replay(["h8=N"], "rnbqkbn1/pppppppP/8/8/8/8/PPPPPPP1/RNBQKBN1 w - - 0 1")[0];
  assert.equal(promoting.flags.includes("p"), true);
  assert.equal(toStoredUci(promoting), "h7h8n");
  // Without chess.js's fields at all, the caller's promotion is the only
  // signal available — so it is honoured.
  assert.equal(toStoredUci({ from: "h7", to: "h8", promotion: "N" }), "h7h8n");

  // A move object with no promotion field at all stays four characters.
  assert.equal(toStoredUci({ from: "g1", to: "f3" }), "g1f3");
  assert.match(toStoredUci({ from: "g1", to: "f3", promotion: "" }), ENGINE_FORMAT);
  assert.equal(toStoredUci({ from: "G1", to: "F3" }), "g1f3", "case is normalised");
});

// ════════════════════════════════════════════════════════════════════
// 3. Castling and en passant — the move's own squares
// ════════════════════════════════════════════════════════════════════

test("castling and en passant store the move's own squares (UCI, not SAN)", () => {
  const castling = replay(["e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5", "O-O"]);
  const kingSideCastle = castling[castling.length - 1];
  assert.equal(kingSideCastle.san, "O-O");
  assert.equal(toStoredUci(kingSideCastle), "e1g1");

  const enPassant = replay(["e4", "a6", "e5", "d5", "exd6"]);
  const capture = enPassant[enPassant.length - 1];
  assert.equal(capture.san, "exd6");
  assert.equal(capture.flags.includes("e"), true, "the fixture really is en passant");
  assert.equal(toStoredUci(capture), "e5d6");
});

test("a malformed move encodes to nothing rather than to invented UCI", () => {
  for (const bad of [null, undefined, {}, { from: "e2" }, { to: "e4" }, { from: "e9", to: "e4" }, { from: "zz", to: "e4" }]) {
    assert.equal(toStoredUci(bad), "", `${JSON.stringify(bad)} must not encode`);
  }
});

// ════════════════════════════════════════════════════════════════════
// 4. The route's contract
// ════════════════════════════════════════════════════════════════════

test("the route stores the encoder's output, not the request's squares", () => {
  assert.match(
    route,
    /import \{ toStoredUci \} from "\.\.\/\.\.\/\.\.\/\.\.\/lib\/chessMoveUci"/,
    "the route must use the shared encoder",
  );
  assert.ok(
    route.includes("const storedUci = toStoredUci(playedMove);"),
    "the stored UCI must come from the validated move object",
  );
  assert.ok(
    route.includes("moveUci: storedUci,"),
    "the insert must persist that string",
  );
  // The old interpolation is gone — it was the bug.
  assert.ok(
    !route.includes("${from}${to}"),
    "the request's squares must never be interpolated into move_uci",
  );
  assert.doesNotMatch(
    route,
    /moveUci:\s*`\$\{from\}/,
    "move_uci must not be built from the request payload",
  );

  // Order: chess.js validates first, the encoder runs on its RESULT.
  const applied = route.indexOf("const playedMove = chess.move({ from, to, promotion });");
  const rejected = route.indexOf("if (!playedMove)", applied);
  const encoded = route.indexOf("toStoredUci(playedMove)", applied);
  assert.ok(applied > 0, "the move must be applied through chess.js");
  assert.ok(rejected > applied, "an illegal move must be rejected before anything is stored");
  assert.ok(encoded > rejected, "only a validated move may be encoded");

  // SAN keeps coming from the same validated move, so the two stored columns
  // describe the same move.
  assert.ok(route.includes("moveSan: playedMove.san,"));
});

test("the request default still promotes, but no longer leaks into storage", () => {
  // `promotion = "q"` must stay on the chess.js call (an omitted field still
  // promotes to a queen) while storage ignores the request field entirely.
  assert.ok(
    route.includes("const { gameId, from, to, promotion = \"q\" } = await req.json();"),
    "the chess.js call must keep its queen default",
  );
  assert.ok(
    route.includes("chess.move({ from, to, promotion })"),
    "the validated move is what carries the promotion piece",
  );
});
