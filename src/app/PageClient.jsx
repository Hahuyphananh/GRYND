"use client";

// src/app/PageClient.jsx
//
// GRYND's home page — the Solitaire lobby.
//
// This is deliberately not a marketing page with a link to a lobby somewhere
// else: the real lobby (src/components/solitaire-duel/SolitaireLobby) is
// mounted right here, with the existing matchmaking, practice, open-table,
// resume and cancel actions. Everything above and below it is support:
//
//   * the hero says what GRYND is in one screen;
//   * the lobby is the product (ranked / practice / real queue state);
//   * the dashboard is the player's own Solitaire record, from /api/user-stats,
//     /api/get-user-tokens and /api/solitaire-duel/lobby;
//   * the ranking preview is the public Solitaire board.
//
// No number on this page is invented: an unknown stat renders as a dash, an
// empty list says so, and a signed-out visitor is shown a sign-in path rather
// than somebody else's record.

import { useEffect, useState } from "react";
import Link from "next/link";
import { useAuth, useUser } from "@clerk/nextjs";
import NavigationBar from "../components/navigation-bar";
import Footer from "../components/Footer";
import SolitaireLobby from "../components/solitaire-duel/SolitaireLobby";
import ReportEntryButton from "../components/reports/ReportEntryButton";
import { clearSessionArtifacts } from "../lib/security/sessionCleanup";

const formatDate = (ms) => {
  if (!ms) return "";
  return new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" });
};

const outcomeLabel = (outcome) => {
  if (outcome === "win") return "Win";
  if (outcome === "loss") return "Loss";
  if (outcome === "draw") return "Draw";
  return "In progress";
};

const outcomeTone = (outcome) => {
  if (outcome === "win") return "text-emerald-300";
  if (outcome === "loss") return "text-rose-300";
  if (outcome === "draw") return "text-amber-200";
  return "text-sky-300";
};

