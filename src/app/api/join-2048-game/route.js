// Global in-memory storage for dev runtime
const globalGames = globalThis;
if (!globalGames.games) globalGames.games = {};
const games = globalGames.games;

/**
 * POST /api/join-2048-game
 * Joins a player to a specific gameId in memory
 */
export async function POST(request) {
  try {
    const { gameId, playerId } = await request.json();

    if (!gameId || !playerId) {
      return new Response(JSON.stringify({ error: 'Missing gameId or playerId' }), {
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

    if (!Array.isArray(game.players)) {
      game.players = [];
    }

    if (!game.players.includes(playerId)) {
      game.players.push(playerId);
    }

    return new Response(JSON.stringify({
      message: 'Joined game',
      players: game.players
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

  } catch (err) {
    console.error('❌ Join game error:', err);
    return new Response(JSON.stringify({ error: 'Server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
