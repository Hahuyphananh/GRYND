"use client";

// src/app/casino/keno-pvp/[matchId]/page.jsx
//
// Live 1v1 Keno Catch Duel match view. Both players face the SAME
// shared 10-ball draw; balls are released one at a time on a
// server-declared schedule and you tap to catch each one inside its
// window — perfect-timed taps earn bonus points. Best of 5 rounds,
// first to 3 round wins takes the pot (90/10 split).
//
// The client animates the ball stream from the match's roundDeadline
// + the shared timing constants; the SERVER grades every catch with
// its own clock, so the client can never self-report a perfect tap.
// The opponent's ticket stays hidden until the round resolves.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { usePostHog } from "posthog-js/react";
import { motion, AnimatePresence } from "framer-motion";
import NavigationBar from "../../../../components/navigation-bar";
import Footer from "../../../../components/Footer";
import { useSocket } from "../../../../context/SocketProvider";
import {
  KENO_PVP_MATCH_UPDATED,
  kenoPvpMatchRoom,
} from "../../../../lib/keno-pvp/rooms";
import {
  BALL_COUNT,
  IDEAL_CATCH_MS,
  KENO_POOL_SIZE,
  PERFECT_BONUS,
  PERFECT_WINDOW_MS,
} from "../../../../lib/keno-pvp/constants";
import { ballSchedule, computeRoundStats } from "../../../../lib/keno-pvp/engine";

