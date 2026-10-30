// src/lib/dominoes/ui.ts
//
// The Dominoes match view's pure view-model: every string, counter and flag the
// board renders, derived from the SERVER's snapshot and nothing else.
//
// ── WHY THIS IS A SEPARATE, PURE MODULE ───────────────────────────────────
//
// The match page decides nothing about a match. It renders:
//
//   * the viewer's own hand,
//   * the opponent's tile COUNT (never the tiles),
//   * the public chain and its two open ends,
//   * the draw-pile COUNT,
//   * the turn, the deadline, and the settled result,
//
// all of it read from `GET /api/dominoes/match/<id>` and from nothing local. The
// functions here are the presentation of exactly those fields — no React, no
// fetch, no socket — so they can be driven directly by tests and so a renamed
// projection breaks one file instead of a board.
//
// ── WHAT THE CLIENT MAY DERIVE, AND WHY THAT IS SAFE ──────────────────────
//
// `playOptionsFor` / `availableActions` compute which ENDS a tile may go on and
// whether drawing or passing is even offered. That is not the client deciding
// the rules: it is the same public information (the two open values, the
// viewer's own hand, the chain length, the pile COUNT) that a human at a table
// reads at a glance. It exists so a control can be DISABLED with a reason
// instead of sending a request the server will refuse.
//
// Anything sent is re-validated by `validateAction`/`applyAction` inside the
// store's row-locked transaction, so an enabled-looking control can never
// produce an accepted illegal move — the worst case is a 409 and a resync.
// Nothing here ever computes a winner, a pips total or a deadline.

import { viewerOutcome } from "../results/viewerOutcome";
import { MATCH_STATUS } from "./constants";
import type { ChainTileLike } from "./layout";

/** A seat key, as the API spells it. */
export type Seat = "player1" | "player2";

/** A chain end. */
export type ChainEnd = "left" | "right";

/**
 * The drag payload type a hand tile carries when it is picked up.
 *
 * Shared, because two components have to agree on it: the hand SETS it when a
 * tile is lifted, and the chain only accepts a drop that carries it — so a file
 * or a link dragged over the board can never be mistaken for a tile.
 */
export const DOMINO_DRAG_TYPE = "application/x-domino-tile";

/** What the result screen is told. `draw` is a real Dominoes outcome. */
export type Outcome = "win" | "loss" | "draw";

/**
 * The public open values, as `openEnds` arrives on the wire.
 *
 * Both halves are optional because the projection can be partial (a lobby has no
 * chain at all), and `countdownFor`-style callers read them defensively — a
 * missing half is simply "that end is not open".
 */
export type OpenEnds =
  | { left?: number | null; right?: number | null }
  | null
  | undefined;

/* -------------------------------------------------------------------------- *
 * Lifecycle copy
 * -------------------------------------------------------------------------- */

/** True for the two states that accept nothing further. */
export function isTerminalStatus(status: unknown): boolean {
  const value = String(status ?? "");
  return value === MATCH_STATUS.FINISHED || value === MATCH_STATUS.CANCELLED;
}

/** Human copy for the lifecycle chip. */
export function statusLabel(status: unknown): string {
  switch (String(status ?? "")) {
    case MATCH_STATUS.WAITING:
      return "Waiting for an opponent";
    case MATCH_STATUS.PLAYING:
      return "In progress";
    case MATCH_STATUS.FINISHED:
      return "Finished";
    case MATCH_STATUS.CANCELLED:
      return "Cancelled";
    default:
      return "Loading";
  }
}

/**
 * The turn banner.
 *
 * Every branch is driven by the server's own `isViewerTurn` and `status` — never
 * by the viewer's last submission, and never by the local countdown.
 */
export function turnLabel({
  status,
  isViewerTurn,
  viewerSeat,
  opponentName,
}: {
  status?: unknown;
  isViewerTurn?: boolean;
  viewerSeat?: Seat | null;
  opponentName?: string | null;
}): string {
  const value = String(status ?? "");
  if (value === MATCH_STATUS.WAITING) return "Waiting for an opponent to join…";
  if (value === MATCH_STATUS.CANCELLED) return "This match was cancelled.";
  if (value === MATCH_STATUS.FINISHED) return "Match complete.";
  if (!viewerSeat) return "Loading the match…";
  if (isViewerTurn) return "Your turn — play a tile, or draw if nothing fits.";
  return `${opponentName || "Your opponent"} is deciding…`;
}

