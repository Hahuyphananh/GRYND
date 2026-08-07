// src/lib/reports/submitReport.ts
//
// Player-report submission core — deliberately framework-free so it can be
// exercised with `node --test` outside of a running game / Next.js server.
// The API route (/api/reports/submit) is a thin wrapper around this.
//
// The `sql` tagged-template function is injected (default: the Neon SQL
// helper) so tests can drive the whole flow with a fake implementation and
// assert on the queries that would hit `player_reports`.

import { getNeonSql } from "../../db/neon";

export const REPORT_REASONS = [
  "toxic_player",
  "hacker",
  "inappropriate_name",
  "inappropriate_picture",
  "other",
] as const;

/** Keep in sync with the textarea maxLength in ReportModal.tsx. */
export const REPORT_DETAILS_MAX = 500;

export interface SubmitReportPayload {
  reportedClerkId?: string | null;
  gameType?: string | null;
  gameId?: string | number | null;
  reason?: string | null;
  details?: string | null;
}

export interface SubmitReportResult {
  success: boolean;
  status: number;
  error?: string;
  message?: string;
}

// The real Neon query function returns a custom thenable (NeonQueryPromise,
// not a native Promise), so the return type is intentionally loose — a plain
// async function (as used by the tests) and the real neon() fn are both
// assignable. Callers cast the awaited result to the row shape they expect.
export type SqlLike = (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => any;

/**
 * Ensure the self-healing schema exists (idempotent DDL). Called once per
 * process by the route — kept separate so tests can skip or spy on it.
 */
export async function ensurePlayerReportsTable(
  sql: SqlLike = getNeonSql(),
): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS player_reports (
      id SERIAL PRIMARY KEY,
      reporter_clerk_id VARCHAR(255) NOT NULL,
      reported_clerk_id VARCHAR(255) NOT NULL,
      game_type VARCHAR(50) NOT NULL,
      game_id VARCHAR(100),
      reason VARCHAR(50) NOT NULL,
      details TEXT,
      status VARCHAR(20) NOT NULL DEFAULT 'pending',
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      resolved_at TIMESTAMP,
      resolved_by_clerk_id VARCHAR(255)
    )
  `;
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_banned BOOLEAN NOT NULL DEFAULT FALSE`;
  await sql`CREATE INDEX IF NOT EXISTS idx_users_is_banned ON users (is_banned)`;
}

/**
 * Submit a player report.
 *
 * Validation order matches the original route exactly:
 *   1. reason must be one of REPORT_REASONS
 *   2. "other" requires details
 *   3. details capped at REPORT_DETAILS_MAX
 *   4. resolve reportedClerkId from the game row when the client couldn't
 *      provide it (hex-duel / pool-masters)
 *   5. required fields present + no self-report
 *   6. duplicate reports within 5 minutes → 429
 *   7. insert
 */
