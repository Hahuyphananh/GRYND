// ── View-model derivations for the Precision match page ──────────────────
//
// Everything here is PURE: it maps a `PrecisionState` server snapshot onto the
// small shapes the match page renders. No React, no fetch, no clock — which is
// what keeps the page's hooks thin, and lets these mappings be reasoned about
// (and unit-tested) without a browser.
//
// The per-round reveal, the arming recap board, the scoreboard badges and the
// end-of-match popup all read from the SAME derivations, so they can never
// disagree about which round just ended or where the rockets parked.

import type { RocketLane } from "../../components/precision/PrecisionRocketRace";
import type { PlayerSeat, PrecisionPlayer, PrecisionState } from "./types";

/** The running display clock's frozen value for the local seat. */
export type FrozenElapsedMs = number | null;

/** One round's decided telemetry, snapshotted for the reveal overlay. Values
 *  are SERVER-STAMPED (`recordRoundStop` in `serverStore.ts`) and rendered
 *  verbatim — the client never recomputes a diff. */
export interface RoundResultReveal {
  /** The target the decided round was graded against. */
  targetMs: number;
  seat1ElapsedMs: number;
  seat1DiffMs: number;
  seat2ElapsedMs: number;
  seat2DiffMs: number;
  /** 1 / 2, or null on a tie (the round is re-armed with a fresh target). */
  roundWinnerSeat: PlayerSeat | null;
  /** Stable signature used to debounce duplicate captures from broadcast +
   *  polling (the same round decision landing via both paths). */
  signature: string;
}

/** The per-seat telemetry a scoreboard needs for its rank badges. */
export interface RoundStopsSummary {
  seat1: { elapsedMs: number; diffMs: number };
  seat2: { elapsedMs: number; diffMs: number };
}

export interface RaceLanesOptions {
  /** true  → the arming recap of the last DECIDED round: both lanes parked at
   *          their server-stamped stops.
   *  false → the live round: the local seat parks at its frozen click value,
   *          the bot at its published `state.aiStop`, and a human opponent
   *          keeps flying (their stop is only revealed at resolution). */
  recap: boolean;
  state: PrecisionState | null;
  players: PrecisionPlayer[];
  localSeat: PlayerSeat;
  /** Elapsed ms the local player froze at when they hit STOP. */
  selfFrozenElapsedMs: FrozenElapsedMs;
  seat1Fallback: string;
  seat2Fallback: string;
}

/**
 * Identity of the last DECIDED round, derived ONLY from the decision itself
 * (the server-stamped stops + the winner). It deliberately does not include
 * `targetMs`, which flips `null → T` when the NEXT round opens: keying the
 * reveal on the decision is what keeps it tied to "a round just ended" instead
 * of "the phase changed". Returns null when no round has been decided or the
 * payload is half-written.
 */
export function decisionKeyOf(state: PrecisionState | null): string | null {
  const lr = state?.lastRoundStops;
  // Defensive shape check: this state arrives over a public GET endpoint, so a
  // malformed payload must never reach a `.elapsedMs` read and take the whole
  // match page down with it (a client-side render throw unmounts the page).
  if (!lr?.seat1 || !lr?.seat2) return null;
  return [
    lr.seat1.stopInstant,
    lr.seat1.elapsedMs,
    lr.seat2.stopInstant,
    lr.seat2.elapsedMs,
    state?.lastRoundWinnerSeat ?? "tie",
  ].join("|");
}

/**
 * Build the reveal payload for the last decided round, or null when there is
 * nothing to reveal (no decision yet / unusable target).
 *
 * The target comes from `lastRoundTargetMs` — stamped by the server WITH the
 * decision (see `applyRoundResult`) — so the reveal does not depend on this
 * client having observed the live round's `targetMs` first: a fresh mount,
 * a reconnect or a poll that landed after the round closed still gets the
 * popup. The live `targetMs` is only a fallback for older snapshots.
 */
export function buildRoundResultReveal(state: PrecisionState | null): RoundResultReveal | null {
  const signature = decisionKeyOf(state);
  const lr = state?.lastRoundStops;
  if (!signature || !lr?.seat1 || !lr?.seat2) return null;

  const targetMs =
    typeof state?.lastRoundTargetMs === "number"
      ? state.lastRoundTargetMs
      : typeof state?.targetMs === "number"
        ? state.targetMs
        : null;
  if (targetMs === null || !Number.isFinite(targetMs)) return null;

  return {
    targetMs,
    seat1ElapsedMs: lr.seat1.elapsedMs,
    seat1DiffMs: lr.seat1.diffMs,
    seat2ElapsedMs: lr.seat2.elapsedMs,
    seat2DiffMs: lr.seat2.diffMs,
    roundWinnerSeat: (state?.lastRoundWinnerSeat ?? null) as PlayerSeat | null,
    signature,
  };
}

