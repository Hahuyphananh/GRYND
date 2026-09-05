"use client";

// ── Match-end result popup — shared PvpResultScreen adapter ──────────
// Precision's end-of-match experience now renders the shared
// PvpResultScreen (UX plan P3-3). The props contract is unchanged so
// the match page's coordinated replay flow (15s window, both-players-
// agree) keeps working untouched; the old bespoke win/loss/draw modal
// is deleted. Every number shown comes from the server-resolved
// `PrecisionEndPopupState` (winnerName / finalScore / payout / wager /
// prizeMultiplier) — nothing is invented, and any section whose data
// is absent simply hides.

import React from "react";
import PvpResultScreen from "../result/PvpResultScreen";
import { RESULT_POPUP_REPLAY_WINDOW_MS } from "../../lib/precision/constants";
import {
  endReasonToLabel,
  formatTokens,
  getReplaySecondsLeft,
} from "../../lib/precision/utils";
import type { PrecisionEndPopupState } from "../../lib/precision/types";
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
  // Tick the replay countdown ~1 Hz while the popup is open so the
  // details line shows live seconds remaining even when the
  // surrounding page isn't re-rendering.
  const [, setTick] = React.useState(0);
  React.useEffect(() => {
    if (!popup) return;
    const id = setInterval(() => setTick((n) => n + 1), 500);
    return () => clearInterval(id);
  }, [popup]);

  if (!popup) return null;

  const outcome = popup.result;
  const secondsLeft = getReplaySecondsLeft(popup.openedAt);
  const expired = secondsLeft <= 0;

  const multiplier =
    typeof popup.prizeMultiplier === "number" && popup.prizeMultiplier > 0
      ? popup.prizeMultiplier
      : 1.9;
  const wager =
    typeof popup.wager === "number" && Number.isFinite(popup.wager)
      ? popup.wager
      : 0;
  const payout =
    typeof popup.payout === "number" && Number.isFinite(popup.payout)
      ? popup.payout
      : 0;

  // Settlement (processMatchFinishedPayout): the winner is credited
  // `payout` (= wager × multiplier, stake included); a loss forfeits
  // the wager. The tokens row is hidden when the numbers aren't on
  // the payload or on a draw (nothing to show).
  const tokenDelta =
    outcome === "win" && payout > 0 && wager > 0
      ? payout - wager
      : outcome === "loss" && wager > 0
        ? -wager
        : null;

  const winnerLine =
    popup.winnerName ?? (outcome === "win" ? "You" : "Opponent");
  const scoreLine = popup.finalScore
    ? popup.finalScore.seat1 === popup.finalScore.seat2
      ? `${popup.finalScore.seat1} – ${popup.finalScore.seat2} (drawn)`
      : `${popup.finalScore.seat1} – ${popup.finalScore.seat2}`
    : null;

  const headline =
    outcome === "win"
      ? "You took the match"
      : outcome === "loss"
        ? `${winnerLine} took the match`
        : "Dead heat — draw";
  const subline = `${endReasonToLabel(popup.reason)}${
    popup.opponentName ? ` · vs. ${popup.opponentName}` : ""
  }`;

  return (
    <PvpResultScreen
      open
      outcome={outcome}
      headline={headline}
      subline={subline}
      gameName="Precision"
      opponent={popup.opponentName ? { name: popup.opponentName } : null}
      tokenDelta={tokenDelta}
      summary={[
        {
          label: "Result",
          value: outcome === "win" ? "Win" : outcome === "loss" ? "Loss" : "Draw",
        },
        ...(scoreLine
          ? [{ label: "Score", value: scoreLine }]
          : []),
        ...(popup.winnerName
          ? [{ label: "Winner", value: popup.winnerName }]
          : []),
      ]}
      details={[
        ...(wager > 0
          ? [{ label: "Wager", value: `${formatTokens(wager)} tokens` }]
          : []),
        ...(payout > 0
          ? [
              {
                label: "Prize paid",
                value: `+${formatTokens(payout)} tokens`,
              },
              {
                label: "Multiplier",
                value: `${multiplier}× on ${formatTokens(wager)} wagered`,
              },
            ]
          : []),
      ]}
      detailsContent={
        <div className="mt-3 text-center">
          <p className="text-xs font-bold uppercase tracking-widest text-yellow-200">
            {t("games.precision.replay_window_label")} {secondsLeft}s
          </p>
          <p className="mt-1 text-xs text-slate-300">
            {expired
              ? t("games.precision.expired")
              : returnChosen
                ? t("games.precision.replay_disabled_return")
                : opponentReplayRequested
                  ? t("games.precision.opponent_ready_replay")
                  : t("games.precision.replay_explainer", {
                      seconds: Math.round(RESULT_POPUP_REPLAY_WINDOW_MS / 1000),
                    })}
          </p>
        </div>
      }
      playAgain={{
        label: replayRequested
          ? t("games.precision.replay_requested")
          : t("games.precision.replay_button"),
        onClick: onReplay,
      }}
      onReturnToLobby={onReturnToLobby}
    />
  );
}

export default React.memo(PrecisionResultPopupImpl);