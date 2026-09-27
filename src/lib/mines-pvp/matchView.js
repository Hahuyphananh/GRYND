// src/lib/mines-pvp/matchView.js
//
// Pure viewer serialization for the Mines PvP ("Mines Duel") shared board.
//
// WHY this lives outside the route: the visibility contract is the single most
// security-sensitive part of the game (it decides whether a client can read
// the mine layout), and it used to be untestable — it sat inline in
// `src/app/api/mines-pvp/match/[matchId]/route.js`, reached only through an
// authenticated Next handlers. Extracted here it is a pure function of
// (match row, viewer id), so the contract can be asserted directly:
//
//   • ACTIVE match (`waiting` / `ready` / `p1_turn` / `p2_turn`):
//     - `board` is HIDDEN (null) — the hidden mine list never leaves the
//       server while the match is live.
//     - every REVEAL is public to BOTH seats, clue (`hint`) included. The
//       shared-board rules give both players the same board, so a reveal's
//       server-computed number is the same information for each of them.
//     - FLAG claims are public per seat (`p1Flags` / `p2Flags`), read from
//       their own columns so neither seat can clobber the other. A claim
//       never carries a correctness verdict.
//     - the viewer's own auto-pick flag is visible; the opponent's is
//       scrubbed to false so neither side can infer AFK state.
//   • SETTLED match (`finished` ONLY): the full board is revealed (that is
//     how GRYND renders a settled match), together with every reveal's real
//     `isMine` verdict, plus `winnerId` + `winReason`. A `cancelled` match is
//     deliberately NOT revealed: it never settled, so there is nothing to
//     show and no reason to hand out a mine layout.
//
// The caller is responsible for having run the row through
// `enrichMatchWithPlayers` first if it wants usernames on `players`.

import { GRID_CELLS, MATCH_STATUS, flagsForSeat } from "./constants";

export function isTerminalStatus(status) {
  return status === MATCH_STATUS.FINISHED || status === MATCH_STATUS.CANCELLED;
}

// Per-seat scrub helper for the legacy single-pick columns. Kept for
// backwards-compat with any client that still reads `p1Pick` / `p2Pick` etc.
// directly; new clients should consume the `picks` array (returned by
// `scrubPicksForViewer`) instead. The legacy columns show the MOST RECENT
// REVEAL from each seat (mirrored server-side) so the rendered cell matches the
// latest entry in the per-seat slice of `picks`.
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

// Shape the per-pick `picks` array for the viewer. Mid-game, only safe
// REVEALS can exist (a mine would have ended the match), so we hardcode
// `isMine: false` and scrub the OPPONENT's `autoPicked` flag to false so
// neither side can deduce the other's AFK state. The CLUE (`hint`) is NOT
// scrubbed: under the shared-board rules both players see the same board, so
// the server-computed number belongs to both seats.
export function scrubPicksForViewer(picks, viewerUserId, finished) {
  if (!Array.isArray(picks)) return [];
  const sanitized = [];
  for (const raw of picks) {
    if (!raw || typeof raw !== "object") continue;
    const isViewerPick =
      typeof raw.userId === "string" && raw.userId === viewerUserId;
    sanitized.push({
      userId: raw.userId ?? null,
      seat: raw.seat ?? null,
      cell: Number(raw.cell) || 0,
      // Mid-game scrub: every reveal is safe (game would have ended).
      // Finished: reveal the actual isMine flag (the game-ending mine is the
      // one whose isMine=true inside this array).
      isMine: finished || isViewerPick ? Boolean(raw.isMine) : false,
      // The server-computed CLUE (distance to the nearest mine, 1+ for safe
      // cells). PUBLIC to both seats: the shared-board rules give both players
      // the same revealed board, so the opponent's reveals carry their numbers
      // too. A flag entry has no clue (null) — a claim reveals nothing.
      hint: raw.hint != null ? Number(raw.hint) : null,
      // Discriminator: true when this entry is a FLAG claim rather than a
      // reveal. Flags may appear mid-match now (a flag no longer ends the
      // match) and never carry a mine verdict.
      flag: Boolean(raw.flag),
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
  // The board (and every reveal's verdict, and the payout numbers) is
  // disclosed ONLY once the match actually SETTLED. `cancelled` is terminal
  // but never settled, so it stays scrubbed.
  const finished = match.status === MATCH_STATUS.FINISHED;
  const picks = scrubPicksForViewer(
    Array.isArray(match.picks) ? match.picks : [],
    viewerUserId,
    finished,
  );

  // Safe-tiles counter — the zugzwang legibility stat. The client CANNOT
  // derive this mid-match (the opponent's picks have their `isMine` scrubbed,
  // so a viewer can't count safe reveals they didn't make), so the server
  // stamps it from the board + raw pick history: total safe cells (25 − mines)
  // minus every safe reveal so far (mine reveals never count — and mid-match
  // there are none yet, because a mine would have ended the game). As it
  // approaches 0, only mines are left unrevealed: whoever's turn it is next
  // loses by logic — the zugzwang endgame.
  const safeTilesTotal = GRID_CELLS - Number(match.minesCount);
  // FLAG claims are not reveals: they say nothing about the cell, so they must
  // not count towards "safe cells discovered".
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
    // Result + payout. The loser sees zero prize/fees (avoids leaking the
    // winner's exact payout amount). The shared-board flow never produces a
    // DRAW; the field stays on the response for legacy consumers.
    result: match.result ?? null,
    winnerId: match.winnerId ?? null,
    // WHY the match ended (shared-board rules): 'mine_hit' |
    // 'all_mines_flagged' | 'resign' | 'disconnect', or null while the match
    // is still in progress. `result` says WHO won; this says HOW.
    winReason: match.winReason ?? null,
    // Per-player flag CLAIMS. Flags are public shared-board state (both seats
    // see both sets) and each is read from its own column, so the two
    // collections stay independent — the same cell may appear in both.
    // Canonicalised (unique, sorted, in-range) so the client never receives a
    // raw/legacy JSONB shape.
    p1Flags: flagsForSeat(match, "player1"),
    p2Flags: flagsForSeat(match, "player2"),
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
