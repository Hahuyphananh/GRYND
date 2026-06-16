"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useUser } from "@clerk/nextjs";
import { usePostHog } from "posthog-js/react";
import NavigationBar from "../../../components/navigation-bar";
import { playCardDraw, playVictory, playDefeat } from "../../../lib/gameAudio";
import { KENO_MULTIPLIER_TABLE, KENO_MAX_PICKS, KENO_POOL_SIZE, KENO_DRAW_COUNT, KENO_AUTO_PICK_COUNT, calcKenoPayout } from "../../../lib/kenoMultipliers";

const QUICK_BETS = [
  { label: "½×", factor: 0.5 },
  { label: "2×", factor: 2 },
  { label: "Max", factor: -1 }, // -1 = use user balance
];

export default function KenoGame() {
  const router = useRouter();
  const { isSignedIn, user } = useUser();
  const posthog = usePostHog();

  const [betAmount, setBetAmount] = useState(100);
  const [selectedNumbers, setSelectedNumbers] = useState<number[]>([]);
  const [userBalance, setUserBalance] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [highlightedWins, setHighlightedWins] = useState<number[]>([]);
  const [animationDone, setAnimationDone] = useState(false);
  const [showRules, setShowRules] = useState(false);
  const [showWinScreen, setShowWinScreen] = useState(false);

  // Bet history
  const [roundHistory, setRoundHistory] = useState<{ picks: number; hits: number; payout: number; winningNumbers: number[] }[]>([]);

  const fetchUserBalance = async () => {
    if (!user) return;
    try {
      const res = await fetch("/api/get-user-tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
      });
      const data = await res.json();
      if (data.success) setUserBalance(Number(data.data.balance));
      else setError("Failed to fetch balance");
    } catch {
      setError("Unable to fetch balance");
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
      prev.includes(num) ? prev.filter((n) => n !== num) : prev.length < KENO_MAX_PICKS ? [...prev, num] : prev
    );
  };

  // Winning number reveal animation
  useEffect(() => {
    if (!result?.winningNumbers) return;

    setHighlightedWins([]);
    setAnimationDone(false);

    let i = 0;
    const interval = setInterval(() => {
      if (i >= result.winningNumbers.length) {
        clearInterval(interval);
        setAnimationDone(true);

        if (result.payout > 0) {
          setTimeout(() => setShowWinScreen(true), 400);
        }

        return;
      }
      setHighlightedWins((prev) => [...prev, result.winningNumbers[i]]);
      i++;
    }, 300);

    return () => clearInterval(interval);
  }, [result]);

  const handleAutoPick = () => {
    // Clear previous results when auto-picking
    setHighlightedWins([]);
    setResult(null);
    setAnimationDone(false);

    const pickCount = KENO_AUTO_PICK_COUNT;
    const picks: number[] = [];
    while (picks.length < pickCount) {
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

  const handleQuickBet = (factor: number) => {
    if (factor === -1 && userBalance !== null) {
      setBetAmount(userBalance);
    } else if (factor > 0) {
      const newBet = Math.max(1, Math.round(betAmount * factor));
      setBetAmount(newBet);
    }
  };

  const handleBet = async () => {
    setError(null);

    if (!isSignedIn) {
      router.push("/sign-in?redirect_url=/casino/keno");
      return;
    }
    if (betAmount <= 0) return setError("Bet must be more than 0");
    if (selectedNumbers.length < 1) return setError("Select at least 1 number");
    if (userBalance !== null && betAmount > userBalance) return setError("Not enough balance");

    setLoading(true);
    try {
      const res = await fetch("/api/keno/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
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

      // Add to round history
      setRoundHistory((prev) => [
        { picks: selectedNumbers.length, hits: data.matches.length, payout: data.payout, winningNumbers: data.winningNumbers },
        ...prev.slice(0, 9), // keep last 10 rounds
      ]);

      // Audio feedback
      if (data.payout > 0) {
        setTimeout(() => playVictory(), 500);
      } else {
        setTimeout(() => playDefeat(), 500);
      }
      playCardDraw();

      posthog?.capture("keno_game_started", { bet_amount: betAmount, numbers_count: selectedNumbers.length });
      if (data.payout > 0) {
        posthog?.capture("keno_game_ended", { result: "win", bet_amount: betAmount, payout: data.payout, matches: data.matches?.length ?? 0 });
      } else {
        posthog?.capture("keno_game_ended", { result: "loss", bet_amount: betAmount, payout: 0, matches: data.matches?.length ?? 0 });
      }
    } catch {
      setError("Error starting game");
    }
    setLoading(false);
  };

  const payoutTable = KENO_MULTIPLIER_TABLE[selectedNumbers.length] || {};

  // Estimated payout for a realistic hit scenario — clamps to nearest valid multiplier tier
  const table = selectedNumbers.length > 0 ? KENO_MULTIPLIER_TABLE[selectedNumbers.length] : null;
  const validHits = table ? Object.keys(table).map(Number).sort((a, b) => a - b) : [];
  const rawEstimate = Math.max(1, Math.floor(selectedNumbers.length * 0.35));
  const displayHits = validHits.find((h) => h >= rawEstimate) ?? validHits[0] ?? 0;
  const estimatedPayout = selectedNumbers.length > 0
    ? calcKenoPayout(selectedNumbers.length, displayHits, betAmount)
    : 0;
  const maxPossiblePayout = selectedNumbers.length > 0
    ? calcKenoPayout(selectedNumbers.length, selectedNumbers.length, betAmount)
    : 0;

  return (
    <div
      className="
relative flex min-h-screen flex-col items-center
overflow-x-hidden
bg-gradient-to-br from-[#001933] to-[#000d1a]

px-2 sm:px-4 md:px-6
pb-24 md:pb-8
pt-[76px]

text-white
"
    >
      <NavigationBar currentPath="/casino" />

      <div
        className="
absolute right-2 top-[82px]
sm:right-4 sm:top-24

rounded-xl
border border-[#00e5ff]/30
bg-[#0b224f]/90

px-2 py-1.5
sm:px-3 sm:py-2

text-xs sm:text-sm md:text-base
font-bold text-[#FFD700]

shadow-[0_0_12px_rgba(0,229,255,0.2)]
backdrop-blur-md
z-20
"
      >
        🪙 Balance: {userBalance ?? "..."}
      </div>

      <h1
        className="
text-2xl sm:text-3xl md:text-4xl
font-extrabold tracking-wider
text-transparent bg-clip-text
bg-gradient-to-r from-[#00e5ff] to-[#00ffa6]

mt-12 sm:mt-16 md:mt-20
mb-4 sm:mb-6
text-center
"
      >
        ⚡ KENO
      </h1>

      {error && <div className="bg-red-500/20 text-red-300 px-4 py-2 rounded mb-4">{error}</div>}

      <div
        className="
w-full max-w-5xl

bg-[#050d1f]/80
backdrop-blur-xl
border border-[#00e5ff]/40

shadow-[0_0_25px_rgba(0,229,255,0.25),inset_0_0_25px_rgba(0,229,255,0.08)]

p-3 sm:p-5
rounded-2xl

flex flex-col gap-3
mb-5 sm:mb-6
"
      >
        {/* Top row: bet + buttons */}
        <div className="flex flex-col sm:flex-row gap-3 items-stretch sm:items-end">
          {/* Bet Input */}
          <div className="flex flex-col gap-1">
            <label className="text-sm text-gray-300">Bet Amount</label>
            <input
              type="number"
              min={1}
              value={betAmount}
              onChange={(e) => setBetAmount(Number(e.target.value))}
              className="
bg-[#020617]
border border-[#00e5ff]/30

focus:border-[#00e5ff]
focus:shadow-[0_0_15px_rgba(0,229,255,0.6)]

rounded-xl

px-3 py-3
text-white
outline-none
transition-all duration-300

w-full sm:w-28
h-12
"
            />
          </div>

          {/* Quick-bet buttons */}
          {QUICK_BETS.map((qb) => (
            <button
              key={qb.label}
              onClick={() => handleQuickBet(qb.factor)}
              className="w-full sm:w-auto h-12 px-4 rounded-xl font-bold text-sm transition-all duration-300
                         bg-[#0d335f] text-[#a8f4ff] border border-[#00e5ff]/30
                         hover:bg-[#1a4a7a] hover:border-[#00e5ff]/60 hover:text-white active:scale-95"
            >
              {qb.label}
            </button>
          ))}

          <button
            onClick={handleBet}
            disabled={loading}
            className={`w-full sm:w-auto h-12 px-6 rounded-xl font-bold text-base sm:text-lg transition-all duration-300
  ${
    loading
      ? "bg-[#1a2333] text-gray-400 border border-gray-600"
      : "bg-gradient-to-r from-[#a855f7] to-[#ff4fd8] text-[#001933] border border-[#ff4fd8] shadow-[0_0_20px_#ff4fd8] hover:shadow-[0_0_35px_#a855f7] hover:scale-105"
  }
`}
          >
            {loading ? "Playing..." : "Bet"}
          </button>

          {/* Auto Pick */}
          <button
            onClick={handleAutoPick}
            className="w-full sm:w-auto h-12 px-5 rounded-xl font-bold text-sm sm:text-base transition-all duration-300
               bg-gradient-to-r from-[#00e5ff] to-[#00ffa6] text-[#001933]
               border border-[#00e5ff]
               shadow-[0_0_20px_rgba(0,229,255,0.6)]
               hover:shadow-[0_0_35px_rgba(0,255,166,1)] hover:scale-105"
          >
            AUTO PICK
          </button>

          {/* Clear */}
          <button
            onClick={handleClear}
            className="w-full sm:w-auto h-12 px-5 rounded-xl font-bold text-sm sm:text-base transition-all duration-300
               bg-[#1a2333] text-gray-400 border border-gray-600
               hover:bg-[#2a3446] hover:text-white"
          >
            CLEAR
          </button>
        </div>

        {/* Payout estimate */}
        {selectedNumbers.length > 0 && (
          <div className="text-center text-xs sm:text-sm text-gray-300 bg-[#020617]/60 rounded-lg py-2 px-3 border border-[#00e5ff]/15">
            Pick {selectedNumbers.length} — ~{displayHits} hit{displayHits !== 1 ? "s" : ""}:{" "}
            <span className="text-[#00ffa6] font-bold">{estimatedPayout > 0 ? `+${estimatedPayout} tokens` : "no payout"}</span>
            {maxPossiblePayout > estimatedPayout && (
              <span className="text-gray-500">
                {" "}· all {selectedNumbers.length}: <span className="text-[#00ffa6]/60">+{maxPossiblePayout}</span>
              </span>
            )}
          </div>
        )}
      </div>

      {/* Gameboard */}
      <div
        className="
w-full max-w-6xl

mb-6
bg-[#0b224f]/85

border-2 border-[#00e5ff]/35
rounded-2xl

shadow-[0_0_24px_rgba(0,229,255,0.2)]

p-2 sm:p-4 md:p-6

overflow-hidden
"
      >
        <div
          className="
flex flex-col lg:flex-row
gap-4 lg:gap-6
"
        >
          {/* Number grid */}
          <div
            className="
grid
grid-cols-5 xs:grid-cols-5 sm:grid-cols-6 md:grid-cols-8

gap-2 sm:gap-3 md:gap-4

flex-1
justify-items-center
"
          >
            {Array.from({ length: KENO_POOL_SIZE }, (_, i) => i + 1).map((num) => {
              const isSelected = selectedNumbers.includes(num);
              const isWinning = highlightedWins.includes(num);
              const isDisabled = !isSelected && selectedNumbers.length >= KENO_MAX_PICKS;
              const isMatch = isSelected && isWinning;
              const isDrawnNonMatch = isWinning && !isSelected;

              return (
                <button
                  key={num}
                  onClick={() => toggleNumber(num)}
                  disabled={isDisabled}
                  className={`

relative

w-12 h-12
sm:w-14 sm:h-14
md:w-16 md:h-16

flex items-center justify-center

rounded-xl

text-sm sm:text-base md:text-lg
font-bold

transition-all duration-300
overflow-hidden

touch-manipulation
select-none
active:scale-95

  ${
    isMatch
      ? "bg-[#00ffa6] text-[#001933] scale-110 ring-4 ring-[#00ffa6]/70 shadow-[0_0_30px_rgba(0,255,166,1)] animate-pulse"
      : isDrawnNonMatch
        ? "bg-[#00ffa6]/25 text-[#00ffa6]/80 border border-[#00ffa6]/40"
        : isSelected
          ? "bg-[#00e5ff] text-[#001933] shadow-[0_0_20px_rgba(0,229,255,0.8)] scale-105"
          : isDisabled
            ? "bg-[#002244] opacity-40 cursor-not-allowed"
            : "bg-[#020617] border border-[#00e5ff]/30 hover:border-[#00e5ff] hover:shadow-[0_0_15px_rgba(0,229,255,0.6)]"
  }`}
                >
                  {num}

                  {/* 🔥 Glow trail */}
                  {isWinning && (
                    <span className="absolute inset-0 bg-gradient-to-r from-transparent via-[#00ffa6]/60 to-transparent animate-[slide_0.6s_linear]" />
                  )}

                  {isMatch && <span className="absolute top-1 right-1 text-xs">🔥</span>}
                </button>
              );
            })}
          </div>

          {/* Multiplier panel */}
          <div
            className="
w-full lg:w-44

bg-[#020617]/80
backdrop-blur-xl
border border-[#00e5ff]/40
                rounded-xl p-4 flex flex-col gap-2
                shadow-[0_0_20px_rgba(0,229,255,0.2)] flex flex-col gap-2 shadow-[0_0_12px_rgba(0,229,255,0.15)]"
          >
            <h3
              className="text-center font-bold text-transparent bg-clip-text 
               bg-gradient-to-r from-[#00e5ff] to-[#00ffa6] mb-2"
            >
              Payouts
            </h3>

            {Object.entries(payoutTable).map(([hits, mult]) => {
              const isActive = animationDone && result?.matches?.length === Number(hits);

              return (
                <div
                  key={hits}
                  className={`flex justify-between px-2 py-1 rounded text-sm
                    ${isActive ? "bg-green-400 text-black font-bold" : "bg-[#0d335f]"}`}
                >
                  <span>
                    {hits} hit{hits !== "1" ? "s" : ""}
                  </span>
                  <span>×{mult}</span>
                </div>
              );
            })}

            {selectedNumbers.length === 0 && (
              <div className="text-xs text-gray-400 text-center mt-2">Select numbers</div>
            )}
          </div>
        </div>
      </div>

      {/* Result panel */}
      {result && (
        <div
          className="
w-full max-w-3xl

mt-2
bg-[#050d1f]/80
backdrop-blur-xl
border border-[#00e5ff]/40

p-4 rounded-xl

text-sm sm:text-base

shadow-[0_0_20px_rgba(0,229,255,0.2)]
"
        >
          <p>🎯 Drawn Numbers: {result.winningNumbers.join(", ")}</p>
          <p>✅ Matches: {result.matches.length} {result.matches.length > 0 && `(${result.matches.join(", ")})`}</p>
          <p>💰 Payout: {result.payout} tokens</p>
        </div>
      )}

      {/* Bet History */}
      {roundHistory.length > 0 && (
        <div
          className="
w-full max-w-3xl

mt-4
bg-[#0b224f]/85
border-2 border-[#00e5ff]/35

rounded-xl

p-3 sm:p-4

shadow-[0_0_20px_rgba(0,229,255,0.15)]
"
        >
          <h3 className="text-[#FFD700] font-bold text-lg mb-3">📋 Recent Rounds</h3>
          <div className="flex gap-2 overflow-x-auto pb-2">
            {roundHistory.map((round, i) => {
              const isWin = round.payout > 0;
              return (
                <div
                  key={i}
                  className={`flex-shrink-0 rounded-lg px-3 py-2 text-xs min-w-[130px] border ${
                    isWin ? "bg-green-900/30 border-green-500/30" : "bg-red-900/20 border-red-500/20"
                  }`}
                >
                  <div className="font-bold text-white mb-1">Pick {round.picks} • {round.hits} hit{round.hits !== 1 ? "s" : ""}</div>
                  <div className={isWin ? "text-green-400" : "text-red-400"}>
                    {isWin ? `+${round.payout}` : `− loss`}
                  </div>
                  <div className="text-gray-500 mt-1 truncate" title={round.winningNumbers.join(", ")}>
                    {round.winningNumbers.join(", ")}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Game Rules (Collapsible) */}
      <div
        className="
w-full max-w-4xl

mt-6

bg-[#0b224f]/85
border-2 border-[#00e5ff]/35

rounded-xl

p-3 sm:p-4

shadow-[0_0_20px_rgba(0,229,255,0.15)]
"
      >
        <button
          onClick={() => setShowRules(!showRules)}
          className="w-full text-left text-[#FFD700] font-bold text-lg flex justify-between items-center"
        >
          📜 Game Rules
          <span>{showRules ? "▲" : "▼"}</span>
        </button>

        {showRules && (
          <div className="mt-4 text-sm leading-relaxed space-y-3 text-gray-200">
            <p>
              🎯 <strong>Objective:</strong> Pick numbers and match them with randomly drawn numbers
              to win rewards.
            </p>

            <p>
              🔢 <strong>How to Play:</strong>
              <br />• Select between <strong>1 to {KENO_MAX_PICKS} numbers</strong> from the 1–40 grid. • Choose
              your bet amount. • Click <strong>"Bet"</strong> to start the round.
            </p>

            <p>
              🎲 <strong>Draw:</strong> {KENO_DRAW_COUNT} random numbers are drawn each round.
            </p>

            <p>
              🏆 <strong>Winning:</strong>
              <br />• The more of your selected numbers that match the drawn numbers, the higher
              your payout. • Payout multipliers depend on how many numbers you picked and how many
              matched.
            </p>

            <p>
              ⚠️ <strong>Important:</strong>
              <br />• You must select at least 1 number to play. • Maximum of {KENO_MAX_PICKS} numbers can be
              selected. • You cannot bet more than your available balance.
            </p>

            <p>
              🎮 <strong>Auto Pick:</strong> Automatically selects random numbers for you.
            </p>

            <p>
              🔄 <strong>Clear Table:</strong> Resets your selected numbers and current round.
            </p>
          </div>
        )}
      </div>

      {/* Win overlay */}
      {showWinScreen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-md">
          {/* Glow background */}
          <div className="absolute w-[400px] h-[400px] bg-[#00ffa6]/20 blur-3xl animate-pulse"></div>

          <div
            className="
relative

bg-[#050d1f]/90
border border-[#00e5ff]/40

shadow-[0_0_40px_rgba(0,229,255,0.4)]

rounded-2xl

p-5 sm:p-8

text-center

w-[92vw]
max-w-[320px]
"
          >
            <h2
              className="text-2xl font-extrabold mb-4 text-transparent bg-clip-text 
                     bg-gradient-to-r from-[#00e5ff] to-[#00ffa6]"
            >
              🎉 YOU WON
            </h2>

            <p className="text-lg text-white mb-2">
              Matches: <span className="text-[#00ffa6] font-bold">{result?.matches.length}</span>
            </p>

            <p className="text-xl font-bold text-[#00e5ff] drop-shadow-[0_0_12px_rgba(0,229,255,0.8)] mb-6">
              +{result?.payout} TOKENS
            </p>

            <button
              onClick={() => setShowWinScreen(false)}
              className="w-full py-3 rounded-xl font-bold transition-all duration-300
                   bg-gradient-to-r from-[#00e5ff] to-[#00ffa6] text-[#001933]
                   border border-[#00e5ff]
                   shadow-[0_0_20px_rgba(0,229,255,0.6)]
                   hover:shadow-[0_0_35px_rgba(0,255,166,1)] hover:scale-105"
            >
              CONTINUE
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
