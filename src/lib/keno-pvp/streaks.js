// src/lib/keno-pvp/streaks.js
//
// Cosmetic streak tracking for the Keno SURVIVAL DUEL.
//
// A "streak" is how many resolved tiles IN A ROW one seat claimed. It is
// derived from the PUBLIC tile log — the same authoritative history the
// board and feed paint from — so:
//   * it can never disagree with the server (no local counter),
//   * a duplicated / re-delivered snapshot cannot advance it (the page keys
//     celebrations off the newest log entry's index),
//   * it has NO effect on lives, windows, targets or results. Nothing in this
//     module is imported by the stores or the engine; streaks are decoration
//     only.
//
// The milestones (5 / 10 / 15 in a row) are presentation thresholds. They
// never award anything competitive.

export const STREAK_MILESTONES = Object.freeze([5, 10, 15]);

/** Per-seat claimed flags for one log entry (legacy entries fall back to `outcome`). */
export function claimedFlags(entry) {
  if (!entry || typeof entry !== "object") return { p1: false, p2: false };
  const hasP1 = "p1Claimed" in entry;
  const hasP2 = "p2Claimed" in entry;
  if (hasP1 || hasP2) {
    return { p1: Boolean(entry.p1Claimed), p2: Boolean(entry.p2Claimed) };
  }
  const outcome = entry.outcome;
  return {
    p1: outcome === "player1" || outcome === "both_claim",
    p2: outcome === "player2" || outcome === "both_claim",
  };
}

/**
 * Current and best streaks for both seats, replayed from the public log.
 * `p1Run`/`p2Run` reset to 0 on any entry that seat did not claim.
 */
export function streakStats(log) {
  const rows = Array.isArray(log) ? log : [];
  let p1Run = 0;
  let p2Run = 0;
  let p1Best = 0;
  let p2Best = 0;
  for (const entry of rows) {
    const { p1, p2 } = claimedFlags(entry);
    p1Run = p1 ? p1Run + 1 : 0;
    p2Run = p2 ? p2Run + 1 : 0;
    if (p1Run > p1Best) p1Best = p1Run;
    if (p2Run > p2Best) p2Best = p2Run;
  }
  return { p1Run, p2Run, p1Best, p2Best };
}

/**
 * The milestones the NEWEST resolved tile just reached, if any:
 * `[{ seat: "p1" | "p2", count: 5 | 10 | 15 }]`.
 *
 * Exactly-hit only: a run of 6 is not a milestone (the 5 was already
 * celebrated when it happened). Both seats are checked, because both can
 * claim the same tile and both can be on a run.
 */
export function streakMilestoneAt(log) {
  const rows = Array.isArray(log) ? log : [];
  if (rows.length === 0) return [];
  const { p1Run, p2Run } = streakStats(rows);
  const hits = [];
  if (STREAK_MILESTONES.includes(p1Run)) hits.push({ seat: "p1", count: p1Run });
  if (STREAK_MILESTONES.includes(p2Run)) hits.push({ seat: "p2", count: p2Run });
  return hits;
}
