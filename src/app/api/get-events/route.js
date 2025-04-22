async function handler({ sportId }) {
  const baseQuery = `
    SELECT 
      e.id,
      e.home_team as team1,
      e.away_team as team2,
      e.start_time as date,
      s1.odds as odds1,
      s2.odds as odds2,
      m.id as market_id
    FROM events e
    JOIN markets m ON m.event_id = e.id AND m.name = 'Match Winner'
    JOIN selections s1 ON s1.market_id = m.id AND s1.name = e.home_team
    JOIN selections s2 ON s2.market_id = m.id AND s2.name = e.away_team
    WHERE e.status = 'scheduled'
    ${sportId ? "AND e.sport_id = $1" : ""}
    ORDER BY e.start_time ASC LIMIT 10`;

  const events = sportId
    ? await sql(baseQuery, [sportId])
    : await sql(baseQuery);

  return events;
}
export async function POST(request) {
  return handler(await request.json());
}