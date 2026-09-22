"use client";

// src/app/casino/keno-pvp/[matchId]/PageClient.jsx
//
// Live 1v1 Keno SURVIVAL DUEL match view.
//
// Both players start with 3 lives. ONE tile is lit at a time on the 1–40
// board and both players race for it: the first to tap it claims the tile
// and the opponent loses a life. A tile nobody claims in time is a
// BOTH-MISS — both players lose a life. The claim window starts at 1.6s
// and tightens 100ms for every claimed tile (floor 0.4s), so the match
// turns into a pure reaction test. Lose all your lives and the match is
// over (both eliminated on the same both-miss → draw).
//
// The client renders the live tile + its window from the SERVER's clock
// and the public per-tile log; the SERVER decides every outcome with its
// own clock, so the client can never self-report a claim.

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { usePostHog } from "posthog-js/react";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import confetti from "canvas-confetti";
import NavigationBar from "../../../../components/navigation-bar";
import Footer from "../../../../components/Footer";
import MatchWaiting from "../../../../components/lobby/MatchWaiting";
import CreatorResultOverlay from "../../../../components/creator-mode/CreatorResultOverlay";
import FrameAvatar from "../../../../components/FrameAvatar";
import { cosmeticEffectClass } from "../../../../lib/profileCosmetics";
// Shared Creator Mode foundation (admin-only): mounts the viewport
// recorder + overlay, auto-starts when the run is live and auto-stops
// once it finishes/cancels. The matchmaking takeover and nav stay outside
// the shared CreatorModeHost recording viewport.
import CreatorModeHost from "../../../../components/creator-mode/CreatorModeHost";
import {
  CreatorView,
  CreatorModeShell,
  ShellMain,
  CreatorPhoneFrame,
} from "../../../../components/creator-mode/CreatorModeLayout";
import {
  getSharedAudioContext,
  getSharedOutputNode,
} from "../../../../lib/creator-mode/audioTap";
// Shared game SFX. gameAudio imports the same creator-mode/audioTap
// singleton as the inline tick in this page, so every Keno sound routes
// through ONE page-wide audio context / output node — Creator Mode keeps
// capturing it, and the global mute gate keeps silencing all of it.
import {
  playGoodReveal,
  playBuzz,
  playVictory,
  playDefeat,
  playTick,
} from "../../../../lib/gameAudio";
import EmotePicker, { EmoteBubble } from "../../../../components/game/EmotePicker";
import useGameEmotes from "../../../../hooks/useGameEmotes";
import { useSocket } from "../../../../context/SocketProvider";
import {
  KENO_PVP_MATCH_UPDATED,
  kenoPvpMatchRoom,
} from "../../../../lib/keno-pvp/rooms";
import {
  KENO_POOL_SIZE,
  MIN_WINDOW_MS,
  STARTING_LIVES,
  START_WINDOW_MS,
} from "../../../../lib/keno-pvp/constants";
import { tileWindowMs, windowRemainingMs } from "../../../../lib/keno-pvp/engine";
import { withReducedMotion } from "../../../../lib/animations";
import {
  IconCoins,
  IconHeartHandshake,
  IconTrophy,
  IconCircleX,
  IconNotebook,
  IconX,
  IconTarget,
  IconVolume,
  IconClock,
} from "@tabler/icons-react";
import { PoolBallIcon } from "../../../../components/icons/CustomIcons";

// The 1–40 board numbers. Built once: both board copies map it, and it
// never changes.
const KENO_NUMBERS = Array.from({ length: KENO_POOL_SIZE }, (_, i) => i + 1);

// Server reason → player-facing copy for a tap that did not land. Raw API
// strings must never reach the board.
const MISS_TEXT = {
  "That tile is not live": "Not the live tile",
  "That tile is no longer live": "That tile is gone",
  "Too slow — the tile expired": "Too slow",
  "No tile is live yet": "Wait for the next tile",
  "Match is not live": "Match over",
  "Tile is not live yet": "Not live yet",
};
const MISS_TEXT_FALLBACK = "Too slow";

// Reasons that mean this player's tap genuinely failed (and the tile was
// resolved as a both-miss) → show a miss flash. Transport/auth failures
// are deliberately absent: they are not the player's fault.
const TAP_MISS_REASONS = new Set([
  "That tile is not live",
  "That tile is no longer live",
  "Too slow — the tile expired",
  "Match is not live",
  "No tile is live yet",
]);

function missTextFor(reason) {
  return MISS_TEXT[reason] || MISS_TEXT_FALLBACK;
}

// ── Public tile log → presentation ────────────────────────────────────
//
// The tile log is public to both players (both watch every tile resolve),
// so the match feed is derived from it rather than from local guesses.
// One line per resolved tile, written from the VIEWER's perspective.

function feedLineFor(entry, viewerIsPlayer1, oppName) {
  if (!entry) return null;
  const mine = viewerIsPlayer1 ? "player1" : "player2";
  const outcome = entry.outcome;
  if (outcome === "both_miss") {
    return {
      tone: "miss",
      text: `Nobody claimed tile ${entry.tile} — both lost a life`,
    };
  }
  const name = oppName || "Your opponent";
  if (outcome === mine) {
    return {
      tone: "mine",
      text: `You claimed tile ${entry.tile}${
        entry.reactionMs != null ? ` · ${entry.reactionMs}ms` : ""
      }`,
    };
  }
  return {
    tone: "opp",
    text: `${name} claimed tile ${entry.tile} first — you lost a life`,
  };
}

// The one-line instruction above the board.
function liveStatusText({ isLive, hasLiveTile, remainingMs, viewerCanClaim }) {
  if (!isLive) return null;
  if (!hasLiveTile) return "Lighting the next tile…";
  if (remainingMs <= 0) return "Tile expired — resolving…";
  if (!viewerCanClaim) return "Waiting for the match…";
  return "Tap the lit tile before the window closes";
}

// Lives as pips: filled = remaining, hollow = lost.
function LivesPips({ lives, total = STARTING_LIVES, tone = "cyan" }) {
  const filled = Math.max(0, Math.min(total, Number(lives) || 0));
  const color = tone === "opp" ? "bg-[#FFD700]" : "bg-[#00ffa6]";
  return (
    <span className="inline-flex items-center gap-1" aria-label={`${filled} of ${total} lives left`}>
      {Array.from({ length: total }, (_, i) => (
        <span
          key={i}
          className={
            "h-2.5 w-2.5 rounded-full border " +
            (i < filled
              ? `${color} border-transparent shadow-[0_0_6px_rgba(0,229,255,0.5)]`
              : "border-white/30 bg-white/5")
          }
        />
      ))}
    </span>
  );
}

