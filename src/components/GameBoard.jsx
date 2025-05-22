'use client';
import { useState, useEffect } from 'react';
import './GameBoard.css'; // Import du fichier CSS

export default function GameBoard({ gameId, movesLeft }) {
  const [board, setBoard] = useState(() => generateInitialBoard());
  const [score, setScore] = useState(0);
  const [moves, setMoves] = useState(movesLeft);

  useEffect(() => {
    const handleKeyDown = (e) => {
      let newBoard = board.map((row) => row.slice());
      let moved = false;

      const merge = (row) => {
        let newRow = row.filter((n) => n);
        for (let i = 0; i < newRow.length - 1; i++) {
          if (newRow[i] === newRow[i + 1]) {
            newRow[i] *= 2;
            setScore((prev) => prev + newRow[i]);
            newRow[i + 1] = 0;
          }
        }
        return newRow.filter((n) => n).concat(Array(4).fill(0)).slice(0, 4);
      };

      const transpose = (matrix) => matrix[0].map((_, i) => matrix.map((row) => row[i]));
      const reverseRows = (matrix) => matrix.map((row) => row.slice().reverse());

      if (e.key === 'ArrowLeft') {
        newBoard = newBoard.map((row) => {
          const newRow = merge(row);
          if (row.toString() !== newRow.toString()) moved = true;
          return newRow;
        });
      } else if (e.key === 'ArrowRight') {
        newBoard = newBoard.map((row) => {
          const reversed = row.slice().reverse();
          const merged = merge(reversed).reverse();
          if (row.toString() !== merged.toString()) moved = true;
          return merged;
        });
      } else if (e.key === 'ArrowUp') {
        let transposed = transpose(newBoard);
        transposed = transposed.map((row) => {
          const newRow = merge(row);
          if (row.toString() !== newRow.toString()) moved = true;
          return newRow;
        });
        newBoard = transpose(transposed);
      } else if (e.key === 'ArrowDown') {
        let transposed = transpose(newBoard);
        transposed = transposed.map((row) => {
          const reversed = row.slice().reverse();
          const merged = merge(reversed).reverse();
          if (row.toString() !== merged.toString()) moved = true;
          return merged;
        });
        newBoard = transpose(transposed);
      }

      if (moved) {
        addRandomTile(newBoard);
        setBoard(newBoard);
        setMoves((m) => m - 1);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [board]);

  function generateInitialBoard() {
    const newBoard = Array(4)
      .fill(0)
      .map(() => Array(4).fill(0));
    addRandomTile(newBoard);
    addRandomTile(newBoard);
    return newBoard;
  }

  function addRandomTile(board) {
    const emptyCells = [];
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        if (board[i][j] === 0) emptyCells.push([i, j]);
      }
    }
    if (emptyCells.length === 0) return;
    const [i, j] = emptyCells[Math.floor(Math.random() * emptyCells.length)];
    board[i][j] = Math.random() < 0.9 ? 2 : 4;
  }

  function getTileColor(value) {
    const colors = {
      0: 'bg-gray-200 text-transparent',
      2: 'bg-yellow-100 text-yellow-800',
      4: 'bg-yellow-200 text-yellow-900',
      8: 'bg-orange-300 text-white',
      16: 'bg-orange-400 text-white',
      32: 'bg-orange-500 text-white',
      64: 'bg-orange-600 text-white',
      128: 'bg-green-400 text-white',
      256: 'bg-green-500 text-white',
      512: 'bg-blue-400 text-white',
      1024: 'bg-purple-500 text-white',
      2048: 'bg-pink-600 text-white',
    };
    return colors[value] || 'bg-black text-white';
  }

  return (
    <div className="flex flex-col items-center justify-center min-h-screen">
      <div className="grid grid-cols-4 gap-2 bg-gray-500 p-4 rounded-lg">
        {board.flat().map((cell, idx) => (
          <div
            key={idx}
            className={`tile w-20 h-20 flex items-center justify-center font-bold text-xl rounded ${getTileColor(cell)}`}
          >
            {cell !== 0 ? cell : ''}
          </div>
        ))}
      </div>
      <div className="mt-4 text-center">
        <p className="text-lg font-semibold">Score: {score}</p>
        <p className="text-md text-gray-700">Moves Left: {moves}</p>
      </div>
    </div>
  );
}
