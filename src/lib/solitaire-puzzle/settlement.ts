// src/lib/solitaire-puzzle/settlement.ts
//
// PUZZLE RANKED SETTLEMENT — the platform's existing writers, one new key.
//
// There is NO puzzle-specific rating maths and NO puzzle-specific trophy
// economy here. A verified Puzzle Ranked result calls:
//
//   * `applyRatingResult` (src/lib/rating.js) with `gameKey: "solitaire-puzzle"`,
//     so Puzzle Ranked keeps an INDEPENDENT Elo row (Solitaire Duel's rating is
//     never read or written by this path);
//   * `applyTrophyResult` (src/lib/trophyStore.js) with the same key, on the
//     platform's existing ±30 duel ladder (opponent-count adjusted), which is
//     the "balanced reward formula based on the existing economy";
//   * the account W/L counters, exactly as Solitaire Duel does.
//
// IDEMPOTENCY: the caller invokes this inside the row-locked transaction that
// flips the session to `finished`. The status flip is the once-only guard, and
// both writers additionally journal per (user, game, match), so a replayed or
// concurrent settlement cannot award twice.
//
// NEVER SETTLED: practice/AI sessions, guest seats, cancelled searches, and a
// session without a verified terminal result.
//
// THE CLIENT CANNOT REACH THIS: no argument comes from a request body. The
// winner and both scores are read from the stored session snapshot.

import { eq, sql } from "drizzle-orm";

import { users } from "../../db/schema";
import { isGuestId } from "../guestIdentity";
import { recordCompetitiveResult } from "../competitiveStreak";
import { applyRatingResult } from "../rating";
import { applyTrophyResult } from "../trophyStore";
import {
  PUZZLE_RANKED_GAME_KEY,
  PUZZLE_SESSION_MODE,
  PUZZLE_SESSION_RESULT,
  PUZZLE_SESSION_STATUS,
} from "./constants";
import type { PuzzleReward, PuzzleSessionSnapshot } from "./types";

type Row = Record<string, unknown>;

function rowsOf(result: unknown): Row[] {
  if (Array.isArray(result)) return result as Row[];
  const rows = (result as { rows?: unknown })?.rows;
  return Array.isArray(rows) ? (rows as Row[]) : [];
}

/**
 * Record one settled Puzzle Ranked result.
 *
 * Best-effort exactly like every other game's settlement: a writer failure must
 * never fail (or roll back) the match that has already been decided. The
 * writers re-validate their own arguments and return `{ applied: false }` for
 * anything they refuse.
 */
