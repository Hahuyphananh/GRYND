/**
 * Big Wins Recording Utility
 * 
 * This utility records wins of 1 million+ tokens to the big_wins table.
 * Call this function whenever a player wins a game and the win amount
 * is >= 1,000,000 tokens.
 * 
 * Usage example:
 * ```
 * import { recordBigWinIfNeeded } from "@/lib/bigWins";
 * 
 * // After calculating payout
 * await recordBigWinIfNeeded({
 *   userId: user.clerkId,
 *   username: user.name,
 *   game: "Crash",
 *   betAmount: bet,
 *   winAmount: payout,
 *   multiplier: cashoutMultiplier
 * });
 * ```
 */

import { neon } from "@neondatabase/serverless";

const MINIMUM_BIG_WIN_AMOUNT = 1000000; // 1 million tokens

export interface BigWinRecord {
  userId: string;        // clerkId of the user
  username: string;      // display name of the user
  game: string;          // game name (e.g., "Crash", "Slots", "Blackjack")
  betAmount: number;     // amount bet
  winAmount: number;     // amount won (payout)
  multiplier: number;    // win multiplier (winAmount / betAmount)
}

/**
 * Records a big win to the database if the win amount is >= 1 million tokens.
 * This function is fire-and-forget - it doesn't throw errors to avoid
 * disrupting the game flow if recording fails.
 */
export async function recordBigWinIfNeeded(record: BigWinRecord): Promise<boolean> {
  // Only record wins >= 1 million tokens
  if (record.winAmount < MINIMUM_BIG_WIN_AMOUNT) {
    return false;
  }

  try {
    const sql = neon(process.env.DATABASE_URL!);

    await sql`
      INSERT INTO big_wins (user_id, username, game, bet_amount, win_amount, multiplier)
      VALUES (
        ${record.userId}, 
        ${record.username}, 
        ${record.game}, 
        ${Math.floor(record.betAmount)}, 
        ${Math.floor(record.winAmount)}, 
        ${parseFloat(record.multiplier.toFixed(4))}
      )
    `;

    console.log(`🎉 Big Win recorded: ${record.username} won ${record.winAmount.toLocaleString()} tokens on ${record.game}`);
    return true;
  } catch (error) {
    // Log error but don't fail the game flow
    console.error("Failed to record big win:", error);
    return false;
  }
}

export { MINIMUM_BIG_WIN_AMOUNT };