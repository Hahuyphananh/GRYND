// src/lib/solitaire-duel/bots.ts
//
// The ONE bot roster for Solitaire Duel practice.
//
// Each bot is a stable public identity (id, name, trophy rating, difficulty,
// copy, avatar placeholder) plus the AI profile that actually decides how it
// plays. The profile lives here, next to the identity, so a lobby card can never
// advertise a difficulty the engine does not deliver.
//
// AVATARS: every bot points at a local, square 384×384 asset under
// `/images/...`; the one shared `BotAvatar` frame crops all of them identically.
// No remote or generated URL belongs here. Perfect deliberately wears the
// existing GLITCH mascot as its avatar — the final challenge, not a seventh
// character.
//
// PERFECT has no numeric trophy rating. `rating: null` is deliberate — the UI
// renders `ratingLabel` ("PERFECT"), and nothing awards these ratings to the
// player. They are opponent strength labels, not trophies.

export type SolitaireBotId =
  | "rookie"
  | "felix"
  | "ace"
  | "professor"
  | "grandmaster"
  | "perfect";

export type SolitaireBotAudience = "beginner" | "intermediate" | "advanced";

export type SolitaireBotDifficultyId =
  | "very-easy"
  | "easy"
  | "intermediate"
  | "hard"
  | "expert"
  | "perfect";

/**
 * The decision-making knobs a bot uses.
 *
 * All of them are FAIR-INFORMATION knobs: the evaluator below never reads a
 * face-down card's identity or the order of the stock. A stronger profile sees
 * farther ahead and weighs structural progress more accurately; it does not see
 * more cards.
 */
export type SolitaireBotAiProfile = {
  /** How often the bot deliberately takes a lower-ranked legal move (0–1). */
  mistakeRate: number;
  /** How many of the best moves a deliberate slip may fall through. */
  slipPool: number;
  /** A slip never falls below this fraction of the best move's score. */
  slipFloor: number;
  /**
   * How often the bot plays a move that makes NO progress at all (0–1):
   * recycling the stock while a real move is available, giving a card back
   * from a foundation, or shuffling a run sideways. This is the beginner's
   * error — a `mistakeRate` slip is still a productive move, so it costs a
   * little quality but no time. A blunder costs plies, which is what makes
   * the weak bots genuinely slow to finish.
   */
  blunderRate: number;
  /** Visible-move plies searched before choosing. 0 = evaluate one move. */
  searchDepth: number;
  /** How many child moves are expanded at each searched node. */
  beamWidth: number;
  /** Hard cap on evaluated nodes for one decision (keeps server reads bounded). */
  searchBudget: number;
  foundationWeight: number;
  revealWeight: number;
  emptyColumnWeight: number;
  structureWeight: number;
  drawWeight: number;
  planningWeight: number;
  /** Server pacing between accepted bot moves (never the only difficulty knob). */
  moveDelayMs: number;
};

export type SolitaireBot = {
  /** Stable id stored in `solitaire_duel_matches.ai_difficulty`. */
  id: SolitaireBotId;
  name: string;
  /** Numeric opponent rating, or null for the special final challenge. */
  rating: number | null;
  /** What the UI prints where a numeric rating would go. */
  ratingLabel: string;
  difficulty: SolitaireBotDifficultyId;
  difficultyLabel: string;
  description: string;
  /** Placeholder initials, and the future local image slot (currently null). */
  initials: string;
  avatar: { src: string | null; alt: string };
  audience: SolitaireBotAudience;
  audienceLabel: string;
  /** 1 (weakest) → 6 (Perfect). Drives the progression marker. */
  order: number;
  /**
   * Typical plies a solve takes for this profile, measured by the difficulty
   * benchmark in `tests/solitaire-duel-bots.test.mjs` over proven-solvable
   * practice deals.
   *
   * Calibration for the lobby's finish estimate only — the clock always uses
   * `ai.moveDelayMs`, never this.
   */
  expectedSolveMoves: number;
  ai: SolitaireBotAiProfile;
};

