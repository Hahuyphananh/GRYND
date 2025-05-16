import { v4 as uuidv4 } from 'uuid';

// Ensure global persistence across hot reloads (dev mode)
const globalGames = globalThis as unknown as { games: Record<string, any> };
if (!globalGames.games) globalGames.games = {};
const games = globalGames.games;

/**
 * POST /api/create-2048-game
 * Creates a new 2048 game session with a bet amount.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const body = await request.json();
    const { betAmount } = body;

    if (typeof betAmount !== 'number' || betAmount <= 0) {
      return new Response(JSON.stringify({ error: 'Invalid bet amount' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const gameId = uuidv4();
    games[gameId] = {
      betAmount,
      players: [],
      boardStates: {},
      scores: {},
    };

    return new Response(JSON.stringify({ gameId }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

  } catch (err) {
    console.error('❌ Failed to create game:', err);
    return new Response(JSON.stringify({ error: 'Server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