export async function settlePuzzleRankedSession(
  tx: any,
  snapshot: PuzzleSessionSnapshot,
): Promise<void> {
  if (!tx) return;
  if (snapshot.mode !== PUZZLE_SESSION_MODE.RANKED) return;
  if (snapshot.isAi) return;
  if (snapshot.status !== PUZZLE_SESSION_STATUS.FINISHED) return;
  if (!snapshot.result) return;
  if (!snapshot.player2Id) return;
  if (snapshot.player1Id === snapshot.player2Id) return;
  // A guest has no `users` row, no rating and no trophies: a match with a guest
  // seat is unrated for BOTH participants (the shared writers enforce this too).
  if (isGuestId(snapshot.player1Id) || isGuestId(snapshot.player2Id)) return;

  const matchId = snapshot.id;

  if (snapshot.result === PUZZLE_SESSION_RESULT.DRAW) {
    await applyRatingResult({
      tx,
      gameKey: PUZZLE_RANKED_GAME_KEY,
      matchId,
      winnerClerkId: snapshot.player1Id,
      loserClerkId: snapshot.player2Id,
      result: "draw",
    }).catch(() => {});
    await applyTrophyResult({
      tx,
      gameKey: PUZZLE_RANKED_GAME_KEY,
      matchId,
      winnerClerkId: snapshot.player1Id,
      loserClerkId: snapshot.player2Id,
      result: "draw",
    }).catch(() => {});
    // A draw changes neither account's win/loss counter, but it DOES break a
    // ranked win streak for BOTH seats. The journaled writer is idempotent per
    // (match, user, game), so a duplicate settlement cannot reset twice.
    await recordCompetitiveResult({
      tx,
      clerkId: snapshot.player1Id,
      outcome: "draw",
      gameKey: PUZZLE_RANKED_GAME_KEY,
      matchId,
    });
    await recordCompetitiveResult({
      tx,
      clerkId: snapshot.player2Id,
      outcome: "draw",
      gameKey: PUZZLE_RANKED_GAME_KEY,
      matchId,
    });
    return;
  }

  const winnerId =
    snapshot.result === PUZZLE_SESSION_RESULT.PLAYER1
      ? snapshot.player1Id
      : snapshot.player2Id;
  const loserId =
    snapshot.result === PUZZLE_SESSION_RESULT.PLAYER1
      ? snapshot.player2Id
      : snapshot.player1Id;
  if (!winnerId || !loserId || winnerId === loserId) return;

  await tx
    .update(users)
    .set({ gamesWon: sql`${users.gamesWon} + 1` })
    .where(eq(users.clerkId, winnerId));
  await tx
    .update(users)
    .set({ gamesLost: sql`${users.gamesLost} + 1` })
    .where(eq(users.clerkId, loserId));

  // Ranked win streak — its own game key, journaled once per match.
  await recordCompetitiveResult({
    tx,
    clerkId: winnerId,
    outcome: "win",
    gameKey: PUZZLE_RANKED_GAME_KEY,
    matchId,
  });
  await recordCompetitiveResult({
    tx,
    clerkId: loserId,
    outcome: "loss",
    gameKey: PUZZLE_RANKED_GAME_KEY,
    matchId,
  });

  await applyRatingResult({
    tx,
    gameKey: PUZZLE_RANKED_GAME_KEY,
    matchId,
    winnerClerkId: winnerId,
    loserClerkId: loserId,
  }).catch(() => {});
  await applyTrophyResult({
    tx,
    gameKey: PUZZLE_RANKED_GAME_KEY,
    matchId,
    winnerClerkId: winnerId,
    loserClerkId: loserId,
  }).catch(() => {});
}

/**
 * The caller's own rating/trophy deltas for settled Puzzle Ranked sessions.
 *
 * Read from the journals the writers already maintain — the records are the
 * single source of truth, so nothing is duplicated onto the session row. A
 * missing journal row (writer not yet applied, guest seat) is reported as null
 * rather than as a fabricated zero.
 */
export async function readPuzzleRewards({
  tx,
  matchIds,
  clerkId,
}: {
  tx: any;
  matchIds: readonly string[];
  clerkId: string | null | undefined;
}): Promise<Record<string, PuzzleReward>> {
  const ids = [...new Set(matchIds.map((id) => String(id)).filter(Boolean))];
  if (!tx || !clerkId || ids.length === 0) return {};
  if (isGuestId(clerkId)) return {};

  const map: Record<string, PuzzleReward> = {};
  for (const id of ids) map[id] = { ratingDelta: null, trophiesDelta: null };

  const list = sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  );

  const applyRows = (rows: Row[], key: "ratingDelta" | "trophiesDelta") => {
    for (const row of rows) {
      const id = String(row.matchId ?? row.match_id ?? "");
      if (!map[id]) continue;
      const delta = Number(row.delta);
      if (Number.isFinite(delta)) map[id][key] = delta;
    }
  };

  try {
    const rating = await tx.execute(sql`
      SELECT match_id AS "matchId", delta
        FROM rating_events
       WHERE game_key = ${PUZZLE_RANKED_GAME_KEY}
         AND user_id = (SELECT id FROM users WHERE clerk_id = ${String(clerkId)})
         AND match_id IN (${list})
    `);
    applyRows(rowsOf(rating), "ratingDelta");
  } catch {
    // A journal read is presentation data; never fail the match payload for it.
  }

  try {
    const trophies = await tx.execute(sql`
      SELECT match_id AS "matchId", delta
        FROM trophy_events
       WHERE game_key = ${PUZZLE_RANKED_GAME_KEY}
         AND user_id = (SELECT id FROM users WHERE clerk_id = ${String(clerkId)})
         AND match_id IN (${list})
    `);
    applyRows(rowsOf(trophies), "trophiesDelta");
  } catch {
    // Same rule as above.
  }

  return map;
}
