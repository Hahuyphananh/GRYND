"use client";

// src/app/casino/solitaire-duel/play-ai/PageClient.tsx
//
// The Solitaire Duel bot-selection page.
//
// A challenge starts the SAME server-authoritative practice match as before
// (POST /api/solitaire-duel/create-ai), with one addition: the selected bot's
// stable id travels in the request, and the server persists it in the existing
// `ai_difficulty` field. No new match type, board or rules engine is created.
//
// The cards are deliberately compact: avatar, identity, progression marker and
// one Challenge button. The page is a picker, not a landing page.

import { useCallback, useState } from "react";
import Link from "next/link";
import {
  IconArrowLeft,
  IconCards,
  IconChevronRight,
  IconRobot,
  IconSparkles,
  IconTrophy,
} from "@tabler/icons-react";

import NavigationBar from "../../../../components/navigation-bar";
import BotAvatar from "../../../../components/solitaire-duel/BotAvatar";
import { useMatchRouter } from "../../../../hooks/useMatchRouter";
import {
  SOLITAIRE_BOTS,
  solitaireBotStats,
  type SolitaireBot,
  type SolitaireBotId,
} from "../../../../lib/solitaire-duel/bots";

const LOBBY_PATH = "/casino/solitaire-duel";

function Progression({ bot }: { bot: SolitaireBot }) {
  return (
    <div className="mt-3" aria-label={`Difficulty ${bot.order} of 6`}>
      <div className="flex gap-1" aria-hidden="true">
        {Array.from({ length: 6 }, (_, index) => (
          <span
            key={index}
            className={`h-1 flex-1 rounded-full ${
              index < bot.order
                ? bot.id === "perfect"
                  ? "bg-gradient-to-r from-amber-400 to-violet-300"
                  : "bg-cyan-400/70"
                : "bg-white/10"
            }`}
          />
        ))}
      </div>
      <p className="mt-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-white/35">
        Difficulty {bot.order} of 6
      </p>
    </div>
  );
}

// The two facts a player actually chooses on: how long this opponent needs to
// finish the deal, and how often it gets a move wrong. Both are derived from
// the bot's own profile (see `solitaireBotStats`) — nothing is hard-coded here.
function DifficultyFacts({ bot }: { bot: SolitaireBot }) {
  const stats = solitaireBotStats(bot);
  return (
    <dl className="mt-3 grid grid-cols-2 gap-2" aria-label={`${bot.name} strengths`}>
      <div className="rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-2">
        <dt className="text-[9px] font-bold uppercase tracking-[0.12em] text-white/35">
          Typical finish
        </dt>
        <dd className="mt-0.5 text-sm font-extrabold text-white/80">
          {stats.finishLabel}
        </dd>
      </div>
      <div className="rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-2">
        <dt className="text-[9px] font-bold uppercase tracking-[0.12em] text-white/35">
          Bad moves
        </dt>
        <dd className="mt-0.5 text-sm font-extrabold text-white/80">
          {stats.mistakeLabel}
        </dd>
      </div>
    </dl>
  );
}

function Rating({ bot }: { bot: SolitaireBot }) {
  if (bot.rating == null) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-amber-300/50 bg-amber-400/15 px-2 py-0.5 text-[11px] font-black tracking-[0.14em] text-amber-200">
        <IconSparkles size={12} aria-hidden="true" />
        {bot.ratingLabel}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-amber-400/25 bg-amber-400/[0.07] px-2 py-0.5 font-mono text-[11px] font-bold text-amber-200/90">
      <IconTrophy size={12} aria-hidden="true" />
      {bot.ratingLabel}
    </span>
  );
}