export default function MainComponent({ adSlot = null, hilltopSlot = null }) {
  const { isLoaded, isSignedIn, signOut } = useAuth();
  const { user } = useUser();

  const [showTermsModal, setShowTermsModal] = useState(false);
  const [termsLoading, setTermsLoading] = useState(true);
  const [stats, setStats] = useState(null);
  const [trophies, setTrophies] = useState(null);
  const [board, setBoard] = useState(null);
  const [recent, setRecent] = useState([]);

  // Terms gate — unchanged from the previous home page: a signed-in player who
  // has not accepted is asked before they keep playing.
  useEffect(() => {
    if (!isSignedIn || !isLoaded) return;
    let cancelled = false;
    fetch("/api/user/terms-status")
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled && data.success && !data.termsAccepted) {
          setShowTermsModal(true);
        }
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setTermsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isSignedIn, isLoaded]);

  // The public Solitaire ranking preview. Works signed out — it is the same
  // board /classement renders, just five rows of it.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/leaderboard/game?game=solitaire-duel&limit=5", { cache: "no-store" })
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled && Array.isArray(data?.items)) setBoard(data);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // The player's own record, from the platform's authoritative counters.
  useEffect(() => {
    if (!isSignedIn) {
      setStats(null);
      setTrophies(null);
      setRecent([]);
      return;
    }
    let cancelled = false;

    fetch("/api/user-stats", { credentials: "include" })
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled && data?.success) setStats(data.stats);
      })
      .catch(() => {});

    // Total trophies come from the same payload the navbar chip reads, so the
    // two surfaces can never disagree.
    fetch("/api/get-user-tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
    })
      .then((res) => res.json())
      .then((data) => {
        if (cancelled || !data?.success) return;
        const total = Number(data.data?.totalTrophies);
        setTrophies(Number.isFinite(total) && total >= 0 ? total : 0);
      })
      .catch(() => {});

    fetch("/api/solitaire-duel/lobby", { cache: "no-store", credentials: "include" })
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled && data?.success && Array.isArray(data.data?.recent)) {
          setRecent(data.data.recent);
        }
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [isSignedIn]);

  const handleAcceptTerms = async () => {
    try {
      const res = await fetch("/api/user/accept-terms", { method: "POST" });
      const data = await res.json();
      if (data.success) setShowTermsModal(false);
    } catch {
      // the gate persists until the next successful accept
    }
  };

  const handleRejectTerms = async () => {
    if (signOut) {
      clearSessionArtifacts();
      await signOut();
    }
  };

  const solitaireRating = stats?.ratings?.["solitaire-duel"] ?? null;
  const rating = Number.isFinite(Number(solitaireRating?.rating))
    ? Number(solitaireRating.rating)
    : null;
  const games = Number.isFinite(Number(solitaireRating?.gamesRated))
    ? Number(solitaireRating.gamesRated)
    : null;
  const winRate = Number.isFinite(Number(solitaireRating?.winRate))
    ? Number(solitaireRating.winRate)
    : null;

  const tiles = [
    {
      label: "Solitaire Elo",
      value: rating === null ? "—" : rating.toLocaleString(),
      hint:
        solitaireRating?.provisional
          ? `Provisional · ${Number(solitaireRating.provisionalGamesRemaining ?? 0)} placement games left`
          : "Rated ladder",
    },
    {
      label: "Trophies",
      value: trophies === null ? "—" : trophies.toLocaleString(),
      hint: "Across every archived and active game",
    },
    {
      label: "Ranked games",
      value: games === null ? "—" : games.toLocaleString(),
      hint: "Settled Solitaire matches",
    },
    {
      label: "Win rate",
      value: winRate === null ? "—" : `${winRate}%`,
      hint: "Decided Solitaire matches only",
    },
  ];

  const features = [
    {
      title: "One deal, two players",
      body: "The server mints one deterministic Klondike deal and gives both seats the exact same starting position. Nobody gets luckier cards.",
    },
    {
      title: "Free ranked play",
      body: "No stake, no entry fee, no tokens. Ranked Solitaire moves your Elo rating and your trophy ladder instead.",
    },
    {
      title: "Server-authoritative",
      body: "Every move, the clock, the progress and the result are validated and held by the server. The browser never decides a match.",
    },
  ];

  return (
    <div className="relative min-h-screen bg-[#05070d] pb-24 text-white md:pb-0">
      <NavigationBar currentPath="/" />

      <main className="mx-auto max-w-6xl px-4 pt-24 sm:px-6 md:pt-28">
        {/* ── Hero ──────────────────────────────────────────────────────── */}
        <section className="border-b border-white/10 pb-8 pt-4 sm:pb-10">
          <p className="text-[11px] font-black uppercase tracking-[0.4em] text-cyan-300/80">
            GRYND · competitive Solitaire
          </p>
          <h1 className="mt-3 max-w-3xl text-4xl font-black leading-[0.95] tracking-tight sm:text-5xl lg:text-6xl">
            The competitive home{" "}
            <span className="text-cyan-300">of Solitaire</span>
          </h1>
          <p className="mt-4 max-w-2xl text-sm leading-relaxed text-white/60 sm:text-base">
            Classic Klondike, three ways: race a real person on the ranked
            ladder, play a timed game on your own, or take on the same daily deal
            as everyone else. Every ranked result is validated server-side, and
            ranked play is free — the only thing at stake is your rating.
          </p>
          <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
            <a
              href="#lobby"
              className="inline-flex items-center gap-2 rounded-lg bg-cyan-400 px-5 py-2.5 font-bold text-[#04121a] transition hover:bg-cyan-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-200 focus-visible:ring-offset-2 focus-visible:ring-offset-[#05070d]"
            >
              Play ranked
            </a>
            <a
              href="#practice"
              className="text-white/70 underline underline-offset-4 transition hover:text-white"
            >
              Practise vs AI
            </a>
            <Link href="/games/solitaire-duel" className="text-white/70 underline underline-offset-4 transition hover:text-white">
              Rules &amp; strategy
            </Link>
            <Link href="/classement" className="text-white/70 underline underline-offset-4 transition hover:text-white">
              Leaderboard
            </Link>
          </div>
          <p className="mt-4 text-xs font-semibold uppercase tracking-[0.16em] text-white/35">
            Real opponents · Free ranked ladder · Server-verified results
          </p>
        </section>

        {/* ── Three ways to play ────────────────────────────────────────── */}
        <section className="mt-8" aria-labelledby="modes-heading">
          <h2
            id="modes-heading"
            className="text-[11px] font-black uppercase tracking-[0.32em] text-white/40"
          >
            Three ways to play
          </h2>
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            <a
              href="#lobby"
              className="group rounded-2xl border border-cyan-400/30 bg-cyan-400/[0.06] p-5 transition hover:border-cyan-300/60 hover:bg-cyan-400/10"
            >
              <p className="text-[10px] font-black uppercase tracking-[0.2em] text-cyan-300">
                Ranked PvP
              </p>
              <h3 className="mt-2 text-lg font-bold text-white">Race a real person</h3>
              <p className="mt-1 text-sm leading-relaxed text-white/55">
                The main competitive mode. Same deal, Elo on the line, never an AI
                opponent.
              </p>
              <span className="mt-3 inline-block text-sm font-semibold text-cyan-300">
                Find a match →
              </span>
            </a>
            <Link
              href="/solitaire"
              className="group rounded-2xl border border-white/10 bg-white/[0.02] p-5 transition hover:border-white/25 hover:bg-white/[0.05]"
            >
              <p className="text-[10px] font-black uppercase tracking-[0.2em] text-white/45">
                Solo Solitaire
              </p>
              <h3 className="mt-2 text-lg font-bold text-white">Play alone, right now</h3>
              <p className="mt-1 text-sm leading-relaxed text-white/55">
                Classic Klondike with a timer, undo and personal bests. No queue,
                no opponent, no Elo.
              </p>
              <span className="mt-3 inline-block text-sm font-semibold text-white/70">
                Start solo →
              </span>
            </Link>
            <a
              href="#practice"
              className="group rounded-2xl border border-white/10 bg-white/[0.02] p-5 transition hover:border-white/25 hover:bg-white/[0.05]"
            >
              <p className="text-[10px] font-black uppercase tracking-[0.2em] text-white/45">
                Practice vs AI
              </p>
              <h3 className="mt-2 text-lg font-bold text-white">Learn the rhythm</h3>
              <p className="mt-1 text-sm leading-relaxed text-white/55">
                Unrated games against the built-in bot, with selectable
                difficulty. Clearly practice, never ranked.
              </p>
              <span className="mt-3 inline-block text-sm font-semibold text-white/70">
                Practise →
              </span>
            </a>
          </div>
        </section>

        {/* ── Daily Challenge ───────────────────────────────────────────── */}
        <section className="mt-4" aria-labelledby="daily-heading">
          <Link
            href="/daily"
            className="flex flex-col gap-4 rounded-2xl border border-amber-300/30 bg-gradient-to-r from-amber-300/[0.10] via-amber-300/[0.04] to-transparent p-5 transition hover:border-amber-200/50 sm:flex-row sm:items-center sm:justify-between"
          >
            <div>
              <p className="text-[10px] font-black uppercase tracking-[0.28em] text-amber-300">
                Featured · Daily Challenge
              </p>
              <h2 id="daily-heading" className="mt-2 text-xl font-black text-white sm:text-2xl">
                One deal. Everyone. Every day.
              </h2>
              <p className="mt-1 max-w-xl text-sm leading-relaxed text-white/60">
                The same deterministic Klondike deal for every player, fixed by the
                UTC date. One official result per day — refresh-proof and
                reroll-proof.
              </p>
            </div>
            <span className="shrink-0 rounded-lg bg-amber-300 px-5 py-2.5 text-sm font-bold text-[#1a1204]">
              Play today&apos;s deal →
            </span>
          </Link>
        </section>

        {/* ── The lobby ─────────────────────────────────────────────────── */}
        <section id="lobby" className="scroll-mt-28 pt-8" aria-labelledby="lobby-heading">
          <h2
            id="lobby-heading"
            className="text-[11px] font-black uppercase tracking-[0.32em] text-white/40"
          >
            Play now
          </h2>
          <div id="practice" className="mt-4 scroll-mt-28">
            <SolitaireLobby variant="home" />
          </div>
        </section>

        {/* ── Player dashboard ──────────────────────────────────────────── */}
        <section id="dashboard" className="mt-14 scroll-mt-28" aria-labelledby="dashboard-heading">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <h2
              id="dashboard-heading"
              className="text-[11px] font-black uppercase tracking-[0.32em] text-white/40"
            >
              Your Solitaire
            </h2>
            {isSignedIn && (
              <Link href="/profil" className="text-xs font-semibold text-cyan-300 hover:text-cyan-200">
                Full profile →
              </Link>
            )}
          </div>

          {!isLoaded ? (
            <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-busy="true">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="h-24 animate-pulse rounded-2xl border border-white/10 bg-white/[0.02]" />
              ))}
            </div>
          ) : !isSignedIn ? (
            <div className="mt-4 flex flex-col gap-4 rounded-2xl border border-white/10 bg-white/[0.03] p-5 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="font-bold text-white">Carry a rating, not just a score</p>
                <p className="mt-1 text-sm leading-relaxed text-white/55">
                  An account keeps your Solitaire Elo, trophies, match history and
                  placement progress. Practice against the bot works without one.
                </p>
              </div>
              <div className="flex shrink-0 gap-2">
                <Link
                  href="/sign-up"
                  className="rounded-lg bg-cyan-400 px-4 py-2 text-sm font-bold text-[#04121a] transition hover:bg-cyan-300"
                >
                  Create account
                </Link>
                <Link
                  href="/sign-in"
                  className="rounded-lg border border-white/15 px-4 py-2 text-sm font-semibold text-white/80 transition hover:border-white/30 hover:text-white"
                >
                  Sign in
                </Link>
              </div>
            </div>
          ) : (
            <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {tiles.map((tile) => (
                <div key={tile.label} className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
                  <p className="text-[10px] font-black uppercase tracking-[0.22em] text-white/35">
                    {tile.label}
                  </p>
                  <p className="mt-1.5 text-2xl font-black tabular-nums text-white">{tile.value}</p>
                  <p className="mt-1 text-[11px] leading-relaxed text-white/40">{tile.hint}</p>
                </div>
              ))}
            </div>
          )}

          <div className="mt-4 grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
            {/* Recent matches — the caller's own rows, never a sample. */}
            <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
              <div className="flex items-baseline justify-between gap-3">
                <h3 className="text-sm font-bold text-white/90">Recent matches</h3>
                <Link href="/profil" className="text-[11px] font-semibold text-white/45 hover:text-white/80">
                  History
                </Link>
              </div>
              {!isSignedIn ? (
                <p className="mt-3 text-sm text-white/40">Sign in to see your match history.</p>
              ) : recent.length === 0 ? (
                <p className="mt-3 text-sm text-white/40">
                  No matches yet. Your first ranked game will appear here.
                </p>
              ) : (
                <ul className="mt-3 divide-y divide-white/5">
                  {recent.map((match) => (
                    <li key={match.matchId} className="flex items-center justify-between gap-3 py-2.5">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-white/85">
                          {match.opponent}
                        </p>
                        <p className="text-[11px] text-white/35">
                          {formatDate(match.endedAtMs ?? match.createdAtMs)}
                          {match.isAi ? " · Practice · unrated" : " · Ranked"}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-3">
                        <span className={`text-xs font-black uppercase tracking-wider ${outcomeTone(match.outcome)}`}>
                          {outcomeLabel(match.outcome)}
                        </span>
                        <Link
                          href={`/casino/solitaire-duel/${match.matchId}`}
                          className="text-[11px] font-semibold text-white/45 hover:text-white/80"
                        >
                          Open
                        </Link>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* Public Solitaire leaderboard preview. */}
            <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
              <div className="flex items-baseline justify-between gap-3">
                <h3 className="text-sm font-bold text-white/90">Solitaire leaderboard</h3>
                <Link href="/classement" className="text-[11px] font-semibold text-cyan-300 hover:text-cyan-200">
                  Full board
                </Link>
              </div>
              {!board ? (
                <div className="mt-3 space-y-2" aria-busy="true">
                  {[0, 1, 2, 3, 4].map((i) => (
                    <div key={i} className="h-7 animate-pulse rounded bg-white/5" />
                  ))}
                </div>
              ) : board.items.length === 0 ? (
                <p className="mt-3 text-sm text-white/40">
                  No rated players yet — the first settled match starts the board.
                </p>
              ) : (
                <ol className="mt-3 space-y-1.5">
                  {board.items.map((item) => {
                    const name = item.user?.name || item.name || "Player";
                    return (
                      <li
                        key={`${item.clerk_id}-${item.rank}`}
                        className="flex items-center justify-between gap-2 rounded-lg px-1 py-1.5"
                      >
                        <Link
                          href={`/profil/${encodeURIComponent(item.clerk_id)}`}
                          className="flex min-w-0 items-center gap-2 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300"
                        >
                          <span className="w-6 shrink-0 text-xs font-black tabular-nums text-white/35">
                            {item.rank}
                          </span>
                          <span className="truncate text-sm text-white/80">{name}</span>
                        </Link>
                        <span className="flex shrink-0 items-center gap-2">
                          <span className="text-xs font-bold tabular-nums text-cyan-200">
                            {Number(item.rating).toLocaleString()}
                          </span>
                          {item.clerk_id && item.clerk_id !== user?.id && (
                            <ReportEntryButton
                              reportedClerkId={item.clerk_id}
                              reportedPlayerName={name}
                              gameType="leaderboard"
                              contextLabel="Leaderboard entry"
                            />
                          )}
                        </span>
                      </li>
                    );
                  })}
                </ol>
              )}
            </div>
          </div>
        </section>

        {/* ── Why ranked Solitaire is fair ──────────────────────────────── */}
        <section className="mt-14" aria-labelledby="fair-heading">
          <h2
            id="fair-heading"
            className="text-[11px] font-black uppercase tracking-[0.32em] text-white/40"
          >
            Fair by construction
          </h2>
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            {features.map((feature) => (
              <div key={feature.title} className="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
                <h3 className="text-sm font-bold text-white">{feature.title}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-white/55">{feature.body}</p>
              </div>
            ))}
          </div>
          <p className="mt-4 text-sm text-white/45">
            New here?{" "}
            <Link href="/games/solitaire-duel" className="text-cyan-300 underline underline-offset-4">
              Read how Solitaire Duel works
            </Link>
            , or jump straight into the{" "}
            <Link href="/classement" className="text-cyan-300 underline underline-offset-4">
              Solitaire rankings
            </Link>
            .
          </p>
        </section>

        {hilltopSlot}

        {adSlot}
      </main>

      <Footer />

      {showTermsModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/85 p-4 backdrop-blur-sm">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="terms-modal-title"
            className="max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-white/15 bg-[#08111f] p-6 md:p-8"
          >
            <h2 id="terms-modal-title" className="text-2xl font-black text-white">
              Terms &amp; Conditions
            </h2>
            <p className="mt-3 text-sm leading-relaxed text-white/60">
              GRYND is a free competitive Solitaire platform. Play is for rating
              and trophies only — there is no wagering, no entry fee and no
              cash-out. By continuing you agree to the{" "}
              <Link href="/terms" className="text-cyan-300 underline">
                Terms of Service
              </Link>{" "}
              and{" "}
              <Link href="/privacy-policy" className="text-cyan-300 underline">
                Privacy Policy
              </Link>
              .
            </p>
            {termsLoading ? null : (
              <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:justify-end">
                <button
                  type="button"
                  onClick={handleRejectTerms}
                  className="rounded-lg border border-red-500/40 bg-red-500/10 px-5 py-2.5 text-sm font-bold text-red-300"
                >
                  Decline and sign out
                </button>
                <button
                  type="button"
                  onClick={handleAcceptTerms}
                  className="rounded-lg bg-cyan-400 px-5 py-2.5 text-sm font-bold text-[#04121a]"
                >
                  I agree
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
