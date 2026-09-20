import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// ── Four-In-A-Row final result presentation ────────────────────────────
// There is exactly ONE result system (the shared PvpResultScreen), and these
// checks pin what Four in a Row does with it: it feeds the panel the real
// outcome and the real winning line, drawn with the game's own Disc in the
// winner's own colours, through the panel's supported game-specific slot —
// so the winning four stay readable after the board dims. A draw has no line,
// so it passes nothing and stays neutral. No gameplay, payout, result
// calculation or server value is touched.

const GAME = fs.readFileSync(
  "src/app/casino/four-in-a-row/game/[gameId]/PageClient.tsx",
  "utf8",
);
const AI = fs.readFileSync(
  "src/app/casino/four-in-a-row/play-ai/PageClient.tsx",
  "utf8",
);
const PANEL = fs.readFileSync("src/components/result/PvpResultScreen.jsx", "utf8");

test("Four-In-A-Row: the panel gets the real outcome and the real winning line", () => {
  // Both pages build the strip from findWinningLine's real cells, and only
  // when a line exists — so a draw passes nothing.
  assert.match(GAME, /const winStrip = winLine \? \(/);
  assert.match(GAME, /\{winLine\.map\(\(cell\) => \(/);
  assert.match(AI, /const winStrip = winLine && winnerValue \? \(/);
  assert.match(AI, /\{winLine\.map\(\(cell\) => \(/);
  // The winning line itself still comes from the read-only helper.
  assert.match(GAME, /findWinningLine\(board, winnerValue\)/);
  assert.match(AI, /findWinningLine\(board, winnerValue\)/);
});

test("Four-In-A-Row: the strip uses the game's own Disc, in the winner's colours", () => {
  // No new visual identity: the same <Disc> the board uses.
  assert.match(GAME, /<Disc value=\{winnerDiscValue\} \/>/);
  assert.match(AI, /<Disc value=\{winnerValue\} \/>/);
  // The colour is the REAL winner's seat, not "me" — so a loss shows the
  // opponent's discs rather than a celebrating treatment.
  assert.match(
    GAME,
    /const winnerDiscValue =\s*\n?\s*game\?\.winnerClerkId && game\.winnerClerkId === game\.hostClerkId \? 1 : 2;/,
  );
  assert.match(
    AI,
    /const winnerValue =\s*\n?\s*status === "won" \? HUMAN_PLAYER : status === "lost" \? AI_PLAYER : null;/,
  );
});

test("Four-In-A-Row: the strip is passed through the shared panel, never a second overlay", () => {
  // The panel's supported "here is how it ended" slot — the same one other
  // games use — not a bespoke banner or a duplicated result UI.
  assert.match(GAME, /extraContent=\{winStrip\}/);
  assert.match(AI, /extraContent=\{winStrip\}/);
  assert.match(GAME, /data-testid="fiar-result-win-line"/);
  assert.match(AI, /data-testid="fiar-result-win-line"/);
  // Still exactly one result system per page.
  assert.equal((GAME.match(/<PvpResultScreen\s*\n\s*open/g) || []).length, 1);
  assert.equal((AI.match(/<CreatorResultOverlay\s*\n\s*open/g) || []).length, 1);
  // No second WIN/LOSS/DRAW banner invented on the pages.
  assert.doesNotMatch(GAME, /data-testid="fiar-result-win-line"[\s\S]{0,400}WIN[\s\S]{0,40}LOSS/);
});

test("Four-In-A-Row: the strip is static and adds no celebration of its own", () => {
  const stripStart = GAME.indexOf("const winStrip = winLine");
  const strip = GAME.slice(stripStart, GAME.indexOf("<PvpResultScreen", stripStart));
  assert.ok(strip.length > 0, "strip block located");
  // No particles, no glow, no looping animation, no extra motion controller —
  // the shared panel owns the entrance and the confetti.
  assert.doesNotMatch(strip, /fireConfetti|confetti|particle/i);
  assert.doesNotMatch(strip, /animation|infinite|motion\.|keyframes/);
  // It reads only the winning line + the winner's colour.
  assert.doesNotMatch(strip, /fetch\(/);
  assert.doesNotMatch(strip, /payout|tokenDelta|betAmount/);
  assert.doesNotMatch(strip, /setGame\(|setBoard/);
});

test("Four-In-A-Row: the shared panel celebrates a WIN only, and never under reduced motion", () => {
  assert.match(PANEL, /if \(!open \|\| outcome !== "win"\) return;/);
  assert.match(PANEL, /if \(shouldReduce\) return;/);
  // The confetti is bounded, not an endless emitter.
  assert.match(PANEL, /fireConfetti\(\{ particleCount: 90/);
  assert.doesNotMatch(PANEL, /setInterval\([\s\S]{0,120}fireConfetti/);
});

test("Four-In-A-Row: a DRAW lands neutral — no overshoot, no winner emphasis", () => {
  // The panel gives a draw its own dead-neutral landing (a plain ease) instead
  // of the win's overshoot spring.
  assert.match(
    PANEL,
    /outcome === "draw"\s*\n?\s*\? \{ duration: 0\.3, ease: "easeOut" \}/,
  );
  // A draw passes no sides/highlight and no strip.
  assert.match(GAME, /const outcome = isDraw \? "draw" : playerWon \? "win" : "loss";/);
  assert.match(AI, /outcome=\{status === "won" \? "win" : status === "draw" \? "draw" : "loss"\}/);
  // And the winner-block is never built for a draw (winLine is null).
  assert.match(GAME, /game\?\.result === "draw"[\s\S]{0,120}return null;/);
});

test("Four-In-A-Row: the board is not hidden for the result", () => {
  // The panel is a fixed overlay with a partial backdrop, and the page keeps
  // rendering the board underneath — nothing is torn down for the result.
  assert.match(PANEL, /bg-black\/80/);
  assert.match(PANEL, /backdrop-blur-sm/);
  assert.match(GAME, /const c4BoardNode = \(/);
  assert.doesNotMatch(GAME, /status === "finished"[\s\S]{0,80}\? null[\s\S]{0,80}c4BoardNode/);
});
