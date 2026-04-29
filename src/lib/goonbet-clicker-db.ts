import { getNeonSql } from "../db/neon";
import { CLICKER_CLICK_COOLDOWN_MS, getNextMultiplier, isBustRoll, payoutFrom } from "./goonbet-clicker";

export async function ensureClickerUser(userId: string, email: string | null) {
  const sql = getNeonSql();
  await sql`INSERT INTO clicker_users (id, email, tokens)
            VALUES (${userId}, ${email}, 1000)
            ON CONFLICT (id) DO NOTHING`;
}

export async function getTokens(userId: string): Promise<bigint> {
  const sql = getNeonSql();
  const rows = await sql`SELECT tokens FROM clicker_users WHERE id = ${userId} LIMIT 1`;
  return BigInt(rows[0]?.tokens ?? 0);
}

export async function startRound(userId: string, betAmount: bigint) {
  const sql = getNeonSql();
  return sql.transaction(async (tx) => {
    const users = await tx`SELECT tokens FROM clicker_users WHERE id = ${userId} FOR UPDATE`;
    if (!users.length) throw new Error("USER_NOT_FOUND");

    const tokens = BigInt(users[0].tokens);
    if (tokens <= BigInt(0) || tokens < betAmount) throw new Error("INSUFFICIENT_TOKENS");

    await tx`UPDATE clicker_users SET tokens = tokens - ${betAmount} WHERE id = ${userId}`;
    const created = await tx`INSERT INTO clicker_rounds (user_id, bet_amount, multiplier, clicks, status, payout)
                             VALUES (${userId}, ${betAmount}, 1.0, 0, 'active', 0)
                             RETURNING id, bet_amount, multiplier, clicks, status`;
    return created[0];
  });
}

export async function processClick(userId: string, roundId: number) {
  const sql = getNeonSql();
  return sql.transaction(async (tx) => {
    const rounds = await tx`SELECT * FROM clicker_rounds WHERE id = ${roundId} AND user_id = ${userId} FOR UPDATE`;
    if (!rounds.length) throw new Error("ROUND_NOT_FOUND");

    const round = rounds[0];
    if (round.status !== "active") throw new Error("ROUND_NOT_ACTIVE");

    const lastAction = await tx`SELECT created_at FROM clicker_actions WHERE round_id = ${roundId} ORDER BY id DESC LIMIT 1`;
    if (lastAction.length > 0) {
      const elapsedMs = Date.now() - new Date(lastAction[0].created_at).getTime();
      if (elapsedMs < CLICKER_CLICK_COOLDOWN_MS) throw new Error("RATE_LIMITED");
    }

    const clicks = Number(round.clicks) + 1;
    const multiplier = getNextMultiplier(Number(round.multiplier));
    const busted = isBustRoll();
    const status = busted ? "bust" : "active";

    await tx`UPDATE clicker_rounds
             SET clicks = ${clicks}, multiplier = ${multiplier}, status = ${status}
             WHERE id = ${roundId}`;

    await tx`INSERT INTO clicker_actions (round_id, click_index, multiplier, busted)
             VALUES (${roundId}, ${clicks}, ${multiplier}, ${busted})`;

    return { busted, clicks, multiplier, status };
  });
}

export async function cashoutRound(userId: string, roundId: number) {
  const sql = getNeonSql();
  return sql.transaction(async (tx) => {
    const rounds = await tx`SELECT * FROM clicker_rounds WHERE id = ${roundId} AND user_id = ${userId} FOR UPDATE`;
    if (!rounds.length) throw new Error("ROUND_NOT_FOUND");

    const round = rounds[0];
    if (round.status !== "active") throw new Error("ROUND_NOT_ACTIVE");

    const payout = payoutFrom(BigInt(round.bet_amount), Number(round.multiplier));

    await tx`UPDATE clicker_rounds SET status = 'cashed_out', payout = ${payout} WHERE id = ${roundId}`;
    await tx`UPDATE clicker_users SET tokens = tokens + ${payout} WHERE id = ${userId}`;

    return { payout, multiplier: Number(round.multiplier), clicks: Number(round.clicks) };
  });
}

export async function getRecentRounds(userId: string) {
  const sql = getNeonSql();
  return sql`SELECT id, bet_amount, multiplier, clicks, status, payout, created_at
             FROM clicker_rounds
             WHERE user_id = ${userId}
             ORDER BY id DESC
             LIMIT 10`;
}