/**
 * Why the round ended, as a sentence.
 *
 * The server records the reason (`emptied-hand`, `blocked-pips`, `resigned`,
 * `abandoned`); the client only names it, per outcome.
 */
export function resultReasonLabel(reason: unknown, outcome: Outcome | null): string {
  switch (String(reason ?? "")) {
    case "emptied-hand":
      return outcome === "win"
        ? "You played your last tile."
        : "Your opponent played their last tile.";
    case "blocked-pips":
      if (outcome === "draw") {
        return "Neither side could play and both hands counted the same.";
      }
      return outcome === "win"
        ? "Neither side could play — your opponent had more pips left."
        : "Neither side could play — you had more pips left.";
    case "resigned":
      return outcome === "win"
        ? "Your opponent resigned the match."
        : "You resigned the match.";
    case "abandoned":
      return outcome === "win"
        ? "Your opponent left and did not return — the match was awarded to you."
        : "You left and did not return — the match was awarded to your opponent.";
    case "timed-out":
      return "The match ran out of time.";
    default:
      return outcome === "win"
        ? "You won the match."
        : outcome === "loss"
          ? "Your opponent won the match."
          : "Match complete.";
  }
}

/**
 * The viewer's outcome, from the settled `result`/`winnerId`.
 *
 * DELEGATED to src/lib/results/viewerOutcome.ts — the platform's one verdict
 * rule — so Dominoes answers "who won" the way every other game does: from the
 * server's settled row, read against the seat the SERVER says the viewer holds.
 * Unlike the win/lose duels it keeps `draw`, because a blocked round on equal
 * pips really is one.
 */
export function outcomeFor({
  result,
  winnerId,
  viewerSeat,
  userId,
}: {
  result?: string | null;
  winnerId?: string | null;
  viewerSeat?: Seat | null;
  userId?: string | null;
}): Outcome | null {
  return viewerOutcome({ result, winnerId, viewerSeat, viewerId: userId });
}

/** How to refer to a seat from the viewer's point of view. */
export function seatLabel(
  seat: Seat | null | undefined,
  viewerSeat: Seat | null | undefined,
): string {
  if (!seat) return "—";
  if (viewerSeat) return seat === viewerSeat ? "You" : "Opponent";
  return seat === "player1" ? "Player 1" : "Player 2";
}

/* -------------------------------------------------------------------------- *
 * Snapshot ordering
 * -------------------------------------------------------------------------- */

/**
 * Monotonic-snapshot guard, the same one the other match views use.
 *
 * Several refreshes can be in flight at once (the initial load, a socket push,
 * a post-move resync, the deadline read), so an older response must never roll
 * the board back — and a same-version TERMINAL snapshot (a resignation landing
 * in the same instant as a live read) must never be overwritten by a live one.
 */
export function isIncomingSnapshotStale(
  current: { version?: unknown; status?: unknown } | null | undefined,
  incoming: { version?: unknown; status?: unknown } | null | undefined,
): boolean {
  if (!current) return false;
  const incomingVersion = Number(incoming?.version);
  if (!Number.isFinite(incomingVersion)) return true;
  const currentVersion = Number(current?.version);
  if (!Number.isFinite(currentVersion)) return false;
  if (incomingVersion < currentVersion) return true;
  if (incomingVersion > currentVersion) return false;
  const currentTerminal = isTerminalStatus(current?.status);
  const incomingTerminal = isTerminalStatus(incoming?.status);
  return currentTerminal && !incomingTerminal;
}

/* -------------------------------------------------------------------------- *
 * Tiles
 * -------------------------------------------------------------------------- */

