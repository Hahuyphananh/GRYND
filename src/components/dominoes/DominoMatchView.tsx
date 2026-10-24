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
// ── WHAT IS ON SCREEN, AND WHERE ──────────────────────────────────────────
//
// The table is a two-column layout: the BOARD (left) and the ACTIONS (right).
//
//   board      opponent seat (name/avatar + TILE COUNT only), the turn banner
//              and the 15-second window, the shared chain and its two open
//              values, the draw pile, and — underneath the table, where a
//              player's own tiles belong — the viewer's hand.
//   sidebar    the open ends, the selected tile, and the three actions (play on
//              an end, draw, pass), plus resign and the rules. It is pinned in
//              its own column so the controls never move as the chain grows or
//              the hand shrinks; on a narrow screen it stacks under the board.
//
// The opponent's tiles are not in the payload at all, so there is nothing here
// that could render them; the count is public (in dominoes you can see how many
// tiles a player holds).
//
// ── STATES ────────────────────────────────────────────────────────────────
//
// waiting / reconnecting / your-turn / their-turn / drawing / passing / selected /
// disabled / victory / defeat / draw. The terminal ones are the page's result
// screen; here the board simply stops offering controls (`data-live="false"`)
// and keeps the final position on screen.
//
// A DROPPED LIVE LINK DOES NOT DISABLE THE BOARD. Every read and every action
// goes over HTTP and the socket only says "something changed, re-read" (see the
// match page), so losing it costs freshness, never the ability to play: the
// notice appears and the controls stay live.

import { useId } from "react";

import DominoActions from "./DominoActions";
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
  /** True for a free practice match: the opponent seat is the bot. */
  isAi?: boolean;
  aiDifficulty?: string | null;
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
  /** The socket is down: live updates pause, the board and its controls do not. */
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
  // A bot seat has no identity (no `users` row), so it is named by the match's
  // own `isAi` flag rather than by a missing name.
  const opponentIsAi = Boolean(snapshot.isAi);
  const opponentName = opponentIsAi
    ? t("games.dominoes.ai_opponent")
    : opponentIdentity?.name || (opponentSeat ? seatLabel(opponentSeat, viewerSeat) : "Opponent");

  const chain = Array.isArray(snapshot.chain) ? snapshot.chain : [];
  const chainEmpty = chain.length === 0;
  const hand = Array.isArray(snapshot.hand) ? snapshot.hand : [];
  const opponentTileCount = Number(snapshot.opponentTileCount ?? 0) || 0;
  const drawPileCount = Number(snapshot.drawPileCount ?? 0) || 0;
  const openEnds = snapshot.openEnds ?? null;

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

      <div className="dominoes-layout">
        {/* ══ THE BOARD ══════════════════════════════════════════════════ */}
        <div className="dominoes-main">
          {/* ── Opponent seat: a name, an avatar, and a COUNT ────────────── */}
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
                isAi={opponentIsAi}
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

          {/* ── Turn banner + clock ──────────────────────────────────────── */}
          <div className="dominoes-banner">
            <p
              className="dominoes-status"
              role="status"
              aria-live="polite"
              data-testid="dominoes-status"
            >
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
            <p
              className="dominoes-reconnect"
              role="status"
              aria-live="polite"
              data-testid="dominoes-reconnect"
            >
              {t("games.dominoes.reconnecting")}
            </p>
          ) : null}

          {/* ── The shared chain, which grows like a real table ──────────── */}
          <div className="dominoes-table">
            <DominoChain chain={chain} openEnds={openEnds} isLive={isLive} />

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

          {/* ── The viewer's own tiles, UNDER the table ──────────────────── */}
          <DominoHand
            hand={hand}
            selected={selected}
            onSelect={onSelect}
            openEnds={openEnds}
            chainEmpty={chainEmpty}
            isViewerTurn={isViewerTurn}
            isLive={isLive}
            pending={pending}
          />
        </div>

        {/* ══ THE ACTIONS — a sidebar on the right ═══════════════════════ */}
        <aside className="dominoes-sidebar">
          <DominoActions
            hand={hand}
            selected={selected}
            onPlay={onPlay}
            onDraw={onDraw}
            onPass={onPass}
            openEnds={openEnds}
            chainEmpty={chainEmpty}
            drawPileCount={drawPileCount}
            isViewerTurn={isViewerTurn}
            isLive={isLive}
            pending={pending}
          />

          <p
            className={`dominoes-notice ${notice ? "is-visible" : ""}`}
            role="status"
            aria-live="polite"
            data-testid="dominoes-notice"
          >
            {notice ?? ""}
          </p>

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

          {/* Rules, in place. A disclosure instead of a modal: a player can read
              it mid-match without dismissing anything. */}
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
        </aside>
      </div>
    </div>
  );
}
