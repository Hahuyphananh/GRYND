// src/lib/mascot/glitchMoments.ts
//
// GLITCH OUTSIDE ONBOARDING — the two low-risk moments Stage 4 adds:
//
//   * one line under a match result (the only place GLITCH reacts to play)
//   * one hint per east session in the games hub
//
// Same split as glitchOnboarding.ts: the DECISION (which expression, which
// translation key, which event id) lives here so the result screen and the
// lobby cannot invent their own; the WORDS live in appTextTranslations under
// `glitch.*` (en / fr / es).
//
// NOTHING HERE IMPLIES A REWARD. The result copy describes the match only —
// no tokens, no prizes, no "you earned" — because the mascot never knows
// whether a reward was granted and must not guess. Rewards are stated by the
// result screen's own server-derived rows, never by the character.
//
// The event ids are STABLE strings: the provider refuses a repeated id within a
// session, which is what makes "never show the same lobby hint twice" a
// property of the id rather than of a component's memory.

import type { GlitchExpression } from "./glitchAssets";

export type GlitchMoment = {
  readonly expression: GlitchExpression;
  /** Dotted path into appTextTranslations. */
  readonly messageKey: string;
  /** Stable per-session event id (see glitchCadence.js). */
  readonly eventId: string;
};

/** The outcome shape PvpResultScreen already uses: "win" | "loss" | "draw". */
export type GlitchResultOutcome = "win" | "loss" | "draw" | string | null | undefined;

/**
 * GLITCH's reaction to a finished match.
 *
 * Victory → victory, defeat → defeat, and anything else (a draw, a missing
 * outcome, a future value) → the neutral `idle` face. That fallback is
 * deliberate: an unexpected state must never look like a celebration or a
 * consolation it has no reason to give.
 */
export function glitchResultMoment(outcome: GlitchResultOutcome): GlitchMoment {
  if (outcome === "win") {
    return {
      expression: "victory",
      messageKey: "glitch.result.victory",
      eventId: "result:win",
    };
  }
  if (outcome === "loss") {
    return {
      expression: "defeat",
      messageKey: "glitch.result.defeat",
      eventId: "result:loss",
    };
  }
  return {
    expression: "idle",
    messageKey: "glitch.result.draw",
    eventId: "result:neutral",
  };
}

// ── When a result screen is allowed to show GLITCH ────────────────────────
//
// NOT every result. A reaction that appears after every single match stops
// being a character and becomes part of the furniture, so the result screen
// asks this selector first. It is a strict priority ladder over data the
// result screen ALREADY has — no new field, no request, no randomness:
//
//   1. the player's first RATED match   (`overallElo.previousOverallElo` is null:
//                                       there was no rating before this one)
//   2. a completed progression tier     (`progress[].percent` has reached 100)
//   3. a rank improvement               (`rankDelta > 0`, a real server number)
//   4. an occasional reaction           (one win, one loss, one draw per session)
//
// Each step carries a STABLE event id, and an id already shown this session is
// skipped — so the ladder walks down to the next unshown reason, and once every
// reason in it has been used the screen is simply quiet. Deterministic: the
// same signals always produce the same answer, with no coin flips and no
// configuration to tune.

export const GLITCH_RESULT_EVENT_IDS = {
  firstRated: "result:first-rated",
  rankUp: "result:rank-up",
  firstWin: "result:first-win",
  firstLoss: "result:first-loss",
  neutral: "result:neutral",
  milestonePrefix: "result:milestone:",
} as const;

/** Shape of the only result-screen props this decision reads. */
export type GlitchResultSignals = {
  outcome?: string | null;
  /** The screen's own opt-out; `false` always wins. */
  showGlitch?: boolean;
  /** Creator Mode recording frame — never show GLITCH in one. */
  compact?: boolean;
  /** The result screen's explicit overall-Elo override, when a game passes it. */
  overallElo?: { previousOverallElo?: number | null; overallElo?: number | null } | null;
  /** Game-supplied progression rows. */
  progress?: ReadonlyArray<{ label?: string | null; percent?: number | null }> | null;
  /** Weekly-rank improvement, when the result carries one. */
  rankDelta?: number | null;
};

export type GlitchResultReactionReason =
  | "opted-out"
  | "compact"
  | "no-signal"
  | "first-rated"
  | "milestone"
  | "rank-up"
  | "occasional"
  | "duplicate";

export type GlitchResultReaction = {
  readonly show: boolean;
  readonly moment: GlitchMoment;
  readonly reason: GlitchResultReactionReason;
};

