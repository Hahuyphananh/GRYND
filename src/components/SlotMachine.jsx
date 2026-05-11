"use client";
import NavigationBar from "../components/navigation-bar";
import React, { useState, useRef, useEffect } from "react";
import Link from "next/link";

/* =========================
   IMPORT YOUR 20 IMAGES HERE
   Replace paths with yours
========================= */
import img1 from "../images/01_watermelon.png";
import img2 from "../images/02_banana.png";
import img3 from "../images/03_pineapple.png";
import img4 from "../images/04_green_apple.png";
import img5 from "../images/05_strawberry.png";
import img6 from "../images/06_mango.png";
import img7 from "../images/07_melon.png";
import img8 from "../images/08_grapes.png";
import img9 from "../images/09_cherries.png";
import img10 from "../images/10_red_apple.png";
import img11 from "../images/11_orange.png";
import img12 from "../images/12_lemon.png";
import img13 from "../images/13_kiwi.png";
import img14 from "../images/14_pear.png";
import img15 from "../images/15_peach.png";
import img16 from "../images/16_coconut.png";
import img17 from "../images/17_tomato.png";
import img18 from "../images/18_eggplant.png";
import img19 from "../images/19_corn.png";
import img20 from "../images/20_sweet_potato.png";

/* map backend values -> images */
const symbolImages = {
  "💰": img1,
  "🍒": img2,
  "🍉": img3,
  "🍌": img4,
  "🍍": img5,
  "🍏": img6,
  "🍇": img7,
  "🍓": img8,
  "🍋": img9,
  "🥝": img10,
  "7️⃣": img11,
  "⭐": img12,
  "🔔": img13,
  "💎": img14,
  "🍊": img15,
  "🍎": img16,
  "🍑": img17,
  "🥭": img18,
  "🍐": img19,
  "🪙": img20,
};

const playSound = (freq = 880) => {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.frequency.value = freq;
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start();
  gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.3);
};