/**
 * A tile as its two halves, or null when it is not shaped like a tile at all.
 *
 * This is a DISPLAY splitter, so it accepts either half order (`"3-6"` reads as
 * 3–6). Whether an id is a tile of the double-six set — and whether it is in the
 * canonical `high-low` form — is the engine's question (`isTileId`, run on the
 * server before any action is applied).
 */
export function tileParts(tile: unknown): [number, number] | null {
  if (typeof tile !== "string") return null;
  const match = /^([0-6])-([0-6])$/.exec(tile);
  if (!match) return null;
  return [Number(match[1]), Number(match[2])];
}

/**
 * A tile id as it is spoken and printed: `"6-3"` → `"6–3"`.
 *
 * The HYPHEN is the wire format (the engine's canonical id), the en dash is the
 * display format. A malformed id falls back to the raw string rather than
 * rendering nothing, so a bug is visible instead of silent.
 */
export function tileLabel(tile: unknown): string {
  const parts = tileParts(tile);
  if (!parts) return typeof tile === "string" ? tile : "—";
  return `${parts[0]}–${parts[1]}`;
}

/** `"7 tiles"` / `"1 tile"` — used for the opponent's count and the pile. */
export function tileCountLabel(count: unknown): string {
  const value = Number(count);
  const safe = Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  return `${safe} ${safe === 1 ? "tile" : "tiles"}`;
}

/**
 * The ends a tile may legally be attached to, from the PUBLIC open values.
 *
 * A double matches whichever end carries its value (and, on an empty chain,
 * either — see `playOptionsFor`). This is an affordance for the buttons; the
 * store re-validates every placement inside its transaction.
 */
export function legalEndsFor(tile: unknown, openEnds: OpenEnds): ChainEnd[] {
  const parts = tileParts(tile);
  if (!parts) return [];
  const [high, low] = parts;
  const ends: ChainEnd[] = [];
  const left = openEnds?.left;
  const right = openEnds?.right;
  if (typeof left === "number" && (high === left || low === left)) ends.push("left");
  if (typeof right === "number" && (high === right || low === right)) ends.push("right");
  return ends;
}

/** True while the chain has not been opened yet. */
export function isChainEmpty(chain: unknown): boolean {
  return !Array.isArray(chain) || chain.length === 0;
}

/**
 * Every tile in the viewer's hand that can be played right now, with the ends it
 * fits.
 *
 * An EMPTY CHAIN accepts the whole hand: the engine's opening move is any tile,
 * and the store normalises the end to `left`, so the board offers one "Play"
 * action for the opener rather than two identical ones.
 */
export function playOptionsFor(
  hand: readonly unknown[] | null | undefined,
  openEnds: OpenEnds,
  chainEmpty: boolean,
): { tile: string; ends: ChainEnd[] }[] {
  const tiles = Array.isArray(hand) ? hand : [];
  const options: { tile: string; ends: ChainEnd[] }[] = [];
  for (const tile of tiles) {
    if (typeof tile !== "string") continue;
    const ends = chainEmpty ? (["left"] as ChainEnd[]) : legalEndsFor(tile, openEnds);
    if (ends.length > 0) options.push({ tile, ends });
  }
  return options;
}

/** Does the viewer hold anything playable? */
export function hasPlayableTile(
  hand: readonly unknown[] | null | undefined,
  openEnds: OpenEnds,
  chainEmpty: boolean,
): boolean {
  return playOptionsFor(hand, openEnds, chainEmpty).length > 0;
}

/** One tile of a previewed chain, in exactly the shape the projection sends. */
export type PreviewChainTile = {
  id: string;
  end: ChainEnd;
  left: number;
  right: number;
  isDouble: boolean;
};

/** A prospective placement: the chain as it would read once the tile was laid. */
export type PlacementPreview = {
  /** The table's chain with the prospective tile in it. */
  chain: PreviewChainTile[];
  /** Where the prospective tile sits in `chain` (0 for a left play). */
  index: number;
  /** Whether the tile widens the line at its start or its end. */
  position: "prepend" | "append";
  /** The half facing each side of the line, as the engine would resolve it. */
  facing: { left: number; right: number };
  isDouble: boolean;
  /** The end the tile would be attached to. */
  end: ChainEnd;
};

