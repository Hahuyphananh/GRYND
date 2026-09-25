import { eq, inArray, or } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { db } from "../../db/client";
import {
  blackjackGames,
  blackjackPvpMatches,
  chatMessages,
  chessGames,
  chessMoves,
  fourInARowGames,
  crashGames,
  diceFlushActions,
  diceFlushPlayers,
  diceFlushRooms,
  diceLobbies,
  diceMatches,
  dicePlayerStats,
  dotsAndBoxesGames,
  emailEvents,
  hexDuelActions,
  hexDuelGames,
  kenoPvpMatches,
  keno_games,
  laneRunnerGames,
  laneRunnerPvpMatches,
  laneRushDuelMatches,
  memoryGridMatches,
  minesGames,
  minesPvpMatches,
  oddsGames,
  plinkoGames,
  plinkoPvpMatches,
  playerReports,
  pokerGames,
  poolLobbies,
  poolMatches,
  poolPlayerStats,
  poolShots,
  precisionMatches,
  rouletteGames,
  roulettePvpMatches,
  rpsGames,
  rpsPvpGames,
  stripeCheckoutSessions,
  towerArenaMatches,
  towerArenaPlayers,
  unoGames,
  userAutomationState,
  userLoginRewards,
  userPresence,
  users,
} from "../../db/schema";

/**
 * Placeholder that replaces a deleted user's clerk id in records that
 * must be kept but can no longer reference the erased account (reports
 * filed against them). Real Clerk ids are always `user_...`, so this
 * sentinel can never collide with a live account.
 */
const DELETED_USER_SENTINEL = "[deleted]";

// Tables the purge touches whose existence can't be guaranteed (schema
// drift: a table referenced by this module may not exist on a given
// database — e.g. lane_runner_pvp_matches was never created on prod). A
// DELETE against a missing table throws `relation ... does not exist`
// inside the transaction and rolls back the whole purge, so the purge
// must skip deletes for tables that aren't actually present.
let existingTables: Set<string> | null = null;

async function getExistingTables(): Promise<Set<string>> {
  if (existingTables) return existingTables;
  const { rows } = await db.execute(sql`
    SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = 'public'
  `);
  existingTables = new Set(rows.map((r: any) => r.tablename));
  return existingTables;
}

/**
 * Deletes (or anonymizes) every local DB row belonging to a user, given
 * their Clerk id.
 *
 * The `users` row delete cascades to all tables with an integer FK to
 * `users.id` (stats, friends, titles, daily streaks, crash arena entries,
 * etc.). The one non-cascading integer FK (`user_login_rewards`) and the
 * solo-game tables whose integer `user_id` has no FK at all
 * (`uno_games`, `blackjack_games`, `keno_games`, ...) are deleted
 * explicitly here.
 *
 * PvP match history stores players as varchar Clerk ids with no FK
 * (`player1_id` / `player2_id`), so every match a deleted user took part
 * in is purged explicitly. `poker_games` embeds Clerk ids inside its
 * `players` / `player_positions` jsonb — those rows are scrubbed rather
 * than deleted because the same game can legitimately contain players
 * who were never deleted.
 *
 * Ratings: `player_ratings` / `rating_events` are keyed by `users.id`
 * and cascade with the account, so they ARE erased here. The anti-reset
 * ladder `rating_identities` (migration 0171) is deliberately NOT touched:
 * it is keyed by a hash of the account's normalized email rather than by
 * user id, holds no directly identifying data, and exists precisely so a
 * deleted-and-recreated account cannot reset its per-game Elo rating or
 * restart its provisional match window. Deleting it would reopen that
 * abuse — do not add it to this purge.
 *
 * Moderation records are handled deliberately:
 *  - player_reports the user FILED are deleted — the complaint text is
 *    their own personal data.
 *  - player_reports filed AGAINST them are kept (other users' evidence
 *    of misconduct must not vanish because the reported party deleted
 *    their account) but the reported clerk id is replaced with a
 *    sentinel so the erased identity is not stored.
 *  - admin_audit_logs are kept fully intact — audit trails are retained
 *    for compliance/security by law (GDPR Art. 17(3), CCPA 1798.105(d)).
 *  - contact_messages have no user link and are left alone.
 *
 * Returns true if a local user row existed and was removed.
 */
