async function handler({ limit = 10 }) {
  const events = await sql`
    SELECT 
      e.*,
      s.name as sport_name,
      s.icon_name as sport_icon,
      json_agg(
        json_build_object(
          'id', m.id,
          'name', m.name,
          'selections', (
            SELECT json_agg(
              json_build_object(
                'id', s.id,
                'name', s.name,
                'odds', s.odds
              )
            )
            FROM selections s
            WHERE s.market_id = m.id 
            AND s.status = 'active'
          )
        )
      ) as markets
    FROM events e
    JOIN sports s ON e.sport_id = s.id
    LEFT JOIN markets m ON m.event_id = e.id
    WHERE e.start_time > NOW()
    GROUP BY e.id, s.name, s.icon_name
    ORDER BY e.start_time
    LIMIT ${limit}
  `;

  return events;
}
export async function POST(request) {
  return handler(await request.json());
}