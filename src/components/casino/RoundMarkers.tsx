"use client";

// src/components/casino/RoundMarkers.tsx
//
// Brawl-Stars-Hotzone-style round tracker shared by every best-of game
// (RPS best-of-7, Blackjack best-of-3, Memory Grid best-of-5, …).
//
// A single row of dots, one per round in the match:
//   • BLUE  — a round YOU won
//   • RED   — a round the OPPONENT won
//   • dim   — round not decided yet
// Ties never consume a dot (they are replayed), so `myWins + oppWins`
// is always ≤ `total`.

import { motion } from "framer-motion";

interface RoundMarkersProps {
  /** Total rounds in the match (best-of N). */
  total?: number;
  /** Rounds won by the viewer. */
  myWins: number;
  /** Rounds won by the opponent. */
  oppWins: number;
  /** Optional labels for the legend (defaults: "You" / "Opponent"). */
  myLabel?: string;
  oppLabel?: string;
  /** Compact variant for in-table scoreboards (smaller dots, no legend). */
  compact?: boolean;
}

export default function RoundMarkers({
  total = 7,
  myWins,
  oppWins,
  myLabel = "You",
  oppLabel = "Opponent",
  compact = false,
}: RoundMarkersProps) {
  const decided = myWins + oppWins;

  return (
    <div className="flex flex-col items-center gap-1.5">
      <div className="flex items-center gap-1.5" role="img" aria-label={`Best of ${total} — you won ${myWins}, opponent won ${oppWins}`}>
        {Array.from({ length: total }).map((_, i) => {
          const isMyWin = i < myWins;
          const isOppWin = !isMyWin && i < decided;
          const filled = isMyWin || isOppWin;
          // Only the most recently filled dot pops (keyed on `decided` so
          // a fresh win re-keys the row and re-mounts it) — the earlier
          // dots mount without initial/animate and render at full size.
          const isNewest = filled && i === decided - 1;
          return (
            <motion.span
              key={`${i}-${filled ? (isMyWin ? "blue" : "red") : "empty"}-${decided}`}
              {...(isNewest
                ? {
                    initial: { scale: 0 },
                    animate: { scale: 1 },
                    transition: { type: "spring", stiffness: 400, damping: 15 },
                  }
                : {})}
              className={`inline-block rounded-full border transition-shadow ${
                compact ? "h-2 w-2" : "h-3.5 w-3.5 sm:h-4 sm:w-4"
              } ${
                isMyWin
                  ? "border-blue-200 bg-blue-500 shadow-[0_0_8px_rgba(59,130,246,0.9)]"
                  : isOppWin
                    ? "border-red-200 bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.9)]"
                    : "border-white/20 bg-white/5"
              }`}
            />
          );
        })}
      </div>

      {!compact && (
        <div className="flex items-center gap-4 text-[10px] font-bold uppercase tracking-widest text-white/60">
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded-full bg-blue-500" />
            {myLabel}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded-full bg-red-500" />
            {oppLabel}
          </span>
        </div>
      )}
    </div>
  );
}
