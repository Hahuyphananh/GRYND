// src/lib/prestige.js
//
// Permanent Prestige system layered ON TOP of the permanent Battle Pass.
//
// The Battle Pass remains the normal progression system (Level 1 → 100 via
// XP). Once a player reaches the permanent Level 100 cap (xp >= 63360) they
// become eligible for Prestige. Prestige is a SEPARATE long-term track:
//
//   Prestige 0 → 1 → 2 → … → 10
//
// It is NOT Battle Pass XP and NEVER raises the Battle Pass level. Reaching a
// Prestige tier preserves Level 100, XP, rewards, titles, and cosmetics.
//
// Rules (all enforced here, server-side only):
//   * A player below Level 100 cannot gain Prestige net wins.
//   * Level 100: win → net_wins + 1, loss → net_wins - 1.
//   * prestige_net_wins is clamped to >= 0.
//   * When net_wins meets the current tier's requirement the tier
//     increments by 1 and net_wins resets to 0.
//   * prestige_level is monotonic — a loss can reduce progress toward the
//     next tier but can NEVER remove an already-earned tier.
//   * Prestige values are NEVER accepted from the client. Progress originates
//     exclusively from authoritative server-side game settlement, which
//     passes this module a `source` + authoritative `sourceId`; the
//     `prestige_results` journal (migration 0136) makes every event
//     idempotent so duplicate / retried / concurrent settlements of the same
//     match can never award progress twice.
//
// Callers inside a game settlement transaction pass their `tx` so the journal
// insert + users update commit atomically with the result-processing flow.

import { sql } from "drizzle-orm";
import { getBattlepassProgress } from "./battlepass";
import { db } from "../db";

// Net wins required to advance FROM Prestige N to Prestige N+1 (index N).
// Centralized here — API/UI code must read from this module, never hardcode.
export const PRESTIGE_REQUIREMENTS = Object.freeze([
  25, // Prestige 1
  50, // Prestige 2
  100, // Prestige 3
  175, // Prestige 4
  275, // Prestige 5
  400, // Prestige 6
  550, // Prestige 7
  725, // Prestige 8
  900, // Prestige 9
  1100, // Prestige 10
]);

/** Highest earnable Prestige tier (additional tiers can be appended later). */
export const MAX_PRESTIGE_LEVEL = PRESTIGE_REQUIREMENTS.length;

/** Valid journal source keys (game keys that feed Prestige). */
const SOURCE_REGEX = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** Net wins required to advance FROM `prestigeLevel` to the next tier (null when maxed). */
export function prestigeRequirementForLevel(prestigeLevel) {
  const level = Math.max(0, Math.floor(Number(prestigeLevel) || 0));
  return level < PRESTIGE_REQUIREMENTS.length
    ? PRESTIGE_REQUIREMENTS[level]
    : null;
}

/**
 * Pure transition math used by applyPrestigeResult (exported for tests).
 * Returns the post-result { level, netWins, delta }.
 *  - outcome "draw" never changes state.
 *  - ineligible (below Level 100) players never change state.
 *  - a loss can never reduce level; net wins floor at 0.
 *  - `requirementMultiplier` (membership Prestige perk, 1 by default) lowers
 *    the effective net-wins requirement: effReq = ceil(req / multiplier).
 *    High Rollers progress ~20% faster — progression, never gameplay odds.
 */
