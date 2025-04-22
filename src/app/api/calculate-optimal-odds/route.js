async function handler({ eventId }) {
  const session = getSession();
  if (!session?.user?.id) {
    throw new Error("Unauthorized");
  }

  try {
    const marketData = await sql`
      SELECT m.*, e.* 
      FROM markets m 
      JOIN events e ON m.event_id = e.id 
      WHERE e.id = ${eventId}
    `;

    if (!marketData.length) {
      return { error: "Event not found" };
    }

    const BASE_MARGIN = 0.05;

    const historicalData = await sql`
      SELECT result_home, result_away 
      FROM events 
      WHERE sport_id = (
        SELECT sport_id FROM events WHERE id = ${eventId}
      )
      AND status = 'completed'
      LIMIT 100
    `;

    let homeWins = 0;
    let draws = 0;
    let awayWins = 0;

    historicalData.forEach((match) => {
      if (match.result_home > match.result_away) homeWins++;
      else if (match.result_home === match.result_away) draws++;
      else awayWins++;
    });

    const total = historicalData.length || 1;
    const probabilities = [homeWins / total, draws / total, awayWins / total];

    const adjustedOdds = probabilities.map(
      (prob) => 1 / (prob * (1 + BASE_MARGIN))
    );

    await sql`
      UPDATE selections 
      SET odds = ${adjustedOdds[0]} 
      WHERE market_id = ${marketData[0].id}
    `;

    return {
      success: true,
      odds: adjustedOdds,
    };
  } catch (error) {
    return { error: "Failed to calculate optimal odds" };
  }
}
export async function POST(request) {
  return handler(await request.json());
}