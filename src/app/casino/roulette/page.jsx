"use client";

import React, { useState, useEffect } from "react";

function RoulettePage() {
  const [betAmount, setBetAmount] = useState(10);
  const [betType, setBetType] = useState("red");
  const [selectedNumber, setSelectedNumber] = useState(0);
  const [spinning, setSpinning] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [history, setHistory] = useState([]);
  const [userTokens, setUserTokens] = useState(0); // user tokens balance
  const [loading, setLoading] = useState(false);
  const [highlightedNumbers, setHighlightedNumbers] = useState([]);
  const [stats, setStats] = useState({
    biggestWin: 0,
    totalBets: 0,
    totalWins: 0,
  });
  const [spinningNumbers, setSpinningNumbers] = useState([]);

  const rouletteNumbers = [
    0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23,
    10, 5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26,
  ];

  const redNumbers = [
    1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36,
  ];

  const spinDuration = 3000;

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

const handleSpin = async () => {
  if (spinning) return;

  if (betAmount <= 0) {
    setError("Montant de mise invalide");
    return;
  }

  if (betAmount > userTokens) {
    setError("Solde insuffisant pour cette mise");
    return;
  }

  setSpinning(true);
  setError(null);

  const spinResult =
    rouletteNumbers[Math.floor(Math.random() * rouletteNumbers.length)];

  animateRouletteWheel(spinResult);
  await new Promise((resolve) => setTimeout(resolve, spinDuration));

  // Determine win/loss
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
  } else if (betType === "even" && spinResult !== 0 && spinResult % 2 === 0) {
    win = true;
    winAmount = betAmount * 2;
  } else if (betType === "odd" && spinResult !== 0 && spinResult % 2 !== 0) {
    win = true;
    winAmount = betAmount * 2;
  } else if (betType === "number" && spinResult === selectedNumber) {
    win = true;
    winAmount = betAmount * 35;
  }

  // Update backend token balance (deduct bet)
  try {
    const resDeduct = await fetch("/api/tokens/update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amount: -betAmount }),
    });
    console.log("Erreur lors de la requête POST vers /api/tokens/update", resDeduct.status);

    if (!resDeduct.ok) throw new Error("Échec de la mise à jour des tokens.");
    setUserTokens((prev) => prev - betAmount); // apply locally after success
  } catch (err) {
    setError(err.message || "Erreur réseau lors de la mise à jour du solde.");
    setSpinning(false);
    return;
  }

  // If win, add reward
  if (win) {
    try {
      const resWin = await fetch("/api/tokens/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount: winAmount }),
      });
      if (!resWin.ok) throw new Error("Erreur lors de l'ajout du gain.");
      setUserTokens((prev) => prev + winAmount); // apply locally after success
    } catch (err) {
      setError(err.message || "Erreur lors du crédit des gains.");
    }
  }

  // Show result and update stats
  setResult({ number: spinResult, win, amount: winAmount });
  setHistory((prev) => [spinResult, ...prev].slice(0, 10));
  setHighlightedNumbers([spinResult]);
  setStats((prev) => ({
    biggestWin: win ? Math.max(prev.biggestWin, winAmount) : prev.biggestWin,
    totalBets: prev.totalBets + 1,
    totalWins: win ? prev.totalWins + 1 : prev.totalWins,
  }));

  setSpinning(false);
};



  return (
    <div className="min-h-screen bg-gradient-to-br from-[#001933] to-[#000d1a] text-white">
      <div className="container mx-auto pt-24 px-4">
        <div className="flex flex-col items-center justify-center">
          <div className="bg-[#0a1e3a] rounded-2xl p-10 shadow-2xl w-full max-w-5xl border border-yellow-400/30">
            <div className="mb-6">
              <a
                href="/casino"
                className="inline-flex items-center text-yellow-400 hover:text-yellow-300 transition"
              >
                <svg
                  className="w-6 h-6 mr-2"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M10 19l-7-7m0 0l7-7m-7 7h18"
                  />
                </svg>
                Retour au Casino
              </a>
            </div>

            <h1 className="text-4xl font-bold text-center mb-10 text-yellow-400 tracking-wide drop-shadow-lg">
              🎰 Roulette Royale
            </h1>
            <p className="text-lg font-semibold">🪙 Tokens: {userTokens}</p>

            <div className="flex flex-wrap gap-6 justify-center mb-10">
              <div>
                <label className="block text-sm font-medium text-yellow-300 mb-1">
                  Mise
                </label>
                <input
                  type="number"
                  min="1"
                  value={betAmount}
                  onChange={(e) => setBetAmount(Number(e.target.value))}
                  className="block w-32 rounded-md border-2 border-yellow-400 bg-[#102542] text-white px-3 py-2 focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-yellow-300 mb-1">
                  Type de Pari
                </label>
                <select
                  value={betType}
                  onChange={(e) => setBetType(e.target.value)}
                  className="block w-40 rounded-md border-2 border-yellow-400 bg-[#102542] text-white px-3 py-2 focus:outline-none"
                >
                  <option value="red">Rouge</option>
                  <option value="black">Noir</option>
                  <option value="green">Vert (0)</option>
                  <option value="even">Pair</option>
                  <option value="odd">Impair</option>
                  <option value="number">Numéro Spécifique</option>
                </select>
              </div>

              {betType === "number" && (
                <div>
                  <label className="block text-sm font-medium text-yellow-300 mb-1">
                    Sélectionner un Numéro
                  </label>
                  <input
                    type="number"
                    min="0"
                    max="36"
                    value={selectedNumber}
                    onChange={(e) => setSelectedNumber(Number(e.target.value))}
                    className="block w-32 rounded-md border-2 border-yellow-400 bg-[#102542] text-white px-3 py-2 focus:outline-none"
                  />
                </div>
              )}
            </div>

            <div className="grid grid-cols-6 gap-3 justify-center mb-10">
              {rouletteNumbers.map((number) => (
                <div
                  key={number}
                  className={`w-14 h-14 flex items-center justify-center rounded-full text-lg font-bold border-2 border-yellow-400 shadow-md transition-all duration-300 ${
                    number === 0
                      ? "bg-green-500"
                      : redNumbers.includes(number)
                      ? "bg-red-600"
                      : "bg-black"
                  } ${
                    spinning && spinningNumbers.includes(number)
                      ? "scale-110 ring-4 ring-yellow-300"
                      : highlightedNumbers.includes(number)
                      ? "ring-4 ring-yellow-400"
                      : ""
                  }`}
                >
                  {number}
                </div>
              ))}
            </div>

            <div className="text-center">
              <button
                onClick={handleSpin}
                disabled={spinning}
                className={`px-8 py-3 rounded-full text-white font-bold uppercase tracking-wide transition-all border-2 border-yellow-400 shadow-lg ${
                  spinning
                    ? "bg-gray-600 cursor-not-allowed"
                    : "bg-yellow-400 hover:bg-yellow-300 text-black"
                }`}
              >
                {spinning ? "La roue tourne..." : "Tourner la Roue!"}
              </button>
            </div>

            {result && (
              <div className="mt-6 text-center text-white">
                <p className="text-xl font-bold">
                  Résultat: <span className="text-yellow-300">{result.number}</span>
                  {result.win
                    ? ` - Vous avez gagné ${result.amount} tokens! 🎉`
                    : " - Perdu, essayez encore!"}
                </p>
              </div>
            )}

            {error && (
              <div className="mt-4 text-center text-red-400 font-semibold">{error}</div>
            )}

            <div className="mt-10">
              <h2 className="text-xl font-bold mb-4 text-yellow-300 text-center">
                Historique des Tours
              </h2>
              <div className="flex flex-wrap gap-2 justify-center">
                {history.map((spin, index) => (
                  <div
                    key={index}
                    className={`w-8 h-8 flex items-center justify-center rounded-full border-2 border-yellow-400 text-sm ${
                      spin === 0
                        ? "bg-green-500"
                        : redNumbers.includes(spin)
                        ? "bg-red-600"
                        : "bg-black"
                    }`}
                  >
                    {spin}
                  </div>
                ))}
              </div>
            </div>

            <div className="mt-10 grid grid-cols-3 gap-6 text-white text-center">
              <div>
                <p className="font-semibold text-yellow-300">Plus gros gain</p>
                <p>{stats.biggestWin} tokens</p>
              </div>
              <div>
                <p className="font-semibold text-yellow-300">Paris totaux</p>
                <p>{stats.totalBets}</p>
              </div>
              <div>
                <p className="font-semibold text-yellow-300">Victoires</p>
                <p>{stats.totalWins}</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default RoulettePage;
