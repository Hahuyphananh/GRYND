"use client";

// src/app/PageClient.jsx
//
// GRYND's home page — the RANKED-FIRST LANDING (decision D1).
//
// Home is not the menu any more. It answers one question — "what is this, and
// how do I play the real thing?" — and hands the full choice to /play:
//
//   * the hero says what GRYND is and puts ranked first;
//   * three inline ways in (solo, vs AI, daily), plus one link to /play, which
//     is the only surface that renders all six modes;
//   * the standing block is the player's own Solitaire record, from
//     /api/user-stats, /api/get-user-tokens and /api/solitaire-duel/lobby, with
//     the solo and daily figures that used to live on the mode cards;
//   * recent matches and the public ladder preview;
//   * why the ranked result can be trusted;
//   * social proof, then the ad slot as the very last block.
//
// The ranked lobby is NOT mounted here: matchmaking lives on /play/ranked.
// No number on this page is invented: an unknown stat renders as a dash, an
// empty list says so, and a signed-out visitor gets a sign-in path rather than
// somebody else's record.

import { useEffect, useState } from "react";
import Link from "next/link";
import { useAuth, useUser } from "@clerk/nextjs";
import NavigationBar from "../components/navigation-bar";
import DailyRewardWidget from "../components/DailyRewardWidget";
import QuestWidget from "../components/QuestWidget";
import Footer from "../components/Footer";
import ReportEntryButton from "../components/reports/ReportEntryButton";
import HeroCard3D from "../components/home/HeroCard3D";
import { Button, StatTile, Surface } from "../components/ui";
import { formatDuration } from "../lib/solitaire-duel/soloStats.js";
import { clearSessionArtifacts } from "../lib/security/sessionCleanup";

const formatDate = (ms) => {
  if (!ms) return "";
  return new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" });
};

// A UTC date key (YYYY-MM-DD) as a short label. UTC is explicit so the viewer's
// timezone can never move the day the server fixed the deal to.
const formatDealDate = (dateKey) => {
  const [year, month, day] = String(dateKey).split("-").map(Number);
  if (!year || !month || !day) return "";
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
};

const outcomeLabel = (outcome) => {
  if (outcome === "win") return "Win";
  if (outcome === "loss") return "Loss";
  if (outcome === "draw") return "Draw";
  return "In progress";
};

const outcomeTone = (outcome) => {
  if (outcome === "win") return "text-[color:var(--state-win)]";
  if (outcome === "loss") return "text-[color:var(--state-loss)]";
  if (outcome === "draw") return "text-[color:var(--state-gold)]";
  return "text-[color:var(--accent-strong)]";
};

// The three ways in that are NOT ranked. Ranked owns the hero CTA; the full
// six-mode menu is one link away on /play (D1). Deliberately data-driven so a
// destination is stated once, as `href:`.
const WAYS = [
  {
    key: "solo",
    href: "/solitaire",
    eyebrow: "Solo",
    title: "Play alone, right now",
    body: "Classic Klondike with a timer, undo and personal bests. No queue, no opponent, no Elo.",
    cta: "Start solo",
  },
  {
    key: "ai",
    href: "/play/ai",
    eyebrow: "vs AI",
    title: "Learn the rhythm",
    body: "Unrated games against the built-in bot, with selectable difficulty. Never ranked.",
    cta: "Practise vs AI",
  },
  {
    key: "daily",
    href: "/daily",
    eyebrow: "Daily",
    title: "One deal, every day",
    body: "The same deterministic deal for every player, fixed by the UTC date. One official result a day.",
    cta: "Play today's deal",
  },
];

