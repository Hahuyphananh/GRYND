/**
 * tic-tac-toe-ui-contract.test.mjs
 *
 * The Tic-Tac-Toe Duel FRONTEND contract: what the board may show, what the
 * match page may send, and — above all — what it is NOT allowed to decide.
 *
 * The UI is held to the same trust boundary as the server. The only value it
 * ever authors is the cell index of a click; the board, whose turn it is, the
 * winning line, the draw and the settled result all arrive in the snapshot.
 * There is no code path in which the client detects a line, computes a winner
 * or submits a result.
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
const UI_HELPERS = "src/lib/tic-tac-toe/ui.ts";
const LOBBY = "src/app/casino/PageClient.jsx";
const SITEMAP = "src/app/sitemap.ts";
const TRANSLATIONS = "src/lib/appTextTranslations.js";
const MOVE_ROUTE = "src/app/api/tic-tac-toe/match/[matchId]/move/route.ts";

const page = code(MATCH_PAGE);
const board = code(BOARD);
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
  assert.match(page, /<MatchLoading label="Loading Tic-Tac-Toe…"/, "loading state");
  assert.match(page, /Unable to load this match/, "error state");
  assert.match(page, /<MatchWaiting/, "waiting / opponent state");
  assert.match(page, /data-testid="tic-tac-toe-match"/, "the live match");
  assert.match(page, /data-testid="tic-tac-toe-board"|<\s*TicTacToeBoard/, "the board");
  assert.match(page, /data-testid="tic-tac-toe-cancelled"/, "cancelled state");
  assert.match(page, /<PvpResultScreen/, "the shared win/loss/draw screen");
  assert.match(page, /<ReportModal/, "report flow");
  assert.match(page, /<EmotePicker/, "emotes");
});

test("ui: the game information block shows opponent, mark, turn and status", () => {
  // Seat cards carry a name, a mark and whose turn it is.
  assert.match(page, /data-testid=\{`seat-\$\{seat\}`\}/);
  assert.match(page, /data-active=\{isActive \? "true" : "false"\}/);
  assert.match(page, /const isActive = match\.currentTurn === seat/);
  // A status chip and a turn banner.
  assert.match(page, /data-testid="match-status"/);
  assert.match(page, /statusLabel\(match\.status\)/);
  assert.match(page, /data-testid="turn-status"/);
  assert.match(page, /turnLabel\(\{/);
  // The viewer's own mark, their opponent, and how far the match has gone.
  assert.match(page, /viewerMarkLabel\(viewerSeat\)/);
  assert.match(page, /progressLabel\(match\.board\)/);
  assert.match(page, /label="Your mark"/);
  assert.match(page, /label="Opponent"/);
  assert.match(page, /label="Moves played"/);
  assert.match(page, /label="Turn"/);
  // The move log is rendered from the SNAPSHOT's moves, not a local array.
  assert.match(page, /const moves = Array\.isArray\(match\?\.moves\) \? match\.moves : \[\]/);
  assert.match(page, /moves\.map\(\(mv: any, index: number\) =>/);
});

// ════════════════════════════════════════════════════════════════════════
// 2. Authority: the client sends a cell, never a result
// ════════════════════════════════════════════════════════════════════════

test("authority: the move request carries ONLY { cellIndex, expectedVersion }", () => {
  assert.match(
    page,
    /body: JSON\.stringify\(\{ cellIndex, expectedVersion \}\)/,
    "the move POST must send exactly the cell and the concurrency token",
  );
  // Exactly one move request exists in the page.
  assert.equal(
    (page.match(/\/move`/g) ?? []).length,
    1,
    "the match page must have exactly one /move call",
  );
  // The route it targets forwards only those two fields either.
  const route = code(MOVE_ROUTE);
  assert.match(route, /cellIndex: body\?\.cellIndex/);
  assert.match(route, /expectedVersion: body\?\.expectedVersion/);
  assert.doesNotMatch(route, /body\?\.(mark|board|winner|result|score|turn)\b/);
});

test("authority: the client never computes a line, a winner or a result", () => {
  // The rules engine and its vocabulary stay server-side.
  assert.doesNotMatch(page, /lib\/tic-tac-toe\/rules/);
  assert.doesNotMatch(page, /findWinningLine|WINNING_LINES|applyMove|computeMatchResult/);
  assert.doesNotMatch(board, /findWinningLine|WINNING_LINES|applyMove/);
  // The outcome is READ from the settled row: the server's `result` and
  // `winnerId` are the only inputs.
  assert.match(page, /outcomeFor\(\{\s*result: match\?\.result,\s*winnerId: match\?\.winnerId,/);
  assert.match(page, /open=\{finished\}/);
  assert.match(page, /gameKey="tic-tac-toe"/);
});

test("authority: the board is rendered from the snapshot, never from local state", () => {
  assert.match(page, /board=\{match\.board\}/);
  assert.match(page, /winningLine=\{match\.winningLine\}/);
  assert.match(page, /lastMove=\{match\.lastMove\}/);
  assert.match(page, /viewerSeat=\{viewerSeat\}/);
  // The unlock flag is the SERVER's `viewerCanMove`, narrowed only by "a
  // request is in flight" and "the match is over".
  assert.match(
    page,
    /const boardUnlocked =\s*Boolean\(match\) &&\s*!finished &&\s*!cancelled &&\s*!submitting &&\s*Boolean\(match\?\.viewerCanMove\)/,
  );
  assert.match(page, /viewerCanMove=\{boardUnlocked\}/);
  // The board itself re-checks the cell before offering it.
  assert.match(board, /isCellPlayable\(\{/);
  assert.match(board, /if \(!actionable\) return;/);
  assert.match(board, /onPlay: \(cellIndex: number\) => void;/);
});

test("authority: the optimistic mark is feedback, and a rejection resyncs", () => {
  // The ghost is local-only…
  assert.match(page, /pendingCell=\{pending\?\.cell \?\? null\}/);
  assert.match(page, /setPending\(\{ cell: cellIndex, version: Number\(expectedVersion\) \|\| 0 \}\)/);
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
  assert.match(board, /grid grid-cols-3 gap-2 sm:gap-3/);
  assert.match(board, /aspect-square/);
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
// 4. Lifecycle: waiting, live updates and the way out
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
  assert.doesNotMatch(lobbyPage, /betAmount|stakeAmount|prizePaid|houseFee|newBalance/);
  // Free practice vs AI is offered from the lobby (unrated, so no economy).
  assert.match(lobbyPage, /AiDifficultyPicker/);
  assert.match(lobbyPage, /create-ai/);
});

// ════════════════════════════════════════════════════════════════════════
// 5. Registration: the lobby, the catalog, presence, sitemap, copy
// ════════════════════════════════════════════════════════════════════════

test("discovery: the lobby card links to the game and is a 1v1 duel", () => {
  const src = code(LOBBY);
  const card = src.slice(src.indexOf('name: "Tic-Tac-Toe"'));
  assert.match(card, /href: "\/casino\/tic-tac-toe"/);
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
  assert.equal(entry.href, "/casino/tic-tac-toe");
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
  const src = code(SITEMAP);
  assert.match(src, /ticTacToeMatches,/);
  assert.match(
    src,
    /\{ path: "\/games\/tic-tac-toe", source: \[ticTacToeMatches, ticTacToeMatches\.createdAt\] \}/,
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
