// You must define or import `games` — this is just a placeholder.
// Ideally, `games` should be stored in memory (for dev), Redis, or DB (for prod).
const games = global.games || (global.games = {});

/**
 * @param {import("next").NextApiRequest} req
 * @param {import("next").NextApiResponse} res
 */
export default function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method not allowed' });
  }

  const { gameId, playerId } = req.body;

  if (!gameId || !playerId) {
    return res.status(400).json({ message: 'Missing gameId or playerId' });
  }

  const game = games[gameId];

  if (!game) {
    return res.status(404).json({ message: 'Game not found' });
  }

  if (!game.players) {
    game.players = [];
  }

  if (!game.players.includes(playerId)) {
    game.players.push(playerId);
  }

  return res.status(200).json({ message: 'Joined game', players: game.players });
}
