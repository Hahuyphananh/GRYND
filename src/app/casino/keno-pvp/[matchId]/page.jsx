"use client";

// src/app/casino/keno-pvp/[matchId]/page.jsx
//
// Live 1v1 Keno Catch Duel match view. Both players face the SAME
// shared 10-tile draw; tiles glow one at a time on a server-declared
// schedule and you tap the glowing tile on the 1–40 board to catch it
// before its 0.8s glow fades. Green = caught, red = tapped too late
// (no points). First to 10 cumulative points takes the pot (90/10
// split).
//
// The client animates the glow stream from the match's roundDeadline
// + the shared timing constants; the SERVER grades every catch with
// its own clock, so the client can never self-report a catch.
// The opponent's ticket stays hidden until the round resolves.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { usePostHog } from "posthog-js/react";
import { motion, AnimatePresence } from "framer-motion";
import confetti from "canvas-confetti";
import NavigationBar from "../../../../components/navigation-bar";
import Footer from "../../../../components/Footer";
import { useSocket } from "../../../../context/SocketProvider";
import {
  KENO_PVP_MATCH_UPDATED,
  kenoPvpMatchRoom,
} from "../../../../lib/keno-pvp/rooms";
import {
  BALL_COUNT,
  GLOW_MS,
  KENO_POOL_SIZE,
  POINTS_TO_WIN,
} from "../../../../lib/keno-pvp/constants";
import { ballSchedule, computeRoundStats } from "../../../../lib/keno-pvp/engine";
import { KENO_MULTIPLIER_TABLE } from "../../../../lib/kenoMultipliers";
import {
  IconCoins,
  IconHeartHandshake,
  IconTrophy,
  IconSkull,
  IconCircleX,
  IconNotebook,
  IconX,
  IconTarget,
  IconVolume,
  IconRefresh,
  IconClock,
} from "@tabler/icons-react";
import { PoolBallIcon } from "../../../../components/icons/CustomIcons";

// Flash feedback shown after a tap on the board: green for a catch
// inside the glow window, red for a tap that landed too late.
const FLASH_LABEL = {
  caught: { text: "CAUGHT!", cls: "text-emerald-300 border-emerald-400/60 bg-emerald-500/15" },
  missed: { text: "MISSED", cls: "text-red-300 border-red-400/60 bg-red-500/15" },
};

