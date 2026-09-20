import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// ── Four-In-A-Row turn / state hierarchy ───────────────────────────────
// Visual-only: ONE derived turn state drives every cue (label, line colour,
// player-card emphasis, column lock), the active player is the strongest and
// the waiting player is secondary, a move in flight locks the board briefly,
// and a finished game drops the turn cue so the winning/result state leads.
// These source checks pin the parts a browser check can't see (the reduced-
// motion branch, the pill's one-shot timer) without touching gameplay.

const GAME = fs.readFileSync(
  "src/app/casino/four-in-a-row/game/[gameId]/PageClient.tsx",
  "utf8",
);
const AI = fs.readFileSync(
  "src/app/casino/four-in-a-row/play-ai/PageClient.tsx",
  "utf8",
);
const CSS = fs.readFileSync("src/app/globals.css", "utf8");
const MP_HARNESS = fs.readFileSync("qa/fiar-multiplayer-page.mjs", "utf8");
const AI_HARNESS = fs.readFileSync("qa/fiar-ai-page.mjs", "utf8");

test("Four-In-A-Row (multiplayer) derives ONE turn state for every cue", () => {
  assert.match(
    GAME,
    /const turnState: "mine" \| "theirs" \| "locked" \| "over" =/,
  );
  // The four sources it can be derived from, all read-only.
  assert.match(GAME, /const moveInProgress = loadingMove \|\| pendingCol !== null;/);
  assert.match(GAME, /const inProgress = game\?\.status === "in_progress";/);
  assert.match(GAME, /const isMyTurn = inProgress && !isSpectator && game\?\.currentTurn === game\?\.role;/);
  assert.match(GAME, /const activeSeat: "host" \| "guest" \| null =/);
  // Nothing else recomputes a turn cue locally.
  const derivations = GAME.match(/const turnState/g) || [];
  assert.equal(derivations.length, 1);
});

