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
import { IconHeartHandshake, IconTrophy, IconX } from "@tabler/icons-react";
import GlitchSay from "../../mascot/GlitchSay";
import { glitchResultMoment } from "../../../lib/mascot/glitchMoments";
import { useTranslation } from "../../../hooks/useTranslation";
import BoardGrid from "./BoardGrid";
import FleetStatus from "./FleetStatus";

// The match-ending beat. The server's verdict arrives with the last snapshot,
// but the victory / defeat popup is held back this long so the final boards
// (the two cells the last round revealed) are what the player reads first.
// Battleship draws its own end popup instead of mounting the shared result
// screen, so it holds its own beat here.
export const BATTLE_RESULT_DELAY_MS = 2_000;

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

// The popup's palette: a win reads green, a loss red, a draw neutral — the
// same language the shared result screen uses, in a compact card.
const RESULT_PANEL_STYLES: Record<string, string> = {
  Victory:
    "border-emerald-400/60 bg-gradient-to-b from-[#0d2b1a] via-[#072014] to-[#04170e] shadow-[0_0_40px_rgba(52,211,153,0.3)]",
  Defeat:
    "border-red-500/50 bg-gradient-to-b from-[#2a0f14] via-[#1d0a0e] to-[#140608] shadow-[0_0_36px_rgba(239,68,68,0.24)]",
  Draw:
    "border-cyan-400/50 bg-gradient-to-b from-[#0a1a33] via-[#08142a] to-[#050d1c] shadow-[0_0_36px_rgba(34,211,238,0.24)]",
};

