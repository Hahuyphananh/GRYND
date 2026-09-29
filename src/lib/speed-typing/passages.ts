// src/lib/speed-typing/passages.ts
//
// The SERVER-SELECTED prompt library for Speed Typing.
//
// A "prompt" is what this codebase calls a PASSAGE — one text both seats race
// on. There is deliberately no second vocabulary: the database columns
// (`passage_id`, `passage_version`), the store, the race state and the tests all
// say "passage", so the library, the selectors and the metadata below do too.
//
// The passage is chosen by the server from an `(id, version)` pair that is
// stored on the match row, and both seats are served the text that pair
// resolves to here. Nothing about the text is ever sent by, or accepted from, a
// client — which is what makes "both players receive the exact same text" a
// server fact rather than a client convention.
//
// This mirrors Mini Golf exactly (see src/lib/mini-golf/course.ts): the
// database stores only a SEED plus a VERSION, and the content is derived in
// code. That buys three things a stored blob would not:
//
//   * the passage a match was raced on is reproducible forever, from two
//     columns, with no prose sitting in the database;
//   * a bad passage is fixed by bumping PASSAGE_VERSION and shipping — old
//     matches keep resolving to the text they actually used, because the
//     version they ran under is on their row;
//   * verification is trivially trustworthy: the server compares a submission
//     against the text IT resolved, never against a target the client supplied.
//
// SELECTION IS ONCE PER MATCH AND FIXED FOREVER (see `passageForRow`): the row
// stores the resolved pair, so a race can never be re-rolled, both seats read
// the same pair, and a `disabled` entry is only ever reachable for a match that
// was armed with it before it was retired.
//
// TEXT RULES (all enforced by tests/speed-typing-prompts.test.mjs):
//   * ASCII only — no smart quotes, no accents, no em dashes. A passage that
//     cannot be typed on a US keyboard is not a fair race.
//   * plain punctuation and single spaces; passages are compared exactly, so
//     every character must be reproducible from the keyboard.
//   * no double quotes, so the sources stay plainly readable.
//   * a comfortable length for a 1v1 race: roughly 25-45 words.

/**
 * Bump when any passage text changes. Stored per match; never migrated.
 *
 * This is the library's version: one number covers the whole catalog, and it is
 * written to every armed row alongside the passage id. Bumping it retires the
 * old texts for NEW matches while leaving every already-armed match resolvable
 * under the version it ran on.
 */
export const PASSAGE_VERSION = 1;

/** The difficulties the catalog can be filtered by. Editorial, not derived. */
export const PASSAGE_DIFFICULTIES = ["easy", "normal", "hard"] as const;

export type PassageDifficulty = (typeof PASSAGE_DIFFICULTIES)[number];

/** The languages the library currently ships. Selection filters on this. */
export const PASSAGE_LANGUAGES = ["en"] as const;

export type PassageLanguage = (typeof PASSAGE_LANGUAGES)[number];

/**
 * A catalog entry, as written by hand.
 *
 * `charCount` is deliberately NOT hand-written: a hand-kept number drifts the
 * moment someone edits a sentence, and the whole point of this field is to be
 * trustworthy enough to size a race from. It is derived once, at load, below.
 */
type RawPassage = {
  /** Stable catalog id, e.g. "pt-01". Written to `passage_id`. */
  readonly id: string;
  /** The exact text both seats race on. Never sent to a non-participant. */
  readonly text: string;
  /** Editorial difficulty, for future filtering / progression. */
  readonly difficulty: PassageDifficulty;
  /** BCP-47 language tag of the text. */
  readonly language: PassageLanguage;
  /**
   * false = RETIRED. A retired prompt is never selected for a new match, but it
   * stays in the catalog so a match already armed with it still verifies — see
   * `passageById`.
   */
  readonly enabled: boolean;
};

/**
 * A catalog entry as the rest of the game sees it: the raw fields plus the
 * derived `charCount`. Every field is needed by someone — the UI to label a
 * race, the selectors to filter, and the server to size and verify it.
 */
export type Passage = RawPassage & {
  /** Derived from `text` at load, so it can never disagree with it. */
  readonly charCount: number;
};

/**
 * The catalog. Order is irrelevant to fairness (selection is seeded), but the
 * list is frozen so ids can never be reordered by an edit — an id always means
 * one passage.
 */
