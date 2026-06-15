"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { usePostHog } from "posthog-js/react";
import NavigationBar from "../../../components/navigation-bar";
import GameTrack from "./components/GameTrack";
import {
  DEFAULT_LANES,
  getDifficultyMultipliers,
  LANE_RUNNER_DIFFICULTIES,
} from "../../../lib/laneRunner";

const MAX_LANES = DEFAULT_LANES;

export default function LaneRunnerPage() {
  const posthog = usePostHog();
  const [betAmount, setBetAmount] = useState(10);
  const [difficulty, setDifficulty] = useState("easy");

  const [currentLane, setCurrentLane] = useState(0);
  const [multiplier, setMultiplier] = useState(1);
  const [payout, setPayout] = useState(0);

  const [hasLost, setHasLost] = useState(false);
  const [hasCashedOut, setHasCashedOut] = useState(false);

  const [safeTilesByLane, setSafeTilesByLane] = useState({});
  const [selectedTileByLane, setSelectedTileByLane] = useState({});

  const [error, setError] = useState("");
  const [running, setRunning] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  const [fairData, setFairData] = useState(null);
  const [history, setHistory] = useState([]);

  const [userTokens, setUserTokens] = useState(0);
  const [isBalanceLoading, setIsBalanceLoading] = useState(false);

  const [crashLane, setCrashLane] = useState(null);

  const loseSoundRef = useRef(null);
  const winSoundRef = useRef(null);
  const [showCashoutPopup, setShowCashoutPopup] = useState(false);
  const [showWinPopup, setShowWinPopup] = useState(false);
  const [showLosePopup, setShowLosePopup] = useState(false);
  const [popupData, setPopupData] = useState(null);

  const difficultyConfig = useMemo(
    () => LANE_RUNNER_DIFFICULTIES[difficulty],
    [difficulty],
  );

  const laneMultipliers = useMemo(
    () => getDifficultyMultipliers(difficulty),
    [difficulty],
  );

  useEffect(() => {
    fetchUserTokens();
  }, []);

  async function fetchUserTokens() {
    setIsBalanceLoading(true);
    try {
      const res = await fetch("/api/get-user-tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
      });

      const json = await res.json();
      if (res.ok && json.success) {
        setUserTokens(Number(json.data.balance));
      }
    } catch (e) {
      console.error(e);
    } finally {
      setIsBalanceLoading(false);
    }
  }

  async function startGame() {
    setIsLoading(true);
    setError("");
    setHasLost(false);
    setHasCashedOut(false);
    setShowCashoutPopup(false);
    setShowWinPopup(false);
    setShowLosePopup(false);

    setCurrentLane(0);
    setMultiplier(1);
    setPayout(Number(betAmount));

    setSelectedTileByLane({});
    setSafeTilesByLane({});
    setCrashLane(null);

    const res = await fetch("/api/lane-runner/play", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        action: "start",
        betAmount,
        difficulty,
      }),
    });

    const json = await res.json();

    if (!res.ok || !json.success) {
      setError(json.error || "Unable to start game");
      setRunning(false);
      setIsLoading(false);
      return;
    }

    setRunning(true);
    setPayout(Number(betAmount * (json.data.multiplier || 1)));
    setUserTokens(Number(json.data.newBalance ?? userTokens));
    posthog?.capture("lane_runner_game_started", { bet_amount: betAmount, difficulty });

    setFairData({
      serverSeedHash: json.data.serverSeedHash,
      nonce: json.data.nonce,
    });

    setIsLoading(false);
  }

  async function pickTile(tileIndex) {
    if (!running || hasLost || hasCashedOut || isLoading) return;

    setIsLoading(true);

    const res = await fetch("/api/lane-runner/play", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ action: "pick", tileIndex }),
    });

    const json = await res.json();
    setIsLoading(false);

    if (!res.ok || !json.success) {
      setError(json.error || "Pick failed");
      return;
    }

    const data = json.data;

    setSelectedTileByLane((prev) => ({
      ...prev,
      [data.lane]: tileIndex,
    }));

    setSafeTilesByLane((prev) => ({
      ...prev,
      [data.lane]: data.safeTiles || [],
    }));

    setMultiplier(data.multiplier);
    setPayout(Number(betAmount * (data.multiplier ?? multiplier)));
    setCurrentLane(data.currentLane ?? data.lane);

    if (typeof data.newBalance === "number") {
      setUserTokens(data.newBalance);
    }

    if (data.hasLost) {
      triggerLosePopup(data);
      setCrashLane(data.lane);
      setHasLost(true);
      setRunning(false);
      loseSoundRef.current?.play().catch(() => {});
      posthog?.capture("lane_runner_game_ended", { result: "loss", bet_amount: betAmount, difficulty, lane: data.lane + 1, multiplier: data.multiplier });

      setHistory((prev) =>
        [
          {
            id: Date.now(),
            result: "lost",
            lane: data.lane + 1,
            multiplier: data.multiplier,
            payout: 0,
          },
          ...prev,
        ].slice(0, 10),
      );
      return;
    }

    if (data.hasCashedOut) {
      triggerWinPopup(data);
      setHasCashedOut(true);
      setRunning(false);
      setShowCashoutPopup(true);
      posthog?.capture("lane_runner_game_ended", { result: "win", bet_amount: betAmount, difficulty, multiplier: data.multiplier, payout: data.payout });

      setHistory((prev) =>
        [
          {
            id: Date.now(),
            result: "cashed_out",
            lane: data.currentLane,
            multiplier: data.multiplier,
            payout: data.payout,
          },
          ...prev,
        ].slice(0, 10),
      );
      return;
    }

    winSoundRef.current?.play().catch(() => {});
  }

  async function cashOut() {
    if (!running || hasLost || hasCashedOut) return;

    setIsLoading(true);

    const res = await fetch("/api/lane-runner/play", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ action: "cashout" }),
    });

    const json = await res.json();
    setIsLoading(false);

    if (!res.ok || !json.success) {
      setError(json.error || "Cashout failed");
      return;
    }

    setHasCashedOut(true);
    setRunning(false);
    posthog?.capture("lane_runner_game_ended", { result: "cashout", bet_amount: betAmount, difficulty, multiplier: json.data.multiplier, payout: json.data.payout });

    setPopupData({
      payout: json.data.payout,
      multiplier: json.data.multiplier,
    });

    setShowCashoutPopup(true);
    setMultiplier(json.data.multiplier);
    setPayout(
      Number(json.data.payout || betAmount * json.data.multiplier || 0),
    );
    setUserTokens(Number(json.data.newBalance ?? userTokens));

    setHistory((prev) =>
      [
        {
          id: Date.now(),
          result: "cashed_out",
          lane: currentLane,
          multiplier: json.data.multiplier,
          payout: json.data.payout,
        },
        ...prev,
      ].slice(0, 10),
    );
  }

  function triggerWinPopup(data) {
    setPopupData(data);
    setShowWinPopup(true);
  }

  function triggerLosePopup(data) {
    setPopupData(data);
    setShowLosePopup(true);
  }

  function handleTowerPick(laneIndex, tileIndex) {
    if (laneIndex !== currentLane) return;
    pickTile(tileIndex);
  }

  return (
    <div className="min-h-screen overflow-x-clip bg-[radial-gradient(circle_at_top,#1b2150_0%,#080b1f_35%,#03040d_100%)] pb-24 pt-20 text-white md:pb-8">
      <NavigationBar currentPath="/casino/lane-runner" />
      <audio ref={winSoundRef} src="/sounds/coin-flip.mp3" />
      <audio ref={loseSoundRef} src="/sounds/coin-flip.mp3" />

      <div className="mx-auto flex max-w-7xl flex-col gap-4 px-3 pb-10 sm:px-4 md:flex-row md:gap-6">
        <div className="w-full rounded-3xl border border-cyan-300/20 bg-slate-900/70 p-5 backdrop-blur md:w-96">
          <h1 className="text-2xl font-black text-cyan-100">Towers</h1>
          <p className="mt-2 text-sm text-white/75">
            Carve a safe path to the top. One bad tile ends the run.
          </p>
          <p className="mt-1 text-sm">
            Balance: {isBalanceLoading ? "..." : userTokens.toFixed(2)}
          </p>

          <label className="mt-4 block text-xs uppercase tracking-wider text-white/60">
            Bet Amount
          </label>
          <input
            className="w-full rounded-xl border border-white/15 bg-slate-950 p-2"
            type="number"
            min={1}
            value={betAmount}
            onChange={(e) => setBetAmount(Number(e.target.value))}
          />

          <label className="mt-4 block text-xs uppercase tracking-wider text-white/60">
            Difficulty
          </label>
          <div className="mt-2 grid grid-cols-3 gap-2">
            {Object.entries(LANE_RUNNER_DIFFICULTIES).map(([key, config]) => (
              <button
                key={key}
                type="button"
                onClick={() => setDifficulty(key)}
                className={`rounded-xl border p-2 text-xs transition ${
                  difficulty === key
                    ? "border-cyan-300 bg-cyan-300/20 text-cyan-50"
                    : "border-white/15 bg-black/20 text-white/80 hover:border-cyan-300/40"
                }`}
              >
                <p className="font-bold uppercase">{config.label}</p>
                <p className="text-[10px] text-white/70">
                  {config.width} x {MAX_LANES}
                </p>
              </button>
            ))}
          </div>

          <div className="mt-4 grid grid-cols-2 gap-2 text-xs">
            <p className="rounded-xl bg-black/30 p-2">
              Level: {Math.min(currentLane + 1, MAX_LANES)}/{MAX_LANES}
            </p>
            <p className="rounded-xl bg-black/30 p-2">
              x{multiplier.toFixed(2)}
            </p>
            <p className="col-span-2 rounded-xl bg-black/30 p-2">
              Payout: {payout.toFixed(2)}
            </p>
          </div>

          <button
            onClick={startGame}
            disabled={running || isLoading}
            className="mt-3 w-full rounded-xl bg-gradient-to-r from-cyan-400 to-blue-500 py-2 font-bold text-black transition hover:brightness-110 disabled:opacity-60"
          >
            {isLoading && !running ? "Starting..." : "Start Tower"}
          </button>

          {error && <p className="mt-3 text-xs text-red-400">{error}</p>}
          <div className="rounded-3xl border border-white/10 bg-black/30 p-4 text-xs h-fit mt-4">
            <p className="mb-2 text-sm font-semibold text-cyan-200">
              Recent Runs
            </p>

            <div className="max-h-[60vh] overflow-y-auto pr-1">
              {history.length === 0 && (
                <p className="text-white/50">No runs yet.</p>
              )}

              {history.map((h) => (
                <p
                  key={h.id}
                  className="border-b border-white/10 py-1 last:border-0"
                >
                  {h.result} • level {h.lane} • x{h.multiplier?.toFixed?.(2)} •{" "}
                  {h.payout}
                </p>
              ))}
            </div>
          </div>
        </div>

        <div className="flex-1">
          <GameTrack
            towerRows={Array.from({ length: MAX_LANES }, (_, i) => i)}
            towerWidth={difficultyConfig.width}
            currentLane={currentLane}
            currentMultiplier={multiplier}
            running={running}
            hasLost={hasLost}
            hasCashedOut={hasCashedOut}
            crashLane={crashLane}
            laneMultipliers={laneMultipliers}
            selectedTileByLane={selectedTileByLane}
            safeTilesByLane={safeTilesByLane}
            onAttemptTile={handleTowerPick}
            onCashout={cashOut}
          />
        </div>
      </div>

      {showWinPopup && (
        <PopupShell
          tone="emerald"
          title="TOWER CLEARED!"
          onClose={() => setShowWinPopup(false)}
        >
          <p className="mt-2 text-black">
            +{popupData?.payout?.toFixed?.(2)} tokens
          </p>
          <p className="text-sm text-black">
            x{popupData?.multiplier?.toFixed?.(2)}
          </p>
        </PopupShell>
      )}

      {showLosePopup && (
        <PopupShell
          tone="red"
          title="BAD TILE"
          onClose={() => setShowLosePopup(false)}
        >
          <p className="mt-2 text-white">
            You hit a bad tile and lost this bet.
          </p>
          <p className="text-sm text-white/85">Level {popupData?.lane + 1}</p>
        </PopupShell>
      )}

      {showCashoutPopup && (
        <PopupShell
          tone="cyan"
          title="CASHED OUT"
          onClose={() => setShowCashoutPopup(false)}
        >
          <p className="mt-2 text-black">
            +{popupData?.payout?.toFixed?.(2)} tokens
          </p>
          <p className="text-sm text-black">
            x{popupData?.multiplier?.toFixed?.(2)}
          </p>
        </PopupShell>
      )}
    </div>
  );
}

function PopupShell({ title, children, tone, onClose }) {
  const palette = {
    red: "bg-red-600 text-white",
    cyan: "bg-cyan-500 text-black",
    emerald: "bg-emerald-500 text-black",
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <motion.div
        initial={{ opacity: 0, scale: 0.86, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        className={`relative w-80 rounded-2xl p-8 text-center shadow-2xl ${palette[tone]}`}
      >
        <button
          onClick={onClose}
          className="absolute right-2 top-2 text-lg font-bold"
        >
          ✕
        </button>
        <h2 className="text-2xl font-bold">{title}</h2>
        {children}
      </motion.div>
    </div>
  );
}