const QUALITY_LABEL = {
  perfect: { text: "PERFECT +5", cls: "text-emerald-300 border-emerald-400/60 bg-emerald-500/15" },
  good: { text: "GOOD", cls: "text-cyan-300 border-cyan-400/50 bg-cyan-500/15" },
  late: { text: "LATE", cls: "text-slate-300 border-slate-400/40 bg-slate-500/15" },
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
  const [lastQuality, setLastQuality] = useState(null); // { ball, quality } flash
  const [roundBanner, setRoundBanner] = useState(null); // { roundNumber, winnerIsYou }
  const [leaving, setLeaving] = useState(false);

  const myCatchesRef = useRef([]);
  const lastStatusRef = useRef(null);
  const bannerTimerRef = useRef(null);

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
      const res = await fetch(`/api/keno-pvp/match/${matchId}`, {
        cache: "no-store",
      });
      const json = await res.json();
      if (!json.success) {
        if (res.status === 401) {
          router.push("/sign-in?redirect_url=" + encodeURIComponent(`/casino/keno-pvp/${matchId}`));
        }
        setError(json.error || "Failed to load match");
        return;
      }
      setMatch(json.data.match);
      setRounds(json.data.rounds || []);
      myCatchesRef.current = json.data.match.myCatches || [];

      const m = json.data.match;
      const prev = lastStatusRef.current;
      // Detect a just-resolved round so we can flash a winner banner.
      if (
        prev &&
        /^round_\d+$/.test(prev.status) &&
        /^round_\d+$/.test(m.status) &&
        Number(m.currentRound) > Number(prev.currentRound)
      ) {
        const prevRound = rounds.find((r) => r.roundNumber === Number(prev.currentRound));
        if (prevRound) {
          const youWon = prevRound.roundWinner
            ? prevRound.roundWinner === (m.viewerIsPlayer1 ? "player1" : "player2")
            : null;
          setRoundBanner({ roundNumber: prevRound.roundNumber, winnerIsYou: youWon });
          if (bannerTimerRef.current) clearTimeout(bannerTimerRef.current);
          bannerTimerRef.current = setTimeout(() => setRoundBanner(null), 2600);
        }
      }
      lastStatusRef.current = m;
    } catch {
      // Silent — poll retries.
    }
  }, [matchId, router, rounds]);

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

  useEffect(() => {
    setLoading(false);
  }, [match]);

  const isRound = match && /^round_\d+$/.test(match.status || "");
  const isWaiting = match?.status === "waiting";
  const isReady = match?.status === "ready";
  const isFinished = match?.status === "finished";
  const isCancelled = match?.status === "cancelled";

  // The release schedule for the current round, derived server-style
  // from the round deadline (identical for both players).
  const schedule = useMemo(() => {
    if (!isRound || !match?.roundDeadline) return [];
    return ballSchedule(new Date(match.roundDeadline).getTime(), match.currentDraw || []);
  }, [isRound, match?.roundDeadline, match?.currentDraw]);

  // The ball currently catchable (latest released, not yet expired).
  const activeBall = useMemo(() => {
    if (!isRound) return null;
    const nowMs = now;
    let active = null;
    for (const b of schedule) {
      if (nowMs >= b.releaseMs && nowMs < b.acceptedUntilMs) active = b;
    }
    return active;
  }, [isRound, schedule, now]);

  const roundEndMs = match?.roundDeadline ? new Date(match.roundDeadline).getTime() : 0;
  const roundTimeLeft = Math.max(0, Math.ceil((roundEndMs - now) / 1000));

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
      if (now >= b.releaseMs) set.add(b.number);
    }
    return set;
  }, [isRound, schedule, now]);

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
    async (ballNumber) => {
      if (!matchId || !activeBall || ballNumber !== activeBall.number) return;
      if ((myCatchesRef.current || []).some((c) => c.number === ballNumber)) return;
      try {
        const res = await fetch(`/api/keno-pvp/match/${matchId}/catch`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ ball: ballNumber }),
        });
        const json = await res.json();
        if (!json.success) {
          setLastQuality({ ball: ballNumber, quality: "missed", text: json.error || "Missed" });
          setTimeout(() => setLastQuality(null), 900);
          return;
        }
        setLastQuality({ ball: ballNumber, quality: json.data.catch.quality });
        myCatchesRef.current = [...myCatchesRef.current, json.data.catch];
        setMatch((prev) => {
          if (!prev) return prev;
          const mine = [...(prev.myCatches || []), json.data.catch];
          return { ...prev, myCatches: mine };
        });
        posthog?.capture("keno_pvp_caught", {
          match_id: matchId,
          ball: ballNumber,
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
    [matchId, activeBall, posthog, socket],
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

  return (
    <div className="min-h-screen overflow-x-clip bg-gradient-to-br from-[#001933] to-[#000d1a] px-3 pb-24 pt-20 text-white sm:px-6 md:pb-8">
      <NavigationBar currentPath="/casino" />

      <div className="mx-auto mt-4 max-w-5xl">
        {/* Header + scoreboard */}
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl sm:text-3xl font-extrabold tracking-wide text-transparent bg-clip-text bg-gradient-to-r from-[#00e5ff] to-[#00ffa6]">
              🎱 Keno Catch Duel
            </h1>
            <p className="text-xs text-white/50 mt-1">
              Best of 5 · first to 3 round wins · stake {match.stakeAmount.toLocaleString()} 🪙
              {match.isBot ? " · 🤖 Test vs Bot (free play)" : ""}
            </p>
          </div>
          <div className="rounded-xl border border-[#00e5ff]/30 bg-[#0b224f]/85 px-4 py-2 text-sm shadow-[0_0_14px_rgba(0,229,255,0.15)]">
            <div className="flex items-center gap-3">
              <span className="font-bold text-[#00ffa6]">{me === "player1" ? "You" : p1Name} {myWins}</span>
              <span className="text-white/40">–</span>
              <span className="font-bold text-[#FFD700]">{oppWins} {me === "player2" ? "You" : p2Name}</span>
            </div>
            <div className="flex items-center justify-center gap-3 mt-1 text-[11px] text-white/50">
              <span>{myPts} pts</span>
              <span>·</span>
              <span>{oppPts} pts</span>
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
                  ? "you won it! 🎉"
                  : "opponent won it."}
            </motion.div>
          )}
        </AnimatePresence>

        {error && (
          <div className="mb-3 rounded-lg border border-red-400/40 bg-red-900/30 px-3 py-2 text-sm text-red-200">
            {error}
          </div>
        )}

        {/* ── WAITING ─────────────────────────────────────────────── */}
        {isWaiting && (
          <div className="rounded-2xl border border-[#00e5ff]/30 bg-[#0b224f]/85 p-10 text-center">
            <p className="text-4xl mb-3 animate-pulse">🎱</p>
            <h2 className="text-xl font-bold mb-2">Waiting for an opponent…</h2>
            <p className="text-sm text-white/60 mb-6">
              Your {match.stakeAmount.toLocaleString()} 🪙 stake is escrowed. Someone with the same
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
            <h2 className="text-2xl font-bold mb-2">Match found! 🤝</h2>
            <p className="text-sm text-white/60">
              {p1Name} vs {p2Name} — round 1 starts in a moment. Catch the balls before they drop!
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
                  Round {match.currentRound}/5
                </span>
                <span>{roundTimeLeft}s left</span>
              </div>

              {/* Ball stream lane */}
              <div className="flex items-center justify-center gap-1.5 sm:gap-2 flex-wrap mb-5">
                {Array.from({ length: BALL_COUNT }, (_, i) => i).map((i) => {
                  const ball = schedule[i];
                  const caught = (match.myCatches || []).some((c) => c.number === ball?.number);
                  const expired = ball && now >= ball.acceptedUntilMs;
                  const released = ball && now >= ball.releaseMs;
                  const isActive = activeBall?.number === ball?.number;
                  const isUpcoming = ball && !released;
                  let cls = "bg-[#0a1a3a] border-[#00e5ff]/20 text-white/30";
                  if (isActive) cls = "bg-[#00e5ff] text-[#001933] border-[#00e5ff] scale-110 shadow-[0_0_20px_rgba(0,229,255,0.8)]";
                  else if (caught) cls = "bg-[#00ffa6]/25 text-[#00ffa6] border-[#00ffa6]/50";
                  else if (expired) cls = "bg-[#1a2333] border-white/10 text-white/25 line-through";
                  else if (isUpcoming) cls = "bg-[#0a1a3a] border-[#00e5ff]/25 text-white/50";
                  return (
                    <button
                      key={ball ? ball.number : i}
                      disabled={!isActive}
                      onClick={() => isActive && doCatch(ball.number)}
                      className={`relative w-11 h-11 sm:w-14 sm:h-14 rounded-full border-2 flex items-center justify-center text-sm sm:text-base font-bold transition-all duration-150 ${
                        isActive ? "cursor-pointer animate-pulse touch-manipulation select-none active:scale-90" : "cursor-default"
                      } ${cls}`}
                    >
                      {ball ? ball.number : "·"}
                      {isActive && (
                        <span className="absolute -top-2 -right-1 text-[9px] font-black text-[#00ffa6] animate-pulse">CATCH!</span>
                      )}
                    </button>
                  );
                })}
              </div>

              {/* Big catch button */}
              <div className="flex flex-col items-center gap-2">
                {activeBall ? (
                  <>
                    <button
                      onClick={() => doCatch(activeBall.number)}
                      className="px-10 py-4 rounded-2xl text-lg font-extrabold text-[#001933] bg-gradient-to-r from-[#00e5ff] to-[#00ffa6] shadow-[0_0_25px_rgba(0,229,255,0.6)] hover:scale-105 active:scale-95 transition touch-manipulation select-none"
                    >
                      CATCH {activeBall.number}!
                    </button>
                    <p className="text-[11px] text-white/40">
                      Tap inside the gold window (≈{Math.round((IDEAL_CATCH_MS - PERFECT_WINDOW_MS) / 1000 * 10) / 10}s after release) for PERFECT +{PERFECT_BONUS}
                    </p>
                  </>
                ) : (
                  <p className="text-sm text-white/50 animate-pulse">
                    {roundTimeLeft > 0 ? "Next ball incoming…" : "Resolving round…"}
                  </p>
                )}
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
                        QUALITY_LABEL[lastQuality.quality]?.cls || "text-white border-white/40 bg-black/60"
                      }`}
                    >
                      {lastQuality.quality === "missed"
                        ? lastQuality.text || "MISSED"
                        : `BALL ${lastQuality.ball} · ${QUALITY_LABEL[lastQuality.quality].text}`}
                    </span>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            {/* Keno board — drawn numbers light up as the draw unfolds */}
            <div className="rounded-2xl border border-[#00e5ff]/35 bg-[#050d1f]/70 p-4 sm:p-5">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-bold uppercase tracking-wider text-[#7cefff]">
                  🎱 Keno Board 1–{KENO_POOL_SIZE}
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
                  const caught = caughtNumbers.has(num);
                  const oppCaught = oppRevealedNumbers.has(num);
                  const drawn = drawnNumbers.has(num);
                  return (
                    <div
                      key={num}
                      className={`w-10 h-10 sm:w-11 sm:h-11 md:w-12 md:h-12 flex items-center justify-center rounded-lg text-sm font-bold transition-all duration-200 ${
                        caught
                          ? "bg-[#00ffa6] text-[#001933] scale-105 ring-2 ring-[#00ffa6]/70 shadow-[0_0_18px_rgba(0,255,166,0.9)]"
                          : oppCaught
                            ? "bg-[#FFD700]/25 text-[#FFD700] border border-[#FFD700]/50"
                            : drawn
                              ? "bg-[#00ffa6]/20 text-[#00ffa6] border border-[#00ffa6]/45"
                              : "bg-[#020617] border border-[#00e5ff]/20 text-white/35"
                      }`}
                    >
                      {num}
                    </div>
                  );
                })}
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
                    <p className="text-xs text-white/40">Catch some balls!</p>
                  )}
                  {(match.myCatches || []).map((c) => (
                    <span
                      key={c.number}
                      className={`px-2.5 py-1 rounded-lg border text-sm font-bold ${QUALITY_LABEL[c.quality]?.cls || "bg-white/10"}`}
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

        {/* ── FINISHED ────────────────────────────────────────────── */}
        {isFinished && (
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
            <p className="text-3xl mb-3">🚫</p>
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

// ── Result modal ──────────────────────────────────────────────────────
function ResultModal({ match, rounds, me, p1Name, p2Name, myWins, oppWins, myPts, oppPts, onLobby }) {
  const router = useRouter();
  const [showReveal, setShowReveal] = useState(false);
  const result = match.result;
  const iWon = result === me;
  const drew = result === "draw";

  const net = useMemo(() => {
    if (match.isBot) return 0;
    if (drew) return 0;
    return iWon ? Number(match.prizePaid) - Number(match.stakeAmount) : -Number(match.stakeAmount);
  }, [match, iWon, drew]);

  const winnerName = result === "player1" ? p1Name : p2Name;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4">
      <div className="w-full max-w-lg rounded-2xl border border-[#00e5ff]/40 bg-[#050d1f]/95 p-6 shadow-[0_0_40px_rgba(0,229,255,0.25)] max-h-[92vh] overflow-y-auto">
        <div className="text-center mb-4">
          <p className="text-5xl mb-2">{drew ? "🤝" : iWon ? "🏆" : "💀"}</p>
          <h2 className={`text-2xl sm:text-3xl font-extrabold ${
            drew ? "text-white/70" : iWon ? "text-[#00ffa6]" : "text-red-400"
          }`}>
            {drew ? "MATCH DRAW" : iWon ? "YOU WON!" : `${winnerName} WON`}
          </h2>
          <p className="text-sm text-white/60 mt-1">
            {myWins} – {oppWins} round wins · {myPts} – {oppPts} pts
          </p>
          {!match.isBot && (
            <p className={`mt-2 text-xl font-black ${drew ? "text-white/60" : iWon ? "text-[#00ffa6]" : "text-red-400"}`}>
              {drew ? "Stake refunded" : `${iWon ? "+" : "−"}${Math.abs(net).toLocaleString()} 🪙`}
            </p>
          )}
          {match.isBot && <p className="mt-1 text-xs text-white/40">Practice match — no tokens wagered</p>}
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
            🔄 New Match
          </button>
        </div>
      </div>
    </div>
  );
}
