/**
 * Crash Arena — Private Per-Hand Insights (signals)
 *
 * Every entered player is dealt exactly one private "insight" per hand: a
 * quality tier (strong / medium / weak) plus a claim about the crash zone.
 * The tier is drawn from a symmetric distribution (same rules for every
 * player — humans always draw 30/40/30), while each player's claim is drawn
 * independently so every seat sees a differently-drawn read each hand.
 *
 * Calibration (public, common knowledge, stable — shown in the client):
 *   strong ≈ 72%  of strong insights name the crash zone correctly
 *   medium ≈ 58%  of medium insights name it correctly
 *   weak   ≈ 46%  of weak insights name it correctly (barely above noise)
 *
 * Tiers are just *reliability*; the claim is what you act on:
 *   • crash under 2.5×            (low)
 *   • crash between 2.5× and 4.5× (mid-low)
 *   • crash between 4.5× and 6.5× (mid-high)
 *   • crash over 6.5×             (high)
 *
 * Reveal model: an insight is private while the hand runs, becomes public
 * the moment its owner folds, and every unrevealed insight is revealed at
 * the crash. Because the payout goes through FOLD ORDER (not tip accuracy),
 * a misplaced "strong" tip can still win you the pot if your early fold is
 * the last fold before the crash — the skill is reading and acting.
 *
 * This module is PURE (no node imports) so it is safe to run server-side
 * (deal + reveal) and client-side (render an insight / calibration check).
 */

// ── Types ─────────────────────────────────────────────────────────────────

export type SignalTier = "strong" | "medium" | "weak";

export type SignalArchetype = "low" | "midLow" | "midHigh" | "high";

/** A dealt insight. `claim` is the human-readable text of `archetype`. */
export interface CrashSignal {
  tier: SignalTier;
  /** The crash-zone the claim points at. */
  archetype: SignalArchetype;
  /** "crash under 2.5×" etc. */
  claim: string;
  /** Full line shown in the UI: e.g. "Insight: crash under 2.5× · strong". */
  text: string;
  /** The public calibration number for this tier (0–1). */
  accuracy: number;
}

/** Who a signal may be dealt to (seats only; humans + bot seats). */
export interface SignalTarget {
  userId: number;
  /** Bot seats draw from the difficulty-gated tier distribution. */
  isBot?: boolean;
  aiDifficulty?: string | null;
}

// ── Constants ─────────────────────────────────────────────────────────────

export const SIGNAL_CRASH_MIN = 1.2;
export const SIGNAL_CRASH_MAX = 9.2;

/**
 * Public calibration table — stable, shown in the rules + calibration views.
 * P(the claim names the true crash zone) for each tier.
 */
export const SIGNAL_TIER_ACCURACY: Record<SignalTier, number> = {
  strong: 0.72,
  medium: 0.58,
  weak: 0.46,
};

/** Symmetric deal odds for every HUMAN player (30/40/30). */
export const SIGNAL_TIER_WEIGHTS: Record<SignalTier, number> = {
  strong: 0.3,
  medium: 0.4,
  weak: 0.3,
};

/**
 * Difficulty-gated tier odds for BOT seats. Bots don't act on their
 * insight (their fold is a committed target), but the reveal everyone sees
 * when a bot folds is flavored by its difficulty: a hard bot draws
 * stronger reads than an easy bot. Weights sum to 1 per difficulty.
 */
export const BOT_SIGNAL_TIER_WEIGHTS: Record<string, Record<SignalTier, number>> = {
  easy: { strong: 0.1, medium: 0.3, weak: 0.6 },
  medium: { strong: 0.3, medium: 0.4, weak: 0.3 },
  hard: { strong: 0.4, medium: 0.45, weak: 0.15 },
};

const ARCHETYPES: SignalArchetype[] = ["low", "midLow", "midHigh", "high"];

// ── Pure helpers ──────────────────────────────────────────────────────────

