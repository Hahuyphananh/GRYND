/**
 * Mines PvP — frontend (shared-board) contract.
 *
 * The match view is a large presentation component (animations, framer-motion
 * transitions, layout) that cannot be rendered in the node test runner, so this
 * file pins the CONTRACT the conversion introduced, the same way
 * `board-fit-desktop.test.mjs` pins its layout hooks:
 *
 *   • shared reveals — the opponent's clue is rendered, never hidden
 *   • player ownership accents on BOTH reveals and flags
 *   • flags are CLAIMS: both sets are visible, a claim never opens the result
 *     popup, and completing the sweep shows the normal result screen
 *   • mine click ends the match immediately (no waiting for a turn)
 *   • the seat cards report Reveals + Flags (counts only — never locations)
 *   • the existing turn indicator / board guard / realtime room are kept
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
// 1. Shared reveals + shared clues
// ════════════════════════════════════════════════════════════════════════

test("the clue is rendered from the shared payload for ANY revealed cell", () => {
  // The badge reads the entry's server-stamped number with no owner check.
  assert.match(
    SRC,
    /const hint =\s*\n?\s*entry && typeof entry\.hint === "number" \? entry\.hint : null;/,
  );
  // ...and the revealed-cell branch renders it for every reveal.
  assert.match(SRC, /content: safeCellContent\(entry\)/);
  // No leftover per-viewer clue gating anywhere in the client.
  assert.doesNotMatch(SRC, /PRIVATE/);
  assert.doesNotMatch(SRC, /viewer-private|viewer_private/);
  assert.doesNotMatch(SRC, /finished \|\| isViewerPick \? raw\.hint/);
});

test("the match view documents the shared-board model it implements", () => {
  assert.match(SRC, /SHARED INFORMATION/);
  assert.match(SRC, /both players/i);
  // The hidden mine list is still never trusted to the client mid-match.
  assert.match(SRC, /board: \{ size: number; mines: number\[\] \} \| null;/);
});

// ════════════════════════════════════════════════════════════════════════
// 2. Player ownership — reveals AND flags
// ════════════════════════════════════════════════════════════════════════

test("reveals carry the seat accent (player1 cyan / player2 fuchsia)", () => {
  assert.match(
    SRC,
    /entry\?\.seat === "player2" \? "text-fuchsia-300" : "text-cyan-300"/,
  );
  // The seat tint follows the entry regardless of who is viewing.
  assert.match(SRC, /const diamondColor =/);
});

test("both players' flag claims are rendered, seat-accented", () => {
  // Read per seat from the shared payload.
  assert.match(SRC, /match\.player1Id === myUserId \? match\.p1Flags : match\.p2Flags/);
  assert.match(SRC, /match\.player1Id === myUserId \? match\.p2Flags : match\.p1Flags/);
  // Rendered on the board for either owner.
  assert.match(SRC, /const claimedByMe = myFlags\.includes\(cellIndex\);/);
  assert.match(SRC, /const claimedByOpponent = opponentFlags\.includes\(cellIndex\);/);
  assert.match(SRC, /if \(isFlagTarget \|\| claimedByMe \|\| claimedByOpponent\) \{/);
});

// ════════════════════════════════════════════════════════════════════════
// 3. Flags are claims, not terminal moves
// ════════════════════════════════════════════════════════════════════════

test("a flag click POSTs /flag and never opens the result screen by itself", () => {
  assert.match(SRC, /`\/api\/mines-pvp\/match\/\$\{matchId\}\/flag`/);
  // The result screen is gated on the server's FINISHED status only — there is
  // no code path that opens it because a flag was placed.
  assert.match(
    SRC,
    /function renderResult\(\) \{\s*\n\s*if \(!match \|\| match\.status !== MATCH_STATUS\.FINISHED\) return null;/,
  );
});

test("the flag toggle explains the claim rules (no 'wrong = you lose')", () => {
  assert.match(SRC, /Claim every mine to win/);
  assert.match(SRC, /a wrong claim only costs you a turn/);
  assert.doesNotMatch(SRC, /wrong = you lose/);
  assert.doesNotMatch(SRC, /Correct = opponent/i);
});

// ════════════════════════════════════════════════════════════════════════
// 4. Mine click → immediate game over
// ════════════════════════════════════════════════════════════════════════

test("a mine click refetches the authoritative state immediately", () => {
  // The pick POST is followed by an unconditional `fetchStatus()` (which is
  // what flips the view to finished when the click detonated a mine) — the
  // player never waits for another turn.
  assert.match(SRC, /await fetchStatus\(\);/);
  const postIdx = SRC.indexOf("/pick`");
  const statusIdx = SRC.indexOf("await fetchStatus();", postIdx);
  assert.ok(postIdx > 0 && statusIdx > postIdx, "fetchStatus must follow the pick POST");
  // The detonated cell gets the impact cue.
  assert.match(SRC, /animate-mine-hit/);
  assert.match(SRC, /const mineHitCell = useMemo/);
});

// ════════════════════════════════════════════════════════════════════════
// 5. Scoreboard — reveals + flags per seat, counts only
// ════════════════════════════════════════════════════════════════════════

test("the seat cards report Reveals and Flags with mine-count progress", () => {
  assert.match(SRC, /reveals: number;/);
  assert.match(SRC, /flags: number;/);
  assert.match(SRC, /mineCount: number;/);
  assert.match(SRC, /Reveals:\{" "\}/);
  assert.match(SRC, /Flags:\{" "\}/);
  assert.match(SRC, /\/ \{mineCount\}/);
  // Both seats are fed their own counters from the shared state.
  assert.match(SRC, /reveals=\{myPicks\.length\}/);
  assert.match(SRC, /flags=\{myFlags\.length\}/);
  assert.match(SRC, /reveals=\{opponentPicks\.length\}/);
  assert.match(SRC, /flags=\{opponentFlags\.length\}/);
});

test("the scoreboard never renders a mine location", () => {
  // Only counts come off `match.board`-adjacent fields; the mine list is read
  // exclusively inside the post-match reveal branch.
  const beforeResult = SRC.slice(0, SRC.indexOf("function renderResult()"));
  assert.match(beforeResult, /const mines = match\.board\?\.mines \?\? \[\];/);
  // No `board.mines` usage outside `getCellDisplay`'s finished branch.
  const minesUsages = beforeResult.match(/match\.board\?\.mines/g) ?? [];
  assert.equal(minesUsages.length, 1, "mine locations are read once, in the finished reveal");
});

// ════════════════════════════════════════════════════════════════════════
// 6 + 7. Turn UI and board interaction (kept, server-authoritative)
// ════════════════════════════════════════════════════════════════════════

test("the existing turn indicator and my-turn gating are kept", () => {
  assert.match(SRC, /function renderTurnIndicator\(\)/);
  assert.match(SRC, /const isMyTurn =/);
  assert.match(SRC, /thinking=\{inPickState && isMyTurn\}/);
});

test("a cell is clickable only on your turn, unrevealed, and the server still rules", () => {
  assert.match(SRC, /const isMyTurnClickable =/);
  assert.match(SRC, /const cellAlreadyPicked =/);
  assert.match(SRC, /disabled=\{!isMyTurnClickable \|\| busy\}/);
  // A reveal blocked by either seat disables the tile.
  assert.match(SRC, /myPicks\.includes\(cellIndex\) \|\|/);
  assert.match(SRC, /opponentPicks\.includes\(cellIndex\)/);
  // The server stays authoritative: a rejected action surfaces its message
  // instead of silently mutating local state.
  assert.match(SRC, /if \(!res\.ok \|\| !data\.success\) \{/);
  assert.match(SRC, /setError\(data\?\.error \|\| \(flagMode \? "Flag failed" : "Pick failed"\)\)/);
});

// ════════════════════════════════════════════════════════════════════════
// 9. Result popup — both shared-board reasons
// ════════════════════════════════════════════════════════════════════════

test("the result headline covers mine_hit and all_mines_flagged by name", () => {
  assert.match(SRC, /winReason === "all_mines_flagged"/);
  assert.match(SRC, /correctly flagged all mines/);
  assert.match(SRC, /`\$\{oppName\} hit a mine`/);
  assert.match(SRC, /"You hit a mine"/);
  // The popup still uses the existing shared result component.
  assert.match(SRC, /<PvpResultScreen/);
});

// ════════════════════════════════════════════════════════════════════════
// 10. Realtime — existing room + refetch, unchanged
// ════════════════════════════════════════════════════════════════════════

test("the existing match room drives the refetch on opponent actions", () => {
  assert.match(SRC, /const roomId = minesPvpMatchRoom\(matchId\);/);
  assert.match(SRC, /socket\.on\(MINES_PVP_MATCH_UPDATED, refresh\)/);
  assert.match(SRC, /roomId: minesPvpMatchRoom\(matchId\),/);
});