export default function SlotMachine() {
  const [reels, setReels] = useState(
    Array.from({ length: 5 }, () => Array(3).fill("💰")),
  );
  const [balance, setBalance] = useState(0);
  const [bet, setBet] = useState(100);
  const [lastResult, setLastResult] = useState("");
  const [totalWin, setTotalWin] = useState(0);
  const [totalLoss, setTotalLoss] = useState(0);
  const [autoSpinning, setAutoSpinning] = useState(false);
  const [spinning, setSpinning] = useState(false);
  const [flashWin, setFlashWin] = useState(false);
  const autoSpinRef = useRef(null);
  const [winningPositions, setWinningPositions] = useState([]);
  const [animatingReels, setAnimatingReels] = useState(Array(5).fill(false));
  const spinLockRef = useRef(false);

  useEffect(() => {
    const fetchTokens = async () => {
      try {
        const res = await fetch("/api/get-user-tokens", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
        });

        const data = await res.json();
        if (data.success) setBalance(parseFloat(data.data.balance));
      } catch (err) {
        setLastResult("❌ Failed to load balance");
      }
    };

    fetchTokens();
  }, []);

  const handleBetChange = (e) => {
    const value = parseInt(e.target.value);
    if (!isNaN(value) && value > 0) {
      setBet(Math.min(value, balance));
    }
  };

  const handleSpin = async () => {
    if (spinLockRef.current) return;
    spinLockRef.current = true;

    setWinningPositions([]);

    if (balance < bet) {
      setLastResult("❌ Not enough balance.");
      return;
    }

    setSpinning(true);
    setAnimatingReels(Array(5).fill(true));

    try {
      const res = await fetch("/api/slots/play", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bet }),
      });

      const json = await res.json();
      if (!json.success) throw new Error(json.error);

      const { reels: newReels, winAmount, newBalance, winningLine } = json.data;

      await fetch("/api/slots/save-game", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          betAmount: bet,
          payout: winAmount,
          reels: newReels.flat(),
        }),
      });

      setTimeout(() => {
        setAnimatingReels(Array(5).fill(false));
        setReels(newReels);

        playSound(
          winAmount >= bet * 5 ? 1200 : winAmount >= bet * 2 ? 1000 : 700,
        );

        setSpinning(false);
        spinLockRef.current = false;

        if (winAmount > 0) {
          setFlashWin(true);
          setTimeout(() => setFlashWin(false), 800);
        }

        setLastResult(
          winAmount >= bet * 5
            ? "🎉 JACKPOT!"
            : winAmount >= bet * 2
              ? "✅ Match!"
              : "❌ No match.",
        );

        if (winningLine?.positions) {
          setWinningPositions(winningLine.positions);
        }

        setBalance(newBalance);
        setTotalWin((prev) => prev + winAmount);
        if (winAmount === 0) setTotalLoss((prev) => prev + bet);
      }, 1500);
    } catch (err) {
      setSpinning(false);
      spinLockRef.current = false;
      setLastResult("❌ Error playing slot");
    }
  };

  const startAutoSpin = () => {
    if (autoSpinning) return;
    setAutoSpinning(true);
    autoSpinRef.current = setInterval(handleSpin, 2000);
  };

  const stopAutoSpin = () => {
    setAutoSpinning(false);
    clearInterval(autoSpinRef.current);
  };

  const setMaxBet = () => {
    setBet(Math.min(1000, balance));
  };

  /* REPLACE ONLY YOUR CURRENT RETURN JSX WITH THIS */

  return (
    <div className="min-h-screen bg-[#060612] text-white relative overflow-hidden">
      <NavigationBar currentPath="/casino" />

      {/* BACKGROUND */}
      <div className="absolute inset-0 pointer-events-none z-0 bg-[radial-gradient(circle_at_50%_10%,rgba(0,255,255,0.15),transparent_35%),radial-gradient(circle_at_80%_70%,rgba(255,0,255,0.12),transparent_30%),radial-gradient(circle_at_20%_90%,rgba(0,140,255,0.10),transparent_30%)]" />

      <div className="relative z-10 pt-24 px-6">
        {/* TITLE */}
        <h1 className="text-center text-5xl font-black tracking-widest mb-8 text-cyan-300 drop-shadow-[0_0_18px_cyan]">
          FRUIT FORTUNE
        </h1>

        {/* TOP BUTTON */}
        <div className="flex justify-center mb-6">
          <Link href="/casino/slots">
            <button className="px-6 py-2 rounded-full border border-cyan-400 bg-black hover:bg-cyan-500/10 transition shadow-[0_0_12px_cyan]">
              ⬅ Return to Lobby
            </button>
          </Link>
        </div>

        {/* MAIN LAYOUT */}
        <div className="flex flex-col xl:flex-row items-start justify-center gap-8">
          {/* LEFT SIDE SLOT */}
          <div className="flex flex-col items-center">
            {/* SLOT MACHINE BIGGER */}
            <div className="relative p-6 rounded-[30px] border-2 border-cyan-400 bg-[#0d1020] shadow-[0_0_45px_rgba(0,255,255,0.45)]">
              <div className="absolute inset-0 rounded-[30px] border border-pink-500 pointer-events-none animate-pulse opacity-40" />

              {flashWin && (
                <div className="absolute inset-0 bg-cyan-400/20 rounded-[30px] animate-flash pointer-events-none" />
              )}

              {/* REELS BIGGER */}
              <div className="flex gap-3 bg-[#05070d] p-5 rounded-2xl border border-cyan-500 shadow-inner">
                {reels.map((column, colIdx) => {
                  const symbols = animatingReels[colIdx]
                    ? [...column, ...column, ...column]
                    : column;

                  return (
                    <div
                      key={colIdx}
                      className="w-[118px] h-[330px] rounded-xl overflow-hidden border border-cyan-400 bg-gradient-to-b from-[#161a2f] to-[#090b15]"
                    >
                      <div
                        className={`flex flex-col ${
                          animatingReels[colIdx]
                            ? "animate-[scrollReel_0.18s_linear_infinite]"
                            : ""
                        }`}
                      >
                        {symbols.map((fruit, rowIdx) => {
                          const isWinning = winningPositions.some(
                            (p) => p.col === colIdx && p.row === rowIdx,
                          );

                          return (
                            <div
                              key={`${fruit}-${colIdx}-${rowIdx}`}
                              className={`relative w-full h-[110px] flex items-center justify-center border-b border-cyan-900 transition-all duration-300
  ${
    isWinning
      ? "bg-gradient-to-br from-yellow-300 via-pink-400 to-cyan-300 scale-110 z-10 shadow-[0_0_30px_#fff,0_0_50px_#ff00ff] animate-matchPulse"
      : "bg-[#11162a]"
  }`}
                            >
                              {/* WIN SPARKLES */}
                              {isWinning && (
                                <div className="absolute inset-0 rounded-md border-2 border-white animate-pulse opacity-80" />
                              )}

                              <img
                                src={symbolImages[fruit]?.src || img1.src}
                                alt="symbol"
                                draggable="false"
                                className={`w-full h-full object-contain p-2 transition-all duration-300
    ${isWinning ? "drop-shadow-[0_0_25px_white]" : ""}`}
                              />
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* LEVER */}
              <div className="absolute -right-8 top-20 flex flex-col items-center">
                <div className="w-3 h-32 bg-gray-300 rounded-full" />
                <div className="w-12 h-12 rounded-full bg-pink-500 shadow-[0_0_22px_#ff00ff]" />
              </div>
            </div>

            {/* BUTTONS */}
            <div className="flex flex-wrap justify-center gap-4 mt-8 mb-10">
              <button
                onClick={handleSpin}
                disabled={spinning}
                className="px-10 py-4 rounded-full bg-cyan-400 text-black font-black text-xl hover:scale-105 transition shadow-[0_0_20px_cyan] disabled:opacity-50"
              >
                SPIN
              </button>

              {!autoSpinning ? (
                <button
                  onClick={startAutoSpin}
                  className="px-6 py-3 rounded-full bg-pink-500 font-bold shadow-[0_0_15px_#ff00ff]"
                >
                  AUTO SPIN
                </button>
              ) : (
                <button
                  onClick={stopAutoSpin}
                  className="px-6 py-3 rounded-full bg-red-600 font-bold"
                >
                  STOP AUTO
                </button>
              )}

              <button
                onClick={setMaxBet}
                className="px-6 py-3 rounded-full bg-green-400 text-black font-bold shadow-[0_0_15px_lime]"
              >
                MAX BET
              </button>
            </div>
          </div>

          {/* RIGHT SIDE PANEL */}
          <div className="w-[340px] rounded-2xl p-6 border border-cyan-500 bg-[#0c1020]/95 space-y-4 shadow-[0_0_25px_rgba(0,255,255,0.18)]">
            <div className="text-2xl font-black text-cyan-300 mb-2">
              PLAYER PANEL
            </div>

            <div className="flex justify-between items-center">
              <span>Bet Amount</span>
              <input
                type="number"
                min="1"
                max={balance}
                value={bet}
                onChange={handleBetChange}
                className="w-28 px-3 py-1 rounded bg-black text-cyan-300 border border-cyan-400 outline-none"
              />
            </div>

            <div className="flex justify-between">
              <span>Balance</span>
              <span className="text-green-400 font-bold">
                ${balance.toFixed(2)}
              </span>
            </div>

            <div className="flex justify-between">
              <span>Total Won</span>
              <span className="text-cyan-300 font-bold">
                ${totalWin.toFixed(2)}
              </span>
            </div>

            <div className="flex justify-between">
              <span>Total Lost</span>
              <span className="text-pink-400 font-bold">
                ${totalLoss.toFixed(2)}
              </span>
            </div>

            <div className="pt-4 text-center text-xl font-bold text-yellow-300 min-h-[40px]">
              {lastResult}
            </div>
          </div>
        </div>
      </div>

      <style jsx>{`
        @keyframes scrollReel {
          0% {
            transform: translateY(0);
          }
          100% {
            transform: translateY(-33.33%);
          }
        }

        @keyframes flash {
          0%,
          100% {
            opacity: 0;
          }
          50% {
            opacity: 1;
          }
        }

        .animate-flash {
          animation: flash 0.25s linear 5;
        }
        @keyframes matchPulse {
          0%,
          100% {
            transform: scale(1.05);
            filter: brightness(1);
          }
          50% {
            transform: scale(1.12);
            filter: brightness(1.35);
          }
        }

        .animate-matchPulse {
          animation: matchPulse 0.6s ease-in-out infinite;
        }
      `}</style>
    </div>
  );
}
