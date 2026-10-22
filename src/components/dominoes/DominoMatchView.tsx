"use client";

// src/components/dominoes/DominoMatchView.tsx
//
// THE BOARD, IN ONE PRESENTATIONAL COMPONENT.
//
// Everything it draws comes from ONE authoritative snapshot — the payload of
// `GET /api/dominoes/match/<id>` — plus the viewer's own selection and the local
// clock reading. It fetches nothing, holds no match state, and reports intents
// upwards. That is what makes it renderable in a test with a fixed snapshot (see
// tests/dominoes-online-ui.test.mjs, which renders it once per seat and asserts
// the opponent's tiles are nowhere in the markup).
//
// ── WHAT IS ON SCREEN, AND WHY ────────────────────────────────────────────
//
//   opponent seat   name/avatar + TILE COUNT only. The count is public in
//                   dominoes (you can see how many tiles a player holds); the
//                   tiles themselves are not, and never reach the client.
//   turn banner     the server's `isViewerTurn`, plus the 15-second window drawn
//                   from `turnDeadlineAt`. The countdown is decoration: the
//                   server refuses a late action and resolves the turn itself.
//   the chain       both open values, the played tiles in order (see
//                   DominoChain for wrapping/scrolling).
//   the draw pile   a stack and its COUNT. The pile's contents are secret and
//                   are not in the payload.
//   the viewer's hand + the three actions (play on an end, draw, pass).
//   the rules panel a `<details>` disclosure — no modal, no interruption.
//
// ── STATES ────────────────────────────────────────────────────────────────
//
// waiting / reconnecting / your-turn / their-turn / drawing / passing / selected /
// disabled / victory / defeat / draw. The terminal ones are the page's result
// screen; here the board simply stops offering controls (`data-live="false"`)
// and keeps the final position on screen.

import { useId } from "react";

import DominoChain, { type ChainTileLike } from "./DominoChain";
import DominoHand from "./DominoHand";
import SeatAvatar from "../game/SeatAvatar";
import { useTranslation } from "../../hooks/useTranslation";
import {
  countdownFor,
  isTerminalStatus,
  seatLabel,
  type OpenEnds,
} from "../../lib/dominoes/ui";

/**
 * LOCALISATION NOTE: every player-facing string on this board is a key under
 * `APP_TEXT_TRANSLATIONS.<lang>.games.dominoes`. The English values there are
 * the exact sentences the board shipped with, so keying the copy did not change
 * the wording — it only made it translatable (en / fr / es, matching the rest of
 * the app). The `ui.ts` label helpers remain the pure, tested view-model (they
 * take no locale); this component renders the same statements through `t()`.
 */

/** The seat identity the route decorates the snapshot with. */
export type SeatIdentity = {
  name?: string | null;
  iconKey?: string | null;
  profileFrame?: string | null;
  isGuest?: boolean | null;
} | null;

/** The subset of the projection this view renders. */
export type DominoSnapshot = {
  matchId?: string;
  status?: string;
  version?: number;
  ply?: number;
  viewerSeat?: "player1" | "player2" | null;
  opponentSeat?: "player1" | "player2" | null;
  isLive?: boolean;
  isViewerTurn?: boolean;
  hand?: string[];
  chain?: ChainTileLike[];
  openEnds?: OpenEnds;
  turn?: "player1" | "player2" | null;
  turnDeadlineAt?: string | null;
  opponentTileCount?: number;
  drawPileCount?: number;
  result?: string | null;
  winnerId?: string | null;
  resultReason?: string | null;
  players?: { player1?: SeatIdentity; player2?: SeatIdentity } | null;
};

export type DominoMatchViewProps = {
  snapshot: DominoSnapshot | null;
  /** The local clock reading the countdown is drawn from (visual only). */
  nowMs: number;
  selected?: string | null;
  onSelect?: (tile: string | null) => void;
  onPlay?: (tile: string, end?: "left" | "right") => void;
  onDraw?: () => void;
  onPass?: () => void;
  onResign?: () => void;
  /** A submission is in flight — every control waits for its answer. */
  pending?: boolean;
  /** The server's last refusal, or a local explanation. */
  notice?: string | null;
  /** The socket is down: the board still renders, actions are paused. */
  reconnecting?: boolean;
};

