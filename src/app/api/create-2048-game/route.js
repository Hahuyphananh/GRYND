// pages/api/game/create.js
import { v4 as uuidv4 } from 'uuid';

let games = {}; // In-memory storage for demonstration

export default function handler(req, res) {
  if (req.method === 'POST') {
    const { betAmount } = req.body;
    const gameId = uuidv4();
    games[gameId] = {
      betAmount,
      players: [],
      boardStates: {},
      scores: {},
    };
    res.status(200).json({ gameId });
  } else {
    res.status(405).json({ message: 'Method not allowed' });
  }
}
