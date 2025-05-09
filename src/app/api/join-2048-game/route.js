// pages/api/game/join.js
export default function handler(req, res) {
    if (req.method === 'POST') {
      const { gameId, playerId } = req.body;
      if (games[gameId]) {
        games[gameId].players.push(playerId);
        res.status(200).json({ message: 'Joined game' });
      } else {
        res.status(404).json({ message: 'Game not found' });
      }
    } else {
      res.status(405).json({ message: 'Method not allowed' });
    }
  }
  