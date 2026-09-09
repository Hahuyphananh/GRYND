"use client";
import { useRouter } from "next/navigation";
import NavigationBar from "../../../components/navigation-bar";
import CreatorModeLobby from "../../../components/creator-mode/CreatorModeLobby";
import Footer from "../../../components/Footer";
import { RulesModal, useFirstVisitRules } from "../../../components/lobby/PvpLobby";
import { useEffect, useRef, useState } from "react";
import { useSocket } from "../../../context/SocketProvider";
import {
  IconChess,
  IconRobot,
  IconPalette,
  IconClock,
  IconBook,
} from "@tabler/icons-react";
import { playCardDraw, playTick, playBuzz } from "../../../lib/gameAudio";
const AI_DIFFICULTY_LEVELS = [
  { level: 1, label: "Beginner", desc: "Easy opponent" },
  { level: 2, label: "Casual", desc: "Relaxed play" },
  { level: 3, label: "Intermediate", desc: "Moderate challenge" },
  { level: 4, label: "Advanced", desc: "Strong opponent" },
  { level: 5, label: "Expert", desc: "Very tough" },
];
const TIMER_OPTIONS = [
  { id: "1min", label: "1 Min", time: 60 },
  { id: "2min", label: "2 Min", time: 120 },
  { id: "3min", label: "3 Min", time: 180 },
  { id: "5min", label: "5 Min", time: 300 },
  { id: "10min", label: "10 Min", time: 600 },
  { id: "30min", label: "30 Min", time: 1800 },
];