const RAW_PASSAGES: readonly RawPassage[] = Object.freeze([
  {
    id: "pt-01",
    text:
      "The fastest typists do not look at their hands. They watch the words appear and let their fingers find the next key on their own, one smooth motion at a time, until the whole line is done.",
    difficulty: "normal",
    language: "en",
    enabled: true,
  },
  {
    id: "pt-02",
    text:
      "Accuracy beats raw speed in every close race. A single missed letter costs more time than a calm pause, because every correction is a delay you cannot get back.",
    difficulty: "easy",
    language: "en",
    enabled: true,
  },
  {
    id: "pt-03",
    text:
      "A steady rhythm carries a long passage better than a burst of effort. Begin at a pace you can hold, and let the last sentence arrive before your hands get tired.",
    difficulty: "easy",
    language: "en",
    enabled: true,
  },
  {
    id: "pt-04",
    text:
      "Practice works best in short, honest sessions. Type the same paragraph three times and check your mistakes, then rest; the improvement shows up the next day, not in the last repetition.",
    difficulty: "normal",
    language: "en",
    enabled: true,
  },
  {
    id: "pt-05",
    text:
      "Two players start on the same line of text, so the only difference between them is how they move. The clock is the same, the words are the same, and the finish line is the same.",
    difficulty: "hard",
    language: "en",
    enabled: true,
  },
  {
    id: "pt-06",
    text:
      "Muscle memory is built slowly and lost quickly. A few minutes every day keeps the old keys familiar, while a single long session on a weekend mostly teaches you to be tired.",
    difficulty: "normal",
    language: "en",
    enabled: true,
  },
  {
    id: "pt-07",
    text:
      "Read one word ahead and your hands will not stall at the space. The eye leads, the fingers follow, and the line keeps moving even when a longer word shows up.",
    difficulty: "easy",
    language: "en",
    enabled: true,
  },
  {
    id: "pt-08",
    text:
      "The keyboard layout you learned first is the one you should race on. Switching layouts mid season costs weeks of speed, and the small gains rarely repay that kind of loss.",
    difficulty: "normal",
    language: "en",
    enabled: true,
  },
  {
    id: "pt-09",
    text:
      "Mistakes are normal in a fast race. The trick is to keep going once you notice one, fix it if the game allows, and never let a single error turn into a slow sentence.",
    difficulty: "hard",
    language: "en",
    enabled: true,
  },
  {
    id: "pt-10",
    text:
      "Speed grows out of clean repetitions, not out of strain. Push a little past comfortable, hold that pace for the whole passage, and the new speed becomes ordinary.",
    difficulty: "normal",
    language: "en",
    enabled: true,
  },
  {
    // RETIRED — never selected for a new match, but kept so a match armed with
    // it before its retirement still resolves to the exact text it raced.
    id: "pt-11",
    text:
      "A short break between races keeps the hands fresh and the eyes sharp. Step away from the screen for a minute, roll your shoulders, and come back ready to type the next line without rushing.",
    difficulty: "easy",
    language: "en",
    enabled: false,
  },
]);

/**
 * The whole catalog, with `charCount` derived once and everything frozen.
 *
 * Deriving here rather than hand-writing the number is what makes the metadata
 * trustworthy: `passage.charCount === passage.text.length` is true by
 * construction, and the test that asserts it is a regression guard rather than
 * a hope.
 */
export const SPEED_TYPING_PASSAGES: readonly Passage[] = Object.freeze(
  RAW_PASSAGES.map((passage) => Object.freeze({ ...passage, charCount: passage.text.length })),
);

/**
 * The SELECTABLE catalog: every entry that is not retired.
 *
 * This is the pool every selector draws from, so a disabled prompt is
 * unreachable for a new match by construction rather than by a check each
 * caller has to remember. `passageById` still resolves retired entries, which is
 * how an already-armed match keeps working after a retirement.
 */
export const ENABLED_PASSAGES: readonly Passage[] = Object.freeze(
  SPEED_TYPING_PASSAGES.filter((passage) => passage.enabled),
);

/** Every catalog id, in catalog order (including retired entries). */
export const PASSAGE_IDS: readonly string[] = Object.freeze(
  SPEED_TYPING_PASSAGES.map((passage) => passage.id),
);

/** Every SELECTABLE id, in catalog order. Never contains a retired entry. */
export const ENABLED_PASSAGE_IDS: readonly string[] = Object.freeze(
  ENABLED_PASSAGES.map((passage) => passage.id),
);

const PASSAGES_BY_ID: Readonly<Record<string, Passage>> = Object.freeze(
  SPEED_TYPING_PASSAGES.reduce<Record<string, Passage>>((acc, passage) => {
    acc[passage.id] = passage;
    return acc;
  }, {}),
);

/**
 * The public, non-secret metadata of a prompt.
 *
 * Deliberately excludes the selection inputs (the race seed and the catalog
 * index): a client is told WHICH prompt it is racing and how big/hard it is,
 * never how the server arrived at it. Nothing here is a decision input — every
 * field is a fact about the text, and the authoritative text still comes from
 * `passageForRow` on the server.
 */
export type PassageMeta = {
  id: string;
  version: number;
  difficulty: PassageDifficulty;
  language: PassageLanguage;
  charCount: number;
};

/** The metadata of a resolved passage, or null when there is none. */
export function passageMeta(passage: Passage | null | undefined): PassageMeta | null {
  if (!passage) return null;
  return {
    id: passage.id,
    version: PASSAGE_VERSION,
    difficulty: passage.difficulty,
    language: passage.language,
    charCount: passage.charCount,
  };
}

