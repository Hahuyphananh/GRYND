// standalone/solitaire-duel/src/App.tsx
//
// The standalone screen: menu → dealing → race → result, with nothing else.
//
// What this file owns is presentation and timing ONLY. Every rule, every
// legality decision and every competitive number comes from `./match` (which in
// turn is the shared engine), so this UI cannot drift from the GRYND game.
//
// The clock: a 250 ms tick advances the bot and re-renders the stopwatch. The
// bot's own pacing is computed from `GO + ply × delay` inside the controller, so
// a slow frame or a background tab cannot make it play faster or slower than
// the app's bot would.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import SolitaireBoard from "../../../src/components/solitaire-duel/SolitaireBoard";
import SolitaireThemePicker from "../../../src/components/solitaire-duel/SolitaireThemePicker";
import {
  SOLITAIRE_BOTS,
  solitaireBotFor,
  solitaireBotStats,
  type SolitaireBotId,
} from "../../../src/lib/solitaire-duel/bots";
import { aiMoveDelayMs, aiPaceLabel } from "../../../src/lib/solitaire-duel/ai";
import { SEAT } from "../../../src/lib/solitaire-duel/constants";
import {
  clockLabel,
  durationSeconds,
  outcomeLabel,
  progressLabel,
  resolutionLabel,
  viewerOutcome,
} from "../../../src/lib/solitaire-duel/ui";
import type { SeatProgress, SolitaireMove } from "../../../src/lib/solitaire-duel/types";
import {
  advanceAi,
  aiProgress,
  applyPlayerMove,
  createLocalMatch,
  endMatchByProgress,
  playerProgress,
  playerView,
  redealPlayerIfDead,
  undoPlayerMove,
  type LocalMatch,
} from "./match";
import { PORTAL_CONFIG } from "./portal-config";
import { PORTAL_RUNTIME } from "./portal-sdk";
import ResultScreen from "./ResultScreen";
import { randomSeed } from "./seed";

/** How often the bot is given a chance to move and the stopwatch updates. */
const TICK_MS = 250;

/** Race time as m:ss, from GO to the instant the result landed. */
function matchTimeLabel(match: LocalMatch): string {
  const startedAt = new Date(match.goAtMs).toISOString();
  const endedAt = new Date(match.endedAtMs ?? match.goAtMs).toISOString();
  const seconds = durationSeconds(startedAt, endedAt) ?? 0;
  return clockLabel(seconds * 1000);
}

