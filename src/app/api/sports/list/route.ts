import { NextResponse } from "next/server";

const LIST_CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12h — sports list changes rarely

let listCache: { expiresAt: number; data: any[] } | null = null;

export async function GET() {
  try {
    // Serve from cache when fresh — the sports list is essentially static, so
    // hitting the Odds API on every page load only burns monthly quota.
    if (listCache && Date.now() < listCache.expiresAt) {
      return NextResponse.json({
        success: true,
        sports: listCache.data,
        cached: true,
      });
    }

    const res = await fetch(
      `https://api.the-odds-api.com/v4/sports/?apiKey=${process.env.ODDS_API_KEY}`,
    );

    if (!res.ok) {
      // Serve stale cache on upstream failures (e.g. quota exhausted).
      if (listCache) {
        return NextResponse.json({
          success: true,
          sports: listCache.data,
          cached: true,
          stale: true,
        });
      }
      throw new Error(`Failed to fetch sports list (${res.status})`);
    }

    const data = await res.json();
    listCache = { expiresAt: Date.now() + LIST_CACHE_TTL_MS, data };

    return NextResponse.json({ success: true, sports: data, cached: false });
  } catch (err: any) {
    if (listCache) {
      return NextResponse.json({
        success: true,
        sports: listCache.data,
        cached: true,
        stale: true,
      });
    }
    return NextResponse.json(
      { success: false, error: err.message },
      { status: 500 },
    );
  }
}