// One Keno board tile.
//
// Memoized leaf: the page re-renders on the 100ms board clock, which used
// to rebuild all 40 tile buttons on every tick. This re-renders only when
// a prop it actually renders changes. The countdown bar is a plain width
// (a data read-out, not decoration), so it stays informative under
// prefers-reduced-motion.
const KenoTile = memo(function KenoTile({
  num,
  isLive,
  liveRemainingRatio,
  claimedByMe,
  claimedByOpp,
  missed,
  frozen,
  onClaim,
}) {
  let cls = "bg-[#0b224f] border border-[#00e5ff]/20 text-white/40 cursor-default";
  if (missed) cls = "bg-red-900/40 border border-red-500/40 text-red-300/70 cursor-default";
  if (claimedByOpp) cls = "bg-[#FFD700]/30 border border-[#FFD700]/60 text-[#FFD700] cursor-default";
  if (claimedByMe) cls = "bg-[#00ffa6] border border-[#00ffa6]/70 text-[#001933] font-black cursor-default";
  if (isLive) {
    cls =
      "bg-[#00e5ff] border border-white/70 text-[#001933] font-black scale-110 " +
      "ring-2 ring-white/80 shadow-[0_0_22px_rgba(0,229,255,0.9)] cursor-pointer animate-pulse";
  }
  const disabled = frozen || !isLive;
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => {
        if (!disabled) onClaim(num);
      }}
      aria-label={
        isLive
          ? `Live tile ${num} — tap to claim`
          : claimedByMe
            ? `Tile ${num} claimed by you`
            : claimedByOpp
              ? `Tile ${num} claimed by your opponent`
              : missed
                ? `Tile ${num} went unclaimed`
                : `Tile ${num}`
      }
      className={`relative w-full aspect-square overflow-hidden flex items-center justify-center rounded-lg text-sm font-bold transition-all duration-200 touch-manipulation select-none active:scale-90 ${cls}`}
    >
      {num}
      {isLive && (
        <span
          aria-hidden="true"
          className="absolute inset-x-0 bottom-0 h-1 bg-white/85 transition-[width] duration-100 ease-linear"
          style={{ width: `${Math.max(0, Math.min(1, liveRemainingRatio)) * 100}%` }}
        />
      )}
    </button>
  );
});

// Cushion added to the tile-deadline nudge below. The nudge is timed from
// our own estimate of the server clock (`clockOffset`), which carries up
// to roughly half an RTT of error; without the cushion the read could land
// a fraction early, see the tile still live, and wait for the poll.
const DEADLINE_NUDGE_CUSHION_MS = 300;

// When a free (AI) match re-asks the server to run the bot's turn, measured
// from the moment the page learns of the live tile.
//
// The bot's claim is graded SERVER-side against its own reaction time —
// 200–420ms into the tile's window — so a coarse poll can never catch it: the
// 5s backstop poll and the deadline nudge both land outside the window, and
// the store refuses to claim once the tile has expired. A short burst (plus
// one immediate ask) covers the whole reaction band without polling for the
// entire window: whichever probe first lands at/after the bot's due time is
// the one that writes the claim.
const AI_TURN_PROBE_OFFSETS_MS = [140, 300, 460];