/** A stable, readable id for one completed progression tier. */
function milestoneEventId(label: unknown): string {
  const slug = String(label ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `${GLITCH_RESULT_EVENT_IDS.milestonePrefix}${slug || "tier"}`;
}

/**
 * Should this result show GLITCH, and with which line?
 *
 * `seenEventIds` is the session's list of ids that have already produced a
 * reaction — the result screen reads it from `sessionStorage`. Passing it in
 * keeps the whole decision pure and testable; nothing here touches storage.
 */
export function selectGlitchResultReaction(
  signals: GlitchResultSignals = {},
  { seenEventIds = [] }: { seenEventIds?: readonly string[] } = {}
): GlitchResultReaction {
  const {
    outcome,
    showGlitch = true,
    compact = false,
    overallElo = null,
    progress = null,
    rankDelta = null,
  } = signals;

  const base = glitchResultMoment(outcome);
  const blocked = (reason: GlitchResultReactionReason): GlitchResultReaction => ({
    show: false,
    moment: base,
    reason,
  });

  // The screen's own opt-out and Creator Mode come first: they are absolute.
  if (!showGlitch) return blocked("opted-out");
  if (compact) return blocked("compact");

  // A draw or an unexpected outcome gets the neutral face at most — never a
  // celebration or a consolation the data does not support.
  if (outcome !== "win" && outcome !== "loss" && outcome !== "draw") {
    return blocked("no-signal");
  }

  const candidates: Array<{
    eventId: string;
    reason: GlitchResultReactionReason;
  }> = [];

  // 1. First rated match: a rating exists now and did not exist before.
  const previous = overallElo?.previousOverallElo;
  const current = overallElo?.overallElo;
  if (
    typeof current === "number" &&
    (previous === null || previous === undefined)
  ) {
    candidates.push({ eventId: GLITCH_RESULT_EVENT_IDS.firstRated, reason: "first-rated" });
  }

  // 2. A progression tier that completed on this result.
  const completedTier = Array.isArray(progress)
    ? progress.find((row) => Number(row?.percent) >= 100)
    : null;
  if (completedTier) {
    candidates.push({ eventId: milestoneEventId(completedTier.label), reason: "milestone" });
  }

  // 3. A real weekly-rank improvement.
  if (typeof rankDelta === "number" && rankDelta > 0) {
    candidates.push({ eventId: GLITCH_RESULT_EVENT_IDS.rankUp, reason: "rank-up" });
  }

  // 4. The occasional reaction — one per outcome per session.
  candidates.push({
    eventId:
      outcome === "win"
        ? GLITCH_RESULT_EVENT_IDS.firstWin
        : outcome === "loss"
          ? GLITCH_RESULT_EVENT_IDS.firstLoss
          : GLITCH_RESULT_EVENT_IDS.neutral,
    reason: "occasional",
  });

  const seen = Array.isArray(seenEventIds) ? seenEventIds : [];
  const pick = candidates.find((candidate) => !seen.includes(candidate.eventId));
  if (!pick) return blocked("duplicate");

  return {
    show: true,
    moment: { ...base, eventId: pick.eventId },
    reason: pick.reason,
  };
}

/**
 * The lobby hint, chosen from the one piece of state the hub genuinely has:
 * has this player ever started a session?
 *
 *   has played before → idle   "Pick a game. I'll be watching."
 *   never played      → wink   "Practice first. Brag later."
 *
 * Two distinct, stable event ids mean a player who has played sees only the
 * first line, and a brand-new player sees only the second — never both, and
 * never the same one twice in a session.
 */
export function glitchLobbyMoment(playedBefore: boolean): GlitchMoment {
  return playedBefore
    ? {
        expression: "idle",
        messageKey: "glitch.lobby.pickGame",
        eventId: "lobby:has-history",
      }
    : {
        expression: "wink",
        messageKey: "glitch.lobby.practiceFirst",
        eventId: "lobby:no-history",
      };
}

/** Every key this module owns — asserted in all locales by the tests. */
export const GLITCH_MOMENT_KEYS = [
  "glitch.result.victory",
  "glitch.result.defeat",
  "glitch.result.draw",
  "glitch.lobby.pickGame",
  "glitch.lobby.practiceFirst",
] as const;

/**
 * Words the mascot must never use about a result: the character is not a
 * source of truth about rewards, and implying one would be a lie whenever the
 * server granted nothing. Checked by tests against every locale.
 */
export const GLITCH_FORBIDDEN_RESULT_WORDS = [
  "token",
  "jeton",
  "ficha",
  "reward",
  "récompense",
  "recompensa",
  "prize",
  "prix",
  "premio",
  "coin",
  "pièce",
  "moneda",
  "earn",
  "gagne",
  "gana",
] as const;
