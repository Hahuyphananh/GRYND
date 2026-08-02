import { auth } from "@clerk/nextjs/server";
import { getNeonSql } from "../../../../db/neon";
import { NextResponse } from "next/server";
import { recordBigWinIfNeeded } from "../../../../lib/bigWins";

function extractRows<T = Record<string, any>>(result: any): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && Array.isArray(result.rows)) return result.rows as T[];
  return [];
}

const normalize = (value: string | null | undefined) =>
  (value || "").trim().toLowerCase();

// Scores responses are cached in-memory per sport so the 2-minute settle poll
// (triggered by the sport page while open) doesn't hit the Odds API every time
// and blow through the free-tier quota (500 credits/month, billed per market).
// 10-minute TTL is a good balance: scores change slowly, and a slightly stale
// score only delays a settlement by a few minutes.
const SCORES_CACHE_TTL_MS = 10 * 60 * 1000;
const scoresCache = new Map<string, { expiresAt: number; events: any[] }>();

const getCachedScores = (sportKey: string): any[] | null => {
  const entry = scoresCache.get(sportKey);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    scoresCache.delete(sportKey);
    return null;
  }
  return entry.events;
};

const setCachedScores = (sportKey: string, events: any[]) => {
  scoresCache.set(sportKey, {
    expiresAt: Date.now() + SCORES_CACHE_TTL_MS,
    events,
  });
};

const parseChoiceLabel = (choice: string | null | undefined) => {
  const raw = (choice || "").trim();
  if (!raw) return "";
  const withoutPrefix = raw.includes(":")
    ? raw.split(":").slice(1).join(":").trim()
    : raw;
  return withoutPrefix.replace(/\s*\(.+\)\s*$/, "").trim();
};

const evaluateBet = ({
  bet,
  home,
  away,
  homeScore,
  awayScore,
}: {
  bet: any;
  home: string;
  away: string;
  homeScore: number;
  awayScore: number;
}) => {
  const marketType = normalize(bet.market_type || "h2h");
  const label = normalize(parseChoiceLabel(bet.choice));
  const homeName = normalize(home);
  const awayName = normalize(away);
  const line =
    bet.line_value !== null && bet.line_value !== undefined
      ? Number(bet.line_value)
      : null;

  if (marketType === "spreads") {
    if (line === null || Number.isNaN(line)) return "pending";
    if (label === homeName)
      return homeScore + line > awayScore ? "won" : "lost";
    if (label === awayName)
      return awayScore + line > homeScore ? "won" : "lost";
    return "pending";
  }

  if (marketType === "totals") {
    if (line === null || Number.isNaN(line)) return "pending";
    const total = homeScore + awayScore;
    if (label.startsWith("over")) return total > line ? "won" : "lost";
    if (label.startsWith("under")) return total < line ? "won" : "lost";
    return "pending";
  }

  if (homeScore === awayScore) {
    if (label === "draw" || label === "tie") return "won";
    return "lost";
  }

  const winner = homeScore > awayScore ? homeName : awayName;
  return label === winner ? "won" : "lost";
};

