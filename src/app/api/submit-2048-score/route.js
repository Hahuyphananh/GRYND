// pages/api/game/submit.js
export default function handler(req, res) {
    if (req.method === 'POST') {
      const { gameId, playerId, score } = req.body;
      if (games[gameId]) {
        games[gameId].scores[playerId] = score;
        res.status(200).json({ message: 'Score submitted' });
      } else {
        res.status(404).json({ message: 'Game not found' });
      }
    } else {
      res.status(405).json({ message: 'Method not allowed' });
    }
  }
  