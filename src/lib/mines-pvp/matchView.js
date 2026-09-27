// src/lib/mines-pvp/matchView.js
//
// Pure viewer serialization for the Mines PvP ("Mines Duel") shared board.
//
// WHY this lives outside the route: the visibility contract is the single most
// security-sensitive part of the game (it decides whether a client can read
// the mine layout), and it used to be untestable — it sat inline in
// `src/app/api/mines-pvp/match/[matchId]/route.js`. Extracted here it is a pure
// function of (match row, viewer id), so the contract can be asserted directly:
//
//   • ACTIVE match (`waiting` / `ready` / `p1_turn` / `p2_turn`):
//     - `board` is HIDDEN (null) — the hidden mine list never leaves the
//       server while the match is live.
//     - every REVEAL is public to BOTH seats, clue (`hint`) included. The
//       shared-board rules give both players the same board, so a reveal's
//       server-computed number is the same information for each of them.
//     - FLAG claims are PRIVATE per seat. A viewer only ever sees their OWN
//       flagged cells (`myFlags`); the opponent's flag locations are scrubbed
//       out of `picks` (cell → null) and never listed. What IS public is a
//       COUNT: `myMinesFound` / `opponentMinesFound` — how many mines each
//       seat has confirmed (correctly flagged). The side-by-side counter is
//       driven by those counts, so an opponent's progress is visible without
//       ever revealing WHICH tile they found.
//     - the viewer's own auto-pick flag is visible; the opponent's is
//       scrubbed to false so neither side can infer AFK state.
//   • SETTLED match (`finished` ONLY): the full board is revealed (that is
//     how GRYND renders a settled match), together with every reveal's real
//     `isMine` verdict, plus `winnerId` + `winReason`. A `cancelled` match is
//     deliberately NOT revealed: it never settled.
//
// The caller is responsible for having run the row through
// `enrichMatchWithPlayers` first if it wants usernames on `players`.

import {
  GRID_CELLS,
  MATCH_STATUS,
  flagsForSeat,
  minesFoundForSeat,
} from "./constants";

export function isTerminalStatus(status) {
  return status === MATCH_STATUS.FINISHED || status === MATCH_STATUS.CANCELLED;
}

// Per-seat scrub helper for the legacy single-pick columns. Kept for
// backwards-compat with any client that still reads `p1Pick` / `p2Pick` etc.
// directly; new clients should consume the `picks` array instead.
export function scrubPickColumnsForViewer(match, viewerUserId) {
  const viewerIsPlayer1 = match.player1Id === viewerUserId;
  const finished = isTerminalStatus(match.status);

  return {
    p1Pick: match.p1Pick ?? null,
    p1PickIsMine:
      finished || viewerIsPlayer1 ? match.p1PickIsMine ?? null : null,
    p1PickedAt:
      finished || viewerIsPlayer1 ? match.p1PickedAt ?? null : null,
    p1AutoPicked:
      finished || viewerIsPlayer1 ? Boolean(match.p1AutoPicked) : false,
    p2Pick: match.p2Pick ?? null,
    p2PickIsMine:
      finished || !viewerIsPlayer1 ? match.p2PickIsMine ?? null : null,
    p2PickedAt:
      finished || !viewerIsPlayer1 ? match.p2PickedAt ?? null : null,
    p2AutoPicked:
      finished || !viewerIsPlayer1 ? Boolean(match.p2AutoPicked) : false,
  };
}

// Shape the per-pick `picks` array for the viewer.
//
// REVEAL entries: mid-game every reveal is safe (a mine would have ended the
// match), so `isMine` is scrubbed unless it is the viewer's own or the match
// has finished. The CLUE (`hint`) is NEVER scrubbed — under the shared-board
// rules both players see the same revealed board.
//
// FLAG entries: a claim is PRIVATE. For anyone other than the claimant the
// cell is removed (null) and the correctness verdict is stripped, so the
// opponent learns only that a turn was spent — never where the flag went or
// whether it was right. The claimant keeps their own claim (cell + verdict).
export function scrubPicksForViewer(picks, viewerUserId, finished) {
  if (!Array.isArray(picks)) return [];
  const sanitized = [];
  for (const raw of picks) {
    if (!raw || typeof raw !== "object") continue;
    const isViewerPick =
      typeof raw.userId === "string" && raw.userId === viewerUserId;
    const isFlag = Boolean(raw.flag);
    const reveal = !isFlag || isViewerPick || finished;

    sanitized.push({
      userId: raw.userId ?? null,
      seat: raw.seat ?? null,
      // An opponent's flag cell is never disclosed — the claim stays a
      // private marker even after a settle so a replayed board can't be
      // mined for the opponent's reads.
      cell:
        isFlag && !isViewerPick
          ? null
          : Number.isInteger(Number(raw.cell))
            ? Number(raw.cell)
            : null,
      // Mid-game scrub: every reveal is safe (game would have ended).
      // Finished: reveal the actual isMine flag. A flag's verdict is only
      // ever shown to the claimant.
      isMine: reveal ? Boolean(raw.isMine) : false,
      // The server-computed CLUE (distance to the nearest mine, 1+ for safe
      // cells). PUBLIC to both seats. A flag entry carries no clue (null).
      hint: !isFlag && raw.hint != null ? Number(raw.hint) : null,
      // Discriminator: true when this entry is a FLAG claim rather than a
      // reveal.
      flag: isFlag,
      pickedAt: typeof raw.pickedAt === "string" ? raw.pickedAt : null,
      // The viewer's own auto-pick is fine to reveal; the OPPONENT's is
      // scrubbed to false (AFK should not be visible to a peer).
      autoPicked: finished || isViewerPick ? Boolean(raw.autoPicked) : false,
    });
  }
  return sanitized;
}