const PROFILE = {
  // Rookie is the BAD player, deliberately: it recycles the stock, gives cards
  // back off the foundations and dithers — and it is paced like someone reading
  // the board for the first time. A casual player should always beat it.
  rookie: {
    mistakeRate: 0.5,
    slipPool: 6,
    slipFloor: 0.3,
    blunderRate: 0.22,
    searchDepth: 0,
    beamWidth: 0,
    searchBudget: 1,
    foundationWeight: 0.72,
    revealWeight: 0.35,
    emptyColumnWeight: 0.25,
    structureWeight: 0.55,
    drawWeight: 1.35,
    planningWeight: 0,
    moveDelayMs: 2_600,
  },
  felix: {
    mistakeRate: 0.26,
    slipPool: 5,
    slipFloor: 0.4,
    blunderRate: 0.12,
    searchDepth: 0,
    beamWidth: 0,
    searchBudget: 1,
    foundationWeight: 0.88,
    revealWeight: 0.55,
    emptyColumnWeight: 0.45,
    structureWeight: 0.72,
    drawWeight: 1,
    planningWeight: 0.12,
    moveDelayMs: 2_300,
  },
  ace: {
    mistakeRate: 0.12,
    slipPool: 3,
    slipFloor: 0.55,
    blunderRate: 0.05,
    searchDepth: 1,
    beamWidth: 6,
    searchBudget: 120,
    foundationWeight: 0.96,
    revealWeight: 0.72,
    emptyColumnWeight: 0.65,
    structureWeight: 0.85,
    drawWeight: 0.95,
    planningWeight: 0.32,
    moveDelayMs: 1_550,
  },
  professor: {
    mistakeRate: 0.04,
    slipPool: 2,
    slipFloor: 0.7,
    blunderRate: 0.02,
    searchDepth: 2,
    beamWidth: 5,
    searchBudget: 240,
    foundationWeight: 1.02,
    revealWeight: 0.88,
    emptyColumnWeight: 0.82,
    structureWeight: 0.96,
    drawWeight: 0.9,
    planningWeight: 0.5,
    moveDelayMs: 1_150,
  },
  grandmaster: {
    mistakeRate: 0.008,
    slipPool: 2,
    slipFloor: 0.85,
    blunderRate: 0.006,
    searchDepth: 3,
    beamWidth: 4,
    searchBudget: 420,
    foundationWeight: 1.06,
    revealWeight: 1,
    emptyColumnWeight: 0.96,
    structureWeight: 1.05,
    drawWeight: 0.86,
    planningWeight: 0.66,
    moveDelayMs: 820,
  },
  perfect: {
    mistakeRate: 0,
    slipPool: 0,
    slipFloor: 1,
    blunderRate: 0,
    // The strongest FAIR profile, and the reference the benchmark measures the
    // others against. Deliberately NOT widened beyond this: a beam of 8 at the
    // same depth (and a depth of 4) both reintroduced a gyre — Perfect undid its
    // own move on seed 2026 and completed fewer deals — so the separation from
    // Grandmaster is calibrated on Grandmaster's budget instead. The fairness
    // rule in `searchScore` is unchanged: no hidden card is ever read.
    searchDepth: 3,
    beamWidth: 5,
    searchBudget: 700,
    foundationWeight: 1.1,
    revealWeight: 1.15,
    emptyColumnWeight: 1.1,
    structureWeight: 1.15,
    drawWeight: 0.8,
    planningWeight: 0.8,
    moveDelayMs: 560,
  },
} satisfies Record<SolitaireBotId, SolitaireBotAiProfile>;

export const SOLITAIRE_BOTS: readonly SolitaireBot[] = Object.freeze([
  {
    id: "rookie",
    name: "Rookie",
    rating: 200,
    ratingLabel: "200",
    difficulty: "very-easy",
    difficultyLabel: "Very Easy",
    description:
      "Just getting started. A relaxed opponent who makes plenty of mistakes.",
    initials: "RK",
    avatar: {
      src: "/images/solitaire-bots/rookie.webp",
      alt: "Rookie, a raccoon wearing a headset",
    },
    audience: "beginner",
    audienceLabel: "Beginner",
    order: 1,
    expectedSolveMoves: 330,
    ai: PROFILE.rookie,
  },
  {
    id: "felix",
    name: "Felix",
    rating: 1_000,
    ratingLabel: "1,000",
    difficulty: "easy",
    difficultyLabel: "Easy",
    description:
      "A little more experienced. Knows the basics and spots obvious opportunities.",
    initials: "FX",
    avatar: {
      src: "/images/solitaire-bots/felix.webp",
      alt: "Felix, a fox wearing a headset",
    },
    audience: "beginner",
    audienceLabel: "Beginner",
    order: 2,
    expectedSolveMoves: 180,
    ai: PROFILE.felix,
  },
  {
    id: "ace",
    name: "Ace",
    rating: 3_000,
    ratingLabel: "3,000",
    difficulty: "intermediate",
    difficultyLabel: "Intermediate",
    description:
      "A competitive player who plans ahead and makes fewer mistakes.",
    initials: "AC",
    avatar: {
      src: "/images/solitaire-bots/ace.webp",
      alt: "Ace, a grey wolf wearing a headset",
    },
    audience: "intermediate",
    audienceLabel: "Intermediate",
    order: 3,
    expectedSolveMoves: 155,
    ai: PROFILE.ace,
  },
  {
    id: "professor",
    name: "Professor",
    rating: 6_500,
    ratingLabel: "6,500",
    difficulty: "hard",
    difficultyLabel: "Hard",
    description:
      "Patient and calculated. Carefully evaluates available moves.",
    initials: "PR",
    avatar: {
      src: "/images/solitaire-bots/professor.webp",
      alt: "Professor, a purple owl wearing a headset",
    },
    audience: "intermediate",
    audienceLabel: "Intermediate",
    order: 4,
    expectedSolveMoves: 140,
    ai: PROFILE.professor,
  },
  {
    id: "grandmaster",
    name: "Grandmaster",
    rating: 10_000,
    ratingLabel: "10,000",
    difficulty: "expert",
    difficultyLabel: "Expert",
    description:
      "An elite opponent who considers long-term consequences.",
    initials: "GM",
    avatar: {
      src: "/images/solitaire-bots/grandmaster.webp",
      alt: "Grandmaster, a black panther wearing a headset",
    },
    audience: "advanced",
    audienceLabel: "Advanced",
    order: 5,
    expectedSolveMoves: 135,
    ai: PROFILE.grandmaster,
  },
  {
    id: "perfect",
    name: "Perfect",
    rating: null,
    ratingLabel: "PERFECT",
    difficulty: "perfect",
    difficultyLabel: "Perfect",
    description:
      "No intentional mistakes. The ultimate Solitaire challenge.",
    initials: "PF",
    // Perfect's avatar IS Glitch: the existing GRYND mascot artwork, reused as
    // the final challenge's face rather than a new character.
    avatar: {
      src: "/images/mascot/glitch-idle.webp",
      alt: "Glitch, the GRYND mascot, as the Perfect challenge",
    },
    audience: "advanced",
    audienceLabel: "Advanced",
    order: 6,
    expectedSolveMoves: 135,
    ai: PROFILE.perfect,
  },
]);

