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

const CACHE_TTL_MS = 60 * 1000;
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

const setCached = (key: string, payload: CacheEntry["payload"]) => {
  cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, payload });
};

const buildOddsUrl = (sport: string, markets: string) =>
  `https://api.the-odds-api.com/v4/sports/${sport}/odds/?apiKey=${process.env.ODDS_API_KEY}&regions=us&markets=${markets}&oddsFormat=decimal`;
// NOTE: ODDS_API_KEY is required as a query param by the-odds-api.
// This is a server-side fetch (never exposed to the client).

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
      return NextResponse.json(
        { success: false, error: `Failed to fetch odds (${res.status})` },
        { status: res.status === 422 ? 422 : 500 },
      );
    }

    const data = await res.json();
    const payload = { success: true, events: data, source: "the-odds-api" };
    setCached(cacheKey, payload);

    return NextResponse.json({ ...payload, cached: false });
  } catch (err: any) {
    return NextResponse.json(
      { success: false, error: err.message },
      { status: 500 },
    );
  }
}
