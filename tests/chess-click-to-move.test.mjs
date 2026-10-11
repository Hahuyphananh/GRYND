/**
 * Chess — click-to-move.
 *
 * Pieces used to move only by dragging. Both boards now also take the click,
 * click flow: click one of your pieces to pick it up (its legal destinations
 * light up), then click a destination to play the move. Dragging is untouched,
 * and both paths end in the same move code — only the pick is new.
 *
 * The interesting half of that is the position logic behind the highlight, so
 * it lives in `src/lib/chessClickMove.js` and is exercised directly here with
 * chess.js. The wiring inside the two React pages can't be imported, so it is
 * pinned as a source contract (the boards must keep BOTH input paths).
 *
 * Run:  node --import tsx --test tests/chess-click-to-move.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { Chess } from "chess.js";

import {
  legalTargetsFrom,
  isPromotionMove,
} from "../src/lib/chessClickMove.js";

const read = (p) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");

const pvp = read("src/app/casino/chess-game/[gameId]/PageClient.jsx");
const ai = read("src/app/casino/chess/ai/ChessAIPageInner.tsx");

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const squaresOf = (targets) => targets.map((t) => t.to).sort();

// ════════════════════════════════════════════════════════════════════
// 1. The targets a picked-up piece offers
// ════════════════════════════════════════════════════════════════════

test("a picked pawn offers both its quiet pushes", () => {
  assert.deepEqual(squaresOf(legalTargetsFrom(START, "e2")), ["e3", "e4"]);
  assert.ok(
    legalTargetsFrom(START, "e2").every((t) => t.capture === false),
    "a push onto an empty square is not a capture",
  );
});

test("the alias \"start\" is a real position — the board renders it before the first fetch", () => {
  // chess.js REJECTS "start", so the helper normalizes it; without that, an
  // early click would silently show no targets at all.
  assert.deepEqual(
    squaresOf(legalTargetsFrom("start", "g1")),
    squaresOf(legalTargetsFrom(START, "g1")),
  );
  assert.deepEqual(squaresOf(legalTargetsFrom("start", "g1")), ["f3", "h3"]);
});

test("a capture destination is flagged, so the board can ring it instead of dotting it", () => {
  // 1.e4 d5 — the white pawn on e4 may take on d5.
  const fen = "rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2";
  const targets = legalTargetsFrom(fen, "e4");
  const toD5 = targets.find((t) => t.to === "d5");
  assert.ok(toD5, "the e4 pawn must offer the d5 capture");
  assert.equal(toD5.capture, true);
  assert.equal(targets.find((t) => t.to === "e5").capture, false);
});

test("a piece that cannot move right now offers nothing", () => {
  assert.deepEqual(legalTargetsFrom(START, "e5"), [], "an empty square");
  assert.deepEqual(legalTargetsFrom(START, "e7"), [], "the opponent's pawn, out of turn");
  assert.deepEqual(legalTargetsFrom(START, "a1"), [], "our own rook, boxed in at home");
  assert.deepEqual(legalTargetsFrom(START, null), [], "no pick at all");
});

test("the source square is never its own destination", () => {
  for (const square of ["e2", "g1", "b1", "a1", "e1"]) {
    assert.ok(
      !legalTargetsFrom(START, square).some((t) => t.to === square),
      `${square} must not be offered as its own target`,
    );
  }
});

test("a stale or malformed board reads as \"no targets\" instead of throwing", () => {
  // chess.js v1 throws on a bad FEN; a click handler must not blow up with it.
  assert.deepEqual(legalTargetsFrom("not-a-fen", "e2"), []);
  // A missing/empty position must not fall back to chess.js's default board:
  // that would highlight the start position under a board showing something
  // else. Only the "start" alias the pages actually render is normalized.
  assert.deepEqual(legalTargetsFrom("", "e2"), []);
  assert.deepEqual(legalTargetsFrom(undefined, "e2"), []);
});

// ════════════════════════════════════════════════════════════════════
// 2. The click flow, end to end, on a real board
// ════════════════════════════════════════════════════════════════════

test("click, click plays the move the drag would have played", () => {
  // What the two clicks do, in order: pick e2 (this is what lights the board
  // up), click the e4 dot (this is the move).
  const picked = "e2";
  const targets = legalTargetsFrom(START, picked);
  assert.ok(
    targets.some((t) => t.to === "e4"),
    "the pick must offer the square the second click lands on",
  );

  const game = new Chess(START);
  const move = game.move({ from: picked, to: "e4", promotion: "q" });
  assert.equal(move.san, "e4");
  assert.equal(
    game.fen(),
    "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
  );
  // The pick has been used, so the same flow cannot replay it.
  assert.deepEqual(
    legalTargetsFrom(game.fen(), picked),
    [],
    "the picked piece is gone from e2 — the next pick is a fresh one",
  );
});

test("a click only ever reaches a move the drag could also make", () => {
  // Every dotted square must produce a legal chess.js move, or the second
  // click would reach a move the drop path would have rejected.
  const fen = "r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4";
  const sideToMove = fen.split(" ")[1];
  const board = new Chess(fen).board();
  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const piece = board[r][f];
      if (!piece || piece.color !== sideToMove) continue;
      const square = String.fromCharCode(97 + f) + (8 - r);
      for (const target of legalTargetsFrom(fen, square)) {
        const probe = new Chess(fen);
        const move = probe.move({
          from: square,
          to: target.to,
          promotion: "q",
        });
        assert.ok(move, `${square}${target.to} must be playable`);
      }
    }
  }
});

// ════════════════════════════════════════════════════════════════════
// 3. Promotion is asked about before the move is played
// ════════════════════════════════════════════════════════════════════

test("only a pawn landing on the far rank needs a promotion choice", () => {
  const promo = "rnbqkbn1/pppppppP/8/8/8/8/PPPPPPP1/RNBQKBN1 w - - 0 1";

  assert.equal(isPromotionMove(promo, "h7", "h8"), true, "h7-h8 promotes");
  assert.equal(isPromotionMove(promo, "h7", "g8"), true, "a capturing promotion too");

  // A non-pawn arriving on the last rank is an ordinary move.
  const rook = "6k1/8/8/8/8/8/8/R5K1 w - - 0 1";
  assert.equal(isPromotionMove(rook, "a1", "a8"), false, "a rook is not a pawn");

  // A pawn on the far rank stepping sideways is not a promotion, and a pawn
  // elsewhere on the board never is.
  assert.equal(isPromotionMove(START, "e2", "e4"), false, "not the far rank");
  assert.equal(isPromotionMove(promo, "h6", "g7"), false);
  assert.equal(isPromotionMove("not-a-fen", "h7", "h8"), false, "never throws");
  assert.equal(isPromotionMove(promo, null, "h8"), false);
  assert.equal(isPromotionMove(promo, "h7", null), false);
});

test("the prompted promotion is the piece that actually promotes", () => {
  const fen = "rnbqkbn1/pppppppP/8/8/8/8/PPPPPPP1/RNBQKBN1 w - - 0 1";
  assert.equal(isPromotionMove(fen, "h7", "h8"), true);
  const game = new Chess(fen);
  const knight = game.move({ from: "h7", to: "h8", promotion: "n" });
  assert.equal(knight.promotion, "n");
  assert.match(knight.san, /^h8=N/);
});

// ════════════════════════════════════════════════════════════════════
// 4. Both boards wire the click in — and keep the drag
// ════════════════════════════════════════════════════════════════════

for (const [label, source] of [
  ["the PvP page", pvp],
  ["the vs-AI page", ai],
]) {
  test(`${label} keeps dragging and adds onSquareClick`, () => {
    // Dragging is unchanged: the board still drops into onDrop.
    assert.ok(
      source.includes("onPieceDrop={onDrop}"),
      "the drag path must stay wired",
    );
    assert.match(source, /arePiecesDraggable=\{/, "pieces must stay draggable");
    // And the click path is wired to the board.
    assert.ok(
      source.includes("onSquareClick={handleSquareClick}"),
      "the board must report square clicks",
    );
    assert.ok(
      source.includes("function handleSquareClick("),
      "the click handler must be defined",
    );
  });

  test(`${label} picks a piece, shows its targets, then plays the second click`, () => {
    const body = source.slice(source.indexOf("function handleSquareClick("));
    const handler = body.slice(0, body.indexOf("\n  function ") + 1 || 4000);

    // The pick is derived from the position, not guessed from the click alone.
    assert.ok(
      source.includes("legalTargetsFrom(displayFen, selectedSquare)"),
      "the targets must come from the shared helper",
    );
    assert.ok(
      source.includes(
        'import { legalTargetsFrom, isPromotionMove } from "../../../../lib/chessClickMove";',
      ),
      "both pages must use the shared helper",
    );
    // Clicking the picked square again puts the piece back down.
    assert.ok(
      handler.includes("if (selectedSquare === square) {"),
      "a second click on the pick must deselect",
    );
    // A click on a dotted square plays it through the shared move code.
    assert.ok(
      handler.includes(
        "if (selectedSquare && selectedTargets.some((target) => target.to === square)) {",
      ),
      "only a shown target may play the move",
    );
    assert.ok(
      handler.includes("if (isPromotionMove(displayFen, from, square)) {"),
      "a promoting click must ask for the piece first",
    );
  });

  test(`${label} highlights the pick and dismisses it when the board changes`, () => {
    assert.match(
      source,
      /if \(selectedSquare\) \{\s*\n\s*styles\[selectedSquare\] = \{/,
      "the picked square must be highlighted",
    );
    assert.ok(
      source.includes("for (const target of selectedTargets) {"),
      "every destination must be drawn",
    );
    // A pick describes one position only: a fresh FEN (opponent replied, undo,
    // history navigation) must drop it.
    assert.match(
      source,
      /useEffect\(\(\) => \{\s*\n\s*setSelectedSquare\(null\);\s*\n\s*setPromotionPrompt\(null\);\s*\n\s*\}, \[displayFen\]\);/,
      "a board change must clear the pick",
    );
  });
}

test("a clicked promotion asks with its own picker, because the library's dialog cannot be opened from a click", () => {
  for (const [label, source] of [
    ["the PvP page", pvp],
    ["the vs-AI page", ai],
  ]) {
    assert.match(
      source,
      /const \[promotionPrompt, setPromotionPrompt\] = useState[<(]/,
      `${label} must track the pending promotion`,
    );
    assert.ok(
      source.includes("function confirmClickPromotion("),
      `${label} must be able to play the chosen promotion`,
    );
    assert.match(
      source,
      /onClick=\{\(\) => confirmClickPromotion\(option\.letter\)\}/,
      `${label} must offer the four pieces`,
    );
    // The library's dialog stays the drag path's picker.
    assert.ok(
      source.includes("onPromotionPieceSelect={onPromotionPieceCheck}"),
      `${label} must keep the drag promotion dialog`,
    );
  }
});

test("both input paths share one move function, so they cannot drift apart", () => {
  for (const [label, source] of [
    ["the PvP page", pvp],
    ["the vs-AI page", ai],
  ]) {
    assert.ok(
      source.includes("function applyMove("),
      `${label} must factor the move out of onDrop`,
    );
    assert.ok(
      source.includes('return applyMove(sourceSquare, targetSquare, "q")'),
      `${label}'s drop path must delegate with the default queen`,
    );
  }
});
