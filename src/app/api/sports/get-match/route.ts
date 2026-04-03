import { NextResponse } from "next/server";
import { parseAndValidateJson } from "../../../../lib/security/validation";

const ODDS_API_KEY = process.env.ODDS_API_KEY;

export async function POST(req: Request) {
  try {
    if (!ODDS_API_KEY) {
      return NextResponse.json({ success: false, error: "Missing ODDS_API_KEY" }, { status: 500 });
    }
    const body = await req.json();
    const { slug } = body;
    if (!slug)
      return NextResponse.json(
        { success: false, error: "Missing slug" },
        { status: 400 }
      );

    const sportsRes = await fetch(
      `https://api.the-odds-api.com/v4/sports/?apiKey=${ODDS_API_KEY}`
    );
    const sports = await sportsRes.json();

    let matchEvent = null;
    let sportKey = null;

    for (const sport of sports) {
      const eventsRes = await fetch(
        `https://api.the-odds-api.com/v4/sports/${sport.key}/odds/?apiKey=${ODDS_API_KEY}&regions=eu&markets=h2h`
      );
      const eventsData = await eventsRes.json();
      const events = Array.isArray(eventsData) ? eventsData : [];

      matchEvent = events.find((e: any) => e.id === slug || e.slug === slug);

      if (matchEvent) {
        sportKey = sport.key;
        break;
      }
    }

    if (!matchEvent)
      return NextResponse.json(
        { success: false, error: "Match not found" },
        { status: 404 }
      );

    const outcomes = matchEvent.bookmakers?.[0]?.markets?.[0]?.outcomes || [];
    const oddsMap = {
      [outcomes[0]?.name || "Team A"]: outcomes[0]?.price || null,
      draw: outcomes[2]?.price || outcomes[1]?.price || null,
      [outcomes[1]?.name || "Team B"]: outcomes[1]?.price || null,
    };

    let liveScore = null;
    try {
      const scoreRes = await fetch(
        `https://api.the-odds-api.com/v4/sports/${sportKey}/scores/?apiKey=${ODDS_API_KEY}&daysFrom=0&dateFormat=iso`
      );
      const scoresData = await scoreRes.json();
      const scores = Array.isArray(scoresData) ? scoresData : [];

      const scoreMatch = scores.find((s: any) => s.id === matchEvent.id);

      if (scoreMatch) {
        liveScore = {
          team_a_score: scoreMatch.home_score ?? 0,
          team_b_score: scoreMatch.away_score ?? 0,
          status: scoreMatch.status || "scheduled",
        };
      }
    } catch (err) {
      console.warn("Failed to fetch live score:", err);
    }

    const eventData = {
      id: matchEvent.id,
      sport_key: sportKey,
      team_a: outcomes[0]?.name || "Team A",
      team_b: outcomes[1]?.name || "Team B",
      start_time: matchEvent.commence_time,
      odds_map: oddsMap,
      raw_odds: outcomes,
      live_score: liveScore,
    };

    return NextResponse.json({ success: true, event: eventData });
  } catch (err) {
    console.error(err);
    return NextResponse.json(
      { success: false, error: "Internal server error" },
      { status: 500 }
    );
  }
}