/**
 * Normalised per-seat telemetry for the scoreboard's rank badges. Only built
 * when BOTH seats are present so a partial payload degrades to "no badges"
 * instead of throwing inside the scoreboard render.
 */
export function buildRoundStops(state: PrecisionState | null): RoundStopsSummary | null {
  const lr = state?.lastRoundStops;
  if (!lr?.seat1 || !lr?.seat2) return null;
  return {
    seat1: { elapsedMs: lr.seat1.elapsedMs, diffMs: lr.seat1.diffMs },
    seat2: { elapsedMs: lr.seat2.elapsedMs, diffMs: lr.seat2.diffMs },
  };
}

/**
 * The two rocket lanes, built per render (trivially cheap) and shared by the
 * live round (`recap: false`), the post-round arming recap (`recap: true`) and
 * the end-of-match popup.
 */
export function buildRaceLanes({
  recap,
  state,
  players,
  localSeat,
  selfFrozenElapsedMs,
  seat1Fallback,
  seat2Fallback,
}: RaceLanesOptions): [RocketLane, RocketLane] {
  const elapsedFor = (seat: PlayerSeat): number | null => {
    const key = seat === 1 ? "seat1" : "seat2";
    const recorded = state?.lastRoundStops?.[key]?.elapsedMs;
    if (recap) return typeof recorded === "number" ? recorded : null;
    if (seat === localSeat) return selfFrozenElapsedMs;
    if (seat === 2 && state?.isAiGame) {
      const ai = state?.aiStop?.elapsedMs;
      return typeof ai === "number" ? ai : null;
    }
    return null;
  };
  const seat1 = players.find((p) => p.seat === 1);
  const seat2 = players.find((p) => p.seat === 2);
  return [
    {
      seat: 1,
      name: seat1?.name ?? seat1Fallback,
      isSelf: localSeat === 1,
      frozenElapsedMs: elapsedFor(1),
    },
    {
      seat: 2,
      name: seat2?.name ?? seat2Fallback,
      isSelf: localSeat === 2,
      frozenElapsedMs: elapsedFor(2),
    },
  ];
}

/**
 * The live round's target, guarded on `typeof === "number"` rather than
 * `!== null`: a half-written payload that omits `targetMs` (undefined, not
 * null) would otherwise reach arithmetic on undefined and throw while the
 * match page's own render body is building its nodes — exactly the throw the
 * render-error boundary cannot catch from inside.
 */
export function liveTargetMsOf(state: PrecisionState | null): number | null {
  return typeof state?.targetMs === "number" ? state.targetMs : null;
}

/**
 * True when `next` is OLDER than what is already on screen.
 *
 * Every live source (the HTTP poll, the socket broadcasts) hands us a server
 * snapshot, and those responses can genuinely arrive OUT OF ORDER: the 500 ms
 * vs-AI cadence and the 250 ms post-countdown burst routinely leave two or
 * three `get-match` reads in flight, and the read that applies (and persists)
 * the round's transition is the slowest of them. Letting a late, older
 * response land after a newer one regressed the page to a round that had
 * already been decided — the timer kept running against the previous target
 * and the next round "never refreshed", so nobody could win it. The state
 * carries a monotonic `version`, so an older snapshot is dropped.
 */
export function isStaleSnapshot(
  current: PrecisionState | null | undefined,
  next: PrecisionState
): boolean {
  if (!current || current.matchId !== next.matchId) return false;
  const incoming = Number(next.version ?? 0);
  const held = Number(current.version ?? 0);
  return Number.isFinite(incoming) && Number.isFinite(held) && incoming < held;
}

/** sessionStorage key the lobby writes once it knows which seat we own. */
export const LOCAL_SEAT_STORAGE_KEY = "precision:localSeat";

/**
 * The seat this client owns, as written by the lobby page. Falls back to
 * seat 1 (the host) when storage is unavailable or never populated.
 */
export function readStoredLocalSeat(): PlayerSeat {
  if (typeof window === "undefined") return 1;
  try {
    return window.sessionStorage.getItem(LOCAL_SEAT_STORAGE_KEY) === "2" ? 2 : 1;
  } catch {
    return 1;
  }
}