// The single viewer-shaped match payload used by every read path (the match
// GET and the AI-turn POST), so a client can never receive two divergent
// descriptions of the same row.
export function normaliseMatchForViewer(match, viewerUserId) {
  if (!match) return null;
  const viewerIsPlayer1 = match.player1Id === viewerUserId;
  const viewerSeat = viewerIsPlayer1 ? "player1" : "player2";
  const opponentSeat = viewerIsPlayer1 ? "player2" : "player1";
  // The board (and every reveal's verdict, and the payout numbers) is
  // disclosed ONLY once the match actually SETTLED.
  const finished = match.status === MATCH_STATUS.FINISHED;
  const picks = scrubPicksForViewer(
    Array.isArray(match.picks) ? match.picks : [],
    viewerUserId,
    finished,
  );

  // Safe-tiles counter — the zugzwang legibility stat. The client CANNOT
  // derive this mid-match (the opponent's picks have their `isMine` scrubbed),
  // so the server stamps it from the board + raw pick history.
  const safeTilesTotal = GRID_CELLS - Number(match.minesCount);
  const safePicksMade = (Array.isArray(match.picks) ? match.picks : []).filter(
    (p) => p && !Boolean(p.isMine) && !Boolean(p.flag),
  ).length;

  return {
    id: match.id,
    // Seat identities — the client maps "which seat am I" from these, never
    // from anything it sends up.
    player1Id: match.player1Id,
    player2Id: match.player2Id,
    isAi: Boolean(match.isAi),
    stakeAmount: Number(match.stakeAmount),
    minesCount: match.minesCount,
    safeTilesRemaining: Math.max(0, safeTilesTotal - safePicksMade),
    status: match.status,
    firstPlayerId: match.firstPlayerId,
    currentTurnUserId: match.currentTurnUserId,
    roundDeadline: match.roundDeadline,
    viewerIsPlayer1,
    isViewerTurn: match.currentTurnUserId === viewerUserId,
    // The chronological history is the authoritative source. Clients render
    // the board from this array; the legacy single-pick scalars are mirrored
    // for backwards-compat only.
    picks,
    pickCount: picks.length,
    ...scrubPickColumnsForViewer(match, viewerUserId),
    // Board: full reveal ONLY once terminal, hidden while the match is live.
    board: finished ? match.board : null,
    // Result + payout. The loser sees zero prize/fees.
    result: match.result ?? null,
    winnerId: match.winnerId ?? null,
    winReason: match.winReason ?? null,
    // ── Flag state ────────────────────────────────────────────────────
    // The viewer's OWN confirmed mines (correctly flagged cells) — private,
    // canonicalised (unique, sorted, in-range). The OPPONENT's flag
    // locations are never sent; only their confirmed count is.
    myFlags: flagsForSeat(match, viewerSeat),
    // Public per-seat progress: how many mines each player has confirmed.
    // The side-by-side "5 | 5" counter is driven by these two numbers.
    myMinesFound: minesFoundForSeat(match, viewerSeat),
    opponentMinesFound: minesFoundForSeat(match, opponentSeat),
    prizePaid:
      finished && match.winnerId === viewerUserId
        ? Number(match.prizePaid) || 0
        : 0,
    houseFee:
      finished && match.winnerId === viewerUserId
        ? Number(match.houseFee) || 0
        : 0,
    startedAt: match.startedAt,
    endedAt: match.endedAt,
    createdAt: match.createdAt,
    // Player summaries (usernames/icons) added by enrichMatchWithPlayers.
    players: match.players ?? null,
  };
}