/**
 * The passage an `(id, version)` pair resolves to, or null when the pair is
 * unknown — a passage id from a newer catalog, or a version this build does not
 * have. Callers treat null as "this match cannot be verified", never as a
 * reason to fall back to a client-supplied target.
 *
 * Resolves RETIRED entries too: this is the read-by-id path a stored match uses,
 * so retiring a prompt never invalidates a race already armed with it.
 */
export function passageById(id: unknown, version: unknown): Passage | null {
  if (typeof id !== "string" || id.length === 0) return null;
  if (Number(version) !== PASSAGE_VERSION) return null;
  return PASSAGES_BY_ID[id] ?? null;
}

/** True when `id` names a passage in this catalog (retired entries included). */
export function isPassageId(value: unknown): boolean {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(PASSAGES_BY_ID, value);
}

/** True when `id` names a passage a NEW match is allowed to be armed with. */
export function isEnabledPassageId(value: unknown): boolean {
  return typeof value === "string" && ENABLED_PASSAGE_IDS.includes(value);
}

/**
 * The selectable entries matching an optional filter.
 *
 * A filter that no enabled prompt satisfies yields an EMPTY pool, which
 * `selectPassageForSeed` turns into a null selection — the server refuses to
 * arm rather than silently racing an unsupported language or difficulty.
 */
function passagePool({
  language,
  difficulty,
}: {
  language?: unknown;
  difficulty?: unknown;
} = {}): readonly Passage[] {
  return ENABLED_PASSAGES.filter((passage) => {
    if (language != null && passage.language !== language) return false;
    if (difficulty != null && passage.difficulty !== difficulty) return false;
    return true;
  });
}

/**
 * The catalog index a seed selects.
 *
 * A plain `seed % length` would walk the catalog in order as the seed advances,
 * so neighbouring matches would race the same passage in sequence. Mixing the
 * seed first (a fixed 32-bit avalanche, no randomness) scatters it across the
 * whole catalog instead. Pure and integer-only, so two servers, a replay and a
 * test all land on the same passage.
 *
 * The default length is the ENABLED count: selection can only ever land on a
 * selectable prompt.
 */
export function passageIndexFromSeed(
  seed: unknown,
  length = ENABLED_PASSAGES.length,
): number {
  if (!Number.isFinite(Number(seed)) || Number(seed) < 0) return 0;
  if (!Number.isFinite(Number(length)) || Number(length) <= 0) return 0;
  // xorshift-style avalanche on the low 32 bits, then fold into the pool.
  let x = Math.floor(Number(seed)) >>> 0;
  x ^= x << 13;
  x >>>= 0;
  x ^= x >>> 17;
  x ^= x << 5;
  x >>>= 0;
  return x % Math.floor(Number(length));
}

/**
 * The passage a seed selects.
 *
 * The ONLY way a passage is chosen for a new match. `version` is validated, so
 * a row written under an older catalog is never quietly raced on newer text,
 * and the pool is `ENABLED_PASSAGES`, so a retired prompt can never be picked.
 * An optional `language` / `difficulty` filter narrows the pool; a filter that
 * matches nothing makes the selection fail (null) instead of falling back.
 */
export function selectPassageForSeed({
  seed,
  version = PASSAGE_VERSION,
  language,
  difficulty,
}: {
  seed: unknown;
  version?: unknown;
  language?: unknown;
  difficulty?: unknown;
}): Passage | null {
  if (Number(version) !== PASSAGE_VERSION) return null;
  const pool = passagePool({ language, difficulty });
  if (pool.length === 0) return null;
  return pool[passageIndexFromSeed(seed, pool.length)] ?? null;
}

/**
 * The passage a match row raced on, from the row's own columns.
 *
 * Returns null when the row is unarmed (no seed yet) or carries a passage pair
 * this build cannot resolve. Callers must treat null as "cannot verify" — see
 * `submitFinish` in ./serverStore.ts.
 *
 * The STORED pair always wins over a re-derived one. That single line is what
 * makes the prompt fixed for the life of a match: once the pair is written at
 * arming time, changing the row's seed (or shipping a new catalog) cannot move
 * either seat onto different text, and both seats resolve the same text because
 * they read the same pair.
 */
export function passageForRow(row: {
  raceSeed?: unknown;
  passageId?: unknown;
  passageVersion?: unknown;
}): Passage | null {
  if (row.passageId != null) return passageById(row.passageId, row.passageVersion);
  if (row.raceSeed == null) return null;
  return selectPassageForSeed({ seed: row.raceSeed, version: row.passageVersion });
}

/** Word count, used only for display copy and to sanity-check a catalog edit. */
export function passageWordCount(text: unknown): number {
  if (typeof text !== "string") return 0;
  return text.trim().split(/\s+/).filter(Boolean).length;
}
