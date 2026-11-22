"use client";

// src/components/solitaire-duel/StrategicPuzzlePlayer.tsx
//
// THE STRATEGIC PUZZLE PLAYER — introduction, board, progress, hints, result.
//
// This is the player for the validated multi-move library
// (`lib/solitaire-duel/puzzleLibrary.ts`), not the older one-move practice
// drill. It reuses the shipped `SolitaireBoard` for every card, gesture and
// theme: there is no second board implementation and no second rules engine.
// Moves go through `applyPuzzleMove`, which applies them with `./rules.ts`.
//
// WHAT THE PLAYER SEES
//   * before starting: title, category, difficulty, objective, constraints and
//     the strategic skill — never the solution;
//   * while playing: the objective, a measurable progress meter, moves vs par,
//     stock cycles, up to three hints revealed one at a time, restart and exit;
//   * after a move: illegal / legal-but-neutral / progress / complete, with
//     neutral moves described as "does not advance the objective", never as a
//     mistake;
//   * on completion: the concept, why the line worked, the player's own facts,
//     retry, next puzzle and exit.
//
// ACCESSIBILITY: native buttons, `role="progressbar"` with values, live regions
// for feedback and hints, focus moved to the completion heading, and no
// animation of its own (the shared board already honours reduced motion).
//
// LOCALIZATION: every sentence is a key resolved through `useTranslation`.
// Puzzle copy lives in `puzzleLibrary`, player chrome in `puzzlePlayer`.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import {
  IconArrowLeft,
  IconArrowRight,
  IconBulb,
  IconCheck,
  IconRefresh,
  IconX,
} from "@tabler/icons-react";

import SolitaireBoard from "./SolitaireBoard";
import ModeTableau from "../play/ModeTableau";
import GlitchSay from "../mascot/GlitchSay";
import { useTranslation } from "../../hooks/useTranslation";
import {
  PUZZLE_LIBRARY_CATEGORIES,
  PUZZLE_LIBRARY_LEVELS,
  type PuzzleLibraryCategory,
} from "../../lib/solitaire-duel/puzzleVocabulary";
import type { PlayerPuzzle } from "../../lib/solitaire-duel/puzzlePlayerData";
import {
  applyPuzzleMove,
  createPuzzleSession,
  puzzleObjectiveLines,
  puzzleSessionProgress,
  restartPuzzleSession,
  type PuzzleMoveStatus,
  type PuzzleObjectiveLine,
  type PuzzleSession,
} from "../../lib/solitaire-duel/puzzleSession";
import { usePuzzleProgress } from "../../hooks/usePuzzleProgress";
import {
  completedPuzzleCount,
  dailyPuzzleForDate,
  filterPuzzles,
  puzzleDayKey,
  puzzleRecord,
  puzzleStatus,
  recommendedPuzzle,
  type PuzzleStatus,
} from "../../lib/solitaire-duel/puzzleProgress";
import type { SolitaireMove } from "../../lib/solitaire-duel/types";

type Phase = "intro" | "playing" | "complete";

type Feedback = { status: PuzzleMoveStatus; revealed: number } | null;

const FEEDBACK_TONE: Record<PuzzleMoveStatus, string> = {
  illegal: "border-rose-400/35 bg-rose-400/10 text-rose-100",
  "no-progress": "border-amber-300/35 bg-amber-300/10 text-amber-50",
  progress: "border-cyan-300/35 bg-cyan-300/10 text-cyan-50",
  complete: "border-emerald-300/40 bg-emerald-300/10 text-emerald-50",
};

const FEEDBACK_LABEL: Record<PuzzleMoveStatus, string> = {
  illegal: "text-rose-300",
  "no-progress": "text-amber-200",
  progress: "text-cyan-200",
  complete: "text-emerald-200",
};

const STATUS_TONE: Record<PuzzleStatus, string> = {
  new: "border-white/15 bg-white/5 text-white/55",
  "in-progress": "border-cyan-300/35 bg-cyan-300/10 text-cyan-100",
  completed: "border-emerald-300/35 bg-emerald-300/10 text-emerald-100",
  updated: "border-amber-300/35 bg-amber-300/10 text-amber-100",
};

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-full border px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.1em] transition focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-cyan-300 motion-reduce:transition-none ${
        active
          ? "border-cyan-300/60 bg-cyan-300/15 text-cyan-50"
          : "border-white/10 bg-white/[0.03] text-white/50 hover:border-white/25 hover:text-white"
      }`}
    >
      {children}
    </button>
  );
}

export default function StrategicPuzzlePlayer({ puzzles }: { puzzles: PlayerPuzzle[] }) {
  const { t } = useTranslation();
  const {
    progress: savedProgress,
    isProgressLoaded,
    startPuzzle,
    completePuzzle,
  } = usePuzzleProgress(puzzles);
  const [categoryFilter, setCategoryFilter] = useState<PuzzleLibraryCategory | "all">("all");
  const [levelFilter, setLevelFilter] = useState<number | "all">("all");
  const [statusFilter, setStatusFilter] = useState<"all" | "unfinished" | "completed">("all");
  const [dayKey, setDayKey] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  const [phase, setPhase] = useState<Phase>("intro");
  const [session, setSession] = useState<PuzzleSession | null>(() =>
    puzzles[0] ? createPuzzleSession(puzzles[0].spec) : null,
  );
  const [hintsShown, setHintsShown] = useState(0);
  const [feedback, setFeedback] = useState<Feedback>(null);
  // The library is a selector, not part of the board: once a position is picked
  // it leaves the screen so the puzzle owns the viewport.
  const [browsing, setBrowsing] = useState(true);
  const carouselRef = useRef<HTMLUListElement | null>(null);
  const completeHeadingRef = useRef<HTMLHeadingElement | null>(null);

  const puzzle = puzzles[index] ?? null;
  const par = puzzle ? puzzle.par : 0;
  const progress = session ? puzzleSessionProgress(session) : null;
  const objectiveLines = useMemo<PuzzleObjectiveLine[]>(
    () => (puzzle ? puzzleObjectiveLines(puzzle.spec.objective) : []),
    [puzzle],
  );

  const record = puzzle ? puzzleRecord(savedProgress, puzzle.id) : null;
  const filteredPuzzles = useMemo(
    () =>
      filterPuzzles(
        puzzles,
        { category: categoryFilter, level: levelFilter, status: statusFilter },
        savedProgress,
      ),
    [puzzles, categoryFilter, levelFilter, statusFilter, savedProgress],
  );
  const completedCount = useMemo(
    () => completedPuzzleCount(puzzles, savedProgress),
    [puzzles, savedProgress],
  );
  const daily = dayKey ? dailyPuzzleForDate(puzzles, dayKey) : null;
  const dailyNumber = daily ? puzzles.findIndex((entry) => entry.id === daily.id) + 1 : 0;
  const continueIndex = savedProgress.lastPuzzleId
    ? puzzles.findIndex((entry) => entry.id === savedProgress.lastPuzzleId)
    : -1;
  const nextChallenge = useMemo(
    () => recommendedPuzzle(puzzles, savedProgress),
    [puzzles, savedProgress],
  );
  const statusLabel = (status: PuzzleStatus) =>
    status === "completed"
      ? t("puzzlePlayer.library.completedBadge")
      : status === "updated"
        ? t("puzzlePlayer.library.updatedBadge")
        : status === "in-progress"
          ? t("puzzlePlayer.library.inProgressBadge")
          : t("puzzlePlayer.library.newBadge");

  const glitchMessage =
    phase === "complete"
      ? "Solved. Take the next position when you are ready."
      : feedback?.status === "illegal"
        ? "That move is not legal on this table."
        : feedback?.status === "no-progress"
          ? "Legal, but it does not move the objective. Look for a line that does."
          : feedback?.status === "progress"
            ? "Good — that advanced the objective."
            : browsing
              ? "Pick a position. The board opens as soon as you choose it."
              : "Read the objective, then start when you are ready.";

  const select = useCallback(
    (nextIndex: number) => {
      if (puzzles.length === 0) return;
      const wrapped = ((nextIndex % puzzles.length) + puzzles.length) % puzzles.length;
      const next = puzzles[wrapped];
      setIndex(wrapped);
      setSession(createPuzzleSession(next.spec));
      setPhase("intro");
      setHintsShown(0);
      setFeedback(null);
    },
    [puzzles],
  );

  const pick = useCallback(
    (nextIndex: number) => {
      select(nextIndex);
      setBrowsing(false);
    },
    [select],
  );

  const start = useCallback(() => {
    if (!puzzle) return;
    setSession(createPuzzleSession(puzzle.spec));
    setPhase("playing");
    setHintsShown(0);
    setFeedback(null);
    startPuzzle(puzzle);
  }, [puzzle, startPuzzle]);

  const restart = useCallback(() => {
    if (!session || !puzzle) return;
    setSession(restartPuzzleSession(session));
    setPhase("playing");
    setHintsShown(0);
    setFeedback(null);
    startPuzzle(puzzle);
  }, [session, puzzle, startPuzzle]);

  const play = useCallback(
    (move: SolitaireMove) => {
      if (!session || !puzzle || phase !== "playing") return;
      const outcome = applyPuzzleMove(session, move);
      setSession(outcome.session);
      setFeedback({ status: outcome.status, revealed: outcome.revealed.length });
      if (outcome.status === "complete") {
        setPhase("complete");
        completePuzzle(puzzle, outcome.session.stats.moves, hintsShown);
      }
    },
    [session, puzzle, phase, completePuzzle, hintsShown],
  );

  // A click the shared board could not turn into a move (rare, but the board
  // reports it). It is still "illegal", not "wrong plan".
  const onInvalid = useCallback(() => {
    setFeedback({ status: "illegal", revealed: 0 });
  }, []);

  const showHint = useCallback(() => {
    if (!puzzle) return;
    setHintsShown((current) => Math.min(current + 1, puzzle.hints.length));
  }, [puzzle]);

  useEffect(() => {
    if (phase === "complete") completeHeadingRef.current?.focus();
  }, [phase]);

  // The daily pick is computed after mount: the server and the browser can sit
  // on different UTC dates for a moment around midnight, and rendering two
  // different picks during hydration would be a mismatch.
  useEffect(() => {
    setDayKey(puzzleDayKey());
  }, []);

  if (!puzzle || !session || !progress) {
    return (
      <section className="rounded-3xl border border-white/10 bg-surface p-6">
        <p className="text-sm text-white/60">{t("puzzlePlayer.states.empty")}</p>
      </section>
    );
  }

  const total = puzzles.length;
  const categoryName = t(`puzzleLibrary.categories.${puzzle.category}.name`);
  const categoryDescription = t(`puzzleLibrary.categories.${puzzle.category}.description`);
  const concept = t(`puzzleLibrary.concepts.${puzzle.category}`);
  const levelName = t(puzzle.levelKey);
  const pct =
    progress.target > 0
      ? Math.max(0, Math.min(100, Math.round((progress.current / progress.target) * 100)))
      : 0;
  const stockCycles = session.stats.stockPasses + session.stats.stockRecycles;
  const levelTone =
    puzzle.levelNumber >= 5
      ? "border-rose-300/40 bg-rose-300/10 text-rose-100"
      : puzzle.levelNumber >= 4
        ? "border-amber-300/40 bg-amber-300/10 text-amber-100"
        : puzzle.levelNumber >= 3
          ? "border-violet-300/40 bg-violet-300/10 text-violet-100"
          : puzzle.levelNumber >= 2
            ? "border-cyan-300/40 bg-cyan-300/10 text-cyan-100"
            : "border-emerald-300/40 bg-emerald-300/10 text-emerald-100";

  return (
    <section
      aria-labelledby="strategic-puzzle-heading"
      // An explicit dark table: the puzzle panel must stay readable in the
      // light theme, where the white-on-surface copy would otherwise vanish.
      className="rounded-3xl border border-cyan-400/25 bg-[#050b1e] p-4 text-white shadow-[0_18px_60px_-30px_rgba(0,229,255,0.35)] sm:p-6"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[10px] font-black uppercase tracking-[0.3em] text-cyan-300/80">
            {t("puzzlePlayer.eyebrow")}
          </p>
          <h1
            id="strategic-puzzle-heading"
            className="mt-1 text-2xl font-black tracking-tight text-white sm:text-3xl"
          >
            {t("puzzlePlayer.heading")}
          </h1>
          <p className="mt-1 font-mono text-xs text-white/45">
            {t("puzzlePlayer.intro.position", { number: index + 1, total })}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {!browsing && (
            <button
              type="button"
              onClick={() => setBrowsing(true)}
              data-testid="puzzle-back-to-library"
              className="inline-flex items-center gap-1 rounded-full border border-white/15 bg-white/5 px-2.5 py-1 text-[10px] font-black uppercase tracking-[0.12em] text-white/60 transition hover:border-white/30 hover:text-white focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-cyan-300 motion-reduce:transition-none"
            >
              <IconArrowLeft size={12} aria-hidden="true" />
              {t("puzzlePlayer.library.title")}
            </button>
          )}
          <span className="rounded-full border border-white/15 bg-white/5 px-2.5 py-1 text-[10px] font-black uppercase tracking-[0.14em] text-white/65">
            {categoryName}
          </span>
          <span
            className={`rounded-full border px-2.5 py-1 text-[10px] font-black uppercase tracking-[0.14em] ${levelTone}`}
          >
            {levelName}
          </span>
        </div>
      </div>

      {browsing && (
      <div
        data-testid="puzzle-library"
        className="mt-4 rounded-2xl border border-white/10 bg-white/[0.02] p-3 sm:p-4"
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[10px] font-black uppercase tracking-[0.18em] text-white/45">
              {t("puzzlePlayer.library.title")}
            </p>
            <p className="mt-0.5 text-xs text-white/50">
              {t("puzzlePlayer.library.summary", { completed: completedCount, total })}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {continueIndex >= 0 && (
              <button
                type="button"
                onClick={() => pick(continueIndex)}
                data-testid="puzzle-continue"
                className="inline-flex items-center gap-1.5 rounded-lg border border-cyan-300/40 bg-cyan-300/10 px-2.5 py-1.5 text-[10px] font-black uppercase tracking-[0.12em] text-cyan-100 transition hover:bg-cyan-300/20 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-cyan-300 motion-reduce:transition-none"
              >
                {t("puzzlePlayer.library.continue")}
              </button>
            )}
            {nextChallenge && (
              <button
                type="button"
                onClick={() =>
                  pick(puzzles.findIndex((entry) => entry.id === nextChallenge.id))
                }
                data-testid="puzzle-next-challenge"
                className="inline-flex items-center gap-1.5 rounded-lg border border-white/15 px-2.5 py-1.5 text-[10px] font-black uppercase tracking-[0.12em] text-white/60 transition hover:border-white/30 hover:text-white focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-cyan-300 motion-reduce:transition-none"
              >
                {t("puzzlePlayer.library.next")}
                <IconArrowRight size={13} aria-hidden="true" />
              </button>
            )}
          </div>
        </div>

        {daily && dayKey && (
          <div
            data-testid="puzzle-daily"
            className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-300/30 bg-amber-300/10 px-3 py-2"
          >
            <div className="min-w-0">
              <p className="text-[10px] font-black uppercase tracking-[0.14em] text-amber-200/85">
                {t("puzzlePlayer.library.daily")} ·{" "}
                <span className="font-mono normal-case tracking-normal">{dayKey}</span>
              </p>
              <p className="mt-0.5 truncate text-sm font-bold text-white">
                {t("puzzlePlayer.intro.title", {
                  number: dailyNumber,
                  category: t(`puzzleLibrary.categories.${daily.category}.name`),
                })}
              </p>
              <p className="text-[10px] text-amber-100/50">
                {t("puzzlePlayer.library.dailyNote", { date: dayKey })}
              </p>
            </div>
            <button
              type="button"
              onClick={() => pick(dailyNumber - 1)}
              data-testid="puzzle-play-daily"
              className="inline-flex items-center gap-1.5 rounded-lg border border-amber-300/45 bg-amber-300/15 px-2.5 py-1.5 text-[10px] font-black uppercase tracking-[0.12em] text-amber-50 transition hover:bg-amber-300/25 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-amber-300 motion-reduce:transition-none"
            >
              {t("puzzlePlayer.library.playDaily")}
            </button>
          </div>
        )}

        <div className="mt-3">
          <GlitchSay size="sm" message={glitchMessage} />
        </div>

        <div className="mt-3 space-y-2">
          <div
            role="group"
            aria-label={t("puzzlePlayer.library.categoryLabel")}
            className="flex flex-wrap items-center gap-1.5"
          >
            <Chip active={categoryFilter === "all"} onClick={() => setCategoryFilter("all")}>
              {t("puzzlePlayer.library.allCategories")}
            </Chip>
            {PUZZLE_LIBRARY_CATEGORIES.map((category) => (
              <Chip
                key={category.id}
                active={categoryFilter === category.id}
                onClick={() => setCategoryFilter(category.id)}
              >
                {t(category.nameKey)}
              </Chip>
            ))}
          </div>

          <div
            role="group"
            aria-label={t("puzzlePlayer.library.levelLabel")}
            className="flex flex-wrap items-center gap-1.5"
          >
            <Chip active={levelFilter === "all"} onClick={() => setLevelFilter("all")}>
              {t("puzzlePlayer.library.allLevels")}
            </Chip>
            {PUZZLE_LIBRARY_LEVELS.map((level) => (
              <Chip
                key={level.id}
                active={levelFilter === level.level}
                onClick={() => setLevelFilter(level.level)}
              >
                {t(level.key)}
              </Chip>
            ))}
          </div>

          <div
            role="group"
            aria-label={t("puzzlePlayer.library.statusLabel")}
            className="flex flex-wrap items-center gap-1.5"
          >
            <Chip active={statusFilter === "all"} onClick={() => setStatusFilter("all")}>
              {t("puzzlePlayer.library.allStatuses")}
            </Chip>
            <Chip
              active={statusFilter === "unfinished"}
              onClick={() => setStatusFilter("unfinished")}
            >
              {t("puzzlePlayer.library.unfinished")}
            </Chip>
            <Chip
              active={statusFilter === "completed"}
              onClick={() => setStatusFilter("completed")}
            >
              {t("puzzlePlayer.library.completedFilter")}
            </Chip>
          </div>
        </div>

        {filteredPuzzles.length === 0 ? (
          <p className="mt-4 text-xs text-white/45">{t("puzzlePlayer.library.empty")}</p>
        ) : (
          <div className="mt-3 flex items-stretch gap-2">
            <button
              type="button"
              aria-label="Scroll puzzles left"
              onClick={() => carouselRef.current?.scrollBy({ left: -300, behavior: "smooth" })}
              className="shrink-0 self-center rounded-full border border-white/15 bg-white/5 p-2 text-white/60 transition hover:border-cyan-300/50 hover:text-white focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-cyan-300 motion-reduce:transition-none"
            >
              <IconArrowLeft size={16} aria-hidden="true" />
            </button>
          <ul
            ref={carouselRef}
            className="flex min-w-0 flex-1 snap-x snap-mandatory gap-2 overflow-x-auto pb-2"
          >
            {filteredPuzzles.map((entry) => {
              const number = puzzles.findIndex((item) => item.id === entry.id) + 1;
              const status = puzzleStatus(savedProgress, entry);
              const entryRecord = puzzleRecord(savedProgress, entry.id);
              const active = entry.id === puzzle.id;
              return (
                <li key={entry.id} className="w-64 shrink-0 snap-start">
                  <button
                    type="button"
                    onClick={() => pick(number - 1)}
                    aria-pressed={active}
                    data-testid={`puzzle-card-${entry.id}`}
                    className={`flex h-full w-full flex-col rounded-xl border px-2.5 py-2 text-left transition focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-cyan-300 motion-reduce:transition-none ${
                      active
                        ? "border-cyan-300/60 bg-cyan-300/10"
                        : "border-white/10 bg-white/[0.03] hover:border-white/25"
                    }`}
                  >
                    {Math.abs(number - 1 - index) <= 1 && (
                      <span className="mb-2 block overflow-hidden rounded-lg border border-white/10">
                        <ModeTableau variant="dailyPuzzle" />
                      </span>
                    )}
                    <span className="flex items-start justify-between gap-2">
                      <span className="text-xs font-bold leading-snug text-white">
                        {t("puzzlePlayer.intro.title", {
                          number,
                          category: t(`puzzleLibrary.categories.${entry.category}.name`),
                        })}
                      </span>
                      <span
                        className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[8px] font-black uppercase tracking-[0.08em] ${STATUS_TONE[status]}`}
                      >
                        {statusLabel(status)}
                      </span>
                    </span>
                    <span className="mt-1 flex items-center justify-between gap-2 text-[10px] text-white/45">
                      <span>{t(entry.levelKey)}</span>
                      {entryRecord?.completed &&
                        entryRecord.version === entry.spec.version &&
                        entryRecord.bestMoves != null && (
                          <span className="font-mono text-emerald-300/80">
                            {entryRecord.bestHints != null
                              ? t("puzzlePlayer.library.bestHints", {
                                  moves: entryRecord.bestMoves,
                                  hints: entryRecord.bestHints,
                                })
                              : t("puzzlePlayer.library.best", {
                                  moves: entryRecord.bestMoves,
                                })}
                          </span>
                        )}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
            <button
              type="button"
              aria-label="Scroll puzzles right"
              onClick={() => carouselRef.current?.scrollBy({ left: 300, behavior: "smooth" })}
              className="shrink-0 self-center rounded-full border border-white/15 bg-white/5 p-2 text-white/60 transition hover:border-cyan-300/50 hover:text-white focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-cyan-300 motion-reduce:transition-none"
            >
              <IconArrowRight size={16} aria-hidden="true" />
            </button>
          </div>
        )}
      </div>
      )}

      {!browsing && phase === "intro" && (
        <div
          data-testid="puzzle-intro"
          className="mt-5 grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start"
        >
          <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 sm:p-5">
            <h2 className="text-xl font-black tracking-tight text-white">
              {t("puzzlePlayer.intro.title", { number: index + 1, category: categoryName })}
            </h2>

            <dl className="mt-3 grid grid-cols-3 gap-2 text-[11px]">
              <div className="rounded-lg border border-white/10 bg-black/15 px-2.5 py-1.5">
                <dt className="uppercase tracking-[0.12em] text-white/40">
                  {t("puzzlePlayer.hud.moves")}
                </dt>
                <dd className="mt-0.5 font-mono text-sm font-bold text-white">0</dd>
              </div>
              <div className="rounded-lg border border-white/10 bg-black/15 px-2.5 py-1.5">
                <dt className="uppercase tracking-[0.12em] text-white/40">
                  {t("puzzlePlayer.hud.par")}
                </dt>
                <dd className="mt-0.5 font-mono text-sm font-bold text-white">{par}</dd>
              </div>
              <div className="rounded-lg border border-white/10 bg-black/15 px-2.5 py-1.5">
                <dt className="uppercase tracking-[0.12em] text-white/40">
                  {t("puzzlePlayer.hud.hints")}
                </dt>
                <dd className="mt-0.5 font-mono text-sm font-bold text-white">
                  {puzzle.hints.length}
                </dd>
              </div>
            </dl>

            <div className="mt-4">
              <p className="text-[10px] font-black uppercase tracking-[0.18em] text-cyan-200/80">
                {t("puzzlePlayer.intro.objective")}
              </p>
              <ul className="mt-1.5 space-y-1 text-sm leading-relaxed text-white/80">
                {objectiveLines.map((line, lineIndex) => {
                  const destination = line.destination
                    ? t(line.destination.key, line.destination.params)
                    : undefined;
                  return (
                    <li key={`${line.key}-${lineIndex}`} className="flex gap-2">
                      <IconCheck size={15} aria-hidden="true" className="mt-0.5 shrink-0 text-cyan-300" />
                      <span>{t(line.key, { ...line.params, ...(destination ? { destination } : {}) })}</span>
                    </li>
                  );
                })}
              </ul>
            </div>

            <p className="mt-4 text-[10px] font-black uppercase tracking-[0.18em] text-white/40">
              {t("puzzlePlayer.intro.constraints")}
            </p>
            <ul className="mt-1 space-y-0.5 text-xs text-white/55">
              <li>{t("puzzlePlayer.intro.par", { moves: par })}</li>
              <li>{t("puzzlePlayer.intro.noMoveLimit")}</li>
              <li>{t("puzzlePlayer.intro.stock")}</li>
            </ul>

            <button
              type="button"
              onClick={start}
              data-testid="puzzle-start"
              className="mt-5 inline-flex w-full items-center justify-center gap-2 rounded-xl border border-cyan-300/60 bg-cyan-300/15 px-4 py-2.5 text-sm font-black uppercase tracking-[0.14em] text-cyan-50 transition hover:bg-cyan-300/25 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-cyan-300 motion-reduce:transition-none sm:w-auto"
            >
              {t("puzzlePlayer.intro.start")}
              <IconArrowRight size={16} aria-hidden="true" />
            </button>
          </div>

          <aside className="space-y-3">
            <div className="rounded-2xl border border-cyan-300/25 bg-cyan-300/[0.06] p-3">
              <GlitchSay size="sm" message={glitchMessage} />
            </div>
            <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-3">
              <p className="text-[10px] font-black uppercase tracking-[0.18em] text-white/40">
                {t("puzzlePlayer.intro.skill")}
              </p>
              <p className="mt-1 text-sm font-semibold text-white/85">{categoryDescription}</p>
              <p className="mt-2 text-xs leading-relaxed text-white/50">{concept}</p>
            </div>

            {isProgressLoaded && record && (
              <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-3">
                <p className="text-[10px] font-black uppercase tracking-[0.18em] text-white/40">
                  {t("puzzlePlayer.library.attempts", { count: record.attempts })}
                </p>
                {record.completed && record.bestMoves != null && (
                  <p className="mt-1 text-xs text-white/60">
                    {record.bestHints != null
                      ? t("puzzlePlayer.library.bestHints", {
                          moves: record.bestMoves,
                          hints: record.bestHints,
                        })
                      : t("puzzlePlayer.library.best", { moves: record.bestMoves })}
                  </p>
                )}
                {puzzleStatus(savedProgress, puzzle) === "completed" && (
                  <p className="mt-1 text-[10px] font-bold uppercase tracking-[0.12em] text-emerald-300/80">
                    {t("puzzlePlayer.library.replay")}
                  </p>
                )}
              </div>
            )}

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => pick(index - 1)}
                className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-white/15 px-2.5 py-2 text-[10px] font-black uppercase tracking-[0.12em] text-white/60 transition hover:border-white/30 hover:text-white focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-cyan-300 motion-reduce:transition-none"
              >
                <IconArrowLeft size={14} aria-hidden="true" />
                {t("puzzlePlayer.hud.previous")}
              </button>
              <button
                type="button"
                onClick={() => pick(index + 1)}
                className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-white/15 px-2.5 py-2 text-[10px] font-black uppercase tracking-[0.12em] text-white/60 transition hover:border-white/30 hover:text-white focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-cyan-300 motion-reduce:transition-none"
              >
                {t("puzzlePlayer.hud.next")}
                <IconArrowRight size={14} aria-hidden="true" />
              </button>
            </div>

            <Link
              href="/play"
              className="block text-center text-[10px] font-bold uppercase tracking-[0.12em] text-white/40 underline-offset-4 hover:text-white hover:underline"
            >
              {t("puzzlePlayer.hud.exit")}
            </Link>
          </aside>
        </div>
      )}

      {!browsing && phase !== "intro" && (
        <div className="mt-4 space-y-3">
          <div className="rounded-2xl border border-white/10 bg-black/20 p-3 sm:p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[10px] font-black uppercase tracking-[0.18em] text-cyan-200/80">
                  {t("puzzlePlayer.hud.objective")}
                </p>
                <ul className="mt-1 space-y-0.5 text-sm leading-relaxed text-white/85">
                  {objectiveLines.map((line, lineIndex) => {
                    const destination = line.destination
                      ? t(line.destination.key, line.destination.params)
                      : undefined;
                    return (
                      <li key={`${line.key}-${lineIndex}`}>
                        {t(line.key, { ...line.params, ...(destination ? { destination } : {}) })}
                      </li>
                    );
                  })}
                </ul>
              </div>

              <dl className="grid grid-cols-3 gap-2 text-center text-[10px]">
                <div className="rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1.5">
                  <dt className="uppercase tracking-[0.1em] text-white/40">
                    {t("puzzlePlayer.hud.moves")}
                  </dt>
                  <dd className="mt-0.5 font-mono text-sm font-bold text-white">
                    {session.stats.moves}
                  </dd>
                </div>
                <div className="rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1.5">
                  <dt className="uppercase tracking-[0.1em] text-white/40">
                    {t("puzzlePlayer.hud.par")}
                  </dt>
                  <dd className="mt-0.5 font-mono text-sm font-bold text-white">{par}</dd>
                </div>
                <div className="rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1.5">
                  <dt className="uppercase tracking-[0.1em] text-white/40">
                    {t("puzzlePlayer.hud.stockCycles")}
                  </dt>
                  <dd className="mt-0.5 font-mono text-sm font-bold text-white">{stockCycles}</dd>
                </div>
              </dl>
            </div>

            <div className="mt-3">
              <div className="flex items-center justify-between text-[10px] font-bold uppercase tracking-[0.12em] text-white/45">
                <span>{t("puzzlePlayer.hud.progress")}</span>
                <span className="font-mono text-white/70">
                  {progress.current} / {progress.target}
                </span>
              </div>
              <div
                role="progressbar"
                aria-label={t("puzzlePlayer.hud.progress")}
                aria-valuemin={0}
                aria-valuemax={progress.target}
                aria-valuenow={progress.current}
                data-testid="puzzle-progress"
                className="mt-1 h-1.5 overflow-hidden rounded-full bg-white/10"
              >
                <div
                  className="h-full rounded-full bg-gradient-to-r from-cyan-300 to-emerald-300 transition-[width] duration-300 motion-reduce:transition-none"
                  style={{ width: `${pct}%` }}
                />
              </div>
            </div>
          </div>

          {phase === "complete" && (
            <div
              data-testid="puzzle-complete"
              className="rounded-2xl border border-emerald-400/40 bg-emerald-400/10 p-4 text-emerald-50"
            >
              <div className="flex items-start gap-2">
                <IconCheck size={18} aria-hidden="true" className="mt-0.5 shrink-0 text-emerald-300" />
                <div className="min-w-0">
                  <h2
                    ref={completeHeadingRef}
                    tabIndex={-1}
                    className="text-lg font-black tracking-tight text-white focus:outline-hidden"
                  >
                    {t("puzzlePlayer.complete.title")}
                  </h2>
                  <p className="mt-1 text-sm text-emerald-100/90">
                    {t("puzzlePlayer.complete.line", { moves: session.stats.moves, par })}
                  </p>
                  {record?.bestMoves != null && (
                    <p className="mt-0.5 text-xs text-emerald-100/70">
                      {t("puzzlePlayer.complete.best", { moves: record.bestMoves })}
                    </p>
                  )}
                </div>
              </div>

              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <div>
                  <p className="text-[10px] font-black uppercase tracking-[0.16em] text-emerald-300/85">
                    {t("puzzlePlayer.complete.concept")}
                  </p>
                  <p className="mt-1 text-xs leading-relaxed text-emerald-100/80">{concept}</p>
                </div>
                <div>
                  <p className="text-[10px] font-black uppercase tracking-[0.16em] text-emerald-300/85">
                    {t("puzzlePlayer.complete.explanation")}
                  </p>
                  <p className="mt-1 text-xs leading-relaxed text-emerald-100/80">
                    {t(puzzle.explanation.whyKey)}{" "}
                    {t(puzzle.explanation.detailKey, puzzle.explanation.params)}
                  </p>
                  <p className="mt-1 text-xs leading-relaxed text-emerald-100/70">
                    {t(puzzle.explanation.alternativeKey)}
                  </p>
                  {puzzle.explanation.delayedKey && (
                    <p className="mt-1 text-xs leading-relaxed text-emerald-100/70">
                      {t(puzzle.explanation.delayedKey)}
                    </p>
                  )}
                </div>
              </div>

              <ul className="mt-3 flex flex-wrap gap-2 text-[10px] font-bold uppercase tracking-[0.1em] text-emerald-100/75">
                <li className="rounded-full border border-emerald-300/25 bg-emerald-300/5 px-2 py-0.5">
                  {t("puzzlePlayer.complete.revealed", { count: session.stats.revealed })}
                </li>
                {session.stats.foundationGain > 0 && (
                  <li className="rounded-full border border-emerald-300/25 bg-emerald-300/5 px-2 py-0.5">
                    {t("puzzlePlayer.complete.foundation", {
                      count: session.stats.foundationGain,
                    })}
                  </li>
                )}
                {stockCycles > 0 && (
                  <li className="rounded-full border border-emerald-300/25 bg-emerald-300/5 px-2 py-0.5">
                    {t("puzzlePlayer.complete.cycles", { count: stockCycles })}
                  </li>
                )}
                <li className="rounded-full border border-emerald-300/25 bg-emerald-300/5 px-2 py-0.5">
                  {hintsShown > 0
                    ? t("puzzlePlayer.complete.hintsUsed", { count: hintsShown })
                    : t("puzzlePlayer.complete.noHints")}
                </li>
              </ul>

              {puzzle.solutionCount > 1 && (
                <p className="mt-2 text-xs text-emerald-100/70">
                  {t("puzzlePlayer.complete.multiple")}
                </p>
              )}

              <div className="mt-4 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={restart}
                  data-testid="puzzle-retry"
                  className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-emerald-300/50 bg-emerald-300/15 px-3 py-2 text-[10px] font-black uppercase tracking-[0.12em] text-emerald-50 transition hover:bg-emerald-300/25 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-emerald-300 motion-reduce:transition-none"
                >
                  <IconRefresh size={14} aria-hidden="true" />
                  {t("puzzlePlayer.complete.retry")}
                </button>
                <button
                  type="button"
                  onClick={() => pick(index + 1)}
                  data-testid="puzzle-next"
                  className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-white/20 px-3 py-2 text-[10px] font-black uppercase tracking-[0.12em] text-white/75 transition hover:border-white/40 hover:text-white focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-cyan-300 motion-reduce:transition-none"
                >
                  {t("puzzlePlayer.complete.next")}
                  <IconArrowRight size={14} aria-hidden="true" />
                </button>
                <Link
                  href="/play"
                  className="inline-flex items-center rounded-lg border border-transparent px-3 py-2 text-[10px] font-bold uppercase tracking-[0.12em] text-white/45 underline-offset-4 hover:text-white hover:underline"
                >
                  {t("puzzlePlayer.complete.exit")}
                </Link>
              </div>
            </div>
          )}

          <div
            className={
              phase === "complete"
                ? "min-w-0"
                : "grid gap-4 lg:grid-cols-[minmax(0,1fr)_19rem] lg:items-start"
            }
          >
            <div className="min-w-0">
              <SolitaireBoard
                view={session.view}
                interactive={phase === "playing"}
                onMove={play}
                onInvalid={onInvalid}
              />

              {phase === "playing" && feedback && (
                <div
                  role="status"
                  aria-live="polite"
                  data-testid="puzzle-feedback"
                  data-status={feedback.status}
                  className={`mt-2 flex items-start gap-2 rounded-xl border px-3 py-2 text-xs ${FEEDBACK_TONE[feedback.status]}`}
                >
                  {feedback.status === "illegal" ? (
                    <IconX size={14} aria-hidden="true" className="mt-0.5 shrink-0" />
                  ) : feedback.status === "no-progress" ? (
                    <IconBulb size={14} aria-hidden="true" className="mt-0.5 shrink-0" />
                  ) : (
                    <IconCheck size={14} aria-hidden="true" className="mt-0.5 shrink-0" />
                  )}
                  <span className={`font-semibold uppercase tracking-[0.08em] ${FEEDBACK_LABEL[feedback.status]}`}>
                    {t(`puzzlePlayer.feedback.${feedback.status === "no-progress" ? "noProgress" : feedback.status}`)}
                  </span>
                  {feedback.revealed > 0 && (
                    <span className="ml-auto shrink-0 font-mono text-[10px] opacity-70">
                      +{feedback.revealed}
                    </span>
                  )}
                </div>
              )}
            </div>

            {phase === "playing" && (
              <aside className="space-y-3">
                <div className="rounded-2xl border border-cyan-300/25 bg-cyan-300/[0.06] p-3">
                  <GlitchSay size="sm" message={glitchMessage} />
                </div>
                <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-[10px] font-black uppercase tracking-[0.18em] text-white/45">
                      {t("puzzlePlayer.hud.hints")}
                    </p>
                    <span className="font-mono text-[10px] text-white/40">
                      {hintsShown}/{puzzle.hints.length}
                    </span>
                  </div>

                  <ul aria-live="polite" className="mt-2 space-y-2">
                    {puzzle.hints.slice(0, hintsShown).map((hint, hintIndex) => (
                      <li
                        key={hint.key}
                        data-testid="puzzle-hint"
                        className="rounded-lg border border-cyan-300/20 bg-cyan-300/5 px-2.5 py-2 text-xs leading-relaxed text-cyan-50/90"
                      >
                        <span className="mr-1.5 font-mono text-[10px] text-cyan-300/70">
                          {t("puzzlePlayer.hud.hintUsed", { number: hintIndex + 1 })}
                        </span>
                        {t(hint.key, hint.params ?? {})}
                      </li>
                    ))}
                  </ul>

                  <button
                    type="button"
                    onClick={showHint}
                    disabled={hintsShown >= puzzle.hints.length}
                    data-testid="puzzle-show-hint"
                    className="mt-2 inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-cyan-300/40 bg-cyan-300/10 px-2.5 py-2 text-[10px] font-black uppercase tracking-[0.12em] text-cyan-100 transition hover:bg-cyan-300/20 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-cyan-300 disabled:cursor-not-allowed disabled:opacity-40 motion-reduce:transition-none"
                  >
                    <IconBulb size={14} aria-hidden="true" />
                    {hintsShown >= puzzle.hints.length
                      ? t("puzzlePlayer.hud.noHintsLeft")
                      : `${t("puzzlePlayer.hud.showHint")} · ${t("puzzlePlayer.hud.hintsLeft", {
                          count: puzzle.hints.length - hintsShown,
                        })}`}
                  </button>
                </div>

                <div className="space-y-2">
                  <button
                    type="button"
                    onClick={restart}
                    data-testid="puzzle-restart"
                    className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-white/15 px-2.5 py-2 text-[10px] font-black uppercase tracking-[0.12em] text-white/60 transition hover:border-white/30 hover:text-white focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-cyan-300 motion-reduce:transition-none"
                  >
                    <IconRefresh size={14} aria-hidden="true" />
                    {t("puzzlePlayer.hud.restart")}
                  </button>
                  <Link
                    href="/play"
                    className="block rounded-lg border border-transparent px-2.5 py-2 text-center text-[10px] font-bold uppercase tracking-[0.12em] text-white/40 underline-offset-4 hover:text-white hover:underline"
                  >
                    {t("puzzlePlayer.hud.exit")}
                  </Link>
                </div>
              </aside>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
