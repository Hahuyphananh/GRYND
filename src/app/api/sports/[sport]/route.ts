import { NextRequest, NextResponse } from "next/server";

type CacheEntry = {
  expiresAt: number;
  payload: { success: boolean; events?: any[]; error?: string; source?: string };
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

export async function GET(req: NextRequest, context: { params: { sport: string } }) {
  const { sport } = context.params;
  const refresh = req.nextUrl.searchParams.get("refresh") === "1";
  const requestedMarkets = req.nextUrl.searchParams.get("markets") || "h2h,spreads,totals";
  const marketSet = new Set(requestedMarkets.split(",").map((m) => m.trim()).filter(Boolean));
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
        { status: 500 }
      );
    }

    const res = await fetch(
      `https://api.the-odds-api.com/v4/sports/${sport}/odds/?apiKey=${process.env.ODDS_API_KEY}&regions=us&markets=${markets}&oddsFormat=decimal`,
      { cache: "no-store" }
    );

    if (!res.ok) throw new Error(`Failed to fetch odds (${res.status})`);

    const data = await res.json();
    const payload = { success: true, events: data, source: "the-odds-api" };
    setCached(cacheKey, payload);

    return NextResponse.json({ ...payload, cached: false });
  } catch (err: any) {
    return NextResponse.json(
      { success: false, error: err.message },
      { status: 500 }
    );
  }
}
