"use client";

// src/app/casino/speed-typing/[matchId]/PageClient.tsx
//
// The Speed Typing match view — the arena.
//
// ── AUTHORITY ───────────────────────────────────────────────────────────
//
// This page can display a local estimate, but it can never DECIDE anything.
// The only thing it sends is the text the player has typed; the server verifies
// that against the passage it resolved for the match and derives every number
// that matters (progress, errors, completion, WPM, accuracy, the winner). The
// result screen is driven by the SNAPSHOT's `result` / `winnerId`, so when the
// server says player 1 won, this page shows exactly that — it never computes a
// winner from local typing.
//
// Local prediction exists for one reason: a keystroke must paint immediately.
// The passage highlight, the live WPM/accuracy and the player's own progress bar
// are computed from the local buffer between snapshots, then replaced by the
// server's values (`race.metrics.you`, `race.you.*`) as soon as they arrive.
//
// ── FLOW ────────────────────────────────────────────────────────────────
//
//   poll the snapshot GET /api/speed-typing/match/<id> (backstop)
//   socket `lobby:updated` on `speed-typing:match:<id>` → immediate refetch
//   socket `speed-typing:opponent-progress` → the opponent's bar, server-derived
//   socket `speed-typing:countdown` / `match-started` → the GO instant, instantly
//   type → a throttled POST checkpoint → the server verifies and broadcasts
//   the full passage → POST finish → the server verifies, freezes and settles
//
// Keystrokes never reach the socket and never reach the database: the store
// throttles checkpoints by `PROGRESS_MIN_ADVANCE`, so a whole race costs a
// handful of writes.

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useUser } from "@clerk/nextjs";
import { IconKeyboardShow } from "@tabler/icons-react";

import NavigationBar from "../../../../components/navigation-bar";
import GameSessionHost from "../../../../components/GameSessionHost";
import MatchWaiting from "../../../../components/lobby/MatchWaiting";
import PvpResultScreen from "../../../../components/result/PvpResultScreen";
import { useSocket } from "../../../../context/SocketProvider";
import {
  SOCKET_DOWN_POLL_MS,
  SOCKET_HEALTHY_POLL_MS,
  useSocketConnected,
  useVisiblePoll,
} from "../../../../hooks/useVisiblePoll";
import {
  SPEED_TYPING_EVENTS,
  speedTypingMatchRoom,
} from "../../../../lib/speed-typing/rooms";
import { PROGRESS_MIN_ADVANCE } from "../../../../lib/speed-typing/constants";

// ── Types (mirrors of the server's participant view) ──────────────────────

type SeatRace = {
  charsTyped: number;
  errors: number;
  finished: boolean;
  finishedAtMs: number | null;
  elapsedMs: number | null;
  wpm: number | null;
  accuracy: number | null;
};

type RaceMetrics = { elapsedMs: number; wpm: number; accuracy: number; remainingMs: number };

type RaceView = {
  passageId: string | null;
  passageText: string;
  prompt: { id: string; difficulty: string; language: string; charCount: number } | null;
  goAtMs: number | null;
  deadlineMs: number;
  seat: 1 | 2;
  seatKey: "player1" | "player2";
  you: SeatRace;
  opponent: SeatRace;
  metrics: { you: RaceMetrics; opponent: RaceMetrics };
  revision: number;
  resolvedAtMs: number | null;
  resolutionReason: string | null;
};

type MatchDto = {
  matchId: string;
  status: string;
  result: string | null;
  winnerId: string | null;
  isAi: boolean;
  viewerSeat: 1 | 2 | null;
  players: { seat: 1 | 2; userId: string }[];
  startedAt: string | null;
  endedAt: string | null;
  goAt: string | null;
  revision: number;
  resolutionReason: string | null;
  race: RaceView | null;
};

type OpponentProgressPayload = {
  seatKey: "player1" | "player2";
  progressPercent: number;
  completed: boolean;
  wpm: number;
  accuracy: number;
};

const TERMINAL = new Set(["finished", "cancelled"]);
const PUSH_DEBOUNCE_MS = 120;

/** "You" / "Opponent", decided by the seat the SERVER says is the viewer's. */
function seatLabel(seat: 1 | 2, viewerSeat: 1 | 2 | null): string {
  if (!viewerSeat) return `Player ${seat}`;
  return seat === viewerSeat ? "You" : "Opponent";
}

