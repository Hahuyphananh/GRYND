"use client";

// ── Reusable results popup used inside the match page ────────────────────
//
// Mirrors the look-and-feel of Uno's `endPopup` modal so the user
// experience stays consistent across PvP casino games. Includes a
// 15 second replay window that matches the Uno behaviour.

import React from "react";
import { AnimatePresence, motion } from "framer-motion";
import { gameOverModal } from "../../lib/animations";
import { RESULT_POPUP_REPLAY_WINDOW_MS } from "../../lib/precision/constants";
import { endReasonToLabel, formatTokens, getReplaySecondsLeft } from "../../lib/precision/utils";
import type {
  PrecisionEndPopupState,
} from "../../lib/precision/types";
import { useTranslation } from "../../hooks/useTranslation";

interface PrecisionResultPopupProps {
  popup: PrecisionEndPopupState | null;
  onReplay: () => void;
  onReturnToLobby: () => void;
  replayRequested: boolean;
  opponentReplayRequested: boolean;
  returnChosen: boolean;
}

function PrecisionResultPopupImpl({
  popup,
  onReplay,
  onReturnToLobby,
  replayRequested,
  opponentReplayRequested,
  returnChosen,
}: PrecisionResultPopupProps) {
  const { t } = useTranslation();
  // Tick the countdown so the user sees live seconds remaining even if
  // the surrounding page isn't re-rendering for some other reason.
  //
  // OPTIMIZATION — the prior 250ms `setInterval` triggered ~4 React
  // re-renders per second for the entire end-popup subtree. We replace
  // it with a `requestAnimationFrame` loop that runs at the display's
  // native cadence but only forces a re-render when the displayed
  // integer `secondsLeft` actually decrements (~1 Hz instead of 4 Hz).
  // That's ~4x fewer renders during the 15s replay window — the
  // popup's motion animations and ResultRow subtree now stay idle
  // between integer-second ticks. Maintaining 60 FPS is preserved by
  // the rAF scheduling itself; React is just told less often.
  const [, setTick] = React.useState(0);
  React.useEffect(() => {
    if (!popup) return;
    let frameId = 0;
    let lastSeconds = getReplaySecondsLeft(popup.openedAt);
    // Initial render captures the current second; rAF below tracks
    // future decrements.
    const loop = () => {
      const now = getReplaySecondsLeft(popup.openedAt);
      if (now !== lastSeconds) {
        lastSeconds = now;
        setTick((n) => n + 1);
      }
      frameId = requestAnimationFrame(loop);
    };
    frameId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frameId);
  }, [popup]);

  const secondsLeft = popup
    ? getReplaySecondsLeft(popup.openedAt)
    : 0;
  const expired = popup && secondsLeft <= 0;

  const palette =
    popup?.result === "win"
      ? {
          ring: "border-yellow-300/60",
          glow: "shadow-[0_0_45px_rgba(250,204,21,0.4)]",
          heading: "text-yellow-300",
          bg: "bg-gradient-to-b from-[#0a2a1a] to-[#031a0a]",
          icon: "🏆",
          word: t("games.precision.victory"),
        }
      : popup?.result === "draw"
        ? {
            ring: "border-cyan-300/60",
            glow: "shadow-[0_0_45px_rgba(34,211,238,0.35)]",
            heading: "text-cyan-200",
            bg: "bg-gradient-to-b from-[#0a1f2a] to-[#031622]",
            icon: "🤝",
            word: t("games.precision.draw"),
          }
        : {
            ring: "border-fuchsia-300/60",
            glow: "shadow-[0_0_45px_rgba(217,70,239,0.3)]",
            heading: "text-fuchsia-300",
            bg: "bg-gradient-to-b from-[#2a0a1f] to-[#160322]",
            icon: "💀",
            word: t("games.precision.defeat"),
          };

  // ── Winner / Score / Prize derivation ────────────────────────────
  // The popup is the SINGLE consumer of the explicit "Winner / Score
  // / Prize" rows surfaced by `makeInitialEndPopupState`. We resolve
  // these from `popup.winnerName`, `popup.finalScore`, `popup.payout`,
  // and `popup.wager + popup.prizeMultiplier` — all of which arrive
  // resolved server-side (server is the sole source of truth for the
  // actual balance update, so the displayed prize can never diverge
  // from what the DB wrote). Falls through gracefully when the
  // fields are still arriving over the wire.

  const winnerLine =
    popup?.winnerName ??
    (popup?.result === "win" ? "You" : "Opponent");

  const scoreLine = popup?.finalScore
    ? popup.finalScore.seat1 === popup.finalScore.seat2
      ? `${popup.finalScore.seat1} – ${popup.finalScore.seat2} (drawn)`
      : `${popup.finalScore.seat1} – ${popup.finalScore.seat2}`
    : "—";

  const multiplier =
    typeof popup?.prizeMultiplier === "number" && popup.prizeMultiplier > 0
      ? popup.prizeMultiplier
      : 1.9;
  const wagerValue =
    typeof popup?.wager === "number" && Number.isFinite(popup.wager)
      ? popup.wager
      : 0;
  const payoutValue =
    typeof popup?.payout === "number" && Number.isFinite(popup.payout)
      ? popup.payout
      : 0;

  return (
    <AnimatePresence>
      {popup && (
        <motion.div
          key="precision-end-popup"
          {...gameOverModal.backdrop}
          className="fixed inset-0 z-[80] flex items-center justify-center bg-black/80 px-4 backdrop-blur-sm"
        >
          <motion.div
            {...gameOverModal.panel}
            className={`relative w-full max-w-md overflow-hidden rounded-3xl border ${palette.ring} ${palette.bg} p-6 text-center shadow-2xl ${palette.glow}`}
          >
            <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-cyan-300 via-fuchsia-500 to-yellow-300" />
            <motion.div
              initial={{ scale: 0, rotate: -30 }}
              animate={{ scale: 1, rotate: 0 }}
              transition={{ type: "spring", stiffness: 300, damping: 12, delay: 0.3 }}
              className="mb-2 text-6xl"
            >
              {palette.icon}
            </motion.div>
            <p className="text-xs font-black uppercase tracking-[0.45em] text-cyan-200">
              {t("games.precision.match_result_label")}
            </p>
            <motion.h2
              initial={{ y: 20, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              transition={{ delay: 0.5, duration: 0.4 }}
              className={`mt-3 text-4xl font-black uppercase ${palette.heading}`}
            >
              {palette.word}
            </motion.h2>
            <motion.p
              initial={{ y: 20, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              transition={{ delay: 0.6, duration: 0.4 }}
              className="mt-3 text-sm text-slate-200"
            >
              {endReasonToLabel(popup.reason)}
              {popup.opponentName ? ` · vs. ${popup.opponentName}` : ""}
            </motion.p>

            {/* ── Explicit Winner / Score / Prize rows ───────────
                Surface the three fields called out in the spec so
                the user sees who took the match, the final tally,
                and the credited / owed payout in dedicated, easy
                to read rows. Stagger reveals cascade with the
                existing Victory / payout rows. */}
            <motion.div
              data-testid="precision-end-popup-result-rows"
              initial={{ y: 20, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              transition={{ delay: 0.62, duration: 0.4 }}
              className="mt-4 grid gap-2"
            >
              <ResultRow
                label={t("games.precision.winner_label")}
                value={winnerLine}
                tone={
                  popup?.result === "win"
                    ? "gold"
                    : popup?.result === "loss"
                      ? "fuchsia"
                      : "cyan"
                }
              />
              <ResultRow
                label={t("games.precision.score_label")}
                value={scoreLine}
                tone="slate"
                emphasize
              />
              <ResultRow
                label={t("games.precision.prize_label")}
                value={
                  payoutValue > 0
                    ? `+${formatTokens(payoutValue)} ${t("games.precision.tokens_suffix")}`
                    : popup?.result === "win"
                      ? t("games.precision.zero_tokens")
                      : "—"
                }
                subValue={
                  payoutValue > 0 && wagerValue > 0
                    ? t("games.precision.multiplier_suffix", { multiplier, wager: formatTokens(wagerValue) })
                    : payoutValue > 0
                      ? t("games.precision.payout_multiplier_only", { multiplier })
                      : t("games.precision.no_payout")
                }
                tone={payoutValue > 0 ? "gold" : "slate"}
                emphasize
              />
            </motion.div>
            <motion.p
              initial={{ y: 20, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              transition={{ delay: 0.7, duration: 0.4 }}
              className="mt-4 text-xs font-bold uppercase tracking-widest text-yellow-200"
            >
              {t("games.precision.replay_window_label")}{" "}
              {/* Smooth countdown — wrap the digit text in AnimatePresence
                  with mode=wait so each integer-second decrement fades the
                  OLD digit up+out and the NEW digit down+in. Each swap is a
                  short opacity + Y-translate (~220ms), composed on the
                  compositor thread via framer-motion spring. The cadence
                  is driven by the rAF loop above (~1 Hz when seconds
                  decrement, idle otherwise) so this swap is never out of
                  sync with the underlying counter. Uses transform/opacity
                  only — no layout-thrashing width changes. */}
              <AnimatePresence mode="wait" initial={false}>
                <motion.span
                  key={secondsLeft}
                  initial={{ y: 8, opacity: 0 }}
                  animate={{ y: 0, opacity: 1 }}
                  exit={{ y: -8, opacity: 0 }}
                  transition={{ duration: 0.22, ease: "easeOut" }}
                  className="inline-block tabular-nums"
                  data-testid="precision-end-popup-seconds"
                >
                  {secondsLeft}
                </motion.span>
              </AnimatePresence>
              s
            </motion.p>
            <motion.div
              initial={{ y: 20, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              transition={{ delay: 0.8, duration: 0.4 }}
              className="mt-6 grid gap-3 sm:grid-cols-2"
            >
              <button
                onClick={onReplay}
                disabled={returnChosen || replayRequested || expired}
                className="rounded-xl border border-fuchsia-300/70 bg-fuchsia-500/20 px-4 py-3 font-black text-fuchsia-100 shadow-[0_0_18px_rgba(217,70,239,0.25)] disabled:cursor-not-allowed disabled:opacity-40"
              >
                {replayRequested ? t("games.precision.replay_requested") : t("games.precision.replay_button")}
              </button>
              <button
                onClick={onReturnToLobby}
                className="rounded-xl border border-cyan-300/70 bg-cyan-400 px-4 py-3 font-black text-[#031026] shadow-[0_0_18px_rgba(34,211,238,0.35)]"
              >
                {t("games.precision.return_to_lobby")}
              </button>
            </motion.div>
            <motion.p
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 1.0, duration: 0.4 }}
              className="mt-3 text-xs text-slate-300"
            >
              {expired
                ? t("games.precision.expired")
                : returnChosen
                  ? t("games.precision.replay_disabled_return")
                  : opponentReplayRequested
                    ? t("games.precision.opponent_ready_replay")
                    : t("games.precision.replay_explainer", { seconds: Math.round(RESULT_POPUP_REPLAY_WINDOW_MS / 1000) })}
            </motion.p>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// ── ResultRow sub-component ────────────────────────────────────────────────────────────
/**
 * Per-field row used in the match-end popup. Each row pins a left-pad
 * label against a right-aligned value with an optional sub-line for
 * secondary text (e.g. "1.9× on 100 wagered" under the Prize).
 *
 * Tones: gold (winner / prize positive), fuchsia (loss outcome),
 * cyan (draw), and slate (neutral — score).
 */
interface ResultRowProps {
  label: string;
  value: string;
  subValue?: string;
  tone: "gold" | "fuchsia" | "cyan" | "slate";
  emphasize?: boolean;
}

const ResultRow = React.memo(function ResultRow({
  label,
  value,
  subValue,
  tone,
  emphasize,
}: ResultRowProps) {
  const palette =
    tone === "gold"
      ? {
          label: "text-yellow-300",
          value: "text-yellow-200",
          bg: "bg-yellow-400/10",
        }
      : tone === "fuchsia"
        ? {
            label: "text-fuchsia-300",
            value: "text-fuchsia-200",
            bg: "bg-fuchsia-500/10",
          }
        : tone === "cyan"
          ? {
              label: "text-cyan-300",
              value: "text-cyan-200",
              bg: "bg-cyan-400/10",
            }
          : {
              label: "text-slate-300",
              value: "text-slate-100",
              bg: "bg-white/5",
            };
  return (
    <div
      data-testid={`precision-end-popup-result-row-${label.toLowerCase()}`}
      className={`flex items-center justify-between gap-3 rounded-lg border border-white/10 px-3 py-2 ${palette.bg} ${
        emphasize ? "shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)]" : ""
      }`}
    >
      <span
        className={`text-[10px] font-black uppercase tracking-[0.3em] ${palette.label}`}
      >
        {label}
      </span>
      <div className="flex flex-col items-end">
        <span
          className={`font-black tabular-nums ${palette.value} ${
            emphasize ? "text-2xl" : "text-base"
          }`}
        >
          {value}
        </span>
        {subValue ? (
          <span className="text-[10px] font-bold uppercase tracking-widest text-slate-400">
            {subValue}
          </span>
        ) : null}
      </div>
    </div>
  );
});

// OPTIMIZATION — wrap the popup in React.memo so the page's polling
// tick (every 1.5s) doesn't force the entire end-popup subtree to
// re-render unless one of popup/replayRequested/opponentReplayRequested/
// returnChosen/onReplay/onReturnToLobby/logical-input changes. Combined
// with the rAF-based 1-Hz countdown above, the popup is now idle
// between integer-second ticks — `ResultRow`s only re-render when
// their inputs actually change.
export default React.memo(PrecisionResultPopupImpl);
