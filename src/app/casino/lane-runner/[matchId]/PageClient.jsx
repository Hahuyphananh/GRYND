"use client";

// src/app/casino/lane-runner/[matchId]/PageClient.jsx
//
// MATCH view for Lane Rush — the simultaneous-planning OVAL RACE.
//
// One round is:
//   1. PLANNING (60s, 2 action points, server-owned deadline): each seat
//      deploys cars to a route lane, buys / merges / repairs (or uses the free
//      workshop), and locks in. The opponent's route choices are private.
//   2. RACE: the server resolves both grids at once with its own random rolls
//      and stores the complete round. This page NEVER rolls, scores or decides
//      anything — it replays the confirmed round on the oval.
//   3. First seat to 1,000 points wins. Both crossing in one round → higher
//      total wins; an exact tie is a draw. A settlement moves escrow once.
//
// Everything on this page comes from the authoritative payload
// (`/api/lane-rush-duel/match/[id]`), which also heals the lifecycle on every
// read (ready → planning, resolve when both are locked or the clock ran out).
// The countdown is DISPLAY ONLY: when it reaches zero this page simply asks
// the server for the authoritative state, exactly like any other read.

import { use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { usePostHog } from "posthog-js/react";
import { useUser } from "@clerk/nextjs";
import { motion, useReducedMotion } from "framer-motion";
import NavigationBar from "../../../../components/navigation-bar";
import FrameAvatar from "../../../../components/FrameAvatar";
import { cosmeticEffectClass } from "../../../../lib/profileCosmetics";
import GameSessionHost from "../../../../components/GameSessionHost";
import MatchWaiting from "../../../../components/lobby/MatchWaiting";
import PvpResultScreen from "../../../../components/result/PvpResultScreen";
import Footer from "../../../../components/Footer";
import OvalTrack from "../../../../components/lane-rush/OvalTrack";
import RaceGarage from "../../../../components/lane-rush/RaceGarage";
import { useSocket } from "../../../../context/SocketProvider";
import { useMatchSync } from "../../../../hooks/useMatchSync";
import { usePracticePause } from "../../../../hooks/usePracticePause";
import {
  PracticePauseChip,
  PracticePauseOverlay,
} from "../../../../components/game/PracticePause";
import { laneRushDueRead } from "../../../../lib/deadlineRead";
// The platform's ONE seat-based verdict (src/lib/results/viewerOutcome.ts).
import { viewerOutcome } from "../../../../lib/results/viewerOutcome";
import { useDeadlineRead } from "../../../../hooks/useDeadlineRead";
import { useServerClockEstimate } from "../../../../hooks/useServerClockEstimate";
import {
  LANE_RUSH_DUEL_MATCH_UPDATED,
  laneRushDuelMatchRoom,
} from "../../../../lib/lane-rush-duel/rooms";
import { BOT_ACTION_INTERVAL_MS } from "../../../../lib/lane-rush-duel/constants";
import {
  ACTION_POINTS_PER_ROUND,
  PLANNING_SECONDS,
  ROUTES,
  ROUTE_IDS,
  WIN_SCORE,
  tierName,
} from "../../../../lib/lane-rush/rules";
import {
  playBank,
  playCardPlace,
  playCrash,
  playDefeat,
  playGoodReveal,
  playOpponentPick,
  playSafePick,
  playSelect,
  playTick,
  playVictory,
} from "../../../../lib/gameAudio";
import {
  IconClock,
  IconCoins,
  IconLock,
  IconTrophy,
  IconX,
} from "@tabler/icons-react";

// The practice bot is paced SERVER-side (`BOT_ACTION_INTERVAL_MS`), so the page
// wakes it on that same interval — never faster — with a small cushion so a
// wake-up cannot land a millisecond inside the throttle.
const BOT_FIRST_WAKE_MS = 350;
const BOT_WAKE_INTERVAL_MS = BOT_ACTION_INTERVAL_MS + 150;

const SEAT_DOT_CLASS = {
  player1: "bg-sky-400 shadow-[0_0_10px_rgba(56,189,248,0.75)]",
  player2: "bg-rose-400 shadow-[0_0_10px_rgba(251,113,133,0.75)]",
};

function formatClock(totalSeconds) {
  const s = Math.max(0, Math.ceil(Number(totalSeconds) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * Count a score up to a value the SERVER already confirmed.
 *
 * The first payload of a mount (including a reconnect) is painted instantly,
 * so a restored match never looks like it is re-earning points; only a later
 * confirmed change animates.
 */
function useConfirmedScore(value, enabled) {
  const reduced = useReducedMotion();
  const [shown, setShown] = useState(0);
  const initializedRef = useRef(false);
  const previousRef = useRef(0);

  useEffect(() => {
    const target = Number(value) || 0;
    if (!enabled) {
      initializedRef.current = false;
      previousRef.current = 0;
      setShown(0);
      return undefined;
    }
    if (!initializedRef.current) {
      initializedRef.current = true;
      previousRef.current = target;
      setShown(target);
      return undefined;
    }
    const from = previousRef.current;
    previousRef.current = target;
    if (reduced || target === from) {
      setShown(target);
      return undefined;
    }
    let raf = 0;
    let startedAt = 0;
    const step = (stamp) => {
      if (!startedAt) startedAt = stamp;
      const p = Math.min(1, (stamp - startedAt) / 700);
      setShown(Math.round(from + (target - from) * (1 - Math.pow(1 - p, 3))));
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value, enabled, reduced]);

  return shown;
}

function SeatCard({
  seat,
  name,
  displayName,
  identity,
  nameColor,
  nameEffect,
  points,
  shownPoints,
  locked,
  planning,
  isSelf,
  isBot,
  reduced,
}) {
  const pct = Math.max(0, Math.min(100, (Number(points) / WIN_SCORE) * 100));
  return (
    <div
      data-testid={`lane-runner-seat-${seat}`}
      className={`rounded-2xl border p-3 backdrop-blur-md ${
        isSelf
          ? "border-cyan-300/30 bg-cyan-400/[0.06]"
          : "border-rose-300/25 bg-rose-400/[0.05]"
      }`}
    >
      <div className="flex items-center gap-2.5">
        <span
          aria-hidden="true"
          className={`h-2.5 w-2.5 shrink-0 rounded-full ${SEAT_DOT_CLASS[seat]}`}
        />
        {identity?.iconKey ? (
          <FrameAvatar
            frame={identity.profileFrame}
            iconKey={identity.iconKey}
            name={name}
            size="h-9 w-9"
          />
        ) : (
          <div className="flex h-9 w-9 items-center justify-center rounded-full border border-white/15 bg-white/10 text-sm font-black text-white/80">
            {(displayName || "?").charAt(0).toUpperCase()}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-white/45">
            {seat === "player1" ? "Player 1" : "Player 2"} · {isSelf ? "You" : isBot ? "Bot" : "Rival"}
          </p>
          <p
            className={`truncate text-sm font-black ${nameColor || "text-white"} ${nameEffect}`}
          >
            {displayName}
          </p>
        </div>
        <div className="text-right">
          <p
            data-testid={`lane-runner-score-${seat}`}
            className={`font-black tabular-nums ${
              isSelf ? "text-cyan-100" : "text-rose-100"
            } text-xl`}
          >
            {shownPoints.toLocaleString()}
          </p>
          <p className="text-[9px] font-bold uppercase tracking-widest text-white/35">
            / {WIN_SCORE.toLocaleString()}
          </p>
        </div>
      </div>

      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-white/10">
        <motion.div
          initial={reduced ? false : { width: 0 }}
          animate={{ width: `${pct}%` }}
          transition={{ duration: 0.6, ease: "easeOut" }}
          className={`h-full rounded-full ${
            isSelf ? "bg-cyan-300" : "bg-rose-300"
          }`}
        />
      </div>
      <div className="mt-1.5 flex items-center justify-between text-[10px] font-semibold">
        <span className="text-white/40">{Math.round(pct)}% of the target</span>
        <span
          className={
            locked
              ? "inline-flex items-center gap-1 font-black uppercase tracking-wide text-emerald-200"
              : "inline-flex items-center gap-1 text-white/40"
          }
        >
          {locked ? <IconLock size={10} /> : null}
          {locked ? "Locked in" : planning ? "Planning…" : "—"}
        </span>
      </div>
    </div>
  );
}

function PlanningClock({ secondsLeft }) {
  const total = PLANNING_SECONDS;
  const shown = secondsLeft === null ? null : Math.max(0, Math.min(total, secondsLeft));
  const pct = shown === null ? 0 : shown / total;
  const radius = 15;
  const circumference = 2 * Math.PI * radius;
  return (
    <span
      data-testid="lane-runner-clock"
      className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-black tabular-nums ${
        shown !== null && shown <= 10
          ? "border-rose-400/50 bg-rose-500/15 text-rose-100"
          : "border-cyan-300/40 bg-cyan-400/10 text-cyan-100"
      }`}
      title="Planning window — the server owns the deadline"
    >
      <svg viewBox="0 0 36 36" className="h-6 w-6 -rotate-90" aria-hidden="true">
        <circle cx="18" cy="18" r={radius} fill="none" stroke="currentColor" strokeOpacity="0.2" strokeWidth="3" />
        <circle
          cx="18"
          cy="18"
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - pct)}
        />
      </svg>
      {shown === null ? "—" : formatClock(shown)}
    </span>
  );
}

export default function LaneRushMatchPage({ params }) {
  const resolvedParams = use(params);
  const matchId = resolvedParams?.matchId;
  const router = useRouter();
  // useSocket() returns the CONTEXT VALUE ({ socket, userId }), not a socket.
  // Binding the whole value here made every `socket.on/emit` a TypeError on the
  // first effect, which the route error boundary turned into "This screen hit a
  // problem" for every visitor to a Lane Rush match. Every other page
  // destructures; this one is now the same contract.
  const { socket } = useSocket();
  const posthog = usePostHog();
  const { user } = useUser();
  const shouldReduce = useReducedMotion();

  const [match, setMatch] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [acting, setActing] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [resigning, setResigning] = useState(false);
  const [clockOffsetMs, setClockOffsetMs] = useState(0);
  const [syncFailures, setSyncFailures] = useState(0);
  const [now, setNow] = useState(null);
  const [selectedCarId, setSelectedCarId] = useState(null);
  const [mergeSelection, setMergeSelection] = useState([]);
  const [mergeAnim, setMergeAnim] = useState(null);
  // The confirmed round currently being replayed on the oval. A reconnect
  // starts from the live state and replays nothing (`seenRoundRef` is seeded
  // from the first payload).
  const [playbackResult, setPlaybackResult] = useState(null);
  const seenRoundRef = useRef(null);

  // A fallback source for the SAME estimate, for the window before this page's
  // own payload has carried a `serverNow` (the first render, a reconnect).
  const sampledServerNow = useServerClockEstimate();
  const clockOffsetRef = useRef(0);
  clockOffsetRef.current = clockOffsetMs;
  const deadlineServerNow = () =>
    clockOffsetRef.current !== 0
      ? Date.now() + clockOffsetRef.current
      : sampledServerNow();

  const mountedRef = useRef(false);
  const actingRef = useRef(false);
  const actionIdRef = useRef(0);
  const syncSeqRef = useRef(0);
  const syncAbortRef = useRef(null);
  const matchRef = useRef(null);
  const expiredDeadlineRef = useRef(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    matchRef.current = match;
  }, [match]);

  // A new matchId is a NEW race — never inherit the previous one's state.
  useEffect(() => {
    setMatch(null);
    setError(null);
    setLoading(true);
    setActing(false);
    setSyncFailures(0);
    setClockOffsetMs(0);
    setSelectedCarId(null);
    setMergeSelection([]);
    setMergeAnim(null);
    setPlaybackResult(null);
    seenRoundRef.current = null;
    actingRef.current = false;
    syncSeqRef.current += 1;
    syncAbortRef.current?.abort();
    expiredDeadlineRef.current = null;
  }, [matchId]);

  // ── Status read (socket nudge + safety read) ────────────────────────
  const fetchStatus = useCallback(async () => {
    if (!matchId) {
      if (mountedRef.current) setLoading(false);
      return null;
    }
    // Supersede any older in-flight reconcile: out-of-order responses are the
    // classic stale-state bug in a polled duel.
    const seq = (syncSeqRef.current += 1);
    syncAbortRef.current?.abort();
    const controller = new AbortController();
    syncAbortRef.current = controller;
    try {
      const res = await fetch(`/api/lane-rush-duel/match/${matchId}`, {
        cache: "no-store",
        signal: controller.signal,
      });
      const json = await res.json();
      if (!mountedRef.current || seq !== syncSeqRef.current) return null;
      if (!res.ok || !json.success) {
        setError(json.error || "Failed to load match");
        setSyncFailures((n) => n + 1);
        return null;
      }
      const incoming = json.data.match;
      // Re-anchor the countdown to the server clock on EVERY payload (first
      // load, reconnect), so "remaining time" is always
      // `planningDeadline − serverNow` rather than a device-clock guess.
      if (incoming?.serverNow) {
        const serverMs = new Date(incoming.serverNow).getTime();
        if (Number.isFinite(serverMs)) setClockOffsetMs(serverMs - Date.now());
      }
      setMatch(incoming);
      setError(null);
      setSyncFailures(0);
      setLoading(false);
      return incoming;
    } catch (err) {
      if (err?.name === "AbortError") return null;
      if (!mountedRef.current || seq !== syncSeqRef.current) return null;
      setSyncFailures((n) => n + 1);
      setLoading(false);
      return null;
    }
  }, [matchId]);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  // ── Practice pause (vs AI only) ────────────────────────────────────
  const practicePause = usePracticePause({
    game: "lane-rush-duel",
    matchId,
    enabled: match?.player2Id === "AI_BOT",
    onResume: fetchStatus,
  });
  const paused = practicePause.paused;

  useMatchSync(fetchStatus, socket, Boolean(matchId) && !paused);

  // The ready window only closes because a read arrives, so bring that read
  // forward at its stored deadline (the laneRush selector is ready-only).
  useDeadlineRead(paused ? null : laneRushDueRead(match), fetchStatus, {
    serverNow: deadlineServerNow,
  });

  useEffect(() => {
    if (!socket || !matchId) return;
    socket.emit("join_room", { roomId: laneRushDuelMatchRoom(matchId) });
    const refresh = () => fetchStatus();
    socket.on(LANE_RUSH_DUEL_MATCH_UPDATED, refresh);
    return () => {
      socket.emit("leave_room", { roomId: laneRushDuelMatchRoom(matchId) });
      socket.off(LANE_RUSH_DUEL_MATCH_UPDATED, refresh);
    };
  }, [socket, matchId, fetchStatus]);

  // Local clock for the display-only countdown.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);

  const lifecycle = match?.lifecycle || "waiting";
  const finished = finishedState(match);
  const cancelled = match?.status === "cancelled" || lifecycle === "cancelled";
  const planning = lifecycle === "planning";
  const resolving = lifecycle === "resolving";
  const isBotMatch = match?.player2Id === "AI_BOT";
  const mySeat = match?.mySeat === "player2" ? "player2" : "player1";
  const isPlayer1 = mySeat === "player1";
  // A legacy (game_state_version 0) glass-bridge row still exists and still
  // settles on the server, but its board is retired: this page says so instead
  // of rendering racing controls against a bridge payload.
  const legacyMatch = Boolean(match && match.mode !== "race");

  const mySeatIdentity = isPlayer1
    ? {
        name: match?.player1Name || null,
        iconKey: match?.player1IconKey || null,
        nameColor: match?.player1NameColor || null,
        profileFrame: match?.player1ProfileFrame || null,
      }
    : {
        name: match?.player2Name || null,
        iconKey: match?.player2IconKey || null,
        nameColor: match?.player2NameColor || null,
        profileFrame: match?.player2ProfileFrame || null,
      };
  const oppSeatIdentity = isBotMatch
    ? { name: null, iconKey: null, nameColor: null, profileFrame: null }
    : isPlayer1
      ? {
          name: match?.player2Name || null,
          iconKey: match?.player2IconKey || null,
          nameColor: match?.player2NameColor || null,
          profileFrame: match?.player2ProfileFrame || null,
        }
      : {
          name: match?.player1Name || null,
          iconKey: match?.player1IconKey || null,
          nameColor: match?.player1NameColor || null,
          profileFrame: match?.player1ProfileFrame || null,
        };
  const myDisplayName = mySeatIdentity.name || "You";
  const oppDisplayName =
    oppSeatIdentity.name || (isBotMatch ? "GRYND AI" : "Rival");
  const myNameColor = mySeatIdentity.nameColor;
  const oppNameColor = oppSeatIdentity.nameColor;
  const myNameEffect =
    cosmeticEffectClass(mySeatIdentity.profileFrame?.usernameEffect?.visual) || "";
  const oppNameEffect =
    cosmeticEffectClass(oppSeatIdentity.profileFrame?.usernameEffect?.visual) || "";

  // ── Authoritative race view ─────────────────────────────────────────
  const myPoints = Number(match?.myPoints) || 0;
  const oppPoints = Number(match?.oppPoints) || 0;
  const myCars = Array.isArray(match?.myCars) ? match.myCars : [];
  const oppCars = Array.isArray(match?.oppCars) ? match.oppCars : [];
  const resources = match?.myResources || { scrap: 0, fuel: 0, tech: 0 };
  const actionPoints = Number(match?.actionPoints) || 0;
  const locked = Boolean(match?.locked);
  const oppLocked = Boolean(match?.oppLocked);
  const lastResult = match?.lastResult || null;
  const round = Number(match?.round) || 1;
  const results = Array.isArray(match?.results) ? match.results : [];

  const deadlineMs = match?.planningDeadline
    ? new Date(match.planningDeadline).getTime()
    : null;
  const serverNowMs = now === null ? null : now + clockOffsetMs;
  const secondsLeft =
    deadlineMs && serverNowMs !== null
      ? Math.max(0, Math.ceil((deadlineMs - serverNowMs) / 1000))
      : null;

  const shownMyPoints = useConfirmedScore(myPoints, Boolean(match?.id));
  const shownOppPoints = useConfirmedScore(oppPoints, Boolean(match?.id));

  // A NEW resolved round is the only thing that may animate the oval. The
  // first payload of a mount seeds the baseline, so a refresh/reconnect shows
  // the current standings without replaying a finished round.
  useEffect(() => {
    const latest = match?.lastResult || null;
    if (!match) return;
    if (seenRoundRef.current === null) {
      seenRoundRef.current = Number(latest?.round) || 0;
      return;
    }
    const latestRound = Number(latest?.round) || 0;
    if (!latest || latestRound <= seenRoundRef.current) return;
    seenRoundRef.current = latestRound;
    setPlaybackResult(latest);
  }, [match, match?.lastResult]);
  useEffect(() => {
    if (!playbackResult) return undefined;
    const timer = setTimeout(() => setPlaybackResult(null), 4200);
    return () => clearTimeout(timer);
  }, [playbackResult]);

  // The countdown is display-only. When it reaches zero the page asks the
  // server for the authoritative state — the resolver decides whether the
  // round may end, never this clock.
  useEffect(() => {
    if (!match || finished || cancelled || paused) return;
    if (!deadlineMs || !Number.isFinite(deadlineMs)) return;
    if (secondsLeft === null || secondsLeft > 0) {
      expiredDeadlineRef.current = null;
      return;
    }
    if (expiredDeadlineRef.current === deadlineMs) return;
    expiredDeadlineRef.current = deadlineMs;
    fetchStatus();
  }, [deadlineMs, secondsLeft, match, finished, cancelled, paused, fetchStatus]);

  // ── Practice bot: wake it until it has locked in ────────────────────
  // The bot spends its whole plan in ONE server call and locks immediately,
  // so the client asks once per ROUND (the idempotency key) and re-asks on
  // the shared interval until the payload shows the bot locked in.
  const botNeedsPlan =
    isBotMatch && !paused && planning && !oppLocked && !finished && !cancelled;
  const botAskUrl = matchId
    ? `/api/lane-rush-duel/match/${matchId}/ai-turn`
    : null;
  useEffect(() => {
    if (!botNeedsPlan || !botAskUrl) return undefined;
    let cancelled = false;
    let timer = null;

    const wake = async () => {
      if (cancelled || !mountedRef.current) return;
      // Read the LIVE payload: between wake-ups the round may already have
      // resolved, the bot may have locked, or practice may have been paused.
      const live = matchRef.current;
      if (!live || live.player2Id !== "AI_BOT") return;
      if (live.lifecycle === "finished" || live.lifecycle === "cancelled") return;
      if (live.oppLocked) return;

      const actionId = `${matchId}:bot:${live.round}`;
      try {
        const response = await fetch(botAskUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ actionId }),
        });
        const json = await response.json().catch(() => null);
        if (cancelled || !mountedRef.current) return;
        if (json?.success) {
          socket?.emit("room_event", {
            roomId: laneRushDuelMatchRoom(matchId),
            event: LANE_RUSH_DUEL_MATCH_UPDATED,
          });
        }
        // Resync on EVERY answer so the next wake-up decides from the real
        // board rather than this closure.
        await fetchStatus();
      } catch {
        if (cancelled || !mountedRef.current) return;
        await fetchStatus();
      }

      if (cancelled || !mountedRef.current) return;
      timer = setTimeout(wake, BOT_WAKE_INTERVAL_MS);
    };

    timer = setTimeout(wake, BOT_FIRST_WAKE_MS);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [botNeedsPlan, botAskUrl, matchId, socket, fetchStatus]);

  // ── Presentation cues, keyed to the SERVER's resolved round ─────────
  const myRoundCars = lastResult
    ? lastResult.cars.filter((car) => car.seat === mySeat)
    : [];
  const oppRoundCars = lastResult
    ? lastResult.cars.filter((car) => car.seat !== mySeat)
    : [];
  const myRoundKey = lastResult
    ? `${lastResult.round}:${myRoundCars.map((car) => `${car.carId}:${car.outcome}`).join(",")}`
    : null;
  const oppRoundKey = lastResult
    ? `${lastResult.round}:${oppRoundCars.map((car) => `${car.carId}:${car.outcome}`).join(",")}`
    : null;
  // history is the baseline, never "news": the first snapshot only seeds it, so a reconnect replays neither sound nor flash.
  const mySeenKeyRef = useRef(null);
  const oppSeenKeyRef = useRef(null);
  useEffect(() => {
    if (!match) return;
    if (mySeenKeyRef.current === null) {
      mySeenKeyRef.current = myRoundKey;
      return;
    }
    if (!myRoundKey || myRoundKey === mySeenKeyRef.current) return;
    mySeenKeyRef.current = myRoundKey;
    if (myRoundCars.some((car) => car.outcome === "finished")) playSafePick();
    else playTick();
  }, [match, myRoundKey, myRoundCars]);
  useEffect(() => {
    if (!match) return;
    if (oppSeenKeyRef.current === null) {
      oppSeenKeyRef.current = oppRoundKey;
      return;
    }
    if (!oppRoundKey || oppRoundKey === oppSeenKeyRef.current) return;
    oppSeenKeyRef.current = oppRoundKey;
    if (oppRoundCars.some((car) => car.outcome === "finished")) playOpponentPick();
    else playCrash();
  }, [match, oppRoundKey, oppRoundCars]);

  const finishSoundRef = useRef(false);
  const verdict = finished
    ? viewerOutcome({
        result: match?.result,
        winnerId: match?.winnerId,
        viewerSeat: mySeat,
      })
    : null;
  const outcome = verdict ?? "draw";
  const wonMatch = finished && outcome === "win";
  const lostMatch = finished && outcome === "loss";
  const drawMatch = finished && outcome === "draw";
  useEffect(() => {
    if (!finished) {
      finishSoundRef.current = false;
      return;
    }
    if (finishSoundRef.current) return;
    finishSoundRef.current = true;
    if (wonMatch) playVictory();
    else if (lostMatch) playDefeat();
    else if (drawMatch) playTick();
  }, [finished, wonMatch, lostMatch, drawMatch]);

  // ── Planning actions ────────────────────────────────────────────────
  // One idempotent request per click. `actionId` makes a retried POST a
  // no-op, and the round/state version make a stale plan a clean 409.
  const doPlan = useCallback(
    async (actions) => {
      if (actingRef.current) return false;
      if (!matchId) return false;
      actingRef.current = true;
      setActing(true);
      setError(null);
      const actionId = `${matchId}:${mySeat}:${Date.now()}:${(actionIdRef.current += 1)}`;
      const send = () =>
        fetch(`/api/lane-rush-duel/match/${matchId}/act`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            actionId,
            round: matchRef.current?.round ?? null,
            stateVersion: matchRef.current?.gameStateVersion ?? 1,
            actions,
          }),
        });
      try {
        let res;
        try {
          res = await send();
        } catch {
          // One retry — safe because the server dedupes on `actionId`.
          res = await send();
        }
        const json = await res.json().catch(() => null);
        if (!mountedRef.current) return false;
        if (!res.ok || !json?.success) {
          setError(json?.error || "That action was refused.");
          // 409 = the round moved on under us (lock/deadline): reconcile
          // immediately so the garage matches the server again.
          if (res.status === 409) {
            await fetchStatus();
          }
          return false;
        }
        posthog?.capture("lane_rush_race_action", {
          match_id: matchId,
          round: matchRef.current?.round ?? null,
          actions: Array.isArray(actions)
            ? actions.map((action) => action?.type).join(",")
            : null,
        });
        socket?.emit("room_event", {
          roomId: laneRushDuelMatchRoom(matchId),
          event: LANE_RUSH_DUEL_MATCH_UPDATED,
        });
        await fetchStatus();
        return true;
      } catch {
        if (mountedRef.current) {
          setError("Network error — your action was not sent. Try again.");
        }
        return false;
      } finally {
        actingRef.current = false;
        if (mountedRef.current) setActing(false);
      }
    },
    [matchId, mySeat, posthog, socket, fetchStatus],
  );

  const sendPlan = useCallback(
    async (actions, { sound } = {}) => {
      const ok = await doPlan(actions);
      if (ok && typeof sound === "function") sound();
      return ok;
    },
    [doPlan],
  );

  const deployCar = useCallback(
    (carId, route) =>
      sendPlan([{ type: "deploy", carId, route }], { sound: playSelect }),
    [sendPlan],
  );
  const setRoute = useCallback(
    (carId, route) =>
      sendPlan([{ type: "setRoute", carId, route }], { sound: playSelect }),
    [sendPlan],
  );
  const recallCar = useCallback(
    (carId) => sendPlan([{ type: "recall", carId }], { sound: playSelect }),
    [sendPlan],
  );
  const buyCar = useCallback(
    () => sendPlan([{ type: "buy" }], { sound: playCardPlace }),
    [sendPlan],
  );
  const repairCar = useCallback(
    (carId) => sendPlan([{ type: "repair", carId }], { sound: playBank }),
    [sendPlan],
  );
  const workshopCar = useCallback(
    (carId) =>
      sendPlan([{ type: "workshopRecovery", carId }], { sound: playBank }),
    [sendPlan],
  );

  const mergeCars = useCallback(
    async (ids) => {
      if (!Array.isArray(ids) || ids.length !== 2) return false;
      const [carId, otherCarId] = ids;
      const tier = myCars.find((car) => car.id === carId)?.tier ?? null;
      const ok = await sendPlan([{ type: "merge", carId, otherCarId }], {
        sound: playGoodReveal,
      });
      if (!ok) return false;
      setMergeSelection([]);
      if (tier) {
        setMergeAnim({ key: `${carId}:${otherCarId}:${Date.now()}`, tier });
      }
      return true;
    },
    [myCars, sendPlan],
  );

  const lockPlan = useCallback(async () => {
    const ok = await sendPlan([{ type: "lockIn" }], { sound: playBank });
    if (ok) posthog?.capture("lane_rush_race_locked", { match_id: matchId });
    return ok;
  }, [sendPlan, posthog, matchId]);

  const toggleMerge = useCallback((carId) => {
    setMergeSelection((current) => {
      if (current.includes(carId)) return current.filter((id) => id !== carId);
      if (current.length >= 2) return [current[1], carId];
      return [...current, carId];
    });
  }, []);

  useEffect(() => {
    if (!mergeAnim) return undefined;
    const timer = setTimeout(() => setMergeAnim(null), 1100);
    return () => clearTimeout(timer);
  }, [mergeAnim]);

  const cancelLobby = useCallback(async () => {
    if (cancelling || !matchId) return;
    setCancelling(true);
    setError(null);
    try {
      const res = await fetch(`/api/lane-rush-duel/match/${matchId}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        setError(json.error || "Cancel failed");
        return;
      }
      router.push("/casino/lane-runner");
    } catch {
      if (mountedRef.current) setError("Network error — could not cancel.");
    } finally {
      if (mountedRef.current) setCancelling(false);
    }
  }, [cancelling, matchId, router]);

  const handleResign = useCallback(async () => {
    if (resigning || !matchId) return;
    if (
      !window.confirm(
        "Resign this race? Your opponent takes the win and the match settles now.",
      )
    )
      return;
    setResigning(true);
    setError(null);
    try {
      const res = await fetch(`/api/lane-rush-duel/match/${matchId}/resign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        setError(json.error || "Resign failed");
        return;
      }
      posthog?.capture("lane_rush_race_resigned", { match_id: matchId });
      socket?.emit("room_event", {
        roomId: laneRushDuelMatchRoom(matchId),
        event: LANE_RUSH_DUEL_MATCH_UPDATED,
      });
      await fetchStatus();
    } catch {
      if (mountedRef.current) setError("Network error — could not resign.");
    } finally {
      if (mountedRef.current) setResigning(false);
    }
  }, [matchId, posthog, resigning, socket, fetchStatus]);

  // ── Derived UI state ────────────────────────────────────────────────
  const planOpen = Boolean(match?.canAct) && planning && !paused;
  const planBlockedReason = locked
    ? "Your plan is locked in."
    : resolving
      ? "The race is running — the next planning window opens automatically."
      : finished
        ? "The race is over."
        : !planning
          ? "Waiting for the race to start."
          : paused
            ? "Practice is paused."
            : acting
              ? "Sending your plan…"
              : "";

  const racingCount = myCars.filter((car) => car.status === "racing").length;

  const statusChip = (() => {
    if (loading && !match) return { text: "Loading…", cls: "bg-white/10 text-white/70" };
    if (cancelled) return { text: "Cancelled", cls: "bg-red-500/20 text-red-200" };
    if (match?.status === "waiting") return { text: "Waiting for a rival", cls: "bg-amber-400/20 text-amber-200" };
    if (match?.status === "ready") return { text: "Get ready…", cls: "bg-emerald-400/20 text-emerald-200" };
    if (finished) {
      return {
        text: drawMatch ? "DRAW" : wonMatch ? "YOU WIN" : "YOU LOSE",
        cls: drawMatch
          ? "bg-amber-400/25 text-amber-200"
          : wonMatch
            ? "bg-emerald-400/25 text-emerald-200"
            : "bg-rose-500/25 text-rose-200",
      };
    }
    if (resolving) return { text: "Race in progress", cls: "bg-fuchsia-400/20 text-fuchsia-100" };
    if (locked) return { text: "Plan locked", cls: "bg-emerald-400/20 text-emerald-100" };
    return { text: "Planning", cls: "bg-cyan-400/25 text-cyan-100" };
  })();

  const trackPhase = finished ? "finished" : planning ? "planning" : null;

  const phaseLabel = finished
    ? `Round ${Math.max(1, round - 1)} final`
    : resolving
      ? `Round ${round} — racing`
      : planning
        ? `Round ${round} — planning ${secondsLeft !== null ? formatClock(secondsLeft) : ""}`.trim()
        : "Waiting";

  const lastRoundSummary = useMemo(() => {
    if (!lastResult) return null;
    const mine = lastResult.cars.filter((car) => car.seat === mySeat);
    const theirs = lastResult.cars.filter((car) => car.seat !== mySeat);
    const tally = (cars) => ({
      points: cars.reduce((sum, car) => sum + (Number(car.points) || 0), 0),
      finished: cars.filter((car) => car.outcome === "finished").length,
      dnf: cars.filter((car) => car.outcome === "dnf").length,
    });
    return {
      round: lastResult.round,
      mine: tally(mine),
      theirs: tally(theirs),
      myCars: mine,
      oppCars: theirs,
    };
  }, [lastResult, mySeat]);

  const bothBelowTarget = myPoints < WIN_SCORE && oppPoints < WIN_SCORE;
  const bothCrossed = myPoints >= WIN_SCORE && oppPoints >= WIN_SCORE;
  const iResigned = Array.isArray(match?.myActions)
    ? match.myActions.some((entry) => entry?.type === "resigned")
    : false;

  const resultScreenProps = finished
    ? {
        outcome,
        headline: drawMatch
          ? bothCrossed
            ? "Both seats crossed 1,000 — exact dead heat"
            : "Neither seat reached the target"
          : wonMatch
            ? bothBelowTarget
              ? "Opponent left the race — you take the win"
              : bothCrossed
                ? "Tie-break: you led on total points"
                : `You reached ${myPoints.toLocaleString()} points`
            : bothBelowTarget
              ? iResigned
                ? "You resigned — your rival takes the win"
                : "The race ended early — your rival takes the win"
              : bothCrossed
                ? "Tie-break: your rival led on total points"
                : `${oppDisplayName} reached the target first`,
        gameName: "Lane Rush",
        opponent: {
          name: oppDisplayName,
          iconKey: oppSeatIdentity.iconKey,
          profileFrame: oppSeatIdentity.profileFrame,
          isAi: isBotMatch,
        },
        durationSeconds: (() => {
          if (!match?.startedAt || !match?.endedAt) return null;
          const ms =
            new Date(match.endedAt).getTime() - new Date(match.startedAt).getTime();
          return Number.isFinite(ms) && ms > 0 ? Math.round(ms / 1000) : null;
        })(),
        sides: [
          {
            name: "You",
            score: myPoints.toLocaleString(),
            highlight: !drawMatch && wonMatch,
          },
          {
            name: oppDisplayName,
            score: oppPoints.toLocaleString(),
            highlight: !drawMatch && !wonMatch,
          },
        ],
        summary: [
          {
            label: "Rounds",
            value: String(Math.max(0, round - 1) || results.length || 0),
          },
          { label: "Target", value: `${WIN_SCORE.toLocaleString()} points` },
        ],
        details: [
          ...(match?.id != null ? [{ label: "Match ID", value: String(match.id) }] : []),
          {
            label: "Winner",
            value: drawMatch ? "Draw" : wonMatch ? "You" : oppDisplayName,
          },
          {
            label: "Won by",
            value: drawMatch
              ? bothCrossed
                ? "Exact tie at the target"
                : "No winner"
              : bothBelowTarget
                ? "Resignation"
                : bothCrossed
                  ? "Tie-break: higher total"
                  : `${WIN_SCORE.toLocaleString()}-point target`,
          },
          {
            label: "Damaged cars",
            value: String(myCars.filter((car) => car.damaged).length),
          },
          ...(isBotMatch ? [{ label: "Mode", value: "Practice — no stake, no rating" }] : []),
        ],
        secondaryAction: { label: "Back to Lane Rush", href: "/casino/lane-runner" },
      }
    : null;

  const waitingOrReady =
    !legacyMatch && (match?.status === "waiting" || match?.status === "ready");
  const livePhase =
    !legacyMatch && !waitingOrReady && (planning || resolving || finished);

  const copyInvite = () =>
    navigator.clipboard
      ?.writeText(window.location.href)
      ?.catch(() => {});

  const routeLegend = (
    <ul className="mt-2 grid grid-cols-1 gap-1.5 sm:grid-cols-3">
      {ROUTE_IDS.map((route) => {
        const config = ROUTES[route];
        return (
          <li
            key={route}
            className="flex items-center justify-between gap-2 rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1.5"
            title={config.name}
          >
            <span className="inline-flex items-center gap-2 text-[10px] font-black uppercase tracking-wide text-white/70">
              <span
                aria-hidden="true"
                className="h-2.5 w-2.5 rounded-full"
                style={{
                  background:
                    route === "safe" ? "#34d399" : route === "sprint" ? "#38bdf8" : "#fbbf24",
                }}
              />
              {config.name}
            </span>
            <span className="text-[10px] font-semibold text-white/45">
              {Math.round(config.dnfChance * 100)}% DNF · {config.pointsMultiplier}×
            </span>
          </li>
        );
      })}
    </ul>
  );

  const gameContent = (
    <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_23rem]">
      <div className="min-w-0 space-y-3">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <SeatCard
            seat={mySeat}
            name={myDisplayName}
            displayName={myDisplayName}
            identity={mySeatIdentity}
            nameColor={myNameColor}
            nameEffect={myNameEffect}
            points={myPoints}
            shownPoints={shownMyPoints}
            locked={locked}
            planning={planning}
            isSelf
            isBot={false}
            reduced={Boolean(shouldReduce)}
          />
          <SeatCard
            seat={isPlayer1 ? "player2" : "player1"}
            name={oppDisplayName}
            displayName={oppDisplayName}
            identity={oppSeatIdentity}
            nameColor={oppNameColor}
            nameEffect={oppNameEffect}
            points={oppPoints}
            shownPoints={shownOppPoints}
            locked={oppLocked}
            planning={planning}
            isSelf={false}
            isBot={isBotMatch}
            reduced={Boolean(shouldReduce)}
          />
        </div>

        <div className="rounded-2xl border border-white/10 bg-slate-950/60 p-2 backdrop-blur-md">
          <div className="flex flex-wrap items-center justify-between gap-2 px-1 pb-1">
            <div className="flex items-center gap-2">
              <IconTrophy size={14} className="text-amber-300" />
              <span className="text-[10px] font-black uppercase tracking-[0.2em] text-amber-200/90">
                First to {WIN_SCORE.toLocaleString()}
              </span>
            </div>
            <span
              data-testid="lane-runner-phase"
              className={`rounded-full border px-2.5 py-1 text-[10px] font-black uppercase tracking-wide ${
                resolving
                  ? "border-fuchsia-300/40 bg-fuchsia-400/10 text-fuchsia-100"
                  : finished
                    ? "border-amber-300/40 bg-amber-400/10 text-amber-100"
                    : "border-cyan-300/30 bg-cyan-400/10 text-cyan-100"
              }`}
            >
              {phaseLabel}
            </span>
          </div>

          <OvalTrack
            myCars={myCars}
            oppCars={oppCars}
            mySeat={mySeat}
            lastResult={playbackResult}
            round={round}
            phase={trackPhase}
            selectedCarId={selectedCarId}
            targetScore={WIN_SCORE}
            myPoints={myPoints}
            oppPoints={oppPoints}
          />

          <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2 px-1 text-[10px] font-semibold text-white/40">
            <span>Start/finish on the left · clockwise travel</span>
            <span>
              <span className="text-sky-300">Blue</span> = Player 1 ·{" "}
              <span className="text-rose-300">Red</span> = Player 2 · dot size = tier
            </span>
          </div>

          {routeLegend}

          {/* Status strip: whose plan is in, and what the round is doing. */}
          <div
            role="status"
            aria-live="polite"
            className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-white/10 bg-white/[0.03] px-2.5 py-2"
          >
            <span className="text-[11px] font-semibold text-white/65">
              {finished
                ? "Race complete — final standings are in."
                : resolving
                  ? "Both grids are in. The server is resolving the race…"
                  : locked
                    ? `Your plan is locked. ${oppLocked ? "Your rival is locked too." : "Waiting for your rival to lock in."}`
                    : `${racingCount} car${racingCount === 1 ? "" : "s"} on your grid. ${oppLocked ? "Your rival has locked in." : isBotMatch ? "The bot is planning…" : "Your rival is still planning."}`}
            </span>
            <span className="inline-flex items-center gap-2 text-[10px] font-black uppercase tracking-wide">
              <span
                className={`h-1.5 w-1.5 rounded-full ${locked ? "bg-emerald-300" : "bg-white/30"}`}
              />
              <span className={locked ? "text-emerald-200" : "text-white/40"}>
                You {locked ? "locked" : "open"}
              </span>
              <span
                className={`h-1.5 w-1.5 rounded-full ${oppLocked ? "bg-emerald-300" : "bg-white/30"}`}
              />
              <span className={oppLocked ? "text-emerald-200" : "text-white/40"}>
                Rival {oppLocked ? "locked" : "open"}
              </span>
            </span>
          </div>
        </div>

        {/* Last resolved round: the confirmed result, straight from the server. */}
        {lastRoundSummary && (
          <div
            data-testid="lane-runner-last-round"
            className="rounded-2xl border border-white/10 bg-slate-950/60 p-3 backdrop-blur-md"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-[10px] font-black uppercase tracking-[0.2em] text-white/55">
                Round {lastRoundSummary.round} result
              </p>
              <p className="text-[10px] font-semibold text-white/40">
                {finishingBlurb(lastRoundSummary, finished)}
              </p>
            </div>
            <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div className="rounded-xl border border-cyan-300/20 bg-cyan-400/[0.05] px-2.5 py-2">
                <p className="text-[10px] font-black uppercase tracking-wide text-cyan-200/80">
                  You +{lastRoundSummary.mine.points}
                </p>
                <p className="mt-0.5 text-[10px] font-semibold text-white/45">
                  {lastRoundSummary.mine.finished} finished · {lastRoundSummary.mine.dnf} DNF
                </p>
                <ul className="mt-1 flex flex-wrap gap-1">
                  {lastRoundSummary.myCars.map((car) => (
                    <li
                      key={car.carId}
                      className="inline-flex items-center gap-1 rounded border border-white/10 px-1.5 py-0.5 text-[9px] font-bold text-white/60"
                      title={`${tierName(car.tier)} · ${ROUTES[car.route]?.name || car.route} · ${car.outcome}`}
                    >
                      T{car.tier} {car.outcome === "dnf" ? "DNF" : `+${car.points}`}
                    </li>
                  ))}
                </ul>
              </div>
              <div className="rounded-xl border border-rose-300/20 bg-rose-400/[0.05] px-2.5 py-2">
                <p className="text-[10px] font-black uppercase tracking-wide text-rose-200/80">
                  {oppDisplayName} +{lastRoundSummary.theirs.points}
                </p>
                <p className="mt-0.5 text-[10px] font-semibold text-white/45">
                  {lastRoundSummary.theirs.finished} finished · {lastRoundSummary.theirs.dnf} DNF
                </p>
                <ul className="mt-1 flex flex-wrap gap-1">
                  {lastRoundSummary.oppCars.map((car) => (
                    <li
                      key={car.carId}
                      className="inline-flex items-center gap-1 rounded border border-white/10 px-1.5 py-0.5 text-[9px] font-bold text-white/60"
                      title={`${tierName(car.tier)} · ${ROUTES[car.route]?.name || car.route} · ${car.outcome}`}
                    >
                      T{car.tier} {car.outcome === "dnf" ? "DNF" : `+${car.points}`}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="space-y-3">
        {/* Lock the plan — the round's one irreversible choice. */}
        <div className="rounded-2xl border border-white/10 bg-slate-950/60 p-3 backdrop-blur-md">
          <div className="flex items-center justify-between gap-2">
            <div>
              <p className="text-[10px] font-black uppercase tracking-[0.2em] text-white/50">
                Planning
              </p>
              <p className="text-[11px] font-semibold text-white/60">
                {actionPoints} of {ACTION_POINTS_PER_ROUND} action points ·{" "}
                {PLANNING_SECONDS}s window
              </p>
            </div>
            <span className="inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/[0.04] px-2 py-1 text-[10px] font-black text-white/70">
              <IconClock size={11} /> {secondsLeft !== null ? formatClock(secondsLeft) : "—"}
            </span>
          </div>

          <button
            type="button"
            data-testid="lane-runner-lock"
            onClick={lockPlan}
            disabled={!planOpen || locked || acting}
            className="mt-2 w-full rounded-xl border-b-4 border-[#0087a8] bg-[#00e5ff] px-4 py-3 text-sm font-extrabold uppercase tracking-wide text-[#001a2e] transition hover:brightness-110 disabled:cursor-not-allowed disabled:border-white/10 disabled:bg-white/10 disabled:text-white/40"
          >
            {locked ? (
              <span className="inline-flex items-center justify-center gap-1.5">
                <IconLock size={15} /> Plan locked in
              </span>
            ) : (
              "Lock in plan"
            )}
          </button>
          {planBlockedReason && !locked && (
            <p className="mt-1.5 text-center text-[10px] font-semibold text-white/45">
              {planBlockedReason}
            </p>
          )}
          {!locked && planning && racingCount === 0 && (
            <p className="mt-1.5 text-center text-[10px] font-semibold text-amber-200/80">
              No car deployed — you would score nothing this round.
            </p>
          )}
          <p className="mt-1.5 text-center text-[10px] font-semibold text-white/40">
            {oppLocked ? "Rival locked in." : "Rival still planning."}
          </p>
        </div>

        <RaceGarage
          cars={myCars}
          resources={resources}
          actionPoints={actionPoints}
          phase={match?.phase ?? null}
          locked={locked}
          canPlan={Boolean(match?.canAct)}
          acting={acting}
          selectedCarId={selectedCarId}
          onSelectCar={(carId) =>
            setSelectedCarId((current) => (current === carId ? null : carId))
          }
          mergeSelection={mergeSelection}
          onToggleMerge={toggleMerge}
          onDeploy={deployCar}
          onSetRoute={setRoute}
          onRecall={recallCar}
          onRepair={repairCar}
          onBuy={buyCar}
          onMerge={mergeCars}
          onWorkshopRecovery={workshopCar}
          mergeAnim={mergeAnim}
          seat={mySeat}
        />

        {/* Rules summary — the same numbers the engine uses. */}
        <div className="rounded-2xl border border-white/10 bg-slate-950/60 p-3 backdrop-blur-md">
          <h2 className="text-[10px] font-black uppercase tracking-[0.2em] text-white/50">
            How the race works
          </h2>
          <ul className="mt-2 space-y-1 text-[11px] leading-relaxed text-white/55">
            <li>
              Each round is a {PLANNING_SECONDS}s planning window with{" "}
              {ACTION_POINTS_PER_ROUND} action points. Plans stay secret until the
              race resolves.
            </li>
            <li>
              Deploy up to four cars and pick their lane. Deploy, recall and route
              changes are free; buying, merging and repairing spend action points.
            </li>
            <li>
              A finished car scores tier points × the lane multiplier and pays its
              chip. A DNF scores nothing and leaves the car damaged.
            </li>
            <li>
              First to {WIN_SCORE.toLocaleString()} points wins. If both cross in one
              round the higher total wins; an exact tie is a draw.
            </li>
          </ul>
        </div>

        <div className="space-y-2">
          {!cancelled && !finished && !isBotMatch && (
            <button
              type="button"
              data-testid="lane-runner-resign"
              onClick={handleResign}
              disabled={resigning}
              className="w-full rounded-2xl border border-red-500/40 bg-red-500/10 py-2.5 text-xs font-black uppercase tracking-wider text-red-300 transition hover:bg-red-500/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300 disabled:opacity-50"
            >
              {resigning ? "Resigning…" : "Resign race"}
            </button>
          )}
          {practicePause.canPause && !finished && (
            <div className="flex justify-center">
              <PracticePauseChip
                paused={paused}
                busy={practicePause.busy}
                onToggle={() => void practicePause.toggle()}
                testId="lane-runner-pause"
              />
            </div>
          )}
          {isBotMatch && !finished && (
            <p className="text-center text-[10px] text-white/40">
              Practice race — no stake, no rating. The bot plans by the same rules.
            </p>
          )}
        </div>
      </div>
    </div>
  );

  return (
    <>
      {waitingOrReady && (
        <MatchWaiting
          state={match.status === "ready" ? "ready" : "waiting"}
          gameName={isBotMatch ? "Lane Rush vs Bot" : "Lane Rush"}
          subtitle={
            match.status === "ready"
              ? "Both seats are in — you race the same oval. Get ready!"
              : "Your stake is escrowed. Share the invite link to race a player of the same stake, or wait for matchmaking."
          }
          seats={
            match.status === "ready"
              ? [
                  {
                    label: "Player 1",
                    name: isPlayer1 ? myDisplayName : oppDisplayName,
                    occupied: true,
                  },
                  {
                    label: "Player 2",
                    name: isPlayer1 ? oppDisplayName : myDisplayName,
                    occupied: true,
                  },
                ]
              : [
                  { label: "You", name: myDisplayName, occupied: true },
                  {
                    label: isBotMatch ? "Bot" : "Rival",
                    name: oppDisplayName,
                    occupied: false,
                  },
                ]
          }
          onCancel={
            match.status === "waiting" && match?.player1Id === user?.id
              ? cancelLobby
              : null
          }
          cancelLabel="Cancel lobby"
          cancelling={cancelling}
          onCopy={isBotMatch ? null : copyInvite}
        />
      )}

      <div className="min-h-screen overflow-x-clip bg-[radial-gradient(circle_at_top,#1b2150_0%,#080b1f_35%,#03040d_100%)] pb-24 pt-20 text-white md:pb-8">
        <NavigationBar currentPath="/casino/lane-runner" />

        <div className="mx-auto mt-4 max-w-6xl px-3 sm:px-4">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h1 className="text-xl font-black text-cyan-100 sm:text-2xl">
                Lane Rush
              </h1>
              <p className="text-xs text-white/55">
                #{matchId} · Oval circuit ·{" "}
                <span className="inline-flex items-center gap-1 font-semibold text-yellow-300">
                  <IconCoins size={12} />
                  {Number(match?.stakeAmount || 0).toLocaleString()}
                </span>{" "}
                stake
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {statusChip && (
                <span
                  className={`rounded-full border px-3 py-1.5 text-xs font-black uppercase tracking-wider ${statusChip.cls}`}
                >
                  {statusChip.text}
                </span>
              )}
              {secondsLeft !== null && !finished && !cancelled && (
                <PlanningClock secondsLeft={secondsLeft} />
              )}
              {syncFailures > 0 && !finished && !cancelled && (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-400/40 bg-amber-500/15 px-3 py-1.5 text-xs font-black text-amber-100">
                  <IconClock size={13} />
                  Reconnecting…
                </span>
              )}
            </div>
          </div>

          {error && (
            <div className="mb-4 flex items-center gap-2 rounded-xl border border-red-400/40 bg-red-900/30 px-3 py-2 text-sm text-red-200">
              <IconX size={16} className="text-red-300" />
              <span>{error}</span>
            </div>
          )}

          {cancelled && (
            <div className="rounded-3xl border border-red-400/30 bg-slate-900/60 py-16 text-center">
              <p className="text-lg font-black text-red-200">
                This lobby was cancelled
              </p>
            </div>
          )}

          {/* A preserved legacy bridge row: its history and settlement stay,
              but the retired board is not rendered for new gameplay. */}
          {legacyMatch && (
            <div className="rounded-3xl border border-amber-300/30 bg-slate-900/60 p-6 text-center">
              <p className="text-lg font-black text-amber-200">
                This match used the retired bridge board
              </p>
              <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-white/60">
                Lane Rush now runs on the oval race circuit. This match's record
                and result are preserved, but its board can no longer be played
                here. Start a new race for the current rules.
              </p>
              <Link
                href="/casino/lane-runner"
                className="mt-4 inline-flex rounded-xl border border-cyan-300/50 bg-cyan-400/10 px-5 py-2 text-sm font-bold text-cyan-100 transition hover:bg-cyan-400/20"
              >
                Start a new race
              </Link>
            </div>
          )}

          {/* ── Waiting / Ready states ─────────────────────────────── */}
          {waitingOrReady && (
            <motion.div
              initial={shouldReduce ? false : { opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className="flex flex-col items-center justify-center rounded-3xl border border-cyan-300/20 bg-slate-900/60 py-20 text-center"
            >
              <div className="flex items-center gap-2 text-2xl font-black text-cyan-100">
                <span
                  className={`inline-block h-3 w-3 rounded-full bg-cyan-400 ${shouldReduce ? "" : "animate-ping"}`}
                />
                {match?.status === "waiting"
                  ? "Waiting for a rival…"
                  : "Rival found! Get ready…"}
              </div>
              <p className="mt-2 max-w-md text-sm text-white/60">
                {match?.status === "waiting"
                  ? "Your stake is escrowed. Share this link to invite a player of the same stake, or wait for matchmaking."
                  : "Both seats plan in secret, then race the same oval. First to 1,000 points takes the match."}
              </p>
              <div className="mt-6 flex items-center gap-3">
                {match?.status === "waiting" && match?.player1Id === user?.id && (
                  <button
                    onClick={cancelLobby}
                    disabled={cancelling}
                    className="rounded-xl border border-red-400/40 bg-red-500/15 px-5 py-2.5 text-sm font-bold text-red-200 transition hover:bg-red-500/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300 disabled:opacity-50"
                  >
                    {cancelling ? "Cancelling…" : "Cancel lobby"}
                  </button>
                )}
                {!isBotMatch && (
                  <button
                    onClick={() =>
                      navigator.clipboard
                        ?.writeText(window.location.href)
                        ?.catch(() => {})
                    }
                    className="rounded-xl border border-cyan-300/40 bg-cyan-400/10 px-5 py-2.5 text-sm font-bold text-cyan-100 transition hover:bg-cyan-400/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300"
                  >
                    Copy invite link
                  </button>
                )}
              </div>
            </motion.div>
          )}

          {/* ── Race ───────────────────────────────────────────────── */}
          {livePhase && (
            <GameSessionHost
              autoStart={Boolean(match && match.status === "active")}
              autoStop={Boolean(finished || cancelled)}
              gameLabel="lane-rush-duel"
            >
              {gameContent}
            </GameSessionHost>
          )}

          {!loading && !match && (
            <div className="rounded-3xl border border-white/10 bg-slate-900/60 py-20 text-center">
              <p className="text-white/60">
                {error
                  ? `Couldn't load the duel: ${error}`
                  : "Match not found or you are not a participant."}
              </p>
              {error && (
                <button
                  onClick={() => fetchStatus()}
                  className="mt-4 mr-2 rounded-xl border border-cyan-300/50 bg-cyan-400/10 px-5 py-2 text-sm font-bold text-cyan-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300"
                >
                  Retry
                </button>
              )}
            </div>
          )}

          <Footer />
        </div>
      </div>

      {resultScreenProps && <PvpResultScreen open {...resultScreenProps} />}

      <PracticePauseOverlay
        paused={paused}
        busy={practicePause.busy}
        onResume={() => void practicePause.toggle()}
        testId="lane-runner-pause-overlay"
      />
    </>
  );
}

function finishedState(match) {
  return Boolean(
    match && (match.lifecycle === "finished" || match.status === "finished"),
  );
}

function finishingBlurb(summary, finished) {
  if (finished) return "Final round";
  if (summary.mine.dnf > 0 || summary.theirs.dnf > 0) {
    return "Damaged cars return to the garage";
  }
  return "Next planning window is open";
}
