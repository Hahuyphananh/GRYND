"use client";

// src/app/casino/last-run/PageClient.tsx
//
// LAST RUN — the lobby.
//
// ── HONESTY RULE ──────────────────────────────────────────────────────────
//
// Every state on this page comes from the real queue endpoint. There is no
// mock opponent, no scripted "opponent found", and no fabricated countdown: if
// the API is unreachable the page says so and offers a retry. A second player
// is required for the match states, and that is by design.
//
// ── STATES ────────────────────────────────────────────────────────────────
//
//   idle        → rules + "Find a match"
//   searching   → "searching" panel with cancel + elapsed time
//   found       → opponent found (real pairing), then the match page
//   expired     → the server pruned the entry (QUEUE_TTL_MS passed); search again
//   error       → retry, with the server's own message
//   signed out  → sign-in CTA (the queue endpoint is session-only)

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useUser } from "@clerk/nextjs";
import { useCallback, useEffect, useRef, useState } from "react";

import NavigationBar from "../../../components/navigation-bar";
import Footer from "../../../components/Footer";

type Status = "idle" | "searching" | "found" | "expired" | "error";

const RULES = [
  {
    title: "One course, two runners",
    body: "The server mints one seed per match. Both players run the exact same obstacle sequence, spacing and speed curve — only the timing is yours.",
    accent: "cyan",
  },
  {
    title: "First crash loses",
    body: "Crates and spikes are jumped. Beams are ducked. Touch any of them and your run ends. If both bodies fail on the same simulation tick, the match is a draw.",
    accent: "violet",
  },
  {
    title: "The track accelerates",
    body: "Speed rises from 260 to 640 px/s over the first half-minute. The obstacle gap tightens with it, but never below a readable reaction window.",
    accent: "cyan",
  },
] as const;

const CONTROLS = [
  { keys: ["Space", "↑"], label: "Jump" },
  { keys: ["↓"], label: "Duck" },
] as const;

