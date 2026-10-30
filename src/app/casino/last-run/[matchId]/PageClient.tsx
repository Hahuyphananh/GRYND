"use client";

// src/app/casino/last-run/[matchId]/PageClient.tsx
//
// LAST RUN — the match.
//
// ── PHASES (all server-stamped) ───────────────────────────────────────────
//
//   connecting → the first snapshot has not arrived
//   countdown  → `now < startsAt` (3–2–1 + the control guide)
//   racing     → the server is stepping the shared engine every tick
//   finished   → `final` is set exactly once, by the server
//
// ── WHAT THE CLIENT OWNS ──────────────────────────────────────────────────
//
// Two booleans, on transition: `{ jump, duck }`. Everything else — distance,
// height, collisions, survival, winner — is the server's. The arena
// interpolates distance for smoothness; nothing here can change a tick.
//
// Sound is off by default (no autoplay) and is toggled by the visible mute
// control. Effects are cosmetic: with reduced motion they disappear, and the
// match would be identical without them.

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";

import NavigationBar from "../../../../components/navigation-bar";
import Footer from "../../../../components/Footer";
import RunnerArena, { SeatBadge } from "../../../../components/last-run/RunnerArena";
import { useRunInput } from "../../../../components/last-run/useRunInput";
import { useRunAudio } from "../../../../components/last-run/useRunAudio";
import type { MatchSnapshot } from "../../../../lib/last-run/matchRegistry";

type Feed = "connecting" | "live" | "reconnecting" | "lost";

const POLL_RACING_MS = 250;
const POLL_OTHER_MS = 500;
const STALE_AFTER_MS = 2000;

function formatSeconds(ms: number, decimals = 1): string {
  return `${(Math.max(0, ms) / 1000).toFixed(decimals)}s`;
}

function formatDistance(px: number): string {
  return `${Math.round(Math.max(0, px))} m`;
}

const REASON_COPY: Record<string, string> = {
  crash: "Decided by the course.",
  abandon: "Your rival stopped responding.",
  left: "Your rival left the match.",
  time: "Decided on distance at the final marker.",
};

// ── Persisted result shapes (src/lib/last-run/queries.ts) ───────────────
// The client only ever DISPLAYS these: every number was written by the server's
// settlement from the engine's own final state.
type PersistedMatch = {
  matchId: string;
  result: "win" | "loss" | "draw";
  seatResult: "player1" | "player2" | "draw";
  endReason: string;
  durationMs: number;
  seed: number;
  rated: boolean;
  startedAt: string;
  endedAt: string;
  you: { survivalMs: number; distance: number };
  opponent: { survivalMs: number; distance: number; name: string | null };
};

type RatingSide = { delta: number; before: number; after: number };
type RatingView = { applied: boolean; reason?: string; you?: RatingSide } | null;
type SettleState = "idle" | "saving" | "saved" | "error";

function formatDelta(delta: number): string {
  return delta > 0 ? `+${delta}` : `${delta}`;
}

/** Shows Elo only when the server persisted a rating for THIS match. */
function RatingNote({ state, rating }: { state: SettleState; rating: RatingView }) {
  if (state !== "saved") {
    const failed = state === "error";
    return (
      <p
        className={`mt-2 text-[9px] font-bold uppercase tracking-[0.18em] ${failed ? "text-amber-300/70" : "text-white/30"}`}
      >
        {failed
          ? "Result saved. The Elo update could not be confirmed yet."
          : "Recording the result…"}
      </p>
    );
  }
  if (!rating?.applied || !rating.you) {
    return (
      <p className="mt-2 text-[9px] font-bold uppercase tracking-[0.18em] text-white/30">
        Recorded · no rating change applied
      </p>
    );
  }
  return (
    <p className="mt-2 text-[10px] font-bold tabular-nums text-white/60">
      Elo {formatDelta(rating.you.delta)} <span className="text-white/25">·</span> now {rating.you.after}
    </p>
  );
}

