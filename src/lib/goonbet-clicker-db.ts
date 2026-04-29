import { getNeonSql } from "../db/neon";
import { maxAllowedClicks, multiplierFromClicks, payoutFrom } from "./goonbet-clicker";

function asRows<T = Record<string, any>>(result: any): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && Array.isArray(result.rows)) return result.rows as T[];
  return [];
}

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

  await sql`BEGIN`;
  try {
    const usersResult = await sql`SELECT tokens FROM clicker_users WHERE id = ${userId} FOR UPDATE`;
    const users = asRows<{ tokens: string | number }>(usersResult);
    if (users.length === 0) throw new Error("USER_NOT_FOUND");

    const tokens = BigInt(users[0].tokens);
    if (tokens <= BigInt(0) || tokens < betAmount) throw new Error("INSUFFICIENT_TOKENS");

    await sql`UPDATE clicker_users SET tokens = tokens - ${betAmount} WHERE id = ${userId}`;
    const createdResult = await sql`INSERT INTO clicker_rounds (user_id, bet_amount, multiplier, clicks, status, payout)
                                    VALUES (${userId}, ${betAmount}, 1.0, 0, 'active', 0)
                                    RETURNING id, bet_amount, multiplier, clicks, status, created_at`;

    const created = asRows(createdResult);
    await sql`COMMIT`;
    return created[0];
  } catch (error) {
    await sql`ROLLBACK`;
    throw error;
  }
}

export async function cashoutRound(userId: string, roundId: number, clientClicks: number, clientMultiplier: number, durationMs: number) {
  const sql = getNeonSql();

  await sql`BEGIN`;
  try {
    const roundsResult = await sql`SELECT * FROM clicker_rounds WHERE id = ${roundId} AND user_id = ${userId} FOR UPDATE`;
    const rounds = asRows(roundsResult);
    if (rounds.length === 0) throw new Error("ROUND_NOT_FOUND");

    const round = rounds[0] as any;
    if (round.status !== "active") throw new Error("ROUND_NOT_ACTIVE");

    const elapsedMs = Date.now() - new Date(round.created_at).getTime();
    const effectiveDurationMs = Math.min(Math.max(durationMs, 0), Math.max(elapsedMs + 500, 0));
    const boundedClicks = Math.max(0, Math.floor(clientClicks));
    const maxClicks = maxAllowedClicks(effectiveDurationMs);
    if (boundedClicks > maxClicks) throw new Error("INVALID_CLICK_RATE");

    const expectedMultiplier = multiplierFromClicks(boundedClicks);
    if (Math.abs(expectedMultiplier - Number(clientMultiplier)) > 0.001) throw new Error("MULTIPLIER_MISMATCH");

    const payout = payoutFrom(BigInt(round.bet_amount), expectedMultiplier);

    await sql`UPDATE clicker_rounds SET status = 'cashed_out', payout = ${payout}, clicks = ${boundedClicks}, multiplier = ${expectedMultiplier} WHERE id = ${roundId}`;
    await sql`UPDATE clicker_users SET tokens = tokens + ${payout} WHERE id = ${userId}`;

    await sql`COMMIT`;
    return { payout, multiplier: expectedMultiplier, clicks: boundedClicks };
  } catch (error) {
    await sql`ROLLBACK`;
    throw error;
  }
}

export async function syncRound(userId: string, roundId: number, clientClicks: number, clientMultiplier: number, durationMs: number) {
  const sql = getNeonSql();
  const rounds = await sql`SELECT id, created_at, status FROM clicker_rounds WHERE id = ${roundId} AND user_id = ${userId} LIMIT 1`;
  if (!rounds[0]) throw new Error("ROUND_NOT_FOUND");
  if (rounds[0].status !== "active") throw new Error("ROUND_NOT_ACTIVE");

  const elapsedMs = Date.now() - new Date(rounds[0].created_at).getTime();
  const effectiveDurationMs = Math.min(Math.max(durationMs, 0), Math.max(elapsedMs + 500, 0));
  const expectedMultiplier = multiplierFromClicks(clientClicks);
  const maxClicks = maxAllowedClicks(effectiveDurationMs);

  return {
    ok: clientClicks <= maxClicks && Math.abs(expectedMultiplier - Number(clientMultiplier)) <= 0.001,
    expectedMultiplier,
    maxClicks,
  };
}

export async function getRecentRounds(userId: string) {
  const sql = getNeonSql();
  return sql`SELECT id, bet_amount, multiplier, clicks, status, payout, created_at
             FROM clicker_rounds
             WHERE user_id = ${userId}
             ORDER BY id DESC
             LIMIT 10`;
}