export default function KenoPvpMatchPage({ params }) {
  const router = useRouter();
  const posthog = usePostHog();
  const { socket } = useSocket();

  const [matchId, setMatchId] = useState(null);
  const [match, setMatch] = useState(null);
  const [rounds, setRounds] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [now, setNow] = useState(Date.now());
  const [clockOffset, setClockOffset] = useState(0); // ms: serverNow = clientNow + offset
  const [lastQuality, setLastQuality] = useState(null); // { ball, quality } flash
  const [roundBanner, setRoundBanner] = useState(null); // { roundNumber, winnerIsYou }
  const [missedTiles, setMissedTiles] = useState(new Set()); // tiles tapped after the glow faded
  const [showRules, setShowRules] = useState(false);
  const [leaving, setLeaving] = useState(false);
  // Which side just crossed the POINTS_TO_WIN line → scoreboard bar
  // flashes the victory. "you" | "opp" | null.
  const [flashWinner, setFlashWinner] = useState(null);
  // Result modal is delayed briefly so the flash + final board are
  // visible before the overlay covers the screen.
  const [showResult, setShowResult] = useState(false);

  const myCatchesRef = useRef([]);
  const lastStatusRef = useRef(null);
  const bannerTimerRef = useRef(null);
  const lastRoundRef = useRef(null);
  const audioCtxRef = useRef(null);
  const flashTimerRef = useRef(null);
  const resultTimerRef = useRef(null);
  const confettiFiredRef = useRef(false);

  // Flash the scoreboard bar when a player crosses the 10-point line.
  const triggerVictoryFlash = useCallback((who) => {
    setFlashWinner(who);
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    flashTimerRef.current = setTimeout(() => setFlashWinner(null), 2000);
  }, []);

  // Short confetti burst when YOU cross the 10-point line. Fires once
  // per match (guard ref); visible because the result modal is held
  // back ~1.2s. Best-effort — never breaks the game if confetti fails.
  const triggerWinConfetti = useCallback(() => {
    if (confettiFiredRef.current) return;
    confettiFiredRef.current = true;
    try {
      confetti({
        particleCount: 80,
        spread: 70,
        origin: { y: 0.55 },
        colors: ["#00e5ff", "#00ffa6", "#FFD700", "#FFFFFF"],
        disableForReducedMotion: true,
      });
      setTimeout(
        () =>
          confetti({
            particleCount: 40,
            spread: 100,
            origin: { y: 0.45 },
            colors: ["#00ffa6", "#FFFFFF"],
            disableForReducedMotion: true,
          }),
        250,
      );
    } catch {
      // Best-effort — ignore.
    }
  }, []);

  // Clean up the victory-flash / result-modal timers on unmount.
  useEffect(() => {
    return () => {
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
      if (resultTimerRef.current) clearTimeout(resultTimerRef.current);
    };
  }, []);

  // Clear per-round miss state whenever a new round starts.
  useEffect(() => {
    const round = match?.currentRound;
    if (round && round !== lastRoundRef.current) {
      lastRoundRef.current = round;
      setMissedTiles(new Set());
    }
  }, [match?.currentRound]);

  // Resolve the [matchId] param (Next 15/16 passes params as a Promise).
  useEffect(() => {
    (async () => {
      const p = await params;
      setMatchId(Number(p?.matchId));
    })();
  }, [params]);

  const fetchStatus = useCallback(async () => {
    if (!matchId) return;
    try {
      const t0 = Date.now();
      const res = await fetch(`/api/keno-pvp/match/${matchId}`, {
        cache: "no-store",
      });
      const json = await res.json();
      // Clock sync: the response carries the server's clock. Estimate
      // the server↔client offset from the request midpoint (t0+t1)/2
      // and smooth it — schedule times are server-set absolutes, so
      // comparing against the server clock keeps the glow stream
      // aligned with the server's grading on devices whose clock
      // drifts. Ignore samples from slow/hung requests (bad midpoint).
      const t1 = Date.now();
      const serverTime = Number(json.data?.serverTime);
      if (Number.isFinite(serverTime) && serverTime > 0 && t1 - t0 < 2000) {
        const sample = serverTime - (t0 + t1) / 2;
        setClockOffset((prev) => (prev === 0 ? sample : prev * 0.7 + sample * 0.3));
      }
      if (!json.success) {
        if (res.status === 401) {
          router.push("/sign-in?redirect_url=" + encodeURIComponent(`/casino/keno-pvp/${matchId}`));
        }
        setError(json.error || "Failed to load match");
        return;
      }
      const resolvedRounds = json.data.rounds || [];
      setMatch(json.data.match);
      setRounds(resolvedRounds);
      myCatchesRef.current = json.data.match.myCatches || [];

      const m = json.data.match;
      const prev = lastStatusRef.current;
      // Detect a just-resolved round so we can flash a winner banner.
      // NOTE: must search the FRESH `resolvedRounds` (the just-fetched
      // history) — the state variable `rounds` is still the previous
      // poll's value and would miss the newly stamped round.
      if (
        prev &&
        /^round_\d+$/.test(prev.status) &&
        /^round_\d+$/.test(m.status) &&
        Number(m.currentRound) > Number(prev.currentRound)
      ) {
        const prevRound = resolvedRounds.find((r) => r.roundNumber === Number(prev.currentRound));
        if (prevRound) {
          const youWon = prevRound.roundWinner
            ? prevRound.roundWinner === (m.viewerIsPlayer1 ? "player1" : "player2")
            : null;
          setRoundBanner({ roundNumber: prevRound.roundNumber, winnerIsYou: youWon });
          if (bannerTimerRef.current) clearTimeout(bannerTimerRef.current);
          bannerTimerRef.current = setTimeout(() => setRoundBanner(null), 2600);
        }
      }

      // Victory flash: when a player's cumulative score first crosses
      // POINTS_TO_WIN, pulse their side of the scoreboard race bar.
      // (Only fires for a real points win — a cap-tie draw or a
      // low-score finish flashes nothing.)
      if (prev && (m.result === "player1" || m.result === "player2")) {
        const winnerSeat = m.result;
        const prevWinnerScore =
          winnerSeat === "player1" ? Number(prev.p1Score) || 0 : Number(prev.p2Score) || 0;
        const newWinnerScore =
          winnerSeat === "player1" ? Number(m.p1Score) || 0 : Number(m.p2Score) || 0;
        if (newWinnerScore >= POINTS_TO_WIN && prevWinnerScore < POINTS_TO_WIN) {
          const winnerIsYou =
            winnerSeat === (m.viewerIsPlayer1 ? "player1" : "player2");
          triggerVictoryFlash(winnerIsYou ? "you" : "opp");
          if (winnerIsYou) triggerWinConfetti();
        }
      }

      // Hold the result modal back ~1.2s so the player sees the final
      // board + the victory flash before the overlay appears.
      if (m.status === "finished" && prev?.status !== "finished") {
        if (resultTimerRef.current) clearTimeout(resultTimerRef.current);
        resultTimerRef.current = setTimeout(() => setShowResult(true), 1200);
      } else if (m.status !== "finished") {
        if (resultTimerRef.current) clearTimeout(resultTimerRef.current);
        setShowResult(false);
      }
      lastStatusRef.current = m;
    } catch {
      // Silent — poll retries.
    }
  }, [matchId, router, triggerVictoryFlash, triggerWinConfetti]);

  useEffect(() => {
    if (!matchId) return;
    fetchStatus();
    const interval = setInterval(fetchStatus, 800);
    return () => clearInterval(interval);
  }, [matchId, fetchStatus]);

  // Socket live-update: re-poll instantly on opponent actions.
  useEffect(() => {
    if (!socket || !matchId) return;
    const roomId = kenoPvpMatchRoom(matchId);
    const refresh = () => fetchStatus();
    socket.emit("join_room", { roomId });
    socket.on(KENO_PVP_MATCH_UPDATED, refresh);
    return () => {
      socket.emit("leave_room", { roomId });
      socket.off(KENO_PVP_MATCH_UPDATED, refresh);
    };
  }, [socket, matchId, fetchStatus]);

  // Animation clock (100ms ticks drive the ball stream).
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(interval);
  }, []);

  // Subtle audio tick when a tile lights up. Synthesised with the Web
  // Audio API (no asset needed); the context is created lazily and
  // resumed on the first user gesture (browsers block audio before
  // one). Best-effort — never breaks the game if audio is unavailable.
  const playTileTick = useCallback(() => {
    try {
      if (typeof window === "undefined") return;
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      if (!audioCtxRef.current) audioCtxRef.current = new Ctx();
      const ctx = audioCtxRef.current;
      if (ctx.state === "suspended") ctx.resume();
      if (ctx.state !== "running") return;
      const t = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "triangle";
      osc.frequency.setValueAtTime(880, t);
      osc.frequency.exponentialRampToValueAtTime(660, t + 0.08);
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.12, t + 0.005);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.1);
    } catch {
      // Audio is best-effort — ignore.
    }
  }, []);

  // Unlock the audio context on the first user gesture (autoplay policy).
  useEffect(() => {
    const unlock = () => {
      try {
        if (audioCtxRef.current && audioCtxRef.current.state === "suspended") {
          audioCtxRef.current.resume();
        }
      } catch {
        // ignore
      }
    };
    window.addEventListener("pointerdown", unlock);
    window.addEventListener("keydown", unlock);
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, []);

  // Server-view of "now" (client now + measured offset). The release
  // schedule is derived from the server-set round deadline, so all
  // timing comparisons must use the server clock — otherwise a device
  // clock that drifts would make tiles glow at the wrong moment.
  const serverNow = now + clockOffset;

  useEffect(() => {
    setLoading(false);
  }, [match]);

  const isRound = match && /^round_\d+$/.test(match.status || "");
  const isWaiting = match?.status === "waiting";
  const isReady = match?.status === "ready";
  // 30-second countdown after the 3-minute match clock expires with
  // nobody at POINTS_TO_WIN — most tiles wins when it hits zero.
  const isOvertime = match?.status === "overtime";
  const isFinished = match?.status === "finished";
  const isCancelled = match?.status === "cancelled";

  // The release schedule for the current round, derived server-style
  // from the round deadline (identical for both players).
  const schedule = useMemo(() => {
    if (!isRound || !match?.roundDeadline) return [];
    return ballSchedule(new Date(match.roundDeadline).getTime(), match.currentDraw || []);
  }, [isRound, match?.roundDeadline, match?.currentDraw]);

  // The tile currently GLOWING (inside its visible 0.8s window) —
  // bright cyan with the shrinking ring.
  const activeTile = useMemo(() => {
    if (!isRound) return null;
    const nowMs = serverNow;
    let active = null;
    for (const b of schedule) {
      if (nowMs >= b.releaseMs && nowMs < b.expiresMs) active = b;
    }
    return active;
  }, [isRound, schedule, serverNow]);

  // The tile in its hidden network-grace tail: the glow has faded, but
  // a tap that was sent while it was glowing still lands. Catchable,
  // just dimmed — no ring (the ring empties at the visible window).
  const fadingTile = useMemo(() => {
    if (!isRound) return null;
    const nowMs = serverNow;
    let active = null;
    for (const b of schedule) {
      if (nowMs >= b.expiresMs && nowMs < b.acceptedUntilMs) active = b;
    }
    return active;
  }, [isRound, schedule, serverNow]);

  // Play the audio tick each time a NEW tile lights up (fires once per
  // tile — activeTile?.number changes only when the glowing tile does).
  useEffect(() => {
    if (activeTile?.number != null) playTileTick();
  }, [activeTile?.number, playTileTick]);

  const roundEndMs = match?.roundDeadline ? new Date(match.roundDeadline).getTime() : 0;
  const roundTimeLeft = Math.max(0, Math.ceil((roundEndMs - serverNow) / 1000));

  const myStats = useMemo(
    () => computeRoundStats(match?.myCatches || []),
    [match?.myCatches, match?.currentRound],
  );

  // Numbers already released on the shared stream — these light up on
  // the 1–40 board as the draw unfolds (same schedule for both players).
  const drawnNumbers = useMemo(() => {
    if (!isRound) return new Set();
    const set = new Set();
    for (const b of schedule) {
      if (serverNow >= b.releaseMs) set.add(b.number);
    }
    return set;
  }, [isRound, schedule, serverNow]);

  const caughtNumbers = useMemo(
    () => new Set((match?.myCatches || []).map((c) => c.number)),
    [match?.myCatches],
  );

  // Numbers the opponent caught in rounds that have ALREADY resolved.
  // Each resolved round reveals their full ticket (the server only
  // scrubs the LIVE round's opponent catches — history is public), so
  // the board lights those numbers up in gold once the round is over.
  const oppRevealedNumbers = useMemo(() => {
    if (!match || !Array.isArray(rounds)) return new Set();
    const set = new Set();
    const oppKey = match.viewerIsPlayer1 ? "player2Catches" : "player1Catches";
    for (const r of rounds) {
      const catches = Array.isArray(r[oppKey]) ? r[oppKey] : [];
      for (const c of catches) {
        if (c && typeof c.number === "number") set.add(c.number);
      }
    }
    return set;
  }, [rounds, match?.viewerIsPlayer1]);

  const doCatch = useCallback(
    async (tileNumber) => {
      if (!matchId) return;
      // Only taps on tiles that have STARTED glowing reach the server —
      // a tile that hasn't lit up yet is not a miss, it's just not due.
      // (Uses the server-viewed clock so it agrees with the server.)
      const ball = schedule.find((b) => b.number === tileNumber);
      if (!ball || serverNow < ball.releaseMs) return;
      if ((myCatchesRef.current || []).some((c) => c.number === tileNumber)) return;
      try {
        const res = await fetch(`/api/keno-pvp/match/${matchId}/catch`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ ball: tileNumber }),
        });
        const json = await res.json();
        if (!json.success) {
          // Tapped too late (glow already faded server-side) → red.
          setMissedTiles((prev) => new Set(prev).add(tileNumber));
          setLastQuality({ ball: tileNumber, quality: "missed", text: json.error || "Missed" });
          setTimeout(() => setLastQuality(null), 900);
          return;
        }
        setLastQuality({ ball: tileNumber, quality: "caught" });
        myCatchesRef.current = [...myCatchesRef.current, json.data.catch];
        setMatch((prev) => {
          if (!prev) return prev;
          const mine = [...(prev.myCatches || []), json.data.catch];
          return { ...prev, myCatches: mine };
        });
        posthog?.capture("keno_pvp_caught", {
          match_id: matchId,
          ball: tileNumber,
          quality: json.data.catch.quality,
        });
        socket?.emit("room_event", {
          roomId: kenoPvpMatchRoom(matchId),
          event: KENO_PVP_MATCH_UPDATED,
        });
        setTimeout(() => setLastQuality(null), 900);
      } catch {
        // Silent — the poll will reconcile.
      }
    },
    [matchId, schedule, serverNow, posthog, socket],
  );

  const goToLobby = useCallback(() => {
    if (leaving) return;
    setLeaving(true);
    router.push("/casino/keno");
  }, [leaving, router]);

  const cancelMatch = useCallback(async () => {
    if (!matchId) return;
    try {
      await fetch(`/api/keno-pvp/match/${matchId}/cancel`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
      });
      socket?.emit("room_event", { roomId: "lobby:keno-pvp", event: "lobby:updated" });
      goToLobby();
    } catch {
      // Silent
    }
  }, [matchId, socket, goToLobby]);

  if (loading && !match) {
    return (
      <div className="min-h-screen bg-[#001933] text-white flex items-center justify-center">
        <p className="animate-pulse">Loading match…</p>
      </div>
    );
  }

  if (!match) {
    return (
      <div className="min-h-screen bg-[#001933] text-white flex items-center justify-center">
        <div className="text-center space-y-4">
          <p className="text-lg">{error || "Match not found"}</p>
          <button
            onClick={goToLobby}
            className="px-5 py-2 rounded-lg bg-[#00e5ff] text-[#001933] font-bold"
          >
            Back to Keno Lobby
          </button>
        </div>
      </div>
    );
  }

  const me = match.viewerIsPlayer1 ? "player1" : "player2";
  const opponent = match.viewerIsPlayer1 ? "player2" : "player1";
  const myWins = match.viewerIsPlayer1 ? match.roundsWonPlayer1 : match.roundsWonPlayer2;
  const oppWins = match.viewerIsPlayer1 ? match.roundsWonPlayer2 : match.roundsWonPlayer1;
  const myPts = match.viewerIsPlayer1 ? match.p1Score : match.p2Score;
  const oppPts = match.viewerIsPlayer1 ? match.p2Score : match.p1Score;

  const p1Name = match.players?.p1?.displayName || match.player1Id?.slice(0, 6) || "P1";
  const p2Name = match.players?.p2?.displayName || match.player2Id?.slice(0, 6) || "P2";
  const oppName = me === "player1" ? p2Name : p1Name;

  return (
    <div className="min-h-screen overflow-x-clip bg-gradient-to-br from-[#001933] to-[#000d1a] px-3 pb-24 pt-20 text-white sm:px-6 md:pb-8">
      <NavigationBar currentPath="/casino" />

      <div className="mx-auto mt-4 max-w-5xl">
        {/* Header + scoreboard */}
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl sm:text-3xl font-extrabold tracking-wide text-transparent bg-clip-text bg-gradient-to-r from-[#00e5ff] to-[#00ffa6]">
                <span className="inline-flex items-center gap-2"><PoolBallIcon size={28} className="text-[#00e5ff]" /> Keno Catch Duel</span>
              </h1>
              <button
                onClick={() => setShowRules(true)}
                className="h-7 w-7 shrink-0 rounded-full border border-[#00e5ff]/40 bg-[#0b224f]/70 text-sm font-bold text-[#7cefff] transition hover:border-[#00e5ff]/80 hover:text-white"
                aria-label="How to play"
                title="How to play"
              >
                ?
              </button>
            </div>
            <p className="text-xs text-white/50 mt-1">
              First to {POINTS_TO_WIN} points · stake {match.stakeAmount.toLocaleString()} <IconCoins size={12} className="inline" />
            </p>
          </div>
          <div className="rounded-xl border border-[#00e5ff]/30 bg-[#0b224f]/85 px-4 py-2 text-sm shadow-[0_0_14px_rgba(0,229,255,0.15)] min-w-[210px]">
            <div className="flex items-center gap-3">
              <span className="font-bold text-[#00ffa6]">{me === "player1" ? "You" : p1Name} {myPts}</span>
              <span className="text-white/40">–</span>
              <span className="font-bold text-[#FFD700]">{oppPts} {me === "player2" ? "You" : p2Name}</span>
            </div>
            {/* Race to the finish: each player fills toward the centre
                10-point line (myPts / POINTS_TO_WIN from the left,
                opponent's from the right). */}
            <div
              className="relative mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-white/10"
              title={`You ${myPts}/${POINTS_TO_WIN} · ${oppName} ${oppPts}/${POINTS_TO_WIN}`}
            >
              <div
                className="absolute inset-y-0 left-0 rounded-full bg-[#00ffa6] transition-all duration-500"
                style={{
                  width: `${Math.min(50, (myPts / POINTS_TO_WIN) * 50)}%`,
                  // Victory flash when YOU cross the 10-point line.
                  animation: flashWinner === "you" ? "kenoGlowGreen 0.8s ease-in-out 2" : undefined,
                }}
              />
              <div
                className="absolute inset-y-0 right-0 rounded-full bg-[#FFD700] transition-all duration-500"
                style={{
                  width: `${Math.min(50, (oppPts / POINTS_TO_WIN) * 50)}%`,
                  // Victory flash when the OPPONENT crosses the line.
                  animation: flashWinner === "opp" ? "kenoGlowGold 0.8s ease-in-out 2" : undefined,
                }}
              />
              <div className="absolute inset-y-0 left-1/2 w-px bg-white/40" />
            </div>
            <div className="mt-1 flex items-center justify-center gap-2 text-[11px] text-white/50">
              <span>{myWins}–{oppWins} round wins</span>
              <span>·</span>
              <span>first to {POINTS_TO_WIN} pts</span>
            </div>
          </div>
        </div>

        {/* Round-just-resolved banner */}
        <AnimatePresence>
          {roundBanner && (
            <motion.div
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              className="mb-3 rounded-lg border border-[#00ffa6]/40 bg-[#00ffa6]/10 px-3 py-2 text-center text-sm font-semibold text-[#7cefff]"
            >
              Round {roundBanner.roundNumber}:{" "}
              {roundBanner.winnerIsYou === null
                ? "draw — no round win."
                : roundBanner.winnerIsYou
                  ? "you won it!"
                  : "opponent won it."}
            </motion.div>
          )}
        </AnimatePresence>

        {/* How-to-play modal */}
        <AnimatePresence>
          {showRules && <RulesModal onClose={() => setShowRules(false)} />}
        </AnimatePresence>

        {error && (
          <div className="mb-3 rounded-lg border border-red-400/40 bg-red-900/30 px-3 py-2 text-sm text-red-200">
            {error}
          </div>
        )}

        {/* ── WAITING ─────────────────────────────────────────────── */}
        {isWaiting && (
          <div className="rounded-2xl border border-[#00e5ff]/30 bg-[#0b224f]/85 p-10 text-center">
            <p className="mb-3 animate-pulse"><PoolBallIcon size={40} className="text-[#00e5ff]" /></p>
            <h2 className="text-xl font-bold mb-2">Waiting for an opponent…</h2>
            <p className="text-sm text-white/60 mb-6">
              Your {match.stakeAmount.toLocaleString()} <IconCoins size={12} className="inline" /> stake is escrowed. Someone with the same
              stake will join shortly — or you can cancel.
            </p>
            {match.viewerCanCancel && (
              <button
                onClick={cancelMatch}
                className="px-5 py-2 rounded-lg bg-red-500/20 border border-red-500/40 text-red-200 text-sm font-bold hover:bg-red-500/30"
              >
                Cancel Lobby
              </button>
            )}
          </div>
        )}

        {/* ── READY ───────────────────────────────────────────────── */}
        {isReady && (
          <div className="rounded-2xl border border-[#00e5ff]/30 bg-[#0b224f]/85 p-10 text-center">
            <h2 className="mb-2 flex items-center justify-center gap-2 text-2xl font-bold">Match found! <IconHeartHandshake size={24} /></h2>
            <p className="text-sm text-white/60">
              {p1Name} vs {p2Name} — round 1 starts in a moment. Tap each tile while it glows!
            </p>
          </div>
        )}

        {/* ── LIVE ROUND ──────────────────────────────────────────── */}
        {isRound && (
          <div className="space-y-4">
            <div className="rounded-2xl border border-[#00e5ff]/35 bg-[#050d1f]/80 p-4 sm:p-6 shadow-[0_0_25px_rgba(0,229,255,0.15)]">
              {/* Round status line */}
              <div className="mb-4 flex items-center justify-between text-xs text-white/60">
                <span className="font-bold text-[#FFD700] uppercase tracking-wider">
                  Round {match.currentRound} · first to {POINTS_TO_WIN} pts
                </span>
                <span>{roundTimeLeft}s left</span>
              </div>

              {/* Glow hint */}
              <div className="flex flex-col items-center gap-2">
                {activeTile ? (
                  <p className="text-sm font-bold text-[#00e5ff] animate-pulse">
                    Tap tile {activeTile.number} — it's glowing!
                  </p>
                ) : fadingTile ? (
                  <p className="text-sm font-bold text-[#7cefff] animate-pulse">
                    Hurry — tile {fadingTile.number} is fading!
                  </p>
                ) : (
                  <p className="text-sm text-white/50 animate-pulse">
                    {roundTimeLeft > 0 ? "Next tile incoming…" : "Resolving round…"}
                  </p>
                )}
                <p className="text-[11px] text-white/40">
                  Each tile glows for {GLOW_MS / 1000}s — tap it while the ring is shrinking. Green = caught · Red = missed.
                </p>
              </div>

              {/* Quality flash */}
              <AnimatePresence>
                {lastQuality && (
                  <motion.div
                    initial={{ opacity: 0, scale: 0.7 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.7 }}
                    className="fixed inset-x-0 top-24 z-40 flex justify-center pointer-events-none"
                  >
                    <span
                      className={`rounded-full border px-5 py-2 text-lg font-black tracking-widest shadow-lg ${
                        FLASH_LABEL[lastQuality.quality]?.cls || "text-white border-white/40 bg-black/60"
                      }`}
                    >
                      {lastQuality.quality === "missed"
                        ? lastQuality.text || "MISSED"
                        : `TILE ${lastQuality.ball} · ${FLASH_LABEL[lastQuality.quality].text}`}
                    </span>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            {/* Keno board — drawn numbers light up as the draw unfolds */}
            <div className="rounded-2xl border border-[#00e5ff]/35 bg-[#050d1f]/70 p-4 sm:p-5">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-bold uppercase tracking-wider text-[#7cefff]">
                  <span className="inline-flex items-center gap-1.5"><PoolBallIcon size={16} className="text-[#00e5ff]" /> Keno Board 1–{KENO_POOL_SIZE}</span>
                </h3>
                <span className="text-xs text-white/50">
                  {drawnNumbers.size} / {BALL_COUNT} drawn
                  {oppRevealedNumbers.size > 0 && (
                    <span className="ml-2 text-[#FFD700]/80">
                      · {oppRevealedNumbers.size} opponent caught
                    </span>
                  )}
                </span>
              </div>
              <div className="grid grid-cols-5 xs:grid-cols-5 sm:grid-cols-8 gap-2 sm:gap-2.5 justify-items-center">
                {Array.from({ length: KENO_POOL_SIZE }, (_, i) => i + 1).map((num) => {
                  const ball = schedule.find((b) => b.number === num);
                  const released = ball && serverNow >= ball.releaseMs;
                  const isActive = activeTile?.number === num;
                  const inGraceTail =
                    ball && serverNow >= ball.expiresMs && serverNow < ball.acceptedUntilMs;
                  const caught = caughtNumbers.has(num);
                  const oppCaught = oppRevealedNumbers.has(num);
                  const missed = missedTiles.has(num);
                  let cls = "bg-[#020617] border border-[#00e5ff]/20 text-white/35 cursor-default";
                  if (caught)
                    cls = "bg-[#00ffa6] text-[#001933] scale-105 ring-2 ring-[#00ffa6]/70 shadow-[0_0_18px_rgba(0,255,166,0.9)] animate-pulse";
                  else if (isActive)
                    cls = "bg-[#00e5ff] text-[#001933] border-[#00e5ff] scale-110 shadow-[0_0_20px_rgba(0,229,255,0.8)] cursor-pointer animate-pulse";
                  else if (inGraceTail)
                    cls = "bg-[#00e5ff]/25 text-[#7cefff] border-[#00e5ff]/50 cursor-pointer";
                  else if (oppCaught)
                    cls = "bg-[#FFD700]/25 text-[#FFD700] border border-[#FFD700]/50";
                  else if (missed)
                    cls = "bg-red-500/25 text-red-400 border border-red-500/60";
                  else if (released)
                    cls = "bg-[#0a1a3a] border-[#00e5ff]/25 text-white/50 cursor-pointer";
                  return (
                    <button
                      key={num}
                      disabled={!released || caught || missed}
                      onClick={() => released && doCatch(num)}
                      className={`relative w-10 h-10 sm:w-11 sm:h-11 md:w-12 md:h-12 flex items-center justify-center rounded-lg text-sm font-bold transition-all duration-200 touch-manipulation select-none active:scale-90 ${cls}`}
                    >
                      {num}
                      {isActive && ball && (
                        // Shrinking countdown ring — runs for exactly the
                        // remaining VISIBLE glow window so it empties the
                        // moment the glow fades (the hidden network grace
                        // tail stays dimly catchable but shows no ring).
                        <motion.span
                          key={`glow-ring-${num}`}
                          initial={{ scale: 1, opacity: 1 }}
                          animate={{ scale: 0.55, opacity: 0 }}
                          transition={{
                            duration: Math.max(0.05, (ball.expiresMs - serverNow) / 1000),
                            ease: "linear",
                          }}
                          aria-hidden="true"
                          className="absolute inset-0 rounded-lg border-2 border-white/80 pointer-events-none"
                        />
                      )}
                    </button>
                  );
                })}
              </div>

              {/* Inline points table — live highlight on the current tier */}
              <div className="mt-4 border-t border-[#00e5ff]/20 pt-3">
                <div className="mb-1.5 flex items-center justify-between gap-2">
                  <h4 className="text-[11px] font-bold uppercase tracking-wider text-white/40">
                    Points — tiles caught → score
                  </h4>
                  <span className="text-[11px] font-semibold text-[#00ffa6]">
                    {myStats.caught} caught · {myStats.score} pts
                  </span>
                </div>
                <div className="grid grid-cols-5 gap-1.5">
                  {POINTS_TABLE.map(([caught, pts]) => {
                    const isCurrent = caught === myStats.caught;
                    return (
                      <div
                        key={caught}
                        className={`rounded-md border px-1 py-1 text-center transition-colors ${
                          isCurrent
                            ? "border-[#00ffa6]/80 bg-[#00ffa6]/15 shadow-[0_0_10px_rgba(0,255,166,0.35)]"
                            : "border-[#00e5ff]/20 bg-[#0b224f]/60"
                        }`}
                      >
                        <div className={`text-[10px] font-bold ${isCurrent ? "text-[#00ffa6]" : "text-[#FFD700]"}`}>
                          {caught}
                        </div>
                        <div className={`text-[11px] font-black ${isCurrent ? "text-white" : "text-[#00ffa6]"}`}>
                          {pts}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {oppRevealedNumbers.size > 0 && (
                <p className="mt-3 text-[11px] text-white/40">
                  <span className="text-[#FFD700]">Gold</span> = numbers the opponent caught in
                  resolved rounds — their live ticket stays hidden until each round ends.
                </p>
              )}
            </div>

            {/* Tickets */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="rounded-2xl border border-[#00ffa6]/30 bg-[#050d1f]/70 p-4">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="font-bold text-[#00ffa6]">
                    {me === "player1" ? "Your ticket" : p1Name + "'s ticket"}
                    {me === "player1" ? " (You)" : ""}
                  </h3>
                  <span className="text-xs text-white/60">{myStats.score} pts</span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {(match.myCatches || []).length === 0 && (
                    <p className="text-xs text-white/40">Catch some tiles!</p>
                  )}
                  {(match.myCatches || []).map((c) => (
                    <span
                      key={c.number}
                      className="px-2.5 py-1 rounded-lg border text-sm font-bold bg-[#00ffa6]/15 text-[#00ffa6] border-[#00ffa6]/50"
                    >
                      {c.number}
                    </span>
                  ))}
                </div>
              </div>
              <div className="rounded-2xl border border-[#FFD700]/30 bg-[#050d1f]/70 p-4">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="font-bold text-[#FFD700]">
                    {me === "player2" ? "Your ticket" : p2Name + "'s ticket"}
                    {me === "player2" ? " (You)" : ""}
                  </h3>
                  <span className="text-xs text-white/60">
                    {me === "player2" ? `${myStats.score} pts` : `${match.opponentCatchCount} caught`}
                  </span>
                </div>
                <p className="text-xs text-white/40">
                  {me === "player2"
                    ? "Catch some balls!"
                    : `Opponent has caught ${match.opponentCatchCount} ball${match.opponentCatchCount === 1 ? "" : "s"} so far…`}
                </p>
              </div>
            </div>
          </div>
        )}

        {/* ── OVERTIME ───────────────────────────────────────────── */}
        {isOvertime && (
          <div className="rounded-2xl border border-red-400/50 bg-[#1a0505]/85 p-8 text-center shadow-[0_0_30px_rgba(255,70,70,0.25)]">
            <p className="mb-2 animate-pulse"><IconClock size={40} className="text-red-400" /></p>
            <h2 className="text-2xl sm:text-3xl font-extrabold tracking-wide text-red-300">
              OVERTIME
            </h2>
            <p className="mt-2 text-sm text-white/70">
              Nobody reached {POINTS_TO_WIN} pts in time — when the clock hits zero, the player
              with the most tiles wins.
            </p>
            <p className="mt-4 text-6xl font-black text-white tabular-nums">{roundTimeLeft}s</p>
            <p className="mt-1 text-xs text-white/50">
              Most tiles (points) wins · overtime tie = 95% refund each (5% rake)
            </p>
          </div>
        )}

        {/* ── FINISHED ────────────────────────────────────────────── */}
        {isFinished && showResult && (
          <ResultModal
            match={match}
            rounds={rounds}
            me={me}
            p1Name={p1Name}
            p2Name={p2Name}
            myWins={myWins}
            oppWins={oppWins}
            myPts={myPts}
            oppPts={oppPts}
            onLobby={goToLobby}
          />
        )}

        {/* ── CANCELLED ───────────────────────────────────────────── */}
        {isCancelled && (
          <div className="rounded-2xl border border-red-400/30 bg-[#0b224f]/85 p-10 text-center">
            <p className="mb-3"><IconCircleX size={36} className="text-red-400" /></p>
            <h2 className="text-xl font-bold mb-2">Match cancelled</h2>
            <p className="text-sm text-white/60 mb-6">Your stake was refunded.</p>
            <button
              onClick={goToLobby}
              className="px-5 py-2 rounded-lg bg-[#00e5ff] text-[#001933] font-bold"
            >
              Back to Keno Lobby
            </button>
          </div>
        )}

        {/* Leave control during a live match */}
        {!isFinished && !isCancelled && !isWaiting && (
          <div className="mt-4 text-center">
            <button
              onClick={goToLobby}
              disabled={leaving}
              className="px-4 py-2 rounded-lg text-xs text-white/50 border border-white/15 hover:text-white hover:border-white/40 transition disabled:opacity-50"
            >
              {leaving ? "Leaving…" : "Leave match (forfeit)"}
            </button>
          </div>
        )}

        <Footer />
      </div>
    </div>
  );
}

// ── Rules modal ──────────────────────────────────────────────────────

// Tiles caught → points (the classic keno multiplier for picks == hits
// == caught, sourced straight from KENO_MULTIPLIER_TABLE so the modal
// can never drift from the engine).
const POINTS_TABLE = Object.entries(KENO_MULTIPLIER_TABLE)
  .map(([picks, byHits]) => [Number(picks), byHits[Number(picks)]])
  .sort((a, b) => a[0] - b[0]);

function RulesModal({ onClose }) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.92, y: 12 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 8 }}
        transition={{ type: "spring", stiffness: 300, damping: 26 }}
        className="w-full max-w-md rounded-2xl border border-[#00e5ff]/40 bg-[#050d1f]/95 p-6 shadow-[0_0_40px_rgba(0,229,255,0.25)] max-h-[92vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-xl font-extrabold text-[#7cefff]"><IconNotebook size={20} /> How to play</h2>
          <button
            onClick={onClose}
            className="h-8 w-8 rounded-lg border border-white/15 text-white/60 transition hover:border-white/40 hover:text-white"
            aria-label="Close rules"
          >
            <IconX size={16} />
          </button>
        </div>

        <h3 className="mb-2 flex items-center gap-1.5 text-sm font-bold uppercase tracking-wider text-[#00ffa6]"><IconTarget size={15} /> Catch the glowing tile</h3>
        <ul className="mb-5 space-y-1.5 text-xs text-white/70">
          <li>
            Each round, <span className="font-semibold text-white">10 tiles</span> from the 1–40 board
            light up one at a time — both players chase the{" "}
            <span className="font-semibold text-white">same draw</span>.
          </li>
          <li>
            A tile <span className="font-semibold text-[#00e5ff]">glows for {GLOW_MS / 1000}s</span>{" "}
            (watch the ring shrink). Tap it while it's lit →{" "}
            <span className="font-semibold text-[#00ffa6]">caught (green)</span>.
          </li>
          <li>
            Tap after the glow fades → <span className="font-semibold text-red-400">miss (red)</span> — no
            points.
          </li>
          <li>Catching is binary: you're in the 0.8s window or you're not.</li>
          <li className="flex items-center gap-1"><IconVolume size={12} /> A soft tick sounds the moment each tile lights up.</li>
        </ul>

        <h3 className="mb-2 flex items-center gap-1.5 text-sm font-bold uppercase tracking-wider text-[#00ffa6]"><IconCoins size={15} /> Points — keno multiplier</h3>
        <div className="mb-2 grid grid-cols-5 gap-1.5">
          {POINTS_TABLE.map(([caught, pts]) => (
            <div
              key={caught}
              className="rounded-md border border-[#00e5ff]/25 bg-[#0b224f]/80 px-1 py-1.5 text-center"
            >
              <div className="text-[10px] font-bold text-[#FFD700]">{caught}</div>
              <div className="text-[11px] font-black text-[#00ffa6]">{pts}</div>
            </div>
          ))}
        </div>
        <p className="mb-5 text-[11px] text-white/50">
          Tiles caught → points. The multiplier compounds: 5 tiles = 50 pts, all 10 = 5,000 pts —
          the last tiles are worth the most.
        </p>

        <h3 className="mb-2 flex items-center gap-1.5 text-sm font-bold uppercase tracking-wider text-[#00ffa6]"><IconTrophy size={15} /> Winning the match</h3>
        <ul className="space-y-1.5 text-xs text-white/70">
          <li>
            <span className="font-semibold text-white">First to {POINTS_TO_WIN} points</span> takes the
            pot — your round scores accumulate until someone crosses the line.
          </li>
          <li>Higher round score wins the round; an exact tie is a draw (no round win).</li>
          <li>Both cross {POINTS_TO_WIN} in the same round? The higher total wins. Exact tie → full
            refund, no rake.</li>
          <li>
            <IconClock size={12} className="inline" /> <span className="font-semibold text-white">3-minute match clock</span> — if nobody reaches{" "}
            {POINTS_TO_WIN} pts in ~3 minutes, a 30-second OVERTIME countdown starts; the player
            with the most tiles wins when it ends.
          </li>
          <li className="flex items-start gap-1"><IconHeartHandshake size={12} className="mt-0.5 shrink-0" /> <span>An overtime tie is a draw: both players are refunded 95% of their stake (5% rake
            each).</span></li>
          <li>Winner takes their stake + 90% of the loser's stake (house keeps 10%).</li>
        </ul>
      </motion.div>
    </motion.div>
  );
}

// ── Result modal ──────────────────────────────────────────────────────
function ResultModal({ match, rounds, me, p1Name, p2Name, myWins, oppWins, myPts, oppPts, onLobby }) {
  const router = useRouter();
  const [showReveal, setShowReveal] = useState(false);
  const result = match.result;
  const iWon = result === me;
  const drew = result === "draw";

  // Normal draws refund in full (houseFee = 0 → net 0). An OVERTIME
  // tie takes 5% of each stake (10% total, stored in houseFee) — each
  // player's net is −(houseFee / 2).
  const net = useMemo(() => {
    if (drew) return -(Number(match.houseFee) || 0) / 2;
    return iWon ? Number(match.prizePaid) - Number(match.stakeAmount) : -Number(match.stakeAmount);
  }, [match, iWon, drew]);

  const tieFee = drew ? Number(match.houseFee) || 0 : 0;

  const winnerName = result === "player1" ? p1Name : p2Name;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4">
      <div className="w-full max-w-lg rounded-2xl border border-[#00e5ff]/40 bg-[#050d1f]/95 p-6 shadow-[0_0_40px_rgba(0,229,255,0.25)] max-h-[92vh] overflow-y-auto">
        <div className="text-center mb-4">
          <p className="mb-2 flex justify-center">{drew ? <IconHeartHandshake size={48} className="text-white/70" /> : iWon ? <IconTrophy size={48} className="text-[#00ffa6]" /> : <IconSkull size={48} className="text-red-400" />}</p>
          <h2 className={`text-2xl sm:text-3xl font-extrabold ${
            drew ? "text-white/70" : iWon ? "text-[#00ffa6]" : "text-red-400"
          }`}>
            {drew ? "MATCH DRAW" : iWon ? "YOU WON!" : `${winnerName} WON`}
          </h2>
          <p className="text-sm text-white/60 mt-1">
            {myPts} – {oppPts} pts · {myWins} – {oppWins} round wins
          </p>
          {tieFee > 0 && (
            <p className="mt-1 text-xs text-amber-300/90">
              Overtime ended tied — no winner, 5% rake per player
            </p>
          )}
          <p className={`mt-2 text-xl font-black ${drew ? (tieFee > 0 ? "text-amber-300" : "text-white/60") : iWon ? "text-[#00ffa6]" : "text-red-400"}`}>
            {drew
              ? tieFee > 0
                ? <span className="inline-flex items-center gap-1">Tie — 95% refunded ({net < 0 ? "−" : "+"}{Math.abs(net).toLocaleString()} <IconCoins size={14} />)</span>
                : "Stake refunded"
              : <span className="inline-flex items-center gap-1">{iWon ? "+" : "−"}{Math.abs(net).toLocaleString()} <IconCoins size={14} /></span>}
          </p>
        </div>

        {/* Rounds reveal */}
        <button
          onClick={() => setShowReveal((v) => !v)}
          className="w-full mb-4 rounded-lg bg-[#0b224f]/80 border border-[#00e5ff]/25 px-3 py-2 text-sm font-bold text-[#7cefff] hover:border-[#00e5ff]/60 transition"
        >
          {showReveal ? "Hide" : "Reveal"} round results
        </button>
        {showReveal && (
          <div className="space-y-2 mb-4 max-h-56 overflow-y-auto pr-1">
            {rounds.length === 0 && (
              <p className="text-xs text-white/40 text-center">No completed rounds (forfeit).</p>
            )}
            {rounds.map((r) => {
              const rWinner = r.roundWinner === "player1" ? p1Name : r.roundWinner === "player2" ? p2Name : "Draw";
              return (
                <div key={r.id} className="rounded-lg bg-[#08142f]/80 border border-white/10 p-2.5 text-xs">
                  <div className="flex justify-between mb-1.5">
                    <span className="font-bold text-[#FFD700]">Round {r.roundNumber}</span>
                    <span className="text-white/60">{r.player1Score} – {r.player2Score} · winner: {rWinner}</span>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    <span className="text-white/40 mr-1">P1:</span>
                    {r.player1Catches.map((c) => (
                      <span key={c.number} className={`px-1.5 rounded ${c.quality === "perfect" ? "bg-emerald-500/20 text-emerald-300" : "bg-cyan-500/15 text-cyan-200"}`}>
                        {c.number}
                      </span>
                    ))}
                  </div>
                  <div className="flex flex-wrap gap-1 mt-1">
                    <span className="text-white/40 mr-1">P2:</span>
                    {r.player2Catches.map((c) => (
                      <span key={c.number} className={`px-1.5 rounded ${c.quality === "perfect" ? "bg-emerald-500/20 text-emerald-300" : "bg-cyan-500/15 text-cyan-200"}`}>
                        {c.number}
                      </span>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <div className="flex gap-2">
          <button
            onClick={onLobby}
            className="flex-1 rounded-lg bg-[#00e5ff] text-[#001933] py-3 font-bold hover:shadow-[0_0_20px_rgba(0,229,255,0.6)] transition"
          >
            Back to Lobby
          </button>
          <button
            onClick={() => router.push("/casino/keno")}
            className="flex-1 rounded-lg bg-gradient-to-r from-[#00e5ff] to-[#00ffa6] text-[#001933] py-3 font-bold hover:shadow-[0_0_20px_rgba(0,255,166,0.6)] transition"
          >
            <span className="inline-flex items-center gap-1.5"><IconRefresh size={16} /> New Match</span>
          </button>
        </div>
      </div>
    </div>
  );
}