/**
 * WHERE THE SELECTED TILE WOULD LAND — the chain as it would read once it was laid.
 *
 * Selecting a tile is a client-side idea: the player picks one up, the ends it fits
 * light up, and the table shows where it would go. That picture has to be the one
 * the server will produce, so the prospective entry is built here with the engine's
 * own conventions from the same public information the engine validates against:
 *
 *   * the aimed end and that end's open value (`openEnds`, falling back to the
 *     exposed half of the tile already sitting at that end);
 *   * the tile's two halves, one of which must BE that value;
 *   * the canonical id, the end it was attached to, the half facing each side of
 *     the line, and the double flag.
 *
 * The result is a chain in the projection's shape, so the caller can hand it to
 * `layoutChain` and draw the REAL geometry — a preview can never disagree with the
 * placement, because it is computed by the same function on the same shape.
 *
 * NOTHING IS SENT. An end the tile cannot meet returns `null`, which is what keeps
 * a ghost off an end the engine would refuse. The store still re-validates
owner-ship, pip match, turn, version and end inside its row lock.
 */
export function placementPreview(
  chain: readonly ChainTileLike[] | null | undefined,
  openEnds: OpenEnds,
  tile: unknown,
  end: ChainEnd,
): PlacementPreview | null {
  if (typeof tile !== "string") return null;
  const parts = tileParts(tile);
  if (!parts) return null;
  const [high, low] = parts;
  const isDouble = high === low;
  const line = Array.isArray(chain) ? chain : [];

  // The opening placement IS the chain's first tile: any tile, always recorded on
  // the left, and drawn with its canonical facing (the layout turns doubles).
  if (line.length === 0) {
    return {
      chain: [{ id: tile, end: "left", left: high, right: low, isDouble }],
      index: 0,
      position: "append",
      facing: { left: high, right: low },
      isDouble,
      end: "left",
    };
  }

  const wire = end === "left" ? openEnds?.left : openEnds?.right;
  const edge = (end === "left" ? line[0] : line[line.length - 1]) as
    | { left?: unknown; right?: unknown }
    | undefined;
  const fromEdge = edge?.[end];
  const open =
    typeof wire === "number" && Number.isFinite(wire)
      ? wire
      : typeof fromEdge === "number" && Number.isFinite(fromEdge)
        ? fromEdge
        : null;
  if (open === null) return null;

  // Which half meets the chain. A tile that carries neither value fits nothing.
  const mate = high === open ? low : low === open ? high : null;
  if (mate === null) return null;

  const facing =
    end === "left" ? { left: mate, right: open } : { left: open, right: mate };
  const laid: PreviewChainTile = {
    id: tile,
    end,
    left: facing.left,
    right: facing.right,
    isDouble,
  };
  const nextChain = (end === "left" ? [laid, ...line] : [...line, laid]) as PreviewChainTile[];

  return {
    chain: nextChain,
    index: end === "left" ? 0 : line.length,
    position: end === "left" ? "prepend" : "append",
    facing,
    isDouble,
    end,
  };
}

/**
 * Which non-play controls the server would accept.
 *
 * Exactly the engine's rule 6/7 pair, read off public information + the viewer's
 * own hand: with something playable you MUST play (neither button is offered);
 * with nothing playable you draw while the pile has tiles, and pass once it is
 * empty. The store enforces the same thing, so a stale tab gets a 409 and a
 * resync rather than a free turn.
 */
export function availableActions({
  hand,
  openEnds,
  chainEmpty,
  drawPileCount,
  isViewerTurn,
}: {
  hand: readonly unknown[] | null | undefined;
  openEnds: OpenEnds;
  chainEmpty: boolean;
  drawPileCount: unknown;
  isViewerTurn: boolean;
}): { canDraw: boolean; canPass: boolean; mustPlay: boolean } {
  if (!isViewerTurn) return { canDraw: false, canPass: false, mustPlay: false };
  const mustPlay = hasPlayableTile(hand, openEnds, chainEmpty);
  if (mustPlay) return { canDraw: false, canPass: false, mustPlay: true };
  const pile = Number(drawPileCount);
  const pileHasTiles = Number.isFinite(pile) && pile > 0;
  return { canDraw: pileHasTiles, canPass: !pileHasTiles, mustPlay: false };
}