/**
 * The LOCAL typing estimate — deliberately identical in formula to the
 * server's `raceMetrics`, so the numbers a player watches while typing do not
 * jump when the authoritative values arrive. Predictive only: it never decides
 * a result, and it is never sent anywhere except as the raw buffer.
 */
function localTypingStats(
  typedChars: string[],
  passageChars: string[],
  elapsedMs: number,
): { correct: number; errors: number; wpm: number; accuracy: number } {
  let correct = 0;
  let errors = 0;
  const shared = Math.min(typedChars.length, passageChars.length);
  for (let i = 0; i < shared; i += 1) {
    if (typedChars[i] === passageChars[i]) correct += 1;
    else errors += 1;
  }
  // Characters past the end of the passage cannot be correct.
  errors += Math.max(0, typedChars.length - passageChars.length);
  const minutes = elapsedMs > 0 ? elapsedMs / 60_000 : 0;
  return {
    correct,
    errors,
    wpm: minutes > 0 ? Math.round(correct / 5 / minutes) : 0,
    accuracy: typedChars.length > 0 ? Math.round((correct / typedChars.length) * 100) : 0,
  };
}

function formatClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/**
 * The shared passage, one span per character.
 *
 * `memo` is load-bearing: the HUD's clock ticks several times a second, and
 * without this every tick would reconcile every character of the passage while
 * the player is typing. A keystroke is the only thing that repaints it.
 */
const PassageTrack = memo(function PassageTrack({
  passageChars,
  typedChars,
  caretRef,
}: {
  passageChars: string[];
  typedChars: string[];
  caretRef: React.RefObject<HTMLSpanElement | null>;
}) {
  return (
    <p
      className="font-mono text-[15px] leading-relaxed tracking-tight sm:text-lg"
      aria-hidden="true"
    >
      {passageChars.map((char, index) => {
        const isTyped = index < typedChars.length;
        const isCorrect = isTyped && typedChars[index] === char;
        const isWrong = isTyped && typedChars[index] !== char;
        const isCurrent = index === typedChars.length;
        return (
          <span
            key={index}
            ref={isCurrent ? caretRef : undefined}
            className={
              isCurrent
                ? "rounded-[3px] bg-amber-400/25 text-amber-100 shadow-[inset_2px_0_0_0_rgb(251,191,36)]"
                : isWrong
                  ? "text-red-400 underline decoration-red-500/70 underline-offset-2"
                  : isCorrect
                    ? "text-emerald-300"
                    : "text-white/40"
            }
          >
            {char}
          </span>
        );
      })}
    </p>
  );
});

/** One player's progress bar. */
function ProgressBar({
  label,
  percent,
  detail,
  tone,
}: {
  label: string;
  percent: number;
  detail: string;
  tone: "mine" | "theirs";
}) {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3 text-xs">
        <span className="font-bold uppercase tracking-wider text-white/70">{label}</span>
        <span className="font-mono text-white/50">{detail}</span>
      </div>
      <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-white/10">
        <div
          className={
            tone === "mine"
              ? "h-full rounded-full bg-gradient-to-r from-amber-400 to-yellow-300 transition-[width] duration-150"
              : "h-full rounded-full bg-gradient-to-r from-sky-400 to-cyan-300 transition-[width] duration-150"
          }
          style={{ width: `${clamped}%` }}
        />
      </div>
    </div>
  );
}

