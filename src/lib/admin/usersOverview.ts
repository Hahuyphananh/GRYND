// src/lib/admin/usersOverview.ts
//
// Read-only audience metrics for /admin/operations: how many people are here
// right now, how many are actually playing, how many pay for GRYND PRO, and how
// the account base is growing.
//
// WHERE THE NUMBERS COME FROM (no new tracking, no new table):
//   * `user_presence`       one row per signed-in Clerk user, refreshed by the
//                           app-wide heartbeat. "Online" is a row whose
//                           `last_seen` is inside ONLINE_WINDOW_MINUTES — a
//                           closed tab ages out on its own.
//   * `user_game_presence`  one row per (user, game), written only while a real
//                           game board is open. "Playing" is the distinct users
//                           inside ACTIVE_PLAYER_WINDOW_SECONDS (3 min), the
//                           same window the casino lobby's "N playing" badge
//                           uses, so this page can never disagree with it.
//   * `token_subscriptions` the Stripe subscription rows. Entitlement is
//                           decided by `status` alone (the same
//                           ACTIVE_SUBSCRIPTION_STATUSES set /api/membership
//                           uses), so the Pro count matches who is actually
//                           treated as Pro.
//   * `users`               the account table itself.
//
// READ-ONLY BY CONSTRUCTION: every query is a SELECT. Nothing here writes,
// creates a Stripe object or calls a network service. A failed read degrades to
// `available: false` with a reason, so the Operations page still renders its
// deployment/backup sections.

import { and, desc, eq, gt, gte, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../../db/client";
import {
  audienceDailySnapshots,
  stripeCheckoutSessions,
  tokenSubscriptions,
  userGamePresence,
  userPresence,
  users,
} from "../../db/schema";
import { ACTIVE_PLAYER_WINDOW_SECONDS } from "../gamePresence";
import { PRO_PRICE_CENTS } from "../proBilling";
import { BASE_CURRENCY } from "../currency";
import { ACTIVE_SUBSCRIPTION_STATUSES } from "../stripe/subscriptions";

/**
 * How recent a `user_presence` heartbeat must be to count as "online now".
 *
 * The client heartbeat runs on a multi-minute cadence, so this is deliberately
 * generous: it answers "who has the app open", not "who clicked in the last
 * minute". A tighter window would undercount a healthy audience; a looser one
 * would count people who left long ago.
 */
export const ONLINE_WINDOW_MINUTES = 10;

/** Signup window shown next to the account total. */
export const SIGNUP_WINDOW_DAYS = 7;

/** Cancellation window for the churn figure. */
export const CHURN_WINDOW_DAYS = 30;

/** MRR is computed from the catalog, which is priced in the base currency. */
export const MRR_CURRENCY = BASE_CURRENCY;

/** Window for the "paid but not entitled" check. */
export const PAYMENT_GUARD_DAYS = 7;

/** Days of daily snapshots the dashboard charts. */
export const TREND_DAYS = 14;

export type TopGame = { gameKey: string; players: number };

export type ProBreakdown = {
  weekly: number;
  monthly: number;
  yearly: number;
  /** Paid, but on a legacy row with no interval recorded. */
  unknownInterval: number;
  trialing: number;
  pastDue: number;
};

type BillableInterval = "weekly" | "monthly" | "yearly";

/**
 * What one subscriber on `interval` is worth per month, in the catalog's base
 * currency: weekly × 52 / 12, yearly / 12, monthly as-is.
 *
 * This is an annualisation of the PUBLISHED price, not recognised revenue: it
 * ignores taxes, refunds and the currency options a checkout may have charged
 * in. Good enough for "is Pro growing", not for accounting.
 */
export function monthlyValueCents(interval: BillableInterval): number {
  const cents = PRO_PRICE_CENTS[interval];
  if (interval === "weekly") return Math.round((cents * 52) / 12);
  if (interval === "yearly") return Math.round(cents / 12);
  return cents;
}

/** MRR for a set of payers, by interval. Unknown-interval rows are excluded. */
export function computeMrrCents(
  breakdown: Pick<ProBreakdown, "weekly" | "monthly" | "yearly">,
): number {
  return (
    breakdown.weekly * monthlyValueCents("weekly") +
    breakdown.monthly * monthlyValueCents("monthly") +
    breakdown.yearly * monthlyValueCents("yearly")
  );
}

export type UsersOverview = {
  available: boolean;
  /** Why the read failed, safe to render. Null when `available` is true. */
  reason: string | null;
  generatedAt: string;
  online: {
    total: number;
    /** Rows explicitly marked `in_game` (the app-wide status). */
    inGame: number;
    windowMinutes: number;
  };
  playing: {
    /** Distinct signed-in players with a live game board. */
    total: number;
    windowSeconds: number;
    topGames: TopGame[];
  };
  pro: {
    /** Distinct subscribers with an ACTIVE subscription status. */
    total: number;
    breakdown: ProBreakdown;
    /** Pro members as a percentage of all accounts, one decimal. */
    shareOfAccounts: number;
    /** Annualised-from-catalog MRR, in `mrrCurrency`'s minor units. */
    mrrCents: number;
    /** `mrrCents * 12`. */
    arrCents: number;
    /** The currency MRR is expressed in (the catalog's base currency). */
    mrrCurrency: string;
    /** Each billing option's contribution to MRR. */
    mrrByInterval: Record<BillableInterval, number>;
    /** Subscribers whose current subscription started today / in 7 days. */
    newToday: number;
    newLast7Days: number;
    /** Distinct subscribers canceled in the last CHURN_WINDOW_DAYS. */
    canceledLast30Days: number;
    /** Canceled / (active + canceled) over that window, one decimal. */
    churnPercent: number;
  };
  accounts: {
    total: number;
    newToday: number;
    newLast7Days: number;
  };
  /**
   * Money that arrived without an entitlement to show for it. A paid Pro
   * checkout whose clerk has NO `token_subscriptions` row at all means the
   * webhook never recorded the subscription: the customer was charged and is
   * still `free`. Anything above zero is an incident, not a metric.
   */
  payments: {
    /** Paid subscription-mode checkouts in the last PAYMENT_GUARD_DAYS. */
    paidProCheckouts: number;
    /** Of those, how many have no subscription row at all. */
    missingEntitlement: number;
    /** Newest unpaid-entitlement checkout, ISO, or null. */
    lastMissingAt: string | null;
  };
};

/** One day of the daily audience snapshot. */
export type AudienceTrendPoint = {
  day: string;
  peakOnline: number;
  players: number;
  signups: number;
  proMembers: number;
};

/** `3, 7` → `42.9`. Returns 0 for an empty denominator, never NaN/Infinity. */
export function toPercent(part: number, total: number): number {
  if (!Number.isFinite(part) || !Number.isFinite(total) || total <= 0) return 0;
  return Math.round((part / total) * 1_000) / 10;
}

function startOfUtcDay(now: Date): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
}

