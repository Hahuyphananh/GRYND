// src/lib/hexTroopAnimation.ts
//
// Pure data + maths for Hex Duel's troop-movement animations.
//
// THIS IS PRESENTATION ONLY. The engine/server decide every result; this module
// merely describes what the board should draw for an action that already
// happened. It never mutates state and never decides a winner:
//
//   buildTroopMoveEvent    — snapshot of the action: pre-action armies, the
//                            authoritative outcome and the final ownership
//   buildTroopAnimationPlan— how many dots to draw and for how long
//   travelPoint            — position along a curved source→destination path
//   dotFormationPoint      — position of dot N in a compact 10-column cluster

import {
  TERRITORY_LEVELS,
  otherPlayer,
  type AttackOutcome,
  type DuelPlayer,
} from "./hex-duel/rules";

export type MoveOutcomeKind = "conquer" | "tie" | "failed" | "displace";

/** Everything the board needs to animate one action, built from PRE state. */
export interface TroopMoveEvent {
  /** Monotonic id — a new id is what starts a new animation. */
  id: number;
  kind: "attack" | "displace";
  actor: DuelPlayer;
  fromKey: string;
  toKey: string;
  /** Troops the action sent (the authoritative payload). */
  sent: number;
  /** Source troops BEFORE the action. */
  preSource: number;
  /** Destination troops BEFORE the action. */
  preTarget: number;
  /** Destination owner BEFORE the action (null = neutral). */
  preOwner: DuelPlayer | null;
  outcome: MoveOutcomeKind;
  /** Attacking troops left standing on the destination (conquest only). */
  survivors: number;
  /** Defenders left after combat. */
  defenderAfter: number;
  /** Whether the destination changed hands to the actor. */
  conquered: boolean;
  /** Whether the destination was the enemy capital. */
  capital: boolean;
  /** Destination owner AFTER the action (null = neutral). */
  postOwner: DuelPlayer | null;
}

export type TroopMoveEventBody = Omit<TroopMoveEvent, "id">;

export interface BuildTroopMoveEventArgs {
  kind: "attack" | "displace";
  actor: DuelPlayer;
  fromKey: string;
  toKey: string;
  sent: number;
  /** The board immediately BEFORE the action was applied. */
  board: {
    capturedTiles: Record<string, DuelPlayer>;
    tileTroops: Record<string, number>;
  };
  /** The authoritative combat result (attack only). */
  outcome?: AttackOutcome;
  capitals?: Record<string, DuelPlayer>;
}

/**
 * Snapshot a resolved action for the animation layer. Reads pre-action numbers
 * from `board` and the result from `outcome`; it invents nothing.
 */
export function buildTroopMoveEvent(args: BuildTroopMoveEventArgs): TroopMoveEventBody {
  const { kind, actor, fromKey, toKey, sent, board, outcome, capitals } = args;
  const preSource = board.tileTroops[fromKey] ?? 1;
  const preTarget = board.capturedTiles[toKey] ? board.tileTroops[toKey] ?? 1 : 0;
  const preOwner = board.capturedTiles[toKey] ?? null;

  if (kind === "displace" || !outcome) {
    return {
      kind,
      actor,
      fromKey,
      toKey,
      sent,
      preSource,
      preTarget,
      preOwner,
      outcome: "displace",
      survivors: 0,
      defenderAfter: preTarget,
      conquered: false,
      capital: false,
      postOwner: preOwner,
    };
  }

  const capital = capitals?.[toKey] === otherPlayer(actor);

  if (outcome.kind === "conquer") {
    return {
      kind,
      actor,
      fromKey,
      toKey,
      sent,
      preSource,
      preTarget,
      preOwner,
      outcome: "conquer",
      // The reducer caps survivors at the level-1 ceiling of a new conquest.
      survivors: Math.min(
        Math.max(0, outcome.remainingTroops),
        TERRITORY_LEVELS[1].maxTroops,
      ),
      defenderAfter: 0,
      conquered: true,
      capital: Boolean(capital || outcome.conqueredCapital),
      postOwner: actor,
    };
  }

  if (outcome.kind === "tie") {
    return {
      kind,
      actor,
      fromKey,
      toKey,
      sent,
      preSource,
      preTarget,
      preOwner,
      outcome: "tie",
      survivors: 0,
      defenderAfter: 0,
      conquered: false,
      capital: Boolean(capital),
      postOwner: null,
    };
  }

  return {
    kind,
    actor,
    fromKey,
    toKey,
    sent,
    preSource,
    preTarget,
    preOwner,
    outcome: "failed",
    survivors: 0,
    defenderAfter: Math.max(0, outcome.newDefenderTroops),
    conquered: false,
    capital: Boolean(capital),
    postOwner: outcome.defenderWipedOut ? null : preOwner,
  };
}