export default function App() {
  const [match, setMatch] = useState<LocalMatch | null>(null);
  // The real roster, defaulting to Ace — the bot the old `normal` tier maps to.
  const [botId, setBotId] = useState<SolitaireBotId>("ace");
  const [now, setNow] = useState(() => Date.now());
  const [dealing, setDealing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The click handler must see the newest match without re-binding `onMove` on
  // every tick (the board memoises its target highlighting against it).
  const matchRef = useRef<LocalMatch | null>(null);
  useEffect(() => {
    matchRef.current = match;
  }, [match]);

  const start = useCallback((nextBotId: SolitaireBotId) => {
    setBotId(nextBotId);
    setDealing(true);
    setNotice(null);
    setError(null);
    // Clear the finished match first, so the result overlay disappears the
    // moment "Play again" is pressed instead of lingering over the new deal.
    matchRef.current = null;
    setMatch(null);

    // The deal search is bounded and short (measured: ~40 ms typical, ~130 ms
    // worst case), so it runs inline behind this overlay instead of in a
    // Worker. The 40 ms yields one paint first, so "Dealing…" is actually seen.
    window.setTimeout(() => {
      try {
        const created = createLocalMatch({
          botId: nextBotId,
          seed: randomSeed(),
          nowMs: Date.now(),
        });
        matchRef.current = created;
        setMatch(created);
        setNow(Date.now());
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Could not deal a board. Try again.");
      } finally {
        setDealing(false);
      }
    }, 40);
  }, []);

  const backToMenu = useCallback(() => {
    matchRef.current = null;
    setMatch(null);
    setNotice(null);
    setNow(Date.now());
  }, []);

  // The race clock. Stops the moment a result exists.
  useEffect(() => {
    if (!match || match.result) return undefined;
    const id = window.setInterval(() => {
      const stamp = Date.now();
      setNow(stamp);
      setMatch((prev) =>
        prev && !prev.result ? redealPlayerIfDead(advanceAi(prev, stamp)) : prev,
      );
    }, TICK_MS);
    return () => window.clearInterval(id);
  }, [match?.seed, match?.botId, match?.result]);

  // Portal lifecycle. A complete no-op in every default build; when a portal
  // build enables an SDK, a blocked or dead CDN can only fail quietly and the
  // game continues (see src/portal-sdk.ts).
  useEffect(() => {
    PORTAL_RUNTIME.boot();
    const id = window.setTimeout(() => PORTAL_RUNTIME.loaded(), 0);
    return () => window.clearTimeout(id);
  }, []);

  // gameplayStart/gameplayStop around a live match, and one celebration on a
  // win. Keyed on the match's identity and result, not on the object, so the
  // 250 ms tick does not re-fire it.
  useEffect(() => {
    if (!match) {
      PORTAL_RUNTIME.leaveMatch();
      return;
    }
    if (!match.result) {
      PORTAL_RUNTIME.enterMatch();
      return;
    }
    PORTAL_RUNTIME.leaveMatch();
    if (viewerOutcome(SEAT.PLAYER1, match.result) === "win") PORTAL_RUNTIME.celebrate();
  }, [match?.seed, match?.result]);

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

  // Take back the last accepted move. The board comes from the controller's
  // replay of the shortened log, exactly like the app's undo.
  const undoLastMove = useCallback(() => {
    const current = matchRef.current;
    if (!current) return;
    const next = undoPlayerMove(current);
    if (next === current) return;
    matchRef.current = next;
    setMatch(next);
  }, []);

  const view = useMemo(() => (match ? playerView(match) : null), [match]);
  const you = useMemo(() => (match ? playerProgress(match) : null), [match]);
  const bot = useMemo(() => (match ? aiProgress(match) : null), [match]);

  return (
    <div className="min-h-screen w-full bg-[radial-gradient(80%_60%_at_50%_-10%,#12213f_0%,#080d1a_55%,#04070f_100%)] text-white">
      <div className="mx-auto flex min-h-screen w-full max-w-3xl flex-col px-3 pb-8 pt-4 sm:px-5">
        <header className="flex items-center justify-between gap-2">
          <div>
            <h1 className="text-[clamp(15px,2.4vw,20px)] font-black uppercase tracking-[0.18em]">
              Solitaire<span className="text-[#00e5ff]">Duel</span>
            </h1>
            <p className="text-[10px] uppercase tracking-[0.2em] text-white/40">
              Same deal · one puzzle · race the bot
            </p>
          </div>

          {match && !match.result ? (
            <div className="flex items-center gap-2">
              <span className="rounded-full border border-white/15 bg-white/5 px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-white/70">
                {solitaireBotFor(match.botId).difficultyLabel}
              </span>
              <span
                data-testid="match-clock"
                className="tabular-nums text-[11px] text-white/50"
              >
                {clockLabel(Math.max(0, now - match.goAtMs))}
              </span>
              <button
                type="button"
                onClick={() => setMatch((prev) => (prev ? endMatchByProgress(prev) : prev))}
                className="gr-focusable rounded-full border border-white/15 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-white/60 transition hover:border-white/30 hover:text-white"
              >
                End
              </button>
            </div>
          ) : null}
        </header>

        <main className="mt-3 flex flex-1 flex-col">
          {!match && !dealing ? (
            <Menu botId={botId} onPick={setBotId} onStart={start} />
          ) : null}

          {dealing ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 py-10">
              <div className="h-9 w-9 animate-spin rounded-full border-2 border-white/15 border-t-[#00e5ff]" />
              <p className="text-[11px] font-bold uppercase tracking-[0.24em] text-white/50">
                Finding a solvable deal…
              </p>
            </div>
          ) : null}

          {match && you && bot ? (
            <>
              <div className="grid grid-cols-2 gap-3 rounded-2xl border border-white/10 bg-white/[0.03] p-3">
                <StatBlock
                  testId="you-progress"
                  title="You"
                  progress={you}
                  ply={match.player.ply}
                  bar="bg-[#00e5ff]"
                />
                <StatBlock
                  testId="bot-progress"
                  title={`Bot · ${solitaireBotFor(match.botId).name}`}
                  progress={bot}
                  ply={match.ai.ply}
                  bar="bg-[#ff4fd8]"
                />
              </div>

              {/* The tier is PACE, not strength: the bot follows the deal's
                  proven line at every tier, so this is what the choice actually
                  changes. */}
              <p
                data-testid="solver-pace"
                data-delay-ms={aiMoveDelayMs(match.botId)}
                className="mt-1.5 text-center text-[10px] font-bold uppercase tracking-[0.16em] text-white/35"
              >
                {aiPaceLabel(match.botId)} — its real move pace
              </p>

              {/* The app's own HUD line: time, moves and foundation cards,
                  in the same metric cards the solo screen uses. The race clock
                  freezes the instant the result lands. */}
              <div className="mt-3 flex flex-wrap items-end justify-between gap-2">
                <dl className="flex gap-2 text-center">
                  <MiniStat
                    testId="hud-time"
                    label="Time"
                    value={clockLabel(Math.max(0, (match.endedAtMs ?? now) - match.goAtMs))}
                  />
                  <MiniStat testId="hud-moves" label="Moves" value={String(match.log.length)} />
                  <MiniStat
                    testId="hud-foundations"
                    label="Foundations"
                    value={`${you.foundationCards}/52`}
                  />
                </dl>

                {/* The same table selector as the app: the portal renders the
                    shared board, so it must not be the only Solitaire surface
                    where the player's table is fixed to Classic Green. */}
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

              {/* The app's action row, under the board: a fresh race and an
                  undo. Undo is disabled once the result lands, while the board
                  is still hidden behind the countdown, and when there is
                  nothing to take back. */}
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  data-testid="new-game"
                  onClick={() => start(match.botId)}
                  className="gr-focusable rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-emerald-400"
                >
                  New game
                </button>
                <button
                  type="button"
                  data-testid="undo-move"
                  onClick={undoLastMove}
                  disabled={match.log.length === 0 || Boolean(match.result) || now < match.goAtMs}
                  className="gr-focusable rounded-lg border border-white/15 px-4 py-2 text-sm text-slate-200 transition hover:bg-white/5 disabled:opacity-40"
                >
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

          {error ? (
            <p className="mt-3 rounded-xl border border-red-400/40 bg-red-950/40 p-3 text-sm text-red-200">
              {error}
            </p>
          ) : null}
        </main>
      </div>

      {match && !match.result && now < match.goAtMs ? (
        <div className="pointer-events-none fixed inset-0 z-30 flex items-center justify-center bg-[#04070f]/75">
          <div className="text-center">
            <p className="text-[10px] font-black uppercase tracking-[0.3em] text-white/50">
              Same deal · {solitaireBotFor(match.botId).name}
            </p>
            <p className="mt-2 text-6xl font-black tabular-nums">
              {Math.max(1, Math.ceil((match.goAtMs - now) / 1000))}
            </p>
          </div>
        </div>
      ) : null}

      {match && match.result && you && bot ? (
        <ResultScreen
          outcome={outcomeLabel(viewerOutcome(SEAT.PLAYER1, match.result)) || "MATCH OVER"}
          resolution={resolutionLabel(match.resolution)}
          durationLabel={matchTimeLabel(match)}
          playerProgress={you}
          botProgress={bot}
          botLabel={`Bot · ${solitaireBotFor(match.botId).name}`}
          cta={PORTAL_CONFIG}
          onReplay={() => start(match.botId)}
          onChangeDifficulty={backToMenu}
        />
      ) : null}
    </div>
  );
}

// ── Small presentational pieces ─────────────────────────────────────────

/** One metric card, styled exactly like the app's solo HUD (Time/Moves/Best). */
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
    <div
      data-testid={testId}
      className="rounded-lg border border-white/10 bg-white/5 px-3 py-2"
    >
      <dt className="text-[10px] uppercase tracking-wider text-slate-400">{label}</dt>
      <dd className="font-mono text-lg text-white">{value}</dd>
    </div>
  );
}

