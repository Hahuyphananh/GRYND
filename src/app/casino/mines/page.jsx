"use client";
import React, { useState, useEffect, useRef } from "react";
import NavigationBar from "../../../components/navigation-bar";

export default function MinesGamePage() {
  const GRID_SIZE = 5;
  const [totalMines, setTotalMines] = useState(3);
  const [grid, setGrid] = useState(generateGrid(totalMines));
  const [revealed, setRevealed] = useState(Array(GRID_SIZE ** 2).fill(false));
  const [gameOver, setGameOver] = useState(false);
  const [multiplier, setMultiplier] = useState(1);
  const [hasWon, setHasWon] = useState(false);
  const [autoplayEnabled, setAutoplayEnabled] = useState(false);
  const [revealedCount, setRevealedCount] = useState(0);
  const [showAllMines, setShowAllMines] = useState(false);
  const [autoCashoutAt, setAutoCashoutAt] = useState(2.0);
  const [autoplaySpeed, setAutoplaySpeed] = useState(500);
  const [autoplaySettings, setAutoplaySettings] = useState(false);
  const [userTokens, setUserTokens] = useState(0); // user tokens balance
  const [loading, setLoading] = useState(false);
  const [betAmount, setBetAmount] = useState(1);
const [gameStarted, setGameStarted] = useState(false);

  
  // Autoplay references
  const autoplayTimerRef = useRef(null);
  const currentGridRef = useRef(grid);
  const revealedRef = useRef(revealed);
  const gameOverRef = useRef(gameOver);
  const multiplierRef = useRef(multiplier);
  const revealedCountRef = useRef(revealedCount);
//fetch user tokens
 useEffect(() => {
    async function fetchTokens() {
      setLoading(true);
      try {
        const response = await fetch("/api/get-user-tokens", {
          method: "POST",
        });
        const data = await response.json();
        if (data.success) {
          setUserTokens(data.data.balance);
        } else {
          throw new Error(data.error || "Unknown error");
        }
      } catch (error) {
        console.error("Error fetching tokens:", error);
        setError("Impossible de récupérer votre solde de tokens");
      } finally {
        setLoading(false);
      }
    }

    fetchTokens();
  }, []);



  // Update refs when state changes
  useEffect(() => {
    currentGridRef.current = grid;
    revealedRef.current = revealed;
    gameOverRef.current = gameOver;
    multiplierRef.current = multiplier;
    revealedCountRef.current = revealedCount;
  }, [grid, revealed, gameOver, multiplier, revealedCount]);

  // Handle autoplay timer
  useEffect(() => {
    if (autoplayEnabled && !gameOver) {
      startAutoplay();
    } else {
      stopAutoplay();
    }
    
    return () => stopAutoplay();
  }, [autoplayEnabled, gameOver]);

  // Regenerate grid when totalMines changes
  useEffect(() => {
    setGrid(generateGrid(totalMines));
    setRevealed(Array(GRID_SIZE ** 2).fill(false));
    setGameOver(false);
    setMultiplier(1);
    setHasWon(false);
    setRevealedCount(0);
    setShowAllMines(false);
  }, [totalMines]);

  function handleCustomMineInput(e) {
    e.preventDefault();
    const inputField = document.getElementById('custom-mine-input');
    const mineCount = parseInt(inputField.value, 10);
    
    if (isNaN(mineCount)) {
      alert('Please enter a valid number');
      return;
    }
    
    const maxMines = GRID_SIZE * GRID_SIZE - 1;
    const finalMineCount = Math.min(Math.max(1, mineCount), maxMines);
    setTotalMines(finalMineCount);
    inputField.value = '';
  }

  function startAutoplay() {
    if (autoplayTimerRef.current) {
      clearInterval(autoplayTimerRef.current);
    }
    
    autoplayTimerRef.current = setInterval(() => {
      // Get current state from refs
      const currentRevealed = revealedRef.current;
      const currentGameOver = gameOverRef.current;
      const currentMultiplier = multiplierRef.current;
      const currentRevealedCount = revealedCountRef.current;

      if (currentGameOver) {
        stopAutoplay();
        return;
      }

      if (currentMultiplier >= autoCashoutAt) {
        handleCashOut();
        stopAutoplay();
        return;
      }

      // Find all unrevealed cells
      const unrevealed = [];
      for (let i = 0; i < GRID_SIZE * GRID_SIZE; i++) {
        if (!currentRevealed[i]) {
          unrevealed.push(i);
        }
      }

      if (unrevealed.length > 0) {
        const randomIndex = Math.floor(Math.random() * unrevealed.length);
        const clickedIndex = unrevealed[randomIndex];
        
        // Create new revealed array with this cell revealed
        const newRevealed = [...currentRevealed];
        newRevealed[clickedIndex] = true;
        
        // Check if it's a mine
        if (currentGridRef.current[clickedIndex] === "mine") {
          // Mine hit - game over
          setGameOver(true);
          setMultiplier(0);
          setShowAllMines(true);
          setAutoplayEnabled(false);
          return;
        } else {
          // Diamond revealed - update multiplier
          const newRevealedCount = currentRevealedCount + 1;
          const newMultiplier = calculateMultiplier(totalMines, newRevealedCount);
          
          // Update all states and refs
          setRevealed(newRevealed);
          setRevealedCount(newRevealedCount);
          setMultiplier(newMultiplier);
          revealedRef.current = newRevealed;
          revealedCountRef.current = newRevealedCount;
          multiplierRef.current = newMultiplier;

          // Check for win condition
          const safeCells = GRID_SIZE * GRID_SIZE - totalMines;
          if (newRevealedCount >= safeCells) {
            setHasWon(true);
            setGameOver(true);
            setShowAllMines(true);
            setAutoplayEnabled(false);
          }
        }
      } else {
        stopAutoplay();
      }
    }, autoplaySpeed);
  }

  function stopAutoplay() {
    if (autoplayTimerRef.current) {
      clearInterval(autoplayTimerRef.current);
      autoplayTimerRef.current = null;
    }
  }

  function calculateMultiplier(mines, revealed) {
 const multiplierTable = {
  1: {1:1.03,2:1.08,3:1.12,4:1.18,5:1.24,6:1.30,7:1.37,8:1.46,9:1.55,10:1.65,11:1.77,12:1.90,13:2.06,14:2.25,15:2.47,16:2.75,17:3.09,18:3.54,19:4.12,20:4.95,21:6.19,22:8.25,23:12.37,24:24.75},
  2: {1:1.08,2:1.12,3:1.18,4:1.24,5:1.30,6:1.37,7:1.46,8:1.55,9:1.65,10:1.77,11:1.90,12:2.06,13:2.25,14:2.47,15:2.75,16:3.09,17:3.54,18:4.12,19:4.95,20:6.19,21:8.25,22:12.37,23:24.75},
  3: {1:1.12,2:1.18,3:1.24,4:1.30,5:1.37,6:1.46,7:1.55,8:1.65,9:1.77,10:1.90,11:2.06,12:2.25,13:2.47,14:2.75,15:3.09,16:3.54,17:4.12,18:4.95,19:6.19,20:8.25,21:12.37,22:24.75},
  4: {1:1.18,2:1.24,3:1.30,4:1.37,5:1.46,6:1.55,7:1.65,8:1.77,9:1.90,10:2.06,11:2.25,12:2.47,13:2.75,14:3.09,15:3.54,16:4.12,17:4.95,18:6.19,19:8.25,20:12.37,21:24.75},
  5: {1:1.24,2:1.30,3:1.37,4:1.46,5:1.55,6:1.65,7:1.77,8:1.90,9:2.06,10:2.25,11:2.47,12:2.75,13:3.09,14:3.54,15:4.12,16:4.95,17:6.19,18:8.25,19:12.37,20:24.75},
  6: {1:1.30,2:1.37,3:1.46,4:1.55,5:1.65,6:1.77,7:1.90,8:2.06,9:2.25,10:2.47,11:2.75,12:3.09,13:3.54,14:4.12,15:4.95,16:6.19,17:8.25,18:12.37,19:24.75},
  7: {1:1.37,2:1.46,3:1.55,4:1.65,5:1.77,6:1.90,7:2.06,8:2.25,9:2.47,10:2.75,11:3.09,12:3.54,13:4.12,14:4.95,15:6.19,16:8.25,17:12.37,18:24.75},
  8: {1:1.46,2:1.55,3:1.65,4:1.77,5:1.90,6:2.06,7:2.25,8:2.47,9:2.75,10:3.09,11:3.54,12:4.12,13:4.95,14:6.19,15:8.25,16:12.37,17:24.75},
  9: {1:1.55,2:1.65,3:1.77,4:1.90,5:2.06,6:2.25,7:2.47,8:2.75,9:3.09,10:3.54,11:4.12,12:4.95,13:6.19,14:8.25,15:12.37,16:24.75},
  10: {1:1.65,2:1.77,3:1.90,4:2.06,5:2.25,6:2.47,7:2.75,8:3.09,9:3.54,10:4.12,11:4.95,12:6.19,13:8.25,14:12.37,15:24.75},
  11: {1:1.77,2:1.90,3:2.06,4:2.25,5:2.47,6:2.75,7:3.09,8:3.54,9:4.12,10:4.95,11:6.19,12:8.25,13:12.37,14:24.75},
  12: {1:1.90,2:2.06,3:2.25,4:2.47,5:2.75,6:3.09,7:3.54,8:4.12,9:4.95,10:6.19,11:8.25,12:12.37,13:24.75},
  13: {1:2.06,2:2.25,3:2.47,4:2.75,5:3.09,6:3.54,7:4.12,8:4.95,9:6.19,10:8.25,11:12.37,12:24.75},
  14: {1:2.25,2:2.47,3:2.75,4:3.09,5:3.54,6:4.12,7:4.95,8:6.19,9:8.25,10:12.37,11:24.75},
  15: {1:2.47,2:2.75,3:3.09,4:3.54,5:4.12,6:4.95,7:6.19,8:8.25,9:12.37,10:24.75},
  16: {1:2.75,2:3.09,3:3.54,4:4.12,5:4.95,6:6.19,7:8.25,8:12.37,9:24.75},
  17: {1:3.09,2:3.54,3:4.12,4:4.95,5:6.19,6:8.25,7:12.37,8:24.75},
  18: {1:3.54,2:4.12,3:4.95,4:6.19,5:8.25,6:12.37,7:24.75},
  19: {1:4.12,2:4.95,3:6.19,4:8.25,5:12.37,6:24.75},
  20: {1:4.95,2:6.19,3:8.25,4:12.37,5:24.75},
  21: {1:6.19,2:8.25,3:12.37,4:24.75},
  22: {1:8.25,2:12.37,3:24.75},
  23: {1:12.37,2:24.75},
  24: {1:24.75}
};

    
    return multiplierTable[mines]?.[revealed] || 1.0;
  }

  function generateGrid(mines) {
    const totalCells = GRID_SIZE * GRID_SIZE;
    const cells = Array(totalCells).fill("diamond");

    let minesPlaced = 0;
    while (minesPlaced < mines) {
      const idx = Math.floor(Math.random() * totalCells);
      if (cells[idx] !== "mine") {
        cells[idx] = "mine";
        minesPlaced++;
      }
    }

    return cells;
  }

async function handleClick(index) {
  if (!gameStarted) return false; // ⛔ block clicks before New Game
  if (revealed[index] || gameOver) return false;

  const updated = [...revealed];
  updated[index] = true;
  setRevealed(updated);
  
  const newRevealedCount = revealedCount + 1;
  setRevealedCount(newRevealedCount);

  if (grid[index] === "mine") {
    setGameOver(true);
    setMultiplier(0);
    setShowAllMines(true);
    setAutoplayEnabled(false);

    // 🔁 Call settle API for LOSS
    try {
      const res = await fetch("/api/mines/settle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          betAmount: betAmount,
          mines: totalMines,
          revealedCount,
          gameWon: false,
        }),
      });

      const data = await res.json();
      if (data.success) {
        setUserTokens(data.data.newBalance);
      } else {
        console.error("Error updating balance (loss):", data.error);
      }
    } catch (err) {
      console.error("Network error on loss:", err);
    }

    return true;
  } else {
    const newMultiplier = calculateMultiplier(totalMines, newRevealedCount);
    setMultiplier(newMultiplier);
    
    const safeCells = GRID_SIZE * GRID_SIZE - totalMines;
    if (newRevealedCount >= safeCells) {
      setHasWon(true);
      setGameOver(true);
      setShowAllMines(true);
      setAutoplayEnabled(false);
    }
    return false;
  }
}

 async function handleCashOut() {
  setHasWon(true);
  setGameOver(true);
  setShowAllMines(true);
  setAutoplayEnabled(false);

  // 🔁 Call settle API for WIN
  try {
    const res = await fetch("/api/mines/settle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        betAmount: betAmount, // You can make this a state later if needed
        mines: totalMines,
        revealedCount,
        gameWon: true,
      }),
    });

    const data = await res.json();
    if (data.success) {
      setUserTokens(data.data.newBalance);
    } else {
      console.error("Error updating balance (win):", data.error);
    }
  } catch (err) {
    console.error("Network error on win:", err);
  }
}

 function handleReset() {
  setGrid(generateGrid(totalMines));
  setRevealed(Array(GRID_SIZE ** 2).fill(false));
  setGameOver(false);
  setMultiplier(1);
  setHasWon(false);
  setRevealedCount(0);
  setShowAllMines(false);
  setAutoplaySettings(false);
  setGameStarted(true); // ✅ game officially starts
}

  function handleMineChange(mines) {
    setTotalMines(mines);
    handleReset();
  }

  function toggleAutoplay() {
    if (gameOver) return;
    
    if (!autoplayEnabled) {
      setAutoplaySettings(true);
    } else {
      setAutoplayEnabled(false);
    }
  }
  
  function startAutoplayWithSettings() {
    setAutoplaySettings(false);
    setAutoplayEnabled(true);
  }

  function getCellContent(cellType, index) {
    if (revealed[index]) {
      return cellType === "mine" ? "☢️" : "💎";
    }
    
    if (showAllMines && cellType === "mine") {
      return "☢️";
    }
    
    return "❓";
  }
  
  function getCellStyle(cellType, index) {
    const baseStyle = gameOver ? "opacity-70" : "";
    
    if (revealed[index]) {
      return `${baseStyle} ${cellType === "mine" ? "bg-red-600" : "bg-green-600"}`;
    }
    
    if (showAllMines && cellType === "mine") {
      return `${baseStyle} bg-red-800 border border-red-400`;
    }
    
    return `${baseStyle} ${gameOver ? "bg-gray-800" : "bg-gray-700 hover:bg-gray-600"}`;
  }

  const maxMultiplier = calculateMultiplier(totalMines, GRID_SIZE * GRID_SIZE - totalMines - 1);