/** Inline speaker glyphs — no icon dependency, no remote asset. */
function SpeakerIcon({ muted }: { muted: boolean }) {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
      <path d="M4 10v4h3l4 3V7L7 10H4z" strokeLinejoin="round" />
      {muted ? (
        <path d="M15 10l5 5M20 10l-5 5" strokeLinecap="round" />
      ) : (
        <>
          <path d="M15.5 9.5a3.5 3.5 0 0 1 0 5" strokeLinecap="round" />
          <path d="M18 7a7 7 0 0 1 0 10" strokeLinecap="round" opacity={0.55} />
        </>
      )}
    </svg>
  );
}

export default function PageClient({ matchId }: { matchId: string }) {
  const router = useRouter();
  const reducedMotion = useReducedMotion() ?? false;
  const audio = useRunAudio();

  const [snapshot, setSnapshot] = useState<MatchSnapshot | null>(null);
  const [feed, setFeed] = useState<Feed>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [leaving, setLeaving] = useState(false);
  const [persisted, setPersisted] = useState<PersistedMatch | null>(null);
  const [rating, setRating] = useState<RatingView>(null);
  const [settleState, setSettleState] = useState<SettleState>("idle");

  const skew = useRef(0);
  const lastOk = useRef(0);
  const previousSent = useRef({ jump: false, duck: false });
  const playedResult = useRef(false);
  const playedCrash = useRef(false);
  const playedCountdown = useRef<number | null>(null);

  // ── The persisted answer ──────────────────────────────────────────────
  // Settlement is best-effort and asynchronous, so the result screen asks the
  // server for the STORED result a few times instead of guessing. Elo is shown
  // only when the server says it was applied to this match.
  const pollSettled = useCallback(async () => {
    setSettleState("saving");
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        const res = await fetch(`/api/last-run/match/${matchId}/result`, {
          cache: "no-store",
          credentials: "include",
        });
        const data = await res.json().catch(() => null);
        if (data?.success && data.match) {
          setPersisted(data.match as PersistedMatch);
          setRating((data.rating ?? null) as RatingView);
          setSettleState("saved");
          return;
        }
      } catch {
        // Retry below; a failure is never shown as a saved result.
      }
      await new Promise((resolve) => setTimeout(resolve, 600));
    }
    setSettleState("error");
  }, [matchId]);

  // ── The authoritative feed ────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const load = async () => {
      try {
        const res = await fetch(`/api/last-run/match/${matchId}`, {
          cache: "no-store",
          credentials: "include",
        });
        const data = await res.json().catch(() => null);
        if (cancelled) return;

        // The live match is gone (refresh after a restart, or a result screen
        // reopened later) — the durable record still stands.
        if (data?.success && data.snapshot === null && data.recorded) {
          setPersisted(data.recorded as PersistedMatch);
          setRating((data.rating ?? null) as RatingView);
          setSettleState("saved");
          setError(null);
          setFeed("live");
          return;
        }

        if (res.status === 401) {
          setError("Sign in to view this match.");
          setFeed("lost");
          return;
        }
        if (res.status === 404 || !data?.success) {
          setError(data?.error || "This match is not available.");
          setFeed("lost");
          return;
        }

        const next = data.snapshot as MatchSnapshot;
        skew.current = next.serverNow - Date.now();
        lastOk.current = Date.now();
        setSnapshot(next);
        setError(null);
        setFeed("live");
        setNow(Date.now());

        if (next.phase === "finished") {
          void pollSettled();
          return;
        }
        timer = setTimeout(load, next.phase === "racing" ? POLL_RACING_MS : POLL_OTHER_MS);
      } catch {
        if (cancelled) return;
        setFeed((current) => (current === "connecting" ? "lost" : "reconnecting"));
        timer = setTimeout(load, 1500);
      }
    };

    load();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [matchId]);

  // A final snapshot also triggers the persisted read (covers a reconnect that
  // only ever saw the finished frame).
  useEffect(() => {
    if (snapshot?.final) void pollSettled();
  }, [snapshot?.final, pollSettled]);

  // A 100 ms display clock, derived from the server's own instant.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (feed === "live" && Date.now() - lastOk.current > STALE_AFTER_MS) setFeed("reconnecting");
  }, [feed, now]);

  const serverNow = now + skew.current;
  const phase = snapshot?.phase ?? "connecting";
  const countdown = snapshot ? Math.max(0, Math.ceil((snapshot.startsAt - serverNow) / 1000)) : 3;
  const elapsed = snapshot ? Math.max(0, Math.min(snapshot.course.duration * 1000, serverNow - snapshot.startsAt)) : 0;

  // ── Input: transitions only, only while the server says racing ─────────
  const sendInput = useCallback(
    async (input: { jump: boolean; duck: boolean }, cue = true) => {
      if (cue) {
        if (input.jump && !previousSent.current.jump) audio.play("jump");
        else if (input.duck && !previousSent.current.duck) audio.play("duck");
      }
      previousSent.current = input;
      try {
        await fetch(`/api/last-run/match/${matchId}/input`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify(input),
        });
      } catch {
        // Dropped on purpose: the next accepted transition resynchronises the
        // held state, and the server never sees a fabricated position.
      }
    },
    [audio, matchId],
  );

  const controls = useRunInput({ enabled: phase === "racing" && !snapshot?.final, onChange: sendInput });

  // ── Cosmetic cues, all driven by server state ─────────────────────────
  useEffect(() => {
    if (phase !== "countdown") return;
    if (countdown <= 0 || countdown > 3) return;
    if (playedCountdown.current === countdown) return;
    playedCountdown.current = countdown;
    audio.play("tick");
  }, [audio, countdown, phase]);

  useEffect(() => {
    if (!snapshot?.final || playedResult.current) return;
    playedResult.current = true;
    const outcome =
      snapshot.final.result === "draw"
        ? "draw"
        : snapshot.final.result === snapshot.you.seat
          ? "win"
          : "loss";
    audio.play(outcome);
  }, [audio, snapshot]);

  useEffect(() => {
    if (!snapshot || snapshot.you.alive || playedCrash.current) return;
    playedCrash.current = true;
    audio.play("crash");
  }, [audio, snapshot]);

  const forfeit = useCallback(async () => {
    setLeaving(true);
    try {
      await fetch(`/api/last-run/match/${matchId}/forfeit`, {
        method: "POST",
        credentials: "include",
      });
    } catch {
      // The server's abandonment grace closes the match regardless.
    }
  }, [matchId]);

  const outcome = useMemo(() => {
    if (!snapshot?.final) return null;
    if (snapshot.final.result === "draw") return "draw" as const;
    return snapshot.final.result === snapshot.you.seat ? ("win" as const) : ("loss" as const);
  }, [snapshot]);

  // ── Error shell ───────────────────────────────────────────────────────
  if (error) {
    return (
      <div className="min-h-screen bg-[#07080b] text-white">
        <NavigationBar />
        <main className="mx-auto flex min-h-[60vh] w-full max-w-lg flex-col items-center justify-center px-6 text-center">
          <p className="text-[11px] font-black uppercase tracking-[0.32em] text-red-300/70">Match unavailable</p>
          <h1 className="mt-3 text-3xl font-black tracking-tight">This run is not open</h1>
          <p className="mt-3 text-sm text-white/50">{error}</p>
          <Link
            href="/games/last-run/play"
            className="mt-6 inline-flex h-11 items-center rounded-xl bg-cyan-400 px-5 text-xs font-black uppercase tracking-[0.18em] text-[#04121a]"
          >
            Back to the lobby
          </Link>
        </main>
        <Footer />
      </div>
    );
  }

  const finished = snapshot?.final ?? null;
  const rival = snapshot?.opponent;

  // ── Persisted result screen (no live snapshot) ────────────────────────
  if (persisted && !snapshot) {
    const viewOutcome = persisted.result;
    return (
      <div className="min-h-screen bg-[#07080b] text-white">
        <NavigationBar />
        <main className="mx-auto flex min-h-[70vh] w-full max-w-lg flex-col justify-center px-4 py-8">
          <div
            className={`rounded-2xl border p-4 text-center sm:p-5 ${
              viewOutcome === "win"
                ? "border-emerald-400/40 bg-gradient-to-b from-[#0b2418] to-[#07160f]"
                : viewOutcome === "loss"
                  ? "border-red-400/35 bg-gradient-to-b from-[#251014] to-[#14080b]"
                  : "border-cyan-400/35 bg-gradient-to-b from-[#0a1a2b] to-[#071019]"
            }`}
          >
            <p
              className={`text-[9px] font-black uppercase tracking-[0.4em] ${
                viewOutcome === "win" ? "text-emerald-300/80" : viewOutcome === "loss" ? "text-red-300/80" : "text-cyan-300/80"
              }`}
            >
              Saved result
            </p>
            <h1 className="mt-1.5 text-3xl font-black tracking-tight sm:text-4xl">
              {viewOutcome === "win" ? "You survived" : viewOutcome === "loss" ? "Run ended" : "Dead heat"}
            </h1>
            <p className="mt-1 text-[11px] text-white/50">
              {REASON_COPY[persisted.endReason] ?? "Match complete."}
            </p>
            <p className="mt-1 text-[9px] uppercase tracking-[0.22em] text-white/25">
              {new Date(persisted.endedAt).toLocaleString()}
            </p>

            <div className="mt-3 grid grid-cols-2 gap-1.5 text-left sm:gap-2">
              <div className="rounded-xl border border-white/10 bg-black/30 p-2.5">
                <p className="truncate text-[9px] font-bold uppercase tracking-[0.16em] text-white/45">You</p>
                <p className="mt-0.5 font-mono text-base font-black tabular-nums text-white sm:text-lg">
                  {formatSeconds(persisted.you.survivalMs)}
                </p>
                <p className="text-[10px] text-white/45">{formatDistance(persisted.you.distance)} travelled</p>
              </div>
              <div className="rounded-xl border border-white/10 bg-black/30 p-2.5">
                <p className="truncate text-[9px] font-bold uppercase tracking-[0.16em] text-white/45">
                  {persisted.opponent.name ?? "Rival"}
                </p>
                <p className="mt-0.5 font-mono text-base font-black tabular-nums text-white sm:text-lg">
                  {formatSeconds(persisted.opponent.survivalMs)}
                </p>
                <p className="text-[10px] text-white/45">{formatDistance(persisted.opponent.distance)} travelled</p>
              </div>
            </div>

            <RatingNote state={settleState} rating={rating} />

            <div className="mt-3 flex flex-col gap-1.5 sm:flex-row sm:gap-2">
              <button
                type="button"
                onClick={() => router.push("/games/last-run/play?queue=1")}
                className="flex-1 rounded-xl bg-cyan-400 py-2.5 text-[10px] font-black uppercase tracking-[0.18em] text-[#04121a] transition hover:bg-cyan-300 sm:text-[11px]"
              >
                Run it back
              </button>
              <Link
                href="/games/last-run/play"
                className="flex-1 rounded-xl border border-white/15 bg-white/[0.03] py-2.5 text-center text-[10px] font-black uppercase tracking-[0.18em] text-white/70 transition hover:border-white/30 hover:text-white sm:text-[11px]"
              >
                Return to lobby
              </Link>
            </div>
          </div>
        </main>
        <Footer />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#07080b] text-white">
      <NavigationBar />

      <main className="mx-auto w-full max-w-6xl px-3 pb-8 pt-4 sm:px-5 lg:pt-6 [@media(max-height:520px)]:pt-2">
        {/* ── HUD ─────────────────────────────────────────────────────── */}
        <header className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-baseline gap-2.5">
            <Link href="/games/last-run/play" className="text-base font-black tracking-tight text-white/90 hover:text-white sm:text-lg">
              LAST<span className="text-cyan-300">RUN</span>
            </Link>
            <span className="hidden text-[10px] font-bold uppercase tracking-[0.24em] text-white/30 sm:inline">
              duel · seeded course
            </span>
          </div>

          <div className="flex items-center gap-1.5 sm:gap-2">
            <span className="rounded-lg border border-white/10 bg-white/[0.03] px-2 py-1.5 font-mono text-[10px] tabular-nums text-white/60 sm:px-2.5 sm:text-[11px]">
              {snapshot ? `T+${formatSeconds(elapsed, 1)}` : "T+0.0s"}
            </span>
            <span
              className={`inline-flex items-center gap-1.5 rounded-lg border px-2 py-1.5 text-[9px] font-black uppercase tracking-[0.14em] sm:px-2.5 sm:text-[10px] ${
                feed === "live"
                  ? "border-emerald-400/35 bg-emerald-400/10 text-emerald-300"
                  : feed === "reconnecting"
                    ? "border-amber-400/40 bg-amber-400/10 text-amber-300"
                    : feed === "lost"
                      ? "border-red-400/40 bg-red-400/10 text-red-300"
                      : "border-white/10 bg-white/[0.03] text-white/40"
              }`}
              aria-live="polite"
            >
              <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current" />
              {feed === "live" ? "Live" : feed === "reconnecting" ? "Reconnecting" : feed === "lost" ? "Offline" : "Connecting"}
            </span>

            <button
              type="button"
              onClick={audio.toggle}
              aria-pressed={audio.enabled}
              aria-label={audio.enabled ? "Mute game sounds" : "Enable game sounds"}
              title={audio.enabled ? "Mute game sounds" : "Enable game sounds"}
              className={`inline-flex h-8 w-8 items-center justify-center rounded-lg border transition ${
                audio.enabled
                  ? "border-cyan-400/40 bg-cyan-400/10 text-cyan-300"
                  : "border-white/10 bg-white/[0.03] text-white/40 hover:text-white/70"
              }`}
            >
              <SpeakerIcon muted={!audio.enabled} />
            </button>

            {!finished && snapshot && (
              <button
                type="button"
                onClick={forfeit}
                disabled={leaving}
                className="rounded-lg border border-white/10 px-2 py-1.5 text-[9px] font-black uppercase tracking-[0.14em] text-white/45 transition hover:border-red-400/50 hover:text-red-300 disabled:opacity-40 sm:text-[10px]"
              >
                {leaving ? "Leaving…" : "Leave"}
              </button>
            )}
          </div>
        </header>

        {/* ── Seats ───────────────────────────────────────────────────── */}
        <div className="mt-2.5 grid grid-cols-2 gap-1.5 sm:flex sm:items-stretch sm:gap-2">
          <SeatBadge
            seat="YOU"
            name={snapshot?.you.name ?? "You"}
            alive={snapshot?.you.alive ?? true}
            accent="cyan"
            distance={snapshot?.you.distance ?? 0}
          />
          <div className="hidden w-10 shrink-0 items-center justify-center sm:flex">
            <span className="text-[10px] font-black tracking-[0.2em] text-white/25">VS</span>
          </div>
          <SeatBadge
            seat="RIVAL"
            name={rival?.name ?? "Waiting"}
            alive={rival?.alive ?? true}
            accent="violet"
            distance={rival?.distance ?? 0}
          />
        </div>

        {/* ── Arena ───────────────────────────────────────────────────── */}
        <div className="relative mt-2.5">
          <RunnerArena
            you={{
              name: snapshot?.you.name ?? "You",
              distance: snapshot?.you.distance ?? 0,
              y: snapshot?.you.y ?? 0,
              ducking: snapshot?.you.ducking ?? false,
              alive: snapshot?.you.alive ?? true,
              accent: "cyan",
            }}
            opponent={{
              name: rival?.name ?? "Rival",
              distance: rival?.distance ?? 0,
              y: rival?.y ?? 0,
              ducking: rival?.ducking ?? false,
              alive: rival?.alive ?? true,
              accent: "violet",
            }}
            obstacles={snapshot?.course.obstacles ?? []}
            elapsedMs={elapsed}
            running={phase === "racing" && !finished}
            reducedMotion={reducedMotion}
          />

          {/* Countdown + control guide: the only thing between the players and
              the run, and it never covers the result. */}
          {phase === "countdown" && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-2xl bg-[#07080b]/62 p-2 backdrop-blur-[2px]">
              <div className="w-full max-w-sm text-center">
                <p className="text-[9px] font-black uppercase tracking-[0.42em] text-cyan-300/70 sm:text-[10px]">Get ready</p>
                <p
                  key={countdown}
                  className="mt-0.5 text-6xl font-black tabular-nums tracking-tight text-white drop-shadow-[0_0_28px_rgba(34,211,238,0.55)] sm:text-8xl"
                >
                  {countdown > 0 ? countdown : "GO"}
                </p>
                <div className="mx-auto mt-2 max-w-[16rem] rounded-xl border border-white/10 bg-black/35 px-3 py-2 text-left">
                  <p className="text-[9px] font-black uppercase tracking-[0.22em] text-white/35">Controls</p>
                  <div className="mt-1.5 flex items-center justify-between text-[11px] text-white/65">
                    <span className="flex items-center gap-1">
                      <kbd className="rounded border border-white/15 bg-white/[0.07] px-1.5 py-0.5 font-mono text-[10px]">Space</kbd>
                      <kbd className="rounded border border-white/15 bg-white/[0.07] px-1.5 py-0.5 font-mono text-[10px]">↑</kbd>
                    </span>
                    <span>Jump crates &amp; spikes</span>
                  </div>
                  <div className="mt-1 flex items-center justify-between text-[11px] text-white/65">
                    <kbd className="rounded border border-white/15 bg-white/[0.07] px-1.5 py-0.5 font-mono text-[10px]">↓</kbd>
                    <span>Duck under the beam</span>
                  </div>
                  <p className="mt-1.5 text-[10px] text-white/35 sm:hidden">Or use the JUMP / DUCK buttons below.</p>
                </div>
              </div>
            </div>
          )}

          {phase === "connecting" && (
            <div className="absolute inset-0 flex items-center justify-center rounded-2xl bg-[#07080b]/70">
              <p className="animate-pulse motion-reduce:animate-none text-[10px] font-black uppercase tracking-[0.32em] text-white/40">
                Contacting the server…
              </p>
            </div>
          )}

          {feed === "reconnecting" && (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 rounded-b-2xl border-t border-amber-400/25 bg-amber-400/10 px-3 py-1.5 text-center text-[10px] font-bold uppercase tracking-[0.16em] text-amber-200/90">
              Reconnecting — the last confirmed frame is shown
            </div>
          )}

          {/* ── Results ───────────────────────────────────────────────── */}
          {finished && outcome && snapshot && (
            <div className="absolute inset-0 flex items-center justify-center overflow-y-auto rounded-2xl bg-[#07080b]/90 p-2 backdrop-blur-sm sm:p-4">
              <motion.div
                initial={reducedMotion ? false : { opacity: 0, y: 14, scale: 0.985 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                transition={reducedMotion ? { duration: 0 } : { type: "spring", stiffness: 300, damping: 26 }}
                aria-live="polite"
                className={`w-full max-w-md rounded-2xl border p-3.5 text-center sm:p-5 ${
                  outcome === "win"
                    ? "border-emerald-400/40 bg-gradient-to-b from-[#0b2418] to-[#07160f]"
                    : outcome === "loss"
                      ? "border-red-400/35 bg-gradient-to-b from-[#251014] to-[#14080b]"
                      : "border-cyan-400/35 bg-gradient-to-b from-[#0a1a2b] to-[#071019]"
                }`}
              >
                <p
                  className={`text-[9px] font-black uppercase tracking-[0.4em] sm:text-[10px] ${
                    outcome === "win" ? "text-emerald-300/80" : outcome === "loss" ? "text-red-300/80" : "text-cyan-300/80"
                  }`}
                >
                  {outcome === "win" ? "Victory" : outcome === "loss" ? "Defeat" : "Draw"}
                </p>
                <h2 className="mt-1.5 text-3xl font-black tracking-tight sm:text-5xl">
                  {outcome === "win" ? "You survived" : outcome === "loss" ? "Run ended" : "Dead heat"}
                </h2>
                <p className="mt-1 text-[11px] text-white/50 sm:text-xs">{REASON_COPY[finished.reason] ?? "Match complete."}</p>

                <div className="mt-3 grid grid-cols-2 gap-1.5 text-left sm:gap-2">
                  {[snapshot.you, snapshot.opponent].map((side) => (
                    <div key={side.seat} className="rounded-xl border border-white/10 bg-black/30 p-2.5">
                      <p className="truncate text-[9px] font-bold uppercase tracking-[0.16em] text-white/45">{side.name}</p>
                      <p className="mt-0.5 font-mono text-base font-black tabular-nums text-white sm:text-lg">
                        {formatSeconds(side.survivalMs)}
                      </p>
                      <p className="text-[10px] text-white/45">{formatDistance(side.distance)} travelled</p>
                      <p
                        className={`mt-0.5 text-[9px] font-black uppercase tracking-[0.16em] ${
                          side.alive ? "text-emerald-300/80" : "text-white/30"
                        }`}
                      >
                        {side.alive ? "alive at the end" : "crashed"}
                      </p>
                    </div>
                  ))}
                </div>

                <div className="mt-3 flex flex-col gap-1.5 sm:flex-row sm:gap-2">
                  <button
                    type="button"
                    onClick={() => router.push("/games/last-run/play?queue=1")}
                    className="flex-1 rounded-xl bg-cyan-400 py-2.5 text-[10px] font-black uppercase tracking-[0.18em] text-[#04121a] transition hover:bg-cyan-300 sm:text-[11px]"
                  >
                    Run it back
                  </button>
                  <Link
                    href="/games/last-run/play"
                    className="flex-1 rounded-xl border border-white/15 bg-white/[0.03] py-2.5 text-center text-[10px] font-black uppercase tracking-[0.18em] text-white/70 transition hover:border-white/30 hover:text-white sm:text-[11px]"
                  >
                    Return to lobby
                  </Link>
                </div>
                <RatingNote state={settleState} rating={rating} />
                <p className="mt-1 text-[9px] text-white/25">
                  A rematch mints a new seed — this result is never reused.
                </p>
              </motion.div>
            </div>
          )}
        </div>

        {/* ── Touch controls (always comfortable, never tiny) ─────────── */}
        <div className="mt-2.5 grid grid-cols-2 gap-2 sm:hidden">
          <button
            type="button"
            aria-label="Jump"
            {...controls.controlProps("jump")}
            disabled={phase !== "racing"}
            className={`select-none rounded-2xl border py-4 text-xs font-black uppercase tracking-[0.2em] transition active:scale-[0.99] disabled:opacity-35 ${
              controls.held.jump
                ? "border-cyan-300 bg-cyan-400/30 text-cyan-50"
                : "border-cyan-400/35 bg-cyan-400/10 text-cyan-200"
            }`}
          >
            Jump
          </button>
          <button
            type="button"
            aria-label="Duck"
            {...controls.controlProps("duck")}
            disabled={phase !== "racing"}
            className={`select-none rounded-2xl border py-4 text-xs font-black uppercase tracking-[0.2em] transition active:scale-[0.99] disabled:opacity-35 ${
              controls.held.duck
                ? "border-violet-300 bg-violet-400/30 text-violet-50"
                : "border-violet-400/35 bg-violet-400/10 text-violet-200"
            }`}
          >
            Duck
          </button>
        </div>

        {/* ── Desktop command strip + race facts ──────────────────────── */}
        <footer className="mt-2.5 hidden items-center justify-between rounded-xl border border-white/[0.07] bg-[#0a0c11] px-4 py-2 sm:flex">
          <div className="flex items-center gap-5 text-[10px] font-bold uppercase tracking-[0.18em] text-white/35">
            <span className="flex items-center gap-1.5">
              <kbd className="rounded border border-white/15 bg-white/[0.06] px-1.5 py-0.5 font-mono text-[10px] text-white/70">Space</kbd>
              <kbd className="rounded border border-white/15 bg-white/[0.06] px-1.5 py-0.5 font-mono text-[10px] text-white/70">↑</kbd>
              Jump
            </span>
            <span className="flex items-center gap-1.5">
              <kbd className="rounded border border-white/15 bg-white/[0.06] px-1.5 py-0.5 font-mono text-[10px] text-white/70">↓</kbd>
              Duck
            </span>
            <span className="hidden text-white/20 lg:inline">·</span>
            <span className="hidden lg:inline">Both lanes · one seed</span>
          </div>
          <div className="flex items-center gap-4 font-mono text-[10px] uppercase tracking-[0.14em] text-white/30">
            <span>Seed {snapshot ? snapshot.seed.toString(16).padStart(8, "0") : "········"}</span>
            <span className="text-white/15">|</span>
            <span>Tick {snapshot ? snapshot.tick : 0}</span>
          </div>
        </footer>

        {!snapshot && !error && (
          <div className="mt-2.5 grid gap-2 sm:grid-cols-3" aria-hidden="true">
            {[0, 1, 2].map((index) => (
              <div key={index} className="h-10 animate-pulse rounded-xl bg-white/[0.03]" />
            ))}
          </div>
        )}
      </main>

      <Footer />
    </div>
  );
}