export default function MainComponent({ adSlot = null, hilltopSlot = null, socialProof = null }) {
  const { isLoaded, isSignedIn, signOut } = useAuth();
  const { user } = useUser();

  const [showTermsModal, setShowTermsModal] = useState(false);
  const [termsLoading, setTermsLoading] = useState(true);
  const [termsSaving, setTermsSaving] = useState(false);
  const [termsError, setTermsError] = useState("");
  const [stats, setStats] = useState(null);
  const [trophies, setTrophies] = useState(null);
  const [board, setBoard] = useState(null);
  const [recent, setRecent] = useState([]);
  const [soloSummary, setSoloSummary] = useState(null);
  const [soloLoaded, setSoloLoaded] = useState(false);
  const [dailySummary, setDailySummary] = useState(null);
  const [dailyDateKey, setDailyDateKey] = useState(null);
  const [dailyLoaded, setDailyLoaded] = useState(false);

  // Terms gate — unchanged: a signed-in player who has not accepted is asked
  // before they keep playing.
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
        if (cancelled) return;
        if (data?.success && Array.isArray(data.data?.recent)) {
          setRecent(data.data.recent);
        }
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [isSignedIn]);

  // Solo and daily records. These endpoints are the ONLY source for those
  // figures: `/api/solitaire/solo` 401s for a guest (there are no account rows
  // to read) and the daily payload carries today's UTC date for everyone. A
  // failed read leaves the line empty rather than inventing a zero.
  useEffect(() => {
    // Wait for the auth state so a signed-in visitor is never sent the 401 path.
    if (!isLoaded) return;
    let cancelled = false;
    const readJson = (url) =>
      fetch(url, { credentials: "same-origin", cache: "no-store" })
        .then((res) => (res.ok ? res.json() : null))
        .catch(() => null);

    Promise.all([
      isSignedIn ? readJson("/api/solitaire/solo") : Promise.resolve(null),
      readJson("/api/solitaire/daily"),
    ])
      .then(([soloBody, dailyBody]) => {
        if (cancelled) return;
        if (soloBody?.data?.summary) setSoloSummary(soloBody.data.summary);
        if (dailyBody?.data) {
          setDailySummary(dailyBody.data.summary ?? null);
          setDailyDateKey(dailyBody.data.dateKey ?? null);
        }
        setSoloLoaded(true);
        setDailyLoaded(true);
      })
      .catch(() => {
        if (cancelled) return;
        setSoloLoaded(true);
        setDailyLoaded(true);
      });

    return () => {
      cancelled = true;
    };
  }, [isLoaded, isSignedIn]);

  const handleAcceptTerms = async () => {
    setTermsSaving(true);
    setTermsError("");
    try {
      // The API middleware rejects mutations without an application/json
      // content type, so the acceptance must be sent as a (empty) JSON body.
      const res = await fetch("/api/user/accept-terms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        credentials: "same-origin",
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data?.success) {
        setShowTermsModal(false);
        return;
      }
      setTermsError(data?.error || "Could not save your acceptance. Please try again.");
    } catch {
      setTermsError("Could not save your acceptance. Please try again.");
    } finally {
      setTermsSaving(false);
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

  // The solo and daily lines that used to sit on the two mode cards. They move
  // here rather than disappearing with the cards (D1): the figures answer "how
  // am I doing?" and belong beside the ranked standing.
  const soloLine = !isSignedIn
    ? "Sign in to save your best"
    : !soloLoaded
      ? ""
      : soloSummary && soloSummary.games > 0
        ? `${soloSummary.completed}/${soloSummary.games} solved${
            soloSummary.bestMs ? ` · best ${formatDuration(soloSummary.bestMs)}` : ""
          }`
        : "No solo games yet";

  const dailyLine = !dailyLoaded
    ? ""
    : dailySummary
      ? dailySummary.today?.completed
        ? `Played today${
            dailySummary.currentStreak > 1 ? ` · ${dailySummary.currentStreak}-day streak` : ""
          }`
        : `Not played yet${
            dailySummary.currentStreak > 0 ? ` · ${dailySummary.currentStreak}-day streak` : ""
          }`
      : dailyDateKey
        ? `Today's deal · ${formatDealDate(dailyDateKey)}`
        : "";

  const tiles = [
    {
      label: "Solitaire Elo",
      value: rating === null ? "—" : rating.toLocaleString(),
      hint: solitaireRating?.provisional
        ? `Provisional · ${Number(solitaireRating.provisionalGamesRemaining ?? 0)} placement games left`
        : "Rated ladder",
      tone: "accent",
    },
    {
      label: "Trophies",
      value: trophies === null ? "—" : trophies.toLocaleString(),
      hint: "Across every archived and active game",
      tone: "gold",
    },
    {
      label: "Ranked games",
      value: games === null ? "—" : games.toLocaleString(),
      hint: "Settled Solitaire matches",
      tone: "default",
    },
    {
      label: "Win rate",
      value: winRate === null ? "—" : `${winRate}%`,
      hint: "Decided Solitaire matches only",
      tone: "win",
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
    <div className="relative min-h-screen bg-[color:var(--bg-page)] pb-24 text-[color:var(--text-primary)] md:pb-0">
      <NavigationBar currentPath="/" />

      <DailyRewardWidget />
      <QuestWidget />

      <main className="mx-auto max-w-6xl px-4 pt-24 sm:px-6 md:pt-28">
        {/* ── Hero ──────────────────────────────────────────────────────── */}

        <section className="border-b border-[color:var(--border-hairline)] pb-8 pt-4 sm:pb-10">
          <div className="grid items-center gap-8 lg:grid-cols-[minmax(0,1fr)_18rem] xl:grid-cols-[minmax(0,1fr)_21rem]">
            <div className="min-w-0">
              <p className="text-[11px] font-black uppercase tracking-[0.4em] text-[color:var(--text-muted)]">
                GRYND · competitive Solitaire
              </p>
              <h1 className="mt-3 max-w-3xl text-4xl font-black leading-[0.95] tracking-tight sm:text-5xl lg:text-6xl">
                The competitive home{" "}
                <span className="text-[color:var(--gr-brand-cyan)]">of Solitaire</span>
              </h1>
              <p className="mt-4 max-w-2xl text-sm leading-relaxed text-[color:var(--text-secondary)] sm:text-base">
                Classic Klondike, played against a real person on a free ranked
                ladder. Every ranked result is validated server-side, and the
                only thing at stake is your rating.
              </p>
              <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-3 text-sm">
                <Button href="/play/ranked" size="lg">
                  Play ranked
                </Button>
                <Button href="/play/ai" variant="ghost" size="lg">
                  Practise vs AI
                </Button>
                <Link
                  href="/games/solitaire-duel"
                  className="font-semibold text-[color:var(--text-secondary)] underline underline-offset-4 transition hover:text-[color:var(--text-primary)]"
                >
                  Rules &amp; strategy
                </Link>
                <Link
                  href="/classement"
                  className="font-semibold text-[color:var(--text-secondary)] underline underline-offset-4 transition hover:text-[color:var(--text-primary)]"
                >
                  Leaderboard
                </Link>
              </div>
              <p className="mt-4 text-xs font-semibold uppercase tracking-[0.16em] text-[color:var(--text-muted)]">
                Real opponents · Free ranked ladder · Server-verified results
              </p>
            </div>

            {/* The visual is its own grid column: it can never cover the
                heading, copy, CTA or nav. On mobile it follows the copy. */}
            <div className="relative flex justify-center lg:justify-end">
              <div className="w-[10.5rem] sm:w-[12.5rem] lg:w-[15rem] xl:w-[16.5rem]">
                <HeroCard3D />
              </div>
            </div>
          </div>
        </section>

        {/* ── Three ways in, and the full menu one link away ─────────────── */}

        <section className="mt-10" aria-labelledby="ways-heading">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2
              id="ways-heading"
              className="text-[11px] font-black uppercase tracking-[0.32em] text-[color:var(--text-muted)]"
            >
              Ways to play
            </h2>
            <Link
              href="/play"
              className="text-xs font-semibold text-[color:var(--accent-strong)] transition hover:text-[color:var(--text-primary)]"
            >
              All six ways to play →
            </Link>
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            {WAYS.map((way) => (
              <Surface key={way.key} tone="panel" padding="sm">
                <Link
                  href={way.href}
                  className="block rounded-lg p-2 transition hover:bg-[color:var(--bg-surface)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--focus-ring)]"
                >
                  <p className="text-[10px] font-black uppercase tracking-[0.2em] text-[color:var(--text-muted)]">
                    {way.eyebrow}
                  </p>
                  <p className="mt-1 text-sm font-bold text-[color:var(--text-primary)]">
                    {way.title}
                  </p>
                  <p className="mt-1 text-xs leading-relaxed text-[color:var(--text-secondary)]">
                    {way.body}
                  </p>
                  <span className="mt-2 inline-block text-xs font-semibold text-[color:var(--accent-strong)]">
                    {way.cta} →
                  </span>
                </Link>
              </Surface>
            ))}
          </div>
        </section>

        {/* ── Player standing ───────────────────────────────────────────── */}

        <section id="dashboard" className="mt-14 scroll-mt-28" aria-labelledby="dashboard-heading">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <h2
              id="dashboard-heading"
              className="text-[11px] font-black uppercase tracking-[0.32em] text-[color:var(--text-muted)]"
            >
              Your Solitaire
            </h2>
            {isSignedIn && (
              <Link
                href="/profil"
                className="text-xs font-semibold text-[color:var(--accent-strong)] transition hover:text-[color:var(--text-primary)]"
              >
                Full profile →
              </Link>
            )}
          </div>

          {!isLoaded ? (
            <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-busy="true">
              {[0, 1, 2, 3].map((i) => (
                <div
                  key={i}
                  className="h-24 animate-pulse rounded-[var(--radius-surface)] border border-[color:var(--border-hairline)] bg-[color:var(--bg-panel)]"
                />
              ))}
            </div>
          ) : !isSignedIn ? (
            <Surface className="mt-4 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="font-bold text-[color:var(--text-primary)]">
                  Carry a rating, not just a score
                </p>
                <p className="mt-1 text-sm leading-relaxed text-[color:var(--text-secondary)]">
                  An account keeps your Solitaire Elo, trophies, match history and
                  placement progress. Practice against the bot works without one.
                </p>
              </div>
              <div className="flex shrink-0 gap-2">
                <Button href="/sign-up">Create account</Button>
                <Button href="/sign-in" variant="secondary">
                  Sign in
                </Button>
              </div>
            </Surface>
          ) : (
            <>
              <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {tiles.map((tile) => (
                  <StatTile key={tile.label} {...tile} />
                ))}
              </div>
              {(soloLine || dailyLine) && (
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <Surface tone="panel" padding="sm">
                    <p className="text-[10px] font-black uppercase tracking-[0.2em] text-[color:var(--text-muted)]">
                      Solo
                    </p>
                    <p className="mt-1 text-xs text-[color:var(--text-secondary)]">
                      {soloLine || "—"}
                    </p>
                  </Surface>
                  <Surface tone="panel" padding="sm">
                    <p className="text-[10px] font-black uppercase tracking-[0.2em] text-[color:var(--text-muted)]">
                      Daily
                    </p>
                    <p className="mt-1 text-xs text-[color:var(--text-secondary)]">
                      {dailyLine || "—"}
                    </p>
                  </Surface>
                </div>
              )}
            </>
          )}

          <div className="mt-4 grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
            {/* Recent matches — the caller's own rows, never a sample. */}
            <Surface>
              <div className="flex items-baseline justify-between gap-3">
                <h3 className="text-sm font-bold text-[color:var(--text-primary)]">
                  Recent matches
                </h3>
                <Link
                  href="/profil"
                  className="text-[11px] font-semibold text-[color:var(--text-muted)] transition hover:text-[color:var(--text-primary)]"
                >
                  History
                </Link>
              </div>
              {!isSignedIn ? (
                <p className="mt-3 text-sm text-[color:var(--text-muted)]">
                  Sign in to see your match history.
                </p>
              ) : recent.length === 0 ? (
                <p className="mt-3 text-sm text-[color:var(--text-muted)]">
                  No matches yet. Your first ranked game will appear here.
                </p>
              ) : (
                <ul className="mt-3 divide-y divide-[color:var(--border-hairline)]">
                  {recent.map((match) => (
                    <li
                      key={match.matchId}
                      className="flex items-center justify-between gap-3 py-2.5"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-[color:var(--text-primary)]">
                          {match.opponent}
                        </p>
                        <p className="text-[11px] text-[color:var(--text-muted)]">
                          {formatDate(match.endedAtMs ?? match.createdAtMs)}
                          {match.isAi ? " · Practice · unrated" : " · Ranked"}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-3">
                        <span
                          className={`text-xs font-black uppercase tracking-wider ${outcomeTone(match.outcome)}`}
                        >
                          {outcomeLabel(match.outcome)}
                        </span>
                        <Link
                          href={`/casino/solitaire-duel/${match.matchId}`}
                          className="text-[11px] font-semibold text-[color:var(--text-muted)] transition hover:text-[color:var(--text-primary)]"
                        >
                          Open
                        </Link>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Surface>

            {/* Public Solitaire leaderboard preview. */}
            <Surface>
              <div className="flex items-baseline justify-between gap-3">
                <h3 className="text-sm font-bold text-[color:var(--text-primary)]">
                  Solitaire leaderboard
                </h3>
                <Link
                  href="/classement"
                  className="text-[11px] font-semibold text-[color:var(--accent-strong)] transition hover:text-[color:var(--text-primary)]"
                >
                  Full board
                </Link>
              </div>
              {!board ? (
                <div className="mt-3 space-y-2" aria-busy="true">
                  {[0, 1, 2, 3, 4].map((i) => (
                    <div
                      key={i}
                      className="h-7 animate-pulse rounded-sm bg-[color:var(--bg-panel)]"
                    />
                  ))}
                </div>
              ) : board.items.length === 0 ? (
                <p className="mt-3 text-sm text-[color:var(--text-muted)]">
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
                          className="flex min-w-0 items-center gap-2 rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--focus-ring)]"
                        >
                          <span className="w-6 shrink-0 text-xs font-black tabular-nums text-[color:var(--text-muted)]">
                            {item.rank}
                          </span>
                          <span className="truncate text-sm text-[color:var(--text-secondary)]">
                            {name}
                          </span>
                        </Link>
                        <span className="flex shrink-0 items-center gap-2">
                          <span className="text-xs font-bold tabular-nums text-[color:var(--accent-strong)]">
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
            </Surface>
          </div>
        </section>

        {/* ── Why ranked Solitaire is fair ──────────────────────────────── */}

        <section className="mt-14" aria-labelledby="fair-heading">
          <h2
            id="fair-heading"
            className="text-[11px] font-black uppercase tracking-[0.32em] text-[color:var(--text-muted)]"
          >
            Fair by construction
          </h2>
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            {features.map((feature) => (
              <Surface key={feature.title} tone="panel">
                <h3 className="text-sm font-bold text-[color:var(--text-primary)]">
                  {feature.title}
                </h3>
                <p className="mt-1.5 text-sm leading-relaxed text-[color:var(--text-secondary)]">
                  {feature.body}
                </p>
              </Surface>
            ))}
          </div>
          <p className="mt-4 text-sm text-[color:var(--text-muted)]">
            New here?{" "}
            <Link
              href="/games/solitaire-duel"
              className="text-[color:var(--accent-strong)] underline underline-offset-4"
            >
              Read how Solitaire Duel works
            </Link>
            , or jump straight into the{" "}
            <Link
              href="/classement"
              className="text-[color:var(--accent-strong)] underline underline-offset-4"
            >
              Solitaire rankings
            </Link>
            .
          </p>
        </section>

        {hilltopSlot}

        {/* Trustpilot + Product Hunt. A server-rendered child (see
            src/components/home/SocialProof.tsx), so the TrustBox element and
            the badge are in the HTML a crawler receives. */}
        {socialProof}

        {/* The ad is the LAST block on the page: after every interactive
            element and immediately above the footer, so nothing clickable
            follows it (tests/ad-model.test.mjs). */}
        {adSlot}
      </main>

      <Footer />

      {showTermsModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/85 p-4 backdrop-blur-xs">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="terms-modal-title"
            className="max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-[var(--radius-surface)] border border-[color:var(--border-hairline)] bg-[color:var(--bg-surface)] p-6 md:p-8"
          >
            <h2
              id="terms-modal-title"
              className="text-2xl font-black text-[color:var(--text-primary)]"
            >
              Terms &amp; Conditions
            </h2>
            <p className="mt-3 text-sm leading-relaxed text-[color:var(--text-secondary)]">
              GRYND is a free competitive Solitaire platform. Play is for rating
              and trophies only — there is no wagering, no entry fee and no
              cash-out. By continuing you agree to the{" "}
              {/* Opened in a new tab so reading the policies never leaves
                  this page: the pending acceptance survives and the player
                  comes back to the same gate rather than a fresh load. */}
              <Link
                href="/terms"
                target="_blank"
                rel="noopener noreferrer"
                className="text-[color:var(--accent-strong)] underline"
              >
                Terms of Service
                <span className="sr-only"> (opens in a new tab)</span>
              </Link>{" "}
              and{" "}
              <Link
                href="/privacy-policy"
                target="_blank"
                rel="noopener noreferrer"
                className="text-[color:var(--accent-strong)] underline"
              >
                Privacy Policy
                <span className="sr-only"> (opens in a new tab)</span>
              </Link>
              .
            </p>
            {termsLoading ? null : (
              <div className="mt-6">
                {termsError ? (
                  <p className="mb-3 text-sm font-semibold text-[color:var(--state-loss)]" role="alert">
                    {termsError}
                  </p>
                ) : null}
                <div className="flex flex-col gap-3 sm:flex-row sm:justify-end">
                  <Button variant="danger" onClick={handleRejectTerms}>
                    Decline and sign out
                  </Button>
                  <Button onClick={handleAcceptTerms} disabled={termsSaving}>
                    {termsSaving ? "Saving…" : "I agree"}
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
