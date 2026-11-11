// src/lib/solitaire-duel/dialogueLines.ts
//
// The dialogue LIBRARY for the six Solitaire opponents: the closed event
// catalogue, what each event is allowed to claim, which opponents react to
// which events, and the translation keys for every line.
//
// CONTENT ONLY. This module intentionally imports nothing from the AI engine
// (`./ai`), the rules engine (`./rules`) or the server store. Event detection,
// cooldowns, selection and rendering belong to later phases.
//
// The sentences themselves are NOT here. They live in
// `src/lib/appTextTranslations.js` under
// `solitaireBots.<botId>.<event>.<index>` (en / fr / es) and are resolved with
// `useTranslation()` → `t(...)`. This module only owns the keys.

import { SOLITAIRE_BOTS } from "./bots";
import type { SolitaireBotId } from "./bots";
import { SOLITAIRE_BOT_PERSONALITIES } from "./botPersonalities";
import type { DialogueFrequency } from "./botPersonalities";

export type DialogueEventCategory =
  | "ai-progress"
  | "player-performance"
  | "match-situation"
  | "match-ending";

/**
 * The closed set of events an opponent may speak about.
 *
 * Every event is derived from authoritative match state. Nothing here reacts
 * to an ordinary card move, a stock draw or routine tableau shuffling.
 */
export type DialogueEventType =
  // AI progress
  | "reveal"
  | "foundation"
  | "emptyColumn"
  | "kingMove"
  | "significantProgress"
  // Player performance
  | "playerReveal"
  | "playerFoundation"
  | "playerLead"
  | "playerCatchUp"
  | "playerImpressive"
  // Match situation
  | "aiLead"
  | "aiBehind"
  | "closeMatch"
  | "aiNearVictory"
  // Match ending
  | "win"
  | "loss";

export type DialogueEventDefinition = {
  type: DialogueEventType;
  category: DialogueEventCategory;
  /** Human-readable name for docs and test failures. */
  label: string;
  /**
   * The ONLY situation in which a line for this event may be shown.
   *
   * A detector in a later phase must establish this from authoritative state
   * before the event is emitted; a line may never create the event.
   */
  requires: string;
  /** Claims a line for this event must never make. */
  mustNotClaim: string;
};

export const DIALOGUE_EVENTS: readonly DialogueEventDefinition[] = Object.freeze(
  [
    {
      type: "reveal",
      category: "ai-progress",
      label: "AI reveals a face-down card",
      requires:
        "The AI's own seat actually turned at least one face-down tableau card face up.",
      mustNotClaim:
        "Which card was underneath, how many cards were hidden, or that the reveal was planned.",
    },
    {
      type: "foundation",
      category: "ai-progress",
      label: "AI makes foundation progress",
      requires:
        "The AI's total foundation card count increased during the observed step.",
      mustNotClaim:
        "A specific suit or rank unless the authoritative event carries it, or that a foundation is complete when it is not.",
    },
    {
      type: "emptyColumn",
      category: "ai-progress",
      label: "AI opens an empty tableau column",
      requires:
        "A tableau column belonging to the AI became empty as a result of the AI's move.",
      mustNotClaim:
        "That the empty column will be used for a King, or that it guarantees a win.",
    },
    {
      type: "kingMove",
      category: "ai-progress",
      label: "AI places a King in an empty column",
      requires:
        "The AI moved a King into a tableau column that was empty immediately before the move.",
      mustNotClaim:
        "That the move was forced, optimal, or the only legal option.",
    },
    {
      type: "significantProgress",
      category: "ai-progress",
      label: "AI reaches a meaningful progress milestone",
      requires:
        "The AI's authoritative foundation progress crossed a documented milestone (for example half the deck).",
      mustNotClaim:
        "That the match is won, or a milestone the progress value has not reached.",
    },
    {
      type: "playerReveal",
      category: "player-performance",
      label: "Player reveals a hidden card",
      requires:
        "The player's own seat actually turned at least one face-down tableau card face up.",
      mustNotClaim:
        "What the card was if it is not visible in the player's own view, or that the reveal was lucky.",
    },
    {
      type: "playerFoundation",
      category: "player-performance",
      label: "Player makes foundation progress",
      requires:
        "The player's own foundation card count increased during the observed step.",
      mustNotClaim:
        "A suit or rank the observer cannot see, or that the player has completed the game.",
    },
    {
      type: "playerLead",
      category: "player-performance",
      label: "Player takes the lead",
      requires:
        "The authoritative race comparison changed from the AI ahead or level to the player ahead.",
      mustNotClaim:
        "A lead the comparison does not show, or that the lead is permanent.",
    },
    {
      type: "playerCatchUp",
      category: "player-performance",
      label: "Player catches up with the AI",
      requires:
        "The authoritative race comparison changed from the AI ahead to level.",
      mustNotClaim:
        "That the player is now ahead, or that the AI has stopped progressing.",
    },
    {
      type: "playerImpressive",
      category: "player-performance",
      label: "Player makes an objectively impressive move",
      requires:
        "A reliable event source identified the player's move as strong. Until such a source exists, this event must not fire.",
      mustNotClaim:
        "A strategic intention the player did not state, hidden information, or a rating the system did not compute.",
    },
    {
      type: "aiLead",
      category: "match-situation",
      label: "AI takes the lead",
      requires:
        "The authoritative race comparison changed from the player ahead or level to the AI ahead.",
      mustNotClaim:
        "That the match is over, or a margin larger than the comparison reports.",
    },
    {
      type: "aiBehind",
      category: "match-situation",
      label: "AI falls behind",
      requires:
        "The authoritative race comparison changed from the AI ahead or level to the player ahead.",
      mustNotClaim:
        "That the AI is losing the match (the race is not settled), or resentment toward the player.",
    },
    {
      type: "closeMatch",
      category: "match-situation",
      label: "The race becomes particularly close",
      requires:
        "Both seats are past the documented progress floor and the authoritative comparison is level or within one foundation card.",
      mustNotClaim:
        "That the next move decides the match, or a score difference that is not reported.",
    },
    {
      type: "aiNearVictory",
      category: "match-situation",
      label: "AI reaches a meaningful endgame milestone",
      requires:
        "The AI's authoritative foundation count reached the documented endgame threshold, with the match still live.",
      mustNotClaim:
        "That the AI has already won, or the identity of its remaining cards.",
    },
    {
      type: "win",
      category: "match-ending",
      label: "AI wins",
      requires:
        "The match has ended and the authoritative result records the AI seat as the winner.",
      mustNotClaim:
        "A reward, rating change, trophy or prize the system has not awarded.",
    },
    {
      type: "loss",
      category: "match-ending",
      label: "AI loses",
      requires:
        "The match has ended and the authoritative result records the player seat as the winner.",
      mustNotClaim:
        "A rematch that has not been created, a rating change, or that the result is invalid.",
    },
  ],
);