export default function KenoPvpMatchPage({ params }) {
  const router = useRouter();
  const posthog = usePostHog();
  const { socket } = useSocket();
  const shouldReduceMotion = useReducedMotion();

  const [matchId, setMatchId] = useState(null);
  const [match, setMatch] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [now, setNow] = useState(Date.now());
  const [clockOffset, setClockOffset] = useState(0); // ms: serverNow = clientNow + offset
  // Latest resolved-tile event, shown as a short banner. Derived from the
  // public tile log (never from local guesses), so it can never disagree
  // with the server.
  const [feedEntry, setFeedEntry] = useState(null);
  // Local tap feedback only (pending ring / too-slow flash).
  const [claiming, setClaiming] = useState(false);
  const [tapMiss, setTapMiss] = useState(null);
  const [showRules, setShowRules] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [flashSeat, setFlashSeat] = useState(null); // "you" | "opp" | null
  const [showResult, setShowResult] = useState(false);

  // Synchronous in-flight guard: one tap per live tile. A ref so a second
  // tap in the same tick is dropped before it can race the first request.
  const claimingRef = useRef(false);
  // Status-read ordering. Several reads can be in flight at once (the 5s
  // poll, a socket push, the deadline nudge) and they can resolve out of
  // order — the sequence number lets only the newest response commit a
  // snapshot.
  const statusSeqRef = useRef(0);
  const lastAppliedStatusSeqRef = useRef(0);
  const lastStatusRef = useRef(null);
  const deadlineNudgedRef = useRef(null);
  const feedTimerRef = useRef(null);
  const flashTimerRef = useRef(null);
  const tapMissTimerRef = useRef(null);
  const resultTimerRef = useRef(null);
  const confettiFiredRef = useRef(false);
  // Highest tile-log index already announced, so a poll/socket snapshot
  // can never replay a banner or a life-loss flash.
  const seenLogIndexRef = useRef(-1);
  // The live tile index whose audio tick has already played.
  const tickedIndexRef = useRef(-1);

  // Show one short banner for a newly resolved tile.
  const showFeed = useCallback((entry, ms = 2200) => {
    setFeedEntry(entry);
    if (feedTimerRef.current) clearTimeout(feedTimerRef.current);
    feedTimerRef.current = setTimeout(() => {
      feedTimerRef.current = null;
      setFeedEntry(null);
    }, ms);
  }, []);

  const triggerSeatFlash = useCallback((who) => {
    setFlashSeat(who);
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    flashTimerRef.current = setTimeout(() => setFlashSeat(null), 1800);
  }, []);

  // Short confetti burst when YOU take the match. Fires once per match
  // (guard ref); visible because the result modal is held back ~1.2s.
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
    } catch {
      // Best-effort — ignore.
    }
  }, []);

  // Clean up timers + in-flight bookkeeping on unmount.
  useEffect(() => {
    return () => {
      if (feedTimerRef.current) clearTimeout(feedTimerRef.current);
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
      if (tapMissTimerRef.current) clearTimeout(tapMissTimerRef.current);
      if (resultTimerRef.current) clearTimeout(resultTimerRef.current);
      claimingRef.current = false;
    };
  }, []);

  // Resolve the [matchId] param (Next 15/16 passes params as a Promise).
  useEffect(() => {
    (async () => {
      const p = await params;
      setMatchId(Number(p?.matchId));
    })();
  }, [params]);

  const fetchStatus = useCallback(async () => {
    if (!matchId) return;
    const seq = (statusSeqRef.current += 1);
    try {
      const t0 = Date.now();
      const res = await fetch(`/api/keno-pvp/match/${matchId}`, {
        cache: "no-store",
      });
      const json = await res.json();
      // Clock sync: the response carries the server's clock. Estimate the
      // server↔client offset from the request midpoint and smooth it —
      // the tile deadline is a server-set absolute, so comparing against
      // the server clock keeps the window aligned with the server's
      // grading. Ignore samples from slow/hung requests.
      const t1 = Date.now();
      const serverTime = Number(json.data?.serverTime);
      if (Number.isFinite(serverTime) && serverTime > 0 && t1 - t0 < 2000) {
        const sample = serverTime - (t0 + t1) / 2;
        setClockOffset((prev) => (prev === 0 ? sample : prev * 0.7 + sample * 0.3));
      }
      if (!json.success) {
        if (res.status === 401) {
          router.push(
            "/sign-in?redirect_url=" +
              encodeURIComponent(`/casino/keno-pvp/${matchId}`),
          );
        }
        setError(json.error || "Failed to load match");
        return;
      }
      setError(null);
      // Newest snapshot wins: an older read must not roll the board back
      // to a tile that has already been resolved.
      if (seq <= lastAppliedStatusSeqRef.current) return;
      lastAppliedStatusSeqRef.current = seq;

      const m = json.data.match;
      setMatch(m);

      const log = Array.isArray(m.tileLog) ? m.tileLog : [];
      const newest = log.length > 0 ? log[log.length - 1] : null;
      const newestIndex = newest ? Number(newest.index) : -1;

      if (Number.isFinite(newestIndex) && newestIndex > seenLogIndexRef.current) {
        seenLogIndexRef.current = newestIndex;
        const oppName =
          m.players?.[m.viewerIsPlayer1 ? "p2" : "p1"]?.displayName ||
          (m.isAi ? "GRYND AI" : "Your opponent");
        const line = feedLineFor(newest, Boolean(m.viewerIsPlayer1), oppName);
        if (line) showFeed(line);
        // Life-loss flash on the seat that dropped.
        const prev = lastStatusRef.current;
        const p1Dropped =
          prev && Number(newest.p1Lives) < Number(prev.p1Lives ?? STARTING_LIVES);
        const p2Dropped =
          prev && Number(newest.p2Lives) < Number(prev.p2Lives ?? STARTING_LIVES);
        if (m.viewerIsPlayer1 ? p1Dropped : p2Dropped) triggerSeatFlash("you");
        else if (m.viewerIsPlayer1 ? p2Dropped : p1Dropped) triggerSeatFlash("opp");
      }

      // Result modal is held back ~1.2s so the final board + the winning
      // flash are visible before the overlay covers the screen.
      if (m.status === "finished" && lastStatusRef.current?.status !== "finished") {
        if (resultTimerRef.current) clearTimeout(resultTimerRef.current);
        resultTimerRef.current = setTimeout(() => setShowResult(true), 1200);
      } else if (m.status !== "finished") {
        if (resultTimerRef.current) clearTimeout(resultTimerRef.current);
        setShowResult(false);
      }
      lastStatusRef.current = m;
    } catch {
      // Network failure (e.g. ERR_INTERNET_DISCONNECTED): surface it and
      // clear the loading state so the page never sits on a blank screen
      // forever. The poll keeps retrying and clears it once connectivity
      // returns.
      setLoading(false);
      setError("Can't reach the server — check your connection. Retrying…");
    }
  }, [matchId, router, showFeed, triggerSeatFlash]);

  useEffect(() => {
    if (!matchId) return;
    fetchStatus();
    // Socket room (KENO_PVP_MATCH_UPDATED) pushes opponent actions
    // instantly; this HTTP poll is a reconnect safety net. Held at 5s to
    // keep match-time DB reads minimal — the tile pacing comes from the
    // server deadline + the local 100ms clock, never from the poll rate.
    const interval = setInterval(fetchStatus, 5000);
    return () => clearInterval(interval);
  }, [matchId, fetchStatus]);

  // Tile-deadline nudge: the server only resolves a both-miss when it is
  // read, so without this the board can sit on an expired tile for up to a
  // whole poll tick. One extra status read just after the deadline (+ the
  // hidden grace), and at most one nudge per deadline.
  useEffect(() => {
    const deadlineMs = match?.liveDeadline
      ? new Date(match.liveDeadline).getTime()
      : null;
    if (!matchId || deadlineMs == null || !Number.isFinite(deadlineMs)) {
      deadlineNudgedRef.current = null;
      return;
    }
    const grace = Number(match.tapGraceMs) || 0;
    if (deadlineNudgedRef.current === deadlineMs) return;
    const delay = Math.max(
      0,
      deadlineMs + grace - (Date.now() + clockOffset) + DEADLINE_NUDGE_CUSHION_MS,
    );
    const timer = setTimeout(() => {
      deadlineNudgedRef.current = deadlineMs;
      void fetchStatus();
    }, delay);
    return () => clearTimeout(timer);
  }, [matchId, match?.liveDeadline, match?.tapGraceMs, clockOffset, fetchStatus]);

  // ── Free practice: let the bot actually take its turn ────────────────
  // A free (AI) match's bot claims are decided and written SERVER-side, but
  // only when the server is read at/after the bot's own reaction time inside
  // the live tile's window. Nothing else reads that often — the 5s backstop
  // poll and the deadline nudge are both too late, and the store explicitly
  // refuses to claim once the window has expired. Without this sweep the bot
  // is never asked in time, so every tile resolves as a both-miss and the AI
  // appears to do nothing at all.
  //
  // The sweep uses the dedicated ai-turn route (it only runs the bot's due
  // claim and returns a count, rather than a full match read) and pulls the
  // board once the bot has actually tapped. Scoped to a free AI match, where
  // this viewer is the human seat, with a live tile on the board — a
  // human-vs-human duel keeps its single 5s poll.
  useEffect(() => {
    if (!matchId || !match?.isAi || !match?.viewerIsPlayer1) return undefined;
    if (!match?.viewerCanClaim) return undefined;

    let cancelled = false;
    const probe = async () => {
      try {
        const res = await fetch(`/api/keno-pvp/match/${matchId}/ai-turn`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({}),
        });
        const json = await res.json();
        if (cancelled) return;
        // The bot tapped: repaint the board (its claim + the next live tile).
        if (json?.success && Number(json.data?.actions) > 0) void fetchStatus();
      } catch {
        // Network failure — the next probe retries.
      }
    };

    // One ask straight away (covers a tile we only learned about late), then
    // the burst across the bot's reaction band.
    void probe();
    const timers = AI_TURN_PROBE_OFFSETS_MS.map((offset) =>
      setTimeout(probe, offset),
    );
    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
    };
  }, [
    matchId,
    match?.isAi,
    match?.viewerIsPlayer1,
    match?.viewerCanClaim,
    match?.liveTile,
    match?.liveTileIndex,
    fetchStatus,
  ]);

  // Socket live-update: refresh instantly on opponent actions.
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

  // Board clock (100ms ticks drive the window bar + the ring seconds).
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(interval);
  }, []);

  // Subtle audio tick the moment a new tile lights up. Synthesised with
  // the Web Audio API (no asset needed); the context is created lazily and
  // resumed on the first user gesture. Best-effort.
  const playTileTick = useCallback(() => {
    try {
      const ctx = getSharedAudioContext();
      if (!ctx) return;
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
      osc.connect(gain).connect(getSharedOutputNode() || ctx.destination);
      osc.start(t);
      osc.stop(t + 0.1);
    } catch {
      // Audio is best-effort — ignore.
    }
  }, []);

  // Unlock the shared audio context on the first user gesture.
  useEffect(() => {
    const unlock = () => {
      try {
        const ctx = getSharedAudioContext();
        if (ctx && ctx.state === "suspended") ctx.resume();
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

  // Server-view of "now": every timing comparison uses the server clock.
  const serverNow = now + clockOffset;

  useEffect(() => {
    setLoading(false);
  }, [match]);

  const isWaiting = match?.status === "waiting";
  const isReady = match?.status === "ready";
  const isLive = Boolean(match?.status) && /^round_\d+$/.test(match.status);
  const isFinished = match?.status === "finished";
  const isCancelled = match?.status === "cancelled";

  const liveTile = match?.liveTile ?? null;
  const windowMs = Number(match?.windowMs) || tileWindowMs(0);
  const liveDeadlineMs = match?.liveDeadline
    ? new Date(match.liveDeadline).getTime()
    : 0;
  const remainingMs = liveDeadlineMs
    ? windowRemainingMs({ deadlineMs: liveDeadlineMs, atMs: serverNow })
    : 0;
  const remainingSec = remainingMs / 1000;
  const remainingRatio = windowMs > 0 ? remainingMs / windowMs : 0;

  // Audio tick once per newly lit tile.
  useEffect(() => {
    const index = Number(match?.liveTileIndex);
    if (!isLive || liveTile == null || !Number.isInteger(index)) return;
    if (index === tickedIndexRef.current) return;
    tickedIndexRef.current = index;
    playTileTick();
  }, [isLive, liveTile, match?.liveTileIndex, playTileTick]);

  // Board sets — derived from the PUBLIC tile log, so the board can never
  // mislabel a tile the server resolved differently.
  const { myClaimedSet, oppClaimedSet, missedSet } = useMemo(() => {
    const mine = new Set();
    const opp = new Set();
    const missed = new Set();
    const viewerSeat = match?.viewerIsPlayer1 ? "player1" : "player2";
    for (const entry of Array.isArray(match?.tileLog) ? match.tileLog : []) {
      const tile = Number(entry?.tile);
      if (!Number.isInteger(tile)) continue;
      if (entry.outcome === "both_miss") missed.add(tile);
      else if (entry.outcome === viewerSeat) mine.add(tile);
      else opp.add(tile);
    }
    return { myClaimedSet: mine, oppClaimedSet: opp, missedSet: missed };
  }, [match?.tileLog, match?.viewerIsPlayer1]);

  // Result sting, fired with the result PANEL rather than the instant the
  // row settles. `showResult` flips exactly once per finished match and
  // the guard ref makes the sound fire once even if more snapshots arrive.
  const resultSoundFiredRef = useRef(false);
  useEffect(() => {
    if (!isFinished) {
      resultSoundFiredRef.current = false;
      return;
    }
    if (!showResult || resultSoundFiredRef.current) return;
    resultSoundFiredRef.current = true;
    if (!match?.result || match.result === "draw") playTick();
    else if (match.result === (match.viewerIsPlayer1 ? "player1" : "player2")) {
      playVictory();
    } else playDefeat();
  }, [isFinished, showResult, match?.result, match?.viewerIsPlayer1]);

  // Win → confetti + seat flash, once the newest log entry shows the
  // opponent (or us) at zero lives.
  useEffect(() => {
    if (!isFinished || !match?.result || match.result === "draw") return;
    const iWon = match.result === (match.viewerIsPlayer1 ? "player1" : "player2");
    triggerSeatFlash(iWon ? "you" : "opp");
    if (iWon) triggerWinConfetti();
  }, [isFinished, match?.result, match?.viewerIsPlayer1, triggerSeatFlash, triggerWinConfetti]);

  const doClaim = useCallback(
    async (tileNumber) => {
      if (!matchId) return;
      if (tileNumber !== Number(match?.liveTile)) return;
      if (claimingRef.current) return;
      const deadline = match?.liveDeadline
        ? new Date(match.liveDeadline).getTime()
        : 0;
      const grace = Number(match?.tapGraceMs) || 0;
      if (deadline && Date.now() + clockOffset > deadline + grace) return;

      claimingRef.current = true;
      setClaiming(true);
      try {
        const res = await fetch(`/api/keno-pvp/match/${matchId}/catch`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ tile: tileNumber }),
        });
        const json = await res.json();
        if (!json.success) {
          const reason = json.error || "";
          if (TAP_MISS_REASONS.has(reason)) {
            setTapMiss({ text: missTextFor(reason) });
            if (tapMissTimerRef.current) clearTimeout(tapMissTimerRef.current);
            tapMissTimerRef.current = setTimeout(() => setTapMiss(null), 1100);
            playBuzz();
          }
          // Reconcile either way: a rejected tap usually means the tile
          // already moved on.
          void fetchStatus();
          return;
        }
        playGoodReveal();
        posthog?.capture("keno_pvp_claimed", {
          match_id: matchId,
          tile: tileNumber,
          reaction_ms: json.data?.claim?.reactionMs,
        });
        // Pull the freshly lit tile immediately rather than waiting for
        // the next poll.
        void fetchStatus();
        socket?.emit("room_event", {
          roomId: kenoPvpMatchRoom(matchId),
          event: KENO_PVP_MATCH_UPDATED,
        });
        if (match?.isAi) {
          void fetch(`/api/keno-pvp/match/${matchId}/ai-turn`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({}),
          }).catch(() => {});
        }
      } catch {
        // Network failure — silent; the poll reconciles.
      } finally {
        claimingRef.current = false;
        setClaiming(false);
      }
    },
    [matchId, match?.liveTile, match?.liveDeadline, match?.tapGraceMs, match?.isAi, clockOffset, fetchStatus, posthog, socket],
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

  // Emote wiring must be called on EVERY render (rules of hooks), so it
  // lives ABOVE the loading/match early returns below.
  const { incomingEmote, myEmote, sendEmote } = useGameEmotes({
    socket,
    roomId: matchId ? `keno:emote:${matchId}` : null,
    eventName: "keno:emote",
    selfId: match ? (match.viewerIsPlayer1 ? "player1" : "player2") : null,
  });

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
  const myLives = match.viewerIsPlayer1 ? match.p1Lives : match.p2Lives;
  const oppLives = match.viewerIsPlayer1 ? match.p2Lives : match.p1Lives;
  const myTiles = match.viewerIsPlayer1 ? match.p1Tiles : match.p2Tiles;
  const oppTiles = match.viewerIsPlayer1 ? match.p2Tiles : match.p1Tiles;

  const p1Name = match.players?.p1?.displayName || match.player1Id?.slice(0, 6) || "P1";
  const p2Name = match.isAi
    ? "GRYND AI"
    : match.players?.p2?.displayName || match.player2Id?.slice(0, 6) || "P2";
  const myName = me === "player1" ? p1Name : p2Name;
  const oppName = me === "player1" ? p2Name : p1Name;

  // Seat identity — the server already enriches `players` with the
  // official Grynd icon key + equipped name color per seat (keyed p1/p2);
  // the AI seat stays null and falls back to the GRYND AI label.
  const mySeatSummary = match.viewerIsPlayer1
    ? match.players?.p1 ?? null
    : match.players?.p2 ?? null;
  const oppSeatSummary = match.viewerIsPlayer1
    ? match.players?.p2 ?? null
    : match.players?.p1 ?? null;
  const myNameColor = mySeatSummary?.nameColor || null;
  const oppNameColor = oppSeatSummary?.nameColor || null;
  const myNameEffect =
    cosmeticEffectClass(mySeatSummary?.profileFrame?.usernameEffect?.visual) || "";
  const oppNameEffect =
    cosmeticEffectClass(oppSeatSummary?.profileFrame?.usernameEffect?.visual) || "";

  const statusLine = liveStatusText({
    isLive,
    hasLiveTile: liveTile != null,
    remainingMs,
    viewerCanClaim: match.viewerCanClaim,
  });

  // ── Scoreboard: lives + tiles claimed, per seat ────────────────────
  const seatCard = (side) => {
    const isMe = side === "you";
    const lives = isMe ? myLives : oppLives;
    const tiles = isMe ? myTiles : oppTiles;
    const name = isMe ? myName : oppName;
    const summary = isMe ? mySeatSummary : oppSeatSummary;
    const nameColor = isMe ? myNameColor : oppNameColor;
    const nameEffect = isMe ? myNameEffect : oppNameEffect;
    const flashing = flashSeat === (isMe ? "you" : "opp");
    return (
      <div
        className={
          "relative flex-1 rounded-xl border px-3 py-2 transition-colors " +
          (isMe
            ? "border-[#00ffa6]/40 bg-[#00ffa6]/5"
            : "border-[#FFD700]/40 bg-[#FFD700]/5") +
          (flashing ? " ring-2 ring-white/70" : "")
        }
      >
        <div className="flex items-center gap-2">
          <FrameAvatar
            frame={summary?.profileFrame || null}
            iconKey={summary?.iconKey || null}
            name={name}
            size="h-7 w-7"
          />
          <div className="min-w-0 flex-1">
            <div
              className={`truncate text-xs font-bold ${nameEffect}`}
              style={nameColor ? { color: nameColor } : undefined}
            >
              {name}
              {isMe ? " (you)" : ""}
            </div>
            <div className="mt-0.5 flex items-center gap-2">
              <LivesPips lives={lives} tone={isMe ? "cyan" : "opp"} />
              <span className="text-[10px] font-semibold text-white/50">
                {lives} {lives === 1 ? "life" : "lives"} · {tiles} claimed
              </span>
            </div>
          </div>
          <EmoteBubble emote={isMe ? myEmote : incomingEmote} />
        </div>
      </div>
    );
  };

  const livesNode = (
    <div className="mb-3 flex items-stretch gap-2">
      {seatCard("you")}
      {seatCard("opp")}
    </div>
  );

  // ── The live-tile clock ────────────────────────────────────────────
  const windowNode = (
    <div
      className={
        "relative overflow-hidden rounded-2xl border p-3 text-center shadow-[0_0_25px_rgba(0,229,255,0.15)] sm:p-5 " +
        (liveTile == null
          ? "border-[#00e5ff]/35 bg-[#050d1f]/80"
          : remainingSec <= 0.5
            ? "border-red-400/60 bg-[#1a0505]/80"
            : "border-[#00e5ff]/35 bg-[#050d1f]/80")
      }
      role="status"
      aria-live="polite"
    >
      {liveTile == null ? (
        <>
          <p className="text-sm font-bold text-white/70">
            {isLive ? "Lighting the next tile…" : statusLine || "Waiting…"}
          </p>
          <p className="mt-1 text-[11px] text-white/40">
            Window next tile: {windowMs / 1000}s
          </p>
        </>
      ) : (
        <>
          <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-white/50">
            {remainingSec <= 0 ? "Window closed" : "Tap the lit tile"}
          </p>
          <p className="mt-1 text-4xl font-black tabular-nums text-[#00e5ff] sm:text-5xl">
            {Math.max(0, remainingSec).toFixed(1)}s
          </p>
          <p className="mt-1 text-xs font-semibold text-white/60">
            Tile{" "}
            <span className="font-black text-white">{liveTile}</span> · window{" "}
            {windowMs / 1000}s · claim it before {oppName} does
          </p>
          {/* Window bar — a pure data read-out (no animation), so it stays
              readable with motion reduced. */}
          <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-white/10">
            <div
              className={
                "h-full rounded-full transition-[width] duration-100 ease-linear " +
                (remainingSec <= 0.5 ? "bg-red-400" : "bg-[#00e5ff]")
              }
              style={{ width: `${Math.max(0, Math.min(1, remainingRatio)) * 100}%` }}
            />
          </div>
        </>
      )}
      <div className="mt-2 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-[10px] text-white/40">
        <span>
          Lives {myLives}–{oppLives}
        </span>
        <span>·</span>
        <span>
          {match.claimedTotal} claimed · window tightens {MIN_WINDOW_MS / 1000}s →
        </span>
        {claiming && <span className="text-[#7cefff]">· sending…</span>}
      </div>
      <div className="mt-2 flex justify-center">
        <EmotePicker
          compact
          hideBubbles
          incomingEmote={incomingEmote}
          myEmote={myEmote}
          onSend={(emote) => sendEmote(emote)}
        />
      </div>
      <AnimatePresence>
        {tapMiss && (
          <motion.div
            key={tapMiss.text}
            {...withReducedMotion(shouldReduceMotion, {
              initial: { opacity: 0, scale: 0.7 },
              animate: { opacity: 1, scale: 1 },
              exit: { opacity: 0, scale: 0.7 },
            })}
            className="pointer-events-none absolute inset-x-0 bottom-2 z-40 flex justify-center"
          >
            <span className="rounded-full border border-red-400/60 bg-red-500/20 px-5 py-1.5 text-sm font-black tracking-widest text-red-200">
              {tapMiss.text}
            </span>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );

  // ── The resolved-tile feed ─────────────────────────────────────────
  const feedTone = {
    mine: "border-[#00ffa6]/50 bg-[#00ffa6]/10 text-[#7cefff]",
    opp: "border-[#FFD700]/50 bg-[#FFD700]/10 text-[#FFD700]",
    miss: "border-red-400/50 bg-red-500/10 text-red-200",
  };
  const feedNode = (
    <AnimatePresence>
      {feedEntry && (
        <motion.div
          key={`${feedEntry.text}-${match.tileLog.length}`}
          {...withReducedMotion(shouldReduceMotion, {
            initial: { opacity: 0, y: -8 },
            animate: { opacity: 1, y: 0 },
            exit: { opacity: 0, y: -8 },
          })}
          className={`mb-3 rounded-lg border px-3 py-2 text-center text-sm font-semibold ${
            feedTone[feedEntry.tone] || feedTone.miss
          }`}
        >
          {feedEntry.text}
        </motion.div>
      )}
    </AnimatePresence>
  );

  // Last few resolved tiles, newest first — the match feed under the
  // board (public log, so it survives the 2.2s banner).
  const recentFeed = (Array.isArray(match.tileLog) ? match.tileLog : [])
    .slice(-5)
    .reverse();

  // ── Board ──────────────────────────────────────────────────────────
  const boardNode = (
    <div className="relative rounded-2xl border border-[#00e5ff]/35 bg-[#050d1f]/70 p-3 sm:p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-bold uppercase tracking-wider text-[#7cefff]">
          <span className="inline-flex items-center gap-1.5">
            <PoolBallIcon size={16} className="text-[#00e5ff]" /> Keno Board 1–
            {KENO_POOL_SIZE}
          </span>
        </h3>
        <span className="text-xs text-white/50">
          <span className="text-[#00ffa6]">{myTiles} you</span> ·{" "}
          <span className="text-[#FFD700]">{oppTiles} {oppName}</span> ·{" "}
          {match.claimedTotal} / {KENO_POOL_SIZE} tiles claimed
        </span>
      </div>
      <div className="mx-auto grid w-full max-w-[30rem] grid-cols-8 gap-1 sm:gap-2">
        {KENO_NUMBERS.map((num) => (
          <KenoTile
            key={num}
            num={num}
            isLive={isLive && liveTile === num && remainingMs > 0}
            liveRemainingRatio={remainingRatio}
            claimedByMe={myClaimedSet.has(num)}
            claimedByOpp={oppClaimedSet.has(num)}
            missed={missedSet.has(num)}
            frozen={!match.viewerCanClaim || isFinished}
            onClaim={doClaim}
          />
        ))}
      </div>
      <p className="mt-3 text-[11px] text-white/40">
        <span className="text-[#00ffa6]">Green</span> = you claimed it ·{" "}
        <span className="text-[#FFD700]">gold</span> = {oppName} claimed it ·{" "}
        <span className="text-red-300">red</span> = nobody claimed it (both lost a
        life). Untouched tiles all look the same — the board never reveals what
        is coming.
      </p>
      {recentFeed.length > 0 && (
        <div className="mt-3 space-y-1 border-t border-[#00e5ff]/20 pt-3">
          <h4 className="text-[11px] font-bold uppercase tracking-wider text-white/40">
            Feed
          </h4>
          {recentFeed.map((entry) => {
            const line = feedLineFor(
              entry,
              Boolean(match.viewerIsPlayer1),
              oppName,
            );
            const tone =
              line?.tone === "mine"
                ? "text-[#00ffa6]"
                : line?.tone === "opp"
                  ? "text-[#FFD700]"
                  : "text-red-300";
            return (
              <p key={`${entry.index}-${entry.tile}`} className="text-[11px]">
                <span className="text-white/40">#{entry.index + 1}</span>{" "}
                <span className={tone}>{line?.text}</span>
                <span className="text-white/30"> · {(entry.windowMs || 0) / 1000}s window</span>
              </p>
            );
          })}
        </div>
      )}
    </div>
  );

  const leaveNode =
    !isFinished && !isCancelled && !isWaiting ? (
      <div className="flex justify-center">
        <button
          onClick={goToLobby}
          disabled={leaving}
          className="px-4 py-2 rounded-lg text-xs text-white/50 border border-white/15 hover:text-white hover:border-white/40 transition disabled:opacity-50"
        >
          {leaving ? "Leaving…" : "Leave match (forfeit)"}
        </button>
      </div>
    ) : null;

  // ── Creator Mode arrangement ───────────────────────────────────────
  // The SAME game content composes the normal page and the creator frames
  // (portrait phone-style + landscape/square rail). Layout only.
  const creatorGameNode = (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 px-3 pb-1.5 pt-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <PoolBallIcon size={18} className="shrink-0 text-[#00e5ff]" />
            <h1 className="truncate text-base font-extrabold tracking-tight text-cyan-100">
              Keno Survival Duel
            </h1>
            <button
              onClick={() => setShowRules(true)}
              className="h-6 w-6 shrink-0 rounded-full border border-[#00e5ff]/40 bg-[#0b224f]/70 text-xs font-bold text-[#7cefff] transition hover:border-[#00e5ff]/80 hover:text-white"
              aria-label="How to play"
              title="How to play"
            >
              ?
            </button>
          </div>
          <span className="shrink-0 rounded-full border border-white/15 px-2 py-0.5 text-[10px] font-bold text-white/60">
            first to {STARTING_LIVES} tiles lost
          </span>
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 py-2">
        {livesNode}
        <div className="w-full">{windowNode}</div>
        <div className="mt-3 w-full">{boardNode}</div>
        {leaveNode && <div className="mt-3 w-full">{leaveNode}</div>}
      </div>
    </div>
  );

  const portraitContent = (
    <CreatorModeShell className="bg-gradient-to-br from-[#001933] to-[#000d1a]">
      <ShellMain className="overflow-hidden">
        <CreatorPhoneFrame>{creatorGameNode}</CreatorPhoneFrame>
      </ShellMain>
    </CreatorModeShell>
  );

  const landscapeContent = (
    <CreatorModeShell className="bg-gradient-to-br from-[#001933] to-[#000d1a]">
      <ShellMain className="overflow-hidden">
        <CreatorPhoneFrame>{creatorGameNode}</CreatorPhoneFrame>
      </ShellMain>
    </CreatorModeShell>
  );

  return (
    <>
      {/* Unified full-screen waiting takeover (matchmaking → countdown) */}
      {(isWaiting || isReady) && (
        <MatchWaiting
          state={isReady ? "ready" : "waiting"}
          gameName="Keno PvP"
          subtitle={
            isReady
              ? `${p1Name} vs ${p2Name} — the first tile lights in a moment.`
              : `Your ${Number(match.stakeAmount).toLocaleString()} stake is escrowed. Someone with the same stake will join shortly.`
          }
          seats={
            isWaiting
              ? [
                  { label: "You", name: "You", occupied: true },
                  { label: "Opponent", occupied: false },
                ]
              : []
          }
          onCancel={isWaiting && match.viewerCanCancel ? cancelMatch : null}
          cancelLabel="Cancel Lobby"
        />
      )}

      <div className="min-h-screen overflow-x-clip bg-gradient-to-br from-[#001933] to-[#000d1a] px-3 pb-24 pt-20 text-white sm:px-6 md:pb-8">
        <NavigationBar currentPath="/casino" />

        {/* Only the actual match content is recorded — the matchmaking
            takeover and nav sit outside the shared CreatorModeHost
            recording viewport. */}
        <CreatorModeHost
          autoStart={isLive}
          autoStop={isFinished || isCancelled}
          gameLabel="keno"
          backToLobbyHref="/casino/keno"
        >
          <CreatorView
            normal={
              <>
                <div className="mx-auto mt-4 max-w-5xl">
                  {/* Header */}
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-3 sm:mb-4">
                    <div>
                      <div className="flex items-center gap-2">
                        <h1 className="text-2xl sm:text-3xl font-extrabold tracking-wide text-transparent bg-clip-text bg-gradient-to-r from-[#00e5ff] to-[#00ffa6]">
                          <span className="inline-flex items-center gap-2">
                            <PoolBallIcon size={28} className="text-[#00e5ff]" /> Keno
                            Survival Duel
                          </span>
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
                        {STARTING_LIVES} lives each · stake{" "}
                        {match.stakeAmount.toLocaleString()}{" "}
                        <IconCoins size={12} className="inline" /> · survive the
                        shrinking window
                      </p>
                    </div>
                  </div>

                  <AnimatePresence>
                    {showRules && <RulesModal onClose={() => setShowRules(false)} />}
                  </AnimatePresence>

                  {error && (
                    <div className="mb-3 rounded-lg border border-red-400/40 bg-red-900/30 px-3 py-2 text-sm text-red-200">
                      {error}
                    </div>
                  )}

                  {(isLive || isFinished) && (
                    <div className="space-y-3 sm:space-y-4">
                      {livesNode}
                      {feedNode}
                      {windowNode}
                      {boardNode}
                    </div>
                  )}

                  {isCancelled && (
                    <div className="rounded-2xl border border-red-400/30 bg-[#0b224f]/85 p-10 text-center">
                      <p className="mb-3">
                        <IconCircleX size={36} className="text-red-400" />
                      </p>
                      <h2 className="text-xl font-bold mb-2">Match cancelled</h2>
                      <p className="text-sm text-white/60 mb-6">
                        Your stake was refunded.
                      </p>
                      <button
                        onClick={goToLobby}
                        className="px-5 py-2 rounded-lg bg-[#00e5ff] text-[#001933] font-bold"
                      >
                        Back to Keno Lobby
                      </button>
                    </div>
                  )}

                  {leaveNode && <div className="mt-4">{leaveNode}</div>}

                  <Footer />
                </div>
              </>
            }
            portrait={portraitContent}
            landscape={landscapeContent}
          />

          {/* ── FINISHED: end-of-match result screen ──────────────────
              Mounted INSIDE CreatorModeHost as a sibling of <CreatorView>,
              so the WIN/LOSS panel is part of the recording. showResult
              lands 1.2s after the finish, inside the auto-stop grace
              period, so it is captured. */}
          {isFinished && showResult && (
            <ResultModal
              match={match}
              me={me}
              myName={myName}
              oppName={oppName}
              oppSeatSummary={oppSeatSummary}
              myLives={myLives}
              oppLives={oppLives}
              myTiles={myTiles}
              oppTiles={oppTiles}
              onLobby={goToLobby}
            />
          )}
        </CreatorModeHost>
      </div>
    </>
  );
}

// ── Rules modal ──────────────────────────────────────────────────────

function RulesModal({ onClose }) {
  const shouldReduceMotion = useReducedMotion();
  return (
    <motion.div
      {...withReducedMotion(shouldReduceMotion, {
        initial: { opacity: 0 },
        animate: { opacity: 1 },
        exit: { opacity: 0 },
      })}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <motion.div
        {...withReducedMotion(shouldReduceMotion, {
          initial: { opacity: 0, scale: 0.92, y: 12 },
          animate: { opacity: 1, scale: 1, y: 0 },
          exit: { opacity: 0, scale: 0.95, y: 8 },
          transition: { type: "spring", stiffness: 300, damping: 26 },
        })}
        className="w-full max-w-md rounded-2xl border border-[#00e5ff]/40 bg-[#050d1f]/95 p-6 shadow-[0_0_40px_rgba(0,229,255,0.25)] max-h-[92vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-xl font-extrabold text-[#7cefff]">
            <IconNotebook size={20} /> How to play
          </h2>
          <button
            onClick={onClose}
            className="h-8 w-8 rounded-lg border border-white/15 text-white/60 transition hover:border-white/40 hover:text-white"
            aria-label="Close rules"
          >
            <IconX size={16} />
          </button>
        </div>

        <h3 className="mb-2 flex items-center gap-1.5 text-sm font-bold uppercase tracking-wider text-[#00ffa6]">
          <IconTarget size={15} /> Win the race for the lit tile
        </h3>
        <ul className="mb-5 space-y-1.5 text-xs text-white/70">
          <li>
            Both players start with{" "}
            <span className="font-semibold text-white">{STARTING_LIVES} lives</span>.
          </li>
          <li>
            <span className="font-semibold text-[#00e5ff]">One tile</span> from the 1–40
            board is lit for both players at the same time.
          </li>
          <li>
            Tap it first →{" "}
            <span className="font-semibold text-[#00ffa6]">you claim the tile</span> and
            your opponent loses a life.
          </li>
          <li>
            Nobody taps in time →{" "}
            <span className="font-semibold text-red-300">both players lose a life</span>.
          </li>
          <li>
            Lose all {STARTING_LIVES} lives → you are eliminated and the opponent takes the
            pot. If a both-miss takes both players' last life, the match is a draw
            (stake refunded).
          </li>
        </ul>

        <h3 className="mb-2 flex items-center gap-1.5 text-sm font-bold uppercase tracking-wider text-[#00ffa6]">
          <IconClock size={15} /> The window keeps tightening
        </h3>
        <ul className="mb-5 space-y-1.5 text-xs text-white/70">
          <li>
            The first tile gives you{" "}
            <span className="font-semibold text-white">{START_WINDOW_MS / 1000}s</span> to
            react.
          </li>
          <li>
            Every tile either player claims shaves{" "}
            <span className="font-semibold text-white">100ms</span> off the next window.
          </li>
          <li>
            The window bottoms out at{" "}
            <span className="font-semibold text-white">{MIN_WINDOW_MS / 1000}s</span> — the
            endgame is pure reaction time.
          </li>
          <li>A tile nobody claims does not speed the match up.</li>
          <li className="flex items-center gap-1">
            <IconVolume size={12} /> A soft tick sounds the moment each tile lights up.
          </li>
        </ul>

        <h3 className="mb-2 flex items-center gap-1.5 text-sm font-bold uppercase tracking-wider text-[#00ffa6]">
          <IconTrophy size={15} /> The pot
        </h3>
        <ul className="space-y-1.5 text-xs text-white/70">
          <li>Winner takes their stake + 90% of the loser's stake (house keeps 10%).</li>
          <li className="flex items-start gap-1">
            <IconHeartHandshake size={12} className="mt-0.5 shrink-0" />
            <span>A draw (both eliminated on the same tile) refunds both stakes in full.</span>
          </li>
          <li>
            Leaving a live match forfeits it — the opponent takes the pot.
          </li>
        </ul>
      </motion.div>
    </motion.div>
  );
}

// ── Result screen — shared CreatorResultOverlay ──────────────────────
// End-of-match adapter: maps the real match result / payout / survival
// fields onto the shared result screen. No invented values.
function ResultModal({
  match,
  me,
  myName,
  oppName,
  oppSeatSummary,
  myLives,
  oppLives,
  myTiles,
  oppTiles,
  onLobby,
}) {
  const router = useRouter();
  const result = match.result;
  const iWon = result === me;
  const drew = result === "draw";

  const net = drew
    ? -(Number(match.houseFee) || 0) / 2
    : iWon
      ? Number(match.prizePaid) - Number(match.stakeAmount)
      : -Number(match.stakeAmount);

  const winnerName = iWon ? myName : oppName;
  const outcome = drew ? "draw" : iWon ? "win" : "loss";
  const stakeTokens = Number(match.stakeAmount) || 0;
  const log = Array.isArray(match.tileLog) ? match.tileLog : [];

  const seats = match.viewerIsPlayer1
    ? { p1: myName, p2: oppName }
    : { p1: oppName, p2: myName };

  return (
    <CreatorResultOverlay
      open
      outcome={outcome}
      headline={drew ? "Both eliminated — stake refunded" : `${myTiles} – ${oppTiles} tiles claimed`}
      subline={
        outcome === "loss"
          ? `${winnerName} took the pot.`
          : drew
            ? undefined
            : "You survived the duel."
      }
      gameName="Keno Duel"
      opponent={
        match.isAi
          ? { name: "GRYND AI", isAi: true }
          : { name: oppName, iconKey: oppSeatSummary?.iconKey || null }
      }
      tokenDelta={net}
      summary={[
        { label: "Lives left", value: `${myLives} – ${oppLives}` },
        { label: "Tiles claimed", value: `${myTiles} – ${oppTiles}` },
      ]}
      details={[
        ...(match.id != null ? [{ label: "Match ID", value: String(match.id) }] : []),
        { label: "Stake", value: `${stakeTokens.toLocaleString()} tokens` },
        ...(iWon
          ? [
              {
                label: "Payout",
                value: `${(Number(match.prizePaid) || 0).toLocaleString()} tokens`,
              },
            ]
          : []),
        { label: "Winner", value: drew ? "Draw" : winnerName },
      ]}
      detailsContent={
        <div className="mt-2 space-y-1.5">
          {log.length === 0 && (
            <p className="text-xs text-white/40 text-center">
              No tiles were resolved (forfeit).
            </p>
          )}
          {log.map((entry) => {
            const who =
              entry.outcome === "both_miss"
                ? "nobody"
                : seats[entry.outcome] || entry.outcome;
            return (
              <p key={`${entry.index}-${entry.tile}`} className="text-[11px] text-white/60">
                <span className="text-white/35">#{entry.index + 1}</span> tile{" "}
                <span className="font-bold text-white/80">{entry.tile}</span> →{" "}
                <span
                  className={
                    entry.outcome === "both_miss"
                      ? "text-red-300"
                      : entry.outcome === me
                        ? "text-[#00ffa6]"
                        : "text-[#FFD700]"
                  }
                >
                  {who}
                </span>{" "}
                · {(entry.windowMs || 0) / 1000}s window
              </p>
            );
          })}
        </div>
      }
      playAgain={{ label: "RUN IT BACK", onClick: onLobby }}
      onReturnToLobby={() => router.push("/casino")}
    />
  );
}
