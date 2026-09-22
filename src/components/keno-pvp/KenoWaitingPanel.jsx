"use client";

// src/components/keno-pvp/KenoWaitingPanel.jsx
//
// The in-page waiting room for a Keno PvP match: shown in place of the board
// while the match is filling up (`waiting` — no opponent yet) and during the
// server's 3s get-ready banner (`ready` — both seats in, first tile about to
// light).
//
// Modelled on src/components/precision/PrecisionReadyRoom.tsx: a bordered
// panel, one card per seat showing the real player name, and the actions the
// state allows. Pure presentational — the match page owns the click handlers,
// the local "I have readied" state and the player records (so the opponent's
// name/frame come from the same server-enriched payload the board uses).
//
// The Ready button is LOCAL (the user's choice): Keno has no server-side
// ready flag — the server lights the first tile when its own ready window
// elapses — so readying up shows the player's own state and nothing else.

import { motion } from "framer-motion";
import FrameAvatar from "../FrameAvatar";
import { cosmeticEffectClass } from "../../lib/profileCosmetics";

const SEAT_ACCENT = [
  // Seat 1 — the viewer. Cyan, matching the in-game seat card.
  {
    card: "border-[#00ffa6]/40 bg-[#00ffa6]/5",
    label: "text-[#7dffcf]",
  },
  // Seat 2 — the opponent. Gold, matching the in-game seat card.
  {
    card: "border-[#FFD700]/40 bg-[#FFD700]/5",
    label: "text-[#ffe98a]",
  },
];

function SeatCard({ label, accent, occupant, name, isMe, readyLabel, emptyHint }) {
  return (
    <div
      className={`flex flex-col items-center justify-center rounded-xl border p-4 text-center ${
        occupant ? accent.card : "border-white/15 bg-black/40"
      }`}
    >
      <p
        className={`text-[10px] font-bold uppercase tracking-widest ${
          occupant ? accent.label : "text-white/45"
        }`}
      >
        {label}
      </p>

      {occupant ? (
        <div className="mt-2 flex w-full flex-col items-center gap-1.5">
          <FrameAvatar
            frame={occupant.profileFrame || null}
            iconKey={occupant.iconKey || null}
            name={name}
            size="h-9 w-9"
          />
          <p
            className={`max-w-full truncate text-sm font-bold text-white ${cosmeticEffectClass(
              occupant.profileFrame?.usernameEffect?.visual,
            )}`}
            style={occupant.nameColor ? { color: occupant.nameColor } : undefined}
          >
            {name}
            {isMe ? " (you)" : ""}
          </p>
          <span className="flex min-h-4 flex-wrap items-center justify-center gap-x-2.5 gap-y-1 text-[10px] font-semibold">
            {readyLabel ? (
              <span className="inline-flex items-center gap-1.5 text-emerald-300">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                {readyLabel}
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 text-cyan-300">
                <span className="h-1.5 w-1.5 rounded-full bg-cyan-400" />
                Connected
              </span>
            )}
          </span>
        </div>
      ) : (
        <>
          <p className="mt-2 animate-pulse text-sm font-semibold text-cyan-200/80">
            Awaiting player
          </p>
          {emptyHint && (
            <span className="mt-1.5 inline-flex items-center gap-1.5 text-[10px] font-semibold text-white/35">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white/30" />
              {emptyHint}
            </span>
          )}
        </>
      )}
    </div>
  );
}

export default function KenoWaitingPanel({
  matchId,
  /** "waiting" (no opponent yet) | "ready" (both seats in, 3s banner). */
  state = "waiting",
  isAi = false,
  stakeAmount = 0,
  myName = "You",
  oppName = "Opponent",
  mySeatSummary = null,
  oppSeatSummary = null,
  /** Local, optimistic — the server's banner starts the match either way. */
  selfReady = false,
  onReadyClick = null,
  /** Host only, and only while the match is still waiting for an opponent. */
  onCancel = null,
  /** True while the cancel/leave request is in flight. */
  cancelling = false,
}) {
  const isReady = state === "ready";
  const stake = Number(stakeAmount) || 0;
  const seated = isReady; // both seats are occupied exactly when ready

  const subtitle = isReady
    ? isAi
      ? `Free practice vs ${oppName} — no stake, nothing to lose.`
      : `${myName} vs ${oppName} — ${stake.toLocaleString()} tokens on the line.`
    : `Your ${stake.toLocaleString()} stake is escrowed. A player at the same stake is matched in automatically.`;

  return (
    <motion.div
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: "easeOut" }}
      className={`mx-auto mt-4 w-full max-w-3xl rounded-2xl border bg-black/30 p-4 text-white sm:p-6 ${
        isReady
          ? "border-[#facc15]/40 shadow-[0_0_30px_rgba(250,204,21,0.15)]"
          : "border-[#00e5ff]/40 shadow-[0_0_30px_rgba(0,229,255,0.15)]"
      }`}
      role="status"
      aria-live="polite"
    >
      <p className="text-[10px] uppercase tracking-[0.35em] text-cyan-300/80">
        Match #{String(matchId ?? "").slice(0, 6)}
      </p>
      <h2 className="mt-1 text-2xl font-black text-[#7cefff] sm:text-3xl">
        {isReady ? "Get ready" : "Waiting room"}
      </h2>
      <p className="mt-1 text-sm text-cyan-100/90">{subtitle}</p>

      <div className="mt-5 grid gap-3 sm:grid-cols-2">
        <SeatCard
          label="You"
          accent={SEAT_ACCENT[0]}
          occupant={mySeatSummary || { name: myName }}
          name={myName}
          isMe
          readyLabel={isReady && selfReady ? "Ready" : null}
          emptyHint={null}
        />
        <SeatCard
          label="Opponent"
          accent={SEAT_ACCENT[1]}
          occupant={seated ? oppSeatSummary || { name: oppName } : null}
          name={oppName}
          isMe={false}
          readyLabel={null}
          emptyHint={isReady ? null : "Same stake only"}
        />
      </div>

      <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        {isReady ? (
          <p className="text-xs text-white/50">
            {selfReady
              ? "You're set — the first tile lights in a moment."
              : "Both seats are in. Ready up before the first tile lights."}
          </p>
        ) : (
          <p className="text-xs text-white/50">
            Nothing to do yet — the board opens as soon as your opponent joins.
          </p>
        )}

        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          {onCancel && (
            <button
              type="button"
              onClick={onCancel}
              disabled={cancelling}
              className="rounded-lg border border-red-500/40 bg-red-500/15 px-4 py-2 text-sm font-bold text-red-200 transition hover:bg-red-500/25 disabled:opacity-50"
            >
              {cancelling ? "Cancelling…" : "Cancel Lobby"}
            </button>
          )}
          {isReady && onReadyClick && (
            <button
              type="button"
              onClick={onReadyClick}
              disabled={selfReady}
              className={`rounded-lg px-6 py-3 text-base font-black shadow-[0_0_18px_rgba(250,204,21,0.35)] transition ${
                selfReady
                  ? "cursor-default border border-emerald-300/40 bg-emerald-400/20 text-emerald-100"
                  : "border border-yellow-300/40 bg-yellow-400 text-black hover:bg-yellow-300"
              }`}
            >
              {selfReady ? "You're ready ✓" : "Ready"}
            </button>
          )}
        </div>
      </div>
    </motion.div>
  );
}