export default function SolitairePlayAiPage() {
  const router = useMatchRouter();
  const [challengingId, setChallengingId] = useState<SolitaireBotId | null>(null);
  const [error, setError] = useState<string | null>(null);

  const challenge = useCallback(
    async (bot: SolitaireBot) => {
      if (challengingId) return;
      setChallengingId(bot.id);
      setError(null);
      try {
        const res = await fetch("/api/solitaire-duel/create-ai", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ bot: bot.id }),
        });
        const data = await res.json().catch(() => null);
        if (!res.ok || !data?.success) {
          setError(data?.error || `Unable to start the match against ${bot.name}`);
          return;
        }
        router.push(`${LOBBY_PATH}/${data.data.matchId}`);
      } catch {
        setError(`Unable to start the match against ${bot.name}`);
      } finally {
        setChallengingId(null);
      }
    },
    [challengingId, router],
  );

  return (
    <main className="min-h-screen bg-gradient-to-b from-[#07101f] via-[#06152c] to-[#040b17] px-4 pb-20 pt-20 text-white sm:px-6">
      <NavigationBar currentPath={LOBBY_PATH} />

      <div className="mx-auto mt-5 w-full max-w-6xl">
        <Link
          href={LOBBY_PATH}
          className="inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-[0.16em] text-cyan-200/70 transition hover:text-cyan-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff]"
        >
          <IconArrowLeft size={14} aria-hidden="true" />
          Solitaire Duel
        </Link>

        <header className="mt-5 flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-[10px] font-black uppercase tracking-[0.28em] text-amber-300/70">
              Unrated practice
            </p>
            <h1 className="mt-1 flex items-center gap-2 text-3xl font-extrabold tracking-tight text-transparent bg-clip-text bg-gradient-to-r from-amber-200 via-cyan-100 to-violet-200 sm:text-4xl">
              <IconRobot className="h-8 w-8 shrink-0 text-amber-300" aria-hidden="true" />
              Play vs Bots
            </h1>
            <p className="mt-2 max-w-2xl text-sm leading-relaxed text-white/60">
              Challenge increasingly difficult Solitaire opponents. Every bot
              plays the same deterministic deal you do — no hidden cards, no
              special deals — and practice never changes your Elo or trophies.
            </p>
          </div>

          <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 text-[10px] font-bold uppercase tracking-[0.14em] text-white/45">
            <IconCards size={14} className="text-cyan-300/70" aria-hidden="true" />
            <span>Beginner</span>
            <span aria-hidden="true" className="text-white/20">·</span>
            <span>Intermediate</span>
            <span aria-hidden="true" className="text-white/20">·</span>
            <span>Advanced</span>
          </div>
        </header>

        {error && (
          <p
            role="alert"
            className="mt-5 rounded-xl border border-red-400/40 bg-red-500/10 px-4 py-3 text-sm text-red-200"
          >
            {error}
          </p>
        )}

        <section
          aria-label="Solitaire bots"
          className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3"
        >
          {SOLITAIRE_BOTS.map((bot) => {
            const perfect = bot.id === "perfect";
            const busy = challengingId === bot.id;
            return (
              <article
                key={bot.id}
                data-testid={`solitaire-bot-${bot.id}`}
                className={`relative flex h-full flex-col rounded-2xl border p-4 transition ${
                  perfect
                    ? "border-amber-300/55 bg-gradient-to-br from-amber-400/[0.12] via-[#0b224f]/95 to-violet-500/[0.08] shadow-[0_0_28px_rgba(251,191,36,0.14)]"
                    : "border-[#00e5ff]/20 bg-[#0b224f]/85 shadow-[0_0_18px_rgba(0,229,255,0.06)] hover:border-[#00e5ff]/40"
                }`}
              >
                {perfect && (
                  <span className="absolute right-3 top-3 rounded-full border border-amber-300/50 bg-amber-300/15 px-2 py-0.5 text-[9px] font-black uppercase tracking-[0.16em] text-amber-200">
                    Final challenge
                  </span>
                )}

                <div className="flex items-start gap-3">
                  <BotAvatar bot={bot} perfect={perfect} size="h-20 w-20" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-[10px] font-black uppercase tracking-[0.18em] text-white/30">
                        {String(bot.order).padStart(2, "0")}
                      </p>
                      <span className="rounded-full border border-cyan-300/25 bg-cyan-400/10 px-2 py-0.5 text-[9px] font-black uppercase tracking-[0.12em] text-cyan-100/80">
                        {bot.difficultyLabel}
                      </span>
                    </div>
                    <h2
                      className={`mt-1 truncate text-xl font-extrabold ${
                        perfect ? "text-amber-100" : "text-white"
                      }`}
                    >
                      {bot.name}
                    </h2>
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                      <Rating bot={bot} />
                      <span className="rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[9px] font-bold uppercase tracking-[0.1em] text-white/50">
                        {bot.audienceLabel}
                      </span>
                    </div>
                  </div>
                </div>

                <p className="mt-3 min-h-[3.25rem] text-xs leading-relaxed text-white/55">
                  {bot.description}
                </p>

                <DifficultyFacts bot={bot} />

                <Progression bot={bot} />

                <button
                  type="button"
                  onClick={() => void challenge(bot)}
                  disabled={Boolean(challengingId)}
                  aria-busy={busy || undefined}
                  data-testid={`solitaire-challenge-${bot.id}`}
                  className={`mt-4 inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl border px-4 text-xs font-black uppercase tracking-[0.14em] transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff] disabled:cursor-not-allowed disabled:opacity-50 ${
                    perfect
                      ? "border-amber-300/60 bg-gradient-to-r from-amber-400/25 to-violet-400/20 text-amber-100 hover:from-amber-400/35 hover:to-violet-400/30"
                      : "border-cyan-300/40 bg-cyan-400/10 text-cyan-100 hover:bg-cyan-400/20"
                  }`}
                >
                  {busy ? "Starting…" : `Challenge ${bot.name}`}
                  {!busy && <IconChevronRight size={14} aria-hidden="true" />}
                </button>
              </article>
            );
          })}
        </section>

        <p className="mt-6 text-center text-[11px] leading-relaxed text-white/35">
          Bot ratings describe opponent strength; they are not trophies awarded
          to you. Practice matches are unrated and never touch ranked
          matchmaking, Elo or trophies.
        </p>
      </div>
    </main>
  );
}