/* -------------------------------------------------------------------------- *
 * The turn clock
 * -------------------------------------------------------------------------- */

/**
 * The visual countdown for a turn.
 *
 * PURELY presentational: the stamped instant is the server's (`turnDeadlineAt`)
 * and the enforcement is the server's (a late action is refused and the clock
 * acts). This function only says what to draw — `expired` means "stop counting
 * and show that the server is resolving it", NEVER "draw a tile for me".
 */
export function countdownFor(
  deadlineAt: unknown,
  nowMs: number,
): { seconds: number; remainingMs: number; expired: boolean; label: string } {
  const deadline = deadlineAt ? new Date(deadlineAt as string).getTime() : NaN;
  if (!Number.isFinite(deadline)) {
    return { seconds: 0, remainingMs: 0, expired: false, label: "—" };
  }
  const remainingMs = Math.max(0, deadline - nowMs);
  // Ceil so the first second of a 15s window reads "15", not "14".
  const seconds = Math.ceil(remainingMs / 1000);
  return {
    seconds,
    remainingMs,
    expired: remainingMs <= 0,
    label: remainingMs > 0 ? `${seconds}s` : "Time's up",
  };
}

/** Seconds played, for the result screen. */
export function durationSeconds(startedAt: unknown, endedAt: unknown): number | null {
  if (!startedAt || !endedAt) return null;
  const start = new Date(startedAt as string).getTime();
  const end = new Date(endedAt as string).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return Math.round((end - start) / 1000);
}

/* -------------------------------------------------------------------------- *
 * The action log
 * -------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------- *
 * The multi-round match: cumulative scoreboard and the round just closed
 * -------------------------------------------------------------------------- */

/** A cumulative score, normalised (a pre-rounds row has none). */
function scoreValue(value: unknown): number {
  const total = Number(value);
  return Number.isFinite(total) && total > 0 ? Math.floor(total) : 0;
}

/** The seat opposite `seat`, or null when the seat is unknown. */
function oppositeSeatOf(seat: Seat | null): Seat | null {
  if (seat === "player1") return "player2";
  if (seat === "player2") return "player1";
  return null;
}

/** The cumulative scoreboard, SEAT-RELATIVE: every number follows the server's seat. */
export type SeatScoreboard = {
  /** The round in progress (1-based). */
  round: number;
  /** Points needed to win the match. */
  target: number;
  viewerSeat: Seat | null;
  opponentSeat: Seat | null;
  viewerScore: number;
  opponentScore: number;
};

/**
 * Read the match scoreboard off the projection.
 *
 * `scores` are the match row's cumulative columns and `matchTarget` is the
 * engine's own constant, so the client prints server numbers and never adds a
 * round's points itself. A seat-relative read is what makes the same snapshot
 * render correctly for both players (and for a spectator-less guest).
 */
export function scoreboardFor(
  snapshot:
    | {
        viewerSeat?: Seat | null;
        opponentSeat?: Seat | null;
        scores?: { player1?: number | null; player2?: number | null } | null;
        matchTarget?: number | null;
        roundNumber?: number | null;
      }
    | null
    | undefined,
): SeatScoreboard {
  const viewerSeat = snapshot?.viewerSeat ?? null;
  const opponentSeat = snapshot?.opponentSeat ?? oppositeSeatOf(viewerSeat);
  const round = Number(snapshot?.roundNumber);
  const target = Number(snapshot?.matchTarget);
  const scoreFor = (seat: Seat | null): number => {
    if (!seat) return 0;
    return scoreValue(seat === "player1" ? snapshot?.scores?.player1 : snapshot?.scores?.player2);
  };
  return {
    round: Number.isFinite(round) && round >= 1 ? Math.floor(round) : 1,
    target: Number.isFinite(target) && target > 0 ? Math.floor(target) : 50,
    viewerSeat,
    opponentSeat,
    viewerScore: scoreFor(viewerSeat),
    opponentScore: scoreFor(opponentSeat),
  };
}