/** The crash-zone archetype a multiplier falls in. */
export function archetypeOf(crashPoint: number): SignalArchetype {
  const c = Number(crashPoint);
  if (!Number.isFinite(c)) return "low";
  if (c < 2.5) return "low";
  if (c < 4.5) return "midLow";
  if (c < 6.5) return "midHigh";
  return "high";
}

/** Human-readable claim text for an archetype. */
export function archetypeClaim(a: SignalArchetype): string {
  switch (a) {
    case "low":
      return "crash under 2.5×";
    case "midLow":
      return "crash between 2.5× and 4.5×";
    case "midHigh":
      return "crash between 4.5× and 6.5×";
    case "high":
      return "crash over 6.5×";
    default:
      return "crash under 2.5×";
  }
}

/** Weighted random tier draw. weights default to the symmetric human odds. */
export function randomTier(weights: Record<SignalTier, number> = SIGNAL_TIER_WEIGHTS): SignalTier {
  const roll = Math.random();
  let acc = 0;
  for (const tier of ARCHETYPES_TIER_ORDER) {
    acc += weights[tier];
    if (roll < acc) return tier;
  }
  return "weak";
}

/** Tier order for iteration (matches the public table's display order). */
const ARCHETYPES_TIER_ORDER: SignalTier[] = ["strong", "medium", "weak"];

/** Tier weights for a signal target (bot difficulty gating, humans symmetric). */
export function tierWeightsFor(target: Pick<SignalTarget, "isBot" | "aiDifficulty">): Record<SignalTier, number> {
  if (target?.isBot) {
    const { aiDifficulty } = target;
    return (
      BOT_SIGNAL_TIER_WEIGHTS[aiDifficulty ?? "medium"] ??
      BOT_SIGNAL_TIER_WEIGHTS.medium
    );
  }
  return SIGNAL_TIER_WEIGHTS;
}

/**
 * Deal a single insight for a player.
 *
 * Construction keeps calibration honest: with probability `accuracy` the
 * claim names the TRUE crash zone; otherwise it mislabels uniformly across
 * the other three zones. This yields exactly the public P(claim correct)
 * per tier, with independently-drawn claims across players (distinct reads).
 *
 * @param crashPoint server-authoritative crash multiplier
 * @param tier       defaults to a symmetric-tier draw
 * @returns a fully-formed CrashSignal
 */
export function dealSignal(crashPoint: number, tier: SignalTier = randomTier()): CrashSignal {
  const accuracy = SIGNAL_TIER_ACCURACY[tier];
  const trueArchetype = archetypeOf(crashPoint);
  let archetype = trueArchetype;
  if (Math.random() >= accuracy) {
    const others = ARCHETYPES.filter((a) => a !== trueArchetype);
    archetype = others[Math.floor(Math.random() * others.length)];
  }
  const claim = archetypeClaim(archetype);
  return {
    tier,
    archetype,
    claim,
    text: `Insight: ${claim} · ${tier}`,
    accuracy,
  };
}

/**
 * Deal one insight to each seat that entered the hand. Humans draw from
 * the symmetric 30/40/30 distribution; bot seats from their difficulty's
 * distribution (so hard bots reveal stronger reads when they fold).
 *
 * @param targets    every entered player's seat (userId + bot flags)
 * @param crashPoint server-authoritative crash multiplier for the hand
 * @returns Map<userId, CrashSignal> — one entry per target
 */
export function dealSignals(targets: SignalTarget[], crashPoint: number): Map<number, CrashSignal> {
  const byUser = new Map<number, CrashSignal>();
  for (const t of targets) {
    byUser.set(t.userId, dealSignal(crashPoint, randomTier(tierWeightsFor(t))));
  }
  return byUser;
}

/** Whether a signal's claim actually covered the realized crash point. */
export function signalContainsCrash(signal: CrashSignal | null | undefined, crashPoint: number): boolean {
  if (!signal) return false;
  return signal.archetype === archetypeOf(crashPoint);
}