export default function ChessLobby() {
  const router = useRouter();
  const { socket } = useSocket();

  const [showBetPopup, setShowBetPopup] = useState(false);
  const [aiDifficulty, setAiDifficulty] = useState(3);
  const [aiTimer, setAiTimer] = useState("5min");
  const [aiColor, setAiColor] = useState("random");
  const [availableGames, setAvailableGames] = useState([]);
  const [isLoadingAvailableGames, setIsLoadingAvailableGames] = useState(false);
  const [joiningGameId, setJoiningGameId] = useState(null);
  const [creatingGame, setCreatingGame] = useState(false);
  const [stakeInput, setStakeInput] = useState("");
  const [userBalance, setUserBalance] = useState(null);
  const [selectedTimer, setSelectedTimer] = useState("");
  const timerTrackRef = useRef(null);
  const [draggingTimer, setDraggingTimer] = useState(false);
  const [timerDrag, setTimerDrag] = useState(null); // float index while dragging
  const [error, setError] = useState(null);
  const [aiGameLoading, setAiGameLoading] = useState(false);
  const [showRules, setShowRules] = useState(false);
  const firstVisitRules = useFirstVisitRules("chess");
  useEffect(() => {
    if (firstVisitRules) setShowRules(true);
  }, [firstVisitRules]);

  // Auto-clear errors after 5 seconds
  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(null), 5000);
    return () => clearTimeout(t);
  }, [error]);

  // Wallet balance — powers the 1/4, 1/2 and All In stake quick-buttons.
  useEffect(() => {
    fetch("/api/get-user-tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
    })
      .then((r) => r.json())
      .then((data) => {
        if (data?.success) setUserBalance(Number(data.data.balance));
      })
      .catch(() => {});
  }, []);

  const stakeNum = Number(stakeInput) || 0;
  const quarterBet =
    userBalance != null ? Math.max(1, Math.floor((userBalance / 4) * 100) / 100) : null;
  const halfBet =
    userBalance != null ? Math.max(1, Math.floor((userBalance / 2) * 100) / 100) : null;
  const allInBet =
    userBalance != null ? Math.max(1, Math.floor(userBalance * 100) / 100) : null;

  // ── Timeline toggle (snaps to the nearest of the 6 preset times) ─────
  const timerIndexFromEvent = (clientX) => {
    const el = timerTrackRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return ratio * (TIMER_OPTIONS.length - 1);
  };

  const onTimerPointerDown = (e) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setDraggingTimer(true);
    setTimerDrag(timerIndexFromEvent(e.clientX));
  };

  const onTimerPointerMove = (e) => {
    if (!draggingTimer) return;
    setTimerDrag(timerIndexFromEvent(e.clientX));
  };

  const onTimerPointerUp = (e) => {
    if (!draggingTimer) return;
    // Lock onto the nearest of the 6 preset times on release.
    const idx = Math.round(timerIndexFromEvent(e.clientX));
    const snapped = Math.min(TIMER_OPTIONS.length - 1, Math.max(0, idx));
    setSelectedTimer(TIMER_OPTIONS[snapped].id);
    setTimerDrag(null);
    setDraggingTimer(false);
  };

  const onTimerKeyDown = (e) => {
    const idx = displayIndexRounded;
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      setSelectedTimer(TIMER_OPTIONS[Math.max(0, idx - 1)].id);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      setSelectedTimer(TIMER_OPTIONS[Math.min(TIMER_OPTIONS.length - 1, idx + 1)].id);
    }
  };

  const displayIndex =
    timerDrag ??
    Math.max(0, TIMER_OPTIONS.findIndex((t) => t.id === selectedTimer));
  const displayIndexRounded = Math.min(
    TIMER_OPTIONS.length - 1,
    Math.max(0, Math.round(displayIndex)),
  );

  useEffect(() => {
    fetchAvailableGames();
  }, []);

  useEffect(() => {
    if (!socket) return;
    const roomId = "lobby:chess";
    const handleLobbyUpdate = () => fetchAvailableGames();

    // Join room and re-join on reconnect
    const joinRoom = () => socket.emit("join_room", { roomId });
    joinRoom();
    socket.on("connect", joinRoom);
    socket.on("lobby:updated", handleLobbyUpdate);

    return () => {
      socket.emit("leave_room", { roomId });
      socket.off("connect", joinRoom);
      socket.off("lobby:updated", handleLobbyUpdate);
    };
  }, [socket]);

  async function fetchAvailableGames() {
    setIsLoadingAvailableGames(true);
    try {
      const res = await fetch("/api/chess/available-games", {
        cache: "no-store",
      });
      const data = await res.json();
      if (data.success) {
        setAvailableGames(data.data.games || []);
      }
    } catch (error) {
      console.error("Failed to load available chess games", error);
    }
    setIsLoadingAvailableGames(false);
  }

  const selectedTimerObj = TIMER_OPTIONS.find((t) => t.id === selectedTimer);

  async function createGame() {
    if (!stakeNum || !selectedTimer || creatingGame) return;

    setError(null);
    setCreatingGame(true);
    try {
      const res = await fetch("/api/chess/create-game", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tableAmount: stakeNum,
          timerMode: selectedTimer,
          timeLimit: selectedTimerObj?.time,
        }),
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Unable to create game");
        playBuzz();
        return;
      }

      // Game created/matched — the first move is imminent.
      playCardDraw();

      const timerObj = TIMER_OPTIONS.find(
        (t) => t.id === (data.timerMode || selectedTimer),
      );
      const timerParam = timerObj?.time;
      if (data.ready || data.status === "in_progress") {
        socket?.emit("room_event", {
          roomId: "lobby:chess",
          event: "lobby:updated",
        });
        router.push(
          `/casino/chess-game/${data.gameId}?color=${data.color}&timer=${selectedTimer}`,
        );
        return;
      }

      socket?.emit("room_event", {
        roomId: "lobby:chess",
        event: "lobby:updated",
      });
      router.push(
        `/casino/chess/${stakeNum}?gameId=${data.gameId}&color=${data.color}&timer=${selectedTimer}`,
      );
    } catch (error) {
      console.error("Failed to create chess game", error);
      setError("Unable to create game");
    } finally {
      setCreatingGame(false);
    }
  }

  async function joinSpecificGame(gameId) {
    setError(null);
    setJoiningGameId(gameId);
    try {
      const targetGame = availableGames.find((game) => game.id === gameId);
      const res = await fetch("/api/chess/join-game", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gameId }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setError(data.error || "Unable to join game");
        playBuzz();
        fetchAvailableGames();
        return;
      }

      playCardDraw();
      socket?.emit("room_event", {
        roomId: "lobby:chess",
        event: "lobby:updated",
      });
      const joinTimer = TIMER_OPTIONS.find(
        (t) => t.id === targetGame?.timerMode,
      );

      router.push(
        `/casino/chess-game/${gameId}?color=black&timer=${targetGame?.timerMode || "5min"}`,
      );
    } catch (error) {
      console.error("Failed to join chess game", error);
      setError("Unable to join game");
    } finally {
      setJoiningGameId(null);
    }
  }

  async function startAIGame() {
    setAiGameLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/chess/create-ai-game", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          ai_game: true,
          difficultyLevel: aiDifficulty,
        }),
      });

      if (!res.ok) throw new Error("Failed to create AI game");

      // AI match starting — piece-move cue.
      playCardDraw();

      const data = await res.json();
      const timerObj = TIMER_OPTIONS.find((t) => t.id === aiTimer);
      router.push(`/casino/chess/ai?gameId=${data.gameId}&difficulty=${aiDifficulty}&timer=${timerObj?.time || 300}&color=${aiColor}`);
    } catch (error) {
      console.error("Error creating AI game:", error);
      setError("Failed to create AI game");
    } finally {
      setAiGameLoading(false);
    }
  }

  return (
    <div className="min-h-screen overflow-x-clip bg-gradient-to-br from-[#001933] to-[#000d1a] px-3 pb-24 pt-20 text-center text-white sm:px-6 md:pb-8">
      <NavigationBar currentPath="/casino" />
      {/* Creator Mode toggle (admin-only — renders nothing for other users). */}
      <div className="mt-4 flex justify-center">
        <CreatorModeLobby />
      </div>
      <h1 className="mb-4 mt-4 text-3xl font-bold text-[#FFD700] drop-shadow-[0_0_12px_rgba(255,215,0,0.55)] sm:text-4xl">
        <span className="inline-flex items-center gap-2"><IconChess size={28} /> Chess Arena: Challenge Players</span>
      </h1>

      {/* How to Play — rules modal at the top of the lobby */}
      <div className="mb-6 text-center">
        <button
          onClick={() => setShowRules(true)}
          className="inline-flex items-center gap-1.5 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-2 text-sm font-bold text-amber-300 transition-all duration-300 hover:bg-amber-500/20 hover:scale-105 shadow-[0_0_14px_rgba(251,191,36,0.15)]"
        >
          <IconBook size={15} /> How to Play
        </button>
      </div>
      {showRules && (
        <RulesModal
          title="How to Play"
          sections={[
            {
              heading: "Checkmate to win",
              body: (
                <>
                  Standard chess rules. Checkmate your opponent&apos;s
                  king to win the match.
                </>
              ),
            },
            {
              heading: "Stake & timer",
              body: (
                <>
                  Pick a stake and a move timer before creating your
                  game. The winner takes the pot minus a 10% platform fee.
                </>
              ),
            },
            {
              heading: "Play vs AI",
              body: (
                <>
                  Practice against the bot at five difficulty levels
                  (Beginner → Expert) with your choice of timer.
                </>
              ),
            },
          ]}
          onClose={() => setShowRules(false)}
        />
      )}

      <div className="max-w-4xl mx-auto bg-[#0b224f]/85 p-6 rounded-xl border border-[#00e5ff]/30 mb-8 shadow-[0_0_24px_rgba(0,229,255,0.18)]">
        <h2 className="text-2xl font-bold text-[#FFD700] mb-4">
          Create Multiplayer Game
        </h2>
        <p className="text-white/80 mb-5">
          Select a stake and timer, then create your game. Winner gets the pot minus 10% platform fee.
        </p>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
          {/* Stake card (crash-style) */}
          <div className="relative p-5 flex flex-col gap-3 rounded-2xl border border-[#00e5ff]/30 bg-[#08142f]/70 overflow-hidden">
            <div className="absolute top-0 left-0 w-full h-[2px] bg-gradient-to-r from-transparent via-[#00e5ff] to-transparent opacity-70" />
            <div className="flex items-center justify-between">
              <div>
                <span className="text-xs uppercase tracking-widest text-cyan-100/60">
                  Stake
                </span>
                <div className="text-sm font-bold text-white/90 mt-0.5">
                  Set your stake
                </div>
              </div>
              <span className="px-3 py-1 rounded-full text-xs font-bold border border-cyan-500/40 bg-cyan-500/15 text-cyan-300">
                Custom
              </span>
            </div>
            <div className="flex flex-col items-center gap-3">
            {/* Custom stake input (crash-style): type your exact stake */}
            <div className="w-full max-w-xs">
              <div className="flex items-center bg-[#020617] border border-[#00e5ff]/40 rounded-xl overflow-hidden focus-within:border-[#00e5ff] focus-within:shadow-[0_0_15px_rgba(0,229,255,0.3)] transition-all">
                <span className="pl-4 text-[#00e5ff] font-bold text-lg">$</span>
                <input
                  type="number"
                  value={stakeInput}
                  aria-label="Stake amount"
                  onChange={(e) => {
                    const val = e.target.value;
                    if (val === "" || val === "0") {
                      setStakeInput(val);
                    } else {
                      const parsed = parseFloat(val);
                      if (Number.isFinite(parsed)) {
                        setStakeInput(
                          Math.min(
                            1000000,
                            Math.max(1, Math.floor(parsed * 100) / 100),
                          ).toString(),
                        );
                      }
                    }
                  }}
                  min={1}
                  max={1000000}
                  step="0.01"
                  placeholder="1"
                  className="flex-1 bg-transparent px-2 py-3 text-white text-lg font-bold outline-none text-center"
                />
              </div>
            </div>

            {/* Quick stake buttons: 1/4, 1/2, All In, 100$ */}
            <div className="flex flex-wrap gap-2 justify-center">
              {[
                { label: "1/4", value: quarterBet },
                { label: "1/2", value: halfBet },
                { label: "All In", value: allInBet },
                { label: "100$", value: 100 },
              ].map((btn) => (
                <button
                  key={btn.label}
                  onClick={() => {
                    setStakeInput(String(btn.value));
                    playTick();
                  }}
                  disabled={btn.value == null || btn.value < 1}
                  className={`px-4 py-1.5 rounded-full text-xs font-bold border transition-all duration-150 disabled:opacity-40 disabled:cursor-not-allowed ${
                    stakeNum === btn.value
                      ? "bg-[#00e5ff] text-[#001933] border-[#00e5ff] shadow-[0_0_10px_rgba(0,229,255,0.5)]"
                      : "bg-[#08142f] text-[#a8f4ff] border-[#00e5ff]/30 hover:bg-[#0d335f] hover:border-[#00e5ff]/60"
                  }`}
                >
                  {btn.label}
                </button>
              ))}
            </div>

            {userBalance != null && (
              <p className="text-xs text-white/50">
                Balance: $
                {userBalance.toLocaleString(undefined, { maximumFractionDigits: 2 })}
              </p>
            )}
            {userBalance != null && stakeNum > userBalance && (
              <p className="text-[11px] text-red-400/80 text-center">
                Insufficient balance for a ${stakeNum} stake
              </p>
            )}

            {/* Pot preview */}
            {stakeNum > 0 && selectedTimer && (
              <div className="mt-1 w-full bg-emerald-900/20 border border-emerald-400/30 text-emerald-300 p-2 rounded text-sm text-center">
                Pot: ${(stakeNum * 2).toLocaleString()} · Winner gets ~${(stakeNum * 2 * 0.9).toLocaleString(undefined, { maximumFractionDigits: 2 })} (after 10% platform fee)
              </div>
            )}
            </div>
          </div>

          {/* Timer card (crash-style) */}
          <div className="relative p-5 flex flex-col gap-3 rounded-2xl border border-[#00e5ff]/30 bg-[#08142f]/70 overflow-hidden">
            <div className="absolute top-0 left-0 w-full h-[2px] bg-gradient-to-r from-transparent via-[#FFD700] to-transparent opacity-70" />
            <div className="flex items-center justify-between">
              <div>
                <span className="text-xs uppercase tracking-widest text-cyan-100/60">
                  Timer
                </span>
                <div className="text-sm font-bold text-white/90 mt-0.5">
                  Pick your pace
                </div>
              </div>
              <span className="px-3 py-1 rounded-full text-xs font-bold border border-[#FFD700]/40 bg-[#FFD700]/10 text-[#FFD700]">
                6 modes
              </span>
            </div>
            <div className="flex flex-col gap-3">
            {/* Current selection badge */}
            <div className="mb-4 text-center">
              <span className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-full border border-[#FFD700]/50 bg-[#FFD700]/10 text-[#FFD700] font-bold">
                <IconClock size={15} /> {TIMER_OPTIONS[displayIndexRounded].label}
              </span>
            </div>

            {/* Timeline toggle — click & slide; locks to nearest preset on release */}
            <div
              ref={timerTrackRef}
              role="slider"
              aria-label="Move timer"
              aria-valuemin={0}
              aria-valuemax={TIMER_OPTIONS.length - 1}
              aria-valuenow={displayIndexRounded}
              aria-valuetext={TIMER_OPTIONS[displayIndexRounded].label}
              tabIndex={0}
              onPointerDown={onTimerPointerDown}
              onPointerMove={onTimerPointerMove}
              onPointerUp={onTimerPointerUp}
              onPointerCancel={onTimerPointerUp}
              onKeyDown={onTimerKeyDown}
              className="relative h-10 select-none touch-none cursor-grab active:cursor-grabbing outline-none"
            >
              {/* Track line */}
              <div className="absolute top-1/2 left-0 right-0 h-1 -translate-y-1/2 rounded-full bg-[#0a1a3a] border border-[#00e5ff]/20" />
              {/* Filled portion */}
              <div
                className="absolute top-1/2 left-0 h-1 -translate-y-1/2 rounded-full bg-gradient-to-r from-[#00e5ff] to-[#FFD700]"
                style={{ width: `${(displayIndex / (TIMER_OPTIONS.length - 1)) * 100}%` }}
              />
              {/* Tick stops */}
              {TIMER_OPTIONS.map((t, i) => (
                <div
                  key={t.id}
                  className={`absolute top-1/2 -translate-x-1/2 -translate-y-1/2 w-2.5 h-2.5 rounded-full border-2 transition-colors ${
                    i <= displayIndexRounded
                      ? "bg-[#FFD700] border-[#FFD700]"
                      : "bg-[#0a1a3a] border-[#00e5ff]/40"
                  }`}
                  style={{ left: `${(i / (TIMER_OPTIONS.length - 1)) * 100}%` }}
                />
              ))}
              {/* Draggable handle */}
              <div
                className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 w-6 h-6 rounded-full bg-gradient-to-br from-[#00e5ff] to-[#FFD700] border-2 border-white/40 shadow-[0_0_12px_rgba(0,229,255,0.6)]"
                style={{ left: `${(displayIndex / (TIMER_OPTIONS.length - 1)) * 100}%` }}
              />
            </div>

              {/* Preset labels */}
              <div className="flex justify-between mt-2 text-[10px] text-white/40 px-0">
                {TIMER_OPTIONS.map((t) => (
                  <span
                    key={t.id}
                    className={selectedTimer === t.id ? "text-[#FFD700] font-bold" : ""}
                  >
                    {t.label}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </div>

        {error && (
          <div className="mb-4 bg-red-900/30 border border-red-400/40 text-red-300 p-2 rounded text-sm text-center">
            {error}
          </div>
        )}
      </div>

      {/* Sticky action bar — Create Game + Play vs AI, sticks on scroll */}
      <div className="sticky bottom-0 z-30 mt-4 px-3">
        <div className="mx-auto max-w-4xl flex flex-col sm:flex-row gap-3 rounded-xl border border-[#00e5ff]/30 bg-[#0b224f]/95 backdrop-blur-md px-4 py-3 shadow-[0_-8px_30px_rgba(0,0,0,0.5)]">
          <button
            onClick={createGame}
            disabled={!stakeNum || !selectedTimer || creatingGame}
            className="flex-1 bg-[#FFD700] text-[#030817] px-6 py-3 rounded-lg text-lg font-bold hover:bg-[#ffe14f] shadow-[0_0_16px_rgba(255,215,0,0.45)] disabled:bg-[#7f8520] disabled:text-[#c6c6c6] disabled:cursor-not-allowed"
          >
            {creatingGame ? "Creating..." : "Create Game"}
          </button>
          <button
            onClick={() => setShowBetPopup(true)}
            className="flex-1 bg-gradient-to-r from-purple-600 to-indigo-600 text-white px-6 py-3 rounded-lg text-lg font-bold hover:from-purple-500 hover:to-indigo-500 shadow-[0_0_16px_rgba(139,92,246,0.45)] transition-colors"
          >
            <span className="inline-flex items-center justify-center gap-2"><IconRobot size={18} /> Play vs AI</span>
          </button>
        </div>
      </div>

      <div className="max-w-3xl mx-auto mt-10 bg-[#0b224f]/85 p-5 rounded-xl border border-[#00e5ff]/30 text-left shadow-[0_0_24px_rgba(0,229,255,0.18)]">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-2xl font-bold text-[#FFD700]">Available Games</h2>
          <button
            onClick={fetchAvailableGames}
            className="bg-[#00e5ff] text-[#001933] px-4 py-2 rounded-lg font-semibold hover:bg-[#49eeff] shadow-[0_0_10px_rgba(0,229,255,0.35)]"
          >
            {isLoadingAvailableGames ? "Refreshing..." : "Refresh"}
          </button>
        </div>

        {availableGames.length === 0 ? (
          <div className="text-center py-8">
            <IconChess size={48} className="opacity-30" />
            <p className="text-white/60 mt-2">
              No open games right now. Create one from the options above.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {availableGames.map((game) => (
              <div
                key={game.id}
                className="flex items-center justify-between bg-[#08142f] border border-[#00e5ff]/20 rounded-lg p-3"
              >
                <div>
                  <p className="font-semibold">Game #{game.id}</p>
                  <p className="text-sm text-white/80">
                    Host: {game.hostName || "Player"} · Stake: $
                    {Number(game.betAmount)} · Timer:{" "}
                    {TIMER_OPTIONS.find((t) => t.id === game.timerMode)
                      ?.label || "Unknown"}
                    {game.createdAt && (
                      <> · Waiting {(() => {
                        const mins = Math.floor((Date.now() - new Date(game.createdAt).getTime()) / 60000);
                        return mins < 1 ? "<1m" : `${mins}m`;
                      })()}</>
                    )}
                  </p>
                </div>
                <button
                  onClick={() => joinSpecificGame(game.id)}
                  disabled={joiningGameId === game.id}
                  className="bg-[#00e5ff] text-[#001933] px-4 py-2 rounded-lg font-bold hover:bg-[#49eeff] disabled:bg-[#246874]"
                >
                  {joiningGameId === game.id ? "Joining..." : "Join"}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {showBetPopup && (
        <div className="fixed inset-0 bg-black/75 flex items-center justify-center z-50">
          <div className="bg-[#08142f] text-white p-8 rounded-lg w-96 border border-[#00e5ff]/40 shadow-[0_0_22px_rgba(0,229,255,0.25)]">
            <h2 className="text-2xl font-bold mb-2 text-center text-[#FFD700]">
              Choose AI Difficulty
            </h2>
            <p className="text-white/60 text-xs text-center mb-4">
              Free to play, no stakes!
            </p>

            {/* Color selection */}
            <h3 className="mb-2 flex items-center justify-center gap-1.5 text-sm font-semibold text-white/70"><IconPalette size={16} /> Play as:</h3>
            <div className="flex gap-2 justify-center mb-4">
              {[
                { key: "white", label: "♔ White", desc: "Move first" },
                { key: "black", label: "♚ Black", desc: "AI moves first" },
                { key: "random", label: "Random", desc: "Surprise me" },
              ].map((opt) => (
                <button
                  key={opt.key}
                  onClick={() => {
                    setAiColor(opt.key);
                    playTick();
                  }}
                  className={`flex-1 px-3 py-2 rounded-lg text-xs font-bold border transition-all text-center ${
                    aiColor === opt.key
                      ? "bg-[#FFD700] text-[#030817] border-[#FFD700]"
                      : "bg-[#0a1a3a] text-white/70 border-[#00e5ff]/20 hover:border-[#00e5ff]/40"
                  }`}
                >
                  <div>{opt.label}</div>
                  <div className={`text-[10px] mt-0.5 ${aiColor === opt.key ? "text-[#030817]/60" : "text-white/30"}`}>{opt.desc}</div>
                </button>
              ))}
            </div>

            {/* Timer selection */}
            <h3 className="mb-2 flex items-center justify-center gap-1.5 text-sm font-semibold text-white/70"><IconClock size={16} /> Timer:</h3>
            <div className="flex flex-wrap gap-2 justify-center mb-4">
              {TIMER_OPTIONS.map((t) => (
                <button
                  key={t.id}
                  onClick={() => {
                    setAiTimer(t.id);
                    playTick();
                  }}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold border transition-all ${
                    aiTimer === t.id
                      ? "bg-[#FFD700] text-[#030817] border-[#FFD700]"
                      : "bg-[#0a1a3a] text-white/70 border-[#00e5ff]/20 hover:border-[#00e5ff]/40"
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>

            {/* Difficulty levels */}
            <div className="flex flex-col gap-2 mb-4">
              {AI_DIFFICULTY_LEVELS.map((diff) => (
                <button
                  key={diff.level}
                  onClick={() => {
                    setAiDifficulty(diff.level);
                    playTick();
                  }}
                  className={`w-full text-left px-4 py-3 rounded-lg border-2 transition-all ${
                    aiDifficulty === diff.level
                      ? "bg-[#FFD700] text-[#030817] border-[#FFD700] shadow-[0_0_14px_rgba(255,215,0,0.45)]"
                      : "bg-[#0a1a3a] text-white/80 border-[#00e5ff]/20 hover:bg-[#0d224f] hover:border-[#00e5ff]/40"
                  }`}
                >
                  <span className="font-bold">{diff.label}</span>
                  <span className={`ml-2 text-xs ${aiDifficulty === diff.level ? "text-[#030817]/70" : "text-white/40"}`}>
                    · {diff.desc}
                  </span>
                </button>
              ))}
            </div>

            {error && (
              <div className="mb-2 text-red-400 text-xs text-center">{error}</div>
            )}

            <div className="flex justify-between">
              <button
                onClick={() => setShowBetPopup(false)}
                className="bg-red-600 text-white px-4 py-2 rounded hover:bg-red-500 shadow-[0_0_12px_rgba(239,68,68,0.35)]"
              >
                Cancel
              </button>

              <button
                onClick={startAIGame}
                disabled={aiGameLoading}
                className="bg-[#FFD700] text-[#030817] px-4 py-2 rounded hover:bg-[#ffe14f] disabled:bg-[#7f8520] disabled:text-[#c6c6c6]"
              >
                {aiGameLoading ? "Creating..." : "Start Game"}
              </button>
            </div>
          </div>
        </div>
      )}
      <Footer />
    </div>
  );
}