const RESULT_ICON_STYLES: Record<string, string> = {
  Victory: "text-emerald-300",
  Defeat: "text-red-300",
  Draw: "text-cyan-300",
};

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
  const { t } = useTranslation();
  const [selected, setSelected] = useState<Coordinate | null>(null);
  // The result the player is ALLOWED to see yet (null during the hold). The
  // server verdict in `result` still shuts the boards down immediately; only
  // the panel waits.
  const [revealedResult, setRevealedResult] = useState<string | null>(null);
  useEffect(() => {
    if (!result) {
      setRevealedResult(null);
      return undefined;
    }
    const timer = setTimeout(() => setRevealedResult(result), BATTLE_RESULT_DELAY_MS);
    return () => clearTimeout(timer);
  }, [result]);
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

  const resultLabel = seatResultLabel(revealedResult, seat);
  // The shared result moment decides GLITCH's face and line, so this end
  // panel matches every other game's result screen instead of inventing its
  // own mascot copy.
  const resultMoment = resultLabel
    ? glitchResultMoment(resultLabel === "Victory" ? "win" : resultLabel === "Draw" ? "draw" : "loss")
    : null;
  const revealCells = reveal?.coordinates ?? [];
  const displayName = isAi ? "GRYND AI" : opponentName;
  // One line of real match data under the verdict — never an invented reward.
  const resultLine =
    resultLabel === "Victory"
      ? `You sank all six of ${displayName}'s ships.`
      : resultLabel === "Defeat"
        ? `${displayName} sank your fleet.`
        : "Both fleets went down in the same round.";
  const tierLabel = aiDifficulty ? aiDifficulty[0].toUpperCase() + aiDifficulty.slice(1) : "Normal";

  return (
    <section data-testid="battle-preview" className="space-y-2 sm:space-y-3">
      <header className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-white/10 bg-[#061229]/70 p-2 sm:p-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <span
            aria-hidden="true"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-[#ffec08]/50 bg-[#0a1a3d] text-xs font-black text-[#ffec08]"
          >
            {displayName.slice(0, 2).toUpperCase()}
          </span>
          <div className="min-w-0">
            <p className="truncate text-xs font-black text-white sm:text-sm" data-testid="opponent-name">
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

      {/* The match-ending popup. A COMPACT centred card — no wide panel, no
          full-screen result page — sized so it fits a phone viewport without
          scrolling (the max-height is a guard, not the normal state). It is
          held back `BATTLE_RESULT_DELAY_MS` after the server's verdict so the
          last round's revealed cells are read before the result covers them. */}
      {resultLabel ? (
        <div
          data-testid="battle-result-overlay"
          className="fixed inset-0 z-[80] flex items-center justify-center overflow-y-auto bg-black/75 px-4 py-4 backdrop-blur-sm"
        >
          <div
            data-testid="battle-result"
            data-result={resultLabel.toLowerCase()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="battle-result-title"
            className={`max-h-[calc(100dvh-2rem)] w-full max-w-[20rem] overflow-y-auto rounded-2xl border-2 p-4 text-center ${RESULT_PANEL_STYLES[resultLabel]}`}
          >
            <span
              aria-hidden="true"
              className={`mx-auto flex h-11 w-11 items-center justify-center rounded-xl border border-white/10 bg-black/30 ${RESULT_ICON_STYLES[resultLabel]}`}
            >
              {resultLabel === "Victory" ? (
                <IconTrophy size={24} />
              ) : resultLabel === "Defeat" ? (
                <IconX size={24} />
              ) : (
                <IconHeartHandshake size={24} />
              )}
            </span>
            <p className="mt-2 text-[9px] font-black uppercase tracking-[0.3em] text-white/45">
              Battleship
            </p>
            <h2
              id="battle-result-title"
              className={`text-2xl font-black uppercase tracking-wide ${RESULT_ICON_STYLES[resultLabel]}`}
            >
              {resultLabel}
            </h2>
            <p className="mx-auto mt-1 max-w-[16rem] text-[11px] leading-snug text-white/70">
              {resultLine}
            </p>
            {resultMoment ? (
              <div className="mt-2 flex justify-center normal-case tracking-normal">
                <GlitchSay
                  expression={resultMoment.expression}
                  message={t(resultMoment.messageKey)}
                  placement="inline"
                  size="sm"
                  eventId={resultMoment.eventId}
                />
              </div>
            ) : null}
            {isAi && onRestart ? (
              <div className="mt-3 flex flex-col gap-2">
                <button
                  type="button"
                  data-testid="practice-restart"
                  onClick={onRestart}
                  className="rounded-lg border-b-4 border-[#b7a800] bg-[#ffec08] px-3 py-2 text-[10px] font-black uppercase tracking-wider text-[#0a1200]"
                >
                  Play again
                </button>
                <button
                  type="button"
                  data-testid="practice-lobby"
                  onClick={onLeave}
                  className="rounded-lg border border-white/20 px-3 py-2 text-[10px] font-black uppercase tracking-wider text-white/70"
                >
                  Back to lobby
                </button>
              </div>
            ) : (
              <div className="mt-3">
                <button
                  type="button"
                  data-testid="battle-result-leave"
                  onClick={onLeave}
                  className="w-full rounded-lg border border-white/20 px-3 py-2 text-[10px] font-black uppercase tracking-wider text-white/70"
                >
                  Leave match
                </button>
              </div>
            )}
          </div>
        </div>
      ) : null}

      {/* Both boards, stacked close together and sized from the viewport height.
          A 14-column board is wide, so one full-width board per row pushed the
          enemy waters — and the Lock button under them — below the fold. This
          wrapper caps the board width by `100dvh`, so the fleet, the enemy
          waters and the lock control are all on one screen without shrinking
          the cells into slivers. On a wide screen the fleet panels move to the
          side rails, which uses the width without adding height. */}
      <div className="grid gap-2 lg:grid-cols-[minmax(0,15rem)_minmax(0,1fr)_minmax(0,15rem)] lg:items-start">
        <div className="order-2 min-w-0 lg:order-none lg:col-start-1 lg:row-start-1">
          <FleetStatus
            title="My Fleet"
            ships={view.you.fleet.ships}
            sunk={damage.sunk}
            damaged={damage.damaged}
            testId="status-own"
          />
        </div>

      <div
        data-testid="battle-boards"
        className="order-1 mx-auto grid w-full gap-1.5 lg:order-none lg:col-start-2 lg:row-start-1"
        style={{ maxWidth: "min(100%, clamp(17.5rem, calc((100dvh - 18rem) * 0.7), 34rem))" }}
      >
        <div className="min-w-0 rounded-xl border border-white/10 bg-[#061229]/70 p-2">
          <BoardGrid
            title="My Fleet"
            subtitle="Incoming shots"
            cells={view.opponent.board}
            ships={ownShips}
            highlight={revealCells}
            testId="my-fleet"
            compact
          />
        </div>

        <div className="min-w-0 rounded-xl border border-white/10 bg-[#061229]/70 p-2">
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
            compact
          />

          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              type="button"
              data-testid="lock-attack"
              disabled={!selected || locked || Boolean(result) || busy}
              onClick={() => {
                if (!selected) return;
                onAttack(selected);
              }}
              className="rounded-lg border-b-4 border-[#b7a800] bg-[#ffec08] px-3 py-1.5 text-[10px] font-black uppercase tracking-wider text-[#0a1200] transition disabled:cursor-not-allowed disabled:opacity-40"
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

      </div>

        <div className="order-3 min-w-0 lg:order-none lg:col-start-3 lg:row-start-1">
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
