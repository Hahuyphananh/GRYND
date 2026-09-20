import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// ── Four-In-A-Row opponent / AI activity cue ───────────────────────────
// Visual-only: ONE one-shot outline on the other seat's card, fired when it
// takes the turn or its disc starts falling, so the opponent reads as a
// participant instead of a static label. These source checks pin the parts a
// browser check can't see — that the cue is keyed by the exact event (so a
// poll can't replay it), that it is subordinate to the local player's own
// feedback, that it only borrows existing piece colours, and that AI timing
// and logic are untouched.

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

test("Four-In-A-Row (multiplayer) derives ONE cue key from the exact event", () => {
  // One key per event: the opponent's own drop, or their turn's move count.
  assert.match(GAME, /const opponentCueKey =/);
  assert.match(GAME, /`drop-\$\{fallingDisc!\.key\}`/);
  assert.match(GAME, /`turn-\$\{cueSeat\}-\$\{moveCount\}`/);
  assert.match(GAME, /const moveCount =\s*\n?\s*Number\(game\?\.hostDiscsUsed \|\| 0\) \+ Number\(game\?\.guestDiscsUsed \|\| 0\);/);
  const derivations = GAME.match(/const opponentCueKey/g) || [];
  assert.equal(derivations.length, 1);
});

test("Four-In-A-Row (multiplayer) cues the OTHER seat, and the clock for a spectator", () => {
  assert.match(GAME, /const cueSeat: "host" \| "guest" \| null = isSpectator/);
  assert.match(GAME, /\? activeSeat\b/);
  assert.match(GAME, /game\?\.role === "host"[\s\S]{0,40}?\? "guest"/);
  assert.match(GAME, /game\?\.role === "guest"[\s\S]{0,40}?\? "host"/);
  assert.match(GAME, /const fallingSeat: "host" \| "guest" \| null = fallingDisc/);
});

test("Four-In-A-Row (multiplayer) keeps the cue subordinate to your own move", () => {
  // Only for the other seat's turn (never "mine"/"locked"), never on your card.
  assert.match(GAME, /: fallingSeat === cueSeat/);
  assert.match(GAME, /: turnState === "theirs"/);
  assert.doesNotMatch(GAME, /opponentCueKey[\s\S]{0,120}turnState === "mine"/);
  assert.doesNotMatch(GAME, /opponentCueKey[\s\S]{0,120}turnState === "locked"/);
});

test("Four-In-A-Row (multiplayer) renders the cue on both seats in both views", () => {
  assert.match(GAME, /data-testid="fiar-opponent-cue"/);
  assert.match(GAME, /aria-hidden="true"[\s\S]{0,200}fiar-opponent-cue/);
  assert.match(GAME, /className="four-in-a-row-opponent-cue"/);
  // The creator shell's mini row AND the normal cards, one per seat.
  const builtIn = GAME.match(/\{cueSeat === "(host|guest)" && opponentCueNode\}/g) || [];
  assert.equal(builtIn.length, 4, "both seats in both views");
  // Cards must be positioned so the overlay covers them.
  const relative = GAME.match(/four-in-a-row-player relative /g) || [];
  assert.equal(relative.length, 4);
});

