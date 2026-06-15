"use client";
import NavigationBar from "../components/navigation-bar";
import React, { useState, useRef, useEffect, useCallback, useMemo } from "react";
import Link from "next/link";
import { playCardDraw, playVictory, playDefeat, playTick } from "../lib/gameAudio";
import { usePostHog } from "posthog-js/react";
import { CHIP_VALUES } from "../lib/rouletteConfig";
import { getTheme } from "../lib/slotThemes.jsx";

// ─── Audio helpers (Web Audio API, same context as gameAudio) ──────────
let _audioCtx = null;
function getAudioCtx() {
  if (typeof window === "undefined") return null;
  if (!_audioCtx) {
    try { _audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch { return null; }
  }
  if (_audioCtx.state === "suspended") _audioCtx.resume();
  return _audioCtx;
}
function tone(freq, dur, type, vol) {
  const ctx = getAudioCtx(); if (!ctx) return;
  const o = ctx.createOscillator(); const g = ctx.createGain();
  o.type = type || "sine"; o.frequency.value = freq;
  g.gain.setValueAtTime(vol || 0.08, ctx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
  o.connect(g).connect(ctx.destination); o.start(); o.stop(ctx.currentTime + dur);
}
function playSpinSound() {
  // Two overlapping sawtooth tones — repeats every 1s to match ~2s spin duration (std mode)
  tone(160, 1.0, "sawtooth", 0.04);
  tone(140, 1.0, "sawtooth", 0.03);
  setTimeout(() => { tone(160, 0.9, "sawtooth", 0.04); tone(140, 0.9, "sawtooth", 0.03); }, 950);
}
function playReelStop() { tone(600, 0.06, "square", 0.05); setTimeout(() => tone(400, 0.04, "square", 0.04), 40); }

// ─── Sub-components ────────────────────────────────────────────────────

function SlotSymbol({ symbol, svgMap, fallback, className }) {
  const svgContent = svgMap[symbol] || svgMap[fallback];
  return <svg className={className} viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">{svgContent}</svg>;
}

function JackpotConfetti() {
  const particles = useMemo(() => {
    const colors = ["#FFD700","#FF6B6B","#4ECDC4","#FFE66D","#A78BFA","#FF69B4"];
    return Array.from({ length: 30 }).map((_, i) => ({
      id: i, left: `${Math.random()*100}%`, top: `${Math.random()*100}%`,
      w: `${6+Math.random()*14}px`, h: `${6+Math.random()*14}px`,
      bg: colors[i%6], delay: `${Math.random()*2}s`, dur: `${1+Math.random()*2}s`,
    }));
  }, []);
  return particles.map(p => <div key={p.id} className="absolute rounded-full animate-ping"
    style={{ left:p.left, top:p.top, width:p.w, height:p.h, backgroundColor:p.bg, animationDelay:p.delay, animationDuration:p.dur }} />);
}

function CoinSplash() {
  const coins = useMemo(() => {
    const emojis = ["🪙","💵","💎","💰","✨"];
    return Array.from({ length: 18 }).map((_, i) => ({
      id: i, emoji: emojis[i%5],
      x: `${30+Math.random()*40}%`, y: `${40+Math.random()*20}%`,
      tx: `${(Math.random()-0.5)*300}px`, ty: `${-80-Math.random()*200}px`,
      delay: `${Math.random()*0.3}s`, dur: `${0.8+Math.random()*0.6}s`,
    }));
  }, []);
  return coins.map(c => (
    <span key={c.id} className="absolute text-xl pointer-events-none z-30 animate-coinSplash"
      style={{ left:c.x, top:c.y, animationDelay:c.delay, animationDuration:c.dur,
        '--tx':c.tx, '--ty':c.ty }}>{c.emoji}</span>
  ));
}

function PaylineOverlay({ winningLine, themeConfig }) {
  if (!winningLine || !winningLine.positions || winningLine.positions.length < 3) return null;
  const { positions, line: lineName } = winningLine;    const PAD = 20; // p-5 container padding
    const GAP = 12;
    const REEL_W = 118; // reel width
    const SYM_H = 110;
  const colors = { top: "#00ffff", middle: "#ff00ff", bottom: "#ffff00", "v-shape": "#ff8c00", "inverted-v": "#00ff88" };
  const color = colors[lineName] || "#ff00ff";
  const pts = positions.map(p => {
    const cx = PAD + p.col * (REEL_W + GAP) + REEL_W / 2;
    const cy = PAD + p.row * SYM_H + SYM_H / 2;
    return `${cx},${cy}`;
  });
  const d = `M${pts.join(" L")}`;
  return (
    <svg className="absolute inset-0 pointer-events-none z-20" xmlns="http://www.w3.org/2000/svg">
      <path d={d} stroke={color} strokeWidth="5" fill="none" strokeLinecap="round" strokeLinejoin="round"
        className="drop-shadow-[0_0_12px_currentColor]"
        style={{ strokeDasharray: "2000", strokeDashoffset: "2000", animation: "drawLine 0.6s ease-out forwards" }} />
    </svg>
  );
}

function WinCounter({ target, className }) {
  const [display, setDisplay] = useState(0);
  useEffect(() => {
    if (target <= 0) { setDisplay(0); return; }
    const start = performance.now(); const from = 0; const dur = 800;
    let raf;
    const tick = (now) => {
      const p = Math.min((now - start) / dur, 1);
      const eased = 1 - Math.pow(1 - p, 3); // ease-out cubic
      setDisplay(Math.round(from + (target - from) * eased));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target]);
  return <span className={className}>{display.toLocaleString()}</span>;
}

function GambleModal({ pendingWin, onGamble, onCollect, themeConfig }) {
  const [choice, setChoice] = useState(null);
  const [result, setResult] = useState(null); // 'win' | 'lose'
  const [flipping, setFlipping] = useState(false);
  const handlePick = (color) => {
    setChoice(color);
    setFlipping(true);
    setTimeout(() => {
      const won = Math.random() < 0.5;
      setResult(won ? "win" : "lose");
      setTimeout(() => onGamble(won ? pendingWin * 2 : 0), 1500);
    }, 600);
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70">
      <div className={`rounded-2xl p-6 border-2 ${themeConfig.borderColor} bg-[#0d1020] text-white max-w-sm w-full shadow-[0_0_40px_rgba(255,215,0,0.3)]`}>
        {!choice ? (
          <>
            <h3 className="text-xl font-black text-center mb-2">🎲 GAMBLE?</h3>
            <p className="text-center text-white/60 text-sm mb-4">Double or lose your {pendingWin.toLocaleString()} win?</p>
            <div className="flex gap-4 justify-center mb-4">
              <button onClick={() => handlePick("red")}
                className="px-6 py-8 rounded-xl bg-red-600 hover:bg-red-500 font-black text-lg shadow-[0_0_15px_red] transition">🔴 RED</button>
              <button onClick={() => handlePick("black")}
                className="px-6 py-8 rounded-xl bg-gray-800 hover:bg-gray-700 font-black text-lg shadow-[0_0_15px_white] transition">⚫ BLACK</button>
            </div>
            <button onClick={onCollect} className="w-full py-2 rounded-lg bg-green-500/20 border border-green-400/40 text-green-300 hover:bg-green-500/30 transition text-sm">
              Collect {pendingWin.toLocaleString()}
            </button>
          </>
        ) : flipping ? (
          <div className="text-center py-8">
            <div className="text-6xl animate-spin mb-4">{choice === "red" ? "🔴" : "⚫"}</div>
            <p className="text-white/60">Flipping...</p>
          </div>
        ) : (
          <div className="text-center py-6">
            <div className="text-6xl mb-4">{result === "win" ? "🎉" : "💀"}</div>
            <h3 className={`text-2xl font-black ${result === "win" ? "text-green-400" : "text-red-400"}`}>
              {result === "win" ? `+${(pendingWin * 2).toLocaleString()}!` : "LOST!"}
            </h3>
          </div>
        )}
      </div>
    </div>
  );
}

function PaytableModal({ onClose, themeConfig, symbols, svgMap }) {
  const paylineDiagrams = [
    { name: "Top Line", rows: [0,0,0,0,0], color: "#00ffff" },
    { name: "Middle Line", rows: [1,1,1,1,1], color: "#ff00ff" },
    { name: "Bottom Line", rows: [2,2,2,2,2], color: "#ffff00" },
    { name: "V-Shape", rows: [0,1,2,1,0], color: "#ff8c00" },
    { name: "Inverted V", rows: [2,1,0,1,2], color: "#00ff88" },
  ];
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80" onClick={onClose}>
      <div className={`rounded-2xl p-6 border-2 ${themeConfig.borderColor} bg-[#0d1020] text-white max-w-lg w-full max-h-[85vh] overflow-y-auto shadow-[0_0_40px_rgba(0,255,255,0.2)]`}
        onClick={e => e.stopPropagation()}>
        <div className="flex justify-between items-center mb-4">
          <h2 className={`text-2xl font-black ${themeConfig.titleColor}`}>{themeConfig.name} — Paytable</h2>
          <button onClick={onClose} className="text-white/50 hover:text-white text-2xl">✕</button>
        </div>
        <div className="mb-4">
          <h3 className="text-sm font-bold text-white/60 uppercase tracking-wider mb-2">Paylines</h3>
          <div className="grid grid-cols-5 gap-1">
            {paylineDiagrams.map(pl => (
              <div key={pl.name} className="text-center">
                <svg viewBox="0 0 60 40" className="w-full h-10">
                  {[0,1,2].map(row =>
                    [0,1,2,3,4].map(col =>
                      <circle key={`${row}-${col}`} cx={6+col*12} cy={6+row*13} r="2.5" fill="#ffffff20" />
                    )
                  )}
                  <path d={`M6,${6+pl.rows[0]*13} L18,${6+pl.rows[1]*13} L30,${6+pl.rows[2]*13} L42,${6+pl.rows[3]*13} L54,${6+pl.rows[4]*13}`}
                    stroke={pl.color} strokeWidth="2" fill="none" strokeLinecap="round" />
                </svg>
                <p className="text-[10px] text-white/40 mt-0.5">{pl.name}</p>
              </div>
            ))}
          </div>
        </div>
        <div>
          <h3 className="text-sm font-bold text-white/60 uppercase tracking-wider mb-2">Payouts</h3>
          <div className="grid grid-cols-4 gap-1.5">
            {symbols.slice(0, 12).map(s => (
              <div key={s} className="flex items-center gap-1.5 bg-white/5 rounded-lg px-2 py-1.5">
                <SlotSymbol symbol={s} svgMap={svgMap} fallback={symbols[0]} className="w-[22px] h-[22px]" />
                <span className="text-[10px] text-white/60">3:{themeConfig.rtp>=90?"3×":"2×"} 4:{themeConfig.rtp>=90?"4×":"3×"} 5:{themeConfig.rtp>=90?"6×":"5×"}</span>
              </div>
            ))}
          </div>
          <p className="text-[10px] text-white/30 mt-3">5 of a kind wins the full Progressive Jackpot! 🎉</p>
          <p className="text-[10px] text-white/30">RTP: {themeConfig.rtp}%</p>
        </div>
      </div>
    </div>
  );
}

function AutoplaySettings({ settings, onChange, onClose, themeConfig }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div className={`rounded-xl p-5 border ${themeConfig.borderColor} bg-[#0d1020] text-white max-w-xs w-full shadow-[0_0_25px_rgba(0,255,255,0.15)]`}
        onClick={e => e.stopPropagation()}>
        <h3 className="font-black text-lg mb-3">⚙ Auto-Spin Settings</h3>
        <div className="space-y-3 text-sm">
          <label className="flex items-center justify-between gap-2">
            <span>Max spins</span>
            <input type="number" min="0" value={settings.maxSpins||""} onChange={e => onChange({...settings, maxSpins: parseInt(e.target.value)||0})}
              className="w-20 px-2 py-1 rounded bg-black border border-white/20 text-cyan-300 text-right" placeholder="∞" />
          </label>
          <label className="flex items-center justify-between gap-2">
            <span>Stop if win &gt;</span>
            <input type="number" min="0" value={settings.stopOnWin||""} onChange={e => onChange({...settings, stopOnWin: parseInt(e.target.value)||0})}
              className="w-20 px-2 py-1 rounded bg-black border border-white/20 text-cyan-300 text-right" placeholder="off" />
          </label>
          <label className="flex items-center justify-between gap-2">
            <span>Stop if balance &lt;</span>
            <input type="number" min="0" value={settings.stopOnBalance||""} onChange={e => onChange({...settings, stopOnBalance: parseInt(e.target.value)||0})}
              className="w-20 px-2 py-1 rounded bg-black border border-white/20 text-cyan-300 text-right" placeholder="off" />
          </label>
        </div>
        <button onClick={onClose} className="w-full mt-4 py-2 rounded-lg bg-cyan-400/20 border border-cyan-400/40 text-cyan-300 hover:bg-cyan-400/30 transition text-sm">Done</button>
      </div>
    </div>
  );
}

// ─── Main Component ────────────────────────────────────────────────────

export default function SlotMachine({ theme = "fruit" }) {
  const themeConfig = getTheme(theme);
  const svgMap = themeConfig.svgMap;
  const defaultSymbol = themeConfig.defaultSymbol;

  // Core game state
  const [reels, setReels] = useState(Array.from({ length: 5 }, () => Array(3).fill(defaultSymbol)));
  const [balance, setBalance] = useState(0);
  const [betPerLine, setBetPerLine] = useState(20); // bet per line
  const lines = 5;
  const bet = betPerLine * lines; // total bet
  const [lastResult, setLastResult] = useState("");
  const [totalWin, setTotalWin] = useState(0);
  const [totalLoss, setTotalLoss] = useState(0);
  const [autoSpinning, setAutoSpinning] = useState(false);
  const [spinning, setSpinning] = useState(false);
  const [flashWin, setFlashWin] = useState(false);
  const autoSpinRef = useRef(null);
  const [winningPositions, setWinningPositions] = useState([]);
  const [winningLine, setWinningLine] = useState(null);
  const [animatingReels, setAnimatingReels] = useState(Array(5).fill(false));
  const spinLockRef = useRef(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [spinHistory, setSpinHistory] = useState([]);
  const [showHistory, setShowHistory] = useState(false);
  const [jackpot, setJackpot] = useState(0);
  const [jackpotCelebration, setJackpotCelebration] = useState(false);
  const [jackpotWonAmount, setJackpotWonAmount] = useState(0);

  // Tier 1 states
  const [celebrationTier, setCelebrationTier] = useState(null); // null | 'small' | 'medium' | 'big' | 'mega'
  const [nearMiss, setNearMiss] = useState(false);
  const [winCounterTarget, setWinCounterTarget] = useState(0);
  const [showCoins, setShowCoins] = useState(false);
  const [reelStopped, setReelStopped] = useState(Array(5).fill(false)); // for bounce animation

  // Tier 2 states
  const [lossStreak, setLossStreak] = useState(0);
  const [freeSpins, setFreeSpins] = useState(0);
  const [freeSpinActive, setFreeSpinActive] = useState(false);
  const [showGamble, setShowGamble] = useState(false);
  const [pendingWin, setPendingWin] = useState(0);
  const [showPaytable, setShowPaytable] = useState(false);
  const [turboMode, setTurboMode] = useState(false);
  const [showAutoplaySettings, setShowAutoplaySettings] = useState(false);
  const [autoplaySettings, setAutoplaySettings] = useState({ maxSpins: 0, stopOnWin: 0, stopOnBalance: 0, spinsRemaining: 0 });

  // Tier 3 states
  const [candleFlashing, setCandleFlashing] = useState(false);

  const posthog = usePostHog();
  const componentMountedRef = useRef(true);
  const handleSpinRef = useRef(null);
  const reelTimeoutIds = useRef([]);

  // Cleanup on unmount
  useEffect(() => {
    componentMountedRef.current = true;
    return () => {
      componentMountedRef.current = false;
      if (autoSpinRef.current) clearInterval(autoSpinRef.current);
      reelTimeoutIds.current.forEach(clearTimeout);
      reelTimeoutIds.current = [];
    };
  }, []);

  // Auto-stop when balance drops below bet
  useEffect(() => {
    if (autoSpinning && balance < bet) {
      stopAutoSpin();
      setLastResult("⏹ Auto-spin stopped — insufficient balance");
    }
  }, [balance, bet, autoSpinning]);

  const fetchJackpot = useCallback(async () => {
    try {
      const res = await fetch(`/api/slots/jackpot?theme=${theme}`);
      const data = await res.json();
      if (data.success) setJackpot(Number(data.data.amount) || 0);
    } catch { /* silent */ }
  }, [theme]);

  useEffect(() => {
    const fetchTokens = async () => {
      try {
        const res = await fetch("/api/get-user-tokens", { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include" });
        const data = await res.json();
        if (data.success) setBalance(parseFloat(data.data.balance));
      } catch { setLastResult("❌ Failed to load balance"); }
    };
    fetchTokens();
    fetchJackpot();
  }, [fetchJackpot]);

  const handleBetChange = (e) => {
    const value = parseInt(e.target.value);
    if (e.target.value === "") setBetPerLine(0);
    else if (!isNaN(value) && value >= 0) setBetPerLine(value);
  };

  const handleSpin = useCallback(async (isFreeSpin = false) => {
    if (spinLockRef.current) return;
    spinLockRef.current = true;

    setError(null);
    setWinningPositions([]);
    setWinningLine(null);
    setNearMiss(false);
    setCelebrationTier(null);
    setWinCounterTarget(0);
    setShowCoins(false);
    setReelStopped(Array(5).fill(false));

    if (!isFreeSpin && balance < bet) {
      setLastResult("❌ Not enough balance.");
      spinLockRef.current = false;
      return;
    }

    // Play spin sound
    playSpinSound();
    setLoading(true);
    setSpinning(true);
    setAnimatingReels(Array(5).fill(true));
    setFreeSpinActive(isFreeSpin);

    try {
      const res = await fetch("/api/slots/play", {
        method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include",
        body: JSON.stringify({ bet, theme, freeSpin: isFreeSpin }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error);

      const { reels: newReels, winAmount, newBalance, winningLine: wl, jackpotWon: didWinJackpot, jackpotAmount: wonJackpotAmount } = json.data;

      fetch("/api/slots/save-game", {
        method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include",
        body: JSON.stringify({ betAmount: isFreeSpin ? 0 : bet, payout: winAmount, reels: newReels.flat() }),
      }).catch(() => {});

      const tBase = turboMode ? 200 : 800;
      const tStagger = turboMode ? 50 : 200;

      reelTimeoutIds.current = [];
      [0, 1, 2, 3, 4].forEach((col, i) => {
        const id = setTimeout(() => {
          if (!componentMountedRef.current) return;
          setAnimatingReels(prev => { const n = [...prev]; n[col] = false; return n; });
          setReelStopped(prev => { const n = [...prev]; n[col] = true; return n; });
          playReelStop();
        }, tBase + i * tStagger);
        reelTimeoutIds.current.push(id);
      });

      const finalId = setTimeout(() => {
        if (!componentMountedRef.current) return;
        setReels(newReels);
        setSpinning(false);
        spinLockRef.current = false;
        setLoading(false);
        setFreeSpinActive(false);

        if (winAmount > 0) {
          setFlashWin(true);
          setTimeout(() => setFlashWin(false), 800);
          setWinCounterTarget(winAmount);
          setShowCoins(true);
          setTimeout(() => setShowCoins(false), 2500);
          setCandleFlashing(true);
          setTimeout(() => setCandleFlashing(false), 3000);
        }

        // ── Celebration tiers ──
        let tierUsed = null;
        const multiplier = winAmount / (bet || 1);
        if (didWinJackpot) {
          tierUsed = "mega";
          setCelebrationTier("mega");
          setJackpotCelebration(true);
          setJackpotWonAmount(wonJackpotAmount || 0);
          setLastResult(`🎉 JACKPOT! +${(wonJackpotAmount || 0).toLocaleString()} tokens!`);
          const cid = setTimeout(() => { if (componentMountedRef.current) setJackpotCelebration(false); }, 6000);
          reelTimeoutIds.current.push(cid);
        } else if (multiplier >= 50) {
          tierUsed = "mega";
          setCelebrationTier("mega");
          setLastResult(`🌟 MEGA WIN! +${winAmount.toLocaleString()}`);
        } else if (multiplier >= 5) {
          tierUsed = "big";
          setCelebrationTier("big");
          setLastResult(`🔥 BIG WIN! +${winAmount.toLocaleString()}`);
        } else if (multiplier >= 2) {
          tierUsed = "medium";
          setCelebrationTier("medium");
          setLastResult(`✨ NICE WIN! +${winAmount.toLocaleString()}`);
        } else if (winAmount > 0) {
          tierUsed = "small";
          setCelebrationTier("small");
          setLastResult(`✅ +${winAmount.toLocaleString()}`);
        } else {
          // Near miss check: 4 of 5
          if (wl && wl.positions && wl.positions.length === 4) {
            setNearMiss(true);
            setTimeout(() => setNearMiss(false), 2500);
            setLastResult("😱 SO CLOSE!");
          } else {
            setLastResult("❌ No match.");
          }
        }

        // ── Free spins / loss streak ──
        if (winAmount > 0) {
          setLossStreak(0);
          // Show gamble option
          setPendingWin(winAmount);
          setShowGamble(true);
        } else {
          setLossStreak(prev => prev + 1);
        }

        // ── Audio ──
        if (multiplier >= 5) { playVictory(); playCardDraw(); }
        else if (winAmount > 0) { playCardDraw(); }
        else { playDefeat(); }

        if (wl?.positions) {
          setWinningPositions(wl.positions);
          setWinningLine(wl);
        }

        setBalance(newBalance);
        setTotalWin(prev => prev + winAmount);
        if (winAmount === 0 && !isFreeSpin) setTotalLoss(prev => prev + bet);

        setSpinHistory(prev => [
          { reels: newReels, bet: isFreeSpin ? 0 : bet, winAmount, won: winAmount > 0,
            jackpot: didWinJackpot || winAmount >= bet * 5, ts: Date.now(), freeSpin: isFreeSpin },
          ...prev,
        ].slice(0, 20));

        fetchJackpot();          // Set celebration tier ref directly (avoid stale useEffect sync)
          celebrationTierActual.current = tierUsed;

          posthog?.capture("slots_spin_result", {
          theme, bet: isFreeSpin ? 0 : bet, win_amount: winAmount, won: winAmount > 0,
          jackpot: didWinJackpot || winAmount >= bet * 5,
          jackpot_amount: didWinJackpot ? wonJackpotAmount : 0,
          celebration_tier: celebrationTierActual.current,
          free_spin: isFreeSpin,
        });

        // Auto-spin stop conditions
        if (autoSpinning) {
          let shouldStop = false;
          const s = autoplaySettingsRef.current;
          if (s.spinsRemaining > 0) {
            const newRemaining = s.spinsRemaining - 1;
            setAutoplaySettings(prev => ({ ...prev, spinsRemaining: newRemaining }));
            if (newRemaining <= 0) shouldStop = true;
          }
          if (s.stopOnWin > 0 && winAmount >= s.stopOnWin) shouldStop = true;
          if (s.stopOnBalance > 0 && newBalance < s.stopOnBalance) shouldStop = true;
          if (shouldStop) stopAutoSpin();
        }
      }, tBase + 5 * tStagger + (turboMode ? 200 : 400));
      reelTimeoutIds.current.push(finalId);
    } catch (err) {
      if (!componentMountedRef.current) return;
      setSpinning(false); setAnimatingReels(Array(5).fill(false));
      spinLockRef.current = false; setLoading(false); setFreeSpinActive(false);
      setLastResult("❌ Error playing slot");
      setError(err.message || "Network error");
    }
  }, [balance, bet, posthog, theme, fetchJackpot, turboMode, autoSpinning]);

  // Ref for celebration tier in PostHog (set directly in timeout to avoid stale reads)
  const celebrationTierActual = useRef(null);
  const autoplaySettingsRef = useRef(autoplaySettings);
  useEffect(() => { autoplaySettingsRef.current = autoplaySettings; }, [autoplaySettings]);

  useEffect(() => { handleSpinRef.current = handleSpin; }, [handleSpin]);

  // Free spins trigger
  useEffect(() => {
    if (lossStreak >= 10 && !spinning && !spinLockRef.current) {
      setFreeSpins(prev => prev + 1);
      setLossStreak(0);
      setLastResult("🎁 FREE SPIN AWARDED! 10 losses in a row.");
    }
  }, [lossStreak, spinning]);

  // Auto-use free spins
  useEffect(() => {
    if (freeSpins > 0 && !spinning && !spinLockRef.current && componentMountedRef.current) {
      const id = setTimeout(() => {
        if (spinLockRef.current) return; // Don't waste free spin if manual spin is in progress
        setFreeSpins(prev => prev - 1);
        handleSpinRef.current && handleSpinRef.current(true);
      }, 1200);
      return () => clearTimeout(id);
    }
  }, [freeSpins, spinning]);

  const startAutoSpin = useCallback(() => {
    if (autoSpinning || balance < bet) return;
    setAutoSpinning(true);
    setAutoplaySettings(prev => ({ ...prev, spinsRemaining: prev.maxSpins }));
    autoSpinRef.current = setInterval(() => {
      handleSpinRef.current && handleSpinRef.current();
    }, turboMode ? 1200 : 2500);
  }, [autoSpinning, balance, bet, turboMode]);

  const stopAutoSpin = useCallback(() => {
    setAutoSpinning(false);
    if (autoSpinRef.current) { clearInterval(autoSpinRef.current); autoSpinRef.current = null; }
  }, []);

  const handleGambleResult = (newWinAmount) => {
    setShowGamble(false);
    if (newWinAmount > 0) {
      // Win was already added in handleSpin — just add the extra half (diff)
      const diff = newWinAmount - pendingWin;
      setTotalWin(prev => prev + diff);
      setBalance(prev => prev + diff);
      setLastResult(`🎲 GAMBLE WON! +${newWinAmount.toLocaleString()}`);
      playVictory();
    } else {
      // Revert the original win that was already added in handleSpin
      setTotalWin(prev => prev - pendingWin);
      setBalance(prev => prev - pendingWin);
      setLastResult("💀 Gamble lost!");
      playDefeat();
    }
    setPendingWin(0);
  };

  const handleCollect = () => { setShowGamble(false); setPendingWin(0); };

  return (
    <div className="min-h-screen bg-[#060612] text-white relative overflow-hidden">
      <NavigationBar currentPath="/casino" />
      <div className="absolute inset-0 pointer-events-none z-0 bg-[radial-gradient(circle_at_50%_10%,rgba(0,255,255,0.15),transparent_35%),radial-gradient(circle_at_80%_70%,rgba(255,0,255,0.12),transparent_30%),radial-gradient(circle_at_20%_90%,rgba(0,140,255,0.10),transparent_30%)]" />

      {/* ── MEGA WIN / JACKPOT CELEBRATION OVERLAY ── */}
      {(celebrationTier === "mega" || jackpotCelebration) && (
        <div className="fixed inset-0 z-50 flex items-center justify-center pointer-events-none">
          <div className="absolute inset-0 bg-black/60 animate-pulse" />
          <div className={`relative z-10 text-center ${jackpotCelebration ? "animate-bounce" : ""}`}>
            <div className="text-8xl mb-4">{jackpotCelebration ? "🎉💰🎉" : "🌟💎🌟"}</div>
            <h2 className="text-6xl font-black text-yellow-300 drop-shadow-[0_0_40px_gold] mb-4">
              {jackpotCelebration ? "PROGRESSIVE JACKPOT!" : "MEGA WIN!"}
            </h2>
            <p className="text-4xl font-black text-white drop-shadow-[0_0_25px_white]">
              +{(jackpotWonAmount || winCounterTarget).toLocaleString()} tokens!
            </p>
          </div>
          <JackpotConfetti />
        </div>
      )}

      {/* ── BIG WIN OVERLAY ── */}
      {celebrationTier === "big" && (
        <div className="fixed inset-0 z-40 flex items-center justify-center pointer-events-none">
          <div className="text-center animate-[bigWinPulse_0.4s_ease-in-out_3]">
            <h2 className="text-5xl font-black text-orange-400 drop-shadow-[0_0_30px_orange]">🔥 BIG WIN!</h2>
            <p className="text-3xl font-black text-white mt-2"><WinCounter target={winCounterTarget} className="tabular-nums" /></p>
          </div>
          <CoinSplash />
        </div>
      )}

      {/* ── MEDIUM WIN OVERLAY ── */}
      {celebrationTier === "medium" && (
        <div className="fixed inset-0 z-30 flex items-center justify-center pointer-events-none">
          <div className="text-center animate-[slideIn_0.4s_ease-out]">
            <h2 className="text-3xl font-black text-cyan-300 drop-shadow-[0_0_20px_cyan]">✨ NICE WIN!</h2>
            <p className="text-2xl font-black text-white mt-1"><WinCounter target={winCounterTarget} className="tabular-nums" /></p>
          </div>
          <CoinSplash />
        </div>
      )}

      {/* ── Gamble Modal ── */}
      {showGamble && pendingWin > 0 && (
        <GambleModal pendingWin={pendingWin} onGamble={handleGambleResult} onCollect={handleCollect} themeConfig={themeConfig} />
      )}

      {/* ── Paytable Modal ── */}
      {showPaytable && (
        <PaytableModal onClose={() => setShowPaytable(false)} themeConfig={themeConfig} symbols={themeConfig.symbols} svgMap={svgMap} />
      )}

      {/* ── Autoplay Settings ── */}
      {showAutoplaySettings && (
        <AutoplaySettings settings={autoplaySettings} onChange={setAutoplaySettings} onClose={() => setShowAutoplaySettings(false)} themeConfig={themeConfig} />
      )}

      <div className="relative z-10 pt-24 px-6">
        {/* ── TOP CANDLE LIGHT ── */}
        <div className="flex justify-center mb-2">
          <div className={`w-6 h-10 rounded-full border-2 border-white/30 ${candleFlashing ? "bg-red-500 shadow-[0_0_20px_red] animate-pulse" : "bg-red-900/50"}`} />
          <div className="w-3 h-6 rounded-full mx-1 -mt-2 border border-white/20 bg-gray-700" />
          <div className={`w-6 h-10 rounded-full border-2 border-white/30 ${candleFlashing ? "bg-amber-400 shadow-[0_0_20px_amber] animate-pulse" : "bg-amber-900/50"}`} />
        </div>

        {/* ── TITLE + RTP ── */}
        <div className="text-center mb-4">
          <h1 className={`text-5xl font-black tracking-widest ${themeConfig.titleColor} drop-shadow-[0_0_18px_cyan]`}>{themeConfig.name}</h1>
          <p className="text-xs text-white/40 mt-1">RTP: {themeConfig.rtp}%</p>
        </div>

        {/* ── PROGRESSIVE JACKPOT ── */}
        <div className="flex justify-center mb-4">
          <div className={`px-8 py-3 rounded-2xl border-2 ${themeConfig.borderColor} bg-[#0d1020]/90 shadow-[0_0_30px_rgba(255,215,0,0.35)] flex items-center gap-4`}>
            <span className="text-2xl animate-pulse">💰</span>
            <div className="text-center">
              <p className="text-xs text-white/40 uppercase tracking-widest">Progressive Jackpot</p>
              <p className={`text-3xl font-black text-yellow-300 drop-shadow-[0_0_12px_gold] tabular-nums ${jackpot > 10000 ? "animate-pulse" : ""}`}>
                {jackpot.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
              </p>
            </div>
            <span className="text-2xl animate-pulse">💰</span>
          </div>
        </div>

        {/* ── FREE SPIN BADGE ── */}
        {freeSpinActive && (
          <div className="flex justify-center mb-4">
            <span className="px-6 py-2 rounded-full bg-gradient-to-r from-yellow-400 to-orange-500 text-black font-black text-lg animate-pulse shadow-[0_0_20px_gold]">
              🎁 FREE SPIN!
            </span>
          </div>
        )}

        {/* ── NEAR MISS ── */}
        {nearMiss && (
          <div className="flex justify-center mb-4">
            <span className="px-4 py-1 rounded-full bg-red-500/20 border border-red-400/40 text-red-300 font-bold text-sm animate-pulse">
              😱 SO CLOSE! One away...
            </span>
          </div>
        )}

        {/* ── SMALL WIN FLASH ── */}
        {celebrationTier === "small" && (
          <div className="flex justify-center mb-4">
            <span className="text-green-300 font-bold text-lg animate-pulse">+{winCounterTarget.toLocaleString()}</span>
          </div>
        )}

        <div className="flex justify-center mb-4 gap-2 flex-wrap">
          <Link href="/casino/slots">
            <button className="px-4 py-2 rounded-full border border-cyan-400 bg-black hover:bg-cyan-500/10 transition shadow-[0_0_12px_cyan] text-sm">⬅ Lobby</button>
          </Link>
          <button onClick={() => setShowPaytable(true)} className="px-4 py-2 rounded-full border border-white/30 bg-black hover:bg-white/10 transition text-sm">ℹ Paytable</button>
          <button onClick={() => setTurboMode(v => !v)}
            className={`px-4 py-2 rounded-full border text-sm transition ${turboMode ? "border-yellow-400 bg-yellow-400/20 text-yellow-300" : "border-white/20 bg-black hover:bg-white/10"}`}>
            ⚡ Turbo {turboMode ? "ON" : "OFF"}
          </button>
          <button onClick={() => setShowAutoplaySettings(true)} className="px-4 py-2 rounded-full border border-white/20 bg-black hover:bg-white/10 transition text-sm">⚙ Settings</button>
        </div>

        <div className="flex flex-col xl:flex-row items-start justify-center gap-8">
          <div className="flex flex-col items-center">
            {/* ── REEL CABINET ── */}
            <div className={`relative p-6 rounded-[30px] border-2 ${themeConfig.borderColor} bg-[#0d1020] shadow-[0_0_45px_rgba(0,255,255,0.45)]`}>
              {/* Outer chrome trim */}
              <div className="absolute inset-0 rounded-[30px] border border-pink-500 pointer-events-none animate-pulse opacity-40" />
              {/* Reel frame top bar */}
              <div className="absolute top-0 left-0 right-0 h-3 rounded-t-[28px] bg-gradient-to-b from-white/20 to-transparent pointer-events-none" />

              {flashWin && <div className="absolute inset-0 bg-cyan-400/20 rounded-[30px] animate-flash pointer-events-none" />}

              {/* ── REEL GRID ── */}
              <div className="relative flex gap-3 bg-[#05070d] p-5 rounded-2xl border border-cyan-500 shadow-inner">
                {/* Payline overlay */}
                {winningLine && !spinning && (
                  <PaylineOverlay winningLine={winningLine} themeConfig={themeConfig} />
                )}

                {/* Coin splash on win */}
                {showCoins && <CoinSplash />}

                {reels.map((column, colIdx) => {
                  const displaySymbols = animatingReels[colIdx] ? [...column, ...column, ...column] : column;
                  return (
                    <div key={colIdx}
                      className="w-[118px] h-[330px] rounded-xl overflow-hidden border border-cyan-400 bg-gradient-to-b from-[#161a2f] to-[#090b15] relative">
                      {/* Chrome trim per reel */}
                      <div className="absolute inset-0 rounded-xl border border-white/10 pointer-events-none" />
                      <div className={`flex flex-col ${animatingReels[colIdx] ? "animate-[scrollReel_0.18s_linear_infinite]" : ""}`}>
                        {displaySymbols.map((sym, rowIdx) => {
                          const isWinning = winningPositions.some(p => p.col === colIdx && p.row === rowIdx);
                          const justStopped = reelStopped[colIdx] && !animatingReels[colIdx];
                          return (
                            <div key={`${sym}-${colIdx}-${rowIdx}`}
                              className={`relative w-full h-[110px] flex items-center justify-center border-b border-cyan-900 transition-all duration-300
                                ${isWinning ? "bg-gradient-to-br from-yellow-300 via-pink-400 to-cyan-300 scale-110 z-10 shadow-[0_0_30px_#fff,0_0_50px_#ff00ff] animate-matchPulse" : "bg-[#11162a]"}
                                ${justStopped ? "animate-reelBounce" : ""}`}>
                              {isWinning && <div className="absolute inset-0 rounded-md border-2 border-white animate-pulse opacity-80" />}
                              <SlotSymbol symbol={sym} svgMap={svgMap} fallback={defaultSymbol}
                                className={`w-full h-full max-h-[80px] p-2 transition-all duration-300 ${isWinning ? "drop-shadow-[0_0_25px_white]" : ""}`} />
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* ── BELLY GLASS ── */}
              <div className="mt-3 mx-2 rounded-xl bg-[#0a0d18] border border-white/15 py-2 px-4 text-center">
                <p className="text-xs text-white/30 uppercase tracking-[0.3em]">{themeConfig.name}</p>
                <p className="text-[10px] text-white/20">5 Lines • {turboMode ? "Turbo" : "Standard"}</p>
              </div>

              {/* ── LEVER ── */}
              <button onClick={() => handleSpin(false)} disabled={spinning}
                className="absolute -right-8 top-20 flex flex-col items-center cursor-pointer group disabled:cursor-not-allowed" title="Pull to spin">
                <div className="w-3 h-32 bg-gray-300 rounded-full group-hover:bg-gray-200 transition" />
                <div className="w-12 h-12 rounded-full bg-pink-500 shadow-[0_0_22px_#ff00ff] group-hover:bg-pink-400 group-hover:shadow-[0_0_35px_#ff00ff] transition group-active:translate-y-1" />
              </button>
            </div>

            {/* ── BUTTONS ── */}
            <div className="flex flex-wrap justify-center gap-3 mt-6 mb-8">
              <button onClick={() => handleSpin(false)} disabled={spinning}
                className="px-10 py-4 rounded-full bg-cyan-400 text-black font-black text-xl hover:scale-105 transition shadow-[0_0_20px_cyan] disabled:opacity-50">
                {freeSpins > 0 ? `🎁 FREE (${freeSpins})` : "SPIN"}
              </button>
              {!autoSpinning ? (
                <button onClick={startAutoSpin} disabled={balance < bet && freeSpins === 0}
                  className="px-6 py-3 rounded-full bg-pink-500 font-bold shadow-[0_0_15px_#ff00ff] hover:bg-pink-400 transition disabled:opacity-40 disabled:cursor-not-allowed">
                  AUTO SPIN
                </button>
              ) : (
                <button onClick={stopAutoSpin} className="px-6 py-3 rounded-full bg-red-600 hover:bg-red-500 font-bold transition">STOP AUTO</button>
              )}
              <button onClick={() => setBetPerLine(Math.max(1, Math.floor(balance / lines)))}
                className="px-6 py-3 rounded-full bg-green-400 text-black font-bold shadow-[0_0_15px_lime] hover:bg-green-300 transition">MAX BET</button>
            </div>

            {/* ── LOSS STREAK ── */}
            {lossStreak >= 5 && (
              <p className="text-center text-white/30 text-xs mb-4">🔥 {lossStreak} losses in a row — {10 - lossStreak} more for a free spin!</p>
            )}
          </div>

          {/* ── PLAYER PANEL ── */}
          <div className={`w-[340px] rounded-2xl p-6 border ${themeConfig.borderColor} bg-[#0c1020]/95 space-y-4 shadow-[0_0_25px_rgba(0,255,255,0.18)]`}>
            <div className={`text-2xl font-black ${themeConfig.titleColor} mb-2`}>PLAYER PANEL</div>

            {/* Bet UI: per line */}
            <div className="space-y-2">
              <div className="flex justify-between items-center">
                <span className="text-sm text-white/60">Bet per line</span>
                <div className="flex items-center gap-1">
                  <button onClick={() => setBetPerLine(Math.max(1, betPerLine - 10))} className="w-7 h-7 rounded bg-white/10 hover:bg-white/20 text-sm">−</button>
                  <input type="number" min="1" max={Math.floor(balance/lines)} value={betPerLine}
                    onChange={handleBetChange} onBlur={() => { if (!betPerLine || betPerLine < 1) setBetPerLine(1); }}
                    className="w-20 px-2 py-1 rounded bg-black text-cyan-300 border border-cyan-400 outline-none text-center text-sm" />
                  <button onClick={() => setBetPerLine(Math.min(Math.floor(balance/lines), betPerLine + 10))} className="w-7 h-7 rounded bg-white/10 hover:bg-white/20 text-sm">+</button>
                </div>
              </div>
              <div className="flex justify-between text-xs text-white/40">
                <span>Lines: <b className="text-white/60">{lines}</b></span>
                <span>Total bet: <b className="text-yellow-300">{bet.toLocaleString()}</b></span>
              </div>
            </div>

            {/* Chip quick select */}
            <div className="flex flex-wrap gap-1 justify-center">
              {CHIP_VALUES.map(val => (
                <button key={val} onClick={() => setBetPerLine(Math.max(1, Math.floor(val / lines)))}
                  className={`px-2 py-0.5 rounded-full text-xs font-bold border transition-all ${Math.floor(betPerLine * lines) === val
                    ? "bg-[#FFFF33] text-black border-[#FFFF33]" : "bg-[#0a1a3a] text-[#FFFF33]/80 border-[#FFFF33]/30 hover:bg-[#FFFF33]/20"}`}>
                  {val}
                </button>
              ))}
            </div>

            <div className="flex gap-1.5 justify-center">
              <button onClick={() => setBetPerLine(Math.max(1, Math.floor(balance / (lines * 2))))} className="px-2 py-1 rounded text-xs font-bold border border-[#FFFF33]/30 bg-[#FFFF33]/15 text-[#FFFF33] hover:bg-[#FFFF33]/25">½</button>
              <button onClick={() => setBetPerLine(Math.max(1, Math.floor(balance / lines)))} className="px-2 py-1 rounded text-xs font-bold border border-[#FFFF33]/30 bg-[#FFFF33]/15 text-[#FFFF33] hover:bg-[#FFFF33]/25">ALL</button>
              <button onClick={() => setBetPerLine(prev => Math.min(Math.floor(balance/lines), prev * 2))} className="px-2 py-1 rounded text-xs font-bold border border-[#FFFF33]/30 bg-[#FFFF33]/15 text-[#FFFF33] hover:bg-[#FFFF33]/25">2×</button>
            </div>

            {error && <div className="text-red-400 text-xs text-center bg-red-900/20 p-1 rounded">{error}</div>}
            {loading && <div className="text-center"><span className="inline-block w-4 h-4 border-2 border-cyan-400 border-t-transparent rounded-full animate-spin mr-1 align-middle" /><span className="text-cyan-300 text-sm">Spinning...</span></div>}

            <div className="flex justify-between"><span>Balance</span><span className="text-green-400 font-bold">{balance.toLocaleString()}</span></div>
            <div className="flex justify-between"><span>Total Won</span><span className="text-cyan-300 font-bold">{totalWin.toLocaleString()}</span></div>
            <div className="flex justify-between"><span>Total Lost</span><span className="text-pink-400 font-bold">{totalLoss.toLocaleString()}</span></div>
            <div className="flex justify-between border-t border-white/10 pt-2">
              <span className="text-xs text-white/50">Net</span>
              <span className={`text-xs font-bold ${totalWin - totalLoss >= 0 ? "text-green-400" : "text-red-400"}`}>
                {(totalWin - totalLoss) >= 0 ? "+" : ""}{(totalWin - totalLoss).toLocaleString()}
              </span>
            </div>

            {/* Result & win counter */}
            <div className="pt-2 text-center min-h-[60px]">
              <div className="text-xl font-bold text-yellow-300">{lastResult}</div>
              {winCounterTarget > 0 && !showGamble && celebrationTier === "small" && (
                <div className="text-lg font-black text-green-400 mt-1">
                  <WinCounter target={winCounterTarget} className="tabular-nums" />
                </div>
              )}
            </div>

            {/* Loss streak indicator */}
            {lossStreak > 0 && (
              <div className="text-center text-xs text-white/20">
                Loss streak: <span className={lossStreak >= 8 ? "text-red-400 font-bold" : "text-white/40"}>{lossStreak}</span>
                {lossStreak >= 8 && <span className="ml-1">🔥</span>}
              </div>
            )}

            {/* Spin History Panel */}
            <div className="border-t border-white/10 pt-3">
              <button onClick={() => setShowHistory(v => !v)}
                className="flex w-full items-center justify-between text-xs font-bold text-white/60 hover:text-white/90 transition">
                <span>📜 Spin History {spinHistory.length > 0 && <span className="ml-1.5 rounded-full bg-white/10 px-1.5 py-0.5 text-[10px]">{spinHistory.length}</span>}</span>
                <span className={`transform transition-transform ${showHistory ? "rotate-180" : ""}`}>▼</span>
              </button>
              {showHistory && (
                <div className="mt-2 max-h-[260px] overflow-y-auto space-y-1.5 pr-1">
                  {spinHistory.length === 0 ? (
                    <p className="text-white/30 text-xs text-center py-4">No spins yet. Pull the lever!</p>
                  ) : spinHistory.map((entry, i) => (
                    <div key={entry.ts + "-" + i}
                      className={`rounded-lg px-2.5 py-2 text-xs ${entry.jackpot ? "bg-yellow-400/10 border border-yellow-400/30"
                        : entry.won ? "bg-green-400/10 border border-green-400/20" : "bg-white/5 border border-white/5"}`}>
                      <div className="flex gap-1 justify-center mb-1.5">
                        {entry.reels.map((col, ci) => (
                          <div key={ci} className="flex flex-col gap-0.5">
                            {col.slice(0, 3).map((sym, ri) => (
                              <div key={`${ci}-${ri}`} className="w-[22px] h-[22px] rounded bg-[#0a0f1e] flex items-center justify-center">
                                <SlotSymbol symbol={sym} svgMap={svgMap} fallback={defaultSymbol} className="w-[18px] h-[18px]" />
                              </div>
                            ))}
                          </div>
                        ))}
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-white/40">{entry.freeSpin ? "🎁 Free" : `Bet ${entry.bet}`}</span>
                        <span className={`font-bold ${entry.jackpot ? "text-yellow-300" : entry.won ? "text-green-400" : "text-red-400"}`}>
                          {entry.won ? `+${entry.winAmount}` : (entry.freeSpin ? "FREE" : `-${entry.bet}`)}
                          {entry.jackpot && " 🎉"}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      <style jsx>{`
        @keyframes scrollReel { 0% { transform: translateY(0); } 100% { transform: translateY(-33.33%); } }
        @keyframes flash { 0%,100% { opacity:0; } 50% { opacity:1; } }
        .animate-flash { animation: flash 0.25s linear 5; }
        @keyframes matchPulse { 0%,100% { transform:scale(1.05); filter:brightness(1); } 50% { transform:scale(1.12); filter:brightness(1.35); } }
        .animate-matchPulse { animation: matchPulse 0.6s ease-in-out infinite; }
        @keyframes drawLine { to { stroke-dashoffset: 0; } }
        @keyframes reelBounce { 0% { transform: scale(1.05); } 100% { transform: scale(1); } }
        .animate-reelBounce { animation: reelBounce 0.2s ease-out; }
        @keyframes coinSplash { 0% { opacity:1; transform:translate(0,0) scale(1); } 100% { opacity:0; transform:translate(var(--tx),var(--ty)) scale(0.3); } }
        .animate-coinSplash { animation: coinSplash var(--dur,1s) ease-out forwards; }
        @keyframes slideIn { 0% { transform: translateY(-40px); opacity:0; } 100% { transform: translateY(0); opacity:1; } }
        @keyframes bigWinPulse { 0%,100% { transform: scale(1); } 50% { transform: scale(1.08); } }
      `}</style>
    </div>
  );
}
