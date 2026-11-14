// src/lib/proWeeklyRecap.ts
//
// THE WEEKLY GRYND PRO RECAP — one email a week summarising a member's
// solitaire play, derived entirely from games that were already settled and
// analyses that were already computed.
//
// NO NEW GAMEPLAY, NO NEW ANALYSIS. Every figure here comes from
// `solitaire_solo_results` / `solitaire_daily_results` (the settled rows) and
// `solitaire_analysis_cache` (the compact per-move ratings). Producing the recap
// never recomputes an analysis and never writes game state, so it cannot cost a
// member an allowance or change a result.
//
// EXACTLY ONCE PER WEEK. The send is claimed in `pro_weekly_recap_sends` BEFORE
// the mail is handed to the provider; a retry, a manual re-run or an overlapping
// deploy finds the claim and skips that member. A failed send releases its claim
// so the next run retries instead of silently losing the week.
//
// WHO GETS ONE. Active `grynd-pro` subscribers with an email, and only when they
// actually played in the window — an empty recap is not sent. Entitlement is
// resolved from the subscription row (the same source as every other PRO perk),
// never from a client flag.

import { sql } from "../db/sql";
import { renderTemplate, sendEmailSafely } from "./emails/base";

/** The window a recap covers: the seven days before the run. */
export const RECAP_WINDOW_DAYS = 7;

/** The email type recorded with the send (and used for the provider dedupe). */
export const RECAP_EMAIL_TYPE = "pro_weekly_recap";

