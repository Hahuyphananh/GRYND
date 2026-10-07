/**
 * tic-tac-toe-ui-contract.test.mjs
 *
 * The TIC-TAC-TOE DUEL frontend contract: what the Mega lattice may show, what
 * the match page may send, and — above all — what it is NOT allowed to decide.
 *
 * The UI is held to the same trust boundary as the server. The only values it
 * ever authors are the ADDRESS of a click (`boardIndex`, `cellIndex`) and the
 * optimistic-concurrency token; the lattice, each board's control, whose turn
 * it is, the winning lines, the Mega line, the round and the settled result all
 * arrive in the snapshot. There is no code path in which the client detects a
 * line, computes a winner or submits a result.
 *
 * Run:  node --import tsx --test tests/tic-tac-toe-ui-contract.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (rel) => fs.readFileSync(rel, "utf8");
// Normalise CRLF BEFORE stripping, so the `^…$` line regex sees plain \n —
// most files in this repo are CRLF, and `$` also matches before a \r.
const strip = (src) => src.replace(/\r\n/g, "\n");
// LINE comments are removed FIRST: the casino lobby has a `//` line comment that
// mentions `src/app/casino/*`, and stripping block comments first would treat
// that `/*` as the start of a comment and swallow the entire games array.
const stripComments = (src) =>
  src.replace(/^[ \t]*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
const code = (rel) => stripComments(strip(read(rel)));

const MATCH_PAGE = "src/app/casino/tic-tac-toe/[matchId]/PageClient.tsx";
const MATCH_ROUTE_PAGE = "src/app/casino/tic-tac-toe/[matchId]/page.tsx";
const LOBBY_PAGE = "src/app/casino/tic-tac-toe/PageClient.tsx";
const LOBBY_ROUTE_PAGE = "src/app/casino/tic-tac-toe/page.tsx";
const BOARD = "src/components/tic-tac-toe/TicTacToeBoard.tsx";
const MEGA_BOARD = "src/components/tic-tac-toe/MegaBoard.tsx";
const TIEBREAK = "src/components/tic-tac-toe/TiebreakSummary.tsx";
const UI_HELPERS = "src/lib/tic-tac-toe/ui.ts";
const LOBBY = "src/app/casino/PageClient.jsx";
const SITEMAP = "src/app/sitemap.ts";
const SEO_INVENTORY = "src/lib/seoPages.ts";
const TRANSLATIONS = "src/lib/appTextTranslations.js";
const MOVE_ROUTE = "src/app/api/tic-tac-toe/match/[matchId]/move/route.ts";

const page = code(MATCH_PAGE);
const board = code(BOARD);
const mega = code(MEGA_BOARD);
const tiebreak = code(TIEBREAK);
const lobbyPage = code(LOBBY_PAGE);

const { GAME_CATALOG, GAMES_BY_ID } = await import("../src/lib/gameTags.js");
const { resolveGameId } = await import("../src/lib/gamePresence.js");
const { APP_TEXT_TRANSLATIONS } = await import("../src/lib/appTextTranslations.js");

// ════════════════════════════════════════════════════════════════════════
// 1. The match view renders every required state
// ════════════════════════════════════════════════════════════════════════

test("ui: every required match state is rendered", () => {
  // The first-load gate is the shared branded shell (nav + MatchLoading),
  // not a bare centered string on an otherwise empty page.
  assert.match(page, /<MatchLoading label="Loading Mega Tic-Tac-Toe…"/, "loading state");
  assert.match(page, /Unable to load this match/, "error state");
  assert.match(page, /<MatchWaiting/, "waiting / opponent state");
  assert.match(page, /data-testid="tic-tac-toe-match"/, "the live match");
  assert.match(page, /<\s*MegaBoard/, "the Mega lattice");
  assert.match(page, /data-stage=\{stage\}/, "the match carries its round");
  assert.match(page, /data-testid="tic-tac-toe-cancelled"/, "cancelled state");
  assert.match(page, /<PvpResultScreen/, "the shared win/loss/draw screen");
  assert.match(page, /<ReportModal/, "report flow");
  assert.match(page, /<EmotePicker/, "emotes");
});

test("ui: the game information block shows opponent, mark, round and turn", () => {
  // Seat cards carry a name, a mark and whose turn it is.
  assert.match(page, /data-testid=\{`seat-\$\{seat\}`\}/);
  assert.match(page, /data-active=\{isActive \? "true" : "false"\}/);
  assert.match(page, /const isActive = match\.currentTurn === seat/);
  // A status chip and a turn banner.
  assert.match(page, /data-testid="match-status"/);
  assert.match(page, /statusLabel\(match\.status\)/);
  assert.match(page, /data-testid="turn-status"/);
  assert.match(page, /turnLabel\(\{/);
  // The viewer's own mark, their opponent, the round and how far it has gone.
  assert.match(page, /viewerMarkLabel\(viewerSeat\)/);
  assert.match(page, /progressLabel\(match\.boards\?\.\[effectiveFocus\]\?\.cells \?\? \[\]\)/);
  assert.match(page, /roundLabel\(stage\)/);
  assert.match(page, /roundName\(stage\)/);
  assert.match(page, /label="Your mark"/);
  assert.match(page, /label="Opponent"/);
  assert.match(page, /label="Round"/);
  assert.match(page, /label="Moves played"/);
  assert.match(page, /label="Turn"/);
  assert.match(page, /Mega board/, "the Mega-board summary section");
  // The move log is rendered from the SNAPSHOT's moves, not a local array.
  assert.match(page, /const moves = Array\.isArray\(match\?\.moves\) \? match\.moves : \[\]/);
  assert.match(page, /moves\.map\(\(mv: any, index: number\) =>/);
  // Each logged move is addressed by board AND cell.
  assert.match(page, /moveBoardLabel\(mv\.boardIndex\)/);
});

// ════════════════════════════════════════════════════════════════════════
// 2. Authority: the client sends an address, never a result
// ════════════════════════════════════════════════════════════════════════

test("authority: the move request carries ONLY { boardIndex, cellIndex, expectedVersion }", () => {
  assert.match(
    page,
    /body: JSON\.stringify\(\{ boardIndex, cellIndex, expectedVersion \}\)/,
    "the move POST must send exactly the board address, the cell and the concurrency token",
  );
  // Exactly one move request exists in the page.
  assert.equal(
    (page.match(/\/move`/g) ?? []).length,
    1,
    "the match page must have exactly one /move call",
  );
  // The route it targets forwards only those three fields either — and the
  // board index is an ADDRESS, not a decision (the round is derived server-side).
  const route = code(MOVE_ROUTE);
  assert.match(route, /boardIndex: body\?\.boardIndex/);
  assert.match(route, /cellIndex: body\?\.cellIndex/);
  assert.match(route, /expectedVersion: body\?\.expectedVersion/);
  assert.doesNotMatch(route, /body\?\.(mark|winner|result|score|turn|round|stage)\b/);
});

test("authority: a click addresses the board AND the cell", () => {
  assert.match(
    page,
    /onPlay=\{\(boardIndex, cellIndex\) => void submitMove\(boardIndex, cellIndex\)\}/,
    "the lattice must hand both the slot and the cell to the page",
  );
  // The target board is re-checked against the SNAPSHOT before sending.
  assert.match(page, /const target = serverBoardAt\(current, boardIndex\)/);
  assert.match(page, /target\.control !== "active"/);
});

test("authority: the client never computes a line, a winner or a result", () => {
  // The rules engine and its vocabulary stay server-side.
  assert.doesNotMatch(page, /lib\/tic-tac-toe\/rules/);
  assert.doesNotMatch(page, /findWinningLine|WINNING_LINES|applyMove|computeMatchResult/);
  assert.doesNotMatch(board, /findWinningLine|WINNING_LINES|applyMove/);
  assert.doesNotMatch(mega, /findWinningLine|WINNING_LINES|applyMove|findMegaWin/);
  // The outcome is READ from the settled row: the server's `result` and
  // `winnerId` are the only inputs.
  assert.match(page, /outcomeFor\(\{\s*result: match\?\.result,\s*winnerId: match\?\.winnerId,/);
  assert.match(page, /open=\{finished\}/);
  assert.match(page, /gameKey="tic-tac-toe"/);
});

test("authority: the lattice is rendered from the snapshot, never from local state", () => {
  assert.match(page, /boards=\{match\.boards\}/);
  assert.match(page, /stage=\{stage\}/);
  assert.match(page, /slots=\{slots\}/);
  assert.match(page, /winningBoards=\{match\.winningBoards\}/);
  assert.match(page, /suddenDeath=\{match\.suddenDeath\}/);
  assert.match(page, /viewerSeat=\{viewerSeat\}/);
  // The unlock flag is the SERVER's `viewerCanMove`, narrowed only by "a
  // request is in flight" and "the match is over".
  assert.match(
    page,
    /const boardUnlocked =\s*Boolean\(match\) &&\s*!finished &&\s*!cancelled &&\s*!submitting &&\s*!inTransition &&\s*Boolean\(match\?\.viewerCanMove\)/,
  );
  assert.match(page, /viewerCanMove=\{boardUnlocked\}/);
  // The board itself re-checks the cell before offering it.
  assert.match(board, /isCellPlayable\(\{/);
  assert.match(board, /if \(!actionable\) return;/);
  assert.match(board, /onPlay: \(cellIndex: number\) => void;/);
  // Sudden death uses the server's sentinel, not a made-up slot.
  assert.match(mega, /onPlay\(SUDDEN_DEATH_BOARD_INDEX, cellIndex\)/);
});

test("authority: the optimistic mark is feedback, and a rejection resyncs", () => {
  // The ghost is local-only…
  assert.match(page, /pending=\{pending\}/);
  assert.match(
    page,
    /setPending\(\{\s*boardIndex,\s*cellIndex,\s*version: Number\(expectedVersion\) \|\| 0,\s*\}\)/,
  );
  // …and it is dropped — with a refetch — the moment the server refuses.
  assert.match(page, /setPending\(null\);\s*setLoadError\(data\?\.error \|\| "Move rejected"\);\s*refresh\(\);/);
  // The canonical state is only ever adopted from a snapshot or a response —
  // and a POST response is merged over the snapshot (preserving the GET-only
  // adornments it omits), never authored locally.
  assert.match(page, /const adoptAuthoritative = useCallback\(/);
  assert.match(page, /setMatch\(\(prev: any\) => \(\{ \.\.\.\(prev \?\? \{\}\), \.\.\.\(snapshot \?\? \{\}\) \}\)\)/);
  assert.match(page, /adoptAuthoritative\(data\.data\.match\)/);
  assert.match(page, /isIncomingSnapshotStale\(prev, data\.data\) \? prev : data\.data/);
});

// ════════════════════════════════════════════════════════════════════════
// 3. Board interaction rules
// ════════════════════════════════════════════════════════════════════════

test("board: 3x3, large cells, distinct marks and an accessible grid", () => {
  assert.match(board, /role="grid"/);
  assert.match(board, /role="row"/);
  assert.match(board, /role="gridcell"/);
  assert.match(board, /grid grid-cols-3/);
  assert.match(board, /aspect-square/);
  assert.match(board, /aria-label=\{label \?\? "Tic-tac-toe board, 3 by 3"\}/);
  assert.match(board, /aria-label=\{`\$\{cellCoords\(index\)\} — \$\{stateLabel\}`\}/);
  // X and O are drawn as different SHAPES, in different colours.
  assert.match(board, /mark === "X"/);
  assert.match(board, /<line/);
  assert.match(board, /<circle/);
  assert.match(board, /color: colour/);
  // Every cell is a real button, so Enter/Space place a mark.
  assert.match(board, /<button/);
  assert.match(board, /type="button"/);
  assert.doesNotMatch(board, /fetch\(/, "the board itself never talks to the network");
});

test("board: a resolved board is locked but keeps every mark", () => {
  // The board reads the SERVER's control; a resolved board stops offering
  // cells while still rendering all nine of them.
  assert.match(board, /boardIsResolved\(control\)/);
  assert.match(board, /const offers = viewerCanMove && !locked;/);
  assert.match(board, /data-control=\{control \?\? "active"\}/);
  assert.match(board, /data-locked=\{locked \? "true" : "false"\}/);
  assert.match(board, /data-board-index=\{boardIndex \?\? ""\}/);
  // The cells are always drawn — nothing about a controlled board hides moves.
  assert.match(board, /\{cell && \(/);
  assert.match(board, /isCellPlayable\(\{ board: cells, cellIndex: index, viewerCanMove: offers \}\)/);
});

test("board: empty cells advertise playability, occupied cells do nothing", () => {
  // Only a cell the snapshot offers is styled as playable…
  assert.match(board, /cursor-pointer border-dashed border-amber-300\/45/);
  assert.match(board, /const look = cell\s*\? "border-white\/15 bg-white\/\[0\.06\]"\s*:\s*playable/);
  // …and a cell that is not offered is inert (guarded click + aria-disabled),
  // while still being focusable so the whole board can be read by keyboard.
  assert.match(board, /aria-disabled=\{actionable \? undefined : true\}/);
  assert.match(board, /if \(!actionable\) return;/);
  // The native attribute is deliberately avoided (it would drop the cell from
  // the tab order). `aria-disabled` above must not be confused with it.
  assert.doesNotMatch(board, /[\s"']disabled=\{/);
  // The win highlight comes from the server's line.
  assert.match(board, /winningCellSet\(winningLine\)/);
  assert.match(board, /const isWinning = winning\.has\(index\)/);
});

test("ui: the pure helpers encode the same gates the server enforces", async () => {
  const ui = await import("../src/lib/tic-tac-toe/ui.ts");
  const empty = [null, null, null, null, null, null, null, null, null];
  assert.equal(ui.isCellPlayable({ board: empty, cellIndex: 4, viewerCanMove: true }), true);
  // Occupied → not offered.
  assert.equal(
    ui.isCellPlayable({ board: ["X", ...empty.slice(1)], cellIndex: 0, viewerCanMove: true }),
    false,
  );
  // Not the viewer's turn / match over → not offered.
  assert.equal(ui.isCellPlayable({ board: empty, cellIndex: 4, viewerCanMove: false }), false);
  // Out of range → not offered.
  assert.equal(ui.isCellPlayable({ board: empty, cellIndex: 9, viewerCanMove: true }), false);
  assert.equal(ui.isCellPlayable({ board: empty, cellIndex: -1, viewerCanMove: true }), false);
  assert.match(read(UI_HELPERS), /nothing in this module is authoritative/);
  // A result is read from the settled row, including a conceded match.
  assert.equal(ui.outcomeFor({ result: "player1", viewerSeat: "player1" }), "win");
  assert.equal(ui.outcomeFor({ result: "player2", viewerSeat: "player1" }), "loss");
  assert.equal(ui.outcomeFor({ result: "tie", viewerSeat: "player1" }), "draw");
});

// ════════════════════════════════════════════════════════════════════════
// 4. The Mega lattice
// ════════════════════════════════════════════════════════════════════════

test("mega: the lattice renders exactly the slots the server puts in play", () => {
  assert.match(page, /const slots = stageSlotList\.length \? stageSlotList : stageSlots\(stage\)/);
  assert.match(mega, /data-testid="tic-tac-toe-mega"/);
  assert.match(mega, /data-stage=\{round\}/);
  // Every rendered board is a real lattice slot, keyed by that slot.
  assert.match(mega, /slots\.map\(\(slot\) =>/);
  assert.match(mega, /key=\{slot\}/);
  assert.match(mega, /data-testid=\{`tic-tac-toe-lattice-board-\$\{slot\}`\}/);
});

test("mega: the round chooses a 1-up, 2x2 or 3x3 layout with an expansion animation", () => {
  assert.match(mega, /const cols = stageColumns\(round\)/);
  assert.match(mega, /gridTemplateColumns: `repeat\(\$\{cols\}, minmax\(0, 1fr\)\)`/);
  // The board mounts / expands through framer-motion `layout`.
  assert.match(mega, /<motion\.div/);
  assert.match(mega, /\blayout\b/);
  assert.match(mega, /initial=\{\{ opacity: 0, scale: 0\.85 \}\}/);
  assert.match(mega, /animate=\{\{ opacity: 1, scale: 1 \}\}/);
});

test("mega: every board shows its control, and a locked board keeps its marks", () => {
  assert.match(mega, /boardControlShort\(board\.control\)/);
  assert.match(mega, /boardIsResolved\(board\.control\)/);
  assert.match(mega, /boardControlLabel\(board\.control\)/);
  assert.match(mega, /control=\{board\.control\}/);
  // The full board (all marks) is always passed through.
  assert.match(mega, /board=\{board\.cells\}/);
  assert.match(mega, /winningLine=\{board\.winningLine\}/);
  // Which board the viewer is interacting with is surfaced.
  assert.match(mega, /data-focused=\{focused \? "true" : "false"\}/);
});

test("mega: the winning three-board line is highlighted and drawn", () => {
  assert.match(page, /winningBoards=\{match\.winningBoards\}/);
  assert.match(mega, /const winningSet = megaWinningSlotSet\(winningBoards\)/);
  assert.match(mega, /data-testid="mega-winning-line"/);
  assert.match(mega, /data-testid="mega-win-line"/);
  assert.match(mega, /megaLine=\{winningSet\.has\(slot\)\}/);
});

test("mega: sudden death is its own board and addresses slot -1", () => {
  assert.match(page, /suddenDeath=\{match\.suddenDeath\}/);
  assert.match(page, /match\.suddenDeath/);
  assert.match(mega, /normaliseSuddenDeath\(suddenDeath\)/);
  assert.match(mega, /data-testid="tic-tac-toe-sudden-death"/);
  assert.match(mega, /SUDDEN_DEATH_BOARD_INDEX/);
  assert.match(mega, /onPlay\(SUDDEN_DEATH_BOARD_INDEX, cellIndex\)/);
});

test("mega: the wider rounds scroll rather than shrinking cells on mobile", () => {
  assert.match(mega, /overflow-x-auto/);
  assert.match(mega, /minWidth/);
  assert.match(mega, /const minWidth = cols === 1 \? undefined :/);
});

test("mega: the round, expansion and legend are all communicated", () => {
  assert.match(page, /data-testid="mega-transition"/);
  assert.match(mega, /data-testid="mega-round"/);
  assert.match(mega, /data-round=\{round\}/);
  assert.match(mega, /roundBlurb\(round\)/);
  assert.match(mega, /data-testid="mega-legend"/);
  assert.match(mega, /megaControlCounts\(lattice, slots\)/);
});

// ════════════════════════════════════════════════════════════════════════
// 4b. Progression and feedback
// ════════════════════════════════════════════════════════════════════════

test("progression: an expansion is announced fast and locks input only for the beat", () => {
  assert.match(page, /const EXPANSION_MS = 1200/);
  assert.match(page, /const inTransition = transition !== null/);
  assert.match(page, /!inTransition &&/);
  assert.match(page, /data-testid="mega-transition"/);
  assert.match(page, /data-to=\{transition\}/);
  // Round 1 → 2 announces ROUND 2; Round 2 → 3 announces MEGA BOARD.
  assert.match(page, /transition === 2 \? "ROUND 2" : "MEGA BOARD"/);
  assert.match(page, /data-testid="mega-transition-title"/);
  // It is driven ONLY by the server's stage growing — never a first load.
  assert.match(page, /if \(previous === null \|\| stage <= previous\) return undefined;/);
  assert.match(page, /setTransition\(stage\)/);
});

test("feedback: small-board win and draw are announced and highlighted", () => {
  assert.match(page, /const BOARD_EVENT_MS = 1800/);
  assert.match(page, /data-testid="board-event"/);
  assert.match(page, /data-kind=\{boardEvent.control === "draw" \? "draw" : "win"\}/);
  assert.match(page, /drawn — locked/);
  assert.match(page, /controls it!/);
  // The board that just resolved is ring-highlighted, and the detection is a
  // SERVER control flip.
  assert.match(page, /highlightSlot=\{boardEvent\?\.slot \?\? null\}/);
  assert.match(page, /previous\[slot\]\?\.control === "active"/);
  assert.match(mega, /highlightSlot === slot/);
});

test("feedback: the tiebreak summary uses the required board/cell/sudden-death shape", async () => {
  const ui = await import("../src/lib/tic-tac-toe/ui.ts");
  assert.equal(ui.tiebreakHeading({ decidedBy: "boards" }), "BOARD CONTROL");
  assert.equal(ui.tiebreakHeading({ decidedBy: "cells" }), "CELL CONTROL");
  assert.equal(ui.tiebreakHeading({ decidedBy: "sudden-death" }), "SUDDEN DEATH");
  // BOARD CONTROL — Player X: 5 boards · Player O: 4 boards · Winner: X
  assert.deepEqual(
    ui.tiebreakRows({ decidedBy: "boards", xBoards: 5, oBoards: 4, winner: "player1" }),
    [
      { label: "Player X", value: "5 boards" },
      { label: "Player O", value: "4 boards" },
      { label: "Winner", value: "X" },
    ],
  );
  // CELL CONTROL — Player X: 31 cells · Player O: 29 cells · Winner: X
  assert.deepEqual(
    ui.tiebreakRows({ decidedBy: "cells", xCells: 31, oCells: 29, winner: "player1" }),
    [
      { label: "Player X", value: "31 cells" },
      { label: "Player O", value: "29 cells" },
      { label: "Winner", value: "X" },
    ],
  );
  // A complete tie falls through to SUDDEN DEATH.
  const sd = ui.tiebreakRows({ decidedBy: "sudden-death", winner: null });
  assert.equal(sd[1].value, "Sudden death");
  assert.equal(ui.tiebreakWinnerMark({ winner: "player2" }), "O");
  assert.equal(ui.tiebreakWinnerMark({ winner: null }), null);
  // The component is wired into the page and renders data-driven.
  assert.match(page, /<TiebreakSummary tiebreak=\{match\.tiebreak\}/);
  assert.match(tiebreak, /data-testid="tiebreak-summary"/);
  assert.match(tiebreak, /data-decided-by=/);
  assert.match(tiebreak, /data-winner=/);
  assert.match(tiebreak, /tiebreakHeading\(tiebreak\)/);
  assert.match(tiebreak, /tiebreakRows\(tiebreak\)/);
});

test("feedback: a Mega-board win and the final reason surface from the snapshot", () => {
  assert.match(mega, /Mega line — \{winningMark \?\? "X"\} wins the match/);
  assert.match(page, /subline=\{resultReason\(\{/);
  assert.match(read(UI_HELPERS), /Mega line — Boards \$\{/);
  // The final tiebreak also appears in the result details.
  assert.match(page, /label: "Tiebreak", value: tiebreakHeading\(match\.tiebreak\)/);
  assert.match(page, /tiebreakRows\(match\.tiebreak\)\.map/);
});

test("ui: the Mega helpers project the server's lattice without deciding anything", async () => {
  const ui = await import("../src/lib/tic-tac-toe/ui.ts");
  assert.deepEqual(ui.stageSlots(1), [0]);
  assert.deepEqual(ui.stageSlots(2), [0, 1, 3, 4]);
  assert.deepEqual(ui.stageSlots(3), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(ui.stageColumns(1), 1);
  assert.equal(ui.stageColumns(2), 2);
  assert.equal(ui.stageColumns(3), 3);
  assert.equal(ui.normaliseStage(99), 3);
  assert.equal(ui.normaliseStage(0), 1);
  assert.equal(ui.roundCellBudget(2), 36);
  // The lattice reads the server's control and keeps `null` slots as null.
  const cells = ["X", "X", "X", null, null, null, null, null, null];
  const lattice = ui.normaliseLattice([
    { cells, control: "X", winningLine: [0, 1, 2] },
    null,
    null,
    { cells: [null, null, null, null, null, null, null, null, null], control: "draw" },
  ]);
  assert.equal(lattice[0].control, "X");
  assert.deepEqual(lattice[0].winningLine, [0, 1, 2]);
  assert.equal(lattice[1], null);
  assert.equal(ui.boardIsResolved("X"), true);
  assert.equal(ui.boardIsResolved("draw"), true);
  assert.equal(ui.boardIsResolved("active"), false);
  const counts = ui.megaControlCounts(lattice, [0, 1, 3]);
  assert.equal(counts.x, 1);
  assert.equal(counts.draw, 1);
  assert.equal(counts.active, 0);
  assert.deepEqual([...ui.megaWinningSlotSet([0, 4, 8])].sort((a, b) => a - b), [0, 4, 8]);
  // Sudden-death addressing resolves to the LAST sudden-death board.
  const sd = ui.normaliseSuddenDeath({
    boards: [{ cells, control: "X" }, { cells, control: "active" }],
  });
  assert.equal(sd.length, 2);
  assert.equal(ui.serverBoardAt({ suddenDeath: {} }, -1), null);
});

// ════════════════════════════════════════════════════════════════════════
// 5. Lifecycle: waiting, live updates and the way out
// ════════════════════════════════════════════════════════════════════════

test("lifecycle: the match page sits on the shared host with real signals", () => {
  assert.match(page, /<GameSessionHost/);
  assert.match(page, /gameLabel="tic-tac-toe"/);
  assert.match(page, /autoStart=\{match\.status === "playing"\}/);
  assert.match(page, /autoStop=\{finished \|\| cancelled\}/);
});

test("lifecycle: it polls, joins the per-match room and re-joins on reconnect", () => {
  assert.match(page, /fetch\(apiMatch/);
  assert.match(page, /const ACTIVE_POLL_MS = 1800/);
  assert.match(page, /const IDLE_POLL_MS = 5000/);
  assert.match(page, /ticTacToeMatchRoom\(matchId\)/);
  assert.match(page, /socket\.on\(TIC_TAC_TOE_MATCH_UPDATED, onUpdate\)/);
  assert.match(page, /socket\.on\("connect", join\)/);
  assert.match(page, /socket\.off\("connect", join\)/);
  // A completed move pokes the opponent instead of pushing the board.
  assert.match(page, /socket\?\.emit\(TIC_TAC_TOE_READY, \{ matchId \}\)/);
});

test("lifecycle: forfeit and cancel reuse the existing shared conventions", () => {
  assert.match(page, /\/forfeit`/);
  assert.match(page, /\/cancel`/);
  assert.match(page, /data-testid="confirm-forfeit"/);
  assert.match(page, /onCancel=\{canCancelLobby \? cancelLobby : null\}/);
  assert.match(page, /const canCancelLobby = match\?\.status === "waiting" && viewerSeat === "player1"/);
  // The result screen's own CTAs, exactly as every other game drives them.
  assert.match(
    page,
    /playAgain=\{\{\s*label: "Play again",\s*onClick: \(\) => router\.push\("\/casino\/tic-tac-toe"\),\s*\}\}/,
  );
  assert.match(page, /onReturnToLobby=\{\(\) => router\.push\("\/casino"\)\}/);
});

test("economy: no wager, balance or payout field anywhere in the UI", () => {
  assert.doesNotMatch(page, /betAmount|stakeAmount|prizePaid|houseFee|newBalance|tokenBalance/);
  assert.doesNotMatch(board, /betAmount|stakeAmount|prizePaid|houseFee|newBalance/);
  assert.doesNotMatch(mega, /betAmount|stakeAmount|prizePaid|houseFee|newBalance/);
  assert.doesNotMatch(lobbyPage, /betAmount|stakeAmount|prizePaid|houseFee|newBalance/);
  // Free practice vs AI is offered from the lobby (unrated, so no economy).
  assert.match(lobbyPage, /AiDifficultyPicker/);
  assert.match(lobbyPage, /create-ai/);
});

// ════════════════════════════════════════════════════════════════════════
// 6. Registration: the lobby, the catalog, presence, sitemap, copy
// ════════════════════════════════════════════════════════════════════════

test("discovery: the lobby card links to the game and is a 1v1 duel", () => {
  const src = code(LOBBY);
  const card = src.slice(src.indexOf('name: "Tic-Tac-Toe"'));
  assert.match(card, /href: "\/games\/tic-tac-toe"/);
  assert.match(card, /leaderboardKey: "tic-tac-toe"/);
  assert.match(card, /playsKey: "tic-tac-toe"/);
  assert.match(card, /descriptionKey: "games\.tic_tac_toe_desc"/);
  assert.match(card, /nameKey: "games\.tic_tac_toe_name"/);
  assert.match(card, /pvpMode: "1v1"/);
  // Shipped card art, not a shared fallback.
  assert.match(src, /import ImgTicTacToe from "\.\.\/\.\.\/images\/tic-tac-toe-card\.svg"/);
  // It is the newest card, so it heads the "Newest" sort.
  assert.match(src, /const newestOrder = \[\n\s*"tic-tac-toe",/);
});

test("discovery: the catalog mirrors the lobby and tags the game", () => {
  const lobbyIds = [...code(LOBBY).matchAll(/leaderboardKey: "([^"]+)"/g)].map((m) => m[1]);
  assert.equal(GAME_CATALOG.length, lobbyIds.length, "catalog/lobby length mismatch");
  assert.deepEqual(GAME_CATALOG.map((game) => game.id), lobbyIds);
  const entry = GAMES_BY_ID["tic-tac-toe"];
  assert.ok(entry, "the catalog must carry the game");
  assert.equal(entry.href, "/games/tic-tac-toe");
  for (const tag of ["pvp", "strategy", "skill", "competitive"]) {
    assert.ok(entry.tags.includes(tag), `expected the ${tag} tag`);
  }
  // Nothing is drawn or rolled, and it is a solved duel rather than a pick-up
  // game — the same mutual exclusion the other titles follow.
  assert.ok(!entry.tags.includes("chance"));
  assert.ok(!entry.tags.includes("casual"));
});

test("discovery: presence and the sitemap know the game under its canonical id", () => {
  assert.equal(resolveGameId("tic-tac-toe"), "tic-tac-toe");
  // The sitemap entry is GENERATED from the game catalog, so the game is in the
  // sitemap because it has a landing page — not because a literal was added.
  assert.match(strip(read(SITEMAP)), /PUBLIC_SEO_PAGES/, "the sitemap must project the inventory");
  const src = code(SEO_INVENTORY);
  assert.match(src, /gameLandingPath\(game\.slug\)/, "game URLs must be generated");
  assert.match(
    src,
    /"tic-tac-toe": \{ table: ticTacToeMatches, column: ticTacToeMatches\.createdAt \}/,
  );
});

test("copy: the lobby card name and description exist in every locale", () => {
  const src = read(TRANSLATIONS);
  const locales = Object.keys(APP_TEXT_TRANSLATIONS);
  assert.ok(locales.length >= 3, `expected at least three locales, found ${locales.length}`);
  const descriptions = new Set();
  for (const locale of locales) {
    const games = APP_TEXT_TRANSLATIONS[locale]?.games;
    assert.ok(games, `${locale} has no games block`);
    assert.equal(
      typeof games.tic_tac_toe_name === "string" && games.tic_tac_toe_name.trim().length > 0,
      true,
      `${locale} is missing games.tic_tac_toe_name`,
    );
    assert.equal(
      typeof games.tic_tac_toe_desc === "string" && games.tic_tac_toe_desc.trim().length >= 40,
      true,
      `${locale} is missing a real games.tic_tac_toe_desc`,
    );
    descriptions.add(games.tic_tac_toe_desc);
  }
  // A pasted English string is not a translation.
  assert.equal(descriptions.size, locales.length, "the descriptions must be distinct per locale");
  // The source carries one key per locale, so the two expressions agree.
  assert.equal((src.match(/tic_tac_toe_name:/g) ?? []).length, locales.length);
});

test("routes: the lobby renders under /casino/tic-tac-toe and carries the ad script", () => {
  const lobbyRoute = code(LOBBY_ROUTE_PAGE);
  assert.match(lobbyRoute, /import PageClient from "\.\/PageClient"/);
  assert.match(lobbyRoute, /<AdSenseScript \/>/);
  assert.match(lobbyRoute, /<PageClient \/>/);
  // The BOARD route deliberately carries no ad tag.
  const matchRoute = code(MATCH_ROUTE_PAGE);
  assert.match(matchRoute, /export async function generateMetadata/);
  assert.match(matchRoute, /return <PageClient \/>;|return <PageClient\/>;/);
  assert.doesNotMatch(matchRoute, /AdSenseScript/);
});

test("navigation: the lobby reuses the ONE shared matchmaking path", () => {
  assert.match(lobbyPage, /\/api\/tic-tac-toe\/create-or-join/);
  assert.match(lobbyPage, /router\.push\(`\/casino\/tic-tac-toe\/\$\{data\.data\.matchId\}`\)/);
  assert.match(
    lobbyPage,
    /import PvpLobbyPage from "\.\.\/\.\.\/\.\.\/components\/lobby\/PvpLobby"/,
  );
  assert.match(lobbyPage, /<PvpLobbyPage/);
  assert.match(lobbyPage, /rulesKey="tic-tac-toe"/);
  assert.match(lobbyPage, /\/api\/tic-tac-toe\/available/);
});
