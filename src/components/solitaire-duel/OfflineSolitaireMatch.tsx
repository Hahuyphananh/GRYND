"use client";

// src/components/solitaire-duel/OfflineSolitaireMatch.tsx
//
// The Play vs Bots arena with NO server: the same Klondike deal, the same bot
// planner and the same rules as the online practice match, driven entirely from
// `lib/solitaire-duel/localMatch` in this tab.
//
// Nothing here fetches, joins a socket or writes a row, which is the point: a
// practice race starts and finishes with the network down. The result is local
// by design and the screen says so — no Elo, trophies, history or account state
// are touched.
//
// Everything competitive still comes from the shared engine: a move is legal
// when `applyMove` accepts it, the bot is paced by `aiMoveDelayMs`, the dead
// board rescue is `stateSolvableVerdict`, and the winner is `resolveRace`.
// This component owns presentation and the 250 ms tick only.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  IconArrowBackUp,
  IconArrowLeft,
  IconClock,
  IconFlag,
  IconHourglassHigh,
  IconRefresh,
  IconWifiOff,
} from "@tabler/icons-react";

import BotAvatar from "./BotAvatar";
import SolitaireBoard from "./SolitaireBoard";
import SolitaireThemePicker from "./SolitaireThemePicker";
import { aiMoveDelayMs, aiPaceLabel } from "../../lib/solitaire-duel/ai";
import { solitaireBotFor, type SolitaireBotId } from "../../lib/solitaire-duel/bots";
import {
  INACTIVITY_COUNTDOWN_MS,
  INACTIVITY_FORFEIT_MS,
  SEAT,
} from "../../lib/solitaire-duel/constants";
import {
  advanceAi,
  aiProgress,
  applyPlayerMove,
  createLocalMatch,
  endMatchByProgress,
  forfeitIfInactive,
  playerProgress,
  playerView,
  randomLocalSeed,
  redealPlayerIfDead,
  undoPlayerMove,
  type LocalMatch,
} from "../../lib/solitaire-duel/localMatch";
import {
  clockLabel,
  outcomeLabel,
  progressLabel,
  resolutionLabel,
  viewerOutcome,
} from "../../lib/solitaire-duel/ui";
import type { SeatProgress, SolitaireMove } from "../../lib/solitaire-duel/types";

/** How often the bot is given a chance to move and the stopwatch updates. */
const TICK_MS = 250;

/** Race time as m:ss, from GO to the instant the result landed. */
function matchTimeLabel(match: LocalMatch): string {
  const seconds = Math.max(0, Math.round(((match.endedAtMs ?? match.goAtMs) - match.goAtMs) / 1000));
  return clockLabel(seconds * 1000);
}

