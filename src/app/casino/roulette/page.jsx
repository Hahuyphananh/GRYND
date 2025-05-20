"use client";

import React, { useState, useEffect } from "react";
import { useUser } from "@clerk/nextjs";

function MainComponent() {
  const { data: user, isLoaded: userLoaded } = useUser();
  const [balance, setBalance] = useState(0);
  const [balanceLoading, setBalanceLoading] = useState(true);
  const [activeGame, setActiveGame] = useState("roulette");
  const [betAmount, setBetAmount] = useState(10);
  const [betType, setBetType] = useState("red");
  const [selectedNumber, setSelectedNumber] = useState(0);
  const [spinning, setSpinning] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [history, setHistory] = useState([]);
  const [highlightedNumbers, setHighlightedNumbers] = useState([]);
  const [currentSpinIndex, setCurrentSpinIndex] = useState(0);
  const [previousBalance, setPreviousBalance] = useState(null);
  const [balanceChangeVisible, setBalanceChangeVisible] = useState(false);
  const [stats, setStats] = useState({
    biggestWin: 0,
    totalBets: 0,
    totalWins: 0,
  });

  const rouletteNumbers = [
    0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5,
    24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26,
  ];

  const redNumbers = [
    1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36,
  ];

  const [spinningNumbers, setSpinningNumbers] = useState([]);
  const spinDuration = 3000;

  const animateRouletteWheel = (finalNumber) => {
    const animationSteps = 20;
    const stepDuration = spinDuration / animationSteps;
    let currentStep = 0;

    const interval = setInterval(() => {
      if (currentStep < animationSteps - 1) {
        const randomIndex = Math.floor(Math.random() * rouletteNumbers.length);
        setSpinningNumbers([rouletteNumbers[randomIndex]]);
        currentStep++;
      } else {
        setSpinningNumbers([finalNumber]);
        clearInterval(interval);
      }
    }, stepDuration);
  };

  useEffect(() => {
    const fetchBalance = async () => {
      if (!userLoaded || !user) return;

      try {
        const response = await fetch("/api/get-user-tokens", {
          method: "POST",
        });

        if (!response.ok) throw new Error("Failed to fetch balance");

        const data = await response.json();
        const balanceValue = data?.data?.balance;

        if (balanceValue !== undefined) {
          setBalance(balanceValue);
          setPreviousBalance(balanceValue);
        } else {
          const initRes = await fetch("/api/initialize-user-tokens", {
            method: "POST",
          });

          if (!initRes.ok) throw new Error("Failed to initialize tokens");

          const initData = await initRes.json();
          setBalance(initData.data.balance);
          setPreviousBalance(initData.data.balance);
        }
      } catch (err) {
        console.error("Balance error:", err);
        setError("Erreur lors de la récupération du solde");
      } finally {
        setBalanceLoading(false);
      }
    };

    fetchBalance();
  }, [user, userLoaded]);

  const handleSpin = async () => {
    if (spinning || balanceLoading || !user) return;
    if (betAmount <= 0 || betAmount > balance) {
      setError("Montant de mise invalide");
      return;
    }

    setSpinning(true);
    setError(null);
    setPreviousBalance(balance);
    setBalance(balance - betAmount);

    try {
      const debitRes = await fetch("/api/update-token-balance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount: -betAmount }),
      });

      if (!debitRes.ok) throw new Error("Échec du débit");

      const spinResult =
        rouletteNumbers[Math.floor(Math.random() * rouletteNumbers.length)];

      animateRouletteWheel(spinResult);
      await new Promise((resolve) => setTimeout(resolve, spinDuration));

      let win = false;
      let winAmount = 0;

      if (betType === "red" && redNumbers.includes(spinResult)) {
        win = true;
        winAmount = betAmount * 2;
      } else if (
        betType === "black" &&
        spinResult !== 0 &&
        !redNumbers.includes(spinResult)
      ) {
        win = true;
        winAmount = betAmount * 2;
      } else if (betType === "green" && spinResult === 0) {
        win = true;
        winAmount = betAmount * 35;
      } else if (
        betType === "even" &&
        spinResult !== 0 &&
        spinResult % 2 === 0
      ) {
        win = true;
        winAmount = betAmount * 2;
      } else if (
        betType === "odd" &&
        spinResult !== 0 &&
        spinResult % 2 !== 0
      ) {
        win = true;
        winAmount = betAmount * 2;
      } else if (betType === "number" && spinResult === selectedNumber) {
        win = true;
        winAmount = betAmount * 35;
      }

      if (win) {
        const creditRes = await fetch("/api/update-token-balance", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ amount: winAmount }),
        });

        if (!creditRes.ok) throw new Error("Échec du crédit");
        const creditData = await creditRes.json();
        setBalance(creditData.data.balance);
        setBalanceChangeVisible(true);
      }

      setResult({ number: spinResult, win, amount: winAmount });
      setHistory((prev) => [spinResult, ...prev].slice(0, 10));
      setHighlightedNumbers([spinResult]);

      setStats((prev) => ({
        biggestWin: win ? Math.max(prev.biggestWin, winAmount) : prev.biggestWin,
        totalBets: prev.totalBets + 1,
        totalWins: win ? prev.totalWins + 1 : prev.totalWins,
      }));
    } catch (err) {
      console.error(err);
      setBalance(previousBalance);
      setError(err.message || "Erreur lors de la transaction");
    } finally {
      setSpinning(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#003366] text-white">
      <div className="container mx-auto pt-24 max-w-4xl px-4">
        <a href="/casino" className="text-yellow-400 mb-4 inline-block">
          ← Retour au Casino
        </a>
        <h1 className="text-3xl font-bold mb-6 text-center">Roulette</h1>

        <p className="text-center text-xl mb-4">
          Balance: {balanceLoading ? "Loading..." : `${balance} tokens`}
        </p>

        <div className="mb-6 flex flex-wrap gap-4 justify-center">
          <div>
            <label className="text-sm">Mise</label>
            <input
              type="number"
              min="1"
              value={betAmount}
              onChange={(e) => setBetAmount(Number(e.target.value))}
              className="w-full border border-yellow-400 p-2 bg-[#00234D] text-white rounded"
            />
          </div>

          <div>
            <label className="text-sm">Type de Pari</label>
            <select
              value={betType}
              onChange={(e) => setBetType(e.target.value)}
              className="w-full border border-yellow-400 p-2 bg-[#00234D] text-white rounded"
            >
              <option value="red">Rouge</option>
              <option value="black">Noir</option>
              <option value="green">Vert (0)</option>
              <option value="even">Pair</option>
              <option value="odd">Impair</option>
              <option value="number">Numéro</option>
            </select>
          </div>

          {betType === "number" && (
            <div>
              <label className="text-sm">Numéro</label>
              <input
                type="number"
                min="0"
                max="36"
                value={selectedNumber}
                onChange={(e) => setSelectedNumber(Number(e.target.value))}
                className="w-full border border-yellow-400 p-2 bg-[#00234D] text-white rounded"
              />
            </div>
          )}
        </div>

        <div className="text-center">
          <button
            onClick={handleSpin}
            disabled={spinning || balanceLoading}
            className={`px-6 py-2 rounded border-2 border-yellow-400 ${
              spinning ? "bg-gray-600" : "bg-[#00234D] hover:bg-[#001830]"
            }`}
          >
            {spinning ? "Tourne..." : "Tourner la Roue!"}
          </button>
        </div>

        {result && (
          <div className="text-center mt-6 text-lg">
            Résultat: {result.number} —{" "}
            {result.win ? `Gagné ${result.amount} tokens!` : "Perdu"}
          </div>
        )}

        {error && (
          <div className="text-center text-red-400 mt-4">{error}</div>
        )}

        <div className="mt-8 text-center">
          <h2 className="text-xl font-semibold mb-2">Historique</h2>
          <div className="flex flex-wrap justify-center gap-2">
            {history.map((n, i) => (
              <div key={i} className="w-8 h-8 flex items-center justify-center rounded-full bg-[#00234D] border border-yellow-400">
                {n}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export default MainComponent;