export async function submitReport(
  userId: string | null | undefined,
  payload: SubmitReportPayload,
  deps: { sql?: SqlLike; ensureTable?: () => Promise<void> } = {},
): Promise<SubmitReportResult> {
  const sql = deps.sql ?? getNeonSql();
  const ensureTable = deps.ensureTable;

  if (!userId) {
    return { success: false, status: 401, error: "Unauthorized" };
  }

  if (!payload || typeof payload !== "object") {
    return { success: false, status: 400, error: "Invalid request body" };
  }

  const reason = typeof payload.reason === "string" ? payload.reason : "";

  // ── Reason must be one of the allowed values ───────────────────────────
  if (!reason || !(REPORT_REASONS as readonly string[]).includes(reason)) {
    return {
      success: false,
      status: 400,
      error: "Invalid reason. Must be one of: " + REPORT_REASONS.join(", "),
    };
  }

  const details = typeof payload.details === "string" ? payload.details.trim() : "";

  // ── "other" requires details ───────────────────────────────────────────
  if (reason === "other" && details.length === 0) {
    return {
      success: false,
      status: 400,
      error: "Details are required when selecting 'Other' reason",
    };
  }

  // ── Cap details at the same length the UI enforces ─────────────────────
  if (details.length > REPORT_DETAILS_MAX) {
    return {
      success: false,
      status: 400,
      error: `Details must be ${REPORT_DETAILS_MAX} characters or fewer`,
    };
  }

  // ── Normalize/validate fields (defensive against non-string JSON) ─────
  const gameType = typeof payload.gameType === "string" ? payload.gameType.trim() : "";
  const gameId =
    payload.gameId == null
      ? null
      : String(payload.gameId);

  // ── Resolve reportedClerkId from the game when the client didn't send
  //    it (or sent a placeholder like "player1"/"player2"). ───────────────
  let resolvedReportedId =
    typeof payload.reportedClerkId === "string"
      ? payload.reportedClerkId.trim()
      : "";

  if (
    (!resolvedReportedId ||
      resolvedReportedId === "player1" ||
      resolvedReportedId === "player2") &&
    gameId &&
    gameType
  ) {
    try {
      let lookupResult: Array<{ player1_id?: string | null; player2_id?: string | null }> = [];

      if (gameType === "hex-duel") {
        // hex_duel_games.id is a serial → require a valid positive integer
        // instead of relying on parseInt() coercing arbitrary strings to
        // NaN (which produced a hidden lookup failure + misleading error).
        const numericGameId = Number(gameId);
        if (!Number.isInteger(numericGameId) || numericGameId <= 0) {
          return {
            success: false,
            status: 400,
            error: "Invalid gameId for this game type",
          };
        }
        lookupResult = (await sql`
          SELECT player1_id, player2_id FROM hex_duel_games
          WHERE id = ${numericGameId}
          LIMIT 1
        `) as Array<{ player1_id?: string | null; player2_id?: string | null }>;
      } else if (gameType === "pool-masters") {
        // pool_matches.id is a uuid string.
        lookupResult = (await sql`
          SELECT player1_id, player2_id FROM pool_matches
          WHERE id = ${gameId}
          LIMIT 1
        `) as Array<{ player1_id?: string | null; player2_id?: string | null }>;
      }

      if (lookupResult.length > 0) {
        const game = lookupResult[0];
        // The reporter is the current user; the reported is the other player.
        if (game.player1_id === userId) {
          resolvedReportedId = game.player2_id || "";
        } else if (game.player2_id === userId) {
          resolvedReportedId = game.player1_id || "";
        }
      }
    } catch {
      // Lookup failure falls through to the clear validation error below.
    }

    // Surface the real reason when a game lookup was needed but couldn't
    // resolve the opponent (game missing, user not a participant, opponent
    // never joined) instead of the vague "Missing required fields".
    if (!resolvedReportedId) {
      return {
        success: false,
        status: 400,
        error: "Could not resolve the reported player for this game",
      };
    }
  }

  // ── Required fields + self-report guard ────────────────────────────────
  if (!resolvedReportedId || !gameType) {
    return {
      success: false,
      status: 400,
      error: "Missing required fields: reportedClerkId, gameType",
    };
  }

  if (resolvedReportedId === userId) {
    return { success: false, status: 400, error: "You cannot report yourself" };
  }

  try {
    // Self-healing schema (idempotent; the route guards it with a flag).
    if (ensureTable) {
      await ensureTable();
    }

    // Duplicate reports (same reporter, same reported, same game within 5 min).
    const recentReport = (await sql`
      SELECT id FROM player_reports
      WHERE reporter_clerk_id = ${userId}
        AND reported_clerk_id = ${resolvedReportedId}
        AND game_type = ${gameType}
        AND game_id IS NOT DISTINCT FROM ${gameId}
        AND created_at > NOW() - INTERVAL '5 minutes'
      LIMIT 1
    `) as Array<{ id: number }>;

    if (Array.isArray(recentReport) && recentReport.length > 0) {
      return {
        success: false,
        status: 429,
        error: "You have already reported this player recently",
      };
    }

    await sql`
      INSERT INTO player_reports (reporter_clerk_id, reported_clerk_id, game_type, game_id, reason, details)
      VALUES (${userId}, ${resolvedReportedId}, ${gameType}, ${gameId}, ${reason}, ${details || null})
    `;

    return { success: true, status: 200, message: "Report submitted successfully" };
  } catch (err) {
    console.error("[reports/submit] Failed:", err);
    return { success: false, status: 500, error: "Failed to submit report" };
  }
}
