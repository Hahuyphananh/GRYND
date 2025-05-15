// Define or simulate in-memory game state
const games = global.games || (global.games = {});

/**
 * @param {import("next").NextApiRequest} req
 * @param {import("next").NextApiResponse} res
 */
export default function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method not allowed' });
  }

  const { gameId, playerId, score } = req.body;

  if (!gameId || !playerId || typeof score !== "number") {
    return res.status(400).json({ message: 'Missing or invalid gameId, playerId, or score' });
  }

  const game = games[gameId];

  if (!game) {
    return res.status(404).json({ message: 'Game not found' });
  }

  if (!game.scores) {
    game.scores = {};
  }

  game.scores[playerId] = score;

  return res.status(200).json({ message: 'Score submitted', scores: game.scores });
}
