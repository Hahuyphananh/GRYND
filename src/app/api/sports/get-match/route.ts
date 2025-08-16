import { NextResponse } from "next/server";

const ODDS_API_KEY = process.env.ODDS_API_KEY;

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { slug } = body;
    if (!slug) return NextResponse.json({ success: false, error: "Missing slug" }, { status: 400 });

    // Fetch all sports
    const sportsRes = await fetch(`https://api.the-odds-api.com/v4/sports/?apiKey=${ODDS_API_KEY}`);
    const sports = await sportsRes.json();

    let matchEvent = null;
    let sportKey = null;

    for (const sport of sports) {
      const eventsRes = await fetch(
        `https://api.the-odds-api.com/v4/sports/${sport.key}/odds/?apiKey=${ODDS_API_KEY}&regions=eu&markets=h2h`
      );

      const eventsData = await eventsRes.json();

      // Ensure it's an array before searching
      const events = Array.isArray(eventsData) ? eventsData : [];
      matchEvent = events.find((e: any) => e.id === slug || e.slug === slug);

      if (matchEvent) {
        sportKey = sport.key;
        break;
      }
    }

    if (!matchEvent) return NextResponse.json({ success: false, error: "Match not found" }, { status: 404 });

    const outcomes = matchEvent.bookmakers?.[0]?.markets?.[0]?.outcomes || [];
    const oddsMap = {
      [outcomes[0]?.name || "Team A"]: outcomes[0]?.price || null,
      draw: outcomes[2]?.price || outcomes[1]?.price || null,
      [outcomes[1]?.name || "Team B"]: outcomes[1]?.price || null,
    };

    const eventData = {
      id: matchEvent.id,
      sport_key: sportKey,
      team_a: outcomes[0]?.name || "Team A",
      team_b: outcomes[1]?.name || "Team B",
      start_time: matchEvent.commence_time,
      odds_map: oddsMap,
      raw_odds: outcomes,
    };

    return NextResponse.json({ success: true, event: eventData });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}