export async function deleteUserLocalData(clerkId: string): Promise<boolean> {
  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.clerkId, clerkId))
    .limit(1);

  if (existing.length === 0) return false;
  const localUserId = existing[0].id;

  await db.transaction(async (tx) => {
    // ── Clerk-id-keyed tables (no FK to users) — the user's own rows. ──
    await tx.delete(chatMessages).where(eq(chatMessages.clerkId, clerkId));
    await tx.delete(emailEvents).where(eq(emailEvents.clerkId, clerkId));
    await tx.delete(userPresence).where(eq(userPresence.clerkId, clerkId));
    await tx.delete(userAutomationState).where(eq(userAutomationState.clerkId, clerkId));
    await tx.delete(dicePlayerStats).where(eq(dicePlayerStats.userId, clerkId));
    await tx.delete(poolPlayerStats).where(eq(poolPlayerStats.userId, clerkId));

    // Stripe checkout-session ledger (keyed by Clerk id) — a deleted account's
    // purchase history is personal data. Guarded because the table only exists
    // after migration 0113.
    if ((await getExistingTables()).has("stripe_checkout_sessions")) {
      await tx.delete(stripeCheckoutSessions).where(eq(stripeCheckoutSessions.clerkId, clerkId));
    }

    // ── Solo games: integer user_id, no FK (rows would orphan). ──
    await tx.delete(unoGames).where(eq(unoGames.userId, localUserId));
    await tx.delete(blackjackGames).where(eq(blackjackGames.userId, localUserId));
    await tx.delete(crashGames).where(eq(crashGames.userId, localUserId));
    await tx.delete(minesGames).where(eq(minesGames.userId, localUserId));
    await tx.delete(laneRunnerGames).where(eq(laneRunnerGames.userId, localUserId));
    await tx.delete(plinkoGames).where(eq(plinkoGames.userId, clerkId));
    await tx.delete(rouletteGames).where(eq(rouletteGames.userId, localUserId));
    await tx.delete(keno_games).where(eq(keno_games.user_id, localUserId));

    // ── Solo games: varchar user_id (Clerk id), no FK. ──
    await tx.delete(rpsGames).where(eq(rpsGames.userId, clerkId));
    await tx.delete(hexDuelActions).where(eq(hexDuelActions.userId, clerkId));
    await tx.delete(poolShots).where(eq(poolShots.userId, clerkId));
    // chess_moves stores the player as `played_by` (Clerk id) with a
    // cascade on game_id; deleting the user's games covers their moves.
    await tx.delete(chessMoves).where(eq(chessMoves.playedBy, clerkId));
    // dice_flush_rooms carry no user column — the host is found via the
    // room's players/actions rows (deleted below).
    await tx
      .delete(diceFlushRooms)
      .where(
        inArray(
          diceFlushRooms.id,
          tx
            .select({ id: diceFlushPlayers.roomId })
            .from(diceFlushPlayers)
            .where(eq(diceFlushPlayers.userId, clerkId))
        )
      );
    await tx.delete(diceFlushActions).where(eq(diceFlushActions.userId, clerkId));
    await tx.delete(diceFlushPlayers).where(eq(diceFlushPlayers.userId, clerkId));

    // ── PvP match history: player1_id / player2_id are Clerk ids. ──
    // Delete any match the user played in (either seat).
    await tx
      .delete(chessGames)
      .where(or(eq(chessGames.playerWhiteId, clerkId), eq(chessGames.playerBlackId, clerkId)));
    await tx
      .delete(diceLobbies)
      .where(or(eq(diceLobbies.hostUserId, clerkId), eq(diceLobbies.opponentUserId, clerkId)));
    await tx
      .delete(diceMatches)
      .where(or(eq(diceMatches.player1Id, clerkId), eq(diceMatches.player2Id, clerkId)));
    // Tower Arena: seats are normalized into tower_arena_players; deleting
    // any match the user played in cascades to players + placement turns.
    await tx
      .delete(towerArenaMatches)
      .where(
        inArray(
          towerArenaMatches.id,
          tx
            .select({ id: towerArenaPlayers.matchId })
            .from(towerArenaPlayers)
            .where(eq(towerArenaPlayers.userId, clerkId))
        )
      );
    await tx.delete(towerArenaPlayers).where(eq(towerArenaPlayers.userId, clerkId));
    await tx
      .delete(poolLobbies)
      .where(or(eq(poolLobbies.hostUserId, clerkId), eq(poolLobbies.opponentUserId, clerkId)));
    await tx
      .delete(poolMatches)
      .where(or(eq(poolMatches.player1Id, clerkId), eq(poolMatches.player2Id, clerkId)));
    await tx
      .delete(rpsPvpGames)
      .where(or(eq(rpsPvpGames.player1Id, clerkId), eq(rpsPvpGames.player2Id, clerkId)));
    await tx
      .delete(fourInARowGames)
      .where(
        or(eq(fourInARowGames.hostClerkId, clerkId), eq(fourInARowGames.guestClerkId, clerkId))
      );
    await tx
      .delete(dotsAndBoxesGames)
      .where(
        or(eq(dotsAndBoxesGames.hostClerkId, clerkId), eq(dotsAndBoxesGames.guestClerkId, clerkId))
      );
    await tx
      .delete(hexDuelGames)
      .where(or(eq(hexDuelGames.player1Id, clerkId), eq(hexDuelGames.player2Id, clerkId)));
    await tx
      .delete(oddsGames)
      .where(or(eq(oddsGames.player1Id, clerkId), eq(oddsGames.player2Id, clerkId)));
    await tx
      .delete(precisionMatches)
      .where(or(eq(precisionMatches.player1Id, clerkId), eq(precisionMatches.player2Id, clerkId)));
    if ((await getExistingTables()).has("lane_runner_pvp_matches")) {
      await tx
        .delete(laneRunnerPvpMatches)
        .where(
          or(
            eq(laneRunnerPvpMatches.player1Id, clerkId),
            eq(laneRunnerPvpMatches.player2Id, clerkId)
          )
        );
    }
    await tx
      .delete(roulettePvpMatches)
      .where(
        or(eq(roulettePvpMatches.player1Id, clerkId), eq(roulettePvpMatches.player2Id, clerkId))
      );
    await tx
      .delete(blackjackPvpMatches)
      .where(
        or(eq(blackjackPvpMatches.player1Id, clerkId), eq(blackjackPvpMatches.player2Id, clerkId))
      );
    await tx
      .delete(minesPvpMatches)
      .where(or(eq(minesPvpMatches.player1Id, clerkId), eq(minesPvpMatches.player2Id, clerkId)));
    await tx
      .delete(memoryGridMatches)
      .where(
        or(eq(memoryGridMatches.player1Id, clerkId), eq(memoryGridMatches.player2Id, clerkId))
      );
    await tx
      .delete(laneRushDuelMatches)
      .where(
        or(eq(laneRushDuelMatches.player1Id, clerkId), eq(laneRushDuelMatches.player2Id, clerkId))
      );
    await tx
      .delete(plinkoPvpMatches)
      .where(or(eq(plinkoPvpMatches.player1Id, clerkId), eq(plinkoPvpMatches.player2Id, clerkId)));
    await tx
      .delete(kenoPvpMatches)
      .where(or(eq(kenoPvpMatches.player1Id, clerkId), eq(kenoPvpMatches.player2Id, clerkId)));

    // ── Poker: Clerk ids are embedded in jsonb — scrub, don't delete. ──
    // players: [{ seat, clerkId, ... }] — remove any seat referencing the
    // erased account. player_positions: { hostClerkId, state } — null it.
    // The whole predicate is parameterized — no string interpolation.
    await tx.execute(sql`
      UPDATE poker_games
      SET players = (
            SELECT jsonb_agg(
              CASE WHEN elem->>'clerkId' = ${clerkId}
                   THEN (elem - 'clerkId')::jsonb
                   ELSE elem END
            )
            FROM jsonb_array_elements(players) AS elem
          ),
          player_positions = jsonb_set(
            COALESCE(player_positions, '{}'::jsonb),
            '{hostClerkId}',
            'null'::jsonb,
            true
          )
      WHERE EXISTS (
        SELECT 1
        FROM jsonb_array_elements(players) AS elem
        WHERE elem->>'clerkId' = ${clerkId}
      )
    `);

    // Reports the user filed are their personal data — erase them.
    await tx.delete(playerReports).where(eq(playerReports.reporterClerkId, clerkId));
    // Reports filed AGAINST the user are other users' evidence — keep the
    // report, scrub the erased account's identity from it.
    await tx
      .update(playerReports)
      .set({ reportedClerkId: DELETED_USER_SENTINEL })
      .where(eq(playerReports.reportedClerkId, clerkId));
    // No cascade on this FK — must be removed before users.
    await tx.delete(userLoginRewards).where(eq(userLoginRewards.userId, localUserId));
    // Cascades handle every remaining integer-FK table — including
    // player_ratings / rating_events (migration 0170). rating_identities is
    // intentionally absent here; see the doc comment above.
    await tx.delete(users).where(eq(users.id, localUserId));
  });

  return true;
}
