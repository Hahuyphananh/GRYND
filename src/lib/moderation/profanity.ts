// src/lib/moderation/profanity.ts
//
// The username/display-name filter.
//
// WHY THIS EXISTS: GRYND is an 18+ platform and the public homepage leaderboard
// renders real usernames to signed-out visitors. Without a filter, the first
// thing a new visitor reads can be a slur — which is exactly what happened
// ("Stupidgayzz" sitting at rank 1). The filter runs at the two places a name
// can ENTER the system (Clerk signup and the rename endpoint) so a bad name
// never reaches a public surface in the first place. It is deliberately not a
// UI-only check: every enforcement point is server-side.
//
// HOW IT MATCHES: a naive `includes()` over a raw string is trivially defeated
// by padding ("s t u p i d"), leetspeak ("5tup1d"), diacritics ("stüpid") or
// repeated letters ("stuuupid"), so the input is normalized first:
//
//   Unicode fold → lowercase → leet fold → drop non-letters → collapse runs
//
// and then scanned for blocklist substrings. Because everything is collapsed
// into one letter stream, a name that concatenates words ("stupidgayzz") is
// caught even though neither word sits on a boundary — which is the whole
// reason substring matching (rather than word matching) is used here.
//
// The cost of substring matching is false positives ("class" contains "ass",
// "peacock" contains "cock"), so a small ALLOWLIST of ordinary words is removed
// from the normalized string before the scan. That is the standard trade-off:
// the allowlist is auditable and lives right next to the blocklist.
//
// SCOPE: usernames / display names only. Review bodies are already moderated
// before publication (status pending → approved), so this does not gate them.
//
// PURE MODULE: no I/O, no clock, no randomness — so it is testable with plain
// `node --test` and safe to import from either side of the trust boundary (the
// rename form can use it for instant feedback; the server is still the one that
// enforces it).

/**
 * Leetspeak and look-alike folding.
 *
 * Applied character by character AFTER lowercasing, so `5` → `s`, `@` → `a`,
 * `!`/`|` → `i`/`l`, etc. Anything still not a letter is dropped by the
 * "letters only" pass that follows.
 */
const LEET: Record<string, string> = {
  "0": "o",
  "1": "i",
  "2": "z",
  "3": "e",
  "4": "a",
  "5": "s",
  "6": "g",
  "7": "t",
  "8": "b",
  "9": "g",
  "@": "a",
  $: "s",
  "!": "i",
  "|": "l",
  "+": "t",
  "(": "c",
};

/**
 * Ordinary words that legitimately CONTAIN a blocked substring.
 *
 * Removed (in whole) from the normalized string before scanning, so
 * "ClassicGamer" is not rejected for containing "ass". Kept deliberately small
 * and only for words that actually collide with the blocklist below — a long
 * allowlist is how these filters rot.
 */
const ALLOWLIST = [
  // ass
  "class",
  "classic",
  "classy",
  "classify",
  "grass",
  "grayscale",
  "glass",
  "glasses",
  "pass",
  "passage",
  "passenger",
  "passion",
  "passive",
  "password",
  "compass",
  "compassion",
  "harass",
  "harassment",
  "assassin",
  "assassination",
  "mass",
  "massive",
  "bass",
  "bassoon",
  "cassette",
  "molasses",
  "embarrass",
  "assorted",
  "assume",
  "assure",
  "asset",
  "assign",
  "assist",
  "associate",
  "association",
  "cassava",
  "sassy",
  "cassandra",
  "cassidy",
  // The canonical substring-filter false positive: the English town. Kept as a
  // standing example that the allowlist exists for exactly this reason.
  "scunthorpe",
  // spic
  "spice",
  "spices",
  "spicy",
  "auspicious",
  "suspicious",
  "conspicuous",
  "perspicuous",
  "hospice",
  // rape
  "grape",
  "grapes",
  "grapefruit",
  "drape",
  "drapes",
  "scrape",
  "scraper",
  "scrapes",
  "trapeze",
  "therapeutic",
  "therapist",
  // gay (legitimate identity word and surnames)
  "gaylord",
  "gaynor",
  "gayle",
  "gaye",
  // dick
  "dickens",
  "dickinson",
  "dickson",
  "dickey",
  // cock
  "cocktail",
  "cockpit",
  "peacock",
  "hancock",
  "woodcock",
  "cockerel",
  "cocker",
  // coon
  "raccoon",
  "raccoons",
  // cum
  "cumulative",
  "cucumber",
  "circumference",
  "document",
  "cumber",
  "cumbersome",
  "encumber",
  "incumbent",
  "cumulus",
  "cumbria",
  // anal
  "analyst",
  "analysis",
  "analyze",
  "analyses",
  "analytics",
  "analytical",
  "analog",
  "analogue",
  "analogy",
  "canal",
  "banal",
  // sex
  "sexton",
  "sextant",
  "sextet",
  "sussex",
  "essex",
  "unisex",
  // anus
  "janus",
  "uranus",
  // loser / prick / pussy / booby / nude
  "closer",
  "prickly",
  "prickle",
  "pussycat",
  "pussywillow",
  "booby",
  "denude",
  "denuded",
  "fagin",
];

