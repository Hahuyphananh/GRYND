/**
 * tic-tac-toe-ui-contract.test.mjs
 *
 * The ULTIMATE TIC-TAC-TOE frontend contract: what the nine-board lattice may
 * show, what the match page may send, and — above all — what it is NOT allowed
 * to decide.
 *
 * The UI is held to the same trust boundary as the server. The only values it
 * ever authors are the ADDRESS of a click (`boardIndex`, `cellIndex`) and the
 * optimistic-concurrency token; the lattice, each board's control, whose turn it
 * is, the REQUIRED destination (`nextBoard`), the playable set
 * (`playableBoards`), the per-board winning lines, the lattice line and the
 * settled result all arrive in the snapshot. There is no code path in which the
 * client detects a line, re-derives the forced destination, computes a winner or
 * submits a result.
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
const UI_HELPERS = "src/lib/tic-tac-toe/ui.ts";
const LOBBY = "src/app/casino/PageClient.jsx";
const ART_REGISTRY = "src/components/games/gameCardArt.js";
const SITEMAP = "src/app/sitemap.ts";
const SEO_INVENTORY = "src/lib/seoPages.ts";
const TRANSLATIONS = "src/lib/appTextTranslations.js";
const MOVE_ROUTE = "src/app/api/tic-tac-toe/match/[matchId]/move/route.ts";

const page = code(MATCH_PAGE);
const board = code(BOARD);
const mega = code(MEGA_BOARD);
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
  assert.match(page, /<MatchLoading label="Loading Ultimate Tic-Tac-Toe…"/, "loading state");
  assert.match(page, /Unable to load this match/, "error state");
  assert.match(page, /<MatchWaiting/, "waiting / opponent state");
  assert.match(page, /data-testid="tic-tac-toe-match"/, "the live match");
  assert.match(page, /<\s*MegaBoard/, "the nine-board lattice");
  // The match carries the SERVER's destination, and says when the choice is free.
  assert.match(page, /data-next-board=\{nextBoard \?\? ""\}/, "the required destination");
  assert.match(
    page,
    /data-free-choice=\{freeChoice \? "true" : "false"\}/,
    "whether any open board may be played",
  );
  assert.match(page, /data-testid="tic-tac-toe-cancelled"/, "cancelled state");
  assert.match(page, /<PvpResultScreen/, "the shared win/loss/draw screen");
  assert.match(page, /<ReportModal/, "report flow");
  assert.match(page, /<EmotePicker/, "emotes");
});

test("ui: the game information block shows opponent, mark, destination and turn", () => {
  // Seat cards carry a name, a mark and whose turn it is.
  assert.match(page, /data-testid=\{`seat-\$\{seat\}`\}/);
  assert.match(page, /data-active=\{isActive \? "true" : "false"\}/);
  assert.match(page, /const isActive = match\.currentTurn === seat/);
  // A status chip, ONE generated instruction, and the progress line.
  assert.match(page, /data-testid="match-status"/);
  assert.match(page, /statusLabel\(match\.status\)/);
  assert.match(page, /data-testid="turn-status"/);
  assert.match(page, /data-testid="move-instruction"/);
  // Exactly one: a second, hand-kept copy could contradict the generated one.
  assert.equal(
    (page.match(/data-testid="move-instruction"/g) ?? []).length,
    1,
    "the turn instruction is rendered once",
  );
  assert.match(page, /moveInstruction\(\{ snapshot: match, submitting \}\)/);
  assert.match(page, /data-testid="destination-status"/);
  assert.match(page, /viewerMarkLabel\(viewerSeat\)/);
  assert.match(page, /progress\.label/);
  // No hand-written turn copy survives in the view: the sentence is generated
  // from the snapshot, so it cannot name the wrong board.
  assert.doesNotMatch(page, /turnLabel\(/);
  assert.doesNotMatch(page, /"Your turn — pick a cell"/);
  assert.doesNotMatch(
    page,
    /"top-right"|"top-left"|"bottom-right"/,
    "positions come from the helper, never a literal",
  );
  // The sidebar's summary rows.
  assert.match(page, /label="Your mark"/);
  assert.match(page, /label="Opponent"/);
  assert.match(page, /label="Destination"/);
  assert.match(page, /label="Moves played"/);
  assert.match(page, /label="Turn"/);
  assert.match(page, /destinationChip\(match\)/);
  // The MOVE LOG is rendered from the SNAPSHOT's moves, not a local array.
  assert.match(page, /const moves = Array\.isArray\(match\?\.moves\) \? match\.moves : \[\]/);
  assert.match(page, /moves\.map\(\(mv: any, index: number\) =>/);
  assert.match(page, /moveBoardLabel\(mv\.boardIndex\)/);
});

test("ui: the expansion-era summaries are gone from the live screen", () => {
  // The round tracker, the stage labels, the board-count legend ("X controls",
  // "Boards locked") and the tiebreak panel are deleted, not hidden.
  for (const gone of [
    /X controls/,
    /O controls/,
    /label="Boards locked"/,
    /label="Round"/,
    /Tiebreak/,
    /Sudden death/,
    /Round 1|Round 2|Round 3/,
    /mega-round|roundBlurb|stageSlots/,
  ]) {
    assert.doesNotMatch(page, gone, `the page must not carry ${gone}`);
  }
  for (const gone of [/mega-round|roundBlurb|normaliseStage/, /"Board expanding"|"Final expansion"/]) {
    assert.doesNotMatch(mega, gone, `the lattice must not carry ${gone}`);
  }
});
test("ui: no expansion-era vocabulary survives in the view", () => {
  // The stage/round, the tiebreak summary and the sudden-death board are gone —
  // not hidden, not conditionally rendered.
  for (const src of [page, mega]) {
    assert.doesNotMatch(src, /normaliseStage|stageSlots|roundLabel|roundBlurb|roundCellBudget/);
    assert.doesNotMatch(src, /tiebreak|Tiebreak|suddenDeath|Sudden death/i);
    assert.doesNotMatch(src, /stageBoardSlots|megaSize|MEGA_SIZE/);
  }
  assert.doesNotMatch(page, /EXPANSION_MS|mega-transition|inTransition/);
  assert.doesNotMatch(page, /data-stage=/);
  assert.equal(
    fs.existsSync("src/components/tic-tac-toe/TiebreakSummary.tsx"),
    false,
    "the tiebreak component must be deleted, not left as a secondary path",
  );
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
  // The route it targets forwards only those three fields as well — and the
  // board index is an ADDRESS, not a decision (the destination is derived
  // server-side).
  const route = code(MOVE_ROUTE);
  assert.match(route, /boardIndex: body\?\.boardIndex/);
  assert.match(route, /cellIndex: body\?\.cellIndex/);
  assert.match(route, /expectedVersion: body\?\.expectedVersion/);
  assert.doesNotMatch(
    route,
    /body\?\.(mark|winner|result|score|turn|destination|nextBoard|board|round|stage)\b/,
  );
});

test("authority: a click addresses the board AND the cell", () => {
  assert.match(
    page,
    /onPlay=\{\(boardIndex, cellIndex\) => void submitMove\(boardIndex, cellIndex\)\}/,
    "the lattice must hand both the slot and the cell to the page",
  );
  // The target board is re-checked against the SNAPSHOT before sending: it must
  // be a board the server currently offers.
  assert.match(page, /if \(!canPlayInBoard\(current, boardIndex\)\) return;/);
  assert.match(page, /const target = serverBoardAt\(current, boardIndex\)/);
});

test("authority: the client never computes a line, a winner or a result", () => {
  // The rules engine and its vocabulary stay server-side.
  assert.doesNotMatch(page, /lib\/tic-tac-toe\/rules/);
  assert.doesNotMatch(page, /findWinningLine|WINNING_LINES|applyMove|computeMatchResult/);
  assert.doesNotMatch(board, /findWinningLine|WINNING_LINES|applyMove/);
  assert.doesNotMatch(mega, /findWinningLine|WINNING_LINES|applyMove|findLatticeWin/);
  // …and the pure UI helpers do not smuggle the engine in either: they project
  // the DTO, they do not re-derive it.
  assert.doesNotMatch(code(UI_HELPERS), /lib\/tic-tac-toe\/rules|WINNING_LINES|LATTICE_LINES/);
  // The outcome is READ from the settled row: the server's `result` and
  // `winnerId` are the only inputs.
  assert.match(page, /outcomeFor\(\{\s*result: match\?\.result,\s*winnerId: match\?\.winnerId,/);
  assert.match(page, /open=\{finished\}/);
  assert.match(page, /gameKey="tic-tac-toe"/);
});

test("authority: the lattice is rendered from the snapshot, never from local state", () => {
  assert.match(page, /boards=\{match\.boards\}/);
  assert.match(page, /winningBoards=\{match\.winningBoards\}/);
  // The destination and the playable set are passed through from the snapshot.
  assert.match(page, /nextBoard=\{match\.nextBoard\}/);
  assert.match(page, /playableBoards=\{match\.playableBoards\}/);
  assert.match(page, /viewerSeat=\{viewerSeat\}/);
  // The unlock flag is the SERVER's `viewerCanMove`, narrowed only by "a
  // request is in flight" and "the match is over".
  assert.match(
    page,
    /const boardUnlocked =\s*Boolean\(match\) &&\s*!finished &&\s*!cancelled &&\s*!paused &&\s*!submitting &&\s*Boolean\(match\?\.viewerCanMove\)/,
  );
  assert.match(page, /viewerCanMove=\{boardUnlocked\}/);
  // The board itself re-checks the cell before offering it.
  assert.match(board, /isCellPlayable\(\{/);
  assert.match(board, /if \(!actionable\) return;/);
  assert.match(board, /onPlay: \(cellIndex: number\) => void;/);
  // There is exactly ONE addressing mode: a lattice slot.
  assert.match(mega, /onPlay\(slot, cellIndex\)/);
  assert.doesNotMatch(mega, /SUDDEN_DEATH_BOARD_INDEX/);
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
  // Four looks, in priority order: a real mark, a cell the server offers on the
  // REQUIRED board (solid amber), a cell it offers during a free choice (dashed
  // amber), and an inert cell that still reads as part of the grid.
  // Occupied: a raised, top-lit socket (the inset edge is the restrained depth
  // the cartoon-2D standard asks for) with the mark itself carrying the colour.
  assert.match(
    board,
    /\? "border-white\/10 bg-white\/\[0\.06\] shadow-\[inset_0_1px_0_rgba\(255,255,255,0\.06\)\]"/,
  );
  assert.match(board, /cursor-pointer border-amber-300\/70 bg-amber-400\/\[0\.13\]/);
  assert.match(board, /cursor-pointer border-dashed border-amber-300\/45 bg-amber-400\/\[0\.06\]/);
  assert.match(board, /cursor-default border-white\/\[0\.07\] bg-black\/25/);
  // The required board's affordance is chosen from the state, not guessed.
  assert.match(board, /const required = state === "required";/);
  assert.match(board, /playable\s*\? required/);
  // A cell that is not offered is inert (guarded click + aria-disabled), while
  // still being focusable so the whole board can be read by keyboard.
  assert.match(board, /aria-disabled=\{actionable \? undefined : true\}/);
  assert.match(board, /if \(!actionable\) return;/);
  // The native attribute is deliberately avoided (it would drop the cell from
  // the tab order). `aria-disabled` above must not be confused with it.
  assert.doesNotMatch(board, /[\s"']disabled=\{/);
  // The win highlight comes from the server's line.
  assert.match(board, /winningCellSet\(winningLine\)/);
  assert.match(board, /const isWinning = winning\.has\(index\)/);
  // The winning line is DRAWN across the three cells, not only tinted: the line
  // is the non-colour half of the win cue. It is presentational, and it is only
  // mounted for a complete line whose cells really hold the same mark.
  assert.match(board, /winningCellLine\(winningLine\)/);
  assert.match(board, /data-testid="tic-tac-toe-win-line"/);
  assert.match(board, /const lineColor = lineMark \? seatColor\(seatForMark\(lineMark\)\) : null;/);
  assert.match(board, /pointer-events-none absolute inset-0 z-\[3\] h-full w-full/);
  // The last accepted mark is announced, and a confirmed mark animates in.
  assert.match(board, /data-last-move=\{isLast && Boolean\(cell\) \? "true" : "false"\}/);
  assert.match(board, /<motion\.span \{\.\.\.markMotion\}/);
  assert.match(board, /withReducedMotion\(reduce, \{/);
});

test("visual: marks, focus and the win line use the shared cartoon language", () => {
  // Every mark is the SAME silhouette painted twice: the shared dark outline
  // (`--gr-outline`, the token every GRYND piece uses) under the seat colour.
  // That is the depth — there is no glow left to compete with the win cue.
  assert.match(board, /stroke="var\(--gr-outline, #05101f\)"/);
  assert.match(board, /stroke="currentColor"/);
  assert.doesNotMatch(board, /drop-shadow/, "marks are edged, not haloed");
  // One focus language for every cell, taken from the shared token — a playable
  // cell, a taken cell and an inert cell all ring the same way.
  assert.match(board, /focus-visible:ring-state-focus/);
  assert.doesNotMatch(board, /focus-visible:ring-white\/40/);
  assert.doesNotMatch(board, /focus-visible:ring-amber-\d00/);
  // Keyboard parity with the pointer: focusing an offered cell previews the mark
  // (a shape cue), not only a border colour change.
  assert.match(board, /group-focus-visible:opacity-30/);
  assert.match(board, /data-testid="tic-tac-toe-mark-preview"/);
  // The win line is a casing over the colour stroke, drawn at a constant screen
  // weight so a 20px phone cell and a 76px desktop cell read the same.
  assert.match(board, /strokeWidth="5"/);
  assert.match(board, /vectorEffect="non-scaling-stroke"/);
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

  // A winning line is ORDERED for drawing, and only a complete line is one.
  assert.deepEqual(ui.winningCellLine([0, 1, 2]), [0, 1, 2]);
  assert.deepEqual(ui.winningCellLine([2, 0, 1]), [0, 1, 2]);
  assert.deepEqual(ui.winningCellLine([0, 4, 8]), [0, 4, 8]);
  assert.deepEqual(ui.winningCellLine([2, 4, 6]), [2, 4, 6]);
  assert.deepEqual(ui.winningCellLine([0, 1]), [], "a partial line is not drawable");
  assert.deepEqual(ui.winningCellLine([0, 0, 1]), [], "duplicates cannot make a line");
  assert.deepEqual(ui.winningCellLine([0, 1, 9]), [], "out-of-range cells are not a line");
  assert.deepEqual(ui.winningCellLine(null), []);
});

// ════════════════════════════════════════════════════════════════════════
// 4. The nine-board lattice
// ════════════════════════════════════════════════════════════════════════

test("lattice: all nine mini-boards are mounted from the first snapshot", () => {
  // Nine slots, always — no expansion, nothing materialised later.
  assert.match(page, /const slots = useMemo\(\(\) => latticeSlots\(\), \[\]\)/);
  assert.match(mega, /data-testid="tic-tac-toe-mega"/);
  assert.match(mega, /data-cols=\{LATTICE_COLUMNS\}/);
  assert.match(mega, /const lattice = useMemo\(\(\) => normaliseLattice\(boards\), \[boards\]\)/);
  assert.match(mega, /slots\.map\(\(slot\) =>/);
  assert.match(mega, /key=\{slot\}/);
  assert.match(mega, /data-testid=\{`tic-tac-toe-lattice-board-\$\{slot\}`\}/);
  // Every card is rendered unconditionally: there is no "not in play yet" gate.
  assert.doesNotMatch(mega, /if \(!board\) return null;/);
});

test("lattice: the required board is highlighted and stated in words", () => {
  assert.match(mega, /data-testid="lattice-destination"/);
  assert.match(mega, /data-required=\{required \?\? ""\}/);
  assert.match(mega, /data-free-choice=\{freeChoice \? "true" : "false"\}/);
  // The destination comes from the server's own field, not from the last move.
  assert.match(mega, /const required = requiredBoard\(snapshot\)/);
  assert.match(mega, /const freeChoice = isFreeChoice\(snapshot\)/);
  assert.match(mega, /const offered = playableLatticeBoards\(snapshot\)/);
  assert.match(mega, /const chip = destinationChip\(snapshot\)/);
  assert.match(mega, /boardPositionName\(slot\)/);
  // EXACTLY ONE card can be the required one: its state is computed per slot
  // from an identity check, so two boards can never both read "Play here".
  assert.match(
    mega,
    /const state = boardState\(\{\s*control: board\.control,\s*required: required === slot,/,
    "the required state must be computed from an identity check on the slot",
  );
  assert.match(mega, /required: required === slot,/, "one destination value, compared per slot");
  assert.match(mega, /boardStateBadge\(state\)/);
  assert.match(mega, /boardStateDescription\(state\)/);
  assert.match(mega, /data-state=\{state\}/);
  // The required card's OWN attribute is derived from that state — never from
  // the raw slot list, so a resolved board can never be highlighted.
  assert.match(mega, /data-required=\{state === "required" \? "true" : "false"\}/);
});

test("lattice: the four board states are visually distinct", () => {
  // required — amber ring + glow + chip; open — selectable; waiting — dimmed and
  // inert; won/drawn — owner wash and badge, marks untouched.
  assert.match(mega, /required:\s*"border-amber-300\/80 bg-amber-400\/\[0\.07\] ring-2 ring-amber-300\/60/);
  assert.match(mega, /open: "border-amber-400\/25 bg-black\/40/);
  assert.match(mega, /waiting: "border-white\/\[0\.08\] bg-black\/40 opacity-60"/);
  assert.match(mega, /"won-x": "border-amber-400\/40 bg-amber-400\/\[0\.05\]"/);
  assert.match(mega, /"won-o": "border-cyan-400\/40 bg-cyan-400\/\[0\.05\]"/);
  assert.match(mega, /drawn: "border-white\/10 bg-white\/\[0\.03\] opacity-85"/);
  // The chip wording comes from the shared helper, one word per state.
  assert.match(mega, /datatestid|data-testid=\{`lattice-board-badge-\$\{slot\}`\}/);
  assert.match(mega, /boardStateBadge\(state\)/);
});

test("lattice: a board only offers cells when the SERVER offers the board", () => {
  // The viewer's flag AND the playable set AND the board's own state.
  assert.match(
    mega,
    /selectable=\{viewerCanMove && offered\.includes\(slot\) && state !== "waiting"\}/,
  );
  assert.match(mega, /viewerCanMove=\{selectable\}/);
  assert.match(mega, /board=\{board\.cells\}/);
  assert.match(mega, /winningLine=\{board\.winningLine\}/);
  assert.match(mega, /control=\{board\.control\}/);
  assert.match(mega, /state=\{state\}/);
  assert.match(mega, /data-focused=\{focused \? "true" : "false"\}/);
  // A resolved board is COVERED now, not merely tinted: a dark wash plus the
  // outcome blown up across the playfield, so "this board is gone" reads at a
  // glance across nine boards. The faint 11% ownership wash it replaced could
  // only be seen once you were already looking at that board.
  assert.match(mega, /data-testid=\{`lattice-board-overlay-\$\{slot\}`\}/);
  assert.match(mega, /data-outcome=\{ownerMark \?\? "draw"\}/);
  assert.match(mega, /<MarkGlyph mark=\{ownerMark\}/, "the overlay reuses the board's glyph");
  assert.match(mega, /h-\[74%\] w-\[74%\]/, "the outcome mark is drawn huge");
  assert.doesNotMatch(mega, /opacity: 0\.11/, "the faint wash is gone");
  assert.match(mega, /boardStateMark\(state\)/);
  assert.match(mega, /className="relative"/, "the board sits under the overlay");
});

test("lattice: the winning three-board line is highlighted and drawn", () => {
  assert.match(page, /winningBoards=\{match\.winningBoards\}/);
  assert.match(mega, /const winningSet = winningBoardSet\(winningBoards\)/);
  assert.match(mega, /const winningSlots = normaliseWinningBoards\(winningBoards\)/);
  assert.match(mega, /data-testid="mega-winning-line"/);
  assert.match(mega, /data-testid="mega-win-line"/);
  assert.match(mega, /latticeLine=\{winningSet\.has\(slot\)\}/);
  assert.match(mega, /data-lattice-line=\{latticeLine \? "true" : "false"\}/);
  assert.match(mega, /Line — \{winningMark \?\? "X"\} wins the match/);
  // The overlay is geometry over the FIXED 3x3 grid — no stage is consulted.
  assert.match(mega, /const first = slotGridPosition\(winningSlots\[0\]\)/);
  assert.match(mega, /const last = slotGridPosition\(winningSlots\[2\]\)/);
  // The line animates in, and every animated cue is reduced-motion aware.
  assert.match(mega, /<motion\.line/);
  assert.match(mega, /withReducedMotion\(reduce,/);
  assert.match(mega, /useReducedMotion\(\)/);
});

test("lattice: the three rules are stated on the board", () => {
  assert.match(mega, /data-testid="lattice-rules"/);
  assert.match(mega, /HOW_TO_PLAY\.map\(/);
  const helpers = read(UI_HELPERS);
  assert.match(helpers, /Three in a row claims a mini-board\./);
  assert.match(helpers, /sends your opponent to that same board/);
  assert.match(helpers, /Claim three mini-boards in a line to win the match\./);
});

test("lattice: the phone layout is verified in a real browser and stays wired up", () => {
  // The geometry above is static; `qa/tic-tac-toe-mega-mobile-check.mjs` mounts
  // the REAL lattice inside the REAL Tailwind stylesheet and measures the nine
  // boards at 390 / 360 / 320 / 1280 px (it reproduces the original 504px-lattice
  // bug when the floor is reintroduced).
  assert.ok(
    fs.existsSync("qa/tic-tac-toe-mega-mobile-check.mjs"),
    "qa/tic-tac-toe-mega-mobile-check.mjs must exist",
  );
  assert.ok(
    fs.existsSync("qa/tic-tac-toe-mega-mobile-harness.jsx"),
    "qa/tic-tac-toe-mega-mobile-harness.jsx must exist",
  );
  // The harness mounts the shipped component, not a copy of it.
  const harness = read("qa/tic-tac-toe-mega-mobile-harness.jsx");
  assert.match(harness, /import MegaBoard from "\.\.\/src\/components\/tic-tac-toe\/MegaBoard"/);
  assert.doesNotMatch(harness, /stageSlots|stage=/);
  const pkg = JSON.parse(read("package.json"));
  assert.equal(
    pkg.scripts?.["verify:tic-tac-toe-mobile"],
    "node qa/tic-tac-toe-mega-mobile-check.mjs",
    "package.json must expose the browser check",
  );
});

// ════════════════════════════════════════════════════════════════════════
// 4b. Feedback and the pure destination helpers
// ════════════════════════════════════════════════════════════════════════

test("feedback: a mini-board win or draw is announced and highlighted", () => {
  assert.match(page, /const BOARD_EVENT_MS = 1800/);
  assert.match(page, /data-testid="board-event"/);
  assert.match(page, /data-kind=\{boardEvent.control === "draw" \? "draw" : "win"\}/);
  // The announcement names the POSITION, so it matches the board label.
  assert.match(page, /boardPositionName\(boardEvent\.slot\)/);
  assert.match(page, /board is drawn — locked/);
  assert.match(page, /claims the/);
  // The board that just resolved is ring-highlighted, and the detection is a
  // SERVER control flip.
  assert.match(page, /highlightSlot=\{boardEvent\?\.slot \?\? null\}/);
  assert.match(page, /previous\[slot\]\?\.control === "active"/);
  assert.match(mega, /highlightSlot === slot/);
});

test("ui: the destination helpers project the server's own derivation", async () => {
  const ui = await import("../src/lib/tic-tac-toe/ui.ts");
  // `nextBoard` is a slot, or null for a free choice.
  assert.equal(ui.requiredBoard({ nextBoard: 4 }), 4);
  assert.equal(ui.requiredBoard({ nextBoard: null }), null);
  assert.equal(ui.requiredBoard({}), null);
  assert.equal(ui.requiredBoard({ nextBoard: 9 }), null);

  // Free choice = no required board, a live match, and more than one option.
  assert.equal(
    ui.isFreeChoice({ status: "playing", nextBoard: null, playableBoards: [0, 1, 2] }),
    true,
  );
  assert.equal(ui.isFreeChoice({ status: "playing", nextBoard: 4, playableBoards: [4] }), false);
  assert.equal(ui.isFreeChoice({ status: "finished", nextBoard: null, playableBoards: [0, 1] }), false);
  assert.equal(ui.isFreeChoice(null), false);

  // The playable set is the server's; the fallback still reads the server's own
  // per-board control rather than a rule of its own.
  assert.deepEqual(ui.playableLatticeBoards({ playableBoards: [4] }), [4]);
  assert.deepEqual(
    ui.playableLatticeBoards({ boards: [{ control: "active" }, { control: "draw" }] }),
    [0],
  );
  assert.equal(ui.isBoardPlayable({ playableBoards: [4] }, 4), true);
  assert.equal(ui.isBoardPlayable({ playableBoards: [4] }, 3), false);

  const open = () => ({ cells: Array(9).fill(null), control: "active", winningLine: null });
  const snapshot = {
    boards: [open(), open(), open(), open(), open()],
    nextBoard: 4,
    playableBoards: [4],
    status: "playing",
    viewerCanMove: true,
  };
  assert.equal(ui.canPlayInBoard(snapshot, 4), true);
  assert.equal(ui.canPlayInBoard(snapshot, 0), false, "a board the rules do not offer is never clickable");
  assert.equal(ui.canPlayInBoard({ ...snapshot, viewerCanMove: false }, 4), false);

  // The nine-board projection is TOTAL: a missing slot reads as an empty, open
  // board, so the view can never be an unstable grid.
  const cells = ["X", "X", "X", null, null, null, null, null, null];
  const lattice = ui.normaliseLattice([{ cells, control: "X", winningLine: [0, 1, 2] }, null]);
  assert.equal(lattice.length, 9);
  assert.equal(lattice[0].control, "X");
  assert.deepEqual(lattice[0].winningLine, [0, 1, 2]);
  assert.equal(lattice[1].control, "active");
  assert.equal(lattice[1].cells.every((cell) => cell === null), true);
  assert.equal(ui.boardIsResolved("X"), true);
  assert.equal(ui.boardIsResolved("draw"), true);
  assert.equal(ui.boardIsResolved("active"), false);
  assert.deepEqual([...ui.winningBoardSet([0, 4, 8])].sort((a, b) => a - b), [0, 4, 8]);
  assert.deepEqual(ui.normaliseWinningBoards([0, 4]), [], "a partial line is not a win");
  assert.equal(ui.boardName(4), "Board 5");
  const progress = ui.latticeProgress(lattice);
  assert.equal(progress.total, 81);
  assert.equal(progress.played, 3);
  assert.match(progress.label, /3 of 81 cells played/);

  // Addressing has exactly one mode: a lattice slot.
  assert.equal(ui.serverBoardAt({ boards: [open()] }, 9), null);
  assert.equal(ui.serverBoardAt({ boards: [open()] }, -1), null);
  assert.equal(ui.serverBoardAt({ boards: [open()] }, 0).control, "active");
});

test("ui: the board POSITION names cover the whole lattice", async () => {
  const ui = await import("../src/lib/tic-tac-toe/ui.ts");
  assert.deepEqual(
    Array.from({ length: 9 }, (_, slot) => ui.boardPositionName(slot)),
    [
      "top-left",
      "top-middle",
      "top-right",
      "middle-left",
      "centre",
      "middle-right",
      "bottom-left",
      "bottom-middle",
      "bottom-right",
    ],
  );
  assert.equal(ui.boardPositionName(null), "—");
  assert.equal(ui.boardPositionName(9), "—");
});

test("ui: every mini-board state maps to exactly one word and one description", async () => {
  const ui = await import("../src/lib/tic-tac-toe/ui.ts");
  // The state is derived from the SERVER's values only.
  assert.equal(ui.boardState({ control: "active", required: true, offered: true }), "required");
  assert.equal(ui.boardState({ control: "active", offered: true }), "open");
  assert.equal(ui.boardState({ control: "active" }), "waiting");
  assert.equal(ui.boardState({ control: "X" }), "won-x");
  assert.equal(ui.boardState({ control: "O" }), "won-o");
  assert.equal(ui.boardState({ control: "draw" }), "drawn");
  // A resolved board is never reported as playable, whatever else is passed.
  assert.equal(ui.boardState({ control: "draw", required: true, offered: true }), "drawn");
  assert.equal(ui.boardState({ control: "X", required: true, offered: true }), "won-x");

  assert.equal(ui.boardStateBadge("required"), "Play here");
  assert.equal(ui.boardStateBadge("open"), "Open");
  assert.equal(ui.boardStateBadge("waiting"), "Waiting");
  assert.equal(ui.boardStateBadge("won-x"), "X");
  assert.equal(ui.boardStateBadge("won-o"), "O");
  assert.equal(ui.boardStateBadge("drawn"), "Draw");

  assert.match(ui.boardStateDescription("required"), /play here/);
  assert.match(ui.boardStateDescription("open"), /available/);
  assert.match(ui.boardStateDescription("waiting"), /not available/);
  assert.equal(ui.boardStateDescription("won-o"), "won by O");
  assert.equal(ui.boardStateDescription("drawn"), "a draw");

  assert.equal(ui.boardStateMark("won-x"), "X");
  assert.equal(ui.boardStateMark("won-o"), "O");
  assert.equal(ui.boardStateMark("drawn"), null);
  assert.equal(ui.boardStateMark("required"), null);
});

test("ui: turn guidance is generated from the destination, never hardcoded", async () => {
  const ui = await import("../src/lib/tic-tac-toe/ui.ts");
  const base = { status: "playing", boards: [], playableBoards: [4], nextBoard: 4 };

  // The seat to move is told the POSITION of the board it must play.
  assert.equal(
    ui.moveInstruction({ snapshot: { ...base, viewerCanMove: true } }),
    "Play in the centre board.",
  );
  assert.equal(
    ui.moveInstruction({ snapshot: { ...base, nextBoard: 2, viewerCanMove: true } }),
    "Play in the top-right board.",
  );
  assert.equal(
    ui.moveInstruction({ snapshot: { ...base, nextBoard: 8, viewerCanMove: true } }),
    "Play in the bottom-right board.",
  );
  // The waiting seat is told where its OPPONENT must play.
  assert.equal(
    ui.moveInstruction({ snapshot: { ...base, viewerCanMove: false } }),
    "Your opponent must play in the centre board.",
  );
  // A free choice is spelled out, from both seats.
  const free = { status: "playing", boards: [], playableBoards: [0, 1, 2], nextBoard: null };
  assert.equal(
    ui.moveInstruction({ snapshot: { ...free, viewerCanMove: true } }),
    "Free choice — play in any open board.",
  );
  assert.equal(
    ui.moveInstruction({ snapshot: { ...free, viewerCanMove: false } }),
    "Your opponent can choose any open board.",
  );
  // Terminal, lobby and in-flight states never promise a board.
  assert.equal(ui.moveInstruction({ snapshot: { status: "finished", result: "tie" } }), "Match drawn.");
  assert.equal(ui.moveInstruction({ snapshot: { status: "finished" } }), "Match over.");
  assert.equal(ui.moveInstruction({ snapshot: { status: "waiting" } }), "Waiting for an opponent…");
  assert.equal(ui.moveInstruction({ snapshot: base, submitting: true }), "Sending your move…");
  assert.equal(ui.moveInstruction({ snapshot: null }), "Loading…");

  // The header chip says the same thing without the viewer's perspective.
  assert.equal(ui.destinationChip({ ...base, viewerCanMove: true }), "Required: centre board");
  assert.equal(ui.destinationChip({ ...free, viewerCanMove: true }), "Free choice — any open board");
  assert.equal(ui.destinationChip({ status: "finished" }), "Match over");
  assert.equal(ui.destinationChip({ status: "waiting" }), "Not started");

  // Three bullets, and no expansion vocabulary anywhere in the copy.
  assert.equal(ui.HOW_TO_PLAY.length, 3);
  assert.equal(ui.HOW_TO_PLAY[0], "Three in a row claims a mini-board.");
  assert.match(ui.rulesHint(), /Win three mini-boards in a row\./);
  for (const line of [...ui.HOW_TO_PLAY, ui.rulesHint()]) {
    assert.doesNotMatch(line, /expand|stage|round|sudden|tiebreak/i);
  }

  // A decided match is described from the settled row, not recomputed.
  assert.equal(
    ui.resultReason({ winningBoards: [0, 4, 8], result: "player1", ply: 21 }),
    "Lattice line — Board 1 · Board 5 · Board 9",
  );
  assert.match(ui.resultReason({ result: "tie", ply: 81 }), /Draw — every mini-board resolved/);
  assert.match(ui.resultReason({ result: "player2", ply: 12 }), /Conceded/);

  // Nothing tiebreak-shaped or stage-shaped is exported any more.
  for (const gone of [
    "tiebreakHeading",
    "tiebreakRows",
    "tiebreakWinnerMark",
    "normaliseStage",
    "stageSlots",
    "stageColumns",
    "stageBoardCount",
    "roundLabel",
    "roundName",
    "roundBlurb",
    "roundCellBudget",
    "normaliseSuddenDeath",
    "megaControlCounts",
    "megaWinningSlotSet",
    "latticeControlCounts",
    "boardControlShort",
    "boardControlLabel",
    "boardBadge",
    "boardOwnerSeat",
    "markLabel",
    "turnLabel",
    "destinationLabel",
    "GRID_SIZE",
  ]) {
    assert.equal(gone in ui, false, `${gone} must be gone from the UI helpers`);
  }
});

test("dto: the snapshot carries the Ultimate contract and no expansion field", async () => {
  const { normalizeForViewer, createInitialState, applyMove } = await import(
    "../src/lib/tic-tac-toe/rules.ts"
  );
  const ui = await import("../src/lib/tic-tac-toe/ui.ts");
  const seats = { player1Id: "u1", player2Id: "u2" };
  const state = createInitialState();
  const dto = normalizeForViewer({ state, seats, viewerId: "u1", status: "playing" });

  // Everything the view needs to render, and nothing it must not decide.
  for (const key of [
    "version",
    "phase",
    "status",
    "result",
    "winnerId",
    "boards",
    "activeBoards",
    "completedBoards",
    "nextBoard",
    "playableBoards",
    "ply",
    "currentTurn",
    "currentTurnUserId",
    "winner",
    "winningBoards",
    "lastMove",
    "boardSize",
    "cellCount",
    "latticeSize",
    "maxBoards",
    "marks",
    "player1Id",
    "player2Id",
    "viewerSeat",
    "viewerMark",
    "isViewerTurn",
    "viewerCanMove",
    "legacyState",
  ]) {
    assert.ok(key in dto, `the DTO must carry ${key}`);
  }
  for (const gone of ["stage", "stageBoardSlots", "megaSize", "tiebreak", "suddenDeath"]) {
    assert.equal(gone in dto, false, `the DTO must not carry ${gone}`);
  }

  assert.equal(dto.boards.length, 9);
  assert.equal(dto.latticeSize, 3);
  assert.equal(dto.maxBoards, 9);
  assert.equal(dto.nextBoard, null, "the opening position is a free choice");
  assert.deepEqual(dto.playableBoards, [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(dto.viewerCanMove, true);

  // After a move the destination is the opponent's required board — the CELL
  // index, derived server-side.
  const after = applyMove({ state, seat: "player1", boardIndex: 0, cellIndex: 4 }).state;
  const forBob = normalizeForViewer({ state: after, seats, viewerId: "u2" });
  assert.equal(forBob.nextBoard, 4);
  assert.deepEqual(forBob.playableBoards, [4]);
  assert.equal(forBob.isViewerTurn, true);
  assert.equal(forBob.viewerCanMove, true);
  assert.equal(
    normalizeForViewer({ state: after, seats, viewerId: "u1" }).viewerCanMove,
    false,
    "the seat that just moved may not move again",
  );

  // The helpers read exactly those fields, and agree with the server.
  assert.equal(ui.requiredBoard(forBob), 4);
  assert.deepEqual(ui.playableLatticeBoards(forBob), [4]);
  assert.equal(ui.canPlayInBoard(forBob, 4), true);
  assert.equal(ui.canPlayInBoard(forBob, 3), false);
  assert.equal(ui.moveInstruction({ snapshot: forBob }), "Play in the centre board.");
  assert.equal(ui.destinationChip(forBob), "Required: centre board");

  // A destination that has since resolved becomes a free choice in the DTO, and
  // the helpers then say so in words.
  const resolved = {
    ...after,
    boards: after.boards.map((board, slot) =>
      slot === 4
        ? { cells: ["X", "O", "X", "X", "O", "O", "O", "X", "X"], control: "draw", plies: 9, winningLine: null }
        : board,
    ),
  };
  const forBob2 = normalizeForViewer({ state: resolved, seats, viewerId: "u2" });
  assert.equal(forBob2.nextBoard, null, "a resolved destination is normalised away");
  assert.equal(forBob2.playableBoards.includes(4), false);
  assert.equal(ui.requiredBoard(forBob2), null);
  assert.equal(ui.isFreeChoice(forBob2), true);
  assert.equal(ui.moveInstruction({ snapshot: forBob2 }), "Free choice — play in any open board.");

  // A legacy (expansion-era) row is reported and NEVER offered as playable.
  const legacyDto = normalizeForViewer({
    state: { ...state, stage: 1 },
    seats,
    viewerId: "u1",
    status: "playing",
  });
  assert.equal(legacyDto.legacyState, true);
  assert.equal(legacyDto.viewerCanMove, false);
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
  // A live match has no lobby exit: the result screen offers no play-again CTA
  // and its return-to-lobby CTA is PRACTICE-ONLY (gated on the match's AI flag),
  // so the forfeit button stays the way out of a rated duel.
  assert.doesNotMatch(page, /playAgain=/);
  assert.match(
    page,
    /onReturnToLobby=\{Boolean\(match\.isAi\) \? \(\) => router\.push\("\/casino\/tic-tac-toe"\) : null\}/,
    "the practice popup carries the lobby exit, and only practice",
  );
  assert.match(page, /data-testid="forfeit-button"/);
});

test("economy: the lobby owns the stake, and the match page only shows the server's figures", () => {
  // The stake comes from ONE place — the lobby's coin picker — and goes to the
  // server as the wager the table is opened at.
  assert.match(lobbyPage, /const \[stake, setStake\] = useState\(10\);/);
  assert.match(
    lobbyPage,
    /wager=\{\{ value: stake, onChange: setStake, balance: coinBalance \}\}/,
  );
  assert.match(lobbyPage, /import \{ useCoinBalance \} from "[^"]*hooks\/useCoinBalance"/);
  // PvP always plays for coins, so Play is refused without a legal stake.
  assert.match(lobbyPage, /canPlay=\{Boolean\(isSignedIn\) && stake >= MIN_STAKE\}/);
  assert.match(
    lobbyPage,
    /body: JSON\.stringify\(\{ stakeAmount: Number\(targetStake\) \}\)/,
  );
  // Joining a listed lobby echoes THAT lobby's stake, rather than the picker's.
  assert.match(lobbyPage, /onJoin=\{\(row: LobbyRow\) => createOrJoin\(Number\(row\.stakeAmount \?\? 0\)\)\}/);

  // The match page reads the server's own numbers and DISPLAYS them: it neither
  // computes a pot nor declares a payout. `pot` comes from `ticTacToePayout` in
  // the store, so what a player reads is what the ledger moves.
  assert.match(page, /const stakeAmount = Number\(match\?\.stakeAmount \?\? 0\);/);
  assert.match(page, /const potAmount = Number\(match\?\.pot \?\? 0\);/);
  assert.doesNotMatch(page, /\bprizePaid\b|\bhouseFee\b|\bnewBalance\b|\btokenBalance\b/);
  assert.doesNotMatch(page, /PVP_WINNER_SHARE/);

  // The board components stay presentation-only: no stake, no balance, no pot.
  for (const src of [board, mega]) {
    assert.doesNotMatch(
      src,
      /betAmount|stakeAmount|prizePaid|houseFee|newBalance|tokenBalance/,
    );
  }

  // Free practice vs AI is offered from the lobby (unrated, so no economy).
  assert.match(lobbyPage, /AiDifficultyPicker/);
  assert.match(lobbyPage, /create-ai/);
});

// ════════════════════════════════════════════════════════════════════════
// 6. Registration: the lobby, the catalog, presence, sitemap, copy
// ════════════════════════════════════════════════════════════════════════

test("discovery: the lobby card links to the game and is a 1v1 duel", () => {
  const src = code(LOBBY);
  const card = src.slice(src.indexOf('name: "Ultimate Tic-Tac-Toe"'));
  assert.match(card, /href: "\/games\/tic-tac-toe"/);
  assert.match(card, /leaderboardKey: "tic-tac-toe"/);
  assert.match(card, /playsKey: "tic-tac-toe"/);
  assert.match(card, /descriptionKey: "games\.tic_tac_toe_desc"/);
  assert.match(card, /nameKey: "games\.tic_tac_toe_name"/);
  assert.match(card, /pvpMode: "1v1"/);
  // Shipped card art, not a shared fallback. The art now lives in the shared
  // registry (src/components/games/gameCardArt.js) so the FAQ's games directory
  // draws the SAME card as the lobby; what must hold is that this game's own
  // shipped art is registered there and that the lobby draws cards from it.
  const art = code(ART_REGISTRY);
  assert.match(art, /import ticTacToeArt from "\.\.\/\.\.\/images\/tic-tac-toe-card\.svg"/);
  assert.match(art, /"tic-tac-toe": ticTacToeArt/);
  assert.match(src, /import \{ GAME_CARD_ART \} from "\.\.\/\.\.\/components\/games\/gameCardArt"/);
  // It is a recent card, so it rides the "Newest" sort — directly ahead of
  // Speed Typing. A title that ships later heads the list (Barricade does
  // today), so what is asserted is the sibling order, not "tic-tac-toe is first".
  assert.match(src, /const newestOrder = \[/);
  assert.match(src, /"tic-tac-toe",\n\s*"speed-typing",/);
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
  // The page resolves the post-match surface on the server — the runtime kill
  // switch AND the `ad_free` membership answer — and hands both to the client;
  // the board itself still carries no ad tag (asserted on the next line).
  assert.match(matchRoute, /await postMatchAdSurface\(\)/);
  assert.match(matchRoute, /postMatchAdsEnabled=\{ads\.enabled\}/);
  assert.match(matchRoute, /postMatchAdFree=\{ads\.adFree\}/);
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

// ════════════════════════════════════════════════════════════════════════
// 8. Copy: the lobby teaches the four rules of the shipped game
// ════════════════════════════════════════════════════════════════════════

test("copy: the lobby teaches the four Ultimate rules and no other game", () => {
  // The lobby is the first place a player learns the game, so the four rules
  // have to be there in words: a mini-board is won with three in a row, the cell
  // played decides the opponent's board, a resolved destination means free
  // choice, and three boards in a line wins the match.
  assert.match(lobbyPage, /nine mini-boards/i, "rule 1: the nine-board lattice");
  assert.match(lobbyPage, /three in a row wins a board/i, "rule 1: claiming a board");
  assert.match(lobbyPage, /same lattice slot/i, "rule 2: the destination rule");
  assert.match(lobbyPage, /free choice/i, "rule 3: a resolved destination frees the choice");
  assert.match(lobbyPage, /three mini-boards in a line/i, "rule 4: the match win");

  // ...and it must not still describe plain 3x3 Tic-Tac-Toe, where one line ends
  // the match, nor the retired expansion game.
  assert.doesNotMatch(lobbyPage, /line up three in a row takes the match/i);
  assert.doesNotMatch(lobbyPage, /3×3 · three in a row/);
  assert.doesNotMatch(lobbyPage, /expand|expansion|stage|sudden|tiebreak/i);
  assert.match(lobbyPage, /Nine boards · three in a line claims one/);
});