function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export default function PageClient({ autoQueue = false }: { autoQueue?: boolean }) {
  const { isLoaded, isSignedIn, user } = useUser();
  const router = useRouter();

  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [waitingSince, setWaitingSince] = useState<number | null>(null);
  const [waitingCount, setWaitingCount] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [matchedId, setMatchedId] = useState<string | null>(null);
  const autoQueued = useRef(false);

  const displayName = user?.username || user?.fullName || "Runner";

  // One poll loop while searching. It stops the moment the component leaves
  // the searching state, so a lobby tab never keeps a request alive.
  useEffect(() => {
    if (status !== "searching") return undefined;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      try {
        const res = await fetch("/api/last-run/queue", { cache: "no-store", credentials: "include" });
        const data = await res.json().catch(() => null);
        if (cancelled) return;
        if (res.status === 401) {
          setStatus("error");
          setError("Sign in to join the queue.");
          return;
        }
        if (!res.ok || !data?.success) {
          setStatus("error");
          setError(data?.error || "The queue is unavailable right now.");
          return;
        }
        if (typeof data.waiting === "number") setWaitingCount(data.waiting);
        if (data.status === "matched" && typeof data.matchId === "string") {
          setMatchedId(data.matchId);
          setStatus("found");
          return;
        }
        if (data.status === "idle") {
          // The server prunes a queue entry after QUEUE_TTL_MS and then reports
          // `idle`. Without this branch the panel would spin "Finding a rival"
          // forever on a search that no longer exists.
          setStatus("expired");
          return;
        }
        timer = setTimeout(poll, 1200);
      } catch {
        if (cancelled) return;
        setStatus("error");
        setError("Network unavailable. Check your connection and retry.");
      }
    };

    poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [status]);

  useEffect(() => {
    if (status !== "searching") return undefined;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [status]);

  const join = useCallback(async () => {
    if (!isSignedIn) return;
    setError(null);
    setStatus("searching");
    setWaitingSince(Date.now());
    try {
      const res = await fetch("/api/last-run/queue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ name: displayName }),
      });
      const data = await res.json().catch(() => null);
      if (res.status === 401) {
        setStatus("error");
        setError("Sign in to join the queue.");
        return;
      }
      if (!res.ok || !data?.success) {
        setStatus("error");
        setError(data?.error || "Could not join the queue.");
        return;
      }
      if (typeof data.waiting === "number") setWaitingCount(data.waiting);
      if (data.status === "matched" && typeof data.matchId === "string") {
        setMatchedId(data.matchId);
        setStatus("found");
      }
    } catch {
      setStatus("error");
      setError("Network unavailable. Check your connection and retry.");
    }
  }, [displayName, isSignedIn]);

  const cancel = useCallback(async () => {
    setStatus("idle");
    setWaitingSince(null);
    try {
      await fetch("/api/last-run/queue", { method: "DELETE", credentials: "include" });
    } catch {
      // Server-side TTL pruning removes a stale entry regardless.
    }
  }, []);

  // Arriving from a finished match with `?queue=1` re-queues once.
  useEffect(() => {
    if (!autoQueue || autoQueued.current || !isLoaded || !isSignedIn) return;
    autoQueued.current = true;
    void join();
  }, [autoQueue, isLoaded, isSignedIn, join]);

  useEffect(() => {
    if (status !== "found" || !matchedId) return undefined;
    const timer = setTimeout(() => router.push(`/games/last-run/${matchedId}`), 1100);
    return () => clearTimeout(timer);
  }, [matchedId, router, status]);

  const searchingFor = waitingSince ? now - waitingSince : 0;

  return (
    <div className="min-h-screen bg-[#07080b] text-white">
      <NavigationBar />

      <main className="mx-auto w-full max-w-6xl px-4 pb-16 pt-8 sm:px-6 lg:pt-12">
        {/* ── Hero ─────────────────────────────────────────────────────── */}
        <section className="grid gap-8 lg:grid-cols-[1.15fr_0.85fr] lg:items-end">
          <div>
            <p className="text-[11px] font-black uppercase tracking-[0.42em] text-cyan-300/70">GRYND · 1v1 reflex duel</p>
            <h1 className="mt-3 text-5xl font-black leading-[0.95] tracking-tight sm:text-6xl lg:text-7xl">
              LAST
              <span className="ml-3 bg-gradient-to-r from-cyan-300 to-violet-300 bg-clip-text text-transparent">RUN</span>
            </h1>
            <p className="mt-4 max-w-xl text-sm leading-relaxed text-white/60 sm:text-base">
              Two runners. One seeded course. The first crash ends your run — and the match. Survive longer than your
              rival, or read the track better at speed.
            </p>

            <div className="mt-6 flex flex-wrap items-center gap-3">
              {!isLoaded ? (
                <div className="h-12 w-44 animate-pulse rounded-xl bg-white/5" aria-hidden="true" />
              ) : !isSignedIn ? (
                <Link
                  href="/sign-in?redirect_url=%2Fgames%2Flast-run%2Fplay"
                  className="inline-flex h-12 items-center justify-center rounded-xl bg-cyan-400 px-6 text-sm font-black uppercase tracking-[0.14em] text-[#04121a] transition hover:bg-cyan-300"
                >
                  Sign in to run
                </Link>
              ) : (
                <button
                  type="button"
                  onClick={join}
                  disabled={status === "searching" || status === "found"}
                  className="inline-flex h-12 items-center justify-center rounded-xl bg-cyan-400 px-6 text-sm font-black uppercase tracking-[0.14em] text-[#04121a] transition hover:bg-cyan-300 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {status === "searching" ? "Searching…" : "Find a match"}
                </button>
              )}
              <Link
                href="/games"
                className="inline-flex h-12 items-center justify-center rounded-xl border border-white/12 bg-white/[0.03] px-5 text-sm font-bold text-white/70 transition hover:border-white/25 hover:text-white"
              >
                All games
              </Link>
              <span className="inline-flex items-center gap-2 rounded-full border border-white/10 px-3 py-1.5 text-[11px] font-semibold text-white/40">
                <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                Free · unranked while in beta
              </span>
            </div>

            <div className="mt-5 flex flex-wrap items-center gap-x-6 gap-y-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-white/35">
              {CONTROLS.map((control) => (
                <span key={control.label} className="inline-flex items-center gap-2">
                  {control.keys.map((key) => (
                    <kbd
                      key={key}
                      className="rounded-md border border-white/15 bg-white/[0.06] px-2 py-1 font-mono text-[10px] text-white/70"
                    >
                      {key}
                    </kbd>
                  ))}
                  {control.label}
                </span>
              ))}
              <span className="hidden sm:inline">Touch controls on mobile</span>
            </div>
          </div>

          {/* ── Queue panel ────────────────────────────────────────────── */}
          <aside className="relative overflow-hidden rounded-2xl border border-white/10 bg-[#0b0d12] p-5 shadow-[0_30px_80px_-50px_rgba(34,211,238,0.55)]">
            <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-cyan-400/60 to-transparent" />

            {status === "searching" ? (
              <div aria-live="polite">
                <div className="flex items-center justify-between">
                  <p className="text-[11px] font-black uppercase tracking-[0.28em] text-cyan-300/80">Searching</p>
                  <span className="font-mono text-xs text-white/40">{formatClock(searchingFor)}</span>
                </div>
                <div className="mt-4 flex items-center gap-3">
                  <span className="relative flex h-9 w-9 items-center justify-center">
                    <span className="absolute inset-0 animate-ping rounded-full bg-cyan-400/25" />
                    <span className="relative h-3 w-3 rounded-full bg-cyan-300" />
                  </span>
                  <div>
                    <p className="text-base font-bold">Finding a rival</p>
                    <p className="text-xs text-white/45">
                      {waitingCount && waitingCount > 1
                        ? `${waitingCount} players in the queue`
                        : "Waiting for a second runner"}
                    </p>
                  </div>
                </div>
                <p className="mt-4 text-xs leading-relaxed text-white/45">
                  Your place is held server-side. If nobody joins within 90 seconds the entry expires and you can retry.
                </p>
                <button
                  type="button"
                  onClick={cancel}
                  className="mt-5 w-full rounded-xl border border-white/15 bg-white/[0.02] py-2.5 text-xs font-black uppercase tracking-[0.2em] text-white/70 transition hover:border-red-400/50 hover:text-red-300"
                >
                  Cancel search
                </button>
              </div>
            ) : status === "found" ? (
              <div aria-live="polite">
                <p className="text-[11px] font-black uppercase tracking-[0.28em] text-emerald-300/80">Opponent found</p>
                <p className="mt-3 text-2xl font-black tracking-tight">Rival locked in</p>
                <p className="mt-1 text-xs text-white/50">Loading the course and the server-stamped start…</p>
                <div className="mt-4 h-1 w-full overflow-hidden rounded-full bg-white/10">
                  <div className="h-full w-1/3 rounded-full bg-emerald-400" />
                </div>
              </div>
            ) : status === "error" || status === "expired" ? (
              <div aria-live="assertive">
                <p className="text-[11px] font-black uppercase tracking-[0.28em] text-red-300/80">
                  {status === "expired" ? "Search expired" : "Queue unavailable"}
                </p>
                <p className="mt-3 text-sm leading-relaxed text-white/65">
                  {status === "expired"
                    ? "Your place was held for 90 seconds and expired before a rival joined. Nothing was recorded — start a new search whenever you are ready."
                    : error}
                </p>
                <button
                  type="button"
                  onClick={() => {
                    setStatus("idle");
                    void join();
                  }}
                  disabled={!isSignedIn}
                  className="mt-5 w-full rounded-xl border border-white/15 bg-white/[0.03] py-2.5 text-xs font-black uppercase tracking-[0.2em] text-white/75 transition hover:border-cyan-400/60 hover:text-cyan-200 disabled:opacity-40"
                >
                  {status === "expired" ? "Search again" : "Retry"}
                </button>
              </div>
            ) : (
              <div>
                <p className="text-[11px] font-black uppercase tracking-[0.28em] text-white/35">The match</p>
                <dl className="mt-4 space-y-3 text-sm">
                  {[
                    ["Mode", "1v1 · simultaneous"],
                    ["Course", "Seeded · shared"],
                    ["Ends", "First crash"],
                    ["Queue", "90 s hold"],
                  ].map(([label, value]) => (
                    <div key={label} className="flex items-center justify-between border-b border-white/[0.06] pb-2.5">
                      <dt className="text-white/40">{label}</dt>
                      <dd className="font-semibold text-white/85">{value}</dd>
                    </div>
                  ))}
                </dl>
                <p className="mt-4 text-xs leading-relaxed text-white/40">
                  Matchmaking pairs the two longest-waiting players. Nothing is wagered, and no result is written until
                  the server has simulated both runs.
                </p>
              </div>
            )}
          </aside>
        </section>

        {/* ── Rules ───────────────────────────────────────────────────── */}
        <section className="mt-12 lg:mt-16">
          <div className="flex items-baseline justify-between">
            <h2 className="text-[11px] font-black uppercase tracking-[0.32em] text-white/40">How a run works</h2>
            <span className="hidden text-[11px] font-semibold uppercase tracking-[0.2em] text-white/25 sm:inline">
              Fixed 60 Hz simulation
            </span>
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            {RULES.map((rule, index) => (
              <article
                key={rule.title}
                className="rounded-2xl border border-white/10 bg-white/[0.02] p-5 transition hover:border-white/20"
              >
                <span
                  className="inline-flex h-7 w-7 items-center justify-center rounded-lg border text-[11px] font-black"
                  style={{
                    color: rule.accent === "cyan" ? "#22d3ee" : "#a78bfa",
                    borderColor: rule.accent === "cyan" ? "rgba(34,211,238,0.35)" : "rgba(167,139,250,0.35)",
                    background: rule.accent === "cyan" ? "rgba(34,211,238,0.08)" : "rgba(167,139,250,0.08)",
                  }}
                >
                  0{index + 1}
                </span>
                <h3 className="mt-3 text-base font-black tracking-tight text-white/95">{rule.title}</h3>
                <p className="mt-2 text-[13px] leading-relaxed text-white/50">{rule.body}</p>
              </article>
            ))}
          </div>
        </section>

        {/* ── The fine print, stated plainly ──────────────────────────── */}
        <section className="mt-10 grid gap-3 rounded-2xl border border-white/[0.07] bg-[#0a0c11] p-5 sm:grid-cols-2 lg:grid-cols-4">
          {[
            ["Fair seed", "One cryptographic seed per match, generated server-side."],
            ["Server authority", "Clients send jump/duck only. The server decides collisions and the winner."],
            ["No advantages", "No power-ups, boosts or purchases. Every run starts identical."],
            ["Honest results", "A disconnect forfeits. A draw is a draw — no coin flip."],
          ].map(([title, body]) => (
            <div key={title}>
              <p className="text-[11px] font-black uppercase tracking-[0.18em] text-white/45">{title}</p>
              <p className="mt-1.5 text-xs leading-relaxed text-white/35">{body}</p>
            </div>
          ))}
        </section>
      </main>

      <Footer />
    </div>
  );
}
