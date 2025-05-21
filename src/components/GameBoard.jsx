'use client';
import { useState, useEffect } from 'react';

export default function GameBoard({ gameId, movesLeft }) {
  const [board, setBoard] = useState(() => generateInitialBoard());
  const [score, setScore] = useState(0);
  const [moves, setMoves] = useState(movesLeft);

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [board, moves]);

  function generateInitialBoard() {
    const newBoard = [
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ];
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

  function handleKeyDown(e) {
    let newBoard = [...board.map((row) => [...row])]; // deep copy
    let moved = false;

    const merge = (row) => {
      let arr = row.filter((n) => n);
      for (let i = 0; i < arr.length - 1; i++) {
        if (arr[i] === arr[i + 1]) {
          arr[i] *= 2;
          setScore((prev) => prev + arr[i]);
          arr[i + 1] = 0;
        }
      }
      return arr.filter((n) => n).concat(Array(4).fill(0)).slice(0, 4);
    };

    if (e.key === 'ArrowLeft') {
      for (let i = 0; i < 4; i++) {
        const newRow = merge(newBoard[i]);
        if (newRow.toString() !== newBoard[i].toString()) moved = true;
        newBoard[i] = newRow;
      }
    } else if (e.key === 'ArrowRight') {
      for (let i = 0; i < 4; i++) {
        const reversed = newBoard[i].slice().reverse();
        const newRow = merge(reversed).reverse();
        if (newRow.toString() !== newBoard[i].toString()) moved = true;
        newBoard[i] = newRow;
      }
    } else if (e.key === 'ArrowUp') {
      for (let j = 0; j < 4; j++) {
        let col = [newBoard[0][j], newBoard[1][j], newBoard[2][j], newBoard[3][j]];
        const newCol = merge(col);
        for (let i = 0; i < 4; i++) {
          if (newBoard[i][j] !== newCol[i]) moved = true;
          newBoard[i][j] = newCol[i];
        }
      }
    } else if (e.key === 'ArrowDown') {
      for (let j = 0; j < 4; j++) {
        let col = [newBoard[0][j], newBoard[1][j], newBoard[2][j], newBoard[3][j]].reverse();
        const newCol = merge(col).reverse();
        for (let i = 0; i < 4; i++) {
          if (newBoard[i][j] !== newCol[i]) moved = true;
          newBoard[i][j] = newCol[i];
        }
      }
    }

    if (moved) {
      addRandomTile(newBoard);
      setBoard(newBoard);
      setMoves((m) => m - 1);
    }
  }

  return (
    <div className="flex flex-col items-center">
      <div className="grid grid-cols-4 gap-2 bg-gray-400 p-4 rounded-lg">
        {board.flat().map((cell, idx) => (
          <div
            key={idx}
            className={`w-20 h-20 flex items-center justify-center font-bold text-xl rounded
              ${cell === 0 ? 'bg-gray-200' : 'bg-yellow-400 text-white'}`}
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