return (
  <div className="min-h-screen bg-[#003366] text-white flex flex-col items-center justify-center p-4 relative">
    <NavigationBar currentPath="/casino" />
  
   <div className={`bg-[#004080] rounded-lg p-8 w-full max-w-6xl min-w-[80%] ${gameOver ? "relative" : ""}`}>
      {gameOver && (
        <div className="absolute inset-0 bg-black bg-opacity-10 rounded-lg pointer-events-none"></div>
      )}

      {/* Main game area with side panels */}
      <div className="flex flex-col lg:flex-row gap-6">
        {/* Left sidebar */}
        <div className="w-full lg:w-1/4 flex flex-col gap-4">
          {/* Your new input container */}
           <h1 className="text-3xl font-bold text-yellow-400 text-center w-full mt-3">
            Mines
          </h1>
  <div className="bg-[#0055aa] rounded-lg p-4">
    <label htmlFor="bet-input" className="block mb-2 text-center font-semibold">
      Bet Amount
    </label>
    <input
      id="bet-input"
      type="number"
      min="1"
      max={userTokens}
      value={betAmount} // you need to add betAmount state too
      onChange={(e) => setBetAmount(Number(e.target.value))}
      className="w-full bg-[#004080] text-white rounded px-2 py-1 text-center"
      disabled={gameOver || autoplayEnabled}
      placeholder="Enter your bet"
    />
    <p className="text-xs text-gray-300 mt-1 text-center">Balance: {userTokens} tokens</p>
  </div>
          {/* Mine selection */}
          <div className="bg-[#0055aa] rounded-lg p-4">
            <p className="text-lg mb-3 text-center">Select Mines</p>
            <div className="grid grid-cols-3 gap-2">
              {[1, 3, 5, 10, 15, 20].map((mineCount) => (
                <button
                  key={mineCount}
                  onClick={() => handleMineChange(mineCount)}
                  disabled={autoplayEnabled}
                  className={`py-2 px-1 rounded text-sm ${
                    totalMines === mineCount
                      ? "bg-#1e3f5a-600 text-white"
                      : "bg-[#004080] text-gray-300"
                  } ${gameOver || autoplayEnabled ? "opacity-70" : ""}`}
                >
                  {mineCount}
                </button>
              ))}
            </div>

            {/* Custom mine input */}
            <form onSubmit={handleCustomMineInput} className="mt-4 flex gap-2">
              <input
                id="custom-mine-input"
                type="number"
                min="1"
                max={GRID_SIZE * GRID_SIZE - 1}
                placeholder="Custom"
                className="bg-[#004080] text-white rounded px-2 py-1 w-full text-sm"
                disabled={gameOver || autoplayEnabled}
              />
              <button
                type="submit"
                className={`px-2 py-1 rounded text-sm bg-blue-600 text-white
                  ${gameOver || autoplayEnabled ? "opacity-70 cursor-not-allowed" : ""}`}
                disabled={gameOver || autoplayEnabled}
              >
                Set
              </button>
            </form>
          </div>

          {/* Game stats */}
          <div className="bg-[#0055aa] rounded-lg p-4">
            <div className="flex justify-between items-center mb-2">
              <span className="font-bold">Diamonds:</span>
              <span className="flex items-center">
                <span className="text-green-400 mr-1">💎</span>
                {25 - totalMines}
              </span>
            </div>
            <div className="flex justify-between items-center mb-4">
              <span className="font-bold">Mines:</span>
              <span className="flex items-center">
                <span className="text-purple-500 mr-1">☢️</span>
                {totalMines}
              </span>
            </div>
          </div>
        </div>

        {/* Main game grid */}
<div className="w-full lg:w-2/4 relative">
  
  {/* 🔒 Start Game Overlay */}
  {!gameStarted && (
    <div className="absolute inset-0 z-20 bg-black/50 rounded-lg
                    flex flex-col items-center justify-center text-center">
     <p className="text-2xl font-bold mb-3 animate-pulse">
  🎮 Click NEW GAME to start
</p>
      <p className="text-sm text-gray-300">
        Place your bet, choose mines, then start the game
      </p>
    </div>
  )}

  <div className={`grid grid-cols-5 gap-3 ${!gameStarted ? "pointer-events-none" : ""}`}>

            {grid.map((cell, i) => (
             <button
  key={i}
  onClick={() => handleClick(i)}
  disabled={
    !gameStarted || 
    gameOver || 
    (showAllMines && cell === "mine") || 
    autoplayEnabled
  }
                className={`w-full aspect-square rounded-lg flex items-center justify-center
  transition-all duration-300 text-3xl
  ${getCellStyle(cell, i)}
  ${!gameStarted ? "opacity-50 cursor-not-allowed" : ""}
`}
              >
                {getCellContent(cell, i)}
              </button>
            ))}
          </div>
        </div>

        {/* Right sidebar */}
        <div className="w-full lg:w-1/4 flex flex-col gap-4">
          {/* Tokens */}
          <div className="bg-[#0055aa] rounded-lg p-4 text-center">
            <p className="text-lg font-semibold mb-1">🪙 Tokens</p>
            <p className="text-yellow-400 text-xl font-bold">{userTokens}</p>
          </div>

          {/* Multiplier display */}
          <div className="bg-[#0055aa] rounded-lg p-4 text-center">
            <div className="text-3xl font-bold text-green-400 mb-1">
              {multiplier.toFixed(2)}x
            </div>
            <div className="text-sm text-gray-300">Max: {maxMultiplier.toFixed(2)}x</div>
          </div>

          {/* Action buttons */}
          <div className="bg-[#0055aa] rounded-lg p-4 flex flex-col gap-3">
            <button
              onClick={handleCashOut}
              className={`bg-pink-600 hover:bg-pink-700 text-white font-bold py-3 px-4 rounded-lg text-lg
                ${(!gameStarted || revealedCount === 0 || gameOver || autoplayEnabled)
  ? 'opacity-50 cursor-not-allowed'
  : ''}
`}
              disabled={
  !gameStarted ||
  revealedCount === 0 ||
  gameOver ||
  autoplayEnabled
}
            >
              CASHOUT
            </button>
            <button
              onClick={toggleAutoplay}
              className={`${autoplayEnabled ? 'bg-yellow-600' : 'bg-gray-600'} hover:bg-gray-500 text-white 
                font-bold py-3 px-4 rounded-lg text-lg ${gameOver ? 'opacity-70 cursor-not-allowed' : ''}`}
              disabled={gameOver}
            >
              {autoplayEnabled ? 'STOP AUTO' : 'AUTO PLAY'}
            </button>
            <button
              onClick={handleReset}
              className={`bg-green-600 hover:bg-green-700 text-white font-bold py-3 px-4 rounded-lg text-lg
                ${autoplayEnabled ? 'opacity-70 cursor-not-allowed' : ''}`}
              disabled={autoplayEnabled}
            >
              NEW GAME
            </button>
          </div>

          {/* Game status */}
          {gameOver && (
            <div className={`p-3 text-center rounded-lg text-lg ${hasWon ? 'bg-green-900' : 'bg-red-900'}`}>
              {hasWon
                ? `You won ${multiplier.toFixed(2)}x your bet!`
                : "Game Over! You hit a mine."}
            </div>
          )}
        </div>
      </div>
    </div>
  </div>
);

}