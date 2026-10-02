/**
 * Mines Duel — frontend contract for the SIMULTANEOUS, independent-board
 * scoring UI.
 *
 * The match view is a large presentation component (animations, framer-motion
 * transitions, layout) that cannot be rendered in the node test runner, so this
 * file pins the CONTRACT by reading the source, the same way
 * `board-fit-desktop.test.mjs` pins its layout hooks:
 *
 *   • the top bar shows BOTH scores + the 3:00 clock, and the opponent only as
 *     compact public progress (tiles/mines) — never their board
 *   • the single, large board renders ONLY the viewer's own resolved cells
 *   • confirmed mines / wrong flags carry their existing cues, and a wrong
 *     flag is removable via the unflag route
 *   • score feedback is display-only (diffed from the authoritative snapshot),
 *     never client-computed
 *   • board completion shows BOARD CLEARED +100 / final score / waiting
 *   • the result screen reports score, tiles, flags, mines hit, completion
 *   • the old "mine hit = instant loss" messaging is gone
 *   • the client clock is visual only; the server deadline is authoritative
 *   • the existing per-match room + refetch (plus the score hint) are kept
 *
 * Run:  node --import tsx --test tests/mines-pvp-ui-contract.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(
  join(here, "..", "src/app/casino/mines-pvp/[matchId]/PageClient.tsx"),
  "utf8",
);

// ════════════════════════════════════════════════════════════════════════
// 1. Simultaneous model + top scoreboard
// ════════════════════════════════════════════════════════════════════════

test("the view documents the simultaneous, independent-board model", () => {
  assert.match(SRC, /SIMULTANEOUS, INDEPENDENT-BOARD/);
  assert.match(SRC, /There are NO turns/);
  assert.match(SRC, /OWN board/);
  // The old shared-board constant name must be gone from the client.
  assert.doesNotMatch(SRC, /SHARED INFORMATION/);
  assert.doesNotMatch(SRC, /opponentPicks/);
});

test("the top bar shows both scores and the match clock", () => {
  assert.match(SRC, /score={Number\(match\.myScore\) \|\| 0}/);
  assert.match(SRC, /score={Number\(match\.opponentScore\) \|\| 0}/);
  assert.match(SRC, /Match timer/);
  assert.match(SRC, /function formatClock\(/);
  // 3:00 layout: YOU | clock | OPPONENT.
  assert.match(SRC, /label="You"/);
  assert.match(SRC, /label=\{isAi \? "GRYND AI" : "Opponent"\}/);
});

test("the opponent is shown only as compact public progress", () => {
  // Tiles + mines counts, from the PUBLIC opponent fields.
  assert.match(SRC, /tiles · \{mines\} mines/);
  assert.match(SRC, /const opponentTilesResolved =/);
  assert.match(SRC, /opponentSafeRevealed/);
  assert.match(SRC, /opponentCorrectFlags/);
  // The opponent's board is never rendered.
  assert.doesNotMatch(SRC, /match\.opponentBoard/);
  assert.match(SRC, /opponentBoard: \{ size: number; mines: number\[\]; values\?: Record<string, number> \} \| null;/);
});

// ════════════════════════════════════════════════════════════════════════
// 2. Single large board — only the viewer's own cells
// ════════════════════════════════════════════════════════════════════════

test("the board renders the viewer's own resolved cells from their private state", () => {
  assert.match(SRC, /const myRevealMap = useMemo/);
  assert.match(SRC, /new Map<number, OwnReveal>\(\)/);
  assert.match(SRC, /match\?\.myRevealed/);
  assert.match(SRC, /const reveal = myRevealMap\.get\(cellIndex\)/);
  // No shared/per-seat accent lookup anywhere.
  assert.doesNotMatch(SRC, /cellPickSeat/);
  assert.doesNotMatch(SRC, /myPicks|opponentPicks/);
});

test("the safe-reveal clue is rendered for the viewer's own reveals", () => {
  assert.match(SRC, /function safeCellContent\(hint: number \| null\)/);
  assert.match(SRC, /function hintBadgeClass\(/);
  assert.match(SRC, /content: safeCellContent\(reveal\.hint\)/);
});

test("the board is the existing large square frame", () => {
  assert.match(SRC, /mines-board-frame/);
  assert.match(SRC, /grid grid-cols-10/);
  assert.match(SRC, /Array\.from\(\{ length: GRID_CELLS \}/);
});

// ════════════════════════════════════════════════════════════════════════
// 3. Confirmed mines + wrong flags (and unflag)
// ════════════════════════════════════════════════════════════════════════

test("a confirmed mine renders as its own bomb + a check badge", () => {
  assert.match(SRC, /const correctFlagSet = useMemo\(\(\) => new Set\(match\?\.myCorrectFlagCells \?\? \[\]\)/);
  assert.match(SRC, /if \(isCorrect\) \{/);
  assert.match(SRC, /tone: "correctFlag"/);
  assert.match(SRC, /<CheckIcon className="h-2\.5 w-2\.5" \/>/);
});

test("a wrong flag renders with a cross and can be removed via /unflag", () => {
  assert.match(SRC, /const incorrectFlagSet = useMemo\(\(\) => new Set\(match\?\.myIncorrectFlagCells \?\? \[\]\)/);
  assert.match(SRC, /tone: "wrongFlag"/);
  assert.match(SRC, /<CrossIcon className="h-2\.5 w-2\.5" \/>/);
  // Kicking the flag off submits to the unflag route, not a client mutation.
  assert.match(SRC, /postAction\("unflag", cellIndex\)/);
  assert.match(SRC, /\/\$\{action\}`/);
});

test("a reveal and a flag are separate server actions", () => {
  assert.match(SRC, /postAction\("pick", cellIndex\)/);
  assert.match(SRC, /postAction\("flag", cellIndex\)/);
  assert.match(SRC, /action === "flag" \? "mines_pvp_flag" : action === "unflag"/);
});

// ════════════════════════════════════════════════════════════════════════
// 4. Score feedback — display only
// ════════════════════════════════════════════════════════════════════════

test("score feedback is a display-only diff, never a client-computed score", () => {
  assert.match(SRC, /function ScorePop\(/);
  assert.match(SRC, /const prevScoresRef = useRef/);
  assert.match(SRC, /delta: me - prev\.me/);
  assert.match(SRC, /delta: opp - prev\.opp/);
  // The client never mutates a score.
  assert.doesNotMatch(SRC, /myScore\s*[+\-]=/);
  assert.doesNotMatch(SRC, /opponentScore\s*[+\-]=/);
  assert.doesNotMatch(SRC, /\.myScore\s*=\s/);
  // No hard-coded scoring constants in the client.
  assert.doesNotMatch(SRC, /SAFE_TILE|MINE_HIT|WRONG_FLAG|BOARD_COMPLETE/);
});

test("the mine-hit feedback reuses the existing buzz/message treatment", () => {
  assert.match(SRC, /💥 Mine hit −25/);
  assert.match(SRC, /playBuzz\(\)/);
});

// ════════════════════════════════════════════════════════════════════════
// 5. Board completion state
// ════════════════════════════════════════════════════════════════════════

test("clearing the board shows BOARD CLEARED, the +100, the final score, and a wait", () => {
  assert.match(SRC, /isActive && match\.myCompleted/);
  assert.match(SRC, /Board cleared/);
  assert.match(SRC, /\+100 bonus/);
  assert.match(SRC, /Final score/);
  assert.match(SRC, /Waiting for \{isAi \? "GRYND AI" : "opponent"\}/);
});

test("the board is disabled once completed, locked, or time is up", () => {
  assert.match(SRC, /const boardLocked = !isActive \|\| Boolean\(match\?\.myLocked\) \|\| timeLeft <= 0/);
  assert.match(SRC, /disabled=\{!clickable \|\| busy\}/);
});

// ════════════════════════════════════════════════════════════════════════
// 6. Result screen
// ════════════════════════════════════════════════════════════════════════

test("the result screen reports score, tiles, flags, mines hit and completion", () => {
  assert.match(SRC, /<PvpResultScreen/);
  assert.match(SRC, /label: "Tiles revealed"/);
  assert.match(SRC, /label: "Correct flags"/);
  assert.match(SRC, /label: "Wrong flags"/);
  assert.match(SRC, /label: "Mines hit"/);
  assert.match(SRC, /label: "Board cleared"/);
  // Final-score comparison uses the shared `sides` slot.
  assert.match(SRC, /\{ name: "You", score: match\.myScore, highlight: iWon \}/);
  assert.match(SRC, /\{ name: oppName, score: match\.opponentScore, highlight: iLost \}/);
});

test("the result maps to WIN / LOSS / DRAW with no instant-loss messaging", () => {
  assert.match(SRC, /const outcome = isDrawResult \? "draw" : iWon \? "win" : "loss"/);
  assert.match(SRC, /outcome={outcome}/);
  // The old shared-board endings must not survive in the client.
  assert.doesNotMatch(SRC, /all_mines_flagged/);
  assert.doesNotMatch(SRC, /winReason === "mine_hit"/);
  assert.doesNotMatch(SRC, /"You hit a mine"/);
  assert.doesNotMatch(SRC, /correctly flagged all mines/);
});

// ════════════════════════════════════════════════════════════════════════
// 7. Timer — visual only, server-authoritative
// ════════════════════════════════════════════════════════════════════════

test("the countdown is driven by the server deadline, never measured locally", () => {
  assert.match(SRC, /const deadlineMs = new Date\(deadline\)\.getTime\(\)/);
  assert.match(SRC, /Math\.ceil\(\(deadlineMs - Date\.now\(\)\) \/ 1000\)/);
  assert.match(SRC, /if \(!deadline \|\| match\?\.status !== MATCH_STATUS\.ACTIVE\)/);
  // The client never sends a clock to the server.
  assert.doesNotMatch(SRC, /timeLeft.*body|elapsed.*JSON\.stringify/);
});

test("time-up disables the board and waits for the server result", () => {
  assert.match(SRC, /Time! Waiting for the final result/);
});

// ════════════════════════════════════════════════════════════════════════
// 8. Realtime — existing room + refetch (+ score hint)
// ════════════════════════════════════════════════════════════════════════

test("the existing match room drives the refetch on opponent actions", () => {
  assert.match(SRC, /const roomId = minesPvpMatchRoom\(matchId\);/);
  assert.match(SRC, /socket\.on\(MINES_PVP_MATCH_UPDATED, refresh\)/);
  assert.match(SRC, /roomId: minesPvpMatchRoom\(matchId\),/);
});

test("the server-only score hint is only used as an extra refetch prompt", () => {
  assert.match(SRC, /socket\.on\(MINES_PVP_SCORE_EVENT, refresh\)/);
  assert.match(SRC, /mines-pvp:score/);
  // It never reads a delta off the event.
  assert.doesNotMatch(SRC, /MINES_PVP_SCORE_EVENT, \(/);
});

// ════════════════════════════════════════════════════════════════════════
// 9. Awareness + report + AI turn are preserved
// ════════════════════════════════════════════════════════════════════════

test("the AI opponent, report flow and emote system are preserved", () => {
  assert.match(SRC, /\/ai-turn`/);
  assert.match(SRC, /useGameEmotes\(/);
  assert.match(SRC, /<ReportModal/);
  assert.match(SRC, /gameType: "mines-pvp"/);
});

test("the flag-mode toggle explains the scoring rules", () => {
  assert.match(SRC, /Safe reveal \+5/);
  assert.match(SRC, /correct flag = the mine/);
  assert.match(SRC, /wrong flag −10/);
  assert.match(SRC, /mine hit −25/);
  assert.match(SRC, /clearing your board \+100/);
});