// ── Animation plan ─────────────────────────────────────────────────────────

/** Hard caps so a 100-troop army never floods the board with particles. */
export const MAX_ATTACKER_DOTS = 40;
export const MAX_DEFENDER_DOTS = 30;

export const ATTACK_ANIMATION_MS = 900;
export const DISPLACE_ANIMATION_MS = 650;

export interface TroopAnimationPlan {
  attackerDots: number;
  defenderDots: number;
  /** Attacking dots that settle on the conquered tile at the end. */
  survivorDots: number;
  durationMs: number;
  /** Normalised time (0..1) of the clash / arrival. */
  clashAt: number;
  /** True when nothing should be drawn (reduced motion or no troops). */
  skipped: boolean;
}

export interface TroopAnimationOptions {
  maxAttackers?: number;
  maxDefenders?: number;
  durationMs?: number;
  reducedMotion?: boolean;
}

export function buildTroopAnimationPlan(
  event: TroopMoveEvent,
  options: TroopAnimationOptions = {},
): TroopAnimationPlan {
  const maxAttackers = options.maxAttackers ?? MAX_ATTACKER_DOTS;
  const maxDefenders = options.maxDefenders ?? MAX_DEFENDER_DOTS;
  const reducedMotion = options.reducedMotion ?? false;
  const durationMs =
    options.durationMs ??
    (event.kind === "displace" ? DISPLACE_ANIMATION_MS : ATTACK_ANIMATION_MS);

  if (reducedMotion || event.sent <= 0) {
    return {
      attackerDots: 0,
      defenderDots: 0,
      survivorDots: 0,
      durationMs: 0,
      clashAt: 0.5,
      skipped: true,
    };
  }

  const attackerDots = Math.min(
    Math.max(0, Math.floor(event.sent)),
    Math.max(1, maxAttackers),
  );
  const defenderDots =
    event.kind === "attack"
      ? Math.min(Math.max(0, Math.floor(event.preTarget)), Math.max(1, maxDefenders))
      : 0;

  let survivorDots = 0;
  if (event.kind === "attack" && event.conquered && event.survivors > 0) {
    // Draw survivors proportionally to the dots on screen, never more than the
    // dots flying, and always at least one when troops really survived.
    const ratio = event.survivors / Math.max(1, event.sent);
    survivorDots = Math.min(
      attackerDots,
      Math.max(1, Math.round(attackerDots * ratio)),
    );
  }

  return {
    attackerDots,
    defenderDots,
    survivorDots,
    durationMs,
    clashAt: event.kind === "displace" ? 0.82 : 0.5,
    skipped: false,
  };
}

// ── Geometry ───────────────────────────────────────────────────────────────

export interface Point {
  x: number;
  y: number;
}

export const clamp01 = (n: number) =>
  !Number.isFinite(n) ? 0 : Math.min(1, Math.max(0, n));

/** Cubic ease-out for arrivals. */
export const easeOut = (t: number) => 1 - Math.pow(1 - clamp01(t), 3);

/**
 * Point at `t` (0..1) along a quadratic curve from `from` to `to`, bowed by
 * `arc` pixels perpendicular to the straight line. `t=0` is exactly `from`,
 * `t=1` is exactly `to`.
 */
export function travelPoint(from: Point, to: Point, t: number, arc = 0): Point {
  const p = clamp01(t);
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy) || 1;
  const px = -dy / length;
  const py = dx / length;
  const control = {
    x: (from.x + to.x) / 2 + px * arc,
    y: (from.y + to.y) / 2 + py * arc,
  };
  const it = 1 - p;
  return {
    x: it * it * from.x + 2 * it * p * control.x + p * p * to.x,
    y: it * it * from.y + 2 * it * p * control.y + p * p * to.y,
  };
}

/**
 * Position of dot `index` in a compact `columns`-wide formation centred on
 * `(cx, cy)`. Rows are centred independently so a short last row stays tidy.
 */
export function dotFormationPoint(
  index: number,
  count: number,
  cx: number,
  cy: number,
  spacing: number,
  columns = 10,
): Point {
  const total = Math.max(1, Math.floor(count));
  const cols = Math.max(1, Math.min(Math.floor(columns), total));
  const rows = Math.ceil(total / cols);
  const row = Math.floor(index / cols);
  const col = index % cols;
  const inRow = Math.min(cols, total - row * cols);
  return {
    x: cx + (col - (inRow - 1) / 2) * spacing,
    y: cy + (row - (rows - 1) / 2) * spacing,
  };
}

/** Colour of a seat's army, matching the board's existing palette. */
export function actorColor(player: DuelPlayer): string {
  return player === "player1" ? "#22d3ee" : "#ef4444";
}
