"use client";
import React from "react";

function MainComponent() {
  const { data: user, loading: userLoading } = useUser();
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
      if (!user) {
        setBalanceLoading(false);
        return;
      }

      try {
        const response = await fetch("/api/get-user-tokens", {
          method: "POST",
        });
        if (!response.ok) {
          throw new Error("Failed to fetch balance");
        }
        const data = await response.json();

        if (data?.data?.balance !== undefined) {
          setBalance(data.data.balance);
          setPreviousBalance(data.data.balance);
        } else {
          const initResponse = await fetch("/api/initialize-user-tokens", {
            method: "POST",
          });
          if (!initResponse.ok) {
            throw new Error("Failed to initialize tokens");
          }
          const initData = await initResponse.json();
          setBalance(initData.data.balance);
          setPreviousBalance(initData.data.balance);
        }
      } catch (err) {
        console.error("Error fetching balance:", err);
        setError("Erreur lors de la récupération du solde");
      } finally {
        setBalanceLoading(false);
      }
    };

    if (user) {
      fetchBalance();
    }
  }, [user]);

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
      const debitResponse = await fetch("/api/update-token-balance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount: -betAmount }),
      });

      if (!debitResponse.ok) {
        throw new Error("Échec du débit");
      }

      const debitData = await debitResponse.json();
      if (!debitData.success) {
        throw new Error(debitData.error || "Échec du débit");
      }

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

      if (winAmount > 0) {
        const creditResponse = await fetch("/api/update-token-balance", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ amount: winAmount }),
        });

        if (!creditResponse.ok) {
          throw new Error("Échec du crédit");
        }

        const creditData = await creditResponse.json();
        if (!creditData.success) {
          throw new Error(creditData.error || "Échec du crédit");
        }

        setBalance(creditData.data.balance);
        setBalanceChangeVisible(true);
      }

      setResult({
        number: spinResult,
        win,
        amount: winAmount,
      });

      setHistory((prev) => [spinResult, ...prev].slice(0, 10));
      setHighlightedNumbers([spinResult]);

      setStats((prev) => ({
        biggestWin: win
          ? Math.max(prev.biggestWin, winAmount)
          : prev.biggestWin,
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
    <div className="min-h-screen bg-[#003366]">
      <div className="container mx-auto pt-24">
        <div className="flex flex-col items-center justify-center">
          <div className="bg-[#00234D] rounded-lg p-8 shadow-lg w-full max-w-4xl">
            <div className="mb-6">
              <a
                href="/casino"
                className="inline-flex items-center text-yellow-400 hover:text-yellow-300"
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

            <h1 className="text-3xl font-bold text-center mb-8 text-white">
              Roulette
            </h1>

            <div className="text-center mb-6">
              <div className="relative">
                <p className="text-xl text-white">
                  Balance:{" "}
                  {balanceLoading ? (
                    "Loading..."
                  ) : (
                    <>
                      <span className="inline-block min-w-[60px] text-right">
                        {balance} tokens
                      </span>
                      {balanceChangeVisible && (
                        <span
                          className={`absolute ml-2 ${
                            balance > previousBalance
                              ? "text-green-400"
                              : "text-red-400"
                          }`}
                          onAnimationEnd={() => setBalanceChangeVisible(false)}
                        >
                          {balance > previousBalance ? "+" : ""}
                          {balance - previousBalance}
                        </span>
                      )}
                    </>
                  )}
                </p>
              </div>
            </div>

            <div className="flex flex-wrap gap-4 justify-center mb-6">
              <div>
                <label className="block text-sm font-medium text-white">
                  Mise
                </label>
                <input
                  type="number"
                  min="1"
                  value={betAmount}
                  onChange={(e) => setBetAmount(Number(e.target.value))}
                  className="mt-1 block w-full rounded-md border-yellow-400 border-2 bg-[#00234D] text-white"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-white">
                  Type de Pari
                </label>
                <select
                  value={betType}
                  onChange={(e) => setBetType(e.target.value)}
                  className="mt-1 block w-full rounded-md border-yellow-400 border-2 bg-[#00234D] text-white"
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
                  <label className="block text-sm font-medium text-white">
                    Sélectionner un Numéro
                  </label>
                  <input
                    type="number"
                    min="0"
                    max="36"
                    value={selectedNumber}
                    onChange={(e) => setSelectedNumber(Number(e.target.value))}
                    className="mt-1 block w-full rounded-md border-yellow-400 border-2 bg-[#00234D] text-white"
                  />
                </div>
              )}
            </div>

            <div className="mb-6">
              <div className="grid grid-cols-6 gap-2">
                {rouletteNumbers.map((number) => (
                  <div
                    key={number}
                    className={`p-4 text-center rounded-full border-2 border-yellow-400 transition-transform duration-300 ${
                      number === 0
                        ? "bg-green-600 text-white"
                        : redNumbers.includes(number)
                        ? "bg-red-600 text-white"
                        : "bg-[#00234D] text-white"
                    } ${
                      spinning && spinningNumbers.includes(number)
                        ? "scale-110 ring-4 ring-yellow-400"
                        : highlightedNumbers.includes(number)
                        ? "ring-4 ring-yellow-400"
                        : ""
                    }`}
                  >
                    {number}
                  </div>
                ))}
              </div>
            </div>

            <div className="text-center">
              <button
                onClick={handleSpin}
                disabled={spinning || balanceLoading}
                className={`px-6 py-3 rounded-full text-white font-bold border-2 border-yellow-400 ${
                  spinning ? "bg-gray-600" : "bg-[#00234D] hover:bg-[#001830]"
                }`}
              >
                {spinning ? "La roue tourne..." : "Tourner la Roue!"}
              </button>
            </div>

            {result && (
              <div className="mt-6 text-center text-white">
                <p className="text-xl font-bold">
                  Résultat: {result.number}
                  {result.win
                    ? ` - Vous avez gagné ${result.amount} tokens!`
                    : " - Perdu, essayez encore!"}
                </p>
              </div>
            )}

            {error && (
              <div className="mt-4 text-center text-red-400">{error}</div>
            )}

            <div className="mt-8">
              <h2 className="text-xl font-bold mb-4 text-white">
                Historique des Tours
              </h2>
              <div className="flex flex-wrap gap-2 justify-center">
                {history.map((spin, index) => (
                  <div
                    key={index}
                    className={`w-8 h-8 flex items-center justify-center rounded-full border-2 border-yellow-400 ${
                      spin === 0
                        ? "bg-green-600"
                        : redNumbers.includes(spin)
                        ? "bg-red-600"
                        : "bg-[#00234D]"
                    } text-white text-sm`}
                  >
                    {spin}
                  </div>
                ))}
              </div>
            </div>
            <div className="mt-8 grid grid-cols-3 gap-4 text-white">
              <div className="text-center">
                <p className="font-bold">Plus gros gain</p>
                <p>{stats.biggestWin} tokens</p>
              </div>
              <div className="text-center">
                <p className="font-bold">Paris totaux</p>
                <p>{stats.totalBets}</p>
              </div>
              <div className="text-center">
                <p className="font-bold">Victoires</p>
                <p>{stats.totalWins}</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default MainComponent;