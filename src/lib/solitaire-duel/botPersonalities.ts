// src/lib/solitaire-duel/botPersonalities.ts
//
// WHO each Solitaire opponent is when it speaks.
//
// This is CONTENT METADATA ONLY. It is a separate map keyed by the existing
// `SolitaireBotId`s so the shipped roster in `bots.ts` — including every AI
// weighting, pacing value and public label — stays untouched. Nothing here is
// read by the decision engine, the rules engine or the server store; later
// phases may read it when deciding whether an opponent reacts to an event.
//
// IDENTITY NOTE: the sixth opponent keeps its stable internal id `perfect`
// (stored in `solitaire_duel_matches.ai_difficulty`) and its shipped roster
// name "Perfect". For dialogue the character is **Glitch** — `characterName`
// carries that name while `rosterName` mirrors `bots.ts`. Bot dialogue is
// never the floating GRYND mascot speaking (`speaksAsAppMascot: false` for
// every character), and its copy lives under its own translation namespace.

import type { SolitaireBotId } from "./bots";
import type { DialogueEventType } from "./dialogueLines";

/**
 * How often a character is willing to speak during one match.
 *
 * Later phases enforce these numbers; they are declared here so frequency is a
 * property of the character rather than of the renderer.
 */
export type DialogueFrequency = "frequent" | "steady" | "measured" | "rare";

export type SolitaireBotPersonality = {
  id: SolitaireBotId;
  /** The name this character speaks under. Glitch for the sixth opponent. */
  characterName: string;
  /** The name shipped by `bots.ts` today; kept in sync, never rewritten here. */
  rosterName: string;
  /** One paragraph a writer can read before adding lines. */
  description: string;
  /** Adjectival tone cues, in priority order. */
  tone: readonly string[];
  /** Vocabulary and sentence-shape guidance. */
  vocabulary: readonly string[];
  frequency: DialogueFrequency;
  /** Soft ceiling for one match. */
  maxLinesPerMatch: number;
  /** Minimum gap between two lines of this character (ms). */
  minIntervalMs: number;
  /** The only events this character is allowed to react to. */
  supportedEvents: readonly DialogueEventType[];
  /** Failure modes a line for this character must avoid. */
  avoids: readonly string[];
  /**
   * Always false: bot dialogue is the opponent speaking, not the app mascot.
   * Glitch's avatar is reused artwork, not the mascot's voice.
   */
  speaksAsAppMascot: boolean;
};

export const SOLITAIRE_BOT_PERSONALITIES: Readonly<
  Record<SolitaireBotId, SolitaireBotPersonality>