/**
 * Blocked terms.
 *
 * Written as ordinary spellings and folded through the same normalizer at module
 * load, so an entry can never silently fail to match (a term with a space or a
 * digit would otherwise be compared against a letter-only stream and never hit).
 *
 * This is a first-line filter for the obvious cases, NOT a complete list — the
 * report button on leaderboard and review entries is the backstop for whatever
 * it misses, and an admin can act on those.
 */
const BLOCKED_SOURCE = [
  // General profanity / insults
  "fuck",
  "fuk",
  "fck",
  "motherfuck",
  "shit",
  "bullshit",
  "bitch",
  "bastard",
  "asshole",
  "arsehole",
  "arse",
  "assman",
  "assface",
  "asshat",
  "dumbass",
  "jackass",
  "dipshit",
  "cunt",
  "pussy",
  "cock",
  "cocksuck",
  "dickhead",
  "dick",
  "penis",
  "vagina",
  "whore",
  "slut",
  "skank",
  "twat",
  "wanker",
  "prick",
  "bollock",
  "testicle",
  "scrotum",
  "boob",
  "tits",
  "titjob",
  "handjob",
  "blowjob",
  "cum",
  "jizz",
  "orgasm",
  "masturbat",
  "pedo",
  "pedophil",
  "rapist",
  "rape",
  "nazi",
  "hitler",
  "kkk",
  "stupid",
  "idiot",
  "moron",
  "imbecile",
  "retard",
  "loser",
  "scumbag",
  "douche",
  "douchebag",
  // Slurs
  "nigger",
  "nigga",
  "niglet",
  "faggot",
  "fag",
  "dyke",
  "tranny",
  "shemale",
  "wetback",
  "spick",
  "chink",
  "gook",
  "kike",
  "raghead",
  "towelhead",
  "coon",
  "jigaboo",
  "porchmonkey",
  "gyp",
  // Note on "gay": the reported name ("Stupidgayzz") is already caught by
  // "stupid", but "gay" is kept here because it is overwhelmingly used as an
  // insult in usernames. It is also an identity term, so common legitimate
  // names containing it are allowlisted above — remove this one entry if you
  // would rather not filter the word at all; nothing else depends on it.
  "gay",
  "homo",
  "queer",
  // Sexual / adult
  "sex",
  "sxe",
  "porn",
  "porno",
  "hentai",
  "nude",
  "nudes",
  "nsfw",
  "horny",
  "dildo",
  "anal",
  "anus",
  "rectum",
  "sodomy",
  "bestiality",
  "incest",
  // Violence / self-harm
  "kill yourself",
  "kys",
  "behead",
  "lynch",
];

/**
 * The letter-stream WITHOUT the repeat collapse.
 *
 * Unicode fold → lowercase → leet fold → letters only. Kept separate because
 * the collapse is lossy in a way that matters for short terms: collapsing
 * "kkk" produces "k", which would then match every name containing a `k`.
 * Matching therefore runs in two passes — collapsed against collapsed, and raw
 * against raw — so padding is caught without collapsing specificity away.
 */
function baseFold(input: unknown): string {
  if (typeof input !== "string" || input.length === 0) return "";

  const folded = input
    .normalize("NFKD")
    // Strip combining marks so "stüpid" folds to "stupid" instead of "stpid".
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

  let out = "";
  for (const char of folded) {
    const mapped = LEET[char];
    out += mapped ?? char;
  }

  // Letters only: separators, dots and dashes disappear, so "s.t.u.p.i.d" and
  // "s t u p i d" both fold into "stupid".
  return out.replace(/[^a-z]/g, "");
}

