"use client";

// src/components/games/battleship/BattlePreview.tsx
//
// The LIVE combat screen. It renders the server's projection (`MatchView`) and
// sends exactly one thing: the coordinate the player locked.
//
// It resolves nothing. It cannot decide a hit, a sunk ship, a round's outcome or
// a winner — those arrive from the server, together, once BOTH attacks are
// locked. Locking disables the enemy grid and shows a waiting state; the two
// results are revealed at the same time, and `reveal` only animates the two
// attacked cells.
//
// HIDDEN INFORMATION stays structural: the enemy board is rendered WITHOUT a
// `ships` prop, and the enemy fleet panel is `conceal`ed to cell counts. The
// opponent's locked cell is never in the snapshot, so it cannot be drawn.

import { useEffect, useMemo, useState } from "react";

import { ROUND_SECONDS, SHIP_KEYS } from "../../../lib/battleship/constants";
import { fleetDamage } from "../../../lib/battleship/combat";
import { formatCoordinate } from "../../../lib/battleship/rules";
import { seatResultLabel, secondsRemaining } from "../../../lib/battleship/view";
import type { Coordinate, MatchView, Seat } from "../../../lib/battleship/types";
import BoardGrid from "./BoardGrid";
import FleetStatus from "./FleetStatus";

export interface BattlePreviewProps {
  /** The server's per-seat projection — never a hidden fleet. */
  view: MatchView;
  round: number;
  /** Server-owned clock; the client only counts it down. */
  roundDeadline: string | null;
  /** This seat has locked its attack for the open round. */
  locked: boolean;
  lockedCoordinate: string | null;
  opponentLocked: boolean;
  busy: boolean;
  error: string | null;
  opponentName: string;
  /** `player1` / `player2` / `draw` once the match ends, else null. */
  result: string | null;
  seat: Seat;
  /** The two cells of the round that just resolved, for the reveal animation. */
  reveal: { round: number; coordinates: readonly string[] } | null;
  /** Practice match: label the opponent as AI and show the tier. */
  isAi?: boolean;
  aiDifficulty?: string | null;
  /** Practice only: start a fresh match at the same tier. */
  onRestart?: () => void;
  onAttack: (coordinate: Coordinate) => void;
  onLeave: () => void;
}