test("Four-In-A-Row (multiplayer) labels each state, and drops it when finished", () => {
  assert.match(GAME, /\? "Your move"/);
  assert.match(GAME, /`Waiting for \$\{opponentName\}`/);
  assert.match(GAME, /\? "Sending your move…"/);
  // "over" resolves to no label at all, so the cue unmounts and the
  // winning/result state leads.
  assert.match(GAME, /const c4TurnLineNode = turnLabel \? \(/);
  assert.match(GAME, /data-turn-state=\{turnState\}/);
  assert.match(GAME, /four-in-a-row-turn-line--\$\{turnState\}/);
});

test("Four-In-A-Row (multiplayer) marks only the player on the clock as active", () => {
  // Active card = the seat on the clock; the other steps back. Both fall back
  // to a plain card once the game is no longer in progress.
  assert.match(GAME, /activeSeat === "host"[\s\S]{0,120}four-in-a-row-player--active/);
  assert.match(GAME, /activeSeat === "guest"[\s\S]{0,120}four-in-a-row-player--active/);
  // Both seats fall back to the idle cue — in the creator shell AND the normal
  // view — and only while the game is in progress, so a finished match leaves
  // no card emphasised.
  const idle = GAME.match(
    /activeSeat === "(host|guest)"[^\n]*\n\s*\? "four-in-a-row-player--active[^"`]*"[\s\S]{0,80}?inProgress[\s\S]{0,60}?"four-in-a-row-player--idle[^"]*"[\s\S]{0,30}?\s*:\s*"[^"]*"/g,
  ) || [];
  assert.equal(idle.length, 4, "each seat in each view falls back to idle");
  assert.match(GAME, /data-active=\{activeSeat === "host" \? "1" : undefined\}/);
  assert.match(GAME, /data-active=\{activeSeat === "guest" \? "1" : undefined\}/);
});

test("Four-In-A-Row (multiplayer) locks the columns only while a move is in flight", () => {
  assert.match(
    GAME,
    /turnState === "locked"[\s\S]{0,80}four-in-a-row-drop-controls--locked/,
  );
});

test("Four-In-A-Row (multiplayer) shows ONE brief turn pill, never a looping banner", () => {
  // Only fires on a real switch (the first reading never banners), the previous
  // timer is always cancelled first, and it clears itself.
  assert.match(GAME, /setTurnBanner\(isMyTurn \? "Your Turn" : "Opponent's Turn"\)/);
  assert.match(GAME, /prevStatusTextRef\.current !== null/);
  assert.match(GAME, /window\.clearTimeout\(turnBannerTimerRef\.current\)/);
  assert.match(GAME, /setTurnBanner\(null\), 1200\)/);
  assert.match(GAME, /data-testid="fiar-turn-pill"/);
  // Only ever one pill in the tree.
  const pillNodes = GAME.match(/data-testid="fiar-turn-pill"/g) || [];
  assert.equal(pillNodes.length, 1);
  // No looping animation on the cue.
  assert.doesNotMatch(GAME, /turn-pill[\s\S]{0,200}repeat: Infinity/);
});

test("Four-In-A-Row (multiplayer) swaps in a travel-free pill under reduced motion", () => {
  assert.match(GAME, /reduceMotion \? TURN_PILL_REDUCED_MOTION : turnBannerAnim/);
  const variant = GAME.match(/const TURN_PILL_REDUCED_MOTION = \{[\s\S]*?\n\};/);
  assert.ok(variant, "reduced-motion pill variant exists");
  // Opacity only — no travel, no scale.
  assert.match(variant[0], /opacity: 0/);
  assert.doesNotMatch(variant[0], /\b[xy]:/);
  assert.doesNotMatch(variant[0], /scale/);
});

test("Four-In-A-Row (vs-AI) derives its own ONE turn state", () => {
  assert.match(
    AI,
    /const turnState: "mine" \| "thinking" \| "locked" \| "over" =/,
  );
  assert.match(AI, /status !== "playing"/);
  assert.match(AI, /\? "thinking"/);
  assert.match(AI, /\? "locked"/);
  assert.match(AI, /\? "over"/);
  const derivations = AI.match(/const turnState/g) || [];
  assert.equal(derivations.length, 1);
});

test("Four-In-A-Row (vs-AI) hands the emphasis between you and the AI", () => {
  assert.match(AI, /\? "Your move"/);
  assert.match(AI, /\? "AI is thinking…"/);
  assert.match(AI, /\? "Dropping…"/);
  assert.match(AI, /data-active=\{turnState === "mine" \? "1" : undefined\}/);
  assert.match(AI, /data-active=\{turnState === "thinking" \? "1" : undefined\}/);
  assert.match(AI, /data-testid="fiar-turn-line"/);
  assert.match(AI, /four-in-a-row-turn-line--\$\{turnState\}/);
  assert.match(
    AI,
    /turnState === "locked"[\s\S]{0,80}four-in-a-row-drop-controls--locked/,
  );
});

test("Four-In-A-Row turn/state CSS exists, is static, and snaps under reduced motion", () => {
  assert.match(CSS, /\.four-in-a-row-player--active\s*\{/);
  assert.match(CSS, /\.four-in-a-row-player--idle\s*\{/);
  assert.match(CSS, /\.four-in-a-row-turn-line--mine\s*\{/);
  assert.match(CSS, /\.four-in-a-row-turn-line--theirs,\s*\n\s*\.four-in-a-row-turn-line--thinking\s*\{/);
  assert.match(CSS, /\.four-in-a-row-turn-line--locked\s*\{/);
  assert.match(CSS, /\.four-in-a-row-drop-controls--locked\s*\{/);
  assert.match(CSS, /\.four-in-a-row-turn-pill\s*\{/);
  // Emphasis is a static ring/colour/opacity — never a pulse or a loop.
  // Bound the slice to the turn rules (the opponent cue has its own one-shot
  // keyframes, and later games in globals.css do loop).
  const turnStart = CSS.indexOf(".four-in-a-row-player {");
  const turnEnd = CSS.indexOf(".four-in-a-row-opponent-cue {", turnStart);
  assert.ok(turnStart >= 0 && turnEnd > turnStart, "turn section located");
  const turnBlock = CSS.slice(turnStart, turnEnd);
  assert.doesNotMatch(turnBlock, /infinite/);
  assert.doesNotMatch(turnBlock, /@keyframes/);
  // The transient turn pill is static too — it is animated by framer-motion,
  // never by a CSS loop.
  const pillStart = CSS.indexOf(".four-in-a-row-turn-pill {", turnEnd);
  const pillEnd = CSS.indexOf("@media (max-width: 480px)", pillStart);
  assert.ok(pillStart >= 0 && pillEnd > pillStart, "pill section located");
  const pillBlock = CSS.slice(pillStart, pillEnd);
  assert.doesNotMatch(pillBlock, /infinite/);
  assert.doesNotMatch(pillBlock, /@keyframes/);
  assert.doesNotMatch(pillBlock, /animation:/);
  // The hierarchy still changes under reduced motion — it just doesn't glide.
  assert.match(
    CSS,
    /@media \(prefers-reduced-motion: reduce\) \{[\s\S]{0,300}\.four-in-a-row-drop-controls--locked \{ transition: none; \}/,
  );
});

test("Four-In-A-Row QA harnesses mirror the turn/state rules they assert on", () => {
  for (const harness of [MP_HARNESS, AI_HARNESS]) {
    assert.match(harness, /\.four-in-a-row-player--active/);
    assert.match(harness, /\.four-in-a-row-player--idle/);
    assert.match(harness, /\.four-in-a-row-turn-line--mine/);
    assert.match(harness, /\.four-in-a-row-drop-controls--locked/);
  }
});

test("Four-In-A-Row turn cues never write gameplay state", () => {
  // The cue is a pure read of the seat on the clock — no server call, no
  // board write, no timer mutation anywhere near it.
  const cueBlock = GAME.slice(
    GAME.indexOf("const moveInProgress ="),
    GAME.indexOf("// ── Winning-line emphasis"),
  );
  assert.ok(cueBlock.length > 0, "turn cue block located");
  assert.doesNotMatch(cueBlock, /fetch\(/);
  assert.doesNotMatch(cueBlock, /setBoard/);
  assert.doesNotMatch(cueBlock, /checkWinner/);
});