/** The ISO-8601 week a date belongs to, e.g. `2026-W46`. */
export function isoWeekKey(date: Date): string {
  const d = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
  const dayNumber = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNumber);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(
    ((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7,
  );
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export type ProWeekGame = {
  /** `solo` | `daily` — the analysis cache's own vocabulary. */
  readonly gameKind: string;
  readonly completed: boolean;
  /** The compact analysis row, when one exists for this game. */
  readonly analysis: unknown;
};

export type ProWeekSummary = {
  readonly periodKey: string;
  readonly games: number;
  readonly completedGames: number;
  readonly analysedGames: number;
  readonly averageAccuracy: number | null;
  readonly bestAccuracy: number | null;
  readonly great: number;
  readonly brilliant: number;
  readonly mistakes: number;
  /** The mode played most this week, or null when nothing was played. */
  readonly topGame: string | null;
};

/** Read only the numeric fields the recap shows, defensively. */
function analysisFigures(analysis: unknown): {
  accuracy: number | null;
  ratings: Record<string, number>;
} {
  if (!analysis || typeof analysis !== "object") {
    return { accuracy: null, ratings: {} };
  }
  const summary = (analysis as { summary?: unknown }).summary;
  if (!summary || typeof summary !== "object") {
    return { accuracy: null, ratings: {} };
  }
  const { accuracy, ratings } = summary as {
    accuracy?: unknown;
    ratings?: unknown;
  };
  const numericAccuracy =
    typeof accuracy === "number" && Number.isFinite(accuracy) ? accuracy : null;

  const counted: Record<string, number> = {};
  if (ratings && typeof ratings === "object") {
    for (const [key, value] of Object.entries(ratings as Record<string, unknown>)) {
      const count = Number(value);
      if (Number.isFinite(count) && count > 0) {
        counted[key.toLowerCase()] = Math.floor(count);
      }
    }
  }
  return { accuracy: numericAccuracy, ratings: counted };
}

/**
 * Summarise one member's week. Pure: the caller supplies the games and the
 * clock, so every figure is reproducible in a test.
 */
export function summarizeProWeek({
  games,
  now = new Date(),
}: {
  games: readonly ProWeekGame[];
  now?: Date;
}): ProWeekSummary {
  let completedGames = 0;
  let analysedGames = 0;
  let accuracyTotal = 0;
  let accuracyCount = 0;
  let bestAccuracy: number | null = null;
  let great = 0;
  let brilliant = 0;
  let mistakes = 0;
  const byKind = new Map<string, number>();

  for (const game of games) {
    if (!game.completed) continue;
    completedGames += 1;
    byKind.set(game.gameKind, (byKind.get(game.gameKind) ?? 0) + 1);

    const { accuracy, ratings } = analysisFigures(game.analysis);
    if (accuracy !== null) {
      analysedGames += 1;
      accuracyTotal += accuracy;
      accuracyCount += 1;
      if (bestAccuracy === null || accuracy > bestAccuracy) bestAccuracy = accuracy;
    }
    great += ratings.great ?? 0;
    brilliant += ratings.brilliant ?? 0;
    mistakes += ratings.mistake ?? 0;
    mistakes += ratings.blunder ?? 0;
  }

  let topGame: string | null = null;
  let topCount = 0;
  for (const [kind, count] of byKind) {
    if (count > topCount) {
      topGame = kind;
      topCount = count;
    }
  }

  return {
    periodKey: isoWeekKey(now),
    games: games.length,
    completedGames,
    analysedGames,
    averageAccuracy:
      accuracyCount > 0
        ? Math.round((accuracyTotal / accuracyCount) * 10) / 10
        : null,
    bestAccuracy,
    great,
    brilliant,
    mistakes,
    topGame,
  };
}

export type ProRecapMember = { clerkId: string; email: string };
export type ProRecapRun = { member: ProRecapMember; summary: ProWeekSummary };

export type ProWeeklyRecapDeps = {
  listMembers?: () => Promise<ProRecapMember[]>;
  loadGames?: (
    clerkIds: readonly string[],
    since: Date,
  ) => Promise<Map<string, ProWeekGame[]>>;
  /** Claim the (member, week) pair. False when the week was already sent. */
  claim?: (clerkId: string, periodKey: string) => Promise<boolean>;
  /** Release a claim whose send failed, so a retry can pick it up. */
  release?: (clerkId: string, periodKey: string) => Promise<void>;
  send?: (run: ProRecapRun) => Promise<unknown>;
};

/** Active GRYND PRO members with an email address. */
export async function loadProMembers(): Promise<ProRecapMember[]> {
  const result = await sql`
    SELECT DISTINCT s.clerk_id AS "clerkId", u.email AS "email"
      FROM token_subscriptions s
      JOIN users u ON u.clerk_id = s.clerk_id
     WHERE s.status = 'active'
       AND s.plan_key = 'grynd-pro'
       AND (s.current_period_end IS NULL OR s.current_period_end > NOW())
       AND u.email IS NOT NULL
  `;
  return (result.rows ?? []) as ProRecapMember[];
}

/**
 * The week's settled solitaire rows for these members, each with the cached
 * analysis of that exact game (null when the game was never reviewed).
 */
export async function loadProWeekGames(
  clerkIds: readonly string[],
  since: Date,
): Promise<Map<string, ProWeekGame[]>> {
  const byMember = new Map<string, ProWeekGame[]>();
  if (clerkIds.length === 0) return byMember;

  const result = await sql`
    WITH games AS (
      SELECT r.user_id, 'solo'::text AS game_kind, r.id::text AS game_id,
             r.completed, r.created_at
        FROM solitaire_solo_results r
       WHERE r.created_at >= ${since}
      UNION ALL
      SELECT r.user_id, 'daily'::text, r.id::text, r.completed, r.created_at
        FROM solitaire_daily_results r
       WHERE r.created_at >= ${since}
    )
    SELECT g.user_id AS "userId", g.game_kind AS "gameKind",
           g.completed, c.analysis
      FROM games g
      LEFT JOIN solitaire_analysis_cache c
        ON c.game_kind = g.game_kind AND c.game_id = g.game_id
     WHERE g.user_id = ANY(${clerkIds as unknown as string[]})
  `;

  for (const row of (result.rows ?? []) as {
    userId: string;
    gameKind: string;
    completed: boolean;
    analysis: unknown;
  }[]) {
    const list = byMember.get(row.userId) ?? [];
    list.push({
      gameKind: row.gameKind,
      completed: row.completed === true,
      analysis: row.analysis ?? null,
    });
    byMember.set(row.userId, list);
  }
  return byMember;
}

/** The recap email body. Only verified numbers; no player-supplied text. */
export function recapEmail(summary: ProWeekSummary): { subject: string; html: string } {
  const lines = [
    `<p>Games played: <b>${summary.completedGames}</b>`,
    summary.topGame ? ` (mostly ${summary.topGame})` : "",
    `</p>`,
    summary.averageAccuracy !== null
      ? `<p>Average accuracy: <b>${summary.averageAccuracy}%</b></p>`
      : "",
    summary.bestAccuracy !== null
      ? `<p>Best game: <b>${summary.bestAccuracy}%</b></p>`
      : "",
    summary.brilliant > 0
      ? `<p>Brilliant moves: <b>${summary.brilliant}</b></p>`
      : "",
    summary.great > 0 ? `<p>Great moves: <b>${summary.great}</b></p>` : "",
    summary.mistakes > 0
      ? `<p>Moves to work on: <b>${summary.mistakes}</b></p>`
      : "",
  ].join("");

  const base = (process.env.NEXT_PUBLIC_BASE_URL || "").replace(/\/$/, "");
  return {
    subject: `Your week in solitaire — ${summary.periodKey}`,
    html: renderTemplate(
      "Your GRYND PRO week",
      lines,
      base ? "Review your games" : undefined,
      base ? `${base}/solitaire` : undefined,
    ),
  };
}

/** Compute the week's recaps, skipping members who did not play. */
export async function buildProWeeklyRecap({
  now = new Date(),
  deps = {},
}: {
  now?: Date;
  deps?: ProWeeklyRecapDeps;
} = {}): Promise<ProRecapRun[]> {
  const since = new Date(now.getTime() - RECAP_WINDOW_DAYS * 86_400_000);
  const members = await (deps.listMembers ?? loadProMembers)();
  const games =
    members.length > 0
      ? await (deps.loadGames ?? loadProWeekGames)(
          members.map((member) => member.clerkId),
          since,
        )
      : new Map<string, ProWeekGame[]>();

  const runs: ProRecapRun[] = [];
  for (const member of members) {
    const played = games.get(member.clerkId) ?? [];
    if (played.length === 0) continue;
    runs.push({ member, summary: summarizeProWeek({ games: played, now }) });
  }
  return runs;
}

async function claimRecap(clerkId: string, periodKey: string): Promise<boolean> {
  const result = await sql`
    INSERT INTO pro_weekly_recap_sends (user_id, period_key)
    VALUES (${clerkId}, ${periodKey})
    ON CONFLICT (user_id, period_key) DO NOTHING
    RETURNING user_id
  `;
  return (result.rows?.length ?? 0) > 0;
}

async function releaseRecap(clerkId: string, periodKey: string): Promise<void> {
  await sql`
    DELETE FROM pro_weekly_recap_sends
     WHERE user_id = ${clerkId} AND period_key = ${periodKey}
  `;
}

/** Send one recap through the shared email pipeline (Resend or SMTP). */
async function sendRecap({ member, summary }: ProRecapRun): Promise<unknown> {
  const { subject, html } = recapEmail(summary);
  return sendEmailSafely({
    user: member,
    type: RECAP_EMAIL_TYPE,
    category: "marketing",
    dedupeKey: `${RECAP_EMAIL_TYPE}:${member.clerkId}:${summary.periodKey}`,
    subject,
    html,
  });
}

/**
 * The cron entry point: build the week, then mail each member exactly once.
 *
 * Members who did not play are skipped without a claim. A member whose send
 * fails has their claim released and is reported in `failed` (the next run
 * retries them), never silently dropped.
 */
export async function sendProWeeklyRecaps({
  now = new Date(),
  deps = {},
}: {
  now?: Date;
  deps?: ProWeeklyRecapDeps;
} = {}): Promise<{
  periodKey: string;
  members: number;
  sent: number;
  skipped: number;
  failed: number;
}> {
  const runs = await buildProWeeklyRecap({ now, deps });
  const claim = deps.claim ?? claimRecap;
  const release = deps.release ?? releaseRecap;
  const send = deps.send ?? sendRecap;

  let sent = 0;
  let skipped = 0;
  let failed = 0;

  for (const run of runs) {
    const { clerkId } = run.member;
    const periodKey = run.summary.periodKey;

    let claimed = false;
    try {
      claimed = await claim(clerkId, periodKey);
    } catch (error) {
      console.error("[pro-recap] claim failed:", error);
      failed += 1;
      continue;
    }
    if (!claimed) {
      skipped += 1;
      continue;
    }

    try {
      const result = (await send(run)) as { error?: unknown } | undefined;
      if (result && typeof result === "object" && result.error) {
        await release(clerkId, periodKey).catch(() => {});
        failed += 1;
        continue;
      }
      sent += 1;
    } catch (error) {
      console.error("[pro-recap] send failed:", error);
      await release(clerkId, periodKey).catch(() => {});
      failed += 1;
    }
  }

  return {
    periodKey: isoWeekKey(now),
    members: runs.length,
    sent,
    skipped,
    failed,
  };
}
