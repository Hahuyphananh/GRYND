"use client";
import NavigationBar from "../components/navigation-bar";
import ReportModal from "../components/ReportModal";
import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import { useSocket } from "../context/SocketProvider";
import { usePostHog } from "posthog-js/react";
import { celebrateWin } from "../lib/animations";
import { CHIP_VALUES } from "../lib/rouletteConfig";

const PVP_MAX_BET = 10000;
const PVP_HOUSE_FEE = 0.02; // 2%

// ── CoinAnimation ───────────────────────────────────────────────────
function CoinAnimation({ flipping, result, flipKey }) {
  return (
    <div className="relative w-24 h-24 perspective">
      <motion.div
        key={flipKey}
        animate={flipping ? { rotateY: [0, 720, 1440], rotateX: [0, 360, 720] } : { rotateY: 0, rotateX: 0 }}
        transition={{ duration: flipping ? 1 : 0.3, ease: [0.19, 1, 0.22, 1] }}
        className="w-full h-full rounded-full text-4xl flex items-center justify-center 
          bg-gradient-to-br from-purple-500 via-pink-500 to-indigo-500
          text-white font-bold
          shadow-[0_0_25px_rgba(168,85,247,0.8),inset_0_0_20px_rgba(255,255,255,0.2)]
          border border-pink-400/40"
        style={{ transformStyle: "preserve-3d" }}
      >
        {!result && "🪙"}
        {result === "heads" && "⚡"}
        {result === "tails" && "💠"}
      </motion.div>
    </div>
  );
}

// ── Main Page ────────────────────────────────────────────────────────
export default function CoinFlipPage() {
  const [mode, setMode] = useState("solo");
  const router = useRouter();

  return (
    <div
      className="relative flex min-h-screen flex-col items-center justify-start overflow-x-clip px-3 pb-24 pt-20 text-white sm:px-6 md:pb-8"
      style={{ backgroundImage: "linear-gradient(135deg, #020617 0%, #020617 40%, #0f172a 100%)" }}
    >
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(168,85,247,0.15),transparent_70%)] pointer-events-none" />
      <NavigationBar currentPath="/casino" />
      <div className="mt-6 w-full max-w-2xl rounded-xl border border-[#00e5ff]/30 bg-[#0b224f]/85 p-4 text-white shadow-[0_0_24px_rgba(0,229,255,0.2)] sm:mt-10 sm:p-6">
        <h1 className="mb-6 text-center text-2xl font-extrabold tracking-wide text-[#00e5ff] sm:text-3xl">Coin Flip</h1>

        <div className="mb-6 grid grid-cols-2 gap-2 sm:flex sm:justify-center sm:space-x-4 sm:gap-0">
          <button
            className={`px-4 py-2 rounded ${mode === "solo" ? "bg-gradient-to-r from-purple-500 to-pink-500 text-white shadow-[0_0_14px_rgba(236,72,153,0.5)]" : "bg-[#0d335f] hover:bg-[#144a85]"}`}
            onClick={() => setMode("solo")}>Solo vs House</button>
          <button
            className={`px-4 py-2 rounded ${mode === "pvp" ? "bg-gradient-to-r from-purple-500 to-pink-500 text-white shadow-[0_0_14px_rgba(236,72,153,0.5)]" : "bg-[#0d335f] hover:bg-[#144a85]"}`}
            onClick={() => setMode("pvp")}>PvP</button>
        </div>

        {mode === "solo" ? <SoloCoinFlip /> : <PvPCoinFlip />}

        <style jsx>{`.perspective { perspective: 1000px; }`}</style>
      </div>
    </div>
  );
}

