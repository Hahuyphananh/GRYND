'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation'; // ✅ FIXED
import GameBoard from '../../../components/GameBoard';

export default function GamePage() {
  const [betAmount, setBetAmount] = useState(10);
  const [movesLeft, setMovesLeft] = useState(100);
  const [gameId, setGameId] = useState(null);
  const router = useRouter();

  useEffect(() => {
    setMovesLeft(betAmount * 10);
  }, [betAmount]);

  const handleStartGame = async () => {
    const res = await fetch('/api/create-2048-game', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ betAmount }),
    });
    const data = await res.json();
    setGameId(data.gameId);
  };

  return (
    <div className="p-4">
      <h1 className="text-2xl font-bold mb-4">PvP 2048 Game</h1>
      {!gameId ? (
        <div>
          <label className="block mb-2">Bet Amount ($):</label>
          <input
            type="number"
            value={betAmount}
            onChange={(e) => setBetAmount(parseInt(e.target.value))}
            className="border p-2 mb-4"
          />
          <button
            onClick={handleStartGame}
            className="bg-blue-500 text-white px-4 py-2 rounded"
          >
            Start Game
          </button>
        </div>
      ) : (
        <GameBoard gameId={gameId} movesLeft={movesLeft} />
      )}
    </div>
  );
}