export const DIALOGUE_EVENTS_BY_TYPE: Readonly<
  Record<DialogueEventType, DialogueEventDefinition>
> = Object.freeze(
  Object.fromEntries(DIALOGUE_EVENTS.map((event) => [event.type, event])) as Record<
    DialogueEventType,
    DialogueEventDefinition
  >,
);

export const DIALOGUE_EVENT_TYPES: readonly DialogueEventType[] = Object.freeze(
  DIALOGUE_EVENTS.map((event) => event.type),
);

export const DIALOGUE_EVENT_CATEGORIES: readonly DialogueEventCategory[] =
  Object.freeze([
    "ai-progress",
    "player-performance",
    "match-situation",
    "match-ending",
  ]);

/** Writing bounds for one character/event combination. */
export const DIALOGUE_VARIATIONS_MIN = 6;
export const DIALOGUE_VARIATIONS_MAX = 8;

/**
 * Variations written per supported combination. Kept at the documented minimum
 * so the library stays reviewable; a later phase may raise it up to the max
 * without changing any consumer.
 */
export const DIALOGUE_VARIATIONS_PER_EVENT = 6;

/**
 * The one canonical translation key for a line.
 *
 * `solitaireBots.<botId>.<event>.<index>` — en / fr / es all use this shape.
 */
export function solitaireBotDialogueKey(
  botId: SolitaireBotId,
  event: DialogueEventType,
  index: number,
): string {
  return `solitaireBots.${botId}.${event}.${index}`;
}

export type SolitaireBotDialogue = {
  id: SolitaireBotId;
  characterName: string;
  frequency: DialogueFrequency;
  maxLinesPerMatch: number;
  minIntervalMs: number;
  /** Events this character reacts to, in catalogue order. */
  supportedEvents: readonly DialogueEventType[];
  /**
   * Event → ordered translation keys. Only supported events are present.
   * Index order is the authored order; selection is a later phase.
   */
  lines: Readonly<
    Partial<Record<DialogueEventType, readonly string[]>>
  >;
};

function buildDialogue(botId: SolitaireBotId): SolitaireBotDialogue {
  const personality = SOLITAIRE_BOT_PERSONALITIES[botId];
  const lines: Partial<Record<DialogueEventType, string[]>> = {};

  // Catalogue order, not personality-array order, so every consumer sees the
  // same event ordering.
  for (const event of DIALOGUE_EVENT_TYPES) {
    if (!personality.supportedEvents.includes(event)) continue;
    lines[event] = Array.from(
      { length: DIALOGUE_VARIATIONS_PER_EVENT },
      (_, index) => solitaireBotDialogueKey(botId, event, index),
    );
  }

  return Object.freeze({
    id: botId,
    characterName: personality.characterName,
    frequency: personality.frequency,
    maxLinesPerMatch: personality.maxLinesPerMatch,
    minIntervalMs: personality.minIntervalMs,
    supportedEvents: Object.freeze([...personality.supportedEvents]),
    lines: Object.freeze(lines),
  });
}

export const SOLITAIRE_BOT_DIALOGUE: Readonly<
  Record<SolitaireBotId, SolitaireBotDialogue>
> = Object.freeze(
  Object.fromEntries(
    SOLITAIRE_BOTS.map((bot) => [bot.id, buildDialogue(bot.id)]),
  ) as Record<SolitaireBotId, SolitaireBotDialogue>,
);

/** Roster order (weakest → final boss). */
export const SOLITAIRE_BOT_DIALOGUE_LIST: readonly SolitaireBotDialogue[] =
  Object.freeze(SOLITAIRE_BOTS.map((bot) => SOLITAIRE_BOT_DIALOGUE[bot.id]));

/** Every key the library can ask for, in roster → event → index order. */
export const ALL_SOLITAIRE_DIALOGUE_KEYS: readonly string[] = Object.freeze(
  SOLITAIRE_BOT_DIALOGUE_LIST.flatMap((bot) =>
    bot.supportedEvents.flatMap((event) => [...(bot.lines[event] ?? [])]),
  ),
);

export function solitaireBotDialogue(
  botId: SolitaireBotId,
): SolitaireBotDialogue {
  return SOLITAIRE_BOT_DIALOGUE[botId];
}

export function solitaireBotSupportsDialogueEvent(
  botId: SolitaireBotId,
  event: DialogueEventType,
): boolean {
  return solitaireBotDialogue(botId).supportedEvents.includes(event);
}