/**
 * Fold an arbitrary string into the letter-stream the blocklist is matched
 * against — WITHOUT the allowlist removal.
 *
 * Exported so tests (and any future admin tool) can inspect exactly what a name
 * reduces to.
 */
export function foldForModeration(input: unknown): string {
  // Collapse runs of three or more identical letters, so "stuuupid" folds to
  // "stupid". Runs of two are kept — they are how ordinary words are spelled
  // ("assess"), and collapsing them would corrupt the allowlist.
  return baseFold(input).replace(/(.)\1{2,}/g, "$1");
}

/** Remove every allowlisted word from a folded stream. */
function stripAllowed(text: string): string {
  if (!text) return text;
  for (const safe of ALLOWLIST) {
    const folded = baseFold(safe);
    if (folded && text.includes(folded)) text = text.split(folded).join("");
  }
  return text;
}

/**
 * The folded stream with allowlisted words removed — what the scan reads.
 *
 * Collapsed form, kept for inspection and tests; `findProfanity` also checks the
 * uncollapsed form so a repeated-letter term like "kkk" stays specific.
 */
export function normalizeForModeration(input: unknown): string {
  return stripAllowed(foldForModeration(input));
}

/**
 * Blocklist entries, folded once.
 *
 * `collapsed` is used for the padded-input pass; `raw` for the exact pass. A
 * collapsed form shorter than three characters means the collapse ate the term
 * ("kkk" → "k"), so it is discarded in favour of the raw spelling.
 */
const BLOCKED = BLOCKED_SOURCE.map((label) => {
  const raw = baseFold(label);
  const collapsedRaw = raw.replace(/(.)\1{2,}/g, "$1");
  return {
    label,
    raw,
    collapsed: collapsedRaw.length >= 3 ? collapsedRaw : raw,
  };
})
  .filter((entry) => entry.raw.length > 0)
  // Dedupe on the raw form, then check the most specific (longest) terms first.
  .filter(
    (entry, index, all) => all.findIndex((other) => other.raw === entry.raw) === index,
  )
  .sort((a, b) => b.raw.length - a.raw.length);

/**
 * The first blocked term the input contains, or null when it is clean.
 *
 * Returns the TERM rather than the input: callers log the term, and the user is
 * shown a generic message — an error string is not the place to echo a slur.
 */
export function findProfanity(input: unknown): string | null {
  const collapsed = normalizeForModeration(input);
  const raw = stripAllowed(baseFold(input));
  if (!collapsed && !raw) return null;
  for (const entry of BLOCKED) {
    if (collapsed.includes(entry.collapsed)) return entry.label;
    if (raw.includes(entry.raw)) return entry.label;
  }
  return null;
}

/** True when a display name may be published. */
export function isNameAllowed(input: unknown): boolean {
  return findProfanity(input) === null;
}

/**
 * A deterministic, always-clean fallback name.
 *
 * Used when a name arrives from an identity provider (Clerk's `username` or
 * first+last name) and fails the filter: the account is still created — a
 * profane Google name must never block a signup — but it is published under a
 * neutral handle the player can change from their profile.
 *
 * Deterministic on purpose (a djb2 hash of the seed): no `Math.random()`, so the
 * same account always gets the same fallback and a retried webhook cannot mint
 * a different name.
 */
export function safeFallbackName(seed: unknown, prefix = "Player"): string {
  const text = typeof seed === "string" && seed.length > 0 ? seed : "grynd";
  let hash = 5381;
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) >>> 0;
  }
  // Base-36, five characters — short enough to read, wide enough to avoid
  // collisions between the handful of accounts that will ever hit this path.
  const suffix = hash.toString(36).slice(0, 5).toUpperCase().padStart(5, "X");
  return `${prefix}${suffix}`;
}

/**
 * The name to publish for a provider-supplied candidate.
 *
 * Clean names pass through unchanged (trimmed and capped); anything else
 * degrades to the deterministic fallback. This is the single helper the signup
 * paths call, so the webhook and /sync cannot drift apart.
 */
export function moderatedDisplayName(
  candidate: unknown,
  seed: unknown,
  { maxLength = 80 }: { maxLength?: number } = {},
): string {
  const raw = typeof candidate === "string" ? candidate.trim() : "";
  const trimmed = raw.slice(0, maxLength);
  if (trimmed.length > 0 && isNameAllowed(trimmed)) return trimmed;
  return safeFallbackName(seed);
}
