"use client";
import React, { useState, useEffect } from "react";


const GRID_SIZE = 5;
const TOTAL_MINES = 3;

export default function MinesGamePage() {
  const [grid, setGrid] = useState(generateGrid());
  const [revealed, setRevealed] = useState(Array(GRID_SIZE ** 2).fill(false));
  const [gameOver, setGameOver] = useState(false);
  const [multiplier, setMultiplier] = useState(1);
  const [hasWon, setHasWon] = useState(false);

  function generateGrid() {
    const totalCells = GRID_SIZE * GRID_SIZE;
    const cells = Array(totalCells).fill("diamond");

    // Place mines
    let minesPlaced = 0;
    while (minesPlaced < TOTAL_MINES) {
      const idx = Math.floor(Math.random() * totalCells);
      if (cells[idx] !== "mine") {
        cells[idx] = "mine";
        minesPlaced++;
      }
    }

    return cells;
  }

  function handleClick(index) {
    if (revealed[index] || gameOver) return;

    const updated = [...revealed];
    updated[index] = true;
    setRevealed(updated);

    if (grid[index] === "mine") {
      setGameOver(true);
      setMultiplier(0);
    } else {
      setMultiplier((prev) => parseFloat((prev * 1.5).toFixed(2)));
    }
  }

  function handleCashOut() {
    setHasWon(true);
    setGameOver(true);
  }

  function handleReset() {
    setGrid(generateGrid());
    setRevealed(Array(GRID_SIZE ** 2).fill(false));
    setGameOver(false);
    setMultiplier(1);
    setHasWon(false);
  }

  return (
    <div className="min-h-screen bg-black text-white flex flex-col items-center justify-center p-8">
      <h1 className="text-3xl font-bold mb-6 text-[#00FF00]">💣 Mines Game</h1>

      <div className="grid grid-cols-5 gap-2">
        {grid.map((cell, i) => (
          <button
            key={i}
            onClick={() => handleClick(i)}
            className={`w-16 h-16 md:w-20 md:h-20 rounded flex items-center justify-center border-2 border-[#00FF00] bg-black
              ${revealed[i] ? (cell === "mine" ? "bg-red-800" : "bg-green-800") : "bg-black hover:bg-gray-800"}`}
          >
            {revealed[i] ? (
              cell === "mine" ? "💣" : "💎"
            ) : (
              ""
            )}
          </button>
        ))}
      </div>

      <div className="mt-6 text-center">
        {gameOver ? (
          hasWon ? (
            <p className="text-2xl text-[#FFD700]">💰 Gain : x{multiplier}</p>
          ) : (
            <p className="text-2xl text-red-500">💥 Tu as perdu !</p>
          )
        ) : (
          <p className="text-xl text-[#00FF00]">Multiplicateur actuel : x{multiplier}</p>
        )}
      </div>

      <div className="mt-4 flex space-x-4">
        {!gameOver && (
          <button
            onClick={handleCashOut}
            className="bg-[#FFD700] text-black px-6 py-2 rounded hover:bg-yellow-400"
          >
            Encaisser
          </button>
        )}
        <button
          onClick={handleReset}
          className="bg-gray-700 px-6 py-2 rounded hover:bg-gray-600"
        >
          Rejouer
        </button>
      </div>
    </div>
  );
}