const EMPTY: Omit<UsersOverview, "available" | "reason" | "generatedAt"> = {
  online: { total: 0, inGame: 0, windowMinutes: ONLINE_WINDOW_MINUTES },
  playing: {
    total: 0,
    windowSeconds: ACTIVE_PLAYER_WINDOW_SECONDS,
    topGames: [],
  },
  pro: {
    total: 0,
    breakdown: {
      weekly: 0,
      monthly: 0,
      yearly: 0,
      unknownInterval: 0,
      trialing: 0,
      pastDue: 0,
    },
    shareOfAccounts: 0,
    mrrCents: 0,
    arrCents: 0,
    mrrCurrency: MRR_CURRENCY,
    mrrByInterval: { weekly: 0, monthly: 0, yearly: 0 },
    newToday: 0,
    newLast7Days: 0,
    canceledLast30Days: 0,
    churnPercent: 0,
  },
  accounts: { total: 0, newToday: 0, newLast7Days: 0 },
  payments: {
    paidProCheckouts: 0,
    missingEntitlement: 0,
    lastMissingAt: null,
  },
};

/**
 * Read the audience snapshot. Never throws: a database failure returns
 * `available: false` and the reason, so an operator sees "unavailable" instead
 * of a broken page.
 */
export async function getUsersOverview(
  now: Date = new Date(),
): Promise<UsersOverview> {
  const generatedAt = now.toISOString();

  try {
    const onlineCutoff = new Date(
      now.getTime() - ONLINE_WINDOW_MINUTES * 60_000,
    );
    const playingCutoff = new Date(
      now.getTime() - ACTIVE_PLAYER_WINDOW_SECONDS * 1_000,
    );
    const dayStart = startOfUtcDay(now);
    const weekStart = new Date(
      dayStart.getTime() - (SIGNUP_WINDOW_DAYS - 1) * 86_400_000,
    );
    const canceledCutoff = new Date(
      now.getTime() - CHURN_WINDOW_DAYS * 86_400_000,
    );
    const paidCutoff = new Date(
      now.getTime() - PAYMENT_GUARD_DAYS * 86_400_000,
    );

    const [
      presenceRows,
      playingTotalRows,
      gameRows,
      proRows,
      accountRows,
      newProRows,
      canceledRows,
      paidProRows,
      missingRows,
    ] =
      await Promise.all([
        db
          .select({
            status: userPresence.status,
            value: sql<number>`count(*)::int`,
          })
          .from(userPresence)
          .where(gt(userPresence.lastSeen, onlineCutoff))
          .groupBy(userPresence.status),

        db
          .select({
            value: sql<number>`count(distinct ${userGamePresence.userId})::int`,
          })
          .from(userGamePresence)
          .where(gt(userGamePresence.lastSeenAt, playingCutoff)),

        db
          .select({
            gameKey: userGamePresence.gameKey,
            players: sql<number>`count(distinct ${userGamePresence.userId})::int`,
          })
          .from(userGamePresence)
          .where(gt(userGamePresence.lastSeenAt, playingCutoff))
          .groupBy(userGamePresence.gameKey)
          .orderBy(desc(sql`count(distinct ${userGamePresence.userId})`))
          .limit(8),

        db
          .select({
            status: tokenSubscriptions.status,
            interval: tokenSubscriptions.billingInterval,
            value: sql<number>`count(distinct ${tokenSubscriptions.clerkId})::int`,
          })
          .from(tokenSubscriptions)
          .where(
            inArray(tokenSubscriptions.status, [
              ...ACTIVE_SUBSCRIPTION_STATUSES,
            ]),
          )
          .groupBy(tokenSubscriptions.status, tokenSubscriptions.billingInterval),

        db
          .select({
            total: sql<number>`count(*)::int`,
            newToday: sql<number>`count(*) filter (where ${users.createdAt} >= ${dayStart})::int`,
            newLast7Days: sql<number>`count(*) filter (where ${users.createdAt} >= ${weekStart})::int`,
          })
          .from(users),

        // New Pro: ACTIVE subscribers whose current subscription started
        // inside the window. `createdAt` is the row's first write, so a
        // resubscribe after a cancel counts again — which is what "new Pro"
        // means to an operator.
        db
          .select({
            newToday: sql<number>`count(distinct ${tokenSubscriptions.clerkId}) filter (where ${tokenSubscriptions.createdAt} >= ${dayStart})::int`,
            newLast7Days: sql<number>`count(distinct ${tokenSubscriptions.clerkId})::int`,
          })
          .from(tokenSubscriptions)
          .where(
            and(
              inArray(tokenSubscriptions.status, [
                ...ACTIVE_SUBSCRIPTION_STATUSES,
              ]),
              gte(tokenSubscriptions.createdAt, weekStart),
            ),
          ),

        // Cancellations: the webhook stamps `updatedAt` when it records a
        // `customer.subscription.deleted`, so this is the closest the current
        // schema has to a cancellation date.
        db
          .select({
            value: sql<number>`count(distinct ${tokenSubscriptions.clerkId})::int`,
          })
          .from(tokenSubscriptions)
          .where(
            and(
              eq(tokenSubscriptions.status, "canceled"),
              gte(tokenSubscriptions.updatedAt, canceledCutoff),
            ),
          ),

        // The denominator for the paid-but-not-Pro check: every paid
        // subscription checkout we opened in the window.
        db
          .select({ value: sql<number>`count(*)::int` })
          .from(stripeCheckoutSessions)
          .where(
            and(
              eq(stripeCheckoutSessions.sessionMode, "subscription"),
              eq(stripeCheckoutSessions.paymentStatus, "paid"),
              gte(stripeCheckoutSessions.createdAt, paidCutoff),
            ),
          ),

        // The incident count: paid, but the clerk has NO subscription row of
        // any status. A canceled row is excluded on purpose — that customer
        // was entitled while they paid, and churn is a different metric. A
        // row for someone else's clerk cannot mask a missing one because the
        // join is on the session's own clerk id.
        db
          .select({
            missing: sql<number>`count(distinct ${stripeCheckoutSessions.sessionId})::int`,
            lastAt: sql<Date | null>`max(${stripeCheckoutSessions.createdAt})`,
          })
          .from(stripeCheckoutSessions)
          .leftJoin(
            tokenSubscriptions,
            eq(tokenSubscriptions.clerkId, stripeCheckoutSessions.clerkId),
          )
          .where(
            and(
              eq(stripeCheckoutSessions.sessionMode, "subscription"),
              eq(stripeCheckoutSessions.paymentStatus, "paid"),
              gte(stripeCheckoutSessions.createdAt, paidCutoff),
              isNull(tokenSubscriptions.id),
            ),
          ),
      ]);

    const onlineTotal = presenceRows.reduce(
      (sum, row) => sum + Number(row.value ?? 0),
      0,
    );
    const inGame = Number(
      presenceRows.find((row) => row.status === "in_game")?.value ?? 0,
    );

    const proTotal = proRows.reduce(
      (sum, row) => sum + Number(row.value ?? 0),
      0,
    );
    const breakdown: ProBreakdown = {
      weekly: 0,
      monthly: 0,
      yearly: 0,
      unknownInterval: 0,
      trialing: 0,
      pastDue: 0,
    };
    for (const row of proRows) {
      const value = Number(row.value ?? 0);
      if (row.interval === "weekly") breakdown.weekly += value;
      else if (row.interval === "monthly") breakdown.monthly += value;
      else if (row.interval === "yearly") breakdown.yearly += value;
      else breakdown.unknownInterval += value;

      // Statuses are not mutually exclusive with the interval counters above:
      // a trialing weekly subscriber is both. These two are extra context.
      if (row.status === "trialing") breakdown.trialing += value;
      if (row.status === "past_due") breakdown.pastDue += value;
    }

    const accounts = accountRows[0];
    const newToday = Number(newProRows[0]?.newToday ?? 0);
    const newLast7Days = Number(newProRows[0]?.newLast7Days ?? 0);
    const canceledLast30Days = Number(canceledRows[0]?.value ?? 0);
    const mrrByInterval = {
      weekly: breakdown.weekly * monthlyValueCents("weekly"),
      monthly: breakdown.monthly * monthlyValueCents("monthly"),
      yearly: breakdown.yearly * monthlyValueCents("yearly"),
    };
    const mrrCents = computeMrrCents(breakdown);
    const paidProCheckouts = Number(paidProRows[0]?.value ?? 0);
    const missingEntitlement = Number(missingRows[0]?.missing ?? 0);
    const lastMissingRaw = missingRows[0]?.lastAt ?? null;
    const lastMissingAt = lastMissingRaw
      ? new Date(lastMissingRaw).toISOString()
      : null;

    return {
      available: true,
      reason: null,
      generatedAt,
      online: {
        total: onlineTotal,
        inGame,
        windowMinutes: ONLINE_WINDOW_MINUTES,
      },
      playing: {
        total: Number(playingTotalRows[0]?.value ?? 0),
        windowSeconds: ACTIVE_PLAYER_WINDOW_SECONDS,
        topGames: gameRows
          .map((row) => ({
            gameKey: row.gameKey,
            players: Number(row.players ?? 0),
          }))
          .filter((row) => row.players > 0),
      },
      pro: {
        total: proTotal,
        breakdown,
        shareOfAccounts: toPercent(proTotal, Number(accounts?.total ?? 0)),
        mrrCents,
        arrCents: mrrCents * 12,
        mrrCurrency: MRR_CURRENCY,
        mrrByInterval,
        newToday,
        newLast7Days,
        canceledLast30Days,
        churnPercent: toPercent(
          canceledLast30Days,
          proTotal + canceledLast30Days,
        ),
      },
      accounts: {
        total: Number(accounts?.total ?? 0),
        newToday: Number(accounts?.newToday ?? 0),
        newLast7Days: Number(accounts?.newLast7Days ?? 0),
      },
      payments: {
        paidProCheckouts,
        missingEntitlement,
        lastMissingAt,
      },
    };
  } catch (error) {
    console.error("[admin/usersOverview] Failed to read audience metrics:", error);
    return {
      ...EMPTY,
      available: false,
      reason: "The audience tables could not be read.",
      generatedAt,
    };
  }
}

/**
 * The last `days` daily snapshots, oldest first.
 *
 * Written by /api/jobs/audience-snapshot every 15 minutes into
 * `audience_daily_snapshots`. Until that migration has been applied (or before
 * the first run) the table is unreadable, so this returns an empty list rather
 * than failing the Operations page.
 */
export async function getAudienceTrend(
  days: number = TREND_DAYS,
): Promise<AudienceTrendPoint[]> {
  try {
    const rows = await db
      .select({
        day: audienceDailySnapshots.day,
        peakOnline: audienceDailySnapshots.peakOnline,
        players: audienceDailySnapshots.players,
        signups: audienceDailySnapshots.signups,
        proMembers: audienceDailySnapshots.proMembers,
      })
      .from(audienceDailySnapshots)
      .orderBy(desc(audienceDailySnapshots.day))
      .limit(days);

    return rows
      .map((row) => ({
        day: String(row.day),
        peakOnline: Number(row.peakOnline ?? 0),
        players: Number(row.players ?? 0),
        signups: Number(row.signups ?? 0),
        proMembers: Number(row.proMembers ?? 0),
      }))
      .reverse();
  } catch {
    return [];
  }
}
