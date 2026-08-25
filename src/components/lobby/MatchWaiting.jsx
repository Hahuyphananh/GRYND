"use client";

// src/components/lobby/MatchWaiting.jsx
//
// Unified full-screen waiting screen for every casino game. Rendered as a
// fixed overlay the moment the player clicks Play, so the "waiting for a
// match" experience looks identical across the whole casino (searching →
// waiting for opponent → match found countdown) instead of each game
// shipping its own one-off banner.
//
// States:
//   "searching" — Play clicked, no match exists yet. Radar-sweep rings +
//                 an elapsed counter so the screen never looks frozen.
//   "waiting"   — A match/lobby exists and the opponent hasn't joined.
//                 Shows seat tiles + Cancel (host) / Leave (guest).
//   "ready"     — Both players joined. Morphs into "Match found!" with a
//                 big countdown before the game mounts.
//
// The component is intentionally data-driven (same philosophy as
// PvpLobby): games pass their icon, a game-specific context line, seats
// and callbacks. All shared chrome (titles, seat labels, buttons) is
// localized through the existing `t()` hook.
//
// Usage:
//   {showWaiting && (
//     <MatchWaiting
//       state="waiting"
//       gameName="Roulette PvP"
//       icon={<RouletteWheelIcon className="h-8 w-8 text-[#00e5ff]" />}
//       subtitle={`Your ${stake} stake is escrowed…`}
//       seats={[
//         { label: "You", name: myName, occupied: true },
//         { label: "Opponent", occupied: false },
//       ]}
//       onCancel={cancelWaiting}
//       cancelLabel="Cancel & refund"
//       cancelling={cancelling}
//     />
//   )}

import { useEffect, useState } from "react";
import Image from "next/image";
import { motion } from "framer-motion";
import { useTranslation } from "../../hooks/useTranslation";
import LogoSmiley from "../../images/logo1.png";