test("Four-In-A-Row opponent cue borrows each seat's existing colour", () => {
  assert.match(GAME, /const HOST_CUE_COLOR = "rgba\(74, 222, 128/);
  assert.match(GAME, /const GUEST_CUE_COLOR = "rgba\(248, 113, 113/);
  assert.match(GAME, /cueSeat === "host" \? HOST_CUE_COLOR : GUEST_CUE_COLOR/);
  // Green/red match the host/guest card borders already in the markup.
  assert.match(GAME, /four-in-a-row-player--active border-green-400/);
  assert.match(GAME, /four-in-a-row-player--active border-red-400/);
});

test("Four-In-A-Row (vs-AI) cues the AI chip only, on existing states", () => {
  assert.match(AI, /const aiCueKey =/);
  assert.match(AI, /dropAnim && dropAnim\.value === AI_PLAYER[\s\S]{0,40}`drop-\$\{dropAnim\.key\}`/);
  assert.match(AI, /turnState === "thinking"[\s\S]{0,40}`think-\$\{countPieces\(board\)\}`/);
  assert.match(AI, /const AI_CUE_COLOR = "rgba\(192, 132, 252/);
  const derivations = AI.match(/const aiCueKey/g) || [];
  assert.equal(derivations.length, 1);
  // Exactly one cue node, on the AI chip.
  const nodes = AI.match(/data-testid="fiar-opponent-cue"/g) || [];
  assert.equal(nodes.length, 1);
  assert.match(AI, /data-testid="fiar-player-ai"[\s\S]{0,600}\{aiCueNode\}/);
});

test("Four-In-A-Row AI cue invents no timing and touches no AI logic", () => {
  // The cue block itself is a pure read — no delays, no requests, no state.
  const start = AI.indexOf("const aiCueKey =");
  const block = AI.slice(start, AI.indexOf("const aiTurnLineNode"));
  assert.ok(block.length > 0, "cue block located");
  assert.doesNotMatch(block, /setTimeout/);
  assert.doesNotMatch(block, /setAiThinking/);
  assert.doesNotMatch(block, /fetch\(/);
  assert.doesNotMatch(block, /pickAiMove/);
  // The existing pacing is untouched.
  assert.match(AI, /const AI_THINK_DELAY_MS = 450;/);
  assert.match(AI, /const DROP_DURATION_MS = 360;/);
});

test("Four-In-A-Row cue CSS is one finite run, and off under reduced motion", () => {
  assert.match(CSS, /\.four-in-a-row-opponent-cue\s*\{/);
  assert.match(CSS, /@keyframes fourInARowOpponentCue/);
  const cueStart = CSS.indexOf(".four-in-a-row-opponent-cue {");
  const cueEnd = CSS.indexOf(".four-in-a-row-turn-pill {", cueStart);
  assert.ok(cueStart >= 0 && cueEnd > cueStart, "cue section located");
  const cueCss = CSS.slice(cueStart, cueEnd);
  // One-shot: no looping, no pulse. Two rules (base + reduced motion).
  assert.doesNotMatch(cueCss, /infinite/);
  assert.match(cueCss, /animation: fourInARowOpponentCue \.5s ease-out both;/);
  // Ends invisible, so nothing lingers on the card.
  assert.match(cueCss, /100% \{ opacity: 0;/);
  assert.match(cueCss, /pointer-events: none/);
  assert.match(
    cueCss,
    /@media \(prefers-reduced-motion: reduce\) \{[\s\S]{0,120}\.four-in-a-row-opponent-cue \{ animation: none; opacity: 0; \}/,
  );
});

test("Four-In-A-Row opponent cue is gated by reduced motion on both pages", () => {
  assert.match(GAME, /const opponentCueKey = reduceMotion \|\| !cueSeat/);
  assert.match(AI, /const aiCueKey =\s*\n?\s*reduceMotion/);
});

test("Four-In-A-Row cue derivations never write gameplay state", () => {
  const start = GAME.indexOf("const cueSeat:");
  const block = GAME.slice(start, GAME.indexOf("const hintVisible"));
  assert.ok(block.length > 0, "multiplayer cue block located");
  assert.doesNotMatch(block, /fetch\(/);
  assert.doesNotMatch(block, /setGame\(/);
  assert.doesNotMatch(block, /setBoard/);
  assert.doesNotMatch(block, /setFallingDisc/);
  assert.doesNotMatch(block, /checkWinner/);
});

test("Four-In-A-Row QA harnesses mirror the cue they assert on", () => {
  for (const harness of [MP_HARNESS, AI_HARNESS]) {
    assert.match(harness, /\.four-in-a-row-opponent-cue \{/);
    assert.match(harness, /@keyframes fourInARowOpponentCue/);
    assert.match(harness, /four-in-a-row-player \{ position: relative;/);
  }
});
