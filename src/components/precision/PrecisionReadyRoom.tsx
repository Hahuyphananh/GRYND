"use client";

import React from "react";

// ── Ready-up waiting room for the Precision PvP casino game ──────────────
//
// This is the post-matchmaking, pre-game screen. Both players land here
// after `tryAutoMatch` pairs them. Each must click Ready before the
// server flips the match to `phase: "active"`.
//
// Pure presentational. The match page owns:
//   * the click handler (`onReadyClick`)
//   * the local "I have readied" optimistic state
//   * the player record list (so opponent isReady updates via socket)

import { motion } from "framer-motion";
import { SEAT_COUNT } from "../../lib/precision/constants";
import type { PrecisionPlayer } from "../../lib/precision/types";
import { useTranslation } from "../../hooks/useTranslation";
import FrameAvatar from "../FrameAvatar";
import { cosmeticEffectClass } from "../../lib/profileCosmetics";

interface PrecisionReadyRoomProps {
  matchId: string;
  players: PrecisionPlayer[];
  wager: number;
  /** True once the local user clicked Ready (optimistic + server confirm). */
  selfReady: boolean;
  /** Disabled while the POST /api/precision/ready is in flight. */
  readySubmitting: boolean;
  onReadyClick: () => void;
  onLeave: () => void;
}

const SEAT_LABELS = ["Alpha", "Bravo"] as const;

function PrecisionReadyRoomImpl({
  matchId,
  players,
  wager,
  selfReady,
  readySubmitting,
  onReadyClick,
  onLeave,
}: PrecisionReadyRoomProps) {
  const { t } = useTranslation();
  return (
    <motion.div
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: "easeOut" }}
      className="mx-auto mt-6 w-full max-w-3xl rounded-2xl border border-[#facc15]/40 bg-black/30 p-4 text-white shadow-[0_0_30px_rgba(250,204,21,0.15)] sm:p-6"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.35em] text-cyan-300/80">
            {t("games.precision.match_label", { id: matchId.slice(0, 6) })}
          </p>
          <h2 className="mt-1 text-2xl font-black text-fuchsia-300 sm:text-3xl">
            {t("games.precision.waiting_room_title")}
          </h2>
          <p className="mt-1 text-sm text-cyan-100">
            {t("games.precision.ready_explainer", { ready: t("games.precision.ready_button") })}{" "}
            <span className="text-cyan-300/80">
              {t("games.precision.wager_tokens", { wager })}
              {" "}
              {t("games.precision.tokens_suffix")}
            </span>
          </p>
        </div>
      </div>

      <div className="mt-5 grid gap-3 sm:grid-cols-2">
        {Array.from({ length: SEAT_COUNT }).map((_, i) => {
          const seat = (i + 1) as 1 | 2;
          const occupant = players.find((p) => p.seat === seat);
          return (
            <div
              key={seat}
              className="flex flex-col items-center justify-center rounded-xl border border-fuchsia-500/35 bg-[#0b0220]/50 p-4 text-center"
            >
              <p className="text-xs font-bold uppercase tracking-widest text-fuchsia-200/90">
                {seat === 1 ? t("games.precision.seat_alpha") : t("games.precision.seat_bravo")}
              </p>
              {occupant ? (
                <>
                  <p className="mt-2 flex items-center justify-center gap-2 text-xl font-black text-white">
                    <FrameAvatar frame={(occupant as any).profileFrame} iconKey={occupant.iconKey} name={occupant.name} size="h-6 w-6" />
                    <span
                      className={cosmeticEffectClass((occupant as any).profileFrame?.usernameEffect?.visual) || undefined}
                      style={occupant.nameColor ? { color: occupant.nameColor } : undefined}
                    >
                      {occupant.name}
                    </span>
                  </p>
                  <div className="mt-2 flex items-center gap-2">
                    <span
                      className={`inline-block h-2 w-2 rounded-full ${
                        occupant.isReady ? "bg-emerald-400" : "bg-slate-500"
                      }`}
                    />
                    <p
                      className={`text-xs font-bold ${
                        occupant.isReady ? "text-emerald-300" : "text-slate-300"
                      }`}
                    >
                      {occupant.isReady ? t("games.precision.ready_label") : t("games.precision.not_ready_label")}
                    </p>
                  </div>
                </>
              ) : (
                <p className="mt-3 text-slate-400">{t("games.precision.slot_empty")}</p>
              )}
            </div>
          );
        })}
      </div>

      <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <button
          onClick={onLeave}
          className="rounded-lg border border-slate-500/40 bg-slate-800/40 px-4 py-2 text-sm font-bold text-slate-200 hover:bg-slate-800/70"
        >
          {t("games.precision.leave_button")}
        </button>
        <button
          onClick={onReadyClick}
          disabled={selfReady || readySubmitting}
          className={`rounded-lg px-6 py-3 text-base font-black shadow-[0_0_18px_rgba(250,204,21,0.35)] transition ${
            selfReady
              ? "cursor-default border border-emerald-300/40 bg-emerald-400/20 text-emerald-100"
              : readySubmitting
                ? "cursor-wait border border-yellow-300/40 bg-yellow-400/20 text-yellow-100"
                : "border border-yellow-300/40 bg-yellow-400 text-black hover:bg-yellow-300"
          }`}
        >
          {selfReady
            ? t("games.precision.ready_done")
            : readySubmitting
              ? t("games.precision.ready_submitting")
              : t("games.precision.ready_button")}
        </button>
      </div>
    </motion.div>
  );
}

// OPTIMIZATION — React.memo wrapper. Same rationale as the Waiting
// Room wrapper: avoids re-running the motion.div animation cycle and
// re-rendering both seat slots during unrelated polling ticks. The
// Ready / Leave buttons still re-render in response to their own
// state changes since those props arrive from the parent.
export default React.memo(PrecisionReadyRoomImpl);
