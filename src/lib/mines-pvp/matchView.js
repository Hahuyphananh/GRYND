// src/lib/mines-pvp/matchView.js
//
// Pure viewer serialization for the Mines PvP (simultaneous, independent
// boards) match system.
//
// The visibility contract is the security-sensitive core of the game: it
// decides whether a client can read the hidden mine layout or mine values.
// It lives here, outside the route, as a pure function of (match row,
// viewer id) so it can be asserted directly:
//
//   • ACTIVE match: each seat sees ONLY its own resolved cells. A safe
//     reveal carries the server-computed clue (Chebyshev distance to that
//     seat's nearest mine) because the player already saw it. A mine the
//     seat detonated is marked `mine: true`. The opponent's board, mine
//     positions and mine VALUES are never serialised — only the
//     opponent's PUBLIC progress (score, safe reveals, mines hit,
//     completion state).
//   • FINISHED match: both complete boards are revealed (that is the
//     replay state), plus the result / winnerId / winReason.
//
// The caller (the route) is responsible for having run the row through
// `enrichMatchWithPlayers` first if it wants usernames on `players`.

import {
  GRID_CELLS,
  MATCH_STATUS,
  correctFlagsForSeat,
  flagsForSeat,
  isMine,
  nearestMineDistance,
  normalizeFlags,
  revealedForSeat,
} from "./constants";

export function isTerminalStatus(status) {
  return (
    status === MATCH_STATUS.FINISHED || status === MATCH_STATUS.CANCELLED
  );
}

// Build the viewer's own revealed-cell descriptors. Safe reveals carry
// their public clue; a detonated mine is flagged as a mine (that seat
// already saw it).
function describeOwnReveals(board, revealed) {
  const mineSet = new Set(board?.mines || []);
  return normalizeFlags(revealed).map((cell) => {
    const mine = mineSet.has(cell);
    return {
      cell,
      mine,
      hint: mine ? null : nearestMineDistance(board, cell),
    };
  });
}

export function normaliseMatchForViewer(match, viewerUserId) {
  if (!match) return null;
  const viewerIsPlayer1 = match.player1Id === viewerUserId;
  const viewerSeat = viewerIsPlayer1 ? "player1" : "player2";
  const opponentSeat = viewerIsPlayer1 ? "player2" : "player1";
  const finished = match.status === MATCH_STATUS.FINISHED;

  const viewerBoard = viewerSeat === "player2" ? match.p2Board : match.p1Board;
  const opponentBoard =
    opponentSeat === "player2" ? match.p2Board : match.p1Board;

  const myRevealed = revealedForSeat(match, viewerSeat);
  const myFlags = flagsForSeat(match, viewerSeat);
  const myCorrectFlagCells = correctFlagsForSeat(match, viewerSeat);

  const p = (base) =>
    viewerSeat === "player2" ? match[`p2${base}`] : match[`p1${base}`];
  const o = (base) =>
    opponentSeat === "player2" ? match[`p2${base}`] : match[`p1${base}`];

  const safeTilesTotal = GRID_CELLS - Number(match.minesCount || 0);

  return {
    id: match.id,
    player1Id: match.player1Id,
    player2Id: match.player2Id,
    isAi: Boolean(match.isAi),
    stakeAmount: Number(match.stakeAmount),
    minesCount: match.minesCount,
    status: match.status,

    // ── Seat identity (never from anything the client sends) ──────────
    viewerIsPlayer1,
    viewerSeat,
    opponentSeat,

    // ── Match clock (server-authoritative) ────────────────────────────
    matchTimerSeconds: Number(match.matchTimerSeconds) || 0,
    matchDeadline: match.matchDeadline ?? null,
    startedAt: match.startedAt,
    endedAt: match.endedAt,
    createdAt: match.createdAt,

    // ── Viewer's own board state ──────────────────────────────────────
    // The hidden board is NOT sent while the match is live; the viewer
    // only receives the cells it has resolved (with the clues it saw).
    myRevealed: describeOwnReveals(viewerBoard, myRevealed),
    myFlags,
    myCorrectFlagCells,
    myIncorrectFlagCells: normalizeFlags(myFlags).filter(
      (c) => !myCorrectFlagCells.includes(c),
    ),
    myScore: Number(p("Score")) || 0,
    mySafeRevealed: Number(p("SafeRevealed")) || 0,
    myMinesHit: Number(p("MinesHit")) || 0,
    myCorrectFlags: Number(p("CorrectFlagCount")) || 0,
    myIncorrectFlags: Number(p("IncorrectFlagCount")) || 0,
    myCompleted: Boolean(p("Completed")),
    myCompletedAt: p("CompletedAt") ?? null,
    myLocked: Boolean(p("Locked")),
    mySafeTilesRemaining: Math.max(
      0,
      safeTilesTotal - (Number(p("SafeRevealed")) || 0),
    ),

    // ── Opponent PUBLIC progress (never their board) ─────────────────
    opponentScore: Number(o("Score")) || 0,
    opponentSafeRevealed: Number(o("SafeRevealed")) || 0,
    opponentMinesHit: Number(o("MinesHit")) || 0,
    opponentCorrectFlags: Number(o("CorrectFlagCount")) || 0,
    opponentIncorrectFlags: Number(o("IncorrectFlagCount")) || 0,
    opponentCompleted: Boolean(o("Completed")),
    opponentCompletedAt: o("CompletedAt") ?? null,
    opponentLocked: Boolean(o("Locked")),

    // ── Result ────────────────────────────────────────────────────────
    result: match.result ?? null,
    winnerId: match.winnerId ?? null,
    winReason: match.winReason ?? null,

    // ── Boards (revealed ONLY once terminal) ──────────────────────────
    board: finished ? viewerBoard : null,
    opponentBoard: finished ? opponentBoard : null,
    boards: finished
      ? { p1: match.p1Board ?? null, p2: match.p2Board ?? null }
      : null,

    // ── Legacy compatibility fields ───────────────────────────────────
    // The pre-rework client still reads these. They carry safe, non-leaky
    // values so an un-migrated UI degrades gracefully instead of crashing.
    picks: [],
    pickCount: 0,
    p1Pick: null,
    p2Pick: null,
    p1PickIsMine: null,
    p2PickIsMine: null,
    p1AutoPicked: false,
    p2AutoPicked: false,
    p1PickedAt: null,
    p2PickedAt: null,
    currentTurnUserId: null,
    roundDeadline: null,
    firstPlayerId: match.firstPlayerId ?? null,
    safeTilesRemaining: Math.max(
      0,
      safeTilesTotal - (Number(p("SafeRevealed")) || 0),
    ),
    myMinesFound: Number(p("CorrectFlagCount")) || 0,
    opponentMinesFound: Number(o("CorrectFlagCount")) || 0,
    houseFee:
      finished && match.winnerId === viewerUserId
        ? Number(match.houseFee) || 0
        : 0,
    prizePaid:
      finished && match.winnerId === viewerUserId
        ? Number(match.prizePaid) || 0
        : 0,

    players: match.players ?? null,
  };
}
