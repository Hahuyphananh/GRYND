import { getNeonSql } from "../db/neon";
import crypto from "node:crypto";
import {
  bustChanceAtClick,
  maxAllowedClicks,
  multiplierFromClicks,
  payoutFrom,
} from "./goonbet-clicker";

/**
 * Parse a database timestamp value into UTC milliseconds.
 * Handles Date objects, ISO strings, and SQL TIMESTAMP WITHOUT TIME ZONE
 * strings that lack a timezone indicator (forces UTC).
 */
function parseUtcTimestamp(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  const str = String(value ?? "").trim();
  if (!str) {
    console.warn("[clicker] parseUtcTimestamp received empty value, falling back to now");
    return Date.now();
  }
  const iso = str.includes("T") ? str : str.replace(" ", "T");
  const utc =
    iso.endsWith("Z") || /[+-]\d{2}:\d{2}$/.test(iso) ? iso : iso + "Z";
  return new Date(utc).getTime();
}

/** Convert a timestamp value to an ISO 8601 string (UTC). */
function toUtcIso(value: unknown): string {
  return new Date(parseUtcTimestamp(value)).toISOString();
}

function deterministicRoll(seed: string): number {
  const hash = crypto.createHash("sha256").update(seed).digest("hex");
  const bucket = Number.parseInt(hash.slice(0, 13), 16);
  return bucket / 0x1fffffffffffff;
}

function didBustByClick(seed: string, clicks: number): boolean {
  const roll = deterministicRoll(seed);
  let survive = 1;
  for (let i = 1; i <= Math.max(0, Math.floor(clicks)); i += 1) {
    survive *= 1 - bustChanceAtClick(i);
    if (roll > survive) return true;
  }
  return false;
}
function asRows<T = Record<string, any>>(result: any): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && Array.isArray(result.rows)) return result.rows as T[];
  return [];
}

export async function ensureClickerUser(userId: string, email: string | null) {
  const sql = getNeonSql();
  const casinoUsers = await sql`SELECT balance FROM users WHERE clerk_id = ${userId} LIMIT 1`;
  const casinoBalance = BigInt(Math.floor(Number(casinoUsers[0]?.balance ?? 1000)));

  await sql`INSERT INTO clicker_users (id, email, tokens)
            VALUES (${userId}, ${email}, ${casinoBalance})
            ON CONFLICT (id) DO UPDATE
            SET email = COALESCE(EXCLUDED.email, clicker_users.email),
                tokens = ${casinoBalance}`;
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
    await sql`UPDATE users SET balance = balance - ${betAmount} WHERE clerk_id = ${userId}`;
    const createdResult =
      await sql`INSERT INTO clicker_rounds (user_id, bet_amount, multiplier, clicks, status, payout)
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

export async function cashoutRound(
  userId: string,
  roundId: number,
  clientClicks: number,
  clientMultiplier: number,
  durationMs: number
) {
  const sql = getNeonSql();

  await sql`BEGIN`;
  try {
    const roundsResult =
      await sql`SELECT * FROM clicker_rounds WHERE id = ${roundId} AND user_id = ${userId} FOR UPDATE`;
    const rounds = asRows(roundsResult);
    if (rounds.length === 0) throw new Error("ROUND_NOT_FOUND");

    const round = rounds[0] as any;
    if (round.status !== "active") {
  return {
    payout: BigInt(0),
    multiplier: Number(round.multiplier),
    clicks: Number(round.clicks),
    busted: round.status === "bust",
    betAmount: BigInt(round.bet_amount),
  };
}

    const elapsedMs = Math.max(0, Date.now() - parseUtcTimestamp(round.created_at));
    // If client reports 0 or negative duration (NaN serialization / clock skew),
    // fall back to the server's elapsed time to prevent maxClicks=0 clamp
    const clientDurationMs = Math.max(0, durationMs);
    const effectiveDurationMs = clientDurationMs > 0
      ? Math.min(clientDurationMs, Math.max(elapsedMs + 500, 0))
      : Math.max(elapsedMs + 500, 0);
    const boundedClicks = Math.max(0, Math.floor(clientClicks));
    const maxClicks = maxAllowedClicks(effectiveDurationMs);
    const verifiedClicks = Math.min(boundedClicks, maxClicks);
    const expectedMultiplier = multiplierFromClicks(verifiedClicks);

    const bustSeed = `${round.id}:${userId}:${toUtcIso(round.created_at)}`;
    if (didBustByClick(bustSeed, verifiedClicks)) {
      await sql`UPDATE clicker_rounds SET status = 'bust', clicks = ${verifiedClicks}, multiplier = ${expectedMultiplier}, payout = 0 WHERE id = ${roundId}`;
      await sql`COMMIT`;
      return {
        payout: BigInt(0),
        multiplier: expectedMultiplier,
        clicks: verifiedClicks,
        busted: true,
        betAmount: BigInt(round.bet_amount),
      };
    }

    const payout = payoutFrom(BigInt(round.bet_amount), multiplierFromClicks(verifiedClicks));
    const payoutDbValue = payout.toString();

    await sql`UPDATE clicker_rounds SET status = 'cashed_out', payout = ${payoutDbValue}::bigint, clicks = ${verifiedClicks}, multiplier = ${expectedMultiplier} WHERE id = ${roundId}`;
    await sql`UPDATE clicker_users SET tokens = tokens + ${payoutDbValue}::bigint WHERE id = ${userId}`;
    await sql`UPDATE users SET balance = balance + ${payoutDbValue}::bigint WHERE clerk_id = ${userId}`;

    await sql`COMMIT`;
    return {
      payout,
      multiplier: expectedMultiplier,
      clicks: verifiedClicks,
      busted: false,
      betAmount: BigInt(round.bet_amount),
    };
  } catch (error) {
    await sql`ROLLBACK`;
    throw error;
  }
}

export async function syncRound(
  userId: string,
  roundId: number,
  clientClicks: number,
  clientMultiplier: number,
  durationMs: number
) {
  const sql = getNeonSql();
  const rounds =
    await sql`SELECT id, created_at, status FROM clicker_rounds WHERE id = ${roundId} AND user_id = ${userId} LIMIT 1`;
  if (!rounds[0]) throw new Error("ROUND_NOT_FOUND");
  if (rounds[0].status !== "active") throw new Error("ROUND_NOT_ACTIVE");

  const elapsedMs = Math.max(0, Date.now() - parseUtcTimestamp(rounds[0].created_at));
  // Same fallback: if client reports 0 duration, use server elapsed
  const clientDurationMs = Math.max(0, durationMs);
  const effectiveDurationMs = clientDurationMs > 0
    ? Math.min(clientDurationMs, Math.max(elapsedMs + 500, 0))
    : Math.max(elapsedMs + 500, 0);
  const expectedMultiplier = multiplierFromClicks(clientClicks);
  const maxClicks = maxAllowedClicks(effectiveDurationMs);
  const bustSeed = `${roundId}:${userId}:${toUtcIso(rounds[0].created_at)}`;

  return {
    ok:
      clientClicks <= maxClicks &&
      Math.abs(expectedMultiplier - Number(clientMultiplier)) <= 0.001 &&
      !didBustByClick(bustSeed, clientClicks),
    expectedMultiplier,
    maxClicks,
  };
}

export async function getRecentRounds(userId: string) {
  const sql = getNeonSql();

  return sql`
    SELECT
      id,
      bet_amount,
      multiplier,
      clicks,
      status,
      payout,
      created_at
    FROM clicker_rounds
    WHERE user_id = ${userId}
      AND status != 'active'
    ORDER BY id DESC
    LIMIT 10
  `;
}
