import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// ── Four-In-A-Row match-state transitions ──────────────────────────────
// The state machine, turn logic, win detection and both result systems are
// untouched. What these checks pin is the HAND-OFF between them: the
// matchmaking takeover fades out through its own exit instead of cutting, the
// result panel fades out when the match leaves the result state instead of
// vanishing, and the reveal hold is derived synchronously so the panel can never
// flash up for a frame before the winning four have been celebrated.

const GAME = fs.readFileSync(
  "src/app/casino/four-in-a-row/game/[gameId]/PageClient.tsx",
  "utf8",
);
const AI = fs.readFileSync(
  "src/app/casino/four-in-a-row/play-ai/PageClient.tsx",
  "utf8",
);
const MATCH_WAITING = fs.readFileSync(
  "src/components/lobby/MatchWaiting.jsx",
  "utf8",
);

test("Four-In-A-Row: the matchmaking takeover is not replaced — it is an overlay over the board", () => {
  // The takeover is built as its own node and mounted in a separate branch, so
  // the board underneath is never unmounted while matchmaking runs.
  assert.match(GAME, /const matchWaitingNode =/);
  assert.match(GAME, /\{reduceMotion \? \(\s*\n\s*matchWaitingNode\s*\n\s*\) : \(\s*\n\s*<AnimatePresence>\{matchWaitingNode\}<\/AnimatePresence>/);
  assert.match(GAME, /key="fiar-match-waiting"/);
});

test("Four-In-A-Row: the takeover's own exit fade is what plays on match start", () => {
  // The shared takeover was built to be used inside <AnimatePresence> — it
  // already declares an exit — so the page must not re-animate it itself.
  assert.match(MATCH_WAITING, /exit=\{\{ opacity: 0 \}\}/);
  assert.match(MATCH_WAITING, /transition=\{\{ duration: 0\.25 \}\}/);
  // No competing wrapper animation around it (only the presence wrapper).
  assert.doesNotMatch(GAME, /<motion\.div[\s\S]{0,200}\{matchWaitingNode\}/);
});

test("Four-In-A-Row: the result panel is handed off through its own exit, once", () => {
  assert.match(GAME, /data-testid="fiar-result-transition"/);
  assert.match(
    GAME,
    /<AnimatePresence initial=\{false\}>\s*\n\s*\{showResultPopup && \(/,
  );
  assert.match(GAME, /exit=\{\{ opacity: 0 \}\}/);
  assert.match(GAME, /transition=\{\{ duration: reduceMotion \? 0 : 0\.28, ease: "easeOut" \}\}/);
  assert.match(AI, /data-testid="fiar-result-transition"/);
  assert.match(AI, /\{isGameEnded && !revealHolding && \(/);
  // ONE result system per page — no duplicate banners/second panel. (Count the
  // rendered elements only; the doc comments also mention the components.)
  assert.equal((GAME.match(/<PvpResultScreen\s*\n\s*open/g) || []).length, 1);
  assert.equal((AI.match(/<CreatorResultOverlay\s*\n\s*open/g) || []).length, 1);
});

test("Four-In-A-Row: the reveal hold is derived, so the panel can never flash", () => {
  // Derived (not effect-set): the hold is already active in the commit that
  // makes the winning four visible, so `showResultPopup` can never be true in
  // the same frame the board shows the connection.
  assert.match(GAME, /const \[revealDoneKey, setRevealDoneKey\] = useState<string \| null>\(null\);/);
  assert.match(GAME, /const revealHolding =\s*\n?\s*winVisible && winLineKey !== null && revealDoneKey !== winLineKey;/);
  assert.match(GAME, /game\?\.status === "finished" && !game\?\.nextGameId && !revealHolding;/);
  assert.match(AI, /const \[revealDoneKey, setRevealDoneKey\] = useState<string \| null>\(null\);/);
  assert.match(AI, /const revealHolding =\s*\n?\s*winVisible && winLineKey !== null && revealDoneKey !== winLineKey;/);
  assert.match(AI, /\{isGameEnded && !revealHolding && \(/);
  // The old effect-set flag is gone from both pages.
  assert.doesNotMatch(GAME, /winReveal/);
  assert.doesNotMatch(AI, /winReveal/);
  // The hold is still keyed on the winning line, so polling the same finished
  // state can't restart it, while a new line starts a fresh one.
  assert.match(GAME, /setRevealDoneKey\(winLineKey\)/);
  assert.match(AI, /setRevealDoneKey\(winLineKey\)/);
});

test("Four-In-A-Row: both hand-offs respect reduced motion", () => {
  // Matchmaking: the takeover is mounted bare, so it leaves immediately.
  assert.match(
    GAME,
    /\{reduceMotion \? \(\s*\n\s*matchWaitingNode\s*\n\s*\) : \(/,
  );
  // Result: a zero-length transition, and the shared panel zeroes its own
  // animations through withReducedMotion.
  assert.match(GAME, /reduceMotion \? 0 : 0\.28/);
  assert.match(AI, /reduceMotion \? 0 : 0\.28/);
  assert.match(GAME, /const reduceMotion = useReducedMotion\(\);/);
  assert.match(AI, /const reduceMotion = useReducedMotion\(\);/);
  assert.match(AI, /import \{ AnimatePresence, motion, useReducedMotion \} from "framer-motion";/);
});

test("Four-In-A-Row: the hand-offs are short, with no long cinematic sequence", () => {
  // The page's own transition wrappers stay inside the 150–350ms band; the
  // panel keeps its own entrance, which we did not touch.
  const wrapperDurations = [
    ...(GAME.match(/duration: reduceMotion \? 0 : ([\d.]+)/g) || []),
    ...(AI.match(/duration: reduceMotion \? 0 : ([\d.]+)/g) || []),
  ];
  assert.ok(wrapperDurations.length >= 2, "both hand-offs declare a duration");
  for (const entry of wrapperDurations) {
    const value = Number(entry.replace(/.*: /, ""));
    assert.ok(value >= 0.15 && value <= 0.35, `hand-off duration ${value}s is in band`);
  }
  // The takeover's own exit is the shared component's, unchanged.
  assert.match(MATCH_WAITING, /duration: 0\.25/);
});

test("Four-In-A-Row: the result panel content is frozen while it exits", () => {
  // The panel is handed off as a retained React element, so its props cannot be
  // rewritten by a New Game reset mid-fade: the AI page's panel is built once
  // into `resultPanel` and referenced from inside the presence wrapper.
  assert.match(AI, /const resultPanel = \(/);
  assert.match(AI, /\{resultPanel\}/);
  assert.doesNotMatch(AI, /const resultScreen = isGameEnded/);
  // The multiplayer page hands off `renderResult()`, which reads only the
  // finished game row (no freshly-reset local state).
  assert.match(GAME, /\{renderResult\(\)\}/);
});
