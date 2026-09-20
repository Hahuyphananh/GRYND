import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// ── Four-In-A-Row audio feedback ───────────────────────────────────────
// Gameplay, AI, server/API, scoring, win detection, timers and the falling
// animation are all untouched. What these checks pin is the SOUND layer:
// that it is built on the project's existing audio infrastructure, that each
// cue is wired to the right moment, and — most importantly — that no cue can
// be replayed by a poll, a socket echo or a re-render.

const GAME = fs.readFileSync(
  "src/app/casino/four-in-a-row/game/[gameId]/PageClient.tsx",
  "utf8",
);
const AI = fs.readFileSync(
  "src/app/casino/four-in-a-row/play-ai/PageClient.tsx",
  "utf8",
);
const AUDIO = fs.readFileSync("src/lib/fourInARowAudio.ts", "utf8");

test("Four-In-A-Row audio: it reuses the shared audio infrastructure", () => {
  // No new library and no audio files: the module is Web Audio, routed through
  // the page-wide context so the global mute gate and Creator Mode capture both
  // work without per-game code.
  assert.match(AUDIO, /import \{ getSharedAudioContext, getSharedOutputNode \} from "\.\/creator-mode\/audioTap";/);
  assert.match(AUDIO, /function getCtx\(\): AudioContext \| null \{\s*\n\s*return getSharedAudioContext\(\);/);
  assert.match(AUDIO, /getSharedOutputNode\(\) \|\| ctx\.destination/);
  assert.doesNotMatch(AUDIO, /from "(howler|tone|soundjs|@?use-sound)"/);
  assert.doesNotMatch(AUDIO, /\.(mp3|wav|ogg)"/);
  // Matches the established per-game audio modules' shape.
  const gameAudio = fs.readFileSync("src/lib/gameAudio.ts", "utf8");
  for (const helper of ["createOscillator", "createGain", "exponentialRampToValueAtTime"]) {
    assert.ok(AUDIO.includes(helper), `uses ${helper}`);
    assert.ok(gameAudio.includes(helper), `${helper} is the shared pattern`);
  }
});

test("Four-In-A-Row audio: a short cue exists for every meaningful action", () => {
  for (const name of [
    "playFiarSelect",
    "playFiarLand",
    "playFiarMatchStart",
    "playFiarWin",
    "playFiarLoss",
    "playFiarDraw",
  ]) {
    assert.match(AUDIO, new RegExp(`export function ${name}\\(`));
  }
  // The opponent's landing is the same primitive, distinguished by its own
  // pitch/volume so the two never read as one event.
  assert.match(AUDIO, /export function playFiarOpponentLand\(\) \{\s*\n\s*playFiarLand\(false\);/);
  assert.match(AUDIO, /const freq = mine \? 240 : 178;/);
  // Deliberately short arcade feedback — every cue is well under a second.
  const durations = [...AUDIO.matchAll(/playTone\([^,]+, ([\d.]+)/g)].map((m) => Number(m[1]));
  const chimes = [...AUDIO.matchAll(/playChime\([^,]+, ([\d.]+)/g)].map((m) => Number(m[1]));
  for (const value of [...durations, ...chimes]) {
    assert.ok(value <= 0.5, `cue duration ${value}s stays short`);
  }
  // No timers, no loops, nothing that keeps running after a cue.
  assert.doesNotMatch(AUDIO, /setInterval|requestAnimationFrame|while \(/);
});

test("Four-In-A-Row audio: the interaction cue fires immediately on the valid interaction", () => {
  // Selecting a column is only ever reached after the page's own validation:
  // canPlay / loadingMove / a full column all return before the cue.
  assert.match(
    GAME,
    /const playColumn = async \(column: number\) => \{\s*\n\s*if \(!canPlay \|\| loadingMove\) return;\s*\n\s*if \(getDropRow\(game\.board, column\) < 0\) return;\s*\n\s*\n[\s\S]{0,400}?playFiarSelect\(\);\s*\n\s*setPendingCol\(column\);/,
  );
  // vs-AI: same thing — after the status/turn/column checks, before the fall.
  assert.match(
    AI,
    /if \(status !== "playing" \|\| aiThinking \|\| moveLockRef\.current\) return;\s*\n\s*if \(countPieces\(board\) % 2 !== 0\) return;[^\n]*\n\s*const row = getDropRow\(board, col\);\s*\n\s*if \(row < 0\) return;\s*\n\s*\n[\s\S]{0,600}?playFiarSelect\(\);\s*\n\s*moveLockRef\.current = true;/,
  );
});

test("Four-In-A-Row audio: the landing cue fires at touchdown, once per move", () => {
  // Multiplayer: the disc's own teardown is the true landing moment, keyed on
  // the drop's move identity so a re-armed timer can't sound it twice.
  assert.match(
    GAME,
    /if \(lastLandSoundRef\.current !== key\) \{\s*\n\s*lastLandSoundRef\.current = key;\s*\n\s*playFiarLand\(isMine\);/,
  );
  // ...and the landing is attributed to the disc's actual owner.
  assert.match(GAME, /const isMine = fallingDisc\.value === \(game\?\.role === "host" \? 1 : 2\);/);
  // The old start-of-fall tone is gone: one cue per move, at touchdown.
  assert.doesNotMatch(GAME, /playUiTone/);
  assert.doesNotMatch(GAME, /from "[^"]*lib\/gameAudio"/);
  // vs-AI: the fall state clearing IS the landing (immediately under reduced
  // motion, where there is no fall), keyed on the drop's own key.
  assert.match(
    AI,
    /const landed = fallingRef\.current;\s*\n\s*if \(!landed\) return;\s*\n\s*fallingRef\.current = null;[\s\S]{0,200}?if \(lastLandSoundRef\.current === landed\.key\) return;\s*\n\s*lastLandSoundRef\.current = landed\.key;\s*\n\s*playFiarLand\(landed\.mine\);/,
  );
  assert.match(AI, /mine: dropAnim\.value === HUMAN_PLAYER,/);
});

test("Four-In-A-Row audio: the result cue is keyed on the outcome, so polling cannot replay it", () => {
  // Multiplayer: previously `playUiTone("win")` re-fired on every 5s poll for as
  // long as the result screen stayed open. Now one cue per settled outcome.
  assert.match(GAME, /const resultSoundedRef = useRef<string \| null>\(null\);/);
  assert.match(
    GAME,
    /const resultKey = `\$\{gameId\}-\$\{gameData\.result\}-\$\{gameData\.winnerClerkId \|\| "none"\}`;\s*\n\s*if \(resultSoundedRef\.current !== resultKey\) \{\s*\n\s*resultSoundedRef\.current = resultKey;\s*\n\s*if \(gameData\.result === "draw"\) playFiarDraw\(\);\s*\n\s*else if \(wonByMe\) playFiarWin\(\);\s*\n\s*else playFiarLoss\(\);/,
  );
  // The win/loss/draw mapping comes from the server's own outcome, not from
  // anything the sound layer computes.
  assert.match(GAME, /const wonByMe =\s*\n\s*Boolean\(gameData\.winnerClerkId\) &&/);
  // vs-AI: keyed on the move that produced the result, so a re-render or a reset
  // can't replay it while a genuinely new finished game still sounds.
  assert.match(AI, /const resultSoundedRef = useRef<string \| null>\(null\);/);
  assert.match(
    AI,
    /const resultKey = `four-in-a-row-\$\{result\}-\$\{animSeqRef\.current\}`;\s*\n\s*if \(resultSoundedRef\.current !== resultKey\) \{\s*\n\s*resultSoundedRef\.current = resultKey;\s*\n\s*if \(result === "won"\) playFiarWin\(\);\s*\n\s*else playFiarLoss\(\);/,
  );
  assert.match(
    AI,
    /const drawKey = `four-in-a-row-draw-\$\{animSeqRef\.current\}`;[\s\S]{0,120}?playFiarDraw\(\);/,
  );
  // The result cue reads the outcome — it never changes it.
  assert.doesNotMatch(AUDIO, /setStatus|setGame|fetch\(/);
});

test("Four-In-A-Row audio: the match-start cue is a real transition, not a first paint", () => {
  // Multiplayer: one cue per waiting/ready → in_progress hand-over; the first
  // snapshot (prev === null) is explicitly not a transition.
  assert.match(
    GAME,
    /prevGameStatusRef\.current !== null &&\s*\n\s*prevGameStatusRef\.current !== status &&\s*\n\s*status === "in_progress"\s*\n\s*\) \{\s*\n\s*playFiarMatchStart\(\);/,
  );
  // vs-AI: New Game is a genuine new match.
  assert.match(AI, /fallingRef\.current = null;\s*\n\s*playFiarMatchStart\(\);/);
});

test("Four-In-A-Row audio: the landing cue never fires for a board reset", () => {
  // vs-AI clears the in-flight record BEFORE clearing the board, so a New Game
  // reset can't be mistaken for a landing.
  const reset = AI.slice(AI.indexOf("const resetGame = useCallback"), AI.indexOf("const statusText = useMemo"));
  assert.ok(reset.indexOf("fallingRef.current = null") < reset.indexOf("setDropAnim(null)"));
});

test("Four-In-A-Row audio: cues are driven by events, never by a repeating loop", () => {
  for (const [name, src] of [
    ["multiplayer", GAME],
    ["vs-AI", AI],
  ]) {
    // No cue is played from inside a repeating interval — the pages' own timers
    // drive the game, never the sound, so nothing can re-fire on a tick.
    const intervals = [...src.matchAll(/setInterval\(([\s\S]{0,240}?)\}\)/g)]
      .map((m) => m[1])
      .join("\n");
    assert.doesNotMatch(intervals, /playFiar/, `${name}: no cue from an interval`);
    // Exactly one call site per meaningful moment (select, landing, match
    // start, win, loss, draw) — no strays, no duplicates.
    const calls = src.match(/\bplayFiar\w*\(/g) || [];
    assert.equal(calls.length, 6, `${name}: one call site per cue, got ${calls.length}`);
  }
  // And the module keeps no global throttle, so a genuine second event is never
  // swallowed (deduplication belongs to the call sites above).
  assert.match(AUDIO, /Deduplication is the CALLER's job/);
});