export default function DominoMatchView({
  snapshot,
  nowMs,
  selected = null,
  onSelect,
  onPlay,
  onDraw,
  onPass,
  onResign,
  pending = false,
  notice = null,
  reconnecting = false,
}: DominoMatchViewProps) {
  const headingId = useId();
  const { t } = useTranslation();

  if (!snapshot) {
    return (
      <p className="dominoes-empty" role="status" aria-live="polite">
        {t("games.dominoes.turn_loading")}
      </p>
    );
  }

  const status = String(snapshot.status ?? "");
  const terminal = isTerminalStatus(status);
  const isLive = Boolean(snapshot.isLive) && !terminal;
  const isViewerTurn = Boolean(snapshot.isViewerTurn) && isLive;
  const viewerSeat = snapshot.viewerSeat ?? null;
  const opponentSeat = snapshot.opponentSeat ?? null;
  const players = snapshot.players ?? null;
  const viewerIdentity = viewerSeat ? (players?.[viewerSeat] ?? null) : null;
  const opponentIdentity = opponentSeat ? (players?.[opponentSeat] ?? null) : null;
  const opponentName =
    opponentIdentity?.name || (opponentSeat ? seatLabel(opponentSeat, viewerSeat) : "Opponent");

  const chain = Array.isArray(snapshot.chain) ? snapshot.chain : [];
  const chainEmpty = chain.length === 0;
  const hand = Array.isArray(snapshot.hand) ? snapshot.hand : [];
  const opponentTileCount = Number(snapshot.opponentTileCount ?? 0) || 0;
  const drawPileCount = Number(snapshot.drawPileCount ?? 0) || 0;

  // The countdown only exists while the server says a turn is running: a
  // decided match has no clock, and the store clears it.
  const clock = countdownFor(isLive ? snapshot.turnDeadlineAt : null, nowMs);
  const showClock = isLive && Boolean(snapshot.turnDeadlineAt);
  // The countdown bar: how much of the 15-second window is left. Derived from the
  // remaining milliseconds (never from a local 15s animation), so a reload
  // half-way through a turn draws the truth.
  const clockPercent = Math.max(0, Math.min(100, Math.round((clock.remainingMs / 15_000) * 100)));

  return (
    <div
      className="dominoes-board"
      data-testid="dominoes-board"
      data-status={status}
      data-live={isLive ? "true" : "false"}
      data-viewer-seat={viewerSeat ?? ""}
      data-viewer-turn={isViewerTurn ? "true" : "false"}
      aria-labelledby={headingId}
    >
      <h2 id={headingId} className="sr-only">
        {t("games.dominoes.board_title")}
      </h2>

      {/* ── Opponent seat: a name, an avatar, and a COUNT ────────────────── */}
      <div
        className={`dominoes-seat ${isLive && !isViewerTurn ? "is-active" : ""}`}
        data-testid="dominoes-seat-opponent"
        data-active={isLive && !isViewerTurn ? "true" : "false"}
      >
        <span className="dominoes-seat-avatar">
          <SeatAvatar
            iconKey={opponentIdentity?.iconKey ?? null}
            profileFrame={opponentIdentity?.profileFrame ?? null}
            name={opponentName}
            isAi={false}
            isGuest={Boolean(opponentIdentity?.isGuest)}
            size="h-9 w-9"
          />
        </span>
        <span className="dominoes-seat-body">
          <span className="dominoes-seat-name">{opponentName}</span>
          <span className="dominoes-seat-meta" data-testid="dominoes-opponent-count">
            {t(
              opponentTileCount === 1
                ? "games.dominoes.tiles_left_one"
                : "games.dominoes.tiles_left",
              { count: opponentTileCount },
            )}
          </span>
        </span>
        {isLive && !isViewerTurn ? (
          <span className="dominoes-turn-badge" data-testid="dominoes-opponent-turn-badge">
            {t("games.dominoes.to_move")}
          </span>
        ) : null}
      </div>

      {/* ── Turn banner + clock ──────────────────────────────────────────── */}
      <div className="dominoes-banner">
        <p className="dominoes-status" role="status" aria-live="polite" data-testid="dominoes-status">
          {t(
            `games.dominoes.turn_${
              status === "waiting"
                ? "waiting"
                : status === "cancelled"
                  ? "cancelled"
                  : status === "finished"
                    ? "finished"
                    : !viewerSeat
                      ? "loading"
                      : isViewerTurn
                        ? "yours"
                        : "theirs"
            }`,
            { name: opponentName },
          )}
        </p>
        <span className="dominoes-lifecycle" data-testid="dominoes-lifecycle">
          {t(
            `games.dominoes.status_${
              status === "waiting" ||
              status === "playing" ||
              status === "finished" ||
              status === "cancelled"
                ? status
                : "loading"
            }`,
          )}
        </span>
      </div>

      {showClock ? (
        <div
          className={`dominoes-clock ${clock.expired ? "is-expired" : ""}`}
          data-testid="dominoes-clock"
        >
          <span
            className="dominoes-clock-value"
            data-testid="dominoes-countdown"
            // `role="timer"` is a live region by default; the seconds must NOT be
            // announced every tick, so the label is read on demand and the
            // visible value stays a plain text node.
            role="timer"
            aria-live="off"
            aria-label={
              clock.expired
                ? t("games.dominoes.clock_aria_expired")
                : t("games.dominoes.clock_aria", { seconds: clock.seconds })
            }
          >
            {clock.expired
              ? t("games.dominoes.time_up")
              : t("games.dominoes.countdown_seconds", { seconds: clock.seconds })}
          </span>
          <span className="dominoes-clock-track" aria-hidden="true">
            <span className="dominoes-clock-fill" style={{ width: `${clockPercent}%` }} />
          </span>
        </div>
      ) : null}

      {reconnecting ? (
        <p className="dominoes-reconnect" role="status" aria-live="polite" data-testid="dominoes-reconnect">
          {t("games.dominoes.reconnecting")}
        </p>
      ) : null}

      {/* ── The shared chain ─────────────────────────────────────────────── */}
      <div className="dominoes-table">
        <DominoChain chain={chain} openEnds={snapshot.openEnds ?? null} isLive={isLive} />

        <div className="dominoes-pile" data-testid="dominoes-pile">
          <span className="dominoes-pile-stack" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
          <span className="dominoes-pile-body">
            <span className="dominoes-pile-title">{t("games.dominoes.draw_pile")}</span>
            <span className="dominoes-pile-count" data-testid="dominoes-pile-count">
              {t(
                drawPileCount === 1
                  ? "games.dominoes.tiles_count_one"
                  : "games.dominoes.tiles_count",
                { count: drawPileCount },
              )}
            </span>
          </span>
        </div>
      </div>

      {/* ── The viewer's hand and the three actions ──────────────────────── */}
      <DominoHand
        hand={hand}
        selected={selected}
        onSelect={onSelect}
        onPlay={onPlay}
        onDraw={onDraw}
        onPass={onPass}
        openEnds={snapshot.openEnds ?? null}
        chainEmpty={chainEmpty}
        drawPileCount={drawPileCount}
        isViewerTurn={isViewerTurn}
        isLive={isLive}
        pending={pending || reconnecting}
      />

      <p
        className={`dominoes-notice ${notice ? "is-visible" : ""}`}
        role="status"
        aria-live="polite"
        data-testid="dominoes-notice"
      >
        {notice ?? ""}
      </p>

      <div className="dominoes-footer">
        {isLive ? (
          <button
            type="button"
            className="dominoes-secondary-button"
            data-testid="dominoes-resign"
            disabled={pending}
            onClick={() => onResign?.()}
          >
            {t("games.dominoes.resign")}
          </button>
        ) : null}

        {/* Rules, in place. A disclosure instead of a modal: a player can read it
            mid-match without dismissing anything. */}
        <details className="dominoes-rules" data-testid="dominoes-rules">
          <summary className="dominoes-rules-summary">
            {t("games.dominoes.rules_summary")}
          </summary>
          <ul className="dominoes-rules-list">
            <li>{t("games.dominoes.board_rule_match")}</li>
            <li>{t("games.dominoes.board_rule_doubles")}</li>
            <li>{t("games.dominoes.board_rule_draw")}</li>
            <li>{t("games.dominoes.board_rule_pass")}</li>
            <li>{t("games.dominoes.board_rule_win")}</li>
            <li>{t("games.dominoes.board_rule_clock")}</li>
          </ul>
        </details>
      </div>
    </div>
  );
}
