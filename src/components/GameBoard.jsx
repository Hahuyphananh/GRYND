'use client';
import { useState, useEffect } from 'react';

export default function GameBoard({ gameId, movesLeft }) {
  const generateInitialBoard = () => [
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ];

  const [board, setBoard] = useState(generateInitialBoard());
  const [score, setScore] = useState(0);
  const [moves, setMoves] = useState(movesLeft);

  useEffect(() => {
    const handleKeyDown = (e) => {
      // Logique à implémenter : mouvements & fusions
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [board, moves]);

  const tileColors = {
    0: 'bg-gray-300 text-transparent',
    2: 'bg-yellow-100 text-gray-800',
    4: 'bg-yellow-200 text-gray-800',
    8: 'bg-orange-300 text-white',
    16: 'bg-orange-400 text-white',
    32: 'bg-orange-500 text-white',
    64: 'bg-orange-600 text-white',
    128: 'bg-green-400 text-white',
    256: 'bg-green-500 text-white',
    512: 'bg-green-600 text-white',
    1024: 'bg-blue-500 text-white',
    2048: 'bg-purple-600 text-white',
  };

  const getTileClass = (value) => {
    return tileColors[value] || 'bg-black text-white';
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-[#faf8ef] p-4">
      <h1 className="text-4xl font-bold mb-6 text-[#776e65]">2048</h1>
      <div className="bg-[#bbada0] p-4 rounded-lg shadow-lg">
        <div className="grid grid-cols-4 gap-3">
          {board.map((row, i) =>
            row.map((cell, j) => (
              <div
                key={`${i}-${j}`}
                className={`w-20 h-20 rounded-md flex items-center justify-center text-2xl font-bold ${getTileClass(cell)}`}
              >
                {cell !== 0 ? cell : ''}
              </div>
            ))
          )}
        </div>
      </div>
      <div className="mt-6 flex gap-8 text-lg text-[#776e65]">
        <div className="bg-white px-4 py-2 rounded shadow-md">
          <p>Score: <strong>{score}</strong></p>
        </div>
        <div className="bg-white px-4 py-2 rounded shadow-md">
          <p>Moves Left: <strong>{moves}</strong></p>
        </div>
      </div>
    </div>
  );
}
