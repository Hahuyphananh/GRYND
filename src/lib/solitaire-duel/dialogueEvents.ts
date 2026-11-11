// src/lib/solitaire-duel/dialogueEvents.ts
//
// Turns two ADOPTED, authoritative match snapshots into dialogue events.
//
// WHAT THIS MAY READ: only the counts the server already projects to a client —
// the viewer's own `progress`, the opponent's `OpponentProgress`, `status`,
// `result`, `seat`, `goAtMs`, `serverNow`, and the viewer's own `ply` /
// `resetCount`. It never reads a tableau, a stock order, a waste pile, a card
// identity or any other server-only field, because `SolitaireDialogueSnapshot`
// does not carry them and the stores never send them.
//
// WHAT IT DELIBERATELY DOES NOT EMIT:
//   * `playerImpressive` — there is no reliable, cheap in-match evaluator. The
//     library contains copy for it, but this detector must never invent the
//     event. Ordinary legal moves are not evidence of skill.
//
// Simultaneous race, not turn-based: the bot advances on server reads, so its
// counts can move while the viewer's `ply` stands still. AI events are therefore
// keyed to the snapshot instant, never to the viewer's move cursor.

import type { OpponentProgress, SeatProgress, SolitaireView } from "./types";
import type { SolitaireBotId } from "./bots";
import type { DialogueEventType } from "./dialogueLines";
import type { AiDialogueEventSummary } from "./aiDialogueEvents";

/** The presentation-safe slice of a match this module is allowed to see. */
export type SolitaireDialogueSnapshot = {
  matchId: string;
  /** The stable bot id for a practice match; null in a human duel. */
  botId: SolitaireBotId | null;
  status: string;
  result: string | null;
  seat: "player1" | "player2" | null;
  progress: SeatProgress | null;
  opponent: OpponentProgress | null;
  view: Pick<SolitaireView, "ply" | "resetCount"> | null;
  goAtMs: number | null;
  serverNow: number;
  /**
   * The server's count-only summary of the bot's latest planner batch, when the
   * read that produced this snapshot advanced the bot. Absent on older payloads
   * and on every human duel; detection degrades to the progress counts.
   */
  aiEvents?: AiDialogueEventSummary | null;
};

export type DetectedDialogueEvent = {
  /** Stable for the same transition, so a repeated read cannot re-fire it. */
  id: string;
  type: DialogueEventType;
};

/** Foundation milestones that count as "significant" AI progress. */
export const DIALOGUE_SIGNIFICANT_MILESTONES = Object.freeze([
  13, 26, 39,
] as const);

/** AI foundations at or above this are the endgame. */
export const DIALOGUE_NEAR_VICTORY_FOUNDATIONS = 40;

/** Both seats need this many foundation cards before "close" can fire. */
export const DIALOGUE_CLOSE_RACE_FLOOR = 8;

/** Foundation difference that still counts as "close" (level or one card). */
export const DIALOGUE_CLOSE_RACE_MARGIN = 1;

/**
 * A seat is only announced as TAKING the lead at this foundation margin.
 *
 * Hysteresis: a one-card edge is deliberately still "level" for dialogue, so a
 * card moving back and forth around the boundary cannot alternate lead/behind
 * lines on consecutive polls. A seat already ahead by one is not re-announced
 * when it reaches two; only a crossing that starts level-or-behind and lands at
 * a decisive lead speaks.
 */
export const DIALOGUE_LEAD_HYSTERESIS = 2;

const TERMINAL = new Set(["finished", "cancelled"]);
const DRAW = "draw";

function num(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isRacing(
  snapshot: SolitaireDialogueSnapshot,
  paused: boolean,
): boolean {
  if (paused) return false;
  if (snapshot.status !== "playing") return false;
  if (snapshot.goAtMs != null && num(snapshot.serverNow) < num(snapshot.goAtMs)) {
    return false;
  }
  return true;
}

function isCloseRace(own: SeatProgress, opponent: OpponentProgress): boolean {
  const ownFoundation = num(own.foundationCards);
  const aiFoundation = num(opponent.foundationCards);
  if (ownFoundation < DIALOGUE_CLOSE_RACE_FLOOR) return false;
  if (aiFoundation < DIALOGUE_CLOSE_RACE_FLOOR) return false;
  if (opponent.completed) return false;
  return (
    Math.abs(ownFoundation - aiFoundation) <= DIALOGUE_CLOSE_RACE_MARGIN
  );
}

/**
 * Derive the events that happened between two adopted snapshots.
 *
 * Returns an empty array for: a first snapshot, a stale snapshot, a re-deal,
 * a paused/countdown match, a repeated snapshot, and any transition that starts
 * before the viewer's own board is revealed.
 */
export function detectDialogueEvents(
  prev: SolitaireDialogueSnapshot | null,
  next: SolitaireDialogueSnapshot | null,
  options: { paused?: boolean } = {},
): DetectedDialogueEvent[] {
  if (!prev || !next) return [];
  if (prev.matchId !== next.matchId) return [];

  const prevReset = num(prev.view?.resetCount);
  const nextReset = num(next.view?.resetCount);
  // A lower reset is an older read; a higher one is a mid-match re-deal. Both
  // suppress ordinary dialogue (the director also clears its state on a reset).
  if (nextReset !== prevReset) return [];

  // Stale read: the viewer's own move cursor never moves backwards.
  if (prev.view && next.view && num(next.view.ply) < num(prev.view.ply)) {
    return [];
  }

  const events: DetectedDialogueEvent[] = [];
  const push = (type: DialogueEventType, suffix: string) => {
    events.push({ id: `${next.matchId}:${type}:${suffix}`, type });
  };

  const prevTerminal = TERMINAL.has(prev.status);
  const nextTerminal = TERMINAL.has(next.status);

  if (nextTerminal) {
    if (prevTerminal) return [];
    if (!next.result || !next.seat) return [];
    // `result` names the winning seat. Anything else (including a draw, an
    // unusual resolution code or a forfeit without a result) is not an AI
    // victory and must not claim one.
    if (next.result === next.seat) push("loss", "end");
    else if (next.result !== DRAW) push("win", "end");
    return events;
  }

  // Coming back from terminal, or a match that never started racing, is silent.
  if (prevTerminal) return [];
  if (!isRacing(prev, Boolean(options.paused))) return [];
  if (!isRacing(next, Boolean(options.paused))) return [];

  if (!prev.progress || !prev.opponent) return [];
  if (!next.progress || !next.opponent) return [];

  const own = next.progress;
  const ai = next.opponent;
  const prevOwn = prev.progress;
  const prevAi = prev.opponent;

  // One stamp per observed transition. A repeated read has the same stamp, so
  // its ids match and the director's processed-set suppresses it.
  const stamp = `${num(next.serverNow)}:${num(next.view?.ply)}`;

  const aiFoundationBefore = num(prevAi.foundationCards);
  const aiFoundationAfter = num(ai.foundationCards);
  const ownFoundationBefore = num(prevOwn.foundationCards);
  const ownFoundationAfter = num(own.foundationCards);

  // ── AI progress ────────────────────────────────────────────────────────
  // Counts, not moves: several bot moves may have landed in one read. Emit at
  // most one event of each kind per transition.
  if (
    num(ai.revealedTableau) > num(prevAi.revealedTableau) &&
    !ai.completed
  ) {
    push("reveal", stamp);
  }
  if (aiFoundationAfter > aiFoundationBefore && !ai.completed) {
    push("foundation", stamp);
  }
  if (!ai.completed) {
    for (const milestone of DIALOGUE_SIGNIFICANT_MILESTONES) {
      if (aiFoundationBefore < milestone && aiFoundationAfter >= milestone) {
        push("significantProgress", String(milestone));
      }
    }
    if (
      aiFoundationBefore < DIALOGUE_NEAR_VICTORY_FOUNDATIONS &&
      aiFoundationAfter >= DIALOGUE_NEAR_VICTORY_FOUNDATIONS
    ) {
      push("aiNearVictory", String(DIALOGUE_NEAR_VICTORY_FOUNDATIONS));
    }
  }

  // ── Server-derived structural events ──────────────────────────────────
  // Only present when the read that produced this snapshot actually advanced
  // the bot. The summary carries counts and booleans, never a board. Its
  // foundation/suit data is already implied by the count deltas above, so only
  // the structural events that counts cannot see are consumed here.
  const structural = next.aiEvents;
  if (structural && !ai.completed) {
    if (structural.emptyColumnsOpened > 0) {
      push("emptyColumn", `${stamp}:column`);
    }
    if (structural.kingToEmptyColumn) {
      push("kingMove", `${stamp}:king`);
    }
  }

  // ── Race comparison (with hysteresis) ─────────────────────────────────
  // Foundation cards are the primary race measure; a decisive lead means two
  // cards. The transitions below are deliberately asymmetric so the same
  // advantage is announced once, not every time it hovers over the boundary.
  const marginBefore = ownFoundationBefore - aiFoundationBefore;
  const marginAfter = ownFoundationAfter - aiFoundationAfter;
  if (
    marginBefore >= 0 &&
    marginAfter <= -DIALOGUE_LEAD_HYSTERESIS
  ) {
    push("aiLead", stamp);
  }
  if (
    marginBefore <= 0 &&
    marginAfter >= DIALOGUE_LEAD_HYSTERESIS
  ) {
    // The same flip seen from each side. Both are real; the director picks one
    // according to the character's supported events and priorities.
    push("aiBehind", stamp);
    push("playerLead", stamp);
  }
  if (!isCloseRace(prevOwn, prevAi) && isCloseRace(own, ai)) {
    push("closeMatch", stamp);
  }

  // ── Player performance ─────────────────────────────────────────────────
  if (num(own.revealedTableau) > num(prevOwn.revealedTableau)) {
    push("playerReveal", stamp);
  }
  if (ownFoundationAfter > ownFoundationBefore) {
    push("playerFoundation", stamp);
  }
  // Caught up = from a decisive deficit to level-or-one-card-behind. Crossing
  // all the way to a decisive lead is a playerLead, not a catch-up.
  if (
    marginBefore <= -DIALOGUE_LEAD_HYSTERESIS &&
    marginAfter >= -1 &&
    marginAfter <= DIALOGUE_CLOSE_RACE_MARGIN
  ) {
    push("playerCatchUp", stamp);
  }

  return events;
}
