'use client'
import { useState, useEffect } from 'react';

export default function GameBoard({ gameId, movesLeft }) {
  const [board, setBoard] = useState(generateInitialBoard());
  const [score, setScore] = useState(0);
  const [moves, setMoves] = useState(movesLeft);

  useEffect(() => {
    const handleKeyDown = (e) => {
      // Handle arrow key presses to move tiles
      // Update board, score, and moves accordingly
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [board, moves]);

  const generateInitialBoard = () => {
    // Generate a 4x4 board with initial tiles
    return [
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ];
  };

  return (
    <div>
      <div className="grid grid-cols-4 gap-2">
        {board.map((row, i) =>
          row.map((cell, j) => (
            <div
              key={`${i}-${j}`}
              className="w-16 h-16 bg-gray-200 flex items-center justify-center text-xl font-bold"
            >
              {cell !== 0 ? cell : ''}
            </div>
          ))
        )}
      </div>
      <div className="mt-4">
        <p>Score: {score}</p>
        <p>Moves Left: {moves}</p>
      </div>
    </div>
  );
}