export async function POST() {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 },
    );
  }

  const sql = getNeonSql();

  try {
    if (!process.env.ODDS_API_KEY) {
      return NextResponse.json(
        { success: false, error: "Missing ODDS_API_KEY" },
        { status: 500 },
      );
    }

    const userResult =
      await sql`SELECT id, name FROM users WHERE clerk_id = ${userId} LIMIT 1`;
    const userRows = extractRows<{ id: number; name: string }>(userResult);
    const dbUser = userRows[0];
    if (!dbUser) {
      return NextResponse.json(
        { success: false, error: "User not found" },
        { status: 404 },
      );
    }

    // Try full query with market_type/line_value/selection_metadata first;
    // fall back if columns missing.
    let pendingResult;
    try {
      pendingResult = await sql`
      SELECT id, event_external_id, choice, odds, bet_amount, market_type, line_value, selection_metadata
      FROM sports_bets
      WHERE user_id = ${dbUser.id}
        AND (result IS NULL OR LOWER(result) = 'pending')
        AND event_external_id IS NOT NULL
      ORDER BY placed_at ASC
      LIMIT 100
    `;
    } catch (e: any) {
      if (e?.code === "42703") {
        // market_type / line_value columns don't exist in this DB yet
        console.warn("[SPORTS_SETTLE_FALLBACK] market_type/line_value columns missing — spreads/totals will be evaluated as h2h until migration 0025 runs");
        pendingResult = await sql`
      SELECT id, event_external_id, choice, odds, bet_amount
      FROM sports_bets
      WHERE user_id = ${dbUser.id}
        AND (result IS NULL OR LOWER(result) = 'pending')
        AND event_external_id IS NOT NULL
      ORDER BY placed_at ASC
      LIMIT 100
    `;
      } else {
        throw e;
      }
    }

    const pendingBets = extractRows(pendingResult);
    if (pendingBets.length === 0) {
      return NextResponse.json({ success: true, settled: 0, checked: 0 });
    }

    // ---- Quota-conscious score fetching ----
    // The Odds API bills `markets × regions` credits per call and the free tier
    // is 500 credits/month. The old code fetched scores for EVERY sport on the
    // sports list (30+ credits) on every settle call — and the sport page polls
    // this endpoint every 2 minutes, which is what exhausted the monthly quota
    // and caused the 500s. Instead, fetch scores only for sports that this
    // user actually has pending bets on (stored in selection_metadata.sportKey
    // at bet time). Legacy bets without a sportKey still fall back to the full
    // scan so nothing stops settling.
    const readSportKey = (bet: any): string | null => {
      const raw = bet.selection_metadata;
      if (!raw) return null;
      if (typeof raw === "string") {
        try {
          return JSON.parse(raw)?.sportKey || null;
        } catch {
          return null;
        }
      }
      return typeof raw.sportKey === "string" ? raw.sportKey : null;
    };

    const knownSportKeys = new Set<string>();
    const betsWithoutSportKey: any[] = [];
    for (const bet of pendingBets) {
      const key = readSportKey(bet);
      if (key) knownSportKeys.add(key);
      else betsWithoutSportKey.push(bet);
    }

    const scoreByEventId = new Map<string, any>();

    const fetchScoresForSport = async (sportKey: string) => {
      const cached = getCachedScores(sportKey);
      if (cached) {
        for (const score of cached) {
          if (score?.id) scoreByEventId.set(score.id, score);
        }
        return;
      }

      const scoresRes = await fetch(
        `https://api.the-odds-api.com/v4/sports/${sportKey}/scores/?apiKey=${process.env.ODDS_API_KEY}&daysFrom=3&dateFormat=iso`,
        { cache: "no-store" },
      );
      if (!scoresRes.ok) return;
      const scores = await scoresRes.json();
      if (!Array.isArray(scores)) return;
      setCachedScores(sportKey, scores);
      for (const score of scores) {
        if (score?.id) scoreByEventId.set(score.id, score);
      }
    };

    // 1) Sports we know this user has bets on (primary path).
    for (const sportKey of knownSportKeys) {
      await fetchScoresForSport(sportKey);
    }

    // 2) Legacy bets without a stored sportKey: fall back to scanning the
    //    sports list so they still get settled (rare after the fix).
    if (betsWithoutSportKey.length > 0) {
      const sportsRes = await fetch(
        `https://api.the-odds-api.com/v4/sports/?apiKey=${process.env.ODDS_API_KEY}`,
        {
          cache: "no-store",
        },
      );
      if (!sportsRes.ok) {
        throw new Error(`Failed to load sports (${sportsRes.status})`);
      }
      const sports = await sportsRes.json();
      for (const sport of sports) {
        if (knownSportKeys.has(sport.key)) continue; // already fetched
        await fetchScoresForSport(sport.key);
      }
    }

    let settledCount = 0;

    for (const bet of pendingBets) {
      const score = scoreByEventId.get(bet.event_external_id);
      if (!score || score.completed !== true || !Array.isArray(score.scores))
        continue;

      const homeTeam = score.home_team;
      const awayTeam = score.away_team;

      const homeScoreRaw = score.scores.find(
        (s: any) => normalize(s.name) === normalize(homeTeam),
      )?.score;
      const awayScoreRaw = score.scores.find(
        (s: any) => normalize(s.name) === normalize(awayTeam),
      )?.score;
      const homeScore = Number(homeScoreRaw);
      const awayScore = Number(awayScoreRaw);
      if (Number.isNaN(homeScore) || Number.isNaN(awayScore)) continue;

      const result = evaluateBet({
        bet,
        home: homeTeam,
        away: awayTeam,
        homeScore,
        awayScore,
      });
      if (result === "pending") continue;

      const payout =
        result === "won"
          ? Number((Number(bet.bet_amount) * Number(bet.odds)).toFixed(2))
          : 0;

      const updateResult = await sql`
        UPDATE sports_bets
        SET result = ${result}, payout = ${payout}
        WHERE id = ${bet.id}
          AND (result IS NULL OR LOWER(result) = 'pending')
        RETURNING id
      `;

      const updateRows = extractRows(updateResult);
      if (updateRows.length > 0 && result === "won") {
        await sql`
          UPDATE users
          SET balance = balance + ${payout}
          WHERE id = ${dbUser.id}
        `;

        // Record big win if payout >= 1 million tokens
        if (payout >= 1000000) {
          recordBigWinIfNeeded({
            userId: userId,
            username: dbUser.name,
            game: "Sports Bet",
            betAmount: Number(bet.bet_amount),
            winAmount: payout,
            multiplier: Number(bet.odds),
          }).catch(() => {}); // Fire and forget
        }
      }

      settledCount += updateRows.length > 0 ? 1 : 0;
    }

    return NextResponse.json({
      success: true,
      checked: pendingBets.length,
      settled: settledCount,
    });
  } catch (error) {
    console.error("[SPORTS_SETTLE_ERROR]", error);
    return NextResponse.json(
      { success: false, error: "Internal server error" },
      { status: 500 },
    );
  }
}