export function computePrestigeTransition({
  prestigeLevel = 0,
  prestigeNetWins = 0,
  outcome,
  eligible,
  requirementMultiplier = 1,
}) {
  const level = Math.max(0, Math.floor(Number(prestigeLevel) || 0));
  const netWins = Math.max(0, Math.floor(Number(prestigeNetWins) || 0));

  if (outcome === "draw" || !eligible) {
    return { level, netWins, delta: 0 };
  }

  if (outcome === "win") {
    if (level >= MAX_PRESTIGE_LEVEL) return { level, netWins, delta: 0 };
    const rawRequirement = PRESTIGE_REQUIREMENTS[level];
    const multiplier = Math.max(1, Number(requirementMultiplier) || 1);
    const requirement =
      multiplier > 1 ? Math.ceil(rawRequirement / multiplier) : rawRequirement;
    const next = netWins + 1;
    if (next >= requirement) {
      // Tier up: level +1, progress resets to 0 (single +1 steps always
      // land exactly on the requirement, mirroring the 24/25 → 0/50 model).
      return { level: level + 1, netWins: 0, delta: 1 };
    }
    return { level, netWins: next, delta: 1 };
  }

  if (outcome === "loss") {
    const next = Math.max(0, netWins - 1);
    return { level, netWins: next, delta: netWins > 0 ? -1 : 0 };
  }

  // Unknown outcome — defensive no-op (never mutate on bad input).
  return { level, netWins, delta: 0 };
}

/**
 * Pure read-shape helper for APIs/UI. Never trusts stored prestige values to
 * exceed the config, and marks prestige as unlocked only for Level-100
 * players (Battle Pass level derived from XP, like every display path).
 */
export function getPrestigeStatus({ prestigeLevel = 0, prestigeNetWins = 0, xp = 0 }) {
  const progress = getBattlepassProgress(xp);
  const level = Math.max(
    0,
    Math.min(MAX_PRESTIGE_LEVEL, Math.floor(Number(prestigeLevel) || 0)),
  );
  const netWins = Math.max(0, Math.floor(Number(prestigeNetWins) || 0));
  const requirement = prestigeRequirementForLevel(level);
  const unlocked = progress.level >= 100;
  const maxed = requirement === null;
  const nextPrestigeRequirement = maxed ? 0 : requirement;
  const prestigeProgressPercent = maxed
    ? 100
    : requirement > 0
      ? Math.min(100, Math.floor((netWins / requirement) * 100))
      : 0;

  return {
    prestige: level,
    prestigeNetWins: netWins,
    nextPrestigeRequirement,
    prestigeProgressPercent,
    prestigeUnlocked: unlocked,
    maxPrestige: MAX_PRESTIGE_LEVEL,
  };
}

/**
 * Server-authoritative resolution of the equippable "Prestige N" badge.
 * Every read path (public profile, chat, profile header) calls this instead
 * of trusting client-supplied text. The badge resolves ONLY when all of:
 *   - the player opted in via users.show_prestige_badge, and
 *   - they reached the permanent Level 100 cap (XP-derived), and
 *   - they actually earned at least Prestige 1 (a "Prestige 0" badge is
 *     meaningless and is never shown).
 * Returns the display label (e.g. "Prestige 5") or null.
 */
export function resolvePrestigeBadge({ xp = 0, prestigeLevel = 0, showPrestigeBadge = false }) {
  if (!showPrestigeBadge) return null;
  const status = getPrestigeStatus({
    prestigeLevel,
    prestigeNetWins: 0,
    xp,
  });
  if (!status.prestigeUnlocked || status.prestige < 1) return null;
  return `Prestige ${status.prestige}`;
}

/**
 * Apply one authoritative server-side game result to a player's Prestige.
 *
 * @param {object} params
 * @param {string} params.clerkId     app user clerk id (winner or loser)
 * @param {"win"|"loss"|"draw"} params.outcome
 * @param {string} params.source      game key, e.g. "mines-pvp"
 * @param {string} params.sourceId    authoritative match id in that game
 * @param {import("drizzle-orm/node-postgres").PgTransaction} [params.tx]
 *        the caller's settlement transaction — when provided the journal
 *        insert + users update commit atomically with the settlement.
 *
 * @returns {Promise<{applied: boolean, reason?: string, delta: number,
 *          prestigeLevel?: number, prestigeNetWins?: number, eligible?: boolean}>}
 *
 * Idempotency: (user_id, source, source_id) is unique in prestige_results.
 * The row is claimed with ON CONFLICT DO NOTHING inside the same transaction
 * that updates the user, so two concurrent settlements of the same match
 * serialize on the users row lock and only the first can ever apply.
 *
 * This function never throws for expected inputs — callers run it as a
 * best-effort side effect, mirroring the gamesWon/gamesLost bumps.
 */
