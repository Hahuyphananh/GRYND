/**
 * Chess — the promotion dialog contract, and the desktop board size.
 *
 * react-chessboard v4 hands the dialog's choice to the handler as
 * `onPromotionPieceSelect(PIECE, from, to)` — the chosen piece FIRST
 * ("wQ"/"bN"), the squares second. Both chess pages declared the handler as
 * `(sourceSquare, targetSquare, piece)`, so `sourceSquare` received the piece
 * string, `Chess.move()` returned null and the selection was silently dropped:
 * clicking a piece in the promotion dialog did nothing at all.
 *
 * The handler lives inside a React component and can't be imported directly, so
 * the contract is pinned from four angles:
 *   1. the LIBRARY's own call order, read out of the installed react-chessboard
 *      dist — a dependency bump that reorders the arguments fails here;
 *   2. both handlers' declared parameter order;
 *   3. the guards that make the no-argument (backdrop) call a no-op;
 *   4. a behavioural re-run of the mapping with chess.js, which shows the OLD
 *      order genuinely fails and the library's order genuinely promotes.
 *
 * Run:  node --import tsx --test tests/chess-promotion.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { Chess } from "chess.js";

const read = (p) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");

const pvp = read("src/app/casino/chess-game/[gameId]/PageClient.jsx");
const ai = read("src/app/casino/chess/ai/ChessAIPageInner.tsx");
const css = read("src/app/globals.css");
const library = read("node_modules/react-chessboard/dist/index.esm.js");

// ════════════════════════════════════════════════════════════════════
// 1. The library's argument order
// ════════════════════════════════════════════════════════════════════

test("react-chessboard still invokes the handler as (piece, from, to)", () => {
  // The dialog option component calls it directly…
  assert.match(
    library,
    /onPromotionPieceSelect\(option,\s*promoteFromSquare/,
    "the piece must come first, then the two squares",
  );
  // …and it applies the move from those two squares when the handler accepts.
  assert.ok(
    library.includes(
      "handleSetPosition(promoteFromSquare, promoteToSquare, option, true)",
    ),
    "a truthy return must promote from/to the squares the library passed",
  );
  // The dialog's backdrop closes it by calling the handler with NO arguments,
  // which is exactly why both handlers guard before touching Chess.move().
  assert.ok(
    library.includes("onPromotionPieceSelect === null || onPromotionPieceSelect === void 0 ? void 0 : onPromotionPieceSelect()"),
    "the backdrop calls the handler with no arguments",
  );
});

// ════════════════════════════════════════════════════════════════════
// 2. / 3. The handlers themselves
// ════════════════════════════════════════════════════════════════════

const paramsOf = (source, label) => {
  const at = source.indexOf("function onPromotionPieceCheck(");
  assert.ok(at > 0, `${label} must define the promotion handler`);
  const open = source.indexOf("(", at);
  const close = source.indexOf(")", open);
  return source
    .slice(open + 1, close)
    .split(",")
    .map((raw) => raw.replace(/:.*$/, "").replace(/\?/g, "").trim())
    .filter(Boolean);
};

/**
 * The move a promotion plays, wherever that page keeps it.
 *
 * The PvP page plays it inline; the vs-AI page hands the same two squares, in
 * the same order, to the one function that applies a human move (`applyMove`) —
 * which is also the function that PERSISTS it. Playing it inline on the vs-AI
 * page instead is exactly what would let a promoted move reach the board without
 * reaching the game's row, so the shared path is asserted rather than assumed.
 */
test("the promotion takes its squares from the handler's two square parameters", () => {
  assert.ok(
    pvp.includes("const sourceSquare = promoteFromSquare;") &&
      pvp.includes("const targetSquare = promoteToSquare;"),
    "the PvP move must be built from the two square parameters",
  );
  assert.ok(
    ai.includes("return applyMove(promoteFromSquare, promoteToSquare, promo);"),
    "the vs-AI promotion must go through the shared applyMove",
  );
  assert.ok(
    !ai.includes("const sourceSquare = promoteFromSquare;"),
    "the vs-AI page must not keep a second, unshared copy of the move path",
  );
});

for (const [label, source] of [
  ["the PvP page", pvp],
  ["the vs-AI page", ai],
]) {
  test(`${label} reads the chosen piece FIRST, then the two squares`, () => {
    assert.deepEqual(paramsOf(source, label), [
      "piece",
      "promoteFromSquare",
      "promoteToSquare",
    ]);

    // The chosen piece is still read off the piece option ("wN" → "n").
    assert.ok(
      source.includes('piece ? piece[1]?.toLowerCase() : "q"'),
      "the promotion letter comes from the piece option",
    );
    // The no-argument backdrop call must never attempt a move.
    assert.ok(
      source.includes("if (!promoteFromSquare || !promoteToSquare) return false;"),
      "a call without squares is not a move",
    );
    // onDrop runs right after a truthy return (the library's handleSetPosition
    // calls onPieceDrop), so the guard must exist or the move applies twice.
    assert.ok(
      source.includes("promotionHandledRef.current = true;"),
      "the promotion must be flagged so onDrop skips the duplicate",
    );
  });
}

test("a pre-move promotion keeps the piece the player chose", () => {
  // The pre-move branch queues the move itself, so it must also set the guard
  // — otherwise the onDrop that follows overwrites it with promotion: "q" and
  // every queued promotion silently becomes a queen.
  const at = pvp.indexOf("queue as pre-move");
  assert.ok(at > 0, "the PvP page must handle a pre-move promotion");
  const branch = pvp.slice(at, pvp.indexOf("// Flag that promotion handled this move so onDrop skips it", at));
  assert.ok(
    branch.includes("promotionHandledRef.current = true;"),
    "the pre-move branch must flag the promotion too",
  );
  assert.ok(
    branch.includes("premoveRef.current = { from: sourceSquare, to: targetSquare, promotion: promo }"),
    "the pre-move must carry the chosen piece",
  );
});

