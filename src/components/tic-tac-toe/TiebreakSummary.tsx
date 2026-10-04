"use client";

// src/components/tic-tac-toe/TiebreakSummary.tsx
//
// The final tiebreak readout for a fully-resolved Round 3 with no Mega line.
//
// ── AUTHORITY ─────────────────────────────────────────────────────────────
//
// Every number here comes from the SERVER's `tiebreak` object (xBoards /
// oBoards / xCells / oCells / decidedBy / winner). This component only formats
// it — it never re-derives board control, cell control or the winner.
//
//   BOARD CONTROL   Player X: 5 boards · Player O: 4 boards · Winner: X
//   CELL CONTROL    Player X: 31 cells · Player O: 29 cells · Winner: X
//   SUDDEN DEATH    a complete tie — the match goes to sudden death

import {
  seatColor,
  tiebreakHeading,
  tiebreakRows,
  tiebreakWinnerMark,
} from "../../lib/tic-tac-toe/ui";

export type TiebreakSummaryProps = {
  /** The server's tiebreak summary, or null. */
  tiebreak: unknown;
  className?: string;
};

export default function TiebreakSummary({ tiebreak, className = "" }: TiebreakSummaryProps) {
  if (!tiebreak) return null;
  const decidedBy = (tiebreak as { decidedBy?: unknown }).decidedBy;
  const heading = tiebreakHeading(tiebreak);
  const rows = tiebreakRows(tiebreak);
  const isSuddenDeath = decidedBy === "sudden-death";
  const winnerMark = tiebreakWinnerMark(tiebreak);
  const accent = isSuddenDeath ? "#fbbf24" : seatColor(winnerMark === "O" ? "player2" : "player1");

  return (
    <div
      data-testid="tiebreak-summary"
      data-decided-by={String(decidedBy ?? "")}
      data-winner={winnerMark ?? ""}
      className={`rounded-2xl border p-3 ${
        isSuddenDeath
          ? "border-amber-400/50 bg-amber-500/10"
          : "border-emerald-400/40 bg-emerald-500/[0.07]"
      } ${className}`}
    >
      <div className="flex items-center justify-between gap-2">
        <h3
          data-testid="tiebreak-heading"
          className="text-xs font-black uppercase tracking-[0.25em]"
          style={{ color: accent }}
        >
          {heading}
        </h3>
        {!isSuddenDeath && winnerMark && (
          <span
            className="rounded-full border px-2 py-0.5 text-[10px] font-black uppercase tracking-wider"
            style={{ borderColor: accent, color: accent }}
          >
            Winner: {winnerMark}
          </span>
        )}
      </div>

      <dl className="mt-2 space-y-1 text-xs">
        {rows.map((row) => (
          <div key={row.label} className="flex items-center justify-between gap-3">
            <dt className="text-white/50">{row.label}</dt>
            <dd className="font-bold text-white">{row.value}</dd>
          </div>
        ))}
      </dl>

      {isSuddenDeath && (
        <p className="mt-2 text-[11px] text-amber-200/90">
          Sudden death — a win on the live board decides the match.
        </p>
      )}
    </div>
  );
}
