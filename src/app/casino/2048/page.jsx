'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useUser } from '@clerk/nextjs'; // ✅ Added for Clerk auth
import GameBoard from '../../../components/GameBoard';

export default function GamePage() {
  const router = useRouter();
  const { isSignedIn, user } = useUser();

  const [betAmount, setBetAmount] = useState(10);
  const [movesLeft, setMovesLeft] = useState(100);
  const [gameId, setGameId] = useState(null);
  const [userTokens, setUserTokens] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    setMovesLeft(betAmount * 10);
  }, [betAmount]);

  // ✅ Fetch tokens 
  const fetchUserTokens = async () => {
    if (!user) return;
    try {
      const response = await fetch("/api/get-user-tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
      });
      const data = await response.json();
      if (data.success) {
        setUserTokens(data.data.balance);
      } else {
        throw new Error(data.error || "Erreur inconnue");
      }
    } catch (err) {
      console.error("Error fetching tokens:", err);
      setError("Impossible de récupérer votre solde de tokens");
    }
  };

  useEffect(() => {
    if (isSignedIn && user) {
      fetchUserTokens();
    }
  }, [isSignedIn, user]);

  const handleStartGame = async () => {
    if (!isSignedIn) {
      router.push("/sign-in?redirect_url=/casino/2048");
      return;
    }

    const res = await fetch('/api/create-2048-game', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ betAmount }),
    });
    const data = await res.json();
    setGameId(data.gameId);

    // ✅ Refresh tokens after starting a game
    await fetchUserTokens();
  };

  return (
    <div className="min-h-screen bg-[#003366] text-white flex flex-col items-center justify-center p-6 relative">
      {/* Return to Casino Button */}
      <button
        onClick={() => router.push('/casino')}
        className="absolute top-4 left-4 bg-gray-700 hover:bg-gray-800 text-white px-4 py-2 rounded shadow"
      >
        ⬅ Return to Casino
      </button>

      {/* ✅ Token Display */}
      <div className="absolute top-4 right-4 bg-[#0055aa] px-4 py-2 rounded-lg shadow text-yellow-400 font-bold">
        🪙 Tokens: {userTokens !== null ? userTokens : "..."}
      </div>

      <h1 className="text-3xl font-bold mb-6 text-yellow-400">🎰 2048 Casino Challenge</h1>

      {error && (
        <div className="mb-4 rounded bg-red-500/10 p-3 text-red-500">{error}</div>
      )}

      {!gameId ? (
        <div className="bg-white bg-opacity-10 p-6 rounded-lg shadow-lg flex flex-col items-center">
          <label className="block mb-2 text-lg">Bet Amount ($):</label>
          <input
            type="number"
            value={betAmount}
            onChange={(e) => setBetAmount(parseInt(e.target.value) || 1)}
            min={1}
            className="border border-gray-300 text-black px-3 py-2 rounded mb-4 w-32 text-center"
          />
          <button
            onClick={handleStartGame}
            className="bg-yellow-500 hover:bg-yellow-600 text-black font-bold px-6 py-2 rounded shadow-lg"
          >
            Start Game
          </button>
        </div>
      ) : (
        <div className="flex flex-col items-center mt-4">
          <p className="mb-4">Moves Left: {movesLeft}</p>
          <GameBoard
  gameId={gameId}
  movesLeft={movesLeft}
  setMovesLeft={setMovesLeft} // Pass setter
/>

        </div>
      )}
    </div>
  );
}
