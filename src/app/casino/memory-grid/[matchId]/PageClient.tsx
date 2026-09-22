"use client";

// src/app/casino/memory-grid/[matchId]/page.tsx
//
// MATCH view for the Memory Grid system — pure pattern recall, no
// symbols / questions / multiple-choice.
//
// A match is EXACTLY 5 rounds. Each round deals an N×N grid (3×3,
// 4×4, 4×4, 5×5, 5×5) with a fixed number of active (lit) tiles and
// a memorize window. Every round has exactly three phases, played by
// BOTH players SIMULTANEOUSLY (a competitive race — no turns) on the
// SAME server-generated pattern:
//   PHASE 1 — MEMORIZE: the active tiles display the casino logo
//   (the existing logo1.png asset) for the round's memorize duration
//   (2.5–4s) — both players study the same grid at the same time —
//   then the pattern hides: the logos vanish from every tile at the
//   server deadline and the grids go dark.
//   PHASE 2 — RECONSTRUCT: each player gets their OWN blank grid
//   (same challenge, completely independent picks). Tapping a tile
//   flips it to reveal the casino logo and selects it; tapping it
//   again flips it back and deselects — freely editable until you
//   press Submit. A player can submit as soon as they finish: their
//   grid freezes and they see "Waiting for opponent" while the other
//   player finishes. Correctness is NEVER shown mid-reconstruction:
//   every selected tile looks identical, so you only learn your
//   accuracy after submission.
//   PHASE 3 — RESULT: once BOTH players have submitted (or been AFK
//   auto-locked) the round resolves and the match enters a brief
//   result phase. Both players see the correct pattern, both
//   reconstructions, each player's accuracy / time / score, and the
//   updated cumulative score — then the server auto-advances to the
//   next round's memorize phase (or to the finished screen after
//   round 5, where the higher TOTAL cumulative round score wins the
//   match; exactly equal totals → draw refund). Nobody can modify
//   their previous reconstruction: submissions lock the seat and the
//   result phase accepts no further POSTs.
//
// Skill mechanic: the pattern is server-generated and revealed to
// BOTH players during the memorize phase (during the round-result
// phase, and again post-match); it is never visible during
// reconstruction.
//
// Realtime: status polling (the source of truth for forward progress,
// including the server's phase auto-advance / AFK auto-lock) + a
// socket.io `lobby:updated` push on the per-match room for near-instant
// opponent updates. The server has no background scheduler — a phase
// opens when a request arrives — so the route also broadcasts the phase
// it just opened and this client re-fetches on each phase deadline;
// that keeps both players' discovery of a new MEMORIZE window within
// milliseconds of each other instead of up to a poll tick apart (which
// used to burn the entire 2.5–4s preview for whoever polled second).
// A 100 ms tick drives the phase countdown and hides the pattern at the
// server deadline, compared against the server's clock (see
// `clockOffsetMs`) rather than raw `Date.now()`.

import { use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { usePostHog } from "posthog-js/react";
import { useUser } from "@clerk/nextjs";
import { motion } from "framer-motion";
import Image from "next/image";
import NavigationBar from "../../../../components/navigation-bar";
// Shared Creator Mode foundation (admin-only): mounts the viewport
// recorder + overlay and auto-starts when the match actually begins
// (leaves the waiting room), auto-stops when it finishes or the user
// quits. The waiting/matchmaking takeover and Footer stay OUTSIDE so
// nothing is recorded until real gameplay starts.
import CreatorModeHost from "../../../../components/creator-mode/CreatorModeHost";
import {
  CreatorView,
  CreatorModeShell,
  ShellMain,
  CreatorPhoneFrame,
} from "../../../../components/creator-mode/CreatorModeLayout";
import FrameAvatar from "../../../../components/FrameAvatar";
import MatchWaiting from "../../../../components/lobby/MatchWaiting";
import PvpResultScreen from "../../../../components/result/PvpResultScreen";
import EmotePicker, { EmoteBubble } from "../../../../components/game/EmotePicker";
import useGameEmotes from "../../../../hooks/useGameEmotes";
import Footer from "../../../../components/Footer";
import RoundMarkers from "../../../../components/casino/RoundMarkers";
// The casino's existing logo asset (GRYND smiley) — reused as the
// memorize-phase "active tile" marker so the grid reads as the
// casino's own visual language (no emojis / unrelated symbols).
import LogoSmiley from "../../../../images/logo1.png";
import { useSocket } from "../../../../context/SocketProvider";
import {
  MEMORY_GRID_MATCH_UPDATED,
  memoryGridMatchRoom,
} from "../../../../lib/memory-grid/rooms";
import { MATCH_STATUS } from "../../../../lib/memory-grid/constants";
import {
  playVictory,
  playDefeat,
  playTick,
  playGoodReveal,
} from "../../../../lib/gameAudio";
import {
  IconAlertTriangle,
  IconClock,
  IconSparkles,
} from "@tabler/icons-react";

// ── Match payload types (from /api/memory-grid/match/[id]) ───────────
type RoundConfigData = {
  gridSize: number;
  activeCount: number;
  memorizeMs: number;
};

type PatternData = {
  size: number;
  total: number;
  active: number[];
};

// Player heads (displayName + avatar) populated server-side by
// enrichMatchesWithUsers — same shape as plinko-pvp / keno-pvp so
// the match view renders real player cards.
type PlayerHead = {
  id: string;
  displayName: string;
  iconKey: string | null;
  profileFrame?: unknown;
  missing?: boolean;
};

type MatchData = {
  id: number;
  player1Id: string | null;
  player2Id: string | null;
  isAi?: boolean;
  stakeAmount: number;
  status: string;
  phase: string | null;
  roundNumber: number;
  roundsPerMatch: number;
  roundConfig: RoundConfigData;
  viewerIsPlayer1: boolean;
  // Who has locked in their reconstruction this round.
  p1Submitted: boolean;
  p2Submitted: boolean;
  // Authoritative absolute server timestamps (same for BOTH players —
  // the countdown anchors to phaseDeadline, so client clocks never
  // affect the official timing).
  phaseStartedAt: string | null;
  phaseDeadline: string | null;
  // The server's clock at the moment the payload was built — the match
  // view corrects for client clock skew with it.
  serverNow?: string | null;
  p1Score: number;
  p2Score: number;
  p1Total: number;
  p2Total: number;
  p1RoundScore: number;
  p2RoundScore: number;
  players: { p1: PlayerHead | null; p2: PlayerHead | null } | null;
  pattern: PatternData | null;
  result: string | null;
  winnerId: string | null;
  prizePaid: number;
  houseFee: number;
  // Present only on a finished DRAW: the amount both players get
  // back (95% of the stake — 5% per-side rake on the tiebreak tie).
  refundEach: number | null;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string | null;
};

type RoundHistory = {
  roundNumber: number;
  p1RoundScore: number;
  p2RoundScore: number;
  roundWinner: string | null;
};

// A completed-round snapshot served during the round-result phase (and
// on the finished screen): the correct pattern + both players'
// reconstruction submissions (picks, score, accuracy, completion
// time) so each client can render the result screen entirely from
// server data.
type FlipEntry = {
  seat: "player1" | "player2";
  picks: number[];
  score: number;
  accuracyPct: number;
  completionTimeMs: number;
  autoLocked?: boolean;
};

type RoundSnapshot = RoundHistory & {
  boardSnapshot: PatternData | null;
  flips: FlipEntry[];
};

// ── Inline SVG icons (kept in-file so this page doesn't pull in
// other game-specific icon sets) ─────────────────────────────────────

function CoinIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <ellipse cx="12" cy="6" rx="8" ry="2.5" />
      <path d="M4 6 V18 a8 2.5 0 0 0 16 0 V6" />
      <ellipse cx="12" cy="18" rx="8" ry="2.5" />
    </svg>
  );
}

const PHASE = {
  MEMORIZE: "memorize",
  RECONSTRUCT: "reconstruct",
  RESULT: "result",
} as const;

// Speed-tier labels for the submission feedback (mirrors the server's
// SPEED_TIER_MULTIPLIERS in src/lib/memory-grid/constants.js).
const SPEED_TIER_LABEL: Record<string, string> = {
  very_fast: "Very fast",
  fast: "Fast",
  average: "Average",
  slow: "Slow",
  very_slow: "Very slow",
};

// One grid of the round-result screen (correct pattern / your
// reconstruction / opponent reconstruction). Rendered from the
// server's round snapshot — the client never computes accuracy or
// score. Tile states:
//   pattern highlight — the answer key's active (lit) tiles in amber
//   picks highlight   — correct picks in emerald, wrong picks in red,
//                       unpicked tiles dark
function RoundResultGrid({
  title,
  pattern,
  picks,
  highlight,
  flip,
  badge,
}: {
  title: string;
  pattern: PatternData | null;
  picks: number[];
  highlight: "pattern" | "picks";
  flip?: FlipEntry | null;
  badge: string;
}) {
  const size = pattern?.size ?? 3;
  const total = size * size;
  const active = new Set(pattern?.active ?? []);
  const picked = new Set(picks);
  const pickedCount = picks.length;

  return (
    <div className="mb-5 rounded-2xl border border-white/10 bg-black/30 p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-black uppercase tracking-widest text-white/70">
          {title}
        </h3>
        <span className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-white/40">
          {badge}
        </span>
      </div>
      <div
        className="mx-auto grid max-w-[260px] gap-1.5"
        style={{ gridTemplateColumns: `repeat(${size}, minmax(0, 1fr))` }}
      >
        {Array.from({ length: total }, (_, i) => {
          const isActive = active.has(i);
          const isPicked = picked.has(i);
          let cls = "border-white/10 bg-[#08142f]";
          if (highlight === "pattern") {
            if (isActive) {
              cls =
                "border-amber-400/80 bg-gradient-to-br from-amber-400/80 to-yellow-500/70 shadow-[0_0_12px_rgba(251,191,36,0.45)]";
            }
          } else {
            // Reconstruction: correct picks emerald, wrong picks red.
            if (isPicked) {
              cls = isActive
                ? "border-emerald-400/70 bg-gradient-to-br from-emerald-500/60 to-teal-600/40 shadow-[0_0_10px_rgba(52,211,153,0.4)]"
                : "border-red-400/70 bg-gradient-to-br from-red-500/60 to-rose-600/40 shadow-[0_0_10px_rgba(248,113,113,0.4)]";
            } else if (isActive) {
              // Missed active tile — faint amber outline (no face).
              cls = "border-amber-500/40 bg-[#0b1a33]";
            }
          }
          return (
            <div
              key={i}
              className={`relative aspect-square overflow-hidden rounded-lg border ${cls}`}
            >
              {(highlight === "pattern" ? isActive : isPicked) && (
                <Image
                  src={LogoSmiley}
                  alt=""
                  width={36}
                  height={36}
                  className="absolute inset-0 h-full w-full object-contain p-1 drop-shadow-[0_0_6px_rgba(251,191,36,0.8)]"
                />
              )}
            </div>
          );
        })}
      </div>
      {flip && (
        <div className="mt-3 grid grid-cols-3 gap-2 text-center text-xs">
          <div className="rounded-lg border border-white/10 bg-white/5 px-2 py-1.5">
            <p className="text-[10px] font-bold uppercase tracking-widest text-white/40">
              Accuracy
            </p>
            <p className="mt-0.5 font-black text-amber-300">
              {Number(flip.accuracyPct ?? 0).toFixed(1)}%
            </p>
          </div>
          <div className="rounded-lg border border-white/10 bg-white/5 px-2 py-1.5">
            <p className="text-[10px] font-bold uppercase tracking-widest text-white/40">
              Time
            </p>
            <p className="mt-0.5 font-black text-amber-300">
              {(Number(flip.completionTimeMs ?? 0) / 1000).toFixed(2)}s
            </p>
          </div>
          <div className="rounded-lg border border-white/10 bg-white/5 px-2 py-1.5">
            <p className="text-[10px] font-bold uppercase tracking-widest text-white/40">
              Score
            </p>
            <p className="mt-0.5 font-black text-amber-300">
              {Number(flip.score ?? 0)}/100
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

export default function MemoryGridMatchPage({
  params,
}: {
  params: Promise<{ matchId: string }>;
}) {
  const router = useRouter();
  const posthog = usePostHog();
  const { user } = useUser();
  const { socket } = useSocket();
  const resolved = use(params);
  const matchId = Number(resolved?.matchId);
  const { incomingEmote, myEmote, sendEmote } = useGameEmotes({
    socket,
    roomId: Number.isFinite(matchId) ? `memory:emote:${matchId}` : null,
    eventName: "memory:emote",
    selfId: user?.id,
  });

  const [match, setMatch] = useState<MatchData | null>(null);
  const [rounds, setRounds] = useState<RoundSnapshot[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Reconstruct-phase picks (tile indices the viewer has tapped).
  const [selected, setSelected] = useState<number[]>([]);
  const [submitting, setSubmitting] = useState(false);
  // Submitter-only feedback: the server's authoritative round
  // assessment (final score = accuracy × speed + full-grid accuracy
  // breakdown — the client never computes or supplies its own
  // accuracy/score).
  const [feedback, setFeedback] = useState<{
    score: number;
    total: number;
    correct: number;
    incorrect: number;
    accuracyPct: number;
    speedTier: string;
    roundNumber: number;
  } | null>(null);
  // Finished-state result overlay visibility — the shared
  // PvpResultScreen (UX plan P3-3) can be dismissed to reveal the
  // final board underneath.
  const [showResult, setShowResult] = useState(true);
  // Waiting state: cancelling an open lobby (creator only).
  const [cancelling, setCancelling] = useState(false);
  const [forfeiting, setForfeiting] = useState(false);
  // Local clock: drives the phase countdown AND hides the pattern
  // at the server's absolute deadline (never wait for the poll).
  const [nowMs, setNowMs] = useState(() => Date.now());
  // Offset from the server's clock (ms), refreshed from every status
  // payload. Every phase boundary is an absolute SERVER timestamp, so a
  // device clock running even a few seconds ahead used to expire the
  // memorize deadline the instant the payload landed: the client flipped
  // straight to reconstruct, the pattern (the yellow tiles) never
  // rendered, and a tap was answered with "Submission rejected" because
  // the server was still in memorize. Comparing server time to server
  // time removes that whole class of failure.
  const [clockOffsetMs, setClockOffsetMs] = useState(0);
  const aiTriggerRef = useRef("");

  const lastRoundRef = useRef("");
  const feedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Status fetch (the source of truth) ────────────────────────────
  const fetchStatus = useCallback(async () => {
    if (!Number.isFinite(matchId)) return;
    try {
      const res = await fetch(`/api/memory-grid/match/${matchId}`, {
        cache: "no-store",
      });
      const data = await res.json();
      if (!data?.success) {
        setError(data?.error || "Failed to load match");
        return;
      }
      const next = data.data.match as MatchData;
      setMatch(next);
      setError(null);
      // Track the server's clock. The measured offset is biased low by
      // the response's transit time, which only ever leaves the client
      // counting down slightly longer than the server — the safe
      // direction (the server stays authoritative on every deadline).
      // The threshold keeps sub-frame jitter from re-rendering.
      const serverNowMs = next?.serverNow
        ? new Date(next.serverNow).getTime()
        : Number.NaN;
      if (Number.isFinite(serverNowMs)) {
        const offset = serverNowMs - Date.now();
        setClockOffsetMs((prev) =>
          Math.abs(offset - prev) >= 250 ? offset : prev,
        );
      }
      if (Array.isArray(data.data.rounds)) {
        setRounds(data.data.rounds as RoundSnapshot[]);
      }
    } catch {
      // Silent — polling retries on the next tick.
    } finally {
      setLoading(false);
    }
  }, [matchId]);

  useEffect(() => {
    if (!Number.isFinite(matchId)) {
      setError("Invalid match link.");
      setLoading(false);
      return;
    }
    fetchStatus();
    // Socket room (MEMORY_GRID_MATCH_UPDATED) pushes opponent updates
    // instantly; this HTTP poll is a reconnect/consistency safety net.
    // Phase pacing comes from server timelines + the local 100ms clock,
    // never from the poll rate. The server broadcasts every phase
    // transition it discovers (see the /status route) and the client also
    // re-fetches at each phase deadline (below), so 5s keeps match-time
    // DB reads minimal without leaving a 2.5s memorize window
    // undiscovered.
    const interval = setInterval(fetchStatus, 5000);
    return () => clearInterval(interval);
  }, [matchId, fetchStatus]);

  // ── Socket: join the per-match room for instant updates ───────────
  useEffect(() => {
    if (!socket || !Number.isFinite(matchId)) return;
    socket.emit("join_room", { roomId: memoryGridMatchRoom(matchId) });
    const refresh = () => fetchStatus();
    socket.on(MEMORY_GRID_MATCH_UPDATED, refresh);
    return () => {
      socket.emit("leave_room", { roomId: memoryGridMatchRoom(matchId) });
      socket.off(MEMORY_GRID_MATCH_UPDATED, refresh);
    };
  }, [socket, matchId, fetchStatus]);

  // ── Local phase clock (100 ms tick) ───────────────────────────────
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 100);
    return () => clearInterval(id);
  }, []);

  // ── Derived phase state (SIMULTANEOUS play — no turns) ───────────
  const isFinished = match?.status === MATCH_STATUS.FINISHED;
  const isCancelled = match?.status === MATCH_STATUS.CANCELLED;
  const playing = match?.status === MATCH_STATUS.ACTIVE;

  // The round-6 TIEBREAK: dealt when the 5 regular rounds end on
  // exactly equal TOTAL cumulative scores. Detected by the round
  // number exceeding the best-of-5 ceiling.
  const isTiebreak =
    (match?.roundNumber ?? 1) > (match?.roundsPerMatch ?? 5);

  const gridSize = match?.roundConfig?.gridSize ?? 3;
  const activeCount = match?.roundConfig?.activeCount ?? 3;
  const totalTiles = gridSize * gridSize;

  const deadlineMs = match?.phaseDeadline
    ? new Date(match.phaseDeadline).getTime()
    : null;
  // Server-domain "now" — the local tick plus the measured clock
  // offset, so the deadline comparison below happens in one clock.
  const serverNowMs = nowMs + clockOffsetMs;
  const msLeft =
    deadlineMs !== null ? Math.max(0, deadlineMs - serverNowMs) : null;

  // The client-side phase. The pattern hides at the server's
  // absolute deadline; from the viewer's perspective reconstruct
  // starts AT that deadline even if the server hasn't advanced yet
  // (it accepts submissions either way — see the reconstruct route).
  // Without this, a viewer would be frozen for up to a poll tick
  // after the pattern hides.
  const serverPhase = match?.phase ?? null;
  const phase =
    msLeft !== null && msLeft === 0 && serverPhase === PHASE.MEMORIZE
      ? PHASE.RECONSTRUCT
      : serverPhase;
  const isMemorize = phase === PHASE.MEMORIZE;
  const isReconstruct = phase === PHASE.RECONSTRUCT;
  // Round-result phase: both players submitted; the server shows the
  // completed-round snapshot for RESULT_WINDOW_MS before advancing.
  const isRoundResult =
    playing && serverPhase === PHASE.RESULT && rounds.length > 0;

  // The just-completed round snapshot (the LAST element — rounds are
  // appended in completion order). Its roundNumber is the round the
  // result screen is about, and the cumulative score display uses the
  // match's already-awarded totals.
  const roundResult = isRoundResult
    ? rounds[rounds.length - 1]
    : null;

  // Whose reconstruction is whose, oriented to the viewer.
  const viewerFlip = roundResult?.flips?.find(
    (f) => f.seat === (match?.viewerIsPlayer1 ? "player1" : "player2"),
  );
  const opponentFlip = roundResult?.flips?.find(
    (f) => f.seat === (match?.viewerIsPlayer1 ? "player2" : "player1"),
  );

  // The pattern is revealed to BOTH players during the round's
  // memorize phase AND while the server's absolute deadline hasn't
  // passed (the client hides it at the deadline without waiting for
  // the poll).
  const patternVisible =
    playing && isMemorize && Boolean(match?.pattern) && msLeft !== null && msLeft > 0;

  // ── Re-fetch at each phase deadline ───────────────────────────────
  // A phase only opens when a status request arrives (the server has no
  // background scheduler), so whichever player polls first gets the new
  // phase while the other waits for their own next tick. For MEMORIZE
  // that is worse than a delay: the pattern is withheld as soon as the
  // round moves on to reconstruct, so a poll landing after the 2.5–4s
  // window finds nothing left to preview. Landing a request exactly on
  // the deadline puts both players' discovery of the next phase within
  // milliseconds of each other — with or without a live socket.
  useEffect(() => {
    if (
      match?.status !== MATCH_STATUS.ACTIVE &&
      match?.status !== MATCH_STATUS.READY
    ) {
      return;
    }
    if (deadlineMs === null || !Number.isFinite(deadlineMs)) return;
    // Already elapsed and a poll has since confirmed it — arming here
    // would spin; the regular tick picks the transition up instead.
    const delay = deadlineMs - (Date.now() + clockOffsetMs);
    if (delay <= 0) return;
    const id = setTimeout(fetchStatus, delay + 150);
    return () => clearTimeout(id);
  }, [deadlineMs, clockOffsetMs, fetchStatus, match?.status]);

  // Per-seat submission state — drives the frozen-grid "Waiting for
  // opponent" flow.
  const viewerSubmitted = match?.viewerIsPlayer1
    ? Boolean(match?.p1Submitted)
    : Boolean(match?.p2Submitted);
  const opponentSubmitted = match?.viewerIsPlayer1
    ? Boolean(match?.p2Submitted)
    : Boolean(match?.p1Submitted);

  const activeSet = useMemo(() => {
    if (!match?.pattern?.active) return new Set<number>();
    return new Set(match.pattern.active);
  }, [match?.pattern]);

  const viewerWon =
    isFinished && !!match?.winnerId && match.winnerId === user?.id;
  const viewerLost =
    isFinished && !!match?.winnerId && match.winnerId !== user?.id;
  const isDraw = isFinished && !match?.winnerId;

  // ── Audio ─────────────────────────────────────────────────────────
  // Match-result fanfare/defeat plays once when the finished screen
  // first surfaces from the status poll.
  const finishSoundRef = useRef(false);
  useEffect(() => {
    if (!isFinished) {
      finishSoundRef.current = false;
      return;
    }
    if (finishSoundRef.current) return;
    finishSoundRef.current = true;
    if (viewerWon) playVictory();
    else if (viewerLost) playDefeat();
    else if (isDraw) playTick();
  }, [isFinished, viewerWon, viewerLost, isDraw]);

  // Phase cue — soft chime when the pattern hides and reconstruct
  // begins (fires once per transition as `phase` flips).
  const lastPhaseRef = useRef(null);
  useEffect(() => {
    if (phase === lastPhaseRef.current) return;
    const prev = lastPhaseRef.current;
    lastPhaseRef.current = phase;
    if (prev === PHASE.MEMORIZE && phase === PHASE.RECONSTRUCT) {
      playGoodReveal();
    } else if (prev === PHASE.RESULT && phase === PHASE.MEMORIZE) {
      // New round's memorize phase — a subtle tick.
      playTick();
    }
  }, [phase]);

  // ── Round / state-change reset ────────────────────────────────────
  // When the server advances to a new round (or the match finishes),
  // clear the viewer's local reconstruct picks + submission
  // feedback. Keyed on roundNumber + finished so an AFK auto-lock
  // that ends the round also resets the frozen grid.
  const roundKey = `${match?.roundNumber ?? 1}:${isFinished ? "f" : "p"}`;
  useEffect(() => {
    if (!match) return;
    if (roundKey !== lastRoundRef.current) {
      if (lastRoundRef.current !== "") {
        setSelected([]);
        setFeedback(null);
      }
      lastRoundRef.current = roundKey;
    }
  }, [roundKey, match]);

  // ── Forfeit the match (surrender) ─────────────────────────────────
  const handleForfeit = useCallback(async () => {
    if (forfeiting) return;
    if (
      !window.confirm(
        "Forfeit this match? Your stake is forfeited and your opponent wins.",
      )
    )
      return;
    setForfeiting(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/memory-grid/match/${matchId}/forfeit`,
        { method: "POST", credentials: "include" },
      );
      const data = await res.json();
      if (!res.ok || !data?.success) {
        setError(data?.error || "Forfeit failed");
        return;
      }
      posthog?.capture("memory_grid_forfeited", { match_id: matchId });
      socket?.emit("room_event", {
        roomId: memoryGridMatchRoom(matchId),
        event: MEMORY_GRID_MATCH_UPDATED,
      });
      await fetchStatus();
    } catch {
      setError("Network error while forfeiting");
    } finally {
      setForfeiting(false);
    }
  }, [matchId, socket, posthog, forfeiting, fetchStatus]);

  // ── Reconstruct submission ────────────────────────────────────────
  const submitPicks = useCallback(
    async (picks: number[]) => {
      if (submitting) return;
      setSubmitting(true);
      try {
        const res = await fetch(
          `/api/memory-grid/match/${matchId}/reconstruct`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({ picks }),
          },
        );
        const data = await res.json();
        if (!data?.success) {
          setError(data?.error || "Submission rejected");
          setSelected([]);
          return;
        }
        posthog?.capture("memory_grid_reconstruct", {
          match_id: matchId,
          round: data?.data?.roundNumber,
          score: data?.data?.score,
          accuracy: data?.data?.accuracyPct,
        });
        // Sync instantly from the response, then reconcile with a
        // status poll.
        if (data?.data?.match) setMatch(data.data.match);
        setFeedback({
          score: Number(data.data.score) || 0,
          total: Number(data.data.total) || 0,
          correct: Number(data.data.correct) || 0,
          incorrect: Number(data.data.incorrect) || 0,
          accuracyPct: Number(data.data.accuracyPct) || 0,
          speedTier: data.data.speedTier ?? "very_slow",
          roundNumber: Number(data.data.roundNumber) || 1,
        });
        if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current);
        feedbackTimerRef.current = setTimeout(() => {
          setFeedback(null);
        }, 4000);
        // Keep `selected` — the submitted grid stays frozen (logo
        // tiles visible, not clickable) while waiting for the
        // opponent. The next round's reset clears it.
        fetchStatus();
      } catch {
        setError("Failed to submit. Retrying…");
        setSelected([]);
      } finally {
        setSubmitting(false);
      }
    },
    [matchId, posthog, submitting, fetchStatus],
  );

  // Trigger the server AI after the human's reconstruction starts.
  // The server remains authoritative and the endpoint is idempotent;
  // polling is still the recovery path if this request fails.
  useEffect(() => {
    if (!match?.isAi || !playing || !isReconstruct || viewerSubmitted) return;
    const key = `${match.id}:${match.roundNumber}`;
    if (aiTriggerRef.current === key) return;
    aiTriggerRef.current = key;
    fetch(`/api/memory-grid/match/${match.id}/ai-turn`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    }).then(() => fetchStatus()).catch(() => {});
  }, [fetchStatus, isReconstruct, match?.id, match?.isAi, match?.roundNumber, playing, viewerSubmitted]);

  // ── Tile interaction ──────────────────────────────────────────────
  // The viewer can tap only while reconstructing AND hasn't already
  // submitted (their seat locks the moment they submit — grid frozen,
  // no further changes).
  const canPick =
    playing && isReconstruct && !viewerSubmitted && !submitting && !isFinished;

  // Toggle-only selection: tapping a blank tile flips it to reveal
  // the logo and selects it; tapping it again flips it back and
  // deselects. The player can freely modify their reconstruction
  // until they press Submit. There is NO pick limit — a player may
  // select any number of tiles (even the whole grid); over-selection
  // is penalised by the server's full-grid scoring (false positives
  // count as errors), so spamming every tile can't score high. NO
  // correctness feedback is shown — every selected tile looks
  // identical regardless of whether it matches the pattern.
  const handleTileClick = useCallback(
    (tileIndex: number) => {
      if (!canPick) return;
      if (selected.includes(tileIndex)) {
        // Flip back + unselect.
        setSelected((prev) => prev.filter((i) => i !== tileIndex));
        return;
      }
      // Flip to the logo + select.
      setSelected((prev) => [...prev, tileIndex]);
    },
    [canPick, selected],
  );

  // Viewer-oriented cumulative scores. `myTotal`/`oppTotal` are the
  // headline numbers — CUMULATIVE round-score points (each round
  // scores /100, so a 5-round match totals up to 500), accumulated
  // server-side. `myScore`/`oppScore` remain the rounds-won tallies
  // (tiebreak + finished-screen breakdown).
  //
  // IMPORTANT: every value here is null-safe — `match` starts as
  // `null` on the first render (before the status poll resolves), and
  // these constants run BEFORE the `loading` guard below, so a raw
  // `match.p2Score`-style read would throw a client-side TypeError and
  // blank the page with the "Application error" overlay. Guard on
  // `match` itself and only dereference when it exists.
  const viewerIsPlayer1 = match?.viewerIsPlayer1 === true;
  const myScore = match ? (viewerIsPlayer1 ? match.p1Score : match.p2Score) : 0;
  const oppScore = match ? (viewerIsPlayer1 ? match.p2Score : match.p1Score) : 0;
  const myTotal = match ? (viewerIsPlayer1 ? match.p1Total : match.p2Total) : 0;
  const oppTotal = match ? (viewerIsPlayer1 ? match.p2Total : match.p1Total) : 0;

  // Player cards: the viewer is always "You"; the opponent renders
  // their real display name + avatar when available (server-enriched,
  // like the other PvP skill games), falling back to "Player 1/2".
  // Also null-safe for the same first-render reason as the scores
  // above.
  const oppHead = match ? (viewerIsPlayer1 ? match.players?.p2 : match.players?.p1) : null;
  const oppName = match?.isAi
    ? "GRYND AI"
    : oppHead?.displayName || (match ? (viewerIsPlayer1 ? "Player 2" : "Player 1") : "Player 2");
  const oppIconKey = oppHead?.iconKey || null;
  const oppProfileFrame = oppHead?.profileFrame || null;

  // My own seat head — same server enrichment, so the viewer's real
  // username renders next to the opponent's (falls back to "You").
  const myHead = match
    ? viewerIsPlayer1
      ? match.players?.p1
      : match.players?.p2
    : null;
  const myName = myHead?.displayName || "You";

  // Wager shown on the occupied ready-takeover seat chips (formatted like
  // the in-game stake chip; AI matches wagered nothing).
  const stakeLabel = match?.isAi
    ? "Free play"
    : Number(match?.stakeAmount ?? 0).toLocaleString();

  // Waiting state: the creator can cancel their own open lobby, and
  // anyone can copy the invite link (mirrors lane-runner's waiting
  // card). `match` is read from a ref inside cancelLobby to keep the
  // callback stable across polls.
  const matchRef = useRef<MatchData | null>(null);
  useEffect(() => {
    matchRef.current = match;
  }, [match]);
  const viewerCanCancel =
    match?.status === MATCH_STATUS.WAITING && Boolean(match?.player1Id === user?.id);
  const cancelLobby = useCallback(async () => {
    const current = matchRef.current;
    if (!current) return;
    setCancelling(true);
    try {
      const res = await fetch(`/api/memory-grid/match/${current.id}/cancel`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setError(data?.error || "Unable to cancel lobby");
      } else {
        fetchStatus();
      }
    } catch {
      setError("Failed to cancel lobby");
    } finally {
      setCancelling(false);
    }
  }, [fetchStatus]);
  const copyInvite = useCallback(async () => {
    try {
      await navigator.clipboard?.writeText(window.location.href);
      setError(null);
    } catch {
      // Clipboard unavailable — ignore.
    }
  }, []);

  // ── Round-result screen (rendered when phase='result') ───────────
  // Shown to BOTH players for the server's RESULT_WINDOW_MS after the
  // round resolves: the correct pattern, each player's reconstruction
  // (correct picks green, wrong picks red), their accuracy / time /
  // score, and the updated cumulative rounds-won tally. The server
  // auto-advances to the next round (or finished) when the window
  // elapses — the client just renders; the deadline countdown comes
  // from the same authoritative `phaseDeadline` as the other phases.
  //
  // IMPORTANT (creator-mode continuous recording): the round-result
  // view is rendered INSIDE the same <CreatorModeHost> as gameplay —
  // NOT as a separate early-return full page. A separate return would
  // unmount the host (and the viewport recorder) every round, so each
  // round would be captured as its own clip (the "stops recording every
  // round" bug). Folding it in keeps ONE continuous capture across all
  // rounds until the creator clicks Stop & save / Download.
  const mgRoundResultBody = (
    <>
      {/* Round header */}
      <div className="mb-5 text-center">
        <h1 className="flex items-center justify-center gap-3 text-3xl font-extrabold tracking-wide text-transparent bg-clip-text bg-gradient-to-r from-amber-300 via-amber-400 to-yellow-500 drop-shadow-[0_0_18px_rgba(251,191,36,0.5)]">
          Memory Grid
        </h1>
        <div className="mt-2 inline-flex items-center gap-1.5 rounded-full border border-emerald-400/40 bg-emerald-950/40 px-4 py-1.5 text-sm font-black text-emerald-300">
          {roundResult?.roundNumber > (match?.roundsPerMatch ?? 5)
            ? `TIEBREAK ROUND ${roundResult?.roundNumber}`
            : `ROUND ${roundResult?.roundNumber}/${match?.roundsPerMatch ?? 5}`}
        </div>
        <p className="mt-2 text-sm text-white/60">
          {msLeft !== null && msLeft > 0
            ? (roundResult?.roundNumber ?? 0) >= (match?.roundsPerMatch ?? 5)
              ? `Final results in ${Math.ceil(msLeft / 1000)}s…`
              : `Next round in ${Math.ceil(msLeft / 1000)}s…`
            : "…"}
        </p>
      </div>

      {/* Cumulative score — headline numbers are the cumulative
          round-score points (same compact PvP scoreboard style
          as the in-match board), rounds-won as the secondary line. */}
      <div className="mb-5 grid grid-cols-2 gap-3">
        <div className="rounded-2xl border border-amber-400/70 bg-amber-500/10 p-3 text-center">
          <p className="relative text-[10px] font-bold uppercase tracking-widest text-white/50">
            {myName}
            <EmoteBubble emote={myEmote} side="mine" />
          </p>
          <p className="mt-0.5 text-3xl font-black tabular-nums text-yellow-300">
            {myTotal ?? 0}
          </p>
          <p className="text-[10px] font-bold uppercase tracking-widest text-white/40">pts</p>
          <p className="mt-0.5 text-[10px] text-white/40">
            {myScore ?? 0} round win{myScore === 1 ? "" : "s"}
          </p>
        </div>
        <div className="rounded-2xl border border-cyan-400/70 bg-cyan-500/10 p-3 text-center">
          <p className="relative flex items-center justify-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-white/50">
            <FrameAvatar
              frame={oppProfileFrame}
              iconKey={oppIconKey}
              name={oppName}
              size="h-3.5 w-3.5"
            />
            {oppName}
            <EmoteBubble emote={incomingEmote} />
          </p>
          <p className="mt-0.5 text-3xl font-black tabular-nums text-cyan-300">
            {oppTotal ?? 0}
          </p>
          <p className="text-[10px] font-bold uppercase tracking-widest text-white/40">pts</p>
          <p className="mt-0.5 text-[10px] text-white/40">
            {oppScore ?? 0} round win{oppScore === 1 ? "" : "s"}
          </p>
        </div>
      </div>

      {/* Correct pattern */}
      <RoundResultGrid
        title="Correct Pattern"
        pattern={roundResult?.boardSnapshot ?? null}
        picks={roundResult?.boardSnapshot?.active ?? []}
        highlight="pattern"
        badge="answer key"
      />

      {/* Your reconstruction */}
      <RoundResultGrid
        title="Your Reconstruction"
        pattern={roundResult?.boardSnapshot ?? null}
        picks={viewerFlip?.picks ?? []}
        highlight="picks"
        flip={viewerFlip}
        badge="you"
      />

      {/* Opponent reconstruction */}
      <RoundResultGrid
        title={`${oppName}: Reconstruction`}
        pattern={roundResult?.boardSnapshot ?? null}
        picks={opponentFlip?.picks ?? []}
        highlight="picks"
        flip={opponentFlip}
        badge="opponent"
      />
    </>
  );

  const mgRoundResultNode = (
    <div className="mx-auto mt-4 max-w-3xl sm:mt-8">{mgRoundResultBody}</div>
  );

  // Round-result view — same phone-frame treatment as the gameplay
  // shell (compact header + the three grids scrolling at real phone
  // width) so the recorded clip stays consistent.
  const mgRoundResultShell = (
    <CreatorModeShell className="bg-gradient-to-br from-[#0a0118] to-[#061b3d]">
      <ShellMain className="overflow-hidden">
        <CreatorPhoneFrame>
          <div className="shrink-0 px-3 pb-1 pt-2">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="text-[10px] font-black uppercase tracking-widest text-amber-300">Memory Grid</p>
                <p className="text-xs text-white/70">Round {roundResult?.roundNumber}/{match?.roundsPerMatch ?? 5} · Result</p>
              </div>
              <span className="shrink-0 rounded-full bg-black/30 px-2 py-0.5 text-xs font-bold text-amber-200">
                {msLeft !== null && msLeft > 0 ? `Next in ${Math.ceil(msLeft / 1000)}s` : "…"}
              </span>
            </div>
            <div className="mt-1.5 grid grid-cols-2 gap-1.5 text-center text-[11px]">
              <span className="relative block truncate rounded-md bg-black/30 px-2 py-1 font-bold text-yellow-300">
                {myName} · {myTotal ?? 0} pts
              </span>
              <span className="relative block truncate rounded-md bg-black/30 px-2 py-1 font-bold text-cyan-300">
                {oppName} · {oppTotal ?? 0} pts
              </span>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
          <RoundResultGrid
            title="Correct Pattern"
            pattern={roundResult?.boardSnapshot ?? null}
            picks={roundResult?.boardSnapshot?.active ?? []}
            highlight="pattern"
            badge="answer key"
          />
          <RoundResultGrid
            title="Your Reconstruction"
            pattern={roundResult?.boardSnapshot ?? null}
            picks={viewerFlip?.picks ?? []}
            highlight="picks"
            flip={viewerFlip}
            badge="you"
          />
          <RoundResultGrid
            title={`${oppName}: Reconstruction`}
            pattern={roundResult?.boardSnapshot ?? null}
            picks={opponentFlip?.picks ?? []}
            highlight="picks"
            flip={opponentFlip}
            badge="opponent"
          />
          </div>
        </CreatorPhoneFrame>
      </ShellMain>
    </CreatorModeShell>
  );


  if (loading && !match) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#030817] text-white">
        <div className="text-center">
          <div className="mx-auto mb-4 h-10 w-10 animate-spin rounded-full border-2 border-amber-400 border-t-transparent" />
          <p className="text-sm text-white/60">Loading match…</p>
        </div>
      </div>
    );
  }

  if (error && !match) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#030817] px-4 text-white">
        <div className="max-w-md rounded-2xl border border-red-500/30 bg-red-950/20 p-6 text-center">
          <IconAlertTriangle className="mx-auto mb-3 h-8 w-8 text-red-400" />
          <h2 className="mb-2 text-lg font-bold">Match unavailable</h2>
          <p className="mb-4 text-sm text-white/70">{error}</p>
          <button
            onClick={() => router.push("/casino/memory-grid")}
            className="rounded-xl bg-amber-500 px-4 py-2 text-sm font-bold text-black hover:bg-amber-400"
          >
            Back to Lobby
          </button>
        </div>
      </div>
    );
  }

  const countdownLabel =
    msLeft !== null
      ? isMemorize
        ? `${(msLeft / 1000).toFixed(1)}s`
        : `${Math.ceil(msLeft / 1000)}s`
      : null;

  // ── Creator Mode board (rendered inside the phone-frame shell) ────
  // Creator mode uses the full phone width inside the frame so the
  // recorded board looks big/large, but we still cap width slightly
  // so the controls underneath stay visible (not pushed off-screen).
  // Buttons themselves are not resized.
  // Both board mounts (this one, used by the creator phone frame, and the
  // normal-view copy further down) carry `memory-board-frame`, the shared
  // desktop sizing hook defined in globals.css. The grid is square, so
  // capping its width caps its height — that is what keeps the whole grid,
  // plus the controls under it, on one screen.
  const mgBoardNode = (
    <div
      className="memory-board-frame mx-auto grid w-full max-w-lg gap-3"
      style={{
        gridTemplateColumns: `repeat(${gridSize}, minmax(0, 1fr))`,
      }}
    >
      {Array.from({ length: totalTiles }, (_, tileIndex) => {
        const isActive = activeSet.has(tileIndex);
        const isSelected = selected.includes(tileIndex);
        const faceUp = patternVisible && isActive;
        const revealActive = isFinished && activeSet.has(tileIndex);
        const clickable = canPick && !isFinished;
        const showFace = faceUp || isSelected || revealActive;
        return (
          <motion.button
            key={tileIndex}
            type="button"
            onClick={() => handleTileClick(tileIndex)}
            disabled={!clickable}
            whileTap={clickable ? { scale: 0.92 } : undefined}
            aria-label={`Tile ${tileIndex + 1}`}
            className={`relative aspect-square select-none overflow-hidden rounded-xl border transition-colors [transform-style:preserve-3d] [perspective:600px] ${
              revealActive
                ? "border-emerald-400/60 bg-gradient-to-br from-emerald-500/50 to-teal-600/40 shadow-[0_0_16px_rgba(52,211,153,0.45)]"
                : faceUp
                  ? "border-amber-400/80 bg-gradient-to-br from-amber-400/80 to-yellow-500/70 shadow-[0_0_18px_rgba(251,191,36,0.6)]"
                  : isSelected
                    ? "border-cyan-300 bg-cyan-500/25"
                    : clickable
                      ? "cursor-pointer border-cyan-600/40 bg-[#08142f] hover:border-cyan-400/70 hover:bg-[#0b224f]"
                      : "border-white/10 bg-[#08142f]"
            }`}
          >
            <motion.div
              className="absolute inset-0 [transform-style:preserve-3d]"
              initial={false}
              animate={{ rotateY: showFace ? 180 : 0 }}
              transition={{ duration: 0.18, ease: "easeOut" }}
            >
              <span className="absolute inset-0 [backface-visibility:hidden]" />
              <span className="absolute inset-0 flex items-center justify-center p-1 sm:p-2 [backface-visibility:hidden] [transform:rotateY(180deg)]">
                <Image
                  src={LogoSmiley}
                  alt=""
                  width={64}
                  height={64}
                  className="h-full w-full object-contain drop-shadow-[0_0_8px_rgba(251,191,36,0.9)]"
                />
              </span>
            </motion.div>
          </motion.button>
        );
      })}
    </div>
  );
  const mgControlsNode = (
    <div className="mx-auto flex w-full max-w-lg flex-wrap items-center justify-between gap-3">
      <button
        onClick={handleForfeit}
        disabled={forfeiting}
        className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs font-bold text-red-300 transition hover:bg-red-500/25 disabled:opacity-40"
      >
        {forfeiting ? "Forfeiting…" : "Forfeit"}
      </button>
      <button
        onClick={() => setSelected([])}
        disabled={selected.length === 0 || submitting}
        className="rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-xs font-bold text-white/70 transition hover:bg-white/10 disabled:opacity-40"
      >
        Clear
      </button>
      <span className="text-center text-xs text-white/45">
        {selected.length} selected. Tap again to remove · {activeCount}{" "}
        lit this round
      </span>
      <button
        onClick={() => submitPicks(selected)}
        disabled={submitting}
        className="rounded-xl border-b-4 border-amber-700 bg-amber-500 px-6 py-2 text-sm font-extrabold text-black transition hover:brightness-110 disabled:opacity-50"
      >
        {submitting ? "Submitting…" : "Submit"}
      </button>
      <div className="flex justify-center">
        <EmotePicker compact hideBubbles incomingEmote={incomingEmote} myEmote={myEmote} onSend={(emote) => sendEmote(emote)} />
      </div>
    </div>
  );
  // ── Creator Mode phone-frame shell (same treatment as Blackjack) ──
  // The game renders inside <CreatorPhoneFrame>: a real 390px phone
  // layout `zoom`ed up to fill the recording frame, so the recorded
  // clip looks exactly like the mobile app — a big full-width board
  // with the controls directly underneath, instead of a shrunken
  // desktop layout with the buttons detached in a bottom strip.
  const mgShell = (
    <CreatorModeShell className="bg-gradient-to-br from-[#0a0118] to-[#061b3d]">
      <ShellMain className="overflow-hidden">
        <CreatorPhoneFrame>
          {/* Compact header — round, grid size, timer, both scores. */}
          <div className="shrink-0 px-3 pb-1 pt-2">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="text-[10px] font-black uppercase tracking-widest text-amber-300">Memory Grid</p>
                <p className="text-xs text-white/70">
                  Round {match?.roundNumber ?? 1}/{match?.roundsPerMatch ?? 5} · {gridSize}×{gridSize}
                </p>
              </div>
              <span className="shrink-0 rounded-full bg-black/30 px-2 py-0.5 text-xs font-bold text-amber-200">
                ⏱ {countdownLabel ?? "—"}
              </span>
            </div>
            <div className="mt-1.5 grid grid-cols-2 gap-1.5 text-center text-[11px]">
              <span className="relative block truncate rounded-md bg-black/30 px-2 py-1 font-bold text-yellow-300">
                {myName} · {myTotal ?? 0} pts
                <EmoteBubble emote={myEmote} side="mine" />
              </span>
              <span className="relative block truncate rounded-md bg-black/30 px-2 py-1 font-bold text-cyan-300">
                {oppName} · {oppTotal ?? 0} pts
                <EmoteBubble emote={incomingEmote} />
              </span>
            </div>
          </div>
          {/* Board fills the phone-width middle — same sizing as mobile. */}
          <div className="flex min-h-0 flex-1 items-center justify-center px-3 py-2">
            {mgBoardNode}
          </div>
          {/* Controls directly under the board — mobile touch targets,
              same mgControlsNode as the normal (non-creator) view. */}
          <div className="shrink-0 w-full px-3 pb-3">
            {canPick && mgControlsNode}
          </div>
        </CreatorPhoneFrame>
      </ShellMain>
    </CreatorModeShell>
  );

  // ── Result screen — shared PvpResultScreen (UX plan P3-3) ───────
  // Rendered as a fixed overlay when the match finishes (the final
  // board reveal stays underneath, reachable via "View Match
  // Results"). Every number comes from the real match row
  // (winnerId / p1Total–p2Total / prizePaid / houseFee / refundEach
  // / players / startedAt→endedAt) — nothing is invented. Winner /
  // payout logic is untouched; the old inline result panel + draw
  // popup are gone.
  function renderResult() {
    if (!match || !isFinished || !showResult) return null;

    const stake = Number(match.stakeAmount ?? 0);
    const prizePaid = Number(match.prizePaid ?? 0);
    const houseFee = Number(match.houseFee ?? 0);
    const refundEach = Number(match.refundEach ?? 0);
    const isAi = Boolean(match.isAi);

    // Stake is escrowed at matchmaking; at settle the winner is
    // credited `prizePaid` (= stake + 90% of the loser's stake). Net
    // token change from the viewer's pocket:
    //   win  → +prizePaid − stake = +0.9 × stake
    //   loss → −stake
    //   draw → +refundEach (95% of stake — 5% rake per side on the
    //          tiebreak tie)
    // AI practice matches never move tokens.
    const tokenDelta = isAi
      ? null
      : viewerWon
        ? prizePaid - stake
        : viewerLost
          ? -stake
          : refundEach;

    // Duration from the existing timestamps (omitted when unavailable).
    let durationSeconds: number | null = null;
    if (match.startedAt && match.endedAt) {
      const start = new Date(match.startedAt).getTime();
      const end = new Date(match.endedAt).getTime();
      if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
        durationSeconds = Math.round((end - start) / 1000);
      }
    }

    const outcome = isDraw ? "draw" : viewerWon ? "win" : "loss";
    const headline = viewerWon
      ? `You out-remembered ${oppName} ${myScore ?? 0}–${oppScore ?? 0} rounds`
      : viewerLost
        ? `${oppName} out-remembered you ${oppScore ?? 0}–${myScore ?? 0}`
        : "Evenly matched — the tiebreak couldn't split you";
    const subline = isAi
      ? "Free practice match — no tokens were staked."
      : viewerWon
        ? `Your ${stake.toFixed(2)} stake back plus ${(prizePaid - stake).toFixed(2)} in winnings.`
        : viewerLost
          ? `You lost your ${stake.toFixed(2)} stake. Platform fee: ${houseFee.toFixed(2)}.`
          : `Tiebreak tied. Both players refunded ${refundEach.toFixed(2)} (95%, 5% platform fee each).`;

    return (
      <PvpResultScreen
        open
        compact
        outcome={outcome}
        headline={headline}
        subline={subline}
        gameName="Memory Grid"
        opponent={{ name: oppName, iconKey: oppIconKey, profileFrame: oppProfileFrame, isAi }}
        tokenDelta={tokenDelta}
        durationSeconds={durationSeconds}
        summary={[
          {
            label: "Result",
            value: outcome === "win" ? "Win" : outcome === "loss" ? "Loss" : "Draw",
          },
          { label: "Score", value: `${myTotal ?? 0} – ${oppTotal ?? 0} pts` },
          { label: "Rounds won", value: `${myScore ?? 0} – ${oppScore ?? 0}` },
        ]}
        details={[
          { label: "Match ID", value: String(match.id) },
          ...(isAi
            ? []
            : [
                { label: "Stake", value: `${stake.toLocaleString()} tokens` },
                ...(viewerWon
                  ? [
                      { label: "Prize paid", value: `${prizePaid.toLocaleString()} tokens` },
                      { label: "Platform fee", value: `${houseFee.toLocaleString()} tokens` },
                    ]
                  : []),
              ]),
          { label: "Winner", value: isDraw ? "Draw" : viewerWon ? "You" : oppName },
        ]}
        detailsContent={
          rounds.length > 0 ? (
            <div className="mt-3">
              <p className="mb-2 text-[10px] font-bold uppercase tracking-widest text-white/40">
                Round scores
              </p>
              <div className="space-y-1">
                {rounds.map((r) => {
                  const youWonRound = match.viewerIsPlayer1
                    ? r.roundWinner === "player1"
                    : r.roundWinner === "player2";
                  const oppWonRound = match.viewerIsPlayer1
                    ? r.roundWinner === "player2"
                    : r.roundWinner === "player1";
                  return (
                    <div
                      key={r.roundNumber}
                      className="flex items-center justify-between"
                    >
                      <span className="text-white/50">Round {r.roundNumber}</span>
                      <span
                        className={
                          youWonRound
                            ? "font-bold text-emerald-300"
                            : oppWonRound
                              ? "font-bold text-red-300"
                              : "text-white/60"
                        }
                      >
                        {match.viewerIsPlayer1
                          ? `${r.p1RoundScore} – ${r.p2RoundScore}`
                          : `${r.p2RoundScore} – ${r.p1RoundScore}`}
                        {youWonRound ? " ✓" : oppWonRound ? " ✗" : " -"}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null
        }
        playAgain={{ label: "RUN IT BACK", onClick: () => router.push("/casino/memory-grid") }}
        onReturnToLobby={() => router.push("/casino")}
        onDismiss={() => setShowResult(false)}
        dismissLabel="View Match Results"
      />
    );
  }

  return (
    <>
      {/* Unified full-screen waiting takeover (matchmaking → countdown) */}
      {(match?.status === MATCH_STATUS.WAITING ||
        match?.status === MATCH_STATUS.READY) && (
        <MatchWaiting
          state={
            match.status === MATCH_STATUS.READY ? "ready" : "waiting"
          }
          gameName="Memory Grid"
          subtitle={
            match.status === MATCH_STATUS.READY
              ? "Get ready — memorize the pattern!"
              : "Your stake is escrowed. Share the invite link to play a friend of the same stake, or wait for matchmaking."
          }
          seats={[
            // Real username + wager on both seats once the opponent has
            // joined — the ready takeover flips their seat from open to
            // occupied (same treatment as the in-game cards).
            match.status === MATCH_STATUS.READY
              ? {
                  label: "You",
                  name: myName,
                  occupied: true,
                  wager: stakeLabel,
                }
              : { label: "You", name: myName, occupied: true },
            match.status === MATCH_STATUS.READY
              ? {
                  label: "Opponent",
                  name: oppName,
                  occupied: true,
                  wager: stakeLabel,
                }
              : { label: "Opponent", occupied: false },
          ]}
          onCancel={viewerCanCancel ? cancelLobby : null}
          cancelLabel="Cancel lobby"
          cancelling={cancelling}
          onCopy={copyInvite}
        />
      )}

      <div className="min-h-screen overflow-x-clip bg-gradient-to-b from-[#0a0118] to-[#061b3d] px-3 pb-24 pt-20 text-white sm:px-6 md:pb-8">
      <NavigationBar currentPath="/casino" />
      {/* Only the actual game content is recorded — the matchmaking
          takeover / NavBar above and the Footer + modals below sit
          outside the shared CreatorModeHost recording viewport.
          Recording auto-starts when the match leaves waiting and stops
          when it finishes/cancels. */}
      <CreatorModeHost
        autoStart={
          Boolean(match) &&
          match.status !== MATCH_STATUS.WAITING &&
          match.status !== MATCH_STATUS.FINISHED &&
          match.status !== MATCH_STATUS.CANCELLED
        }
        // Continuous recording: keep capturing through all rounds (and
        // past the match result) until the creator clicks "Stop & save"
        // — downloads are always manual. Only a CANCELLED match stops
        // the recording automatically.
        autoStop={match?.status === MATCH_STATUS.CANCELLED}
        gameLabel="memory-grid"
        backToLobbyHref="/casino/memory-grid"
      >
      <CreatorView
        normal={
          isRoundResult && roundResult ? (
            mgRoundResultNode
          ) : (
            <><div className="mx-auto mt-4 max-w-3xl sm:mt-8">
        {/* Header — game title (same amber gradient treatment as the
            other casino games) + a compact stake line + the round
            indicator (ROUND X/5). */}
        <div className="mb-5 text-center">
          <h1 className="flex items-center justify-center gap-3 text-3xl font-extrabold tracking-wide text-transparent bg-clip-text bg-gradient-to-r from-amber-300 via-amber-400 to-yellow-500 drop-shadow-[0_0_18px_rgba(251,191,36,0.5)]">
            Memory Grid
          </h1>
          <div className="mt-2 flex items-center justify-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-400/40 bg-amber-500/10 px-3 py-1 text-xs font-black uppercase tracking-widest text-amber-300">
              {isTiebreak ? (
                <>
                  Tiebreak{" "}
                  <span className="text-yellow-300">
                    {match?.roundNumber ?? 6}
                  </span>
                </>
              ) : (
                <>
                  Round{" "}
                  <span className="text-yellow-300">
                    {match?.roundNumber ?? 1}
                  </span>
                  /{match?.roundsPerMatch ?? 5}
                </>
              )}
            </span>
            {!isFinished && (
              <span className="inline-flex items-center gap-1 rounded-full border border-white/10 bg-black/30 px-3 py-1 text-xs font-bold text-white/60">
                {gridSize}×{gridSize} · stake{" "}
                <span className="inline-flex items-center gap-0.5 font-semibold text-yellow-300">
                  {Number(match?.stakeAmount ?? 0).toLocaleString()}
                  <CoinIcon className="h-3 w-3" />
                </span>
              </span>
            )}
          </div>
        </div>

        {/* Round tracker — blue = rounds you won, red = rounds the
            opponent won (shared best-of marker, brawl-stars style). */}
        <div className="mb-3 flex justify-center rounded-2xl border border-cyan-700/30 bg-black/30 px-4 py-3">
          <RoundMarkers
            total={match?.roundsPerMatch ?? 5}
            myWins={myScore ?? 0}
            oppWins={oppScore ?? 0}
            myLabel="You"
            oppLabel={oppName}
          />
        </div>

        {/* Scoreboard — cumulative points (each round scores /100),
            compact style consistent with the other skill-based PvP
            scoreboards (lane-rush-duel / keno-pvp): YOU | OPPONENT
            with the running totals as the headline numbers and the
            rounds-won tally as the secondary line. */}
        <div className="mb-4 grid grid-cols-2 gap-3">
          <div
            className={`rounded-2xl border p-3 text-center transition ${
              playing && !viewerSubmitted
                ? "border-amber-400/70 bg-amber-500/10 shadow-[0_0_20px_rgba(251,191,36,0.15)]"
                : "border-white/10 bg-black/30"
            }`}
          >
            <p className="text-[10px] font-bold uppercase tracking-widest text-white/50">
              <span className="relative inline-block">
                {myName}
                <EmoteBubble emote={myEmote} side="mine" />
              </span>
              {viewerSubmitted && <span className="ml-1.5 text-emerald-300">✓</span>}
            </p>
            <p className="mt-0.5 text-3xl font-black tabular-nums text-yellow-300">
              {myTotal ?? 0}
            </p>
            <p className="text-[10px] font-bold uppercase tracking-widest text-white/40">
              pts
            </p>
            <p className="mt-0.5 text-[10px] text-white/40">
              {myScore ?? 0} round win{myScore === 1 ? "" : "s"} ·{" "}
              {match ? (viewerIsPlayer1 ? match.p1RoundScore : match.p2RoundScore) : 0}{" "}
              this round
            </p>
          </div>
          <div
            className={`rounded-2xl border p-3 text-center transition ${
              opponentSubmitted
                ? "border-cyan-400/70 bg-cyan-500/10 shadow-[0_0_20px_rgba(34,211,238,0.15)]"
                : "border-white/10 bg-black/30"
            }`}
          >
            <p className="flex items-center justify-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-white/50">
              <FrameAvatar
                frame={oppProfileFrame}
                iconKey={oppIconKey}
                name={oppName}
                size="h-3.5 w-3.5"
              />
              <span className="relative inline-block">
                {oppName}
                <EmoteBubble emote={incomingEmote} />
              </span>
              {opponentSubmitted && <span className="ml-0.5 text-cyan-300">✓</span>}
            </p>
            <p className="mt-0.5 text-3xl font-black tabular-nums text-cyan-300">
              {oppTotal ?? 0}
            </p>
            <p className="text-[10px] font-bold uppercase tracking-widest text-white/40">
              pts
            </p>
            <p className="mt-0.5 text-[10px] text-white/40">
              {oppScore ?? 0} round win{oppScore === 1 ? "" : "s"} ·{" "}
              {match ? (viewerIsPlayer1 ? match.p2RoundScore : match.p1RoundScore) : 0}{" "}
              this round
            </p>
          </div>
        </div>

        {/* Waiting-state card — open lobby: escrow notice + cancel /
            copy-invite actions (mirrors the other PvP games' waiting
            view, e.g. lane-runner). Once an opponent joins the server
            flips to `ready` and the countdown below takes over. */}
        {match?.status === MATCH_STATUS.WAITING && (
          <div className="mb-4 rounded-2xl border border-white/10 bg-black/30 p-4 text-center">
            <div className="flex items-center justify-center gap-2 text-sm font-semibold text-white/70">
              <span className="inline-block h-2.5 w-2.5 animate-ping rounded-full bg-amber-400" />
              Waiting for an opponent…
            </div>
            <p className="mx-auto mt-1.5 max-w-md text-xs text-white/50">
              Your stake is escrowed. Share the invite link to play a
              friend of the same stake, or wait for matchmaking.
            </p>
            <div className="mt-4 flex items-center justify-center gap-3">
              {viewerCanCancel && (
                <button
                  onClick={cancelLobby}
                  disabled={cancelling}
                  className="rounded-xl border border-red-400/40 bg-red-500/15 px-4 py-2 text-xs font-bold text-red-200 transition hover:bg-red-500/25 disabled:opacity-50"
                >
                  {cancelling ? "Cancelling…" : "Cancel lobby"}
                </button>
              )}
              <button
                onClick={copyInvite}
                className="rounded-xl border border-amber-400/40 bg-amber-500/10 px-4 py-2 text-xs font-bold text-amber-200 transition hover:bg-amber-500/20"
              >
                Copy invite link
              </button>
            </div>
          </div>
        )}

        {/* Phase banner — the primary reading of the screen: a big
            uppercase phase label (MEMORIZE / RECREATE THE PATTERN)
            with the authoritative countdown on the right, in the same
            amber-on-dark pill style as the casino's other phase
            indicators. Contextual states (waiting for opponent, ready,
            submitted) keep the banner so the layout never shifts. */}
        <div className="mb-4 flex items-center justify-between rounded-xl border border-white/10 bg-black/30 px-4 py-3 text-sm">
          <div className="flex min-w-0 items-center gap-2">
            <IconSparkles className="h-4 w-4 flex-shrink-0 text-amber-300" />
            {match?.status === MATCH_STATUS.WAITING && (
              <span className="text-white/70">Waiting for opponent…</span>
            )}
            {match?.status === MATCH_STATUS.READY && (
              <span className="font-black uppercase tracking-[0.3em] text-amber-300">
                Get ready
              </span>
            )}
            {playing && isMemorize && (
              <span className="text-lg font-black uppercase tracking-[0.3em] text-amber-300 drop-shadow-[0_0_10px_rgba(251,191,36,0.5)]">
                Memorize
              </span>
            )}
            {playing && isReconstruct && !viewerSubmitted && !opponentSubmitted && (
              <span className="text-lg font-black uppercase tracking-[0.25em] text-amber-300">
                Recreate the pattern
              </span>
            )}
            {playing && isReconstruct && viewerSubmitted && (
              <span className="font-black uppercase tracking-[0.25em] text-white/60">
                Submitted. Waiting
              </span>
            )}
            {playing && isReconstruct && !viewerSubmitted && opponentSubmitted && (
              <span className="font-black uppercase tracking-[0.25em] text-cyan-300">
                Finish your grid
              </span>
            )}
            {playing && isRoundResult && (
              <span className="font-black uppercase tracking-[0.25em] text-emerald-300">
                Round {roundResult?.roundNumber ?? ""} result
              </span>
            )}
            {isFinished && (
              <span className="font-black uppercase tracking-[0.25em] text-emerald-300">
                {viewerWon
                  ? "You win!"
                  : viewerLost
                    ? "You lose"
                    : match?.isAi
                    ? "Draw. Free match"
                    : "Draw. 95% refund"}
              </span>
            )}
            {isCancelled && <span className="text-white/60">Match cancelled</span>}
          </div>
          {playing && msLeft !== null && !isFinished && (
            <div
              className={`flex items-center gap-1.5 font-mono text-lg font-bold ${
                msLeft <= 5000 ? "text-red-400" : "text-amber-300"
              }`}
            >
              <IconClock className="h-4 w-4" />
              {countdownLabel}
            </div>
          )}
        </div>

        {error && match && (
          <div className="mb-4 flex items-center gap-2 rounded-lg border border-red-400/40 bg-red-900/30 px-3 py-2 text-sm text-red-200">
            <IconAlertTriangle className="h-4 w-4 flex-shrink-0 text-red-300" />
            <span>{error}</span>
          </div>
        )}

        {/* Submission feedback (submitter-only, transient) */}
        {feedback && !isFinished && (
          <div className="mb-4 rounded-xl border border-emerald-500/40 bg-emerald-950/40 px-4 py-3 text-center text-sm">
            <span className="font-bold text-emerald-300">
              Round score {feedback.score} · Accuracy {feedback.accuracyPct}%
            </span>
            <span className="ml-1 text-white/50">
              ({feedback.correct} of {feedback.total} cells correct,{" "}
              {feedback.incorrect} wrong ·{" "}
              {SPEED_TIER_LABEL[feedback.speedTier] ?? "Very slow"} · round{" "}
              {feedback.roundNumber})
            </span>
          </div>
        )}

        {/* Waiting-for-opponent / opponent-submitted panels */}
        {playing && isReconstruct && viewerSubmitted && !opponentSubmitted && (
          <div className="mb-4 rounded-xl border border-amber-400/40 bg-amber-950/30 px-4 py-3 text-center text-sm">
            <span className="font-bold text-amber-300">Waiting for opponent…</span>
            <span className="ml-1 text-white/50">your grid is locked</span>
          </div>
        )}
        {playing && isReconstruct && !viewerSubmitted && opponentSubmitted && (
          <div className="mb-4 rounded-xl border border-cyan-400/40 bg-cyan-950/30 px-4 py-3 text-center text-sm">
            <span className="font-bold text-cyan-300">Opponent submitted</span>
            <span className="ml-1 text-white/50">Finish your grid and press Submit</span>
          </div>
        )}

        {/* The grid — full-width inside the shell so the board looks big, but
            capped slightly so the controls underneath stay visible. Buttons are
            not resized here. On desktop `memory-board-frame` tightens that cap
            to the viewport height, so the whole grid fits without scrolling. */}
        <div
          className="memory-board-frame mx-auto grid w-full max-w-lg gap-3"
          style={{
            gridTemplateColumns: `repeat(${gridSize}, minmax(0, 1fr))`,
          }}
        >
          {Array.from({ length: totalTiles }, (_, tileIndex) => {
            const isActive = activeSet.has(tileIndex);
            const isSelected = selected.includes(tileIndex);
            const faceUp = patternVisible && isActive;

            // Reveal on the finished screen: the final round's
            // pattern lights up for both players.
            const revealActive = isFinished && activeSet.has(tileIndex);

            const clickable = canPick && !isFinished;

            // One "face" (the casino logo) is shown by all three
            // states that display it: the memorize pattern, the
            // player's OWN reconstruct picks, and the finished
            // reveal. Selected tiles look IDENTICAL to each other —
            // the game never reveals correctness mid-reconstruction.
            const showFace = faceUp || isSelected || revealActive;

            return (
              <motion.button
                key={tileIndex}
                type="button"
                onClick={() => handleTileClick(tileIndex)}
                disabled={!clickable}
                whileTap={clickable ? { scale: 0.92 } : undefined}
                aria-label={`Tile ${tileIndex + 1}`}
                className={`relative aspect-square select-none overflow-hidden rounded-xl border transition-colors [transform-style:preserve-3d] [perspective:600px] ${
                  revealActive
                    ? "border-emerald-400/60 bg-gradient-to-br from-emerald-500/50 to-teal-600/40 shadow-[0_0_16px_rgba(52,211,153,0.45)]"
                    : faceUp
                      ? "border-amber-400/80 bg-gradient-to-br from-amber-400/80 to-yellow-500/70 shadow-[0_0_18px_rgba(251,191,36,0.6)]"
                      : isSelected
                        ? "border-cyan-300 bg-cyan-500/25"
                        : clickable
                          ? "cursor-pointer border-cyan-600/40 bg-[#08142f] hover:border-cyan-400/70 hover:bg-[#0b224f]"
                          : "border-white/10 bg-[#08142f]"
                }`}
              >
                {/* Card-flip: one continuous 3D rotation (framer-motion,
                    already in the project). The wrapper rotates the whole
                    card Y-axis 0° → 180°; the logo face is pre-rotated
                    180° so it's hidden until the flip lands, and
                    backface-visibility hides whichever face is away. The
                    flip is IDENTICAL for every tile — selected tiles all
                    show the same casino logo, so the animation can never
                    communicate whether a pick is correct. 0.18s + easeOut
                    keeps it fast enough for rapid reconstruction. */}
                <motion.div
                  className="absolute inset-0 [transform-style:preserve-3d]"
                  initial={false}
                  animate={{ rotateY: showFace ? 180 : 0 }}
                  transition={{ duration: 0.18, ease: "easeOut" }}
                >
                  {/* Blank back (inactive) */}
                  <span className="absolute inset-0 [backface-visibility:hidden]" />
                  {/* Logo face (memorize pattern / your picks / reveal) */}
                  <span className="absolute inset-0 flex items-center justify-center p-1 sm:p-2 [backface-visibility:hidden] [transform:rotateY(180deg)]">
                    <Image
                      src={LogoSmiley}
                      alt=""
                      width={64}
                      height={64}
                      className="h-full w-full object-contain drop-shadow-[0_0_8px_rgba(251,191,36,0.9)]"
                    />
                  </span>
                </motion.div>
              </motion.button>
            );
          })}
        </div>

        {/* Reconstruct controls — free modification + explicit Submit */}
        {canPick && mgControlsNode}

      </div>


      </>)
        }
        portrait={isRoundResult && roundResult ? mgRoundResultShell : mgShell}
        landscape={isRoundResult && roundResult ? mgRoundResultShell : mgShell}
      />

      {/* Post-match result screen — shared PvpResultScreen overlay
          (UX plan P3-3). Mounted INSIDE CreatorModeHost so it appears
          in the recording; compact styling keeps it sized for the
          phone frame. */}
      {renderResult()}
      </CreatorModeHost>

      <Footer />
      </div>
    </>
  );
}
