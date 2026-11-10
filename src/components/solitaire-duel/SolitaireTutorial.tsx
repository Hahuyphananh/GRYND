"use client";

// src/components/solitaire-duel/SolitaireTutorial.tsx
//
// THE INTERACTIVE FIRST GAME.
//
// A real Klondike board, the real engine, and Glitch reacting to what the
// player actually did:
//
//   * `SolitaireBoard` renders `viewForState(state)` and proposes moves.
//   * `applyTutorialMove` validates every proposal through `applyMove` — the
//     same authority as solo and the duel. An illegal move is refused by the
//     engine, never by a script.
//   * Goals are state predicates (see lib/solitaire-duel/tutorial.ts), so a
//     player who finds a different legal route still makes progress.
//   * Glitch's reaction is derived from the engine's result: a completed goal,
//     a revealed card, or a refusal. It never claims a move the engine did not
//     accept.
//
// The tutorial makes NO moves for the player, writes no session, touches no
// matchmaking, and cannot affect ranked state: it owns one in-memory board.
//
// Accessibility: the instruction is a polite live region, the board is the
// existing keyboard-playable one, Skip and Restart are real buttons, and the
// mascot stays inline (never floating over the board).

import { useCallback, useEffect, useRef, useState } from "react";
import { IconArrowRight, IconRefresh, IconBulb } from "@tabler/icons-react";

import SolitaireBoard from "./SolitaireBoard";
import GlitchSay from "../mascot/GlitchSay";
import { useTranslation } from "../../hooks/useTranslation";
import { viewForState } from "../../lib/solitaire-duel/rules";
import {
  TUTORIAL_STEPS,
  TUTORIAL_STEP_COUNT,
  applyTutorialMove,
  currentTutorialStep,
  tutorialComplete,
  tutorialInitialState,
  tutorialStepIndex,
} from "../../lib/solitaire-duel/tutorial";
import {
  GLITCH_TUTORIAL_LINES,
  tutorialMoveLine,
  type GlitchLine,
} from "../../lib/mascot/glitchOnboarding";
import type { SolitaireMove, SolitaireState } from "../../lib/solitaire-duel/types";

/** How long without an accepted move before Glitch offers help. */
const STUCK_AFTER_MS = 18_000;

type Props = {
  /** Called once, when the tutorial board mounts (tracking only). */
  onStarted?: () => void;
  /** Called when the player reaches the last goal and continues. */
  onComplete: () => void;
  /** Called when the player skips the tutorial. */
  onSkip: () => void;
  /** Optional mode label shown on the completion panel. */
  recommendedLabel?: string;
};

export default function SolitaireTutorial({
  onStarted,
  onComplete,
  onSkip,
  recommendedLabel,
}: Props) {
  const { t } = useTranslation();
  const [state, setState] = useState<SolitaireState>(() => tutorialInitialState());
  const [line, setLine] = useState<GlitchLine>(GLITCH_TUTORIAL_LINES.progress);
  const [lineVersion, setLineVersion] = useState(0);
  const [hintOpen, setHintOpen] = useState(false);
  const startedRef = useRef(false);

  const stepIndex = tutorialStepIndex(state);
  const complete = tutorialComplete(state);
  const step = currentTutorialStep(state);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    onStarted?.();
  }, [onStarted]);

  const react = useCallback((next: GlitchLine) => {
    setLine(next);
    setLineVersion((version) => version + 1);
  }, []);

  // Stuck? Offer help after a quiet spell — once per goal, never a nag.
  const stuckForRef = useRef<number | null>(null);
  useEffect(() => {
    if (complete) return undefined;
    if (stuckForRef.current === stepIndex) return undefined;
    const timer = setTimeout(() => {
      stuckForRef.current = stepIndex;
      setHintOpen(true);
      react(GLITCH_TUTORIAL_LINES.stuck);
    }, STUCK_AFTER_MS);
    return () => clearTimeout(timer);
  }, [stepIndex, complete, react]);

  /**
   * A move proposed by the BOARD. The engine decides whether it is legal; the
   * tutorial only reacts to that decision.
   */
  const onMove = useCallback(
    (move: SolitaireMove) => {
      const outcome = applyTutorialMove({ state, move });
      if (!outcome.ok) {
        react(GLITCH_TUTORIAL_LINES.invalid);
        return;
      }

      setState(outcome.state);

      if (outcome.advanced) {
        // The goal the completed move reached, from the engine's own step.
        const completedStep = TUTORIAL_STEPS[outcome.stepAfter - 1] ?? null;
        stuckForRef.current = null;
        react(
          tutorialMoveLine({
            stepId: completedStep?.id ?? null,
            revealed: outcome.revealed,
            complete: outcome.complete,
          }),
        );
        if (outcome.complete) setHintOpen(false);
        return;
      }

      // Legal, but it did not advance a goal (e.g. an early draw): say so
      // honestly — the goal is unchanged.
      react(
        outcome.revealed.length > 0
          ? GLITCH_TUTORIAL_LINES.reveal
          : GLITCH_TUTORIAL_LINES.progress,
      );
    },
    [react, state],
  );

  const restart = useCallback(() => {
    setState(tutorialInitialState());
    setHintOpen(false);
    stuckForRef.current = null;
    react(GLITCH_TUTORIAL_LINES.progress);
  }, [react]);

  const lastRevealed = state.tableau[2]?.[0]?.faceUp === true;

  return (
    <section
      data-testid="solitaire-tutorial"
      data-step={stepIndex}
      data-complete={complete ? "true" : "false"}
      className="rounded-2xl border border-[#00e5ff]/25 bg-[#040d24]/70 p-3 sm:p-5"
      aria-label={t("onboarding.solitaire.tutorial.title")}
    >
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[10px] font-bold uppercase tracking-[0.3em] text-[#00e5ff]">
            {t("onboarding.solitaire.tutorial.kicker")}
          </p>
          <h2 className="mt-1 text-lg font-extrabold text-white sm:text-xl">
            {t("onboarding.solitaire.tutorial.title")}
          </h2>
        </div>
        <div className="flex items-center gap-2">
          <span
            className="rounded-full border border-[#00e5ff]/35 bg-[#00e5ff]/10 px-3 py-1 font-mono text-[11px] font-bold text-[#9dd8ff]"
            aria-hidden="true"
          >
            {Math.min(stepIndex + 1, TUTORIAL_STEP_COUNT)} / {TUTORIAL_STEP_COUNT}
          </span>
          <button
            type="button"
            onClick={restart}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-[#00e5ff]/35 px-3 text-[11px] font-bold text-[#9dd8ff] transition hover:bg-[#00e5ff]/10 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[#00e5ff]"
          >
            <IconRefresh size={13} aria-hidden="true" />
            {t("onboarding.solitaire.tutorial.restart")}
          </button>
        </div>
      </div>

      {/* The current instruction — a polite live region, so a screen reader
          hears each new goal without focus being stolen from the board. */}
      <p
        className="mb-3 rounded-xl border border-[#FFD700]/25 bg-[#FFD700]/5 px-3 py-2 text-sm font-semibold text-[#ffe9a3]"
        role="status"
        aria-live="polite"
      >
        {complete
          ? t("onboarding.solitaire.tutorial.completeTitle")
          : t(step?.hintKey ?? "onboarding.solitaire.tutorial.step.ace")}
      </p>

      <SolitaireBoard
        view={viewForState(state)}
        interactive={!complete}
        onMove={onMove}
        onInvalid={() => react(GLITCH_TUTORIAL_LINES.invalid)}
      />

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {!complete && (
          <button
            type="button"
            onClick={() => {
              setHintOpen(true);
              react(GLITCH_TUTORIAL_LINES.stuck);
            }}
            aria-expanded={hintOpen}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-[#00e5ff]/40 bg-[#00e5ff]/10 px-3 text-[11px] font-bold text-[#9dd8ff] transition hover:bg-[#00e5ff]/20 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[#00e5ff]"
          >
            <IconBulb size={14} aria-hidden="true" />
            {t("onboarding.solitaire.tutorial.showHint")}
          </button>
        )}
        <button
          type="button"
          onClick={onSkip}
          className="ml-auto h-9 rounded-lg px-3 text-[11px] font-bold text-[#9dd8ff]/70 underline-offset-4 transition hover:text-[#d8fbff] hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[#00e5ff]"
        >
          {t("onboarding.solitaire.tutorial.skip")}
        </button>
      </div>

      {hintOpen && !complete && (
        <p className="mt-3 rounded-xl border border-[#00e5ff]/25 bg-[#001b33]/80 px-3 py-2 text-xs leading-relaxed text-[#c9f7ff]">
          {lastRevealed
            ? t("onboarding.solitaire.tutorial.hint.revealed")
            : t("onboarding.solitaire.tutorial.hint.select")}
        </p>
      )}

      {complete && (
        <div className="mt-4 flex flex-col gap-3 rounded-xl border border-[#00FFA3]/35 bg-[#00FFA3]/10 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-extrabold text-[#b6ffe0]">
              {t("onboarding.solitaire.tutorial.completeTitle")}
            </p>
            {recommendedLabel && (
              <p className="mt-0.5 text-xs font-semibold text-[#9dd8ff]">
                {t("onboarding.solitaire.tutorial.completeHint", { mode: recommendedLabel })}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onComplete}
            className="inline-flex items-center justify-center gap-2 rounded-xl bg-[#00FFA3] px-5 py-2.5 text-sm font-extrabold text-[#00251a] transition hover:brightness-110 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[#00FFA3]"
          >
            {t("onboarding.controls.next")}
            <IconArrowRight size={16} aria-hidden="true" />
          </button>
        </div>
      )}

      {/* Glitch: inline, in the flow, reacting to the engine's verdict. */}
      <div className="mt-4">
        <GlitchSay
          key={lineVersion}
          expression={line.expression}
          message={t(line.messageKey)}
          placement="inline"
          size="sm"
        />
      </div>
    </section>
  );
}
