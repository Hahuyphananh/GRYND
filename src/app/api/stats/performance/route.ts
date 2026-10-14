// src/app/api/stats/performance/route.ts
//
// GET /api/stats/performance?game=<key>&from=<date>&to=<date>&limit=&offset=
//
// The GRYND PRO performance dashboard payload: totals, per-game breakdown, Elo
// / trophy / Overall Elo progressions, recent results and Overall Elo rank
// history — every number derived from the platform's own authoritative journals
// (see src/lib/stats/queries.ts).
//
// ── ACCESS CONTROL ────────────────────────────────────────────────────────
//
// This is a PRO surface, and the gate is SERVER-SIDE:
//
//   * the caller must be signed in (401 otherwise);
//   * membership is resolved from the caller's own subscription row through the
//     platform's existing authoritative check (`getMembershipTier` — the same
//     one /api/membership/status and the ad entitlement use). There is no
//     `isPro`/`premium` request parameter, header or cookie anywhere in this
//     file: a client cannot ask for the analytics and cannot claim to be a
//     member;
//   * a NON-member gets a 200 with `{ pro: false, locked: true }` and NO
//     analytics of any kind — not the totals, not the series, not the recent
//     results. The dashboard renders its upgrade prompt from that shape, so the
//     lock is enforced in the response itself rather than in the UI.
//
// Free features are untouched: this route is additive, and the profile, the
// leaderboards and the existing match history keep using their own endpoints.
//
// READ-ONLY. There is no writer here beyond the player's own daily rank
// snapshot (an idempotent upsert on (user_id, bucket)), which is what makes the
// rank curve current without touching any settlement path.

import { auth } from "@clerk/nextjs/server";
import {
  RATED_GAMES,
  getRatingGameLabel,
  isRatedGame,
} from "../../../../lib/rating";
import { getMembershipTier } from "../../../../lib/stripe/subscriptions";
import {
  RECENT_MAX_LIMIT,
  getPerformanceDashboard,
} from "../../../../lib/stats/queries";
import { consumeRateLimit } from "../../../../lib/security/rateLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The rated-game vocabulary WITH display labels, resolved server-side so the
 * client filter can name every rated game without importing server modules.
 */
const GAME_LABELS: Record<string, string> = Object.fromEntries(
  RATED_GAMES.map((key) => [key, getRatingGameLabel(key)]),
);

/** `YYYY-MM-DD` or a full ISO instant — anything else is refused, not guessed. */
const DATE_INPUT = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?Z?)?$/;

function parseInstant(value: string | null): { ok: true; value: string | null } | { ok: false } {
  if (!value) return { ok: true, value: null };
  const trimmed = value.trim();
  if (!DATE_INPUT.test(trimmed)) return { ok: false };
  const ms = Date.parse(trimmed);
  if (!Number.isFinite(ms)) return { ok: false };
  return { ok: true, value: new Date(ms).toISOString() };
}

function clampInt(value: string | null, min: number, max: number, fallback: number): number {
  const n = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function clientIp(request: Request): string {
  const raw =
    request.headers.get("x-forwarded-for") || request.headers.get("x-real-ip") || "unknown";
  return String(raw).split(",")[0].trim() || "unknown";
}

export async function GET(request: Request) {
  const { userId } = await auth();
  if (!userId) {
    return Response.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  const rateLimit = await consumeRateLimit(`stats-performance:${userId || clientIp(request)}`, {
    windowMs: 60_000,
    max: 60,
  });
  if (!rateLimit.allowed) {
    return Response.json(
      { success: false, error: "Too many requests, please try again later" },
      {
        status: 429,
        headers: {
          "Retry-After": String(Math.max(1, Math.ceil((rateLimit.resetAt - Date.now()) / 1000))),
        },
      },
    );
  }

  const { searchParams } = new URL(request.url);

  // Filters. An unknown game is refused rather than silently answered with a
  // different game's numbers; unknown dates are refused rather than ignored.
  const rawGame = searchParams.get("game");
  const game = rawGame && rawGame !== "all" ? rawGame : null;
  if (game && !isRatedGame(game)) {
    return Response.json(
      { success: false, error: "Unknown game" },
      { status: 400 },
    );
  }

  const from = parseInstant(searchParams.get("from"));
  const to = parseInstant(searchParams.get("to"));
  if (!from.ok || !to.ok) {
    return Response.json(
      { success: false, error: "Invalid date range" },
      { status: 400 },
    );
  }

  let pro = false;
  try {
    pro = (await getMembershipTier(userId)) === "pro";
  } catch (error) {
    // Unreadable subscription state means "not a member", exactly like
    // /api/membership/status — never the other way round.
    console.error("[stats/performance] Failed to resolve membership:", error);
    pro = false;
  }

  const limit = clampInt(searchParams.get("limit"), 1, RECENT_MAX_LIMIT, 10);
  const offset = clampInt(searchParams.get("offset"), 0, 10_000, 0);

  if (!pro) {
    // Locked: the upsell the UI renders, and nothing else. No totals, no
    // series, no recent results, no rank history.
    return Response.json(
      {
        success: true,
        pro: false,
        locked: true,
        game,
        from: from.value,
        to: to.value,
        games: RATED_GAMES,
        gameLabels: GAME_LABELS,
        upgradeUrl: "/upgrade-pro",
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  }

  try {
    const payload = await getPerformanceDashboard({
      clerkId: userId,
      filters: { game, from: from.value, to: to.value },
      recentLimit: limit,
      recentOffset: offset,
      // Opening the dashboard refreshes today's rank snapshot (idempotent).
      includeRankCapture: true,
    });

    return Response.json(
      {
        success: true,
        pro: true,
        locked: false,
        game,
        from: from.value,
        to: to.value,
        limit,
        offset,
        games: RATED_GAMES,
        gameLabels: GAME_LABELS,
        ...payload,
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    console.error("[stats/performance] Failed to build the dashboard:", error);
    return Response.json(
      { success: false, error: "Unable to load performance statistics" },
      { status: 500 },
    );
  }
}
