'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useUser } from '@clerk/nextjs';
import NavigationBar from "../../../components/navigation-bar";

export default function KenoGame() {
  const router = useRouter();
  const { isSignedIn, user } = useUser();

  const [betAmount, setBetAmount] = useState(1);
  const [selectedNumbers, setSelectedNumbers] = useState<number[]>([]);
  const [userBalance, setUserBalance] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [highlightedWins, setHighlightedWins] = useState<number[]>([]);
const [animationDone, setAnimationDone] = useState(false);

const fetchUserBalance = async () => {
    if (!user) return;
    try {
      const res = await fetch('/api/get-user-tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const data = await res.json();
      if (data.success) setUserBalance(Number(data.data.balance));
      else setError('Failed to fetch balance');
    } catch (err) {
      console.error(err);
      setError('Unable to fetch balance');
    }
  };

  useEffect(() => {
    if (isSignedIn) fetchUserBalance();
  }, [isSignedIn]);

  const toggleNumber = (num: number) => {
    setSelectedNumbers((prev) =>
      prev.includes(num)
        ? prev.filter((n) => n !== num)
        : prev.length < 10
        ? [...prev, num]
        : prev
    );
  };

  useEffect(() => {
  if (!result?.winningNumbers) return;

  setHighlightedWins([]);
  setAnimationDone(false);

  let i = 0;
  const interval = setInterval(() => {
    if (i >= result.winningNumbers.length) {
      clearInterval(interval);
      setAnimationDone(true);
      return;
    }
    setHighlightedWins((prev) => [...prev, result.winningNumbers[i]]);
    i++;
  }, 300); // 300ms between each highlight

  return () => clearInterval(interval);
}, [result]);


  const handleAutoPick = () => {
    const picks: number[] = [];
    while (picks.length < 5) { // auto pick 5 numbers max
      const rand = Math.floor(Math.random() * 40) + 1;
      if (!picks.includes(rand)) picks.push(rand);
    }
    setSelectedNumbers(picks);
  };

  const handleClear = () => setSelectedNumbers([]);

  const handleBet = async () => {
    setError(null);

    if (!isSignedIn) {
      router.push('/sign-in?redirect_url=/casino/keno');
      return;
    }
    if (betAmount <= 0) return setError('Bet must be more than 0');
    if (selectedNumbers.length < 1) return setError('Select at least 1 number');
    if (userBalance !== null && betAmount > userBalance)
      return setError('Not enough balance');

    setLoading(true);
    try {
      const res = await fetch('/api/keno/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ betAmount, numbers: selectedNumbers }),
      });
      const data = await res.json();

      if (data.error) {
        setError(data.error);
        setLoading(false);
        return;
      }

      setResult(data);
      await fetchUserBalance();
    } catch (err) {
      console.error(err);
      setError('Error starting game');
    }
    setLoading(false);
  };

  return (
    <div className="min-h-screen bg-[#003366] text-white flex flex-col items-center p-6 relative">
<NavigationBar currentPath="/casino" />

      <div className="absolute top-4 right-4 bg-[#0055aa] px-4 py-2 rounded-lg shadow text-yellow-400 font-bold">
        🪙 Balance: {userBalance ?? '...'}
      </div>

      <h1 className="text-3xl font-bold mb-6 text-yellow-400 mt-12">🎯 Keno</h1>

      {error && (
        <div className="bg-red-500/20 text-red-300 px-4 py-2 rounded mb-4">
          {error}
        </div>
      )}

      <div className="mb-4 flex gap-4 items-center">
        <div>
          <label>Bet Amount:</label>
          <input
            type="number"
            min={1}
            value={betAmount}
            onChange={(e) => setBetAmount(Number(e.target.value))}
            className="text-black rounded px-2 py-1 w-20"
          />
        </div>

        <button
          onClick={handleAutoPick}
          className="bg-gray-600 px-4 py-1 rounded hover:bg-gray-500"
        >
          Auto Pick
        </button>
        <button
          onClick={handleClear}
          className="bg-gray-600 px-4 py-1 rounded hover:bg-gray-500"
        >
          Clear Table
        </button>
      </div>

      {/* Number grid */}
      <div className="grid grid-cols-8 gap-2 mb-4">
        {Array.from({ length: 40 }, (_, i) => i + 1).map((num) => {
          const isSelected = selectedNumbers.includes(num);
const isWinning = highlightedWins.includes(num);

          return (
            <button
              key={num}
              onClick={() => toggleNumber(num)}
              className={`w-12 h-12 flex items-center justify-center rounded
  ${
    isWinning
      ? 'bg-green-400 text-black animate-pulse' // winning highlight + pulse animation
      : isSelected
      ? 'bg-yellow-400 text-black'
      : 'bg-[#002244] hover:bg-[#004488]'
  }`}

            >
              {num}
            </button>
          );
        })}
      </div>

      <button
        onClick={handleBet}
        disabled={loading}
        className="bg-yellow-500 hover:bg-yellow-600 text-black font-bold px-6 py-2 rounded shadow-lg"
      >
        {loading ? 'Playing...' : 'Bet'}
      </button>

      {result && (
        <div className="mt-6 bg-white/10 p-4 rounded">
          <p>🎯 Winning Numbers: {result.winningNumbers.join(', ')}</p>
          <p>✅ Matches: {result.matches.length}</p>
          <p>💰 Payout: {result.payout} tokens</p>
        </div>
      )}
    </div>
  );

  
}