> = Object.freeze({
  rookie: {
    id: "rookie",
    characterName: "Rookie",
    rosterName: "Rookie",
    description:
      "An enthusiastic beginner who is still learning the shape of a Solitaire deal. Genuinely delighted by small progress, a little nervous when the race slips away, and never superior about anything.",
    tone: ["warm", "eager", "self-deprecating"],
    vocabulary: [
      "plain, everyday words",
      "short exclamations",
      "present tense",
      "questions asked in good faith",
    ],
    frequency: "frequent",
    maxLinesPerMatch: 12,
    minIntervalMs: 9_000,
    supportedEvents: [
      "reveal",
      "foundation",
      "emptyColumn",
      "kingMove",
      "significantProgress",
      "playerReveal",
      "playerFoundation",
      "playerLead",
      "playerCatchUp",
      "playerImpressive",
      "aiLead",
      "aiBehind",
      "closeMatch",
      "aiNearVictory",
      "win",
      "loss",
    ],
    avoids: [
      "arrogance",
      "intimidation",
      "mockery of the player",
      "pretending to understand a move it does not",
    ],
    speaksAsAppMascot: false,
  },
  felix: {
    id: "felix",
    characterName: "Felix",
    rosterName: "Felix",
    description:
      "A confident, playfully cocky competitor. Enjoys needling the player and taking credit for ordinary progress, but the teasing stays affectionate and never turns hostile.",
    tone: ["confident", "teasing", "competitive"],
    vocabulary: [
      "short, dry remarks",
      "mild sarcasm",
      "one-up phrasing",
      "no cruelty or threats",
    ],
    frequency: "steady",
    maxLinesPerMatch: 10,
    minIntervalMs: 12_000,
    supportedEvents: [
      "reveal",
      "foundation",
      "emptyColumn",
      "playerReveal",
      "playerFoundation",
      "playerLead",
      "playerCatchUp",
      "playerImpressive",
      "aiLead",
      "aiBehind",
      "closeMatch",
      "win",
      "loss",
    ],
    avoids: [
      "genuine hostility",
      "slurs or personal insults",
      "threats",
      "sulking after a loss",
    ],
    speaksAsAppMascot: false,
  },
  ace: {
    id: "ace",
    characterName: "Ace",
    rosterName: "Ace",
    description:
      "A naturally gifted, charismatic player who makes difficult sequences look routine. Relaxed rather than boastful, quick to acknowledge a genuinely good move from the player.",
    tone: ["relaxed", "charismatic", "assured"],
    vocabulary: [
      "clean, unforced phrasing",
      "understatement",
      "table-talk rhythm",
      "specific praise, never flattery",
    ],
    frequency: "steady",
    maxLinesPerMatch: 9,
    minIntervalMs: 14_000,
    supportedEvents: [
      "foundation",
      "emptyColumn",
      "significantProgress",
      "playerFoundation",
      "playerImpressive",
      "playerLead",
      "aiLead",
      "closeMatch",
      "win",
      "loss",
    ],
    avoids: [
      "constant bragging",
      "desperation",
      "over-explaining the board",
      "belittling the player",
    ],
    speaksAsAppMascot: false,
  },
  professor: {
    id: "professor",
    characterName: "Professor",
    rosterName: "Professor",
    description:
      "An analytical, methodical opponent who narrates the position in precise language. Calm under pressure, interested in structure and possibility, and never verbose for its own sake.",
    tone: ["intellectual", "calm", "precise"],
    vocabulary: [
      "measured, complete sentences",
      "positional vocabulary",
      "qualifiers such as 'efficient' and 'sound'",
      "no slang",
    ],
    frequency: "measured",
    maxLinesPerMatch: 8,
    minIntervalMs: 16_000,
    supportedEvents: [
      "reveal",
      "foundation",
      "kingMove",
      "significantProgress",
      "playerFoundation",
      "playerImpressive",
      "playerLead",
      "aiLead",
      "aiBehind",
      "win",
      "loss",
    ],
    avoids: [
      "rambling lectures",
      "condescension",
      "vague praise",
      "claiming knowledge of hidden cards",
    ],
    speaksAsAppMascot: false,
  },
  grandmaster: {
    id: "grandmaster",
    characterName: "Grandmaster",
    rosterName: "Grandmaster",
    description:
      "A disciplined, experienced competitor who speaks only when it matters. Calm, authoritative and quietly intimidating; respects skill and consistency, and never sounds nervous or childish.",
    tone: ["composed", "authoritative", "economical"],
    vocabulary: [
      "very short sentences",
      "no filler",
      "commands and observations",
      "no exclamation marks",
    ],
    frequency: "measured",
    maxLinesPerMatch: 6,
    minIntervalMs: 22_000,
    supportedEvents: [
      "foundation",
      "emptyColumn",
      "significantProgress",
      "playerImpressive",
      "aiLead",
      "closeMatch",
      "win",
      "loss",
    ],
    avoids: [
      "nervousness",
      "childish exclamations",
      "small talk",
      "explaining the obvious",
    ],
    speaksAsAppMascot: false,
  },
  perfect: {
    id: "perfect",
    characterName: "Glitch",
    rosterName: "Perfect",
    description:
      "The final boss. Cold, cryptic and ruthless, treating the match as an experiment it has already modelled. Speaks rarely, in short declarative lines, with occasional digital or system-fault imagery; never warm, never jokes, never pleads.",
    tone: ["cold", "cryptic", "ruthless"],
    vocabulary: [
      "short declarative statements",
      "experiment and system language",
      "occasional ERROR / calibration phrasing",
      "no contractions that soften the voice",
    ],
    frequency: "rare",
    maxLinesPerMatch: 4,
    minIntervalMs: 30_000,
    supportedEvents: [
      "significantProgress",
      "playerImpressive",
      "aiLead",
      "aiNearVictory",
      "win",
      "loss",
    ],
    avoids: [
      "warmth or encouragement",
      "jokes and banter",
      "slang",
      "pleading or panic",
      "explaining its own strategy in detail",
      "speaking as the GRYND app mascot",
    ],
    speaksAsAppMascot: false,
  },
});

/** Roster order (weakest → final boss), mirroring `SOLITAIRE_BOTS`. */
export const SOLITAIRE_BOT_PERSONALITY_ORDER: readonly SolitaireBotId[] =
  Object.freeze([
    "rookie",
    "felix",
    "ace",
    "professor",
    "grandmaster",
    "perfect",
  ]);

export const SOLITAIRE_BOT_PERSONALITY_LIST: readonly SolitaireBotPersonality[] =
  Object.freeze(
    SOLITAIRE_BOT_PERSONALITY_ORDER.map(
      (id) => SOLITAIRE_BOT_PERSONALITIES[id],
    ),
  );

/** True for a bot id that has a personality definition. */
export function isSolitaireBotPersonalityId(
  value: unknown,
): value is SolitaireBotId {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(SOLITAIRE_BOT_PERSONALITIES, value)
  );
}

/** Look up a personality. Throws only for an unknown id (a programming error). */
export function solitaireBotPersonality(
  botId: SolitaireBotId,
): SolitaireBotPersonality {
  return SOLITAIRE_BOT_PERSONALITIES[botId];
}

/** Whether this character is allowed to react to `event`. */
export function solitaireBotReactsTo(
  botId: SolitaireBotId,
  event: DialogueEventType,
): boolean {
  return SOLITAIRE_BOT_PERSONALITIES[botId].supportedEvents.includes(event);
}