export default function OfflineSolitaireMatch({
  botId,
  onExit,
}: {
  botId: SolitaireBotId;
  /** Back to the bot picker. */
  onExit: () => void;
}) {
  const [match, setMatch] = useState<LocalMatch | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [dealing, setDealing] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const matchRef = useRef<LocalMatch | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    matchRef.current = match;
  }, [match]);

  const start = useCallback(() => {
    setDealing(true);
    setNotice(null);
    setError(null);
    // Clear the finished match first, so the result overlay disappears the
    // moment "Rematch" is pressed instead of lingering over the new deal.
    matchRef.current = null;
    setMatch(null);

    // The deal search is bounded and short (~40 ms typical, ~130 ms worst case),
    // so it runs inline behind this overlay instead of in a Worker. The short
    // delay yields one paint first, so "Dealing…" is actually seen.
    window.setTimeout(() => {
      if (!mountedRef.current) return;
      try {
        const created = createLocalMatch({
          botId,
          seed: randomLocalSeed(),
          nowMs: Date.now(),
        });
        matchRef.current = created;
        setMatch(created);
        setNow(Date.now());
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Could not deal a board. Try again.");
      } finally {
        if (mountedRef.current) setDealing(false);
      }
    }, 40);
  }, [botId]);

  // One deal per mount, for the bot this arena was opened with.
  useEffect(() => {
    start();
  }, [start]);

  // The race clock. Stops the moment a result exists.
  useEffect(() => {
    if (!match || match.result) return undefined;
    const id = window.setInterval(() => {
      const stamp = Date.now();
      setNow(stamp);
      setMatch((prev) =>
        prev && !prev.result
          ? forfeitIfInactive(redealPlayerIfDead(advanceAi(prev, stamp)), stamp)
          : prev,
      );
    }, TICK_MS);
    return () => window.clearInterval(id);
  }, [match?.seed, match?.botId, match?.result]);

  // A rejected move explains itself for a couple of seconds, then goes away.
  useEffect(() => {
    if (!notice) return undefined;
    const id = window.setTimeout(() => setNotice(null), 2400);
    return () => window.clearTimeout(id);
  }, [notice]);

  const onMove = useCallback((move: SolitaireMove) => {
    const current = matchRef.current;
    if (!current) return;
    const outcome = applyPlayerMove(current, move, Date.now());
    if (outcome.error) {
      setNotice(outcome.error);
      return;
    }
    setNotice(null);
    matchRef.current = outcome.match;
    setMatch(outcome.match);
    setNow(Date.now());
  }, []);

  const undoLastMove = useCallback(() => {
    const current = matchRef.current;
    if (!current) return;
    const next = undoPlayerMove(current);
    if (next === current) return;
    matchRef.current = next;
    setMatch(next);
  }, []);

  const endMatch = useCallback(() => {
    setMatch((prev) => (prev ? endMatchByProgress(prev) : prev));
  }, []);

  const bot = solitaireBotFor(botId);
  const view = useMemo(() => (match ? playerView(match) : null), [match]);
  const you = useMemo(() => (match ? playerProgress(match) : null), [match]);
  const botProgress = useMemo(() => (match ? aiProgress(match) : null), [match]);

  // Time left before the inactivity rule ends this race (0 once it has).
  const idleMs =
    match && !match.result
      ? Math.max(0, match.lastActivityAtMs + INACTIVITY_FORFEIT_MS - now)
      : 0;

  const outcome = match?.result ? viewerOutcome(SEAT.PLAYER1, match.result) : null;

  return (
    <section
      data-testid="solitaire-offline-arena"
      data-bot-id={botId}
      aria-label={`Offline practice against ${bot.name}`}
      className="mt-5 w-full"
    >
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <button
            type="button"
            onClick={onExit}
            data-testid="solitaire-offline-exit"
            className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg border border-white/15 px-3 text-[10px] font-bold uppercase tracking-[0.14em] text-white/60 transition hover:border-white/30 hover:text-white focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[#00e5ff]"
          >
            <IconArrowLeft size={14} aria-hidden="true" />
            Bots
          </button>
          <BotAvatar bot={bot} size="h-12 w-12" perfect={bot.id === "perfect"} />
          <div className="min-w-0">
            <p className="flex items-center gap-1.5 text-[10px] font-black uppercase tracking-[0.2em] text-amber-300/80">
              <IconWifiOff size={12} aria-hidden="true" />
              Offline practice
            </p>
            <h2 className="truncate text-xl font-extrabold text-white">{bot.name}</h2>
            <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-white/40">
              {bot.difficultyLabel} · {aiPaceLabel(bot.id)}
            </p>
          </div>
        </div>

        {match && !match.result ? (
          <div className="flex flex-wrap items-center gap-2">
            <span
              data-testid="solitaire-offline-clock"
              className="inline-flex items-center gap-1 rounded-full border border-white/15 bg-white/5 px-2.5 py-1 tabular-nums text-[11px] text-white/60"
            >
              <IconClock size={12} aria-hidden="true" />
              {clockLabel(Math.max(0, now - match.goAtMs))}
            </span>
            <span
              data-testid="solitaire-offline-idle"
              title="Time until you forfeit for inactivity"
              className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 tabular-nums text-[11px] ${
                idleMs <= INACTIVITY_COUNTDOWN_MS
                  ? "border-amber-300/40 bg-amber-400/10 text-amber-200"
                  : "border-white/15 bg-white/5 text-white/50"
              }`}
            >
              <IconHourglassHigh size={12} aria-hidden="true" />
              idle {clockLabel(idleMs)}
            </span>
            <button
              type="button"
              onClick={endMatch}
              data-testid="solitaire-offline-end"
              className="inline-flex h-8 items-center gap-1 rounded-full border border-white/15 px-3 text-[10px] font-bold uppercase tracking-[0.14em] text-white/60 transition hover:border-white/30 hover:text-white focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[#00e5ff]"
            >
              <IconFlag size={12} aria-hidden="true" />
              End
            </button>
          </div>
        ) : null}
      </header>

      {dealing ? (
        <div className="flex min-h-[40vh] flex-col items-center justify-center gap-3 py-10">
          <div className="h-9 w-9 animate-spin rounded-full border-2 border-white/15 border-t-[#00e5ff]" />
          <p className="text-[11px] font-bold uppercase tracking-[0.24em] text-white/50">
            Dealing a solvable board…
          </p>
        </div>
      ) : null}

      {error ? (
        <p
          role="alert"
          className="mt-5 rounded-xl border border-red-400/40 bg-red-500/10 px-4 py-3 text-sm text-red-200"
        >
          {error}
        </p>
      ) : null}

      {match && you && botProgress ? (
        <>
          <div className="mt-3 grid grid-cols-2 gap-3 rounded-2xl border border-white/10 bg-white/[0.03] p-3">
            <Meter
              testId="solitaire-offline-you"
              title="You"
              progress={you}
              ply={match.player.ply}
              bar="bg-[#00e5ff]"
            />
            <Meter
              testId="solitaire-offline-bot"
              title={`Bot · ${bot.name}`}
              progress={botProgress}
              ply={match.ai.ply}
              bar="bg-[#ff4fd8]"
            />
          </div>

          <div className="mt-3 flex flex-wrap items-end justify-between gap-2">
            <dl className="flex gap-2 text-center">
              <MiniStat
                testId="solitaire-offline-hud-time"
                label="Time"
                value={clockLabel(Math.max(0, (match.endedAtMs ?? now) - match.goAtMs))}
              />
              <MiniStat
                testId="solitaire-offline-hud-moves"
                label="Moves"
                value={String(match.log.length)}
              />
              <MiniStat
                testId="solitaire-offline-hud-foundations"
                label="Foundations"
                value={`${you.foundationCards}/52`}
              />
            </dl>
            <SolitaireThemePicker />
          </div>

          <div className="mt-2 rounded-2xl border border-white/10 bg-black/40 p-2 shadow-[0_18px_35px_rgba(3,8,23,0.55)] sm:p-3">
            <SolitaireBoard
              view={view}
              interactive={!match.result && now >= match.goAtMs}
              onMove={onMove}
              onInvalid={setNotice}
            />
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              data-testid="solitaire-offline-rematch"
              onClick={start}
              className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-emerald-400 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-emerald-300"
            >
              <IconRefresh size={14} aria-hidden="true" />
              New deal
            </button>
            <button
              type="button"
              data-testid="solitaire-offline-undo"
              onClick={undoLastMove}
              disabled={match.log.length === 0 || Boolean(match.result) || now < match.goAtMs}
              className="inline-flex items-center gap-1.5 rounded-lg border border-white/15 px-4 py-2 text-sm text-slate-200 transition hover:bg-white/5 disabled:opacity-40 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[#00e5ff]"
            >
              <IconArrowBackUp size={14} aria-hidden="true" />
              Undo
            </button>
          </div>

          <p
            aria-live="polite"
            className="mt-2 min-h-[18px] text-center text-[11px] leading-relaxed text-white/50"
          >
            {notice ??
              (match.player.completed
                ? "Solved — the result is settled."
                : "Click a card to pick it up, then click a highlighted pile to place it.")}
          </p>
        </>
      ) : null}

      {match && !match.result && now < match.goAtMs ? (
        <div className="pointer-events-none fixed inset-0 z-30 flex items-center justify-center bg-[#04070f]/75">
          <div className="text-center">
            <p className="text-[10px] font-black uppercase tracking-[0.3em] text-white/50">
              Same deal · {bot.name}
            </p>
            <p className="mt-2 text-6xl font-black tabular-nums">
              {Math.max(1, Math.ceil((match.goAtMs - now) / 1000))}
            </p>
            <p className="mt-2 text-[10px] font-bold uppercase tracking-[0.2em] text-white/35">
              Running on this device
            </p>
          </div>
        </div>
      ) : null}

      {match && match.result && you && botProgress ? (
        <div
          data-testid="solitaire-offline-result"
          className="fixed inset-0 z-40 flex items-center justify-center bg-[#04070f]/85 p-4"
        >
          <div className="w-full max-w-sm rounded-3xl border border-white/[0.12] bg-[#0a1224] p-5 text-center shadow-[0_18px_35px_rgba(3,8,23,0.6)]">
            <p className="text-[10px] font-black uppercase tracking-[0.3em] text-[#00e5ff]">
              {resolutionLabel(match.resolution) ?? "Match over"}
            </p>
            <p
              data-testid="solitaire-offline-outcome"
              className={`mt-1 text-3xl font-black ${
                outcome === "win"
                  ? "text-emerald-300"
                  : outcome === "loss"
                    ? "text-rose-300"
                    : "text-amber-200"
              }`}
            >
              {outcomeLabel(outcome) || "MATCH OVER"}
            </p>
            <p className="mt-1 text-[11px] uppercase tracking-[0.16em] text-white/40">
              {matchTimeLabel(match)} · vs {bot.name}
            </p>

            <div className="mt-4 grid grid-cols-2 gap-2 text-left">
              <div className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
                <p className="text-[9px] font-black uppercase tracking-[0.16em] text-white/40">You</p>
                <p className="mt-1 text-xs text-white/75">{progressLabel(you)}</p>
              </div>
              <div className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
                <p className="text-[9px] font-black uppercase tracking-[0.16em] text-white/40">
                  {bot.name}
                </p>
                <p className="mt-1 text-xs text-white/75">{progressLabel(botProgress)}</p>
              </div>
            </div>

            <p className="mt-3 text-[10px] leading-relaxed text-white/35">
              This race ran on this device. Nothing was sent, so no Elo, trophies,
              history or account state changed.
            </p>

            <div className="mt-4 flex flex-col gap-2">
              <button
                type="button"
                onClick={start}
                data-testid="solitaire-offline-play-again"
                className="w-full rounded-xl bg-[#00e5ff] px-4 py-3 text-xs font-black uppercase tracking-[0.16em] text-[#04070f] transition hover:brightness-110 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[#00e5ff]"
              >
                Rematch
              </button>
              <button
                type="button"
                onClick={onExit}
                data-testid="solitaire-offline-change-bot"
                className="w-full rounded-xl border border-white/15 px-4 py-2.5 text-xs font-bold uppercase tracking-[0.16em] text-white/65 transition hover:border-white/30 hover:text-white focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[#00e5ff]"
              >
                Choose another bot
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

// ── Small presentational pieces ─────────────────────────────────────────

/** One metric card, styled like the app's solo HUD (Time/Moves/Foundations). */
function MiniStat({
  label,
  value,
  testId,
}: {
  label: string;
  value: string;
  testId: string;
}) {
  return (
    <div data-testid={testId} className="rounded-lg border border-white/10 bg-white/5 px-3 py-2">
      <dt className="text-[10px] uppercase tracking-wider text-slate-400">{label}</dt>
      <dd className="font-mono text-lg text-white">{value}</dd>
    </div>
  );
}

/** One seat's race bar, built from the engine's own progress figures. */
function Meter({
  title,
  progress,
  ply,
  bar,
  testId,
}: {
  title: string;
  progress: SeatProgress;
  ply: number;
  bar: string;
  testId: string;
}) {
  const percent = Math.max(0, Math.min(100, Number(progress?.progressPercent) || 0));
  return (
    <div data-testid={testId} data-ply={ply} data-foundation={progress.foundationCards}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[10px] font-black uppercase tracking-[0.18em] text-white/70">
          {title}
        </span>
        <span className="tabular-nums text-[10px] font-bold text-white/50">{percent}%</span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-white/10">
        <div
          className={`h-full rounded-full transition-[width] duration-300 ${bar}`}
          style={{ width: `${percent}%` }}
        />
      </div>
      <p className="mt-1 text-[10px] leading-snug text-white/40">{progressLabel(progress)}</p>
    </div>
  );
}
