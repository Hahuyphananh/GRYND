export async function POST(request) {
  try {
    const { sportId } = await request.json();
    const apiKey = process.env.API_KEY;

    const oddsUrl = `https://api.the-odds-api.com/v4/sports/${sportId}/odds/?apiKey=${apiKey}&regions=eu&markets=h2h&oddsFormat=decimal`;
    const res = await fetch(oddsUrl);
    const data = await res.json();

    const events = data.map(event => ({
      id: event.id,
      team1: event.bookmakers[0]?.markets[0]?.outcomes[0]?.name,
      team2: event.bookmakers[0]?.markets[0]?.outcomes[1]?.name,
      date: event.commence_time,
      odds1: event.bookmakers[0]?.markets[0]?.outcomes[0]?.price,
      odds2: event.bookmakers[0]?.markets[0]?.outcomes[1]?.price,
      oddsDraw: null, // or extract from draw if available
    }));

    return new Response(JSON.stringify({ events }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: "Erreur serveur" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