export default function SpeedTypingMatchPage() {
  const params = useParams<{ matchId: string }>();
  const router = useRouter();
  const { socket } = useSocket();
  const { user } = useUser();
  const matchId = params?.matchId;
  const snapshotUrl = `/api/speed-typing/match/${matchId}`;

  const [match, setMatch] = useState<MatchDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [opponent, setOpponent] = useState<OpponentProgressPayload | null>(null);
  const [now, setNow] = useState(0);
  const [goAtOverride, setGoAtOverride] = useState<number | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [requeueing, setRequeueing] = useState(false);

  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const caretRef = useRef<HTMLSpanElement | null>(null);
  const lastSentRef = useRef(0);
  const finishSentRef = useRef(false);
  const sendingRef = useRef(false);
  const loadedRef = useRef(false);

  // ── The snapshot (the one authoritative read) ────────────────────────────
  const load = useCallback(
    async ({ silent = false }: { silent?: boolean } = {}) => {
      if (!matchId) return;
      if (!silent && !loadedRef.current) setLoading(true);
      try {
        const res = await fetch(snapshotUrl, { cache: "no-store" });
        const data = await res.json().catch(() => null);
        if (!res.ok || !data?.success) {
          setLoadError(data?.error || "Unable to load this match");
          return;
        }
        loadedRef.current = true;
        setLoadError(null);
        setMatch(data.data.match as MatchDto);
        // The snapshot carries the server's GO instant; the socket's copy was
        // only ever a head start.
        setGoAtOverride(null);
      } catch {
        setLoadError("Unable to load this match");
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [matchId, snapshotUrl],
  );

  useEffect(() => {
    loadedRef.current = false;
    setLoading(true);
    setTyped("");
    finishSentRef.current = false;
    lastSentRef.current = 0;
    void load();
  }, [load]);

  const loadTimerRef = useRef<number | null>(null);
  const scheduleLoad = useCallback(() => {
    if (loadTimerRef.current != null) return;
    loadTimerRef.current = window.setTimeout(() => {
      loadTimerRef.current = null;
      void load({ silent: true });
    }, PUSH_DEBOUNCE_MS);
  }, [load]);

  useEffect(
    () => () => {
      if (loadTimerRef.current != null) window.clearTimeout(loadTimerRef.current);
    },
    [],
  );

  // ── Derived lifecycle ────────────────────────────────────────────────────
  const race = match?.race ?? null;
  const status = match?.status ?? "";
  const finished = TERMINAL.has(status);
  const passage = race?.passageText ?? "";
  const passageChars = useMemo(() => Array.from(passage), [passage]);
  const typedChars = useMemo(() => Array.from(typed), [typed]);
  const serverGoAt = race?.goAtMs ?? (match?.goAt ? new Date(match.goAt).getTime() : null);
  const goAtMs = goAtOverride ?? serverGoAt;
  const resolved = race?.resolvedAtMs != null;
  const iFinished = race?.you?.finished === true;
  const mySeatKey = race?.seatKey ?? "player1";
  // Only the creator owns the open lobby row, so only they may cancel it.
  const canCancelLobby = status === "waiting" && match?.viewerSeat === 1;

  const phase = useMemo(() => {
    if (!match) return "loading" as const;
    // A failed BACKGROUND refresh must never tear down a live race — the next
    // poll recovers. The error state is only for "we never loaded a match".
    if (loadError && !loadedRef.current) return "error" as const;
    if (finished) return "result" as const;
    if (status === "waiting" || status === "ready") return "waiting" as const;
    if (goAtMs != null && now > 0 && now < goAtMs) return "countdown" as const;
    if (iFinished || resolved) return "complete" as const;
    return "racing" as const;
  }, [match, loadError, finished, status, goAtMs, now, iFinished, resolved]);

  const elapsedMs = goAtMs == null ? 0 : Math.max(0, (now || goAtMs) - goAtMs);
  const local = useMemo(
    () => localTypingStats(typedChars, passageChars, elapsedMs),
    [typedChars, passageChars, elapsedMs],
  );

  const isComplete = passage.length > 0 && typed === passage;
  const myPercent =
    iFinished
      ? 100
      : passageChars.length > 0
        ? (typedChars.length / passageChars.length) * 100
        : 0;
  const opponentPercent =
    opponent?.progressPercent ??
    (race && passageChars.length > 0
      ? (race.opponent.charsTyped / passageChars.length) * 100
      : 0);
  const remainingMs = race ? Math.max(0, race.deadlineMs - now) : 0;
  const countdownSeconds =
    goAtMs == null ? 0 : Math.max(0, Math.ceil((goAtMs - now) / 1000));

  // Live values: local while typing (instant), the server's once frozen.
  const myWpm = race?.you?.finished ? (race.you.wpm ?? local.wpm) : local.wpm;
  const myAccuracy = race?.you?.finished ? (race.you.accuracy ?? local.accuracy) : local.accuracy;
  const opponentWpm = opponent?.wpm ?? race?.metrics?.opponent?.wpm ?? 0;
  const opponentAccuracy = opponent?.accuracy ?? race?.metrics?.opponent?.accuracy ?? 0;

  // ── Clock (only while a clock is on screen) ──────────────────────────────
  useEffect(() => {
    setNow(Date.now());
  }, []);

  useEffect(() => {
    if (phase !== "countdown" && phase !== "racing" && phase !== "complete") return undefined;
    const id = window.setInterval(() => setNow(Date.now()), 200);
    return () => window.clearInterval(id);
  }, [phase]);

  // ── A new race starts from a clean buffer ────────────────────────────────
  useEffect(() => {
    if (goAtMs == null) return;
    setTyped("");
    lastSentRef.current = 0;
    finishSentRef.current = false;
  }, [goAtMs]);

  // ── Sending: the ONLY thing this page ever tells the server ──────────────
  const pushBuffer = useCallback(
    async (buffer: string) => {
      if (!matchId) return;
      const complete = passage.length > 0 && buffer === passage;
      if (complete && finishSentRef.current) return;
      if (complete) finishSentRef.current = true;
      if (sendingRef.current) return;
      sendingRef.current = true;
      try {
        const res = await fetch(
          complete
            ? `/api/speed-typing/match/${matchId}/finish`
            : `/api/speed-typing/match/${matchId}/progress`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            // The ONLY client-authored value: what was typed.
            body: JSON.stringify({ typedText: buffer }),
          },
        );
        const data = await res.json().catch(() => null);
        if (res.ok && data?.success) {
          // Invite the opponent's view to refresh immediately. A bare nudge —
          // the realtime server relays the match id and nothing else.
          socket?.emit(SPEED_TYPING_EVENTS.READY, { matchId });
          if (complete || data.data?.outcome?.settled) void load({ silent: true });
        } else if (complete) {
          // A refusal means the buffer was not the passage after all (a typo the
          // local compare could not see, or a race that already closed). Let the
          // player try again rather than silently swallowing it.
          finishSentRef.current = false;
        }
      } catch {
        if (complete) finishSentRef.current = false;
      } finally {
        sendingRef.current = false;
      }
    },
    [matchId, passage, socket, load],
  );

  useEffect(() => {
    if (phase !== "racing") return;
    // A lost checkpoint is self-healing: the next send carries the whole buffer.
    if (!isComplete && typedChars.length - lastSentRef.current < PROGRESS_MIN_ADVANCE) return;
    lastSentRef.current = typedChars.length;
    void pushBuffer(typed);
  }, [typed, typedChars.length, isComplete, phase, pushBuffer]);

  // ── Socket: the per-match room ───────────────────────────────────────────
  useEffect(() => {
    if (!socket || !matchId) return undefined;
    const roomId = speedTypingMatchRoom(matchId);
    const join = () => socket.emit("join_room", { roomId });
    join();
    // Socket.IO does not restore room membership, so re-join on every connect
    // (including the reconnect after a dropped network) — that is also what
    // cancels the server's disconnect-forfeit timer for this seat.
    socket.on("connect", join);

    const onUpdated = () => scheduleLoad();
    const onProgress = (payload: OpponentProgressPayload) => {
      for (const seat of ["player1", "player2"] as const) {
        if (seat !== mySeatKey && payload?.seatKey === seat) setOpponent(payload);
      }
    };
    const onCountdown = (payload: { goAtMs?: number }) => {
      if (typeof payload?.goAtMs === "number") {
        setGoAtOverride(payload.goAtMs);
        setNow(Date.now());
      }
    };

    socket.on(SPEED_TYPING_EVENTS.MATCH_UPDATED, onUpdated);
    socket.on(SPEED_TYPING_EVENTS.OPPONENT_PROGRESS, onProgress);
    socket.on(SPEED_TYPING_EVENTS.COUNTDOWN, onCountdown);
    socket.on(SPEED_TYPING_EVENTS.MATCH_STARTED, onCountdown);
    socket.on(SPEED_TYPING_EVENTS.MATCH_FINISHED, onUpdated);

    return () => {
      socket.off("connect", join);
      socket.off(SPEED_TYPING_EVENTS.MATCH_UPDATED, onUpdated);
      socket.off(SPEED_TYPING_EVENTS.OPPONENT_PROGRESS, onProgress);
      socket.off(SPEED_TYPING_EVENTS.COUNTDOWN, onCountdown);
      socket.off(SPEED_TYPING_EVENTS.MATCH_STARTED, onCountdown);
      socket.off(SPEED_TYPING_EVENTS.MATCH_FINISHED, onUpdated);
      socket.emit("leave_room", { roomId });
    };
  }, [socket, matchId, mySeatKey, scheduleLoad]);

  const socketConnected = useSocketConnected(socket);

  // Poll backstop — the socket is an accelerator, never the only path. It
  // relaxes while the socket is healthy, tightens if it drops, and stops while
  // the tab is hidden (a racer cannot type into a hidden tab).
  useVisiblePoll(
    () => load({ silent: true }),
    socketConnected ? SOCKET_HEALTHY_POLL_MS : SOCKET_DOWN_POLL_MS,
    Boolean(match) && !finished,
  );

  // ── Focus: the keyboard is the whole game ────────────────────────────────
  useEffect(() => {
    if (phase !== "racing") return undefined;
    const focus = () => inputRef.current?.focus();
    const id = window.setTimeout(focus, 0);
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", focus);
    return () => {
      window.clearTimeout(id);
      window.removeEventListener("focus", focus);
      document.removeEventListener("visibilitychange", focus);
    };
  }, [phase]);

  // Keep the caret on screen without animating anything mid-keystroke.
  useEffect(() => {
    if (phase !== "racing") return;
    caretRef.current?.scrollIntoView({ block: "nearest" });
  }, [typedChars.length, phase]);

  const onChange = useCallback((event: React.ChangeEvent<HTMLTextAreaElement>) => {
    // Newlines cannot appear in a passage; strip them rather than let the buffer
    // drift out of alignment with the text on screen.
    setTyped(event.target.value.replace(/[\r\n]+/g, " "));
  }, []);

  const onKeyDown = useCallback((event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter") event.preventDefault();
  }, []);

  // Leaving a WAITING lobby releases it. The creator cancels the row through the
  // shared cancel route — the same exit every other 1v1 game's lobby uses, and
  // the same `cancelMatch` the retention sweep and the queue mirror already
  // understand. A non-creator merely steps away; the platform's disconnect
  // handler settles the row for them.
  const cancelLobby = useCallback(async () => {
    if (cancelling || !matchId) return;
    setCancelling(true);
    try {
      await fetch(`/api/speed-typing/match/${matchId}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
    } catch {
      // Best effort — an abandoned row is reaped either way.
    } finally {
      setCancelling(false);
      setLeaving(true);
      router.push("/casino/speed-typing");
    }
  }, [cancelling, matchId, router]);

  const leaveWaiting = useCallback(() => {
    setLeaving(true);
    router.push("/casino/speed-typing");
  }, [router]);

  const requeue = useCallback(async () => {
    if (requeueing) return;
    setRequeueing(true);
    try {
      const res = await fetch("/api/speed-typing/create-or-join", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data?.success) {
        router.push(`/casino/speed-typing/${data.data.matchId}`);
      }
    } finally {
      setRequeueing(false);
    }
  }, [requeueing, router]);

  // ── Result: derived from the SNAPSHOT's verdict, never from local typing ──
  const outcome =
    match?.result === "tie"
      ? "draw"
      : match?.winnerId && user?.id && match.winnerId === user.id
        ? "win"
        : "loss";
  const durationSeconds = race?.you?.elapsedMs
    ? Math.round(race.you.elapsedMs / 1000)
    : match?.startedAt && match?.endedAt
      ? Math.round(
          (new Date(match.endedAt).getTime() - new Date(match.startedAt).getTime()) / 1000,
        )
      : null;

  return (
    <GameSessionHost
      // Real lifecycle signals, derived from the server's own status — never a
      // constant. `waiting` is not yet a game, and a terminal match must stop
      // counting immediately.
      autoStart={match?.status === "playing"}
      autoStop={finished}
      gameLabel="speed-typing"
    >
      <div className="min-h-screen overflow-x-clip bg-gradient-to-b from-[#100c02] via-[#0b0902] to-[#070502] px-3 pb-24 pt-20 text-white sm:px-6 md:pb-8">
        <NavigationBar currentPath="/casino" />
        <div className="mx-auto mt-6 max-w-4xl">
          <h1 className="flex items-center gap-2 text-2xl font-extrabold tracking-wide text-transparent bg-clip-text bg-gradient-to-r from-amber-200 via-amber-300 to-yellow-200 sm:text-3xl">
            <IconKeyboardShow className="h-7 w-7 text-amber-400" />
            Speed Typing
          </h1>
          <p className="mt-1 text-xs font-semibold uppercase tracking-widest text-amber-200/70">
            Rated 1v1 · same passage · first to finish correctly
          </p>

          {loading && !match && (
            <p className="mt-8 text-sm text-white/60" data-testid="speed-typing-loading">
              Loading match…
            </p>
          )}

          {loadError && !match && (
            <div
              data-testid="speed-typing-error"
              className="mt-8 rounded-xl border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-200"
            >
              {loadError}
            </div>
          )}

          {match && (
            <div data-testid="speed-typing-match" data-status={match.status}>
              {loadError && match && (
                <p
                  data-testid="speed-typing-stale"
                  className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200"
                >
                  Reconnecting to the match… your place is held.
                </p>
              )}

              {phase === "waiting" && (
                <MatchWaiting
                  state={status === "ready" ? "ready" : "waiting"}
                  gameName="Speed Typing"
                  title="Waiting for an opponent"
                  subtitle="Pairing you with another Speed Typing player…"
                  seats={[
                    { label: "You", name: "You", occupied: true },
                    { label: "Opponent", occupied: false },
                  ]}
                  // The creator owns the open lobby, so only they can cancel it;
                  // anyone else on the row can only leave. Both exits are the
                  // shared takeover's own buttons.
                  onCancel={canCancelLobby ? cancelLobby : null}
                  cancelLabel="Cancel lobby"
                  cancelling={cancelling}
                  onLeave={canCancelLobby ? null : leaveWaiting}
                  leaving={leaving}
                />
              )}

              {phase === "countdown" && (
                <div
                  data-testid="speed-typing-countdown"
                  className="mt-8 rounded-2xl border border-amber-500/25 bg-white/5 p-6 text-center"
                >
                  <p className="text-xs font-bold uppercase tracking-widest text-amber-200/70">
                    Get ready
                  </p>
                  <p className="mt-2 font-mono text-6xl font-extrabold text-amber-200">
                    {countdownSeconds > 0 ? countdownSeconds : "GO"}
                  </p>
                  <div className="mt-6 rounded-xl border border-white/10 bg-black/30 p-4 text-left">
                    <PassageTrack
                      passageChars={passageChars}
                      typedChars={[]}
                      caretRef={caretRef}
                    />
                  </div>
                </div>
              )}

              {(phase === "racing" || phase === "complete") && (
                <div className="mt-6 space-y-4">
                  <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-amber-500/25 bg-white/5 px-4 py-3">
                    <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-3 py-1 text-xs font-bold uppercase tracking-wider text-amber-200">
                      {phase === "complete" ? "Race complete" : "Racing"}
                    </span>
                    <span
                      data-testid="speed-typing-timer"
                      className="font-mono text-lg font-bold text-white/80"
                    >
                      {formatClock(remainingMs)}
                    </span>
                  </div>

                  <div className="grid gap-3 sm:grid-cols-2">
                    <ProgressBar
                      label="You"
                      percent={myPercent}
                      detail={`${myWpm} wpm · ${myAccuracy}%`}
                      tone="mine"
                    />
                    <ProgressBar
                      label="Opponent"
                      percent={opponentPercent}
                      detail={
                        opponent?.completed
                          ? `finished · ${opponentWpm} wpm · ${opponentAccuracy}%`
                          : `${opponentWpm} wpm · ${opponentAccuracy}%`
                      }
                      tone="theirs"
                    />
                  </div>

                  <div
                    data-testid="speed-typing-arena"
                    data-complete={isComplete ? "true" : "false"}
                    className="relative rounded-2xl border border-amber-500/25 bg-black/40 p-4 sm:p-6"
                    onMouseDown={() => inputRef.current?.focus()}
                  >
                    <PassageTrack
                      passageChars={passageChars}
                      typedChars={typedChars}
                      caretRef={caretRef}
                    />
                    <textarea
                      ref={inputRef}
                      value={typed}
                      onChange={onChange}
                      onKeyDown={onKeyDown}
                      onPaste={(event) => event.preventDefault()}
                      rows={1}
                      // The REAL input, kept invisible: the passage above IS the
                      // display, so the browser's own caret never competes with
                      // the highlight. It must stay focusable for mobile.
                      className="absolute inset-0 h-full w-full resize-none bg-transparent p-4 text-transparent caret-transparent outline-none sm:p-6"
                      aria-label="Type the passage"
                      autoCorrect="off"
                      autoCapitalize="off"
                      autoComplete="off"
                      spellCheck={false}
                      enterKeyHint="done"
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                    <Stat label="Correct" value={String(local.correct)} />
                    <Stat label="Mistakes" value={String(local.errors)} />
                    <Stat label="Your WPM" value={String(myWpm)} />
                    <Stat label="Accuracy" value={`${myAccuracy}%`} />
                  </div>

                  {phase === "racing" && (
                    <p className="text-center text-xs text-white/45">
                      Keep typing — the clock started, and your position is verified on the
                      server. Correct a mistake and keep going; the finish only counts when
                      the whole passage is exact.
                    </p>
                  )}

                  {phase === "complete" && !resolved && (
                    <div
                      data-testid="speed-typing-complete"
                      className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-5 text-center"
                    >
                      <p className="text-sm font-bold text-amber-100">
                        {iFinished
                          ? "You finished! Waiting for your opponent to complete the race…"
                          : "Your opponent finished first. Keep typing — the race is still live until you finish or the clock runs out."}
                      </p>
                    </div>
                  )}

                  {phase === "complete" && resolved && (
                    <div
                      data-testid="speed-typing-resolved"
                      className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4 text-center text-sm font-bold text-amber-100"
                    >
                      The race is over — the result is on its way.
                    </div>
                  )}
                </div>
              )}

              {phase === "result" && match.status === "cancelled" && (
                <div
                  data-testid="speed-typing-cancelled"
                  className="mt-8 rounded-2xl border border-white/15 bg-white/5 p-6 text-center"
                >
                  <p className="text-sm font-bold text-white">This match was cancelled.</p>
                  <p className="mt-2 text-xs text-white/60">
                    Nothing was rated. Find another opponent whenever you are ready.
                  </p>
                  <button
                    type="button"
                    onClick={() => router.push("/casino/speed-typing")}
                    className="mt-4 inline-flex items-center justify-center rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-2 text-sm font-bold text-amber-200 transition hover:bg-amber-500/20"
                  >
                    Back to the Speed Typing lobby
                  </button>
                </div>
              )}

              {phase === "error" && (
                <div
                  data-testid="speed-typing-error"
                  className="mt-8 rounded-xl border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-200"
                >
                  {loadError}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <PvpResultScreen
        open={phase === "result" && match?.status === "finished"}
        outcome={outcome}
        headline={
          outcome === "draw"
            ? "Dead heat — the race is a draw"
            : outcome === "win"
              ? "You won the race"
              : "Your opponent won the race"
        }
        subline={
          outcome === "draw"
            ? "Both seats finished inside the dead-heat window."
            : `${myWpm} wpm at ${myAccuracy}% accuracy.`
        }
        opponent={{ name: "Opponent" }}
        gameName="Speed Typing"
        gameKey="speed-typing"
        durationSeconds={durationSeconds}
        sides={[
          { name: "You", score: myWpm, highlight: outcome === "win" },
          { name: "Opponent", score: opponentWpm, highlight: outcome === "loss" },
        ]}
        summary={[
          { label: "Accuracy", value: `${myAccuracy}% – ${opponentAccuracy}%` },
          { label: "Mistakes", value: String(race?.you?.errors ?? local.errors) },
        ]}
        details={[
          { label: "Match ID", value: String(match?.matchId ?? "") },
          {
            label: "Winner",
            value: outcome === "draw" ? "Draw" : outcome === "win" ? "You" : "Opponent",
          },
          ...(race?.prompt
            ? [
                {
                  label: "Passage",
                  value: `${race.prompt.id} · ${race.prompt.charCount} characters`,
                },
              ]
            : []),
        ]}
        playAgain={{ label: "RACE AGAIN", onClick: requeue }}
        onReturnToLobby={() => router.push("/casino/speed-typing")}
      />
    </GameSessionHost>
  );
}

/** One labelled figure in the post-race / mid-race stat row. */
function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/5 px-3 py-2">
      <p className="text-[10px] font-bold uppercase tracking-wider text-white/45">{label}</p>
      <p className="mt-0.5 font-mono text-base font-bold text-white">{value}</p>
    </div>
  );
}