function StatBlock({
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
  const foundations = Math.max(0, Math.trunc(Number(progress?.foundationCards) || 0));
  return (
    <div data-testid={testId} data-ply={ply} data-foundation={foundations}>
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
      {/* The competitive numbers, printed exactly as the settlement compares
          them: foundations first, revealed cards second. */}
      <p className="mt-1 text-[10px] leading-snug text-white/40">{progressLabel(progress)}</p>
    </div>
  );
}


function Menu({
  botId,
  onPick,
  onStart,
}: {
  botId: SolitaireBotId;
  onPick: (id: SolitaireBotId) => void;
  onStart: (id: SolitaireBotId) => void;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center py-6">
      <div className="w-full max-w-md rounded-3xl border border-white/10 bg-white/[0.03] p-5 text-center">
        <p className="text-[10px] font-black uppercase tracking-[0.3em] text-[#00e5ff]">
          Practice race
        </p>
        <h2 className="mt-2 text-2xl font-black leading-tight">
          You and the bot get the same Klondike deal.
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-white/60">
          Clear all 52 cards onto the foundations before the bot does. Every deal is proven
          solvable before you see it — and never laid out for you.
        </p>

        {/* The same six opponents the app's practice lobby offers, with the
            stats the roster derives: real pace and a measured typical finish. */}
        <div className="mt-5 grid grid-cols-2 gap-2 text-left">
          {SOLITAIRE_BOTS.map((bot) => {
            const stats = solitaireBotStats(bot);
            const active = botId === bot.id;
            return (
              <button
                key={bot.id}
                type="button"
                onClick={() => onPick(bot.id)}
                aria-pressed={active}
                data-testid={`bot-${bot.id}`}
                data-pace-ms={bot.ai.moveDelayMs}
                className={`gr-focusable rounded-xl border px-2 py-2 transition ${
                  active
                    ? "border-[#00e5ff] bg-[#00e5ff]/15 text-white"
                    : "border-white/15 bg-white/[0.02] text-white/70 hover:border-white/30"
                }`}
              >
                <span className="flex items-baseline justify-between gap-1 text-xs font-black uppercase tracking-wider">
                  <span>{bot.name}</span>
                  <span className="text-[9px] font-bold text-white/40">{bot.ratingLabel}</span>
                </span>
                <span className="mt-0.5 block text-[9px] font-bold uppercase tracking-wider text-white/40">
                  {bot.difficultyLabel} · {stats.paceLabel}
                </span>
                <span className="mt-0.5 block text-[9px] font-bold tracking-wider text-white/30">
                  {stats.finishLabel} typical
                </span>
              </button>
            );
          })}
        </div>

        <p className="mt-2 text-[10px] leading-snug text-white/35">
          Six named opponents, from Rookie to Perfect: stronger bots plan further
          ahead, make fewer mistakes and finish the deal faster.
        </p>

        <button
          type="button"
          data-testid="start-race"
          onClick={() => onStart(botId)}
          className="gr-focusable mt-4 w-full rounded-xl bg-[#00e5ff] px-4 py-3 text-sm font-black uppercase tracking-[0.18em] text-[#04070f] transition hover:brightness-110"
        >
          Start race
        </button>

        <p className="mt-3 text-[10px] uppercase tracking-wider text-white/30">
          No account · no rewards · nothing saved
        </p>
      </div>
    </div>
  );
}