export async function applyPrestigeResult({ clerkId, outcome, source, sourceId, tx }) {
  if (!clerkId) return { applied: false, reason: "missing-clerk", delta: 0 };
  if (outcome !== "win" && outcome !== "loss" && outcome !== "draw") {
    return { applied: false, reason: "invalid-outcome", delta: 0 };
  }
  const gameKey = String(source || "");
  const eventId = String(sourceId ?? "");
  if (!SOURCE_REGEX.test(gameKey) || !eventId || eventId.length > 128) {
    return { applied: false, reason: "invalid-source", delta: 0 };
  }

  // NOTE on the query style used below: drizzle's `execute()` takes exactly
  // ONE argument — `execute("… $1 …", [param])` silently DROPS the params and
  // sends `$1` unbound, which Postgres rejects ("there is no parameter $1").
  // Because this runs inside the caller's settlement transaction, that error
  // poisons it: every later statement fails and the COMMIT becomes a silent
  // ROLLBACK, so the whole settlement was discarded. Always bind through a
  // `sql` template, and read rows off `.rows` (the node-postgres driver
  // returns the full QueryResult, not an array of rows).
  const run = async (txc) => {
    // Row-lock the player so concurrent settlements serialize: each sees the
    // previous one's committed values (never double-applies).
    const userRes = await txc.execute(sql`
      SELECT id, xp, prestige_level AS "prestigeLevel",
             prestige_net_wins AS "prestigeNetWins"
        FROM users
       WHERE clerk_id = ${clerkId}
       FOR UPDATE
    `);
    const user = userRes.rows[0];
    if (!user) return { applied: false, reason: "user-not-found", delta: 0 };

    const eligible = getBattlepassProgress(Number(user.xp) || 0).level >= 100;
    // High Roller membership perk: faster prestige progression (pure
    // progression — never gameplay odds). Resolved here so the transition math
    // and the journal row both reflect the correct requirement.
    const { getPrestigeMultiplierByClerkId } = await import(
      "./stripe/subscriptions"
    );
    const requirementMultiplier = eligible
      ? await getPrestigeMultiplierByClerkId(clerkId)
      : 1;
    const next = computePrestigeTransition({
      prestigeLevel: Number(user.prestigeLevel) || 0,
      prestigeNetWins: Number(user.prestigeNetWins) || 0,
      outcome,
      eligible,
      requirementMultiplier,
    });

    // Claim the event BEFORE mutating state. If another settlement for this
    // same (user, source, sourceId) already ran (retry, reconnect, double
    // processing, concurrent request), the conflict short-circuits here.
    const claimed = await txc.execute(sql`
      INSERT INTO prestige_results
        (user_id, source, source_id, outcome, delta,
         prestige_level_after, prestige_net_wins_after)
      VALUES (${user.id}, ${gameKey}, ${eventId}, ${outcome}, ${next.delta},
              ${next.level}, ${next.netWins})
      ON CONFLICT (user_id, source, source_id) DO NOTHING
      RETURNING id
    `);
    if (!claimed.rows.length) return { applied: false, reason: "duplicate", delta: 0 };

    if (next.delta !== 0) {
      await txc.execute(sql`
        UPDATE users
           SET prestige_level = ${next.level},
               prestige_net_wins = ${next.netWins}
         WHERE id = ${user.id}
      `);
    }

    return {
      applied: true,
      delta: next.delta,
      prestigeLevel: next.level,
      prestigeNetWins: next.netWins,
      eligible,
    };
  };

  return tx ? run(tx) : db.transaction(run);
}
