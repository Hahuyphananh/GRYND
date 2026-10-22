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

/** A seat key, as the API spells it. */
export type Seat = "player1" | "player2";

/** A chain end. */
export type ChainEnd = "left" | "right";

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
