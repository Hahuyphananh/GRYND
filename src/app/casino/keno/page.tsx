'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useUser } from '@clerk/nextjs';
import NavigationBar from "../../../components/navigation-bar";

const multiplierTable: Record<number, Record<number, number>> = {
  1: { 1: 3 },
  2: { 1: 1.5, 2: 6 },
  3: { 1: 1.2, 2: 3, 3: 12 },
  4: { 2: 2, 3: 6, 4: 20 },
  5: { 2: 2, 3: 5, 4: 15, 5: 50 },
};

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
    } catch {
      setError('Unable to fetch balance');
    }
  };

  useEffect(() => {
    if (isSignedIn) fetchUserBalance();
  }, [isSignedIn]);

  const toggleNumber = (num: number) => {
    if (highlightedWins.length > 0) {
      setHighlightedWins([]);
      setResult(null);
    }

    setSelectedNumbers((prev) =>
      prev.includes(num)
        ? prev.filter((n) => n !== num)
        : prev.length < 5
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
    }, 300);

    return () => clearInterval(interval);
  }, [result]);

  const handleAutoPick = () => {
    const picks: number[] = [];
    while (picks.length < 5) {
      const rand = Math.floor(Math.random() * 40) + 1;
      if (!picks.includes(rand)) picks.push(rand);
    }
    setSelectedNumbers(picks);
  };

  const handleClear = () => {
  setSelectedNumbers([]);
  setHighlightedWins([]);
  setResult(null);
  setAnimationDone(false);
};


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
    } catch {
      setError('Error starting game');
    }
    setLoading(false);
  };

  const payoutTable = multiplierTable[selectedNumbers.length] || {};

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

        <button onClick={handleAutoPick} className="bg-gray-600 px-4 py-1 rounded hover:bg-gray-500">
          Auto Pick
        </button>
        <button onClick={handleClear} className="bg-gray-600 px-4 py-1 rounded hover:bg-gray-500">
          Clear Table
        </button>
      </div>

      {/* Gameboard */}
      <div className="mb-6 bg-[#001a33] border-4 border-yellow-500 rounded-2xl shadow-2xl p-6">
        <div className="flex gap-6">

          {/* Number grid */}
          <div className="grid grid-cols-8 gap-4 flex-1">
            {Array.from({ length: 40 }, (_, i) => i + 1).map((num) => {
              const isSelected = selectedNumbers.includes(num);
              const isWinning = highlightedWins.includes(num);
              const isDisabled = !isSelected && selectedNumbers.length >= 5;
              const isMatch = isSelected && isWinning;

              return (
        <button
  key={num}
  onClick={() => toggleNumber(num)}
  disabled={isDisabled}
  className={`relative w-16 h-16 flex items-center justify-center rounded-xl text-lg font-bold transition-all duration-300
    ${
      isMatch
        ? 'bg-green-400 text-black scale-110 ring-4 ring-green-300 shadow-[0_0_25px_6px_rgba(34,197,94,0.9)] animate-pulse'
        : isWinning
        ? 'bg-green-400/40 text-white'
        : isSelected
        ? 'bg-yellow-400 text-black shadow-md scale-105'
        : isDisabled
        ? 'bg-[#002244] opacity-40 cursor-not-allowed'
        : 'bg-[#003366] hover:bg-[#0055aa] border border-[#0066cc]'
    }`}
>
  {num}

  {isMatch && (
    <span className="absolute top-1 right-1 text-xs">
      🔥
    </span>
  )}
</button>


              );
            })}
          </div>

          {/* Multiplier panel */}
          <div className="w-40 bg-[#002244] border-2 border-yellow-400 rounded-xl p-3 flex flex-col gap-2">
            <h3 className="text-center font-bold text-yellow-400 mb-2">Payouts</h3>

            {Object.entries(payoutTable).map(([hits, mult]) => {
              const isActive =
                animationDone && result?.matches?.length === Number(hits);

              return (
                <div
                  key={hits}
                  className={`flex justify-between px-2 py-1 rounded text-sm
                    ${
                      isActive
                        ? 'bg-green-400 text-black font-bold'
                        : 'bg-[#003366]'
                    }`}
                >
                  <span>{hits} hit{hits !== '1' ? 's' : ''}</span>
                  <span>x{mult}</span>
                </div>
              );
            })}

            {selectedNumbers.length === 0 && (
              <div className="text-xs text-gray-400 text-center mt-2">
                Select numbers
              </div>
            )}
          </div>

        </div>
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
