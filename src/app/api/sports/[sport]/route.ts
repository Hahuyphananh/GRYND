import { NextRequest, NextResponse } from "next/server";

type CacheEntry = {
  expiresAt: number;
  payload: {
    success: boolean;
    events?: any[];
    error?: string;
    source?: string;
  };
};

const CACHE_TTL_MS = 2 * 60 * 1000; // 2 min
const cache = new Map<string, CacheEntry>();

const getCached = (key: string) => {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.payload;
};

// Stale-while-error: keep an expired entry around so we can serve it when the
// upstream odds API is failing (e.g. monthly quota exhausted). Keyed by the
// same cache key so the last-known payload is returned instead of a hard 500.
const getStale = (key: string) => {
  const entry = cache.get(key);
  if (!entry) return null;
  return entry.payload;
};

const setCached = (key: string, payload: CacheEntry["payload"]) => {
  cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, payload });
};

const buildOddsUrl = (sport: string, markets: string) =>
  `https://api.the-odds-api.com/v4/sports/${sport}/odds/?apiKey=${process.env.ODDS_API_KEY}&regions=us&markets=${markets}&oddsFormat=decimal`;

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ sport: string }> },
) {
  const { sport } = await context.params;
  const refresh = req.nextUrl.searchParams.get("refresh") === "1";
  const requestedMarkets =
    req.nextUrl.searchParams.get("markets") || "h2h,spreads,totals";
  const marketSet = new Set(
    requestedMarkets
      .split(",")
      .map((m) => m.trim())
      .filter(Boolean),
  );
  marketSet.add("h2h");
  const markets = Array.from(marketSet).join(",");
  const cacheKey = `${sport}:${markets}`;

  if (!refresh) {
    const cached = getCached(cacheKey);
    if (cached) {
      return NextResponse.json({ ...cached, cached: true });
    }
  }

  try {
    if (!process.env.ODDS_API_KEY) {
      return NextResponse.json(
        { success: false, error: "Missing ODDS_API_KEY" },
        { status: 500 },
      );
    }

    let res = await fetch(buildOddsUrl(sport, markets), { cache: "no-store" });

    // Some futures/outright sports reject spreads/totals (422). Fall back to h2h-only.
    if (res.status === 422 && markets !== "h2h") {
      res = await fetch(buildOddsUrl(sport, "h2h"), { cache: "no-store" });
    }

    if (!res.ok) {
      // Detect quota exhaustion (The Odds API: 401 + OUT_OF_USAGE_CREDITS).
      // The free tier is 500 credits/month and each `markets × regions`
      // combination counts as one credit.
      let upstreamCode: string | null = null;
      try {
        const errBody = await res.json();
        upstreamCode = errBody?.error_code || null;
      } catch {
        // non-JSON error body; ignore
      }
      const quotaOut =
        res.status === 401 && upstreamCode === "OUT_OF_USAGE_CREDITS";

      // If we have a previous payload for this sport, serve it instead of a
      // hard error so the page keeps working with last-known odds.
      const stale = getStale(cacheKey);
      if (stale) {
        return NextResponse.json({ ...stale, cached: true, stale: true });
      }

      return NextResponse.json(
        {
          success: false,
          error: quotaOut
            ? "The odds provider's monthly usage limit has been reached. Please try again later or check the ODDS_API_KEY plan."
            : `Failed to fetch odds (${res.status})`,
          code: quotaOut ? "ODDS_QUOTA_EXHAUSTED" : undefined,
        },
        { status: quotaOut ? 429 : 500 },
      );
    }

    const data = await res.json();
    const payload = { success: true, events: data, source: "the-odds-api" };
    setCached(cacheKey, payload);

    return NextResponse.json({ ...payload, cached: false });
  } catch (err: any) {
    // Serve stale data on unexpected exceptions too.
    const stale = getStale(cacheKey);
    if (stale) {
      return NextResponse.json({ ...stale, cached: true, stale: true });
    }
    return NextResponse.json(
      { success: false, error: err.message },
      { status: 500 },
    );
  }
}