/** The just-closed round, as the viewer reads it. */
export type RoundResultView = {
  round: number;
  viewerPips: number;
  opponentPips: number;
  viewerPoints: number;
  opponentPoints: number;
  /** Who took the round; null when the points were level. */
  winner: "viewer" | "opponent" | null;
  /** Who opened the round now in progress (i.e. starts the next round). */
  nextStarter: "viewer" | "opponent" | null;
};

/**
 * The round-result announcement, or null when there is nothing to announce.
 *
 * ONLY a live series announces a round. `lastRound` is the store's public record
 * of the last COMPLETED round (pips and points at the close — never a hand), and
 * it is shown only while the round immediately after it is in progress. Once the
 * match is decided the verdict owns the screen, and the round transition is not
 * shown at all.
 */
export function roundResultFor(
  snapshot:
    | {
        status?: string | null;
        viewerSeat?: Seat | null;
        opponentSeat?: Seat | null;
        roundNumber?: number | null;
        previousStartingSeat?: Seat | null;
        lastRound?: {
          roundNumber?: number | null;
          player1Pips?: number | null;
          player2Pips?: number | null;
          player1Points?: number | null;
          player2Points?: number | null;
          winnerSeat?: string | null;
        } | null;
      }
    | null
    | undefined,
): RoundResultView | null {
  if (!snapshot || String(snapshot.status ?? "") !== MATCH_STATUS.PLAYING) return null;
  const last = snapshot.lastRound ?? null;
  const lastRound = Number(last?.roundNumber);
  const currentRound = Number(snapshot.roundNumber);
  if (!Number.isFinite(lastRound) || !Number.isFinite(currentRound)) return null;
  // Only the round that JUST closed is announced — an older history entry is not
  // news, and the round in progress is not finished.
  if (currentRound !== lastRound + 1) return null;

  const viewerSeat = snapshot.viewerSeat ?? null;
  const opponentSeat = snapshot.opponentSeat ?? oppositeSeatOf(viewerSeat);
  const relative = (seat: unknown): "viewer" | "opponent" | null => {
    const value = String(seat ?? "");
    if (value !== "player1" && value !== "player2") return null;
    if (!viewerSeat) return null;
    return value === viewerSeat ? "viewer" : "opponent";
  };
  const numberFor = (seat: Seat | null, field: "pips" | "points"): number => {
    if (!seat) return 0;
    const raw =
      field === "pips"
        ? seat === "player1"
          ? last?.player1Pips
          : last?.player2Pips
        : seat === "player1"
          ? last?.player1Points
          : last?.player2Points;
    return scoreValue(raw);
  };

  return {
    round: lastRound,
    viewerPips: numberFor(viewerSeat, "pips"),
    opponentPips: numberFor(opponentSeat, "pips"),
    viewerPoints: numberFor(viewerSeat, "points"),
    opponentPoints: numberFor(opponentSeat, "points"),
    winner: relative(last?.winnerSeat),
    nextStarter: relative(snapshot.previousStartingSeat),
  };
}

/**
 * One logged action (`dominoes_moves` row) as human copy.
 *
 * `timedOut` marks the clock's own action, so a turn the player lost to the
 * timer reads as such instead of looking like a decision they made.
 */
export function loggedActionLabel(entry: {
  action?: unknown;
  tile?: unknown;
  chainEnd?: unknown;
  timedOut?: unknown;
}): string {
  const timedOut = entry?.timedOut === true;
  const action = String(entry?.action ?? "");
  if (action === "play") {
    const side = String(entry?.chainEnd ?? "") === "right" ? "right" : "left";
    const label = `played ${tileLabel(entry?.tile)} on the ${side}`;
    return timedOut ? `the clock ${label}` : label;
  }
  if (action === "draw") {
    return timedOut ? "the clock drew a tile" : "drew a tile";
  }
  if (action === "pass") {
    return timedOut ? "the clock passed" : "passed";
  }
  return "—";
}