// ── Gamble Modal (solo double-or-nothing) ────────────────────────────
function CoinFlipGamble({ pendingPayout, onGamble, onCollect }) {
  const [choice, setChoice] = useState(null);
  const [result, setResult] = useState(null);
  const [flipping, setFlipping] = useState(false);

  const handlePick = (color) => {
    setChoice(color);
    setFlipping(true);
    setTimeout(() => {
      const won = Math.random() < 0.5;
      setResult(won ? "win" : "lose");
      setTimeout(() => onGamble(won ? pendingPayout * 2 : 0), 1200);
    }, 600);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70">
      <div className="rounded-2xl p-6 border-2 border-[#00e5ff]/30 bg-[#0b224f] text-white max-w-sm w-full shadow-[0_0_40px_rgba(0,229,255,0.2)]">
        {!choice ? (
          <>
            <h3 className="text-xl font-black text-center mb-2">🎲 GAMBLE?</h3>
            <p className="text-center text-white/60 text-sm mb-4">Double your {pendingPayout.toFixed(2)} 🪙 win or lose it all?</p>
            <div className="flex gap-4 justify-center mb-4">
              <button onClick={() => handlePick("red")}
                className="px-6 py-8 rounded-xl bg-red-600 hover:bg-red-500 font-black text-lg shadow-[0_0_15px_red] transition">🔴 RED</button>
              <button onClick={() => handlePick("black")}
                className="px-6 py-8 rounded-xl bg-gray-800 hover:bg-gray-700 font-black text-lg shadow-[0_0_15px_white] transition">⚫ BLACK</button>
            </div>
            <button onClick={onCollect} className="w-full py-2 rounded-lg bg-green-500/20 border border-green-400/40 text-green-300 hover:bg-green-500/30 transition text-sm">
              Collect {pendingPayout.toFixed(2)} 🪙
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
              {result === "win" ? `+${(pendingPayout * 2).toFixed(2)} 🪙!` : "LOST!"}
            </h3>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Solo Coin Flip ───────────────────────────────────────────────────
function SoloCoinFlip() {
  const [bet, setBet] = useState(10);
  const [choice, setChoice] = useState("heads");
  const [result, setResult] = useState(null);
  const [message, setMessage] = useState("");
  const [flipping, setFlipping] = useState(false);
  const [balance, setBalance] = useState(null);
  const [flipKey, setFlipKey] = useState(0);
  const [autoBet, setAutoBet] = useState(false);
  const [autoDelay, setAutoDelay] = useState(1000);
  const [soundOn, setSoundOn] = useState(true);
  const [history, setHistory] = useState([]);
  const [showHistory, setShowHistory] = useState(false);
  const [winStreak, setWinStreak] = useState(0);
  const [lossStreak, setLossStreak] = useState(0);

  // Gamble states
  const [showGamble, setShowGamble] = useState(false);
  const [pendingPayout, setPendingPayout] = useState(0); // total payout
  const [pendingBet, setPendingBet] = useState(0); // original bet (for correct history on loss)
  const [gambleStats, setGambleStats] = useState({ attempted: 0, won: 0, lost: 0, netProfit: 0 });

  // Auto-bet settings
  const [showAutoSettings, setShowAutoSettings] = useState(false);
  const [autoSettings, setAutoSettings] = useState({ maxFlips: 0, stopOnWin: 0, stopOnBalance: 0, flipsRemaining: 0 });

  // Lazily mount the <audio> element after the first user interaction so it's
  // not present in the SSR HTML. Next.js auto-injects a <link rel="preload"> for
  // SSR'd audio sources, and if the user doesn't play within a few seconds the
  // browser raises a console error that surfaces in the dev error overlay.
  const [audioSrc, setAudioSrc] = useState("");

  const posthog = usePostHog();
  const flipLockRef = useRef(false);
  const flipRef = useRef(null);
  const audioRef = useRef(null);
  const autoSettingsRef = useRef(autoSettings);

  useEffect(() => { fetchBalance(); }, []);

  const fetchBalance = async () => {
    try {
      const res = await fetch("/api/get-user-tokens", { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include" });
      const json = await res.json();
      if (json.success) setBalance(parseFloat(json.data.balance));
    } catch { setMessage("Failed to load balance"); }
  };

  const flip = useCallback(async (isAuto) => {
    if (flipLockRef.current) return;
    flipLockRef.current = true;

    if (bet <= 0 || !["heads", "tails"].includes(choice)) {
      setMessage("Enter a valid bet and choice.");
      flipLockRef.current = false;
      return;
    }
    if (balance === null || balance < bet) {
      if (isAuto) { setAutoBet(false); setMessage("⏹ Auto stopped — insufficient balance"); }
      else setMessage("Insufficient balance.");
      flipLockRef.current = false;
      return;
    }

    setFlipping(true);
    setResult(null);
    setFlipKey(prev => prev + 1);
    posthog?.capture("coin_flip_solo_started", { bet, choice });

    if (soundOn) {
      // Mount the <audio> element on first flip so it isn't SSR'd.
      setAudioSrc((cur) => cur || "/sounds/coin-flip.mp3");
      // Defer playback to the next frame so the audio element has time to mount.
      requestAnimationFrame(() => {
        const audio = audioRef.current;
        if (!audio) return;
        audio.currentTime = 0;
        const p = audio.play();
        if (p && typeof p.catch === "function") p.catch(() => {});
      });
    }

    try {
      const res = await fetch("/api/coin-flip/solo", {
        method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include",
        body: JSON.stringify({ bet, choice }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error || "Error occurred");

      const { outcome, won, payout, newBalance } = json.data;

      setFlipping(false);
      setResult(outcome);
      setBalance(parseFloat(newBalance));
      setMessage(won ? `✅ You won ${payout.toFixed(2)} 🪙!` : "❌ You lost.");
      posthog?.capture("coin_flip_solo_ended", { bet, choice, outcome, won, payout: payout?.toFixed(2) });
      if (won) {
        // Show gamble option instead of immediately finalizing
        setPendingPayout(payout);
        setPendingBet(bet);
        // Skip gamble during auto-bet (auto-collect)
        if (isAuto) {
          setMessage(`✅ You won ${payout.toFixed(2)} 🪙!`);
          celebrateWin();
        } else {
          setShowGamble(true);
        }
        setWinStreak(prev => prev + 1);
        setLossStreak(0);
      } else {
        setWinStreak(0);
        setLossStreak(prev => prev + 1);
      }

      setHistory(prev => [
        { bet, choice, outcome, won, profit: won ? payout - bet : -bet, ts: Date.now() },
        ...prev,
      ].slice(0, 20));

      // Auto-bet stop conditions (check before gamble resolves)
      if (isAuto) {
        let stop = false;
        const s = autoSettingsRef.current;
        if (s.flipsRemaining > 0) {
          const remaining = s.flipsRemaining - 1;
          setAutoSettings(prev => ({ ...prev, flipsRemaining: remaining }));
          if (remaining <= 0) stop = true;
        }
        if (s.stopOnWin > 0 && won && payout >= s.stopOnWin) stop = true;
        if (s.stopOnBalance > 0 && newBalance < s.stopOnBalance) stop = true;
        if (stop) { setAutoBet(false); setMessage("⏹ Auto stopped per settings"); }
      }
    } catch {
      setFlipping(false);
      setMessage("Server error during flip.");
      fetchBalance(); // Refresh balance on error
    }
    flipLockRef.current = false;
  }, [bet, choice, balance, soundOn, posthog]);

  // Sync flipRef (kept AFTER the `flip` declaration to avoid a Temporal
  // Dead Zone ReferenceError that throws a client-side render exception.)
  useEffect(() => { flipRef.current = flip; }, [flip]);

  const handleGambleResult = (newPayout) => {
    setShowGamble(false);
    if (newPayout > 0) {
      // Won the gamble: add extra profit to balance
      const extraProfit = newPayout - pendingPayout;
      setBalance(prev => (prev !== null ? prev + extraProfit : prev));
      setMessage(`🎲 GAMBLE WON! +${newPayout.toFixed(2)} 🪙!`);
      celebrateWin();
      posthog?.capture("coin_flip_solo_gamble_won", { bet: pendingBet, payout: newPayout, profit: extraProfit });
      setGambleStats(prev => ({ attempted: prev.attempted + 1, won: prev.won + 1, lost: prev.lost, netProfit: prev.netProfit + extraProfit }));
      // Update history entry with gamble result
      setHistory(prev => {
        const updated = [...prev];
        if (updated.length > 0) updated[0] = { ...updated[0], profit: updated[0].profit + extraProfit, won: true };
        return updated;
      });
    } else {
      // Lost the gamble: revert the original win from balance
      setBalance(prev => (prev !== null ? prev - pendingPayout : prev));
      setMessage("💀 Gamble lost! Win forfeited.");
      posthog?.capture("coin_flip_solo_gamble_lost", { bet: pendingBet, lostPayout: pendingPayout });
      setGambleStats(prev => ({ attempted: prev.attempted + 1, won: prev.won, lost: prev.lost + 1, netProfit: prev.netProfit - pendingPayout }));
      // Update history entry to reflect loss (net loss = original bet)
      setHistory(prev => {
        const updated = [...prev];
        if (updated.length > 0) updated[0] = { ...updated[0], won: false, profit: -pendingBet };
        return updated;
      });
      setWinStreak(prev => Math.max(0, prev - 1));
      setLossStreak(prev => prev + 1);
    }
    setPendingPayout(0);
    setPendingBet(0);
  };

  const handleCollect = () => {
    setShowGamble(false);
    setMessage(`✅ You won ${pendingPayout.toFixed(2)} 🪙!`);
    celebrateWin();
    posthog?.capture("coin_flip_solo_gamble_collected", { bet: pendingBet, collected: pendingPayout });
    setGambleStats(prev => ({ ...prev, attempted: prev.attempted + 1 }));
    setPendingPayout(0);
    setPendingBet(0);
  };
  useEffect(() => { autoSettingsRef.current = autoSettings; }, [autoSettings]);

  // Auto-bet interval
  useEffect(() => {
    if (!autoBet) return;
    const interval = setInterval(() => {
      flipRef.current && flipRef.current(true);
    }, autoDelay);
    return () => clearInterval(interval);
  }, [autoBet, autoDelay]);

  const startAuto = () => {
    if (autoBet || (balance !== null && balance < bet)) return;
    setAutoSettings(prev => ({ ...prev, flipsRemaining: prev.maxFlips }));
    setAutoBet(true);
  };

  return (
    <>
      {/* Balance + Sound + Auto Delay */}
      <div className="mb-4 flex flex-col justify-between gap-2 sm:flex-row sm:items-center">
        <p className="text-[#FFD700] font-bold">Balance: {balance !== null ? `${balance.toFixed(2)} 🪙` : "..."}</p>
        <div className="flex items-center gap-3">
          <button onClick={() => setSoundOn(v => !v)}
            className={`px-2 py-1 rounded text-xs ${soundOn ? "bg-green-500/20 border border-green-400/30 text-green-300" : "bg-red-500/20 border border-red-400/30 text-red-300"}`}>
            {soundOn ? "🔊" : "🔇"}
          </button>
          <label className="text-xs">Delay:</label>
          <input type="number" min="100" className="w-16 bg-[#08142f] border border-[#00e5ff]/30 p-1 rounded text-xs"
            value={autoDelay} onChange={e => setAutoDelay(parseInt(e.target.value) || 1000)} />
        </div>
      </div>

      {/* Streaks */}
      {(winStreak > 0 || lossStreak > 0) && (
        <div className="mb-3 flex justify-center gap-4 text-xs">
          {winStreak > 0 && <span className="text-green-400">🔥 {winStreak} win{winStreak>1?"s":""} streak!</span>}
          {lossStreak > 0 && <span className="text-red-400">💀 {lossStreak} loss{lossStreak>1?"es":""} streak{lossStreak>=5?" — ouch!":""}</span>}
        </div>
      )}

      {/* Bet input + chip quick select */}
      <label className="block mb-1 text-xs text-white/60">Bet Amount (🪙)</label>
      <div className="flex gap-2 mb-2">
        <input type="number" className="flex-1 bg-[#08142f] border border-[#00e5ff]/30 p-2 rounded"
          value={bet} onChange={e => setBet(parseFloat(e.target.value) || 0)} />
        <button onClick={() => setBet(Math.max(1, Math.floor(balance / 2)))} className="px-2 py-1 rounded text-xs font-bold border border-[#FFFF33]/30 bg-[#FFFF33]/15 text-[#FFFF33] hover:bg-[#FFFF33]/25">½</button>
        <button onClick={() => setBet(Math.max(1, balance))} className="px-2 py-1 rounded text-xs font-bold border border-[#FFFF33]/30 bg-[#FFFF33]/15 text-[#FFFF33] hover:bg-[#FFFF33]/25">ALL</button>
        <button onClick={() => setBet(prev => Math.min(balance, prev * 2))} className="px-2 py-1 rounded text-xs font-bold border border-[#FFFF33]/30 bg-[#FFFF33]/15 text-[#FFFF33] hover:bg-[#FFFF33]/25">2×</button>
      </div>
      <div className="flex flex-wrap gap-1 justify-center mb-4">
        {CHIP_VALUES.map(val => (
          <button key={val} onClick={() => setBet(val)}
            className={`px-2 py-0.5 rounded-full text-xs font-bold border transition-all ${bet === val ? "bg-[#FFFF33] text-black border-[#FFFF33]" : "bg-[#0a1a3a] text-[#FFFF33]/80 border-[#FFFF33]/30 hover:bg-[#FFFF33]/20"}`}>
            {val}
          </button>
        ))}
      </div>

      {/* Choice buttons */}
      <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:justify-between">
        <button onClick={() => setChoice("heads")}
          className={`w-full rounded p-3 text-base ${choice === "heads" ? "bg-gradient-to-r from-cyan-400 to-emerald-400 text-black shadow-[0_0_12px_rgba(16,185,129,0.6)]" : "bg-[#0d335f] hover:bg-[#144a85]"}`}>
          Heads ⚡
        </button>
        <button onClick={() => setChoice("tails")}
          className={`w-full rounded p-3 text-base ${choice === "tails" ? "bg-gradient-to-r from-cyan-400 to-emerald-400 text-black shadow-[0_0_12px_rgba(16,185,129,0.6)]" : "bg-[#0d335f] hover:bg-[#144a85]"}`}>
          Tails 💠
        </button>
      </div>

      {/* Action buttons */}
      <div className="mb-4 flex flex-col gap-2 sm:flex-row">
        <button onClick={() => flip(false)} disabled={flipping}
          className="w-full p-3 bg-gradient-to-r from-purple-500 to-pink-500 hover:scale-105 transition transform shadow-[0_0_18px_rgba(236,72,153,0.6)] rounded font-bold">
          {flipping ? "Flipping..." : "Flip Coin"}
        </button>
        <button onClick={() => autoBet ? setAutoBet(false) : startAuto()}
          className={`w-full p-3 rounded font-bold ${autoBet ? "bg-gradient-to-r from-red-500 to-orange-500 shadow-[0_0_12px_rgba(239,68,68,0.6)]" : "bg-gradient-to-r from-cyan-400 to-emerald-400 text-black shadow-[0_0_12px_rgba(16,185,129,0.6)]"}`}>
          {autoBet ? "Stop Auto" : "Start Auto"}
        </button>
      </div>

      {/* Auto-bet settings */}
      <div className="mb-3">
        <button onClick={() => setShowAutoSettings(v => !v)}
          className="text-xs text-white/40 hover:text-white/80 transition">
          ⚙ {showAutoSettings ? "Hide" : "Auto-bet"} Settings
        </button>
        {showAutoSettings && (
          <div className="mt-2 grid grid-cols-3 gap-2 text-xs">
            <label className="flex flex-col gap-0.5">
              <span className="text-white/40">Max flips</span>
              <input type="number" min="0" value={autoSettings.maxFlips||""}
                onChange={e => setAutoSettings(prev => ({...prev, maxFlips: parseInt(e.target.value)||0}))}
                className="bg-[#08142f] border border-[#00e5ff]/30 p-1 rounded text-white" placeholder="∞" />
            </label>
            <label className="flex flex-col gap-0.5">
              <span className="text-white/40">Stop if win ≥</span>
              <input type="number" min="0" value={autoSettings.stopOnWin||""}
                onChange={e => setAutoSettings(prev => ({...prev, stopOnWin: parseInt(e.target.value)||0}))}
                className="bg-[#08142f] border border-[#00e5ff]/30 p-1 rounded text-white" placeholder="off" />
            </label>
            <label className="flex flex-col gap-0.5">
              <span className="text-white/40">Stop if bal. &lt;</span>
              <input type="number" min="0" value={autoSettings.stopOnBalance||""}
                onChange={e => setAutoSettings(prev => ({...prev, stopOnBalance: parseInt(e.target.value)||0}))}
                className="bg-[#08142f] border border-[#00e5ff]/30 p-1 rounded text-white" placeholder="off" />
            </label>
          </div>
        )}
      </div>

      {/* Coin animation */}
      <div className="flex justify-center mt-6 h-28">
        <CoinAnimation flipping={flipping} result={result} flipKey={flipKey} />
      </div>

      {message && (
        <motion.p initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
          className="text-center mt-4 text-[#7cefff]">{message}</motion.p>
      )}

      {/* Gamble Modal */}
      {showGamble && pendingPayout > 0 && (
        <CoinFlipGamble pendingPayout={pendingPayout} onGamble={handleGambleResult} onCollect={handleCollect} />
      )}

      {/* Gamble Stats */}
      {gambleStats.attempted > 0 && (
        <div className="mt-3 flex justify-center gap-3 text-[10px] text-white/40">
          <span>🎲 Gambles: {gambleStats.attempted}</span>
          <span className="text-green-400/60">{gambleStats.won}W</span>
          <span className="text-red-400/60">{gambleStats.lost}L</span>
          <span className={gambleStats.netProfit >= 0 ? "text-green-400/60" : "text-red-400/60"}>
            {gambleStats.netProfit >= 0 ? "+" : ""}{gambleStats.netProfit.toFixed(0)}🪙
          </span>
        </div>
      )}

      {/* Flip History */}
      <div className="mt-4 border-t border-white/10 pt-3">
        <button onClick={() => setShowHistory(v => !v)}
          className="flex w-full items-center justify-between text-xs font-bold text-white/60 hover:text-white/90 transition">
          <span>📜 History {history.length > 0 && <span className="ml-1.5 rounded-full bg-white/10 px-1.5 py-0.5 text-[10px]">{history.length}</span>}</span>
          <span className={`transform transition-transform ${showHistory ? "rotate-180" : ""}`}>▼</span>
        </button>
        {showHistory && (
          <div className="mt-2 max-h-[200px] overflow-y-auto space-y-1 pr-1 text-xs">
            {history.length === 0 ? (
              <p className="text-white/30 text-center py-3">No flips yet. Place a bet!</p>
            ) : history.map((e, i) => (
              <div key={e.ts + "-" + i}
                className={`flex items-center justify-between rounded px-2 py-1.5 ${e.won ? "bg-green-400/10 border border-green-400/20" : "bg-white/5 border border-white/5"}`}>
                <span className="text-white/50">{e.choice === "heads" ? "⚡" : "💠"} Bet {e.bet}</span>
                <span className="text-white/30">→ {e.outcome === "heads" ? "⚡" : "💠"}</span>
                <span className={`font-bold ${e.won ? "text-green-400" : "text-red-400"}`}>
                  {e.won ? `+${e.profit + e.bet}` : `-${e.bet}`}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Hidden audio element — mounted client-side only after the first flip
          to avoid Next.js auto-preloading the src in the SSR HTML. */}
      {audioSrc && <audio ref={audioRef} src={audioSrc} preload="auto" />}
    </>
  );
}

// ── PvP Coin Flip ────────────────────────────────────────────────────
function PvPCoinFlip() {
  const { socket } = useSocket();
  const [bet, setBet] = useState(10);
  const [flipping, setFlipping] = useState(false);
  const [message, setMessage] = useState("");
  const [result, setResult] = useState(null);
  const [flipKey, setFlipKey] = useState(0);
  const [games, setGames] = useState([]);
  const [myGameId, setMyGameId] = useState(null);
  const [myBet, setMyBet] = useState(null);
  const [userId, setUserId] = useState(null);
  const [opponentId, setOpponentId] = useState(null);
  const [myChoice, setMyChoice] = useState(null);
  const [opponentChoice, setOpponentChoice] = useState(null);
  const [gameFinished, setGameFinished] = useState(false);
  const [gameStatus, setGameStatus] = useState(null);
  const [choiceDeadline, setChoiceDeadline] = useState(null);
  const [timeLeft, setTimeLeft] = useState(0);
  const [showReportModal, setShowReportModal] = useState(false);
  // Best-of-N scoreboard state — surfaced by /status so the client can
  // show running round progress alongside the existing choice UI.
  const [scoreP1, setScoreP1] = useState(0);
  const [scoreP2, setScoreP2] = useState(0);
  const [targetWins, setTargetWins] = useState(2);
  const [totalRounds, setTotalRounds] = useState(0);
  const [roundBanner, setRoundBanner] = useState(null);
  // Ref-tracked timeout so we can clear it on rematch/closeGame before
  // the auto-dismiss fires — otherwise a stale timer from the prior
  // round could clear a banner for the new round mid-DOM.
  const roundBannerTimerRef = useRef(null);
  // Same idea for the post-finish 1.2s flip-anim setTimeout — if the
  // user clicks Close mid-animation, the stale callback would fire
  // after closeGame and re-set `gameFinished=true` on a closed game,
  // gating the NEXT match's result-flip animation. Track & clear it.
  const flipAnimTimerRef = useRef(null);
  // `imPlayer1` is true when `userId` is the player who created the
  // game (player1). It gates the "You" / "Opponent" labels on the
  // best-of-3 scoreboard so the running scoreboard reads from each
  // player's perspective.
  const [imPlayer1, setImPlayer1] = useState(true);
  // Refs hold the polled totals between renders so we can fire a
  // round-just-resolved banner without false positives on first poll.
  const prevTotalRoundsRef = useRef(null);
  const prevScoreP1Ref = useRef(null);
  const prevScoreP2Ref = useRef(null);
  const posthog = usePostHog();
  const animationLockRef = useRef(false);

  useEffect(() => {
    (async () => {
      const res = await fetch("/api/get-user", { credentials: "include" });
      const json = await res.json();
      if (json.success) setUserId(json.data.userId);
    })();
  }, []);

  const fetchGames = async () => {
    try {
      const res = await fetch("/api/coin-flip/pvp/available", { credentials: "include" });
      const json = await res.json();
      if (json.success) setGames(json.data.games);
    } catch { /* silent */ }
  };

  useEffect(() => { fetchGames(); }, []);
  useEffect(() => {
    if (!socket) return;
    const roomId = "lobby:coin-flip";
    const handler = () => fetchGames();
    socket.emit("join_room", { roomId });
    socket.on("lobby:updated", handler);
    return () => { socket.emit("leave_room", { roomId }); socket.off("lobby:updated", handler); };
  }, [socket]);

  useEffect(() => {
    if (!myGameId) return;
    const checkGame = async () => {
      const res = await fetch(`/api/coin-flip/pvp/status?gameId=${myGameId}`);
      const json = await res.json();
      if (!json.success) return;

      const game = json.data;
      setGameStatus(game.status);
      setChoiceDeadline(game.choiceDeadline || null);
      const opponent = game.player1Id === userId ? game.player2Id : game.player1Id;
      setOpponentId(opponent || null);
      setImPlayer1(game.player1Id === userId);

      if (game.player1Id === userId) { setMyChoice(game.player1Choice || null); setOpponentChoice(game.player2Choice || null); }
      else { setMyChoice(game.player2Choice || null); setOpponentChoice(game.player1Choice || null); }

      // Best-of-N scoreboard surface.
      const nextScoreP1 = game.scorePlayer1 ?? 0;
      const nextScoreP2 = game.scorePlayer2 ?? 0;
      const nextTargetWins = game.targetWins ?? 2;
      const nextTotalRounds = game.totalRounds ?? 0;
      setScoreP1(nextScoreP1);
      setScoreP2(nextScoreP2);
      setTargetWins(nextTargetWins);
      setTotalRounds(nextTotalRounds);

      // Round-just-resolved detection — first poll: initialise refs
      // silently so we don't fire a spurious banner on the very first
      // status read (which could land AFTER a round has already
      // resolved). Subsequent polls: if totalRounds advanced AND the
      // match is still in progress, pulse a brief banner noting who
      // took the just-completed round.
      const isFirstPoll = prevTotalRoundsRef.current === null;
      if (isFirstPoll) {
        prevTotalRoundsRef.current = nextTotalRounds;
        prevScoreP1Ref.current = nextScoreP1;
        prevScoreP2Ref.current = nextScoreP2;
      } else if (
        game.status === "matched" &&
        nextTotalRounds > prevTotalRoundsRef.current
      ) {
        const completedRound = nextTotalRounds;
        const p1Delta = nextScoreP1 - (prevScoreP1Ref.current ?? 0);
        const p2Delta = nextScoreP2 - (prevScoreP2Ref.current ?? 0);
        // The seat whose score JUST advanced is the round winner.
        let roundWinnerIsPlayer1 = null;
        if (p1Delta > 0 && p2Delta === 0) roundWinnerIsPlayer1 = true;
        else if (p2Delta > 0 && p1Delta === 0) roundWinnerIsPlayer1 = false;
        const youWonRound = roundWinnerIsPlayer1 === null
          ? null
          : (imPlayer1 ? roundWinnerIsPlayer1 : !roundWinnerIsPlayer1);
        setRoundBanner({
          roundNumber: completedRound,
          winnerIsYou: youWonRound,
        });
        // Auto-dismiss after a short window so it doesn't linger into
        // the next round's choice phase. Track the handle so we can
        // cancel it on rematch / closeGame.
        if (roundBannerTimerRef.current) clearTimeout(roundBannerTimerRef.current);
        roundBannerTimerRef.current = setTimeout(
          () => {
            setRoundBanner((cur) => (cur && cur.roundNumber === completedRound ? null : cur));
            roundBannerTimerRef.current = null;
          },
          2500
        );
        prevTotalRoundsRef.current = nextTotalRounds;
        prevScoreP1Ref.current = nextScoreP1;
        prevScoreP2Ref.current = nextScoreP2;
      } else {
        prevTotalRoundsRef.current = nextTotalRounds;
        prevScoreP1Ref.current = nextScoreP1;
        prevScoreP2Ref.current = nextScoreP2;
      }

      if (game.status === "matched") setMessage("Choose heads or tails before the timer ends.");
      if (game.status === "cancelled") { setFlipping(false); setMessage("Game cancelled: choice timer expired. Bets refunded."); }

      if (game.status === "finished" && !gameFinished && !animationLockRef.current) {
        animationLockRef.current = true;
        setFlipping(true);
        setMessage("Flipping coin...");
        setFlipKey(k => k + 1);
        // Track the handle so closeGame can cancel a stale animation
        // before it re-asserts `gameFinished=true` against a closed
        // game and gates the next match's flip animation.
        if (flipAnimTimerRef.current) clearTimeout(flipAnimTimerRef.current);
        flipAnimTimerRef.current = setTimeout(() => {
          flipAnimTimerRef.current = null;
          setResult(game.outcome);
          setFlipping(false);
          setMessage(game.winner === "you" ? "✅ You won!" : "❌ You lost.");
          setGameFinished(true);
          animationLockRef.current = false;
          posthog?.capture("coin_flip_pvp_ended", {
            game_id: myGameId, result: game.winner === "you" ? "win" : "lose",
            outcome: game.outcome, my_choice: myChoice, opponent_choice: opponentChoice,
            rounds_played: nextTotalRounds,
          });
        }, 1200);
      }
    };

    checkGame();
    const interval = setInterval(checkGame, 1000);
    return () => clearInterval(interval);
  }, [myGameId, userId, gameFinished, scoreP1, scoreP2]);

  useEffect(() => {
    if (!choiceDeadline || gameStatus !== "matched") { setTimeLeft(0); return; }
    const update = () => setTimeLeft(Math.max(0, Math.ceil((new Date(choiceDeadline).getTime() - Date.now()) / 1000)));
    update();
    const interval = setInterval(update, 250);
    return () => clearInterval(interval);
  }, [choiceDeadline, gameStatus]);

  const createGame = async () => {
    setMessage("Creating game...");
    setResult(null); setFlipping(false); setGameFinished(false);
    setGameStatus("active"); setMyChoice(null); setOpponentChoice(null);

    const res = await fetch("/api/coin-flip/pvp/create", {
      method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include",
      body: JSON.stringify({ betAmount: bet }),
    });
    const json = await res.json();
    if (json.success) {
      setMyGameId(json.data.gameId);
      setMyBet(json.data.betAmount);
      setMessage("Waiting for opponent...");
      posthog?.capture("coin_flip_pvp_started", { game_id: json.data.gameId, bet_amount: bet, mode: "created" });
      socket?.emit("room_event", { roomId: "lobby:coin-flip", event: "lobby:updated" });
    } else setMessage(json.error);
  };

  const submitChoice = async (choice) => {
    if (!myGameId || gameStatus !== "matched" || myChoice) return;
    const res = await fetch("/api/coin-flip/pvp/choose", {
      method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include",
      body: JSON.stringify({ gameId: myGameId, choice }),
    });
    const json = await res.json();
    if (!json.success) { setMessage(json.error || "Failed to save choice"); return; }
    setMyChoice(choice);
    setMessage("Choice locked. Waiting for opponent...");
  };

  const closeGame = () => {
    setGameFinished(false); setMyGameId(null); setMyBet(null); setOpponentId(null);
    setMyChoice(null); setOpponentChoice(null); setResult(null); setChoiceDeadline(null);
    setGameStatus(null); setMessage("");
    // Drop any in-flight round banner from the previous match so it
    // can't bleed into the next one.
    if (roundBannerTimerRef.current) clearTimeout(roundBannerTimerRef.current);
    roundBannerTimerRef.current = null;
    setRoundBanner(null);
    // Cancel any in-flight post-finish flip-animation timeout. Without
    // this, closing mid-anim would let the stale callback re-assert
    // `gameFinished=true` against a closed game and gate the next
    // match's flip animation behind `!gameFinished`.
    if (flipAnimTimerRef.current) clearTimeout(flipAnimTimerRef.current);
    flipAnimTimerRef.current = null;
    // Reset best-of-N refs so the next match's first poll doesn't
    // inherit stale finished-game totals. Without this, an
    // accidentally-too-lax `nextTotalRounds > prev` comparison in a
    // future edit would silently fire a spurious banner.
    prevTotalRoundsRef.current = null;
    prevScoreP1Ref.current = null;
    prevScoreP2Ref.current = null;
    // Also clear the result-flip animation lock — if the user closes
    // mid-animation, the next game's finish must still be allowed to
    // play the flip.
    animationLockRef.current = false;
  };

  const rematch = async () => {
    const savedBet = myBet;
    if (!savedBet) return;
    closeGame();
    // Brief delay then create new game with same bet
    setTimeout(async () => {
      setBet(savedBet);
      const res = await fetch("/api/coin-flip/pvp/create", {
        method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include",
        body: JSON.stringify({ betAmount: savedBet }),
      });
      const json = await res.json();
      if (json.success) {
        setMyGameId(json.data.gameId);
        setMyBet(json.data.betAmount);
        setMessage("Waiting for opponent...");
        posthog?.capture("coin_flip_pvp_started", { game_id: json.data.gameId, bet_amount: savedBet, mode: "rematch" });
        socket?.emit("room_event", { roomId: "lobby:coin-flip", event: "lobby:updated" });
      } else setMessage(json.error);
    }, 100);
  };

  const cancelGame = async () => {
    setMessage("Cancelling game...");
    const res = await fetch("/api/coin-flip/pvp/cancel", {
      method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include",
      body: JSON.stringify({ gameId: myGameId }),
    });
    const json = await res.json();
    if (json.success) {
      posthog?.capture("coin_flip_pvp_cancelled", { game_id: myGameId, bet_amount: myBet });
      setMyGameId(null); setMyBet(null); setChoiceDeadline(null); setGameStatus(null);
      setGames(prev => prev.filter(g => g.id !== myGameId));
      setMessage("Game cancelled.");
      socket?.emit("room_event", { roomId: "lobby:coin-flip", event: "lobby:updated" });
    } else setMessage(json.error);
  };

  const joinGame = async (gameId) => {
    if (gameId === myGameId) return;
    setResult(null); setFlipping(false); setGameFinished(false);
    setMessage("Joining game...");

    const res = await fetch("/api/coin-flip/pvp/join", {
      method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include",
      body: JSON.stringify({ gameId }),
    });
    const json = await res.json();
    if (json.success) {
      setMyGameId(gameId);
      setChoiceDeadline(json.data.choiceDeadline || null);
      setGameStatus("matched");
      setMessage("Choose heads or tails in 10 seconds.");
      const joinedGame = games.find(g => g.id === gameId);
      const actualBet = joinedGame?.betAmount ?? bet;
      posthog?.capture("coin_flip_pvp_started", { game_id: gameId, bet_amount: actualBet, mode: "joined" });
      socket?.emit("room_event", { roomId: "lobby:coin-flip", event: "lobby:updated" });
    } else setMessage(json.error);
  };

  const availableGames = games.filter(g => g.player1Id !== userId && g.id !== myGameId);

  return (
    <>
      {!myGameId && (
        <>
          <label className="block mb-1 text-xs text-white/60">Bet Amount (🪙) <span className="text-white/20">max {PVP_MAX_BET.toLocaleString()}</span></label>
          <input type="number" className="w-full bg-[#08142f] border border-[#00e5ff]/30 p-2 rounded mb-4"
            value={bet} onChange={e => setBet(Math.min(PVP_MAX_BET, parseFloat(e.target.value) || 0))} max={PVP_MAX_BET} />

          <div className="flex flex-wrap gap-1 justify-center mb-4">
            {CHIP_VALUES.filter(v => v <= PVP_MAX_BET).map(val => (
              <button key={val} onClick={() => setBet(val)}
                className={`px-2 py-0.5 rounded-full text-xs font-bold border transition-all ${bet === val ? "bg-[#FFFF33] text-black border-[#FFFF33]" : "bg-[#0a1a3a] text-[#FFFF33]/80 border-[#FFFF33]/30 hover:bg-[#FFFF33]/20"}`}>
                {val}
              </button>
            ))}
          </div>

          <button onClick={createGame}
            className="w-full p-3 rounded font-bold text-lg bg-gradient-to-r from-purple-500 to-pink-500 hover:scale-105 shadow-[0_0_18px_rgba(236,72,153,0.6)] text-white">
            🎲 Create PvP Game
          </button>

          <div className="mt-8">
            <div className="flex justify-between items-center mb-3">
              <h2 className="text-xl font-bold">Available Games</h2>
              <button onClick={fetchGames} disabled={!!myGameId}
                className={`px-3 py-1 rounded text-sm font-semibold ${myGameId ? "bg-gray-500 cursor-not-allowed" : "bg-[#00e5ff] text-[#001933] shadow-[0_0_10px_rgba(0,229,255,0.4)]"}`}>
                🔄 Refresh
              </button>
            </div>
            {availableGames.length === 0 && <p className="text-center text-gray-400">No games available. Be the first to create one!</p>}
            <div className="space-y-3">
              {availableGames.map(game => (
                <div key={game.id} className="bg-gray-900 border border-gray-700 rounded-lg p-4 flex justify-between items-center">
                  <div>
                    <p className="font-bold">{game.player1Name || "Unknown Player"}</p>
                    <p className="text-gray-400 mt-1">Bet: {game.betAmount} 🪙</p>
                  </div>
                  <button onClick={() => joinGame(game.id)}
                    className="px-4 py-2 rounded-lg font-bold bg-gradient-to-r from-cyan-400 to-emerald-400 text-black shadow-[0_0_12px_rgba(16,185,129,0.6)]">
                    Join
                  </button>
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      {myGameId && (
        <div className="mt-6 bg-gray-900 rounded-xl p-6 shadow-xl border border-gray-700">
          <h2 className="text-center text-xl font-bold mb-6">Coin Flip PvP</h2>
          <p className="text-center text-[10px] text-white/20 mb-2">House fee: {(PVP_HOUSE_FEE * 100).toFixed(0)}%</p>

          {/* Best-of-N scoreboard — visible the entire time an opponent
              is present so both players see the running score alongside
              the existing choice / flip UI. `targetWins * 2 - 1` is the
              canonical "Best of N" formulation (best-of-3 = max 3
              rounds, best-of-5 = max 5 rounds, etc.). */}
          {opponentId && (
            <div className="mb-3 px-3 py-2 rounded-lg border border-[#00e5ff]/20 bg-black/30 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[11px] sm:text-xs">
              <span className="text-[#00e5ff] font-bold uppercase tracking-widest">
                Best of {targetWins * 2 - 1}
              </span>
              <span className="text-white/60 font-semibold">
                {gameStatus === "finished"
                  ? `Match complete`
                  : `Round ${totalRounds + 1}`}
              </span>
              <span className="font-bold text-white whitespace-nowrap">
                {imPlayer1 ? (
                  <>
                    <span className="text-green-300">You {scoreP1}</span>
                    <span className="text-white/40 mx-1">–</span>
                    <span className="text-yellow-300">{scoreP2}</span>
                  </>
                ) : (
                  <>
                    <span className="text-green-300">You {scoreP2}</span>
                    <span className="text-white/40 mx-1">–</span>
                    <span className="text-yellow-300">{scoreP1}</span>
                  </>
                )}
              </span>
            </div>
          )}

          {/* Round-just-resolved banner — pulses briefly when a round
              ends mid-match (status still "matched") so both players
              see who took the round before the next choice phase. */}
          {roundBanner && gameStatus === "matched" && (
            <div className="mb-3 text-center text-sm font-semibold text-[#7cefff] tracking-wide">
              {roundBanner.winnerIsYou === null
                ? `Round ${roundBanner.roundNumber} resolved.`
                : `Round ${roundBanner.roundNumber} won by ${roundBanner.winnerIsYou ? "You" : "Opponent"}.`}
              {totalRounds >= targetWins
                ? " — wait for final result…"
                : " — next round, pick your side."}
            </div>
          )}

          <div className="flex justify-end mb-3">
            {opponentId && (
              <button onClick={() => setShowReportModal(true)}
                className="px-3 py-1 rounded-lg bg-red-500/20 border border-red-500/40 text-xs font-bold text-red-300 hover:bg-red-500/30">
                🚩 Report
              </button>
            )}
          </div>

          <div className="grid grid-cols-2 gap-6 text-center mb-6">
            <div className="bg-gray-800 p-4 rounded-lg">
              <p className="font-bold text-green-400">You</p>
              <p className="text-sm break-all">{userId}</p>
              <p className="mt-2 text-yellow-400">Choice: {myChoice === "heads" ? "⚡ Heads" : myChoice === "tails" ? "💠 Tails" : "Not chosen"}</p>
            </div>
            <div className="bg-gray-800 p-4 rounded-lg">
              <p className="font-bold text-yellow-400">{opponentId ? "Opponent" : "Searching..."}</p>
              <p className="text-sm break-all">{opponentId || "..."}</p>
              <p className="mt-2 text-yellow-400">Choice: {opponentChoice === "heads" ? "⚡ Heads" : opponentChoice === "tails" ? "💠 Tails" : "Not chosen"}</p>
            </div>
          </div>

          {gameStatus === "matched" && (
            <div className="mb-4 text-center text-orange-300 font-semibold">Choice timer: {timeLeft}s</div>
          )}

          {!myChoice && gameStatus === "matched" && !flipping && (
            <div className="flex justify-between mb-6">
              <button onClick={() => submitChoice("heads")} disabled={opponentChoice === "heads"}
                className={`w-full mr-2 p-2 rounded ${opponentChoice === "heads" ? "bg-gray-500 cursor-not-allowed" : "bg-[#0d335f] hover:bg-green-700"}`}>
                ⚡ Heads
              </button>
              <button onClick={() => submitChoice("tails")} disabled={opponentChoice === "tails"}
                className={`w-full ml-2 p-2 rounded ${opponentChoice === "tails" ? "bg-gray-500 cursor-not-allowed" : "bg-[#0d335f] hover:bg-green-700"}`}>
                💠 Tails
              </button>
            </div>
          )}

          <div className="flex justify-center mb-6">
            <CoinAnimation flipping={flipping} result={result} flipKey={flipKey} />
          </div>

          <p className="text-center text-gray-400 mb-4">Bet Locked: {myBet} 🪙</p>
          {message && <p className="text-center text-[#7cefff] mb-4">{message}</p>}

          {!flipping && !gameFinished && gameStatus !== "cancelled" && (
            <button onClick={cancelGame}
              className="mt-2 w-full p-3 rounded-lg font-bold bg-gradient-to-r from-red-500 to-orange-500 shadow-[0_0_12px_rgba(239,68,68,0.6)]">
              Cancel Game
            </button>
          )}
          {(gameFinished || gameStatus === "cancelled") && (
            <div className="mt-2 flex gap-2">
              <button onClick={closeGame}
                className="flex-1 p-3 rounded-lg font-bold bg-[#00e5ff] text-[#001933] shadow-[0_0_10px_rgba(0,229,255,0.4)]">
                Close
              </button>
              <button onClick={rematch}
                className="flex-1 p-3 rounded-lg font-bold bg-gradient-to-r from-purple-500 to-pink-500 text-white shadow-[0_0_12px_rgba(236,72,153,0.6)] hover:scale-105 transition">
                🔄 Rematch
              </button>
            </div>
          )}
        </div>
      )}

      <ReportModal isOpen={showReportModal && !!opponentId} onClose={() => setShowReportModal(false)}
        onSubmit={async (reason, details) => {
          const res = await fetch("/api/reports/submit", {
            method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include",
            body: JSON.stringify({ reportedClerkId: opponentId, gameType: "coin-flip", gameId: myGameId ? String(myGameId) : null, reason, details: details || undefined }),
          });
          const data = await res.json();
          if (!data.success) throw new Error(data.error || "Failed to submit report");
        }}
        reportedPlayerName="Opponent" gameType="Coin Flip" />
    </>
  );
}