export default function BattlePreview({
  view,
  round,
  roundDeadline,
  locked,
  lockedCoordinate,
  opponentLocked,
  busy,
  error,
  opponentName,
  result,
  seat,
  reveal,
  isAi = false,
  aiDifficulty = null,
  onRestart,
  onAttack,
  onLeave,
}: BattlePreviewProps) {
  const [selected, setSelected] = useState<Coordinate | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(ROUND_SECONDS);

  const damage = useMemo(
    () => fleetDamage(view.you.fleet, view.opponent.attacks),
    [view],
  );

  /** The viewer's OWN ships, with per-cell damage. */
  const ownShips = useMemo(
    () =>
      view.you.fleet.ships.map((placement) => ({
        placement,
        damaged: damage.damaged[placement.ship] ?? [],
      })),
    [view, damage],
  );

  /**
   * The enemy fleet panel: five rows by SHIP IDENTITY with no positions at all,
   * so `conceal` can show cell counts and sunk state and nothing else.
   */
  const enemyRows = useMemo(
    () => SHIP_KEYS.map((ship) => ({ ship, orientation: "horizontal" as const, x: 0, y: 0 })),
    [],
  );

  const history = useMemo(() => {
    const rows = [
      ...view.you.attacks.map((attack) => ({ ...attack, by: "you" as const })),
      ...view.opponent.attacks.map((attack) => ({ ...attack, by: "opponent" as const })),
    ];
    return rows.sort(
      (a, b) => a.round - b.round || (a.by === b.by ? 0 : a.by === "you" ? -1 : 1),
    );
  }, [view]);

  // The lock is final: once the server says locked, the selection is gone.
  useEffect(() => {
    if (locked) setSelected(null);
  }, [locked]);

  useEffect(() => {
    const tick = () => {
      setSecondsLeft(
        roundDeadline ? Math.min(ROUND_SECONDS, secondsRemaining(roundDeadline)) : ROUND_SECONDS,
      );
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [roundDeadline]);

  const resultLabel = seatResultLabel(result, seat);
  const revealCells = reveal?.coordinates ?? [];
  const displayName = isAi ? "GRYND AI" : opponentName;
  const tierLabel = aiDifficulty ? aiDifficulty[0].toUpperCase() + aiDifficulty.slice(1) : "Normal";

  return (
    <section data-testid="battle-preview" className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-white/10 bg-[#061229]/70 p-3 sm:p-4">
        <div className="flex items-center gap-3">
          <span
            aria-hidden="true"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-[#ffec08]/50 bg-[#0a1a3d] text-sm font-black text-[#ffec08]"
          >
            {displayName.slice(0, 2).toUpperCase()}
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-black text-white" data-testid="opponent-name">
              {displayName}
            </p>
            <p className="flex flex-wrap items-center gap-2 text-[10px] uppercase tracking-wider text-white/45">
              <span
                data-testid="opponent-rank"
                className="rounded-full border border-[#ffec08]/30 px-2 py-0.5 text-[#ffec08]/90"
              >
                {view.you.enemyShipsRemaining} enemy ships
              </span>
              {isAi ? (
                <>
                  <span
                    data-testid="ai-difficulty"
                    className="rounded-full border border-cyan-400/40 px-2 py-0.5 text-cyan-200/90"
                  >
                    AI · {tierLabel}
                  </span>
                  {/* The bot pre-commits its shot, so it is locked before you are. */}
                  <span
                    data-testid="ai-thinking"
                    className="inline-flex items-center gap-1 text-cyan-200/80"
                  >
                    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-cyan-300" />
                    {locked ? "AI resolving…" : "AI is aiming…"}
                  </span>
                </>
              ) : (
                <span>Ranked duel</span>
              )}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <span
            data-testid="round-number"
            className="rounded-lg border border-white/15 px-2.5 py-1 text-[11px] font-black text-white/80"
          >
            Round {round}
          </span>
          <span
            data-testid="round-countdown"
            className={`rounded-lg border px-2.5 py-1 text-[11px] font-black tabular-nums ${
              secondsLeft <= 5
                ? "border-red-400/60 text-red-300"
                : "border-[#ffec08]/40 text-[#ffec08]"
            }`}
          >
            0:{String(secondsLeft).padStart(2, "0")}
          </span>
          <button
            type="button"
            onClick={onLeave}
            className="rounded-lg border border-white/15 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-white/60 transition hover:border-white/40 hover:text-white"
          >
            Leave
          </button>
        </div>
      </header>

      {resultLabel ? (
        <div
          data-testid="battle-result"
          data-result={resultLabel.toLowerCase()}
          className="rounded-2xl border border-[#ffec08]/40 bg-[#ffec08]/10 p-3 text-center text-sm font-black uppercase tracking-[0.2em] text-[#ffec08]"
        >
          {resultLabel}
          {isAi && onRestart ? (
            <div className="mt-2 flex justify-center gap-2">
              <button
                type="button"
                data-testid="practice-restart"
                onClick={onRestart}
                className="rounded-lg border-b-4 border-[#b7a800] bg-[#ffec08] px-3 py-1.5 text-[10px] font-black uppercase tracking-wider text-[#0a1200]"
              >
                Play again
              </button>
              <button
                type="button"
                data-testid="practice-lobby"
                onClick={onLeave}
                className="rounded-lg border border-white/20 px-3 py-1.5 text-[10px] font-black uppercase tracking-wider text-white/70"
              >
                Back to lobby
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="min-w-0 rounded-2xl border border-white/10 bg-[#061229]/70 p-3 sm:p-4">
          <BoardGrid
            title="My Fleet"
            subtitle="Incoming shots"
            cells={view.opponent.board}
            ships={ownShips}
            highlight={revealCells}
            testId="my-fleet"
            footnote="Your ships stay visible here. Enemy hits show red."
          />
        </div>

        <div className="min-w-0 rounded-2xl border border-white/10 bg-[#061229]/70 p-3 sm:p-4">
          {/* NO `ships` PROP — the enemy board can never draw a hidden ship. */}
          <BoardGrid
            title="Enemy Waters"
            subtitle="Target"
            cells={view.you.board}
            selected={selected}
            highlight={revealCells}
            onCellClick={(coordinate) => {
              if (locked || result) return;
              setSelected(coordinate);
            }}
            isCellDisabled={() => locked || Boolean(result) || busy}
            testId="enemy-waters"
            footnote="Only shots already fired are shown. Enemy ships stay hidden."
          />

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              data-testid="lock-attack"
              disabled={!selected || locked || Boolean(result) || busy}
              onClick={() => {
                if (!selected) return;
                onAttack(selected);
              }}
              className="rounded-lg border-b-4 border-[#b7a800] bg-[#ffec08] px-4 py-2 text-[11px] font-black uppercase tracking-wider text-[#0a1200] transition disabled:cursor-not-allowed disabled:opacity-40"
            >
              {locked ? "Locked" : selected ? `Lock ${formatCoordinate(selected)}` : "Lock attack"}
            </button>

            {locked ? (
              <p
                data-testid="waiting-opponent"
                className="text-[11px] font-semibold text-[#ffec08]/80"
              >
                Waiting for opponent… your shot is hidden until both attacks are locked.
              </p>
            ) : (
              <p className="text-[11px] text-white/40">Pick an untried coordinate, then lock it in.</p>
            )}
          </div>

          {locked ? (
            <p
              data-testid="attack-locked"
              data-coordinate={lockedCoordinate ?? ""}
              className="mt-2 rounded-lg border border-[#ffec08]/30 bg-[#ffec08]/5 px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-wider text-[#ffec08]"
            >
              Attack locked{lockedCoordinate ? ` · ${lockedCoordinate}` : ""}
            </p>
          ) : null}

          {opponentLocked && !locked ? (
            <p
              data-testid="opponent-locked"
              className="mt-2 text-[10px] uppercase tracking-wider text-white/50"
            >
              Your opponent has locked an attack — lock yours to resolve the round.
            </p>
          ) : null}

          {error ? (
            <p data-testid="attack-error" className="mt-2 text-[11px] text-red-300">
              {error}
            </p>
          ) : null}
        </div>

        <div className="grid gap-4 sm:grid-cols-2 lg:col-span-2">
          <FleetStatus
            title="My Fleet"
            ships={view.you.fleet.ships}
            sunk={damage.sunk}
            damaged={damage.damaged}
            testId="status-own"
          />
          <FleetStatus
            title="Enemy Fleet"
            ships={enemyRows}
            sunk={view.you.sunkShips}
            conceal
            testId="status-enemy"
          />
        </div>
      </div>

      <section className="rounded-2xl border border-white/10 bg-[#061229]/70 p-3 sm:p-4">
        <h3 className="text-[10px] font-black uppercase tracking-[0.2em] text-[#ffec08]">
          Attack history
        </h3>
        {history.length === 0 ? (
          <p data-testid="history-empty" className="mt-2 text-[11px] text-white/40">
            No shots fired yet. Both attacks appear here once a round resolves.
          </p>
        ) : (
          <ul className="mt-2 space-y-1 text-[11px] text-white/70">
            {history.map((entry) => (
              <li key={`${entry.by}-${entry.round}`} data-testid={`history-${entry.by}-${entry.round}`}>
                Round {entry.round} · {entry.by === "you" ? "You" : "Opponent"} · {entry.coordinate} ·{" "}
                {entry.result}
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="text-[10px] leading-snug text-white/30">
        Both attacks stay hidden until locked, then resolve together on the server. Your fleet
        layout never leaves your own board.
      </p>
    </section>
  );
}
