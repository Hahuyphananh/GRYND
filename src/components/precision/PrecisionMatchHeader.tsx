"use client";

// ── Match header for the Precision match page ────────────────────────────
//
// Three small presentational pieces, split out of the match page so the page
// itself is only orchestration:
//
//   * <PrecisionMatchHeader>    — match label, title, wager, report/leave/resign,
//   * <PrecisionCreatorHeader>  — the same actions in the creator-mode frame's
//                                 tighter typography,
//   * <PrecisionMatchStatus>    — the turn banner + error line under the header.
//
// No state, no data fetching: everything is passed in.

import { IconFlag } from "@tabler/icons-react";

import { useTranslation } from "../../hooks/useTranslation";
import { formatTokens } from "../../lib/precision/utils";
import type { PrecisionState } from "../../lib/precision/types";

export interface PrecisionMatchHeaderProps {
  matchId: string;
  state: PrecisionState | null;
  /** True once a real human opponent seat exists to report. */
  canReport: boolean;
  onReport: () => void;
  onLeave: () => void;
  onResign: () => void;
}

export function PrecisionMatchHeader({
  matchId,
  state,
  canReport,
  onReport,
  onLeave,
  onResign,
}: PrecisionMatchHeaderProps) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <p className="text-xs uppercase tracking-[0.35em] text-cyan-300/80">
          {t("games.precision.match_label", { id: matchId.slice(0, 6) })}
        </p>
        <h1 className="mt-1 text-2xl font-black text-fuchsia-300 sm:text-3xl">
          {state?.phase === "active"
            ? t("games.precision.duel_in_progress")
            : t("games.precision.setting_up")}
        </h1>
        {state && (
          <p className="mt-1 text-sm text-cyan-100/90">
            {t("games.precision.wager_tokens", {
              wager: formatTokens(state.wager),
            })}
          </p>
        )}
      </div>
      <div className="flex items-center gap-2">
        {canReport && (
          <button
            onClick={onReport}
            className="rounded border border-red-500/40 bg-red-500/10 px-4 py-2 font-bold text-red-300 transition hover:bg-red-500/25"
          >
            <span className="inline-flex items-center gap-1">
              <IconFlag size={12} /> Report
            </span>
          </button>
        )}
        <button onClick={onLeave} className="rounded bg-[#f5ff3b] px-4 py-2 font-bold text-black">
          {t("games.precision.lobby_button")}
        </button>
        {state?.phase === "active" && (
          <button
            onClick={onResign}
            className="rounded bg-red-600 px-4 py-2 font-bold text-white hover:bg-red-500"
          >
            {t("games.precision.resign")}
          </button>
        )}
      </div>
    </div>
  );
}

/** Compact header used inside the creator-mode (9:16 / 16:9) frames. */
export function PrecisionCreatorHeader({
  matchId,
  state,
  canReport,
  onReport,
  onLeave,
  onResign,
}: PrecisionMatchHeaderProps) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="min-w-0">
        <p className="text-[10px] uppercase tracking-[0.35em] text-cyan-300/80">
          {t("games.precision.match_label", { id: matchId.slice(0, 6) })}
        </p>
        <h1 className="truncate text-lg font-black text-fuchsia-300">
          {state?.phase === "active"
            ? t("games.precision.duel_in_progress")
            : t("games.precision.setting_up")}
        </h1>
        {state && (
          <p className="text-xs text-cyan-100/90">
            {t("games.precision.wager_tokens", {
              wager: formatTokens(state.wager),
            })}
          </p>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {canReport && (
          <button
            onClick={onReport}
            className="rounded border border-red-500/40 bg-red-500/10 px-2.5 py-1 text-[11px] font-bold text-red-300 transition hover:bg-red-500/25"
          >
            <span className="inline-flex items-center gap-1">
              <IconFlag size={11} /> Report
            </span>
          </button>
        )}
        <button
          onClick={onLeave}
          className="rounded bg-[#f5ff3b] px-2.5 py-1 text-[11px] font-bold text-black"
        >
          {t("games.precision.lobby_button")}
        </button>
        {state?.phase === "active" && (
          <button
            onClick={onResign}
            className="rounded bg-red-600 px-2.5 py-1 text-[11px] font-bold text-white hover:bg-red-500"
          >
            {t("games.precision.resign")}
          </button>
        )}
      </div>
    </div>
  );
}

export interface PrecisionMatchStatusProps {
  /** Whose turn it is, or null outside the active phase. */
  turnBanner: string | null;
  error: string | null;
}

/** Turn banner + error line, rendered directly under the header. */
export function PrecisionMatchStatus({ turnBanner, error }: PrecisionMatchStatusProps) {
  return (
    <>
      {turnBanner && (
        <p className="mt-4 inline-block rounded border border-amber-300/40 bg-amber-300/10 px-3 py-1 text-sm font-bold uppercase tracking-widest text-amber-200">
          {turnBanner}
        </p>
      )}

      {error && (
        <p className="mt-4 rounded border border-red-400/40 bg-red-500/10 px-3 py-2 text-sm text-red-200">
          {error}
        </p>
      )}
    </>
  );
}
