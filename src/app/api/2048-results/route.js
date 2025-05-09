// pages/api/game/result.js
export default function handler(req, res) {
    if (req.method === 'GET') {
      const { gameId } = req.query;
      const game = games[gameId];
      if (game) {
        const [player1, player2] = game.players;
        const score1 = game.scores[player1] || 0;
        const score2 = game.scores[player2] || 0;
        let winner, loser, payout;
        if (score1 > score2) {
          winner = player1;
          loser = player2;
          payout = game.betAmount * 0.9;
        } else if (score2 > score1) {
          winner = player2;
          loser = player1;
          payout = game.betAmount * 0.9;
        } else {
          winner = null;
          payout = 0;
        }
        res.status(200).json({ winner, payout });
      } else {
        res.status(404).json({ message: 'Game not found' });
      }
    } else {
      res.status(405).json({ message: 'Method not allowed' });
    }
  }
  