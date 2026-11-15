"use client";

// src/components/solitaire-duel/SolitairePuzzle.tsx
//
// THE PUZZLE CARD — one verified Klondike position, three moves, one that turns
// a face-down card and stays on the deal's proven winning line.
//
// The browser never receives the answer before it answers: the API strips it
// until a submission has been recorded. A daily puzzle locks itself after the
// one allowed answer; an unlimited puzzle shows the free-plan count and points
// at GRYND PRO when the day's five are spent.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

import { isOfflineError } from "../../hooks/useOnlineStatus";
import {
  buildOfflinePuzzle,
  publicPuzzle,
  randomPuzzleSeed,
  verifyPuzzleChoice,
  type PuzzleCardView,
  type PuzzleChoiceLabel,
  type PuzzleChoiceView,
  type PuzzlePositionView,
  type PublicPuzzle,
} from "../../lib/solitaire-duel/puzzleCore";
import type { SolitaireMove } from "../../lib/solitaire-duel/types";
import { rankLabel, suitGlyph } from "./PlayingCard";

type Allowance = {
  unlimited: boolean;
  limit: number | null;
  used: number;
  remaining: number | null;
  dayKey: string;
  resetsAt: string;
};

type PuzzleData = PublicPuzzle & {
  answer?: PuzzleChoiceLabel | null;
  attempt?: { choice: string; correct: boolean; answeredAt: string | null } | null;
  allowance?: Allowance | null;
};

type AnswerState = {
  correct: boolean;
  answer: PuzzleChoiceLabel | null;
  choice: string;
};

type Props = { kind: "daily" | "unlimited" };

function cardText(card: { suit: string; rank: number }): string {
  return `${rankLabel(card.rank)}${suitGlyph(card.suit)}`;
}

/** The human wording for a move — the same engine union the board uses. */
function describeMove(move: SolitaireMove): { title: string; detail: string } {
  switch (move.kind) {
    case "tableau-to-tableau":
      return {
        title: `${cardText(move.card)} onto column ${move.toColumn + 1}`,
        detail: `from column ${move.fromColumn + 1}`,
      };
    case "tableau-to-foundation":
      return {
        title: `${cardText(move.card)} to the foundation`,
        detail: `from column ${move.fromColumn + 1}`,
      };
    case "waste-to-tableau":
      return {
        title: `The waste card onto column ${move.toColumn + 1}`,
        detail: "from the waste",
      };
    case "waste-to-foundation":
      return {
        title: `The waste card to the ${move.suit} foundation`,
        detail: "from the waste",
      };
    case "foundation-to-tableau":
      return {
        title: `A ${move.suit} foundation card onto column ${move.toColumn + 1}`,
        detail: "pulling a card back down",
      };
    default:
      return { title: "Draw from the stock", detail: "the stock" };
  }
}

function MiniCard({ card }: { card: PuzzleCardView }) {
  const red = card.suit === "hearts" || card.suit === "diamonds";
  return (
    <div
      className={`flex h-[52px] w-[38px] flex-col rounded-[4px] border border-black/25 bg-gradient-to-b from-white to-[#e8ecf3] px-1 pt-0.5 shadow-sm ${
        red ? "text-[#d81f3a]" : "text-[#141a24]"
      }`}
    >
      <span className="text-[11px] font-black leading-none">{rankLabel(card.rank)}</span>
      <span className="text-[10px] leading-none">{suitGlyph(card.suit)}</span>
    </div>
  );
}

function MiniBack() {
  return (
    <div className="h-[52px] w-[38px] rounded-[4px] border border-cyan-400/25 bg-[repeating-linear-gradient(45deg,rgba(0,229,255,0.16)_0_3px,transparent_3px_6px)]" />
  );
}

/** A small, read-only tableau. No interaction, no hidden identities. */
function PuzzleBoard({ position }: { position: PuzzlePositionView }) {
  const foundations = Object.values(position.foundations).reduce((sum, n) => sum + n, 0);
  return (
    <div className="mt-4 rounded-2xl border border-white/10 bg-[#071022] p-3">
      <div className="flex items-start justify-center gap-2 overflow-x-auto pb-1">
        {position.columns.map((column, index) => {
          const height =
            column.reduce((total, card) => total + (card ? 16 : 10), 0) + 52;
          return (
            <div key={index} className="flex min-w-[42px] flex-col items-center">
              <div className="relative w-[38px]" style={{ height }}>
                {column.length === 0 ? (
                  <div className="h-[52px] w-[38px] rounded-[4px] border border-dashed border-white/15" />
                ) : (
                  column.map((card, slot) => (
                    <div
                      key={slot}
                      className="absolute left-0"
                      style={{
                        top: column
                          .slice(0, slot)
                          .reduce((total, above) => total + (above ? 16 : 10), 0),
                      }}
                    >
                      {card ? <MiniCard card={card} /> : <MiniBack />}
                    </div>
                  ))
                )}
              </div>
              <span className="mt-1 text-[9px] font-bold text-white/25">{index + 1}</span>
            </div>
          );
        })}
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-[11px] text-white/45">
        <span>Stock {position.stockCount}</span>
        <span>Waste {position.wasteTop ? cardText(position.wasteTop) : "—"}</span>
        <span>Face-down {position.faceDownRemaining}</span>
        <span>Foundations {foundations}/52</span>
      </div>
    </div>
  );
}

export default function SolitairePuzzle({ kind }: Props) {
  const [puzzle, setPuzzle] = useState<PuzzleData | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [limitReached, setLimitReached] = useState(false);
  const [result, setResult] = useState<AnswerState | null>(null);
  // True when this position was built in the tab because there is no network.
  const [offline, setOffline] = useState(false);
  // The local position's answer. It never leaves this component, and nothing
  // derived from it is stored.
  const [localAnswer, setLocalAnswer] = useState<PuzzleChoiceLabel | null>(null);

  // The unlimited puzzle is the offline-capable mode: a position is a pure
  // function of a seed, so the tab can build and check one with no network.
  // The daily puzzle is tied to the server's UTC day and its one recorded
  // answer, so it stays online-only.
  const buildLocal = useCallback(() => {
    const local = buildOfflinePuzzle(randomPuzzleSeed());
    setPuzzle({ ...publicPuzzle(local), answer: null, attempt: null, allowance: null });
    setLocalAnswer(local.answer);
    setOffline(true);
  }, []);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setFailed(false);
      setLimitReached(false);
      setResult(null);
      setOffline(false);
      setLocalAnswer(null);

      // Offline: never even attempt the request. The yield paints "Building…"
      // before the synchronous deal search runs.
      if (
        kind === "unlimited" &&
        typeof navigator !== "undefined" &&
        navigator.onLine === false
      ) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        try {
          buildLocal();
        } catch {
          setFailed(true);
        } finally {
          setLoading(false);
        }
        return;
      }

      try {
        const response = await fetch(`/api/solitaire/puzzle?kind=${kind}`, {
          credentials: "same-origin",
          cache: "no-store",
          signal,
        });
        const body = await response.json().catch(() => null);
        if (!response.ok || !body?.success) throw new Error(body?.error || "Puzzle unavailable");
        setPuzzle(body.data as PuzzleData);
      } catch (error) {
        if ((error as Error)?.name === "AbortError") return;
        // A dropped connection or captive portal: build a local practice
        // puzzle instead of showing a dead card. Nothing is submitted.
        if (
          kind === "unlimited" &&
          (isOfflineError(error) ||
            (typeof navigator !== "undefined" && navigator.onLine === false))
        ) {
          try {
            buildLocal();
          } catch {
            setFailed(true);
          }
        } else {
          setFailed(true);
        }
      } finally {
        setLoading(false);
      }
    },
    [buildLocal, kind],
  );

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const allowance = puzzle?.allowance ?? null;
  const remaining = allowance?.unlimited ? null : allowance?.remaining ?? null;
  const outOfPuzzles = kind === "unlimited" && remaining === 0;

  const answered: AnswerState | null =
    result ??
    (puzzle?.attempt
      ? {
          correct: puzzle.attempt.correct,
          answer: puzzle.answer ?? null,
          choice: puzzle.attempt.choice,
        }
      : null);

  const locked = answered !== null || outOfPuzzles || limitReached;

  const submit = async (choice: PuzzleChoiceLabel) => {
    if (!puzzle || submitting || locked) return;
    // OFFLINE: check the choice with the same pure verifier and record NOTHING.
    // No request is attempted, and no attempt or allowance is written anywhere.
    if (offline) {
      if (localAnswer == null) return;
      setResult({
        correct: verifyPuzzleChoice({ answer: localAnswer }, choice),
        answer: localAnswer,
        choice,
      });
      return;
    }
    setSubmitting(true);
    try {
      const response = await fetch("/api/solitaire/puzzle", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, key: puzzle.key, choice }),
      });
      const body = await response.json().catch(() => null);

      if (response.status === 429) {
        if (body?.data?.allowance) {
          setPuzzle((current) =>
            current ? { ...current, allowance: body.data.allowance } : current,
          );
        }
        setLimitReached(true);
        return;
      }
      if (!response.ok || !body?.success) throw new Error(body?.error || "Submission failed");

      setResult({
        correct: Boolean(body.data.correct),
        answer: (body.data.answer as PuzzleChoiceLabel) ?? null,
        choice,
      });
      if (body.data.allowance) {
        setPuzzle((current) =>
          current ? { ...current, allowance: body.data.allowance } : current,
        );
      }
    } catch {
      setFailed(true);
    } finally {
      setSubmitting(false);
    }
  };

  const answerChoice: PuzzleChoiceView | undefined = answered?.answer
    ? puzzle?.choices.find((choice) => choice.label === answered.answer)
    : undefined;

  const title = kind === "daily" ? "Daily puzzle" : "Unlimited puzzle";
  const blurb =
    kind === "daily"
      ? "One position from a verified winning deal, free for everyone. One answer a day — make it count."
      : "Fresh verified positions. One move turns a card face up and stays on the winning line.";

  return (
    <section
      aria-labelledby={`puzzle-${kind}-heading`}
      className="rounded-3xl border border-cyan-400/25 bg-gradient-to-b from-[#07152e] to-[#050b1d] p-5 sm:p-6"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[10px] font-black uppercase tracking-[0.3em] text-cyan-300/80">
            {kind === "daily" ? "GRYND · free · once a day" : "GRYND · practice"}
          </p>
          <h2
            id={`puzzle-${kind}-heading`}
            className="mt-1 text-2xl font-black tracking-tight text-white sm:text-3xl"
          >
            {title}
          </h2>
          <p className="mt-2 max-w-xl text-sm leading-relaxed text-white/55">{blurb}</p>
        </div>

        {kind === "unlimited" && offline && (
          <div className="rounded-xl border border-amber-300/30 bg-amber-400/10 px-3 py-2 text-right">
            <p className="text-[10px] font-black uppercase tracking-[0.18em] text-amber-200/80">
              Offline
            </p>
            <p className="font-mono text-lg text-white">Unlimited</p>
            <p className="text-[9px] uppercase tracking-[0.12em] text-amber-100/50">not saved</p>
          </div>
        )}

        {kind === "unlimited" && !offline && allowance && (
          <div className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-right">
            {allowance.unlimited ? (
              <>
                <p className="text-[10px] font-black uppercase tracking-[0.18em] text-[#f5ff3b]">GRYND PRO</p>
                <p className="font-mono text-lg text-white">Unlimited</p>
              </>
            ) : (
              <>
                <p className="text-[10px] font-black uppercase tracking-[0.18em] text-white/40">Today</p>
                <p className="font-mono text-lg text-white">
                  {remaining}/{allowance.limit} left
                </p>
              </>
            )}
          </div>
        )}
      </div>

      {loading && (
        <p className="py-10 text-center text-sm text-white/45" aria-busy="true">
          Building a verified position…
        </p>
      )}

      {failed && (
        <div className="mt-4 rounded-xl border border-rose-400/30 bg-rose-400/10 p-4 text-sm text-rose-100">
          {kind === "daily"
            ? "The daily puzzle needs a connection — it is tied to the server's UTC day. Unlimited puzzles still work offline."
            : "The puzzle could not be loaded. Please try again."}
        </div>
      )}

      {puzzle && !loading && (
        <>
          <PuzzleBoard position={puzzle.position} />

          <p className="mt-4 text-[11px] font-bold uppercase tracking-[0.2em] text-cyan-300/70">
            Which move turns a card face up?
          </p>

          <div className="mt-2 space-y-2">
            {puzzle.choices.map((choice) => {
              const description = describeMove(choice.move);
              const isAnswer = answered?.answer === choice.label;
              const isPicked = answered?.choice === choice.label;
              const showCorrect = Boolean(answered) && isAnswer;
              return (
                <button
                  key={choice.label}
                  type="button"
                  onClick={() => submit(choice.label)}
                  disabled={submitting || locked}
                  className={`flex w-full items-center gap-3 rounded-xl border px-3 py-3 text-left transition ${
                    showCorrect
                      ? "border-cyan-400/70 bg-cyan-400/10"
                      : isPicked && answered && !answered.correct
                        ? "border-rose-400/50 bg-rose-400/10"
                        : "border-white/10 bg-white/[0.03] hover:border-cyan-400/40 hover:bg-white/[0.06]"
                  } ${locked ? "cursor-default" : "cursor-pointer"}`}
                >
                  <span
                    className={`grid h-9 w-9 shrink-0 place-items-center rounded-full border font-mono text-sm font-black ${
                      showCorrect
                        ? "border-cyan-300 text-cyan-200"
                        : "border-white/20 text-white/70"
                    }`}
                  >
                    {choice.label}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-sm font-bold text-white">{description.title}</span>
                    <span className="block text-[11px] uppercase tracking-[0.14em] text-white/35">
                      {description.detail}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>

          {answered && (
            <div
              className={`mt-4 rounded-xl border p-4 text-sm ${
                answered.correct
                  ? "border-cyan-400/40 bg-cyan-400/10 text-cyan-50"
                  : "border-rose-400/30 bg-rose-400/10 text-rose-50"
              }`}
              role="status"
            >
              <p className="font-black">
                {answered.correct ? "Correct — that card turns over." : "Not this time."}
              </p>
              {answerChoice && (
                <p className="mt-1 text-white/70">
                  The winning move was <strong>{answerChoice.label}</strong>:{" "}
                  {describeMove(answerChoice.move).title}.
                </p>
              )}
              {offline && (
                <p className="mt-1 text-white/50">
                  Checked on this device — nothing was recorded.
                </p>
              )}
              {kind === "daily" && (
                <p className="mt-1 text-white/50">A new daily puzzle arrives at UTC midnight.</p>
              )}
            </div>
          )}

          {outOfPuzzles && !answered && (
            <div className="mt-4 rounded-xl border border-[#f5ff3b]/30 bg-[#f5ff3b]/10 p-4 text-sm text-[#f7ffa1]">
              <p className="font-black">You have used all 5 free puzzles today.</p>
              <p className="mt-1 text-white/60">
                GRYND PRO plays unlimited puzzles, all day, every day.
              </p>
              <Link
                href="/upgrade-pro"
                className="mt-3 inline-flex rounded-lg border border-[#f5ff3b]/50 bg-[#f5ff3b]/15 px-3 py-2 text-xs font-black uppercase tracking-[0.14em] text-[#f5ff3b] hover:bg-[#f5ff3b]/25"
              >
                Go unlimited →
              </Link>
            </div>
          )}

          {kind === "unlimited" && (
            <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
              <span className="text-[11px] text-white/35">
                {offline
                  ? "Offline · unlimited practice, nothing saved"
                  : allowance?.unlimited
                    ? "PRO · no daily limit"
                    : `Free plan · ${remaining ?? 0} of ${allowance?.limit ?? 5} left today`}
              </span>
              <button
                type="button"
                onClick={() => load()}
                disabled={loading || submitting || outOfPuzzles}
                className="rounded-lg border border-cyan-400/40 bg-cyan-400/10 px-3 py-2 text-xs font-black uppercase tracking-[0.14em] text-cyan-200 transition hover:bg-cyan-400/20 disabled:opacity-40"
              >
                New puzzle
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
