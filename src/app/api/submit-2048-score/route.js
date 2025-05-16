// In-memory game store for dev mode
const globalGames = globalThis;
if (!globalGames.games) globalGames.games = {};
const games = globalGames.games;

/**
 * POST /api/submit-2048-score
 * Submits a score for a player in a specific game.
 */
export async function POST(request) {
  try {
    const { gameId, playerId, score } = await request.json();

    if (!gameId || !playerId || typeof score !== 'number') {
      return new Response(JSON.stringify({
        error: 'Missing or invalid gameId, playerId, or score',
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const game = games[gameId];
    if (!game) {
      return new Response(JSON.stringify({ error: 'Game not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (!game.scores) {
      game.scores = {};
    }

    game.scores[playerId] = score;

    return new Response(JSON.stringify({
      message: 'Score submitted',
      scores: game.scores,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

  } catch (err) {
    console.error('❌ Score submission error:', err);
    return new Response(JSON.stringify({ error: 'Server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
