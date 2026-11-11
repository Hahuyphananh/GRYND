// src/lib/solitaire-duel/dialogueDirector.ts
//
// Per-match dialogue selection: which detected event may speak, which line it
// gets, and how often.
//
// Pure and instance-scoped. One director belongs to one match (the hook creates
// a fresh one whenever `matchId` changes), so no cooldown, used line or counter
// can leak between matches or users.
//
// Determinism: the line index is an FNV-1a hash of
// `<matchId>:<event>:<occurrence>`, never `Math.random()`. The same match and
// event always resolve to the same first choice; a used key is skipped in a
// deterministic scan rather than re-rolled.
//
// Frequency: the character's Phase 1 personality is a floor/ceiling, not a
// suggestion — `minIntervalMs` can only make a character quieter, and
// `maxLinesPerMatch` can only lower the configured cap.

import { isSolitaireBotId } from "./bots";
import type { SolitaireBotId } from "./bots";
import { DIALOGUE_EVENTS_BY_TYPE } from "./dialogueLines";
import type { DialogueEventType } from "./dialogueLines";
import { SOLITAIRE_BOT_DIALOGUE } from "./dialogueLines";
import { detectDialogueEvents } from "./dialogueEvents";
import type { SolitaireDialogueSnapshot } from "./dialogueEvents";

export type DialogueDirectorConfig = {
  /** Minimum gap between two ordinary lines, across all characters. */
  globalMinIntervalMs: number;
  /** Minimum gap between two lines of the SAME event type. */
  eventCooldownMs: number;
  /** Hard cap on ordinary lines per match (endings are the one exception). */
  maxLinesPerMatch: number;
  /** How long the UI should display an ordinary line. */
  lineDurationMs: number;
  /** Match-ending lines may stay up a little longer. */
  endingDurationMs: number;
};

export const DIALOGUE_DIRECTOR_DEFAULTS: Readonly<DialogueDirectorConfig> =
  Object.freeze({
    globalMinIntervalMs: 9_000,
    eventCooldownMs: 25_000,
    maxLinesPerMatch: 12,
    lineDurationMs: 5_000,
    endingDurationMs: 6_500,
  });

export type SolitaireBotDialogueLine = {
  botId: SolitaireBotId;
  /** `solitaireBots.<botId>.<event>.<index>` — resolved by the UI's `t()`. */
  key: string;
  event: DialogueEventType;
  /** Stable for this exact line in this match. */
  id: string;
  durationMs: number;
};

export type DialogueDirectorState = {
  matchId: string | null;
  totalLines: number;
  lastLineAtMs: number | null;
  lastResetCount: number | null;
  processedEventIds: string[];
  usedKeys: string[];
  occurrences: Partial<Record<DialogueEventType, number>>;
};

/**
 * Priority order for one-snapshot selection. Endings first, then endgame and
 * race swings, then structural progress, then the minor reveal events. Ties are
 * broken by the catalogue order in `dialogueLines.ts`.
 */
const EVENT_PRIORITY: Record<DialogueEventType, number> = {
  win: 100,
  loss: 100,
  aiNearVictory: 85,
  aiLead: 78,
  aiBehind: 74,
  playerLead: 74,
  playerCatchUp: 72,
  closeMatch: 66,
  emptyColumn: 60, // emitted only when the server's AI summary proves it
  significantProgress: 55,
  kingMove: 54, // emitted only when the server's AI summary proves it
  playerImpressive: 52, // not emitted by the client detector yet
  foundation: 45,
  playerFoundation: 45,
  reveal: 30,
  playerReveal: 30,
};

const EVENT_ORDER: Record<DialogueEventType, number> = Object.fromEntries(
  Object.keys(EVENT_PRIORITY).map((type, index) => [type, index]),
) as Record<DialogueEventType, number>;

/** FNV-1a, 32-bit. Exported so selection is testable without a director. */
export function dialogueLineIndex(seed: string, length: number): number {
  if (length <= 0) return 0;
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % length;
}

function num(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isEnding(event: DialogueEventType): boolean {
  return DIALOGUE_EVENTS_BY_TYPE[event]?.category === "match-ending";
}

export type DialogueDirector = {
  observe(
    prev: SolitaireDialogueSnapshot | null,
    next: SolitaireDialogueSnapshot | null,
    options?: { nowMs?: number; paused?: boolean },
  ): SolitaireBotDialogueLine | null;
  reset(): void;
  getState(): DialogueDirectorState;
};

/**
 * THE ENDING LINE FOR A SETTLED PRACTICE RESULT.
 *
 * The director is event-driven, so the last line it selected can be an ordinary
 * one — and a poll that lands after the match settled never sees the ending
 * transition at all. The result popup must not show a silent opponent, so the
 * settled outcome resolves the character's own win/loss line directly, from the
 * same library and with the same deterministic index the director uses. It
 * never invents speech: `win` is the bot's victory, `loss` is the bot's defeat.
 */
export function solitaireResultLine({
  botId,
  matchId,
  botWon,
}: {
  botId: SolitaireBotId;
  matchId: string;
  botWon: boolean;
}): SolitaireBotDialogueLine | null {
  const dialogue = SOLITAIRE_BOT_DIALOGUE[botId];
  if (!dialogue) return null;

  const event: DialogueEventType = botWon ? "win" : "loss";
  const keys = dialogue.lines[event];
  if (!keys || keys.length === 0) return null;

  return {
    botId,
    key: keys[dialogueLineIndex(`${matchId}:${event}:result`, keys.length)],
    event,
    id: `${matchId}:${event}:result`,
    durationMs: DIALOGUE_DIRECTOR_DEFAULTS.endingDurationMs,
  };
}

export function createDialogueDirector(options: {
  config?: Partial<DialogueDirectorConfig>;
} = {}): DialogueDirector {
  const config: DialogueDirectorConfig = {
    ...DIALOGUE_DIRECTOR_DEFAULTS,
    ...(options.config ?? {}),
  };

  let matchId: string | null = null;
  let totalLines = 0;
  let lastLineAtMs: number | null = null;
  let lastResetCount: number | null = null;
  const processed = new Set<string>();
  const usedKeys = new Set<string>();
  const occurrences = new Map<DialogueEventType, number>();
  const lastEventAt = new Map<DialogueEventType, number>();

  function clear(): void {
    totalLines = 0;
    lastLineAtMs = null;
    processed.clear();
    usedKeys.clear();
    occurrences.clear();
    lastEventAt.clear();
  }

  function reset(): void {
    clear();
    lastResetCount = null;
  }

  function observe(
    prev: SolitaireDialogueSnapshot | null,
    next: SolitaireDialogueSnapshot | null,
    observeOptions: { nowMs?: number; paused?: boolean } = {},
  ): SolitaireBotDialogueLine | null {
    if (!next) return null;

    // A different match can never inherit this director's state. (The hook also
    // creates a new director, so this is a second line of defence.) With no
    // comparable previous snapshot this read is the baseline; otherwise the
    // transition itself is still legitimate and is processed below.
    if (matchId !== next.matchId) {
      matchId = next.matchId;
      clear();
      lastResetCount = num(next.view?.resetCount);
      if (!prev || prev.matchId !== next.matchId) return null;
    }

    const nextReset = num(next.view?.resetCount);
    if (lastResetCount === null) {
      lastResetCount = nextReset;
    } else if (nextReset !== lastResetCount) {
      // A re-deal replaces the board under both seats: drop every counter and
      // stay silent for this transition.
      const sameMatch = matchId;
      clear();
      matchId = sameMatch;
      lastResetCount = nextReset;
      return null;
    }

    if (!next.botId || !isSolitaireBotId(next.botId)) return null;
    const dialogue = SOLITAIRE_BOT_DIALOGUE[next.botId];
    if (!dialogue) return null;

    const events = detectDialogueEvents(prev, next, {
      paused: observeOptions.paused,
    });
    if (events.length === 0) return null;

    // A repeated observation of the same transition must not reconsider its
    // events. Mark every fresh event processed, including ones this character
    // cannot use, so the set also records what was seen.
    const freshEvents = events.filter((event) => !processed.has(event.id));
    if (freshEvents.length === 0) return null;
    for (const event of freshEvents) processed.add(event.id);

    const now = num(observeOptions.nowMs ?? next.serverNow);
    const effectiveMinInterval = Math.max(
      config.globalMinIntervalMs,
      dialogue.minIntervalMs,
    );
    const effectiveMaxLines = Math.min(
      config.maxLinesPerMatch,
      dialogue.maxLinesPerMatch,
    );

    const candidates = freshEvents
      .filter((event) => dialogue.supportedEvents.includes(event.type))
      .sort(
        (a, b) =>
          EVENT_PRIORITY[b.type] - EVENT_PRIORITY[a.type] ||
          EVENT_ORDER[a.type] - EVENT_ORDER[b.type] ||
          a.id.localeCompare(b.id),
      );

    for (const candidate of candidates) {
      const event = candidate.type;
      const keys = dialogue.lines[event];
      if (!keys || keys.length === 0) continue;

      const ending = isEnding(event);
      if (!ending && totalLines >= effectiveMaxLines) continue;
      if (
        !ending &&
        lastLineAtMs != null &&
        now - lastLineAtMs < effectiveMinInterval
      ) {
        continue;
      }
      if (!ending) {
        const previousAt = lastEventAt.get(event);
        if (previousAt != null && now - previousAt < config.eventCooldownMs) {
          continue;
        }
      }

      const occurrence = (occurrences.get(event) ?? 0) + 1;
      const seed = `${next.matchId}:${event}:${occurrence}`;
      let key: string | null = null;
      const start = dialogueLineIndex(seed, keys.length);
      for (let offset = 0; offset < keys.length; offset += 1) {
        const candidateKey = keys[(start + offset) % keys.length];
        if (!usedKeys.has(candidateKey)) {
          key = candidateKey;
          break;
        }
      }
      // Every variation already used in this match: silence beats repetition.
      if (!key) continue;

      usedKeys.add(key);
      occurrences.set(event, occurrence);
      lastEventAt.set(event, now);
      lastLineAtMs = now;
      totalLines += 1;

      return {
        botId: next.botId,
        key,
        event,
        id: `${next.matchId}:${event}:${occurrence}`,
        durationMs: ending ? config.endingDurationMs : config.lineDurationMs,
      };
    }

    return null;
  }

  function getState(): DialogueDirectorState {
    return {
      matchId,
      totalLines,
      lastLineAtMs,
      lastResetCount,
      processedEventIds: [...processed],
      usedKeys: [...usedKeys],
      occurrences: Object.fromEntries(occurrences) as Partial<
        Record<DialogueEventType, number>
      >,
    };
  }

  return { observe, reset, getState };
}