function formatElapsed(totalSeconds) {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export default function MatchWaiting({
  // identity
  state = "searching", // "searching" | "waiting" | "ready"
  gameName = "",
  icon = null,
  // copy
  title = null, // overrides the translated default
  subtitle = null, // game-specific context line (escrow note, hint…)
  // waiting-room data
  seats = [], // [{ label, name?, occupied }]
  countdown = null, // seconds until start (ready state only)
  // actions
  copyCode = null,
  onCopy = null,
  onCancel = null,
  cancelLabel = null,
  cancelling = false,
  onLeave = null,
  leaving = false,
  busy = false,
}) {
  const { t } = useTranslation();
  const [elapsed, setElapsed] = useState(0);
  const [copied, setCopied] = useState(false);

  const isSearching = state === "searching";
  const isWaiting = state === "waiting";
  const isReady = state === "ready";

  // Elapsed counter — only meaningful while searching.
  useEffect(() => {
    if (!isSearching) return;
    setElapsed(0);
    const id = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(id);
  }, [isSearching]);

  const handleCopy = async () => {
    if (onCopy) {
      onCopy();
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
      return;
    }
    if (!copyCode) return;
    try {
      await navigator.clipboard.writeText(copyCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard may be unavailable — ignore
    }
  };

  const resolvedTitle =
    title ||
    (isSearching
      ? t("home.matchWaiting.searching_title")
      : isWaiting
        ? t("home.matchWaiting.waiting_title")
        : t("home.matchWaiting.ready_title"));

  const countdownSeconds =
    countdown === null || countdown === undefined
      ? null
      : Math.max(0, Math.ceil(Number(countdown) || 0));

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.25 }}
      className="fixed inset-0 z-[80] flex items-center justify-center overflow-hidden bg-gradient-to-b from-[#0a0118] via-[#050d1f] to-[#061b3d] px-4"
      role="status"
      aria-live="polite"
    >
      {/* Radar-sweep rings — only while actively searching */}
      {isSearching && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 flex items-center justify-center"
        >
          <span className="absolute h-72 w-72 rounded-full border border-[#00e5ff]/25 animate-ping [animation-duration:2.4s]" />
          <span className="absolute h-72 w-72 rounded-full border border-[#00e5ff]/15 animate-ping [animation-duration:2.4s] [animation-delay:0.8s]" />
          <span className="absolute h-72 w-72 rounded-full border border-[#00e5ff]/10 animate-ping [animation-duration:2.4s] [animation-delay:1.6s]" />
        </div>
      )}

      <motion.div
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.08, duration: 0.3, ease: "easeOut" }}
        className="relative z-10 flex w-full max-w-md flex-col items-center text-center"
      >
        {/* Centerpiece — the GRYND logo by default (soft glow + radar
            sweep), or the game's icon in a glowing ring when a game
            passes one. */}
        {icon ? (
          <div className="relative flex h-16 w-16 items-center justify-center rounded-full border-2 border-[#00e5ff]/60 bg-[#00e5ff]/10 shadow-[0_0_30px_rgba(0,229,255,0.35)]">
            {icon}
            {isSearching && (
              <span className="absolute inset-0 animate-ping rounded-full border-2 border-[#00e5ff]/50" />
            )}
          </div>
        ) : (
          <div className="relative flex items-center justify-center">
            <div
              aria-hidden
              className="absolute left-1/2 top-1/2 h-36 w-36 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#00e5ff]/20 blur-2xl"
            />
            <Image
              src={LogoSmiley}
              alt="GRYND"
              width={200}
              height={80}
              priority
              className="relative h-16 w-auto object-contain drop-shadow-[0_0_20px_rgba(245,255,59,0.5)]"
            />
            {isSearching && (
              <span className="absolute left-1/2 top-1/2 h-24 w-24 -translate-x-1/2 -translate-y-1/2 animate-ping rounded-full border-2 border-[#00e5ff]/40" />
            )}
          </div>
        )}

        <h1 className="mt-6 text-2xl font-black uppercase tracking-wider text-[#00e5ff] sm:text-3xl">
          {resolvedTitle}
        </h1>

        {gameName && (
          <p className="mt-1 text-sm font-semibold text-white/60">{gameName}</p>
        )}

        {/* Context line + elapsed counter */}
        <p className="mt-3 text-sm leading-relaxed text-white/60">
          {subtitle}
          {isSearching && (
            <span className="ml-2 whitespace-nowrap tabular-nums text-white/40">
              {formatElapsed(elapsed)}
            </span>
          )}
        </p>

        {/* Seat tiles (waiting state) */}
        {isWaiting && seats.length > 0 && (
          <div className="mt-8 grid w-full grid-cols-2 gap-3">
            {seats.map((seat, i) => (
              <div
                key={i}
                className={`flex flex-col items-center justify-center rounded-xl border p-4 ${
                  seat.occupied
                    ? "border-cyan-500/40 bg-cyan-500/10"
                    : "border-white/15 bg-black/40"
                }`}
              >
                <p className="text-[10px] font-bold uppercase tracking-widest text-white/45">
                  {seat.label}
                </p>
                {seat.occupied ? (
                  <>
                    <p className="mt-1.5 max-w-full truncate text-sm font-bold text-white">
                      {seat.name || "—"}
                    </p>
                    <span className="mt-1.5 inline-flex items-center gap-1.5 text-[10px] font-semibold text-cyan-300">
                      <span className="h-1.5 w-1.5 rounded-full bg-cyan-400" />
                      {t("home.matchWaiting.connected")}
                    </span>
                  </>
                ) : (
                  <>
                    <p className="mt-2 animate-pulse text-sm font-semibold text-cyan-200/80">
                      {t("home.matchWaiting.awaiting_seat")}
                    </p>
                    <span className="mt-1.5 inline-flex items-center gap-1.5 text-[10px] font-semibold text-white/35">
                      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white/30" />
                      {t("home.matchWaiting.open")}
                    </span>
                  </>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Ready countdown */}
        {isReady && countdownSeconds !== null && (
          <div className="mt-8 flex items-baseline justify-center gap-2">
            <span className="text-6xl font-black tabular-nums text-[#f5ff3b] drop-shadow-[0_0_20px_rgba(245,255,59,0.45)]">
              {countdownSeconds}
            </span>
            <span className="text-xs uppercase tracking-widest text-white/50">
              {t("home.matchWaiting.seconds")}
            </span>
          </div>
        )}

        {/* Actions */}
        {(copyCode || onCopy || onCancel || onLeave) && (
          <div className="mt-10 flex flex-wrap items-center justify-center gap-2">
            {(copyCode || onCopy) && (
              <button
                type="button"
                onClick={handleCopy}
                disabled={busy}
                className="inline-flex items-center gap-1.5 rounded-lg border border-[#00e5ff]/40 bg-[#00e5ff]/10 px-4 py-2 text-sm font-bold text-[#9dd8ff] transition-all hover:bg-[#00e5ff]/20 hover:text-[#d8fbff] disabled:opacity-50"
              >
                {copied
                  ? t("home.matchWaiting.invite_copied")
                  : t("home.matchWaiting.copy_invite")}
              </button>
            )}
            {onLeave && (
              <button
                type="button"
                onClick={onLeave}
                disabled={leaving || busy}
                className="inline-flex items-center gap-1.5 rounded-lg bg-cyan-400 px-4 py-2 text-sm font-bold text-black transition-all hover:bg-cyan-300 disabled:opacity-50"
              >
                {leaving ? t("home.matchWaiting.leaving") : t("home.matchWaiting.leave")}
              </button>
            )}
            {onCancel && (
              <button
                type="button"
                onClick={onCancel}
                disabled={cancelling || busy}
                className="inline-flex items-center gap-1.5 rounded-lg border border-red-500/40 bg-red-500/15 px-4 py-2 text-sm font-bold text-red-200 transition-all hover:bg-red-500/25 disabled:opacity-50"
              >
                {cancelling
                  ? t("home.matchWaiting.cancelling")
                  : cancelLabel || t("home.matchWaiting.cancel")}
              </button>
            )}
          </div>
        )}
      </motion.div>
    </motion.div>
  );
}