export const SOLITAIRE_BOT_BY_ID: Record<SolitaireBotId, SolitaireBot> =
  Object.freeze(
    Object.fromEntries(SOLITAIRE_BOTS.map((bot) => [bot.id, bot])) as Record<
      SolitaireBotId,
      SolitaireBot
    >,
  );

/**
 * Historical tier spellings, kept so old practice rows and older clients still
 * resolve to a concrete named bot. `normal` was the old default, so it maps to
 * the middle of the roster (Ace), not to Rookie.
 */
const LEGACY_BOT_ALIASES: Record<string, SolitaireBotId> = {
  easy: "rookie",
  beginner: "rookie",
  novice: "rookie",
  normal: "ace",
  medium: "ace",
  moderate: "ace",
  average: "ace",
  hard: "grandmaster",
  expert: "perfect",
  pro: "grandmaster",
  advanced: "professor",
  insane: "grandmaster",
};

/** True for one of the six stable bot ids. */
export function isSolitaireBotId(value: unknown): value is SolitaireBotId {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(SOLITAIRE_BOT_BY_ID, value)
  );
}

/**
 * Resolve any stored/client value to a named bot.
 *
 * Unknown or absent values fall back to Ace — the old `normal` default — rather
 * than throwing on a legacy row or an older client payload.
 */
export function solitaireBotFor(value: unknown): SolitaireBot {
  if (isSolitaireBotId(value)) return SOLITAIRE_BOT_BY_ID[value];
  if (typeof value === "string") {
    const key = value.trim().toLowerCase();
    if (isSolitaireBotId(key)) return SOLITAIRE_BOT_BY_ID[key];
    const alias = LEGACY_BOT_ALIASES[key];
    if (alias) return SOLITAIRE_BOT_BY_ID[alias];
  }
  return SOLITAIRE_BOT_BY_ID.ace;
}

export function solitaireBotIdFor(value: unknown): SolitaireBotId {
  return solitaireBotFor(value).id;
}

/**
 * The player-facing facts about a bot: how long a solve takes, how often it
 * gets it wrong, and how fast it moves.
 *
 * DERIVED, never a second source of truth: the numbers come from the profile's
 * own measured ply count and `moveDelayMs`. The raw AI knobs stay in `ai` and
 * out of every public payload.
 */
export function solitaireBotStats(bot: SolitaireBot) {
  const paceSeconds = Math.round(bot.ai.moveDelayMs / 100) / 10;
  const finishMinutes =
    Math.round((bot.expectedSolveMoves * bot.ai.moveDelayMs) / 600) / 100;
  const mistakeRate = Math.min(
    1,
    Math.max(0, bot.ai.blunderRate + bot.ai.mistakeRate),
  );
  const mistakePercent = Math.round(mistakeRate * 1_000) / 10;

  return {
    /** Seconds between the bot's moves. */
    paceSeconds,
    paceLabel: `~${paceSeconds.toFixed(1)}s a move`,
    /** Expected minutes to solve one practice deal. */
    finishMinutes,
    finishLabel: `~${finishMinutes.toFixed(1)} min`,
    /** Share of decisions that are not the bot's best move (0–1). */
    mistakeRate,
    mistakeLabel: `${Number.isInteger(mistakePercent) ? mistakePercent : mistakePercent.toFixed(1)}%`,
  };
}

/** The public slice of a bot — safe to put in a match DTO. */
export function publicSolitaireBot(bot: SolitaireBot) {
  return {
    id: bot.id,
    name: bot.name,
    rating: bot.rating,
    ratingLabel: bot.ratingLabel,
    difficulty: bot.difficulty,
    difficultyLabel: bot.difficultyLabel,
    description: bot.description,
    initials: bot.initials,
    avatar: { ...bot.avatar },
    audience: bot.audience,
    audienceLabel: bot.audienceLabel,
    order: bot.order,
    stats: solitaireBotStats(bot),
  };
}

export function publicSolitaireBots() {
  return SOLITAIRE_BOTS.map(publicSolitaireBot);
}