// ════════════════════════════════════════════════════════════════════
// 4. The mapping still promotes — and the old order really did not
// ════════════════════════════════════════════════════════════════════

test("the library's argument order promotes; the old order played no move", () => {
  // A white pawn one step from promotion, black to move but we force white.
  const fen = "rnbqkbn1/pppppppP/8/8/8/8/PPPPPPP1/RNBQKBN1 w - - 0 1";

  // What the handler is handed: the chosen piece first, then the squares.
  const piece = "wN";
  const promoteFromSquare = "h7";
  const promoteToSquare = "h8";

  const promoted = new Chess(fen);
  const knight = promoted.move({
    from: promoteFromSquare,
    to: promoteToSquare,
    promotion: piece[1].toLowerCase(),
  });
  assert.ok(knight, "the chosen piece must produce a legal move");
  assert.equal(knight.promotion, "n", "a knight was chosen, so a knight promotes");
  assert.match(knight.san, /^h8=N/, `expected a knight promotion, got ${knight.san}`);

  const queen = new Chess(fen).move({
    from: promoteFromSquare,
    to: promoteToSquare,
    promotion: "q",
  });
  assert.equal(queen.promotion, "q");
  assert.match(queen.san, /^h8=Q/, "the default promotion is still a queen");

  // The OLD (buggy) reading of the same call: the piece string used as the
  // "from" square. This is why the dialog appeared to do nothing — chess.js v1
  // THROWS on an illegal move (it does not return null), so the whole handler
  // blew up inside the click, `handleSetPosition` never ran and the board was
  // left untouched.
  assert.throws(
    () =>
      new Chess(fen).move({
        from: piece,
        to: promoteFromSquare,
        promotion: "q",
      }),
    /Invalid move/,
    "the piece string is not a square — the old order throws instead of promoting",
  );
});

test("an illegal promotion never throws out of the handler", () => {
  // chess.js v1 throws on an illegal move, so the move is resolved inside a
  // try/catch: a stale board must surface as "not promoted" (return false,
  // dialog closes) rather than an exception inside the click.

  // The PvP page resolves it in the handler itself…
  const pvpAt = pvp.indexOf("function onPromotionPieceCheck(");
  const pvpBody = pvp.slice(pvpAt, pvpAt + 4000);
  assert.ok(pvpBody.includes("try {"), "the PvP page must guard Chess.move()");
  assert.ok(
    /catch[\s\S]{0,80}(localMove = null|return false)/.test(pvpBody),
    "the PvP page must treat a rejected move as \"no move\"",
  );

  // …while the vs-AI page delegates to `applyMove`, so the guard that protects
  // the click lives there — and it must return false, never rethrow.
  const aiAt = ai.indexOf("function applyMove(");
  assert.ok(aiAt > 0, "the vs-AI page must have the shared move applier");
  const aiBody = ai.slice(aiAt, aiAt + 2600);
  assert.ok(aiBody.includes("try {"), "the vs-AI move path must guard Chess.move()");
  assert.match(
    aiBody,
    /catch \{\s*return false;\s*\}/,
    "the vs-AI page must treat a rejected move as \"no move\"",
  );

  // In both pages the no-argument backdrop call is not a move at all.
  for (const [label, source] of [
    ["the PvP page", pvp],
    ["the vs-AI page", ai],
  ]) {
    const at = source.indexOf("function onPromotionPieceCheck(");
    assert.ok(
      source
        .slice(at, at + 1200)
        .includes("if (!promoteFromSquare || !promoteToSquare) return false;"),
      `${label} must ignore the backdrop's no-argument call`,
    );
  }
});

// ════════════════════════════════════════════════════════════════════
// The desktop board size
// ════════════════════════════════════════════════════════════════════

test("both chess boards opt into the shared desktop sizing rule", () => {
  for (const [label, source] of [
    ["the PvP page", pvp],
    ["the vs-AI page", ai],
  ]) {
    assert.ok(
      source.includes("chess-board-frame"),
      `${label} must carry the shared chess-board-frame hook`,
    );
    assert.ok(
      !source.includes("max-w-[90vh]"),
      `${label} must not keep the 90vh cap (it never bound under the 660px column)`,
    );
  }
  // The square board is still a square: the size is capped by width only.
  for (const [label, source] of [
    ["the PvP page", pvp],
    ["the vs-AI page", ai],
  ]) {
    assert.match(
      source,
      /chess-board-frame[^`]*aspect-square/,
      `${label} keeps its 1:1 aspect ratio`,
    );
  }
});

test("the desktop cap saves the vertical space the page chrome needs", () => {
  // The board is a square, so a WIDTH cap is a HEIGHT cap. Capping it by the
  // viewport height (minus the header + player bars) is what keeps the whole
  // board on screen without scrolling.
  assert.match(
    css,
    /@media \(min-width: 1024px\) \{\s*\.chess-board-frame \{\s*max-width: max\(340px, calc\(100vh - 22rem\)\);\s*\}/,
    "desktop must cap the board by the viewport height, with a floor",
  );
  // The floor keeps the board usable in a very short window instead of
  // collapsing it to nothing.
  assert.ok(
    css.includes("max(340px, calc(100vh - 22rem))"),
    "the cap needs a floor",
  );
});
