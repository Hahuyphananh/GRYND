"use client";

import React from "react";

// ── Reusable waiting-room panel used inside the match page ──────────────
//
// Renders the matchmaking state with two seat slots, a host/opponent panel
// and a leave button. Pure presentational component — the parent owns
// the cancel/leave handler and the player list.

import { motion } from "framer-motion";
import { SEAT_COUNT } from "../../lib/precision/constants";
import type { PrecisionPlayer } from "../../lib/precision/types";
import { useTranslation } from "../../hooks/useTranslation";

interface PrecisionWaitingRoomProps {
  matchId: string;
  hostName: string;
  players: PrecisionPlayer[];
  wager: number;
  onLeave: () => void;
  onCancel?: () => void;
  isHost: boolean;
  copyCode?: string;
}

const SEAT_LABELS = ["Alpha", "Bravo"] as const;

function PrecisionWaitingRoomImpl({
  matchId,
  hostName,
  players,
  wager,
  onLeave,
  onCancel,
  isHost,
  copyCode,
}: PrecisionWaitingRoomProps) {
  const { t } = useTranslation();
  const [copied, setCopied] = React.useState(false);

  const handleCopy = async () => {
    if (!copyCode) return;
    try {
      await navigator.clipboard.writeText(copyCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore — clipboard may be unavailable in some browsers
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: "easeOut" }}
      className="mx-auto mt-6 w-full max-w-3xl rounded-2xl border border-[#00e5ff]/40 bg-black/30 p-4 text-white shadow-[0_0_30px_rgba(0,229,255,0.15)] sm:p-6"
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
            {t("games.precision.hosted_by", { name: hostName, wager })}
          </p>
        </div>
        {copyCode && (
          <button
            onClick={handleCopy}
            className="rounded-lg border border-[#00e5ff]/40 bg-[#00e5ff]/10 px-3 py-2 text-xs font-bold text-[#9dd8ff] hover:bg-[#00e5ff]/20"
          >
            {copied ? t("games.precision.copied") : t("games.precision.invite_code", { code: copyCode })}
          </button>
        )}
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
                  <p className="mt-2 text-xl font-black text-white">{occupant.name}</p>
                  <p className="mt-1 text-xs text-cyan-200">{t("games.precision.ready_connected")}</p>
                </>
              ) : (
                <>
                  <p className="mt-3 animate-pulse text-lg font-semibold text-cyan-200">
                    {t("games.precision.awaiting_player")}
                  </p>
                  <p className="mt-2 text-xs text-cyan-100/60">
                    {t("games.precision.share_invite")}
                  </p>
                </>
              )}
            </div>
          );
        })}
      </div>

      <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:justify-end">
        {isHost && onCancel && (
          <button
            onClick={onCancel}
            className="rounded-lg border border-red-500/40 bg-red-500/15 px-4 py-2 font-bold text-red-200 hover:bg-red-500/25"
          >
            {t("games.precision.cancel_lobby")}
          </button>
        )}
        <button
          onClick={onLeave}
          className="rounded-lg bg-cyan-400 px-4 py-2 font-bold text-black hover:bg-cyan-300"
        >
          {t("games.precision.leave_button")}
        </button>
      </div>
    </motion.div>
  );
}

// OPTIMIZATION — React.memo wrapper. The waiting room renders are
// driven by `players` updates from polling/socket. Memoising the
// wrapper avoids the `motion.div` animation cycle + clipboard button
// re-rendering during unrelated polling ticks where player list
// hasn't actually changed.
export default React.memo(PrecisionWaitingRoomImpl);
