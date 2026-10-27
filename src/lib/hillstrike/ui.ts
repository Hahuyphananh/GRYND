// src/lib/hillstrike/ui.ts
//
// Pure view-model helpers for the ONLINE Hillstrike surface (the lobby and the
// match view). Same role as `src/lib/barricade/ui.ts`: it turns the authoritative
// snapshot the server sends into the strings and verdicts the UI renders, and it
// owns no rule of the game.
//
// ── WHY THIS IS NOT THE RULES ENGINE ────────────────────────────────────
//
// Trajectories, collisions, damage, HP, the action order and victory all live in
// `./physics` and `./rules`, and they are executed by the server store. Nothing
// here may re-derive any of them: every function below is a formatter or a small
// guard over values the server already decided (the seat, the turn, both HP
// pools, the actions left, the winner, the reason, the version). That is what
// keeps a stale tab from being able to argue with the server about whose turn it
// is or who won.
//
// Like the engine, this module imports nothing from React/HTTP/DB, so the client
// bundle can share it with a Node test.

import { MATCH_STATUS } from "./constants";
import type { Seat } from "./types";
import { viewerOutcome } from "../results/viewerOutcome";

/** Match states that can never change again. */
const TERMINAL_MATCH_STATUSES = new Set<string>([
  MATCH_STATUS.FINISHED,
  MATCH_STATUS.CANCELLED,
]);

export function isTerminalStatus(status: unknown): boolean {
  return TERMINAL_MATCH_STATUSES.has(String(status ?? ""));
}

/** The seat's accent colour — the battlefield draws player1 cyan, player2 pink. */
export function seatColor(seat: Seat | null | undefined): string {
  return seat === "player2" ? "#ff4fd8" : "#00e5ff";
}

/** A seat's colour name, matching the copy the board and the practice page use. */
export function seatName(seat: Seat | null | undefined): string {
  return seat === "player2" ? "Magenta" : "Cyan";
}

/**
 * How to refer to a seat from the viewer's point of view: "You" for the seat the
 * caller holds, "Opponent" otherwise, falling back to the colour when the caller
 * has no seat at all (the page renders once before the snapshot lands).
 */
export function seatLabel(
  seat: Seat | null | undefined,
  viewerSeat: Seat | null | undefined,
): string {
  if (!seat) return "—";
  if (viewerSeat) return seat === viewerSeat ? "You" : "Opponent";
  return seatName(seat);
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
 * The turn banner. Every branch is driven by the server's own `isViewerTurn` and
 * `status` — never by the viewer's own shot submission.
 */
export function turnLabel({
  status,
  isViewerTurn,
  viewerSeat,
  opponentName,
  actionsRemaining,
  openingShotPending,
}: {
  status?: unknown;
  isViewerTurn?: boolean;
  viewerSeat?: Seat | null;
  opponentName?: string | null;
  actionsRemaining?: unknown;
  openingShotPending?: unknown;
}): string {
  const state = String(status ?? "");
  if (state === MATCH_STATUS.WAITING) return "Waiting for an opponent to join…";
  if (state === MATCH_STATUS.CANCELLED) return "This match was cancelled.";
  if (state === MATCH_STATUS.FINISHED) return "Match complete.";
  if (!viewerSeat) return "Loading the match…";

  const actions = Math.max(0, Number(actionsRemaining) || 0);
  const remaining = `${actions} action${actions === 1 ? "" : "s"} left`;
  if (isViewerTurn) {
    return openingShotPending
      ? `Your turn — the opening turn is a single action.`
      : `Your turn — ${remaining} in this turn.`;
  }
  return `${opponentName || "Your opponent"} is taking their turn…`;
}

/** A seat's remaining HP, from the server's `hp` map. */
export function hpFor(
  hp: Record<string, unknown> | null | undefined,
  seat: Seat | null | undefined,
): number {
  if (!seat || !hp) return 0;
  const value = Number(hp[seat]);
  return Number.isFinite(value) ? value : 0;
}

/**
 * The viewer's outcome, from the settled `result`/`winnerId`.
 *
 * DELEGATED to src/lib/results/viewerOutcome.ts — the platform's one verdict rule
 * — so Hillstrike answers "who won" exactly the way every other game does: from
 * the server's settled row, read against the seat the SERVER says the viewer
 * holds.
 */
export function outcomeFor({
  result,
  winnerId,
  viewerSeat,
  userId,
}: {
  result?: string | null;
  winnerId?: string | null;
  viewerSeat: Seat | null;
  userId?: string | null;
}): "win" | "loss" | null {
  const outcome = viewerOutcome({
    result,
    winnerId,
    viewerSeat,
    viewerId: userId,
  });
  return outcome === "draw" ? null : outcome;
}

/**
 * Monotonic-snapshot guard, copied from the other match views: several refreshes
 * (poll, socket push, post-shot resync) can be in flight at once, so an older
 * response must never roll the view back — and a same-version terminal snapshot
 * (a resignation racing a poll) must never be overwritten by a live one.
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

/**
 * The match clock as `m:ss`, from the milliseconds left on the server's deadline.
 *
 * Presentation only: the DEADLINE and the verdict are the server's (`durationMs`,
 * `deadlineAt`, and the `timeout` route). This function never decides that time
 * is up.
 */
export function clockLabel(ms: unknown): string {
  const remaining = Number(ms);
  const total = Number.isFinite(remaining) ? Math.max(0, Math.ceil(remaining / 1000)) : 0;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** Seconds between two instants, or null when either is unusable. */
export function durationSeconds(startedAt: unknown, endedAt: unknown): number | null {
  if (!startedAt || !endedAt) return null;
  const start = new Date(startedAt as string).getTime();
  const end = new Date(endedAt as string).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return Math.round((end - start) / 1000);
}

/**
 * Why the match ended, as a sentence. The server records the reason; the client
 * only names it (the engine itself produces `hp-depleted` or, when the clock runs
 * out, `timed-out` — which can be a draw).
 */
export function resultReasonLabel(
  reason: unknown,
  outcome: "win" | "loss" | "draw" | null,
): string {
  switch (String(reason ?? "")) {
    case "resigned":
      return outcome === "win"
        ? "Your opponent resigned the match."
        : "You resigned the match.";
    case "abandoned":
      return outcome === "win"
        ? "Your opponent left and did not return — the match was awarded to you."
        : "You left the match and did not return — it was awarded to your opponent.";
    case "timed-out":
      if (outcome === "draw") return "The clock ran out — level HP is a draw.";
      return "The clock ran out — the tank with more HP takes it.";
    case "hp-depleted":
      return outcome === "win"
        ? "You knocked out your opponent's tank."
        : "Your tank was knocked out.";
    // v1 (three-lives) rows only.
    case "lives-exhausted":
      return outcome === "win"
        ? "You knocked out every one of your opponent's lives."
        : "Your opponent knocked out all three of your lives.";
    default:
      return outcome === "win" ? "You won the match." : "Your opponent won the match.";
  }
}

/** One logged action (`hillstrike_shots` row) as human copy. */
export function loggedShotLabel(entry: {
  action?: unknown;
  angleDeg?: unknown;
  power?: unknown;
  impactKind?: unknown;
  damage?: unknown;
  livesLost?: unknown;
}): string {
  const kindAction = String(entry?.action ?? "shoot");
  if (kindAction === "move") return "drove the tank";
  if (kindAction === "build") return "placed a cover block";

  const angle = Number(entry?.angleDeg);
  const power = Number(entry?.power);
  const aim =
    entry?.angleDeg !== null &&
    entry?.power !== null &&
    Number.isFinite(angle) &&
    Number.isFinite(power)
      ? `${Math.round(angle)}° at ${Math.round(power)}%`
      : "shot";
  const kind = String(entry?.impactKind ?? "");
  const damage = Number(entry?.damage) || 0;
  const lives = Number(entry?.livesLost) || 0;
  if (damage > 0) return `${aim} — direct hit, −${damage} HP`;
  if (lives > 0) return `${aim} — direct hit, one life`;
  switch (kind) {
    case "block":
      return `${aim} — tower hit`;
    case "terrain":
      return `${aim} — ground hit`;
    case "out-of-bounds":
      return `${aim} — out of bounds`;
    case "timeout":
      return `${aim} — shot expired in flight`;
    default:
      return aim;
  }
}

/** "76 HP" for the seat cards. */
export function hpLabel(hp: unknown): string {
  const count = Number(hp);
  const safe = Number.isFinite(count) ? Math.max(0, Math.round(count)) : 0;
  return `${safe} HP`;
}
