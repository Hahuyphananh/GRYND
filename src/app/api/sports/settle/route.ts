import { auth } from "@clerk/nextjs/server";
import { sql } from "@vercel/postgres";
import { NextResponse } from "next/server";

const normalize = (value: string | null | undefined) =>
  (value || "").trim().toLowerCase();

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

  try {
    if (!process.env.ODDS_API_KEY) {
      return NextResponse.json(
        { success: false, error: "Missing ODDS_API_KEY" },
        { status: 500 },
      );
    }

    const userResult =
      await sql`SELECT id FROM users WHERE clerk_id = ${userId} LIMIT 1`;
    const dbUser = userResult.rows[0];
    if (!dbUser) {
      return NextResponse.json(
        { success: false, error: "User not found" },
        { status: 404 },
      );
    }

    const pendingResult = await sql`
      SELECT id, event_external_id, choice, odds, bet_amount, market_type, line_value
      FROM sports_bets
      WHERE user_id = ${dbUser.id}
        AND (result IS NULL OR LOWER(result) = 'pending')
        AND event_external_id IS NOT NULL
      ORDER BY placed_at ASC
      LIMIT 100
    `;

    const pendingBets = pendingResult.rows;
    if (pendingBets.length === 0) {
      return NextResponse.json({ success: true, settled: 0, checked: 0 });
    }

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

    const scoreByEventId = new Map<string, any>();
    for (const sport of sports) {
      const scoresRes = await fetch(
        `https://api.the-odds-api.com/v4/sports/${sport.key}/scores/?apiKey=${process.env.ODDS_API_KEY}&daysFrom=3&dateFormat=iso`,
        { cache: "no-store" },
      );
      if (!scoresRes.ok) continue;

      const scores = await scoresRes.json();
      if (!Array.isArray(scores)) continue;

      for (const score of scores) {
        if (score?.id) scoreByEventId.set(score.id, score);
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
      `;

      if (updateResult.rowCount > 0 && result === "won") {
        await sql`
          UPDATE users
          SET balance = balance + ${payout}
          WHERE id = ${dbUser.id}
        `;
      }

      settledCount += updateResult.rowCount > 0 ? 1 : 0;
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
