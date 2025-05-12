// src/app/api/2048-results/route.js

const games = {}; // Replace this with actual DB logic in production

async function handler(data) {
  const { gameId } = data;

  if (!gameId) {
    return new Response(
      JSON.stringify({ error: "Missing gameId" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  const game = games[gameId];
  if (!game) {
    return new Response(
      JSON.stringify({ error: "Game not found" }),
      { status: 404, headers: { "Content-Type": "application/json" } }
    );
  }

  const [player1, player2] = game.players;
  const score1 = game.scores[player1] || 0;
  const score2 = game.scores[player2] || 0;

  let winner = null;
  let payout = 0;

  if (score1 > score2) {
    winner = player1;
    payout = game.betAmount * 0.9;
  } else if (score2 > score1) {
    winner = player2;
    payout = game.betAmount * 0.9;
  }

  return new Response(
    JSON.stringify({ winner, payout }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

export async function POST(request) {
  const body = await request.json();
  return handler(body);
}
