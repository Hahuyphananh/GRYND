/**
 * glitch-review.test.mjs
 *
 * Phase 5 — GLITCH in the Solitaire Game Review.
 *
 * The repository's UI tests are pure-behaviour tests plus source contracts
 * (there is no jsdom harness), so this suite proves:
 *
 *   1. only the events the engine marked as commentary-worthy get a reaction;
 *      normal moves, good moves, routine draws and ordinary waste moves do not;
 *   2. every message family is reachable only through a tag the analysis
 *      actually emitted for that move — no invented explanation;
 *   3. similar events in one game do not repeat the same wording;
 *   4. event ids are stable, unique and built from game + move + event type;
 *   5. the review panel renders GLITCH inline (never the floating provider),
 *      looks the reaction up by the selected move and shows nothing for a
 *      silent one;
 *   6. every `glitch.review.*` key exists in en / fr / es and no English
 *      sentence is hardcoded in the module or the page.
 *
 * Run: npm run test:glitch-review
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const { t } = await import("../src/lib/appTextTranslations.js");
const {
  buildGlitchReviewReactions,
  selectGlitchReviewReaction,
  GLITCH_REVIEW_KEYS,
  GLITCH_REVIEW_MAX_STRUCTURE,
  GLITCH_REVIEW_VARIANTS,
} = await import("../src/lib/mascot/glitchReview.ts");

const read = (relPath) => fs.readFileSync(path.join(process.cwd(), relPath), "utf8");
const LOCALES = ["en", "fr", "es"];
const GAME = "solo:game-1";

const REVIEW_PAGE = "src/app/solitaire/review/[kind]/[gameId]/PageClient.tsx";
const REVIEW_MODULE = "src/lib/mascot/glitchReview.ts";

const RATED = new Set(["brilliant", "great", "mistake", "blunder"]);

/** One perMove entry, in the shape the analysis really emits. */
const move = (ply, rating, tags = [], extra = {}) => ({
  ply,
  rating,
  tags,
  commentaryEligible: RATED.has(rating),
  ...extra,
});

const reactionsFor = (moves, gameKey = GAME) =>
  buildGlitchReviewReactions({ analysis: { perMove: moves }, gameKey });

const reactionAt = (moves, ply, gameKey = GAME) =>
  selectGlitchReviewReaction({ analysis: { perMove: moves }, gameKey, ply });

// ── Copy ──────────────────────────────────────────────────────────────────

test("every review line exists in all three locales", () => {
  assert.equal(GLITCH_REVIEW_KEYS.length % GLITCH_REVIEW_VARIANTS, 0);

  for (const locale of LOCALES) {
    for (const key of GLITCH_REVIEW_KEYS) {
      const value = t(locale, key);
      assert.notEqual(value, key, `${locale} is missing ${key}`);
      assert.ok(value.trim().length > 0, `${locale} has an empty ${key}`);
    }
  }

  // The primary wordings are actually translated, not English placeholders.
  for (const key of ["glitch.review.great.opened", "glitch.review.mistake.generic"]) {
    assert.notEqual(t("fr", key), t("en", key), `fr ${key} is still English`);
    assert.notEqual(t("es", key), t("en", key), `es ${key} is still English`);
  }
});

test("the English copy carries the agreed tone", () => {
  assert.match(
    t("en", "glitch.review.great.opened"),
    /Now THAT was a smart move! You opened a new column/
  );
  assert.match(t("en", "glitch.review.brilliant.unlock"), /clever.*unlocked a sequence/);
  assert.match(t("en", "glitch.review.mistake.generic"), /^Careful!/);
  assert.match(t("en", "glitch.review.blunder.generic"), /^Ouch!/);
});

// ── Eligibility ───────────────────────────────────────────────────────────

test("normal, good and inaccuracy moves stay silent", () => {
  const reactions = reactionsFor([
    move(0, "normal", ["stock-draw"]),
    move(1, "normal", ["revealed-hidden"]),
    move(2, "good", ["foundation-progress"]),
    move(3, "inaccuracy", ["pointless-shuffle"]),
    move(4, "normal", ["waste-redeal"]),
  ]);
  assert.equal(reactions.size, 0);
});

test("routine draws and ordinary waste movement never qualify", () => {
  for (const rating of ["normal", "good"]) {
    for (const tag of ["stock-draw", "waste-redeal", "foundation-progress", "opened-column"]) {
      assert.equal(reactionsFor([move(0, rating, [tag])]).size, 0, `${rating} ${tag}`);
    }
  }
});

test("great moves choose a family from the tags that really happened", () => {
  const cases = [
    [["opened-column"], "great.opened", "victory"],
    [["unlocked-sequence"], "great.unlocked", "focused"],
    [["foundation-cascade"], "great.cascade", "victory"],
    [["revealed-hidden"], "great.reveal", "focused"],
    [["foundation-progress"], "great.foundation", "victory"],
    [[], "great.generic", "focused"],
  ];

  for (const [tags, event, expression] of cases) {
    const reaction = reactionAt([move(0, "great", tags)], 0);
    assert.ok(reaction, `great with ${tags.join(",") || "no tags"} must speak`);
    assert.equal(reaction.event, event);
    assert.equal(reaction.expression, expression);
    assert.equal(reaction.tone, "praise");
    assert.ok(reaction.priority >= 1);
  }
});

test("a great move never claims an unlock it did not make", () => {
  const reaction = reactionAt([move(0, "great", ["revealed-hidden"])], 0);
  assert.equal(reaction.event, "great.reveal");
  assert.doesNotMatch(reaction.messageKey, /opened|unlocked|cascade/);
});

test("brilliant requires the real column-plus-sequence combination", () => {
  const unlock = reactionAt([move(0, "brilliant", ["opened-column", "unlocked-sequence"])], 0);
  assert.equal(unlock.event, "brilliant.unlock");
  assert.equal(unlock.expression, "surprised");
  assert.equal(unlock.priority, 2);

  const generic = reactionAt([move(0, "brilliant", ["opened-column"])], 0);
  assert.equal(generic.event, "brilliant.generic");
});

test("mistakes and blunders use their caution families, never an invented cause", () => {
  const mistake = reactionAt([move(0, "mistake", ["revealed-hidden"])], 0);
  assert.equal(mistake.event, "mistake.generic");
  assert.equal(mistake.tone, "caution");
  assert.equal(mistake.expression, "focused");
  assert.equal(mistake.priority, 1);

  const foundationMistake = reactionAt([move(0, "mistake", ["pulled-from-foundation"])], 0);
  assert.equal(foundationMistake.event, "mistake.foundation");

  const shuffleMistake = reactionAt([move(0, "mistake", ["pointless-shuffle"])], 0);
  assert.equal(shuffleMistake.event, "mistake.shuffle");

  const blunder = reactionAt([move(0, "blunder", [])], 0);
  assert.equal(blunder.event, "blunder.generic");
  assert.equal(blunder.expression, "defeat");
  assert.equal(blunder.priority, 2);

  const foundationBlunder = reactionAt([move(0, "blunder", ["pulled-from-foundation"])], 0);
  assert.equal(foundationBlunder.event, "blunder.foundation");
});

test("the engine's own commentary flag can silence a rated move", () => {
  const reactions = reactionsFor([
    move(0, "great", ["opened-column"], { commentaryEligible: false }),
  ]);
  assert.equal(reactions.size, 0);
});

// ── Structural events ─────────────────────────────────────────────────────

test("structural events are rare, capped and only on unremarkable moves", () => {
  const capped = reactionsFor([
    move(0, "normal", ["unlocked-sequence"]),
    move(1, "normal", ["unlocked-sequence"]),
    move(2, "normal", ["unlocked-sequence"]),
  ]);
  assert.equal(capped.size, GLITCH_REVIEW_MAX_STRUCTURE);
  assert.equal(capped.get(0).event, "structure.sequence");
  assert.equal(capped.get(1).event, "structure.sequence");
  assert.equal(capped.has(2), false);

  // A rated move is already covered by its rating family; the structural pass
  // cannot speak twice for the same move.
  const rated = reactionsFor([move(0, "great", ["unlocked-sequence"])]);
  assert.equal(rated.size, 1);
  assert.equal(rated.get(0).event, "great.unlocked");

  // An inaccuracy is not an "important structural event" the mascot comments on.
  assert.equal(reactionsFor([move(0, "inaccuracy", ["unlocked-sequence"])]).size, 0);

  const cascade = reactionAt([move(0, "normal", ["foundation-cascade"])], 0);
  assert.equal(cascade.event, "structure.cascade");
  assert.equal(cascade.tone, "observation");
  assert.equal(cascade.expression, "focused");
});

// ── Repetition and ids ────────────────────────────────────────────────────

test("similar events vary their wording instead of repeating", () => {
  const moves = [
    move(0, "great", ["opened-column"]),
    move(1, "great", ["opened-column"]),
    move(2, "great", ["opened-column"]),
  ];
  const reactions = reactionsFor(moves);
  const keys = [0, 1, 2].map((ply) => reactions.get(ply).messageKey);

  assert.equal(new Set(keys).size, GLITCH_REVIEW_VARIANTS);
  assert.equal(keys[0], "glitch.review.great.opened");
  assert.equal(keys[1], "glitch.review.great.opened2");
  assert.equal(keys[2], "glitch.review.great.opened3");

  // A fourth similar event cycles rather than inventing a fourth key.
  const fourth = reactionsFor([...moves, move(3, "great", ["opened-column"])]).get(3);
  assert.equal(fourth.messageKey, "glitch.review.great.opened");
});

test("different families do not consume each other's wordings", () => {
  const reactions = reactionsFor([
    move(0, "great", ["opened-column"]),
    move(1, "great", ["revealed-hidden"]),
    move(2, "great", ["opened-column"]),
  ]);
  assert.equal(reactions.get(0).messageKey, "glitch.review.great.opened");
  assert.equal(reactions.get(1).messageKey, "glitch.review.great.reveal");
  assert.equal(reactions.get(2).messageKey, "glitch.review.great.opened2");
});

test("event ids are stable, unique and built from game, move and event", () => {
  const moves = [
    move(0, "great", ["opened-column"]),
    move(1, "mistake", []),
  ];
  const first = reactionsFor(moves);
  const again = reactionsFor(moves);

  assert.equal(first.get(0).eventId, "review:solo:game-1:1:great.opened");
  assert.equal(first.get(1).eventId, "review:solo:game-1:2:mistake.generic");
  assert.deepEqual(first, again);

  // A different game is a different event, so nothing dedupes across games.
  const other = reactionsFor(moves, "daily:game-9");
  assert.notEqual(other.get(0).eventId, first.get(0).eventId);
});

test("one reaction per move, and a revisit returns the same one", () => {
  const moves = [move(0, "great", ["opened-column"]), move(1, "normal", ["stock-draw"])];
  const reactions = reactionsFor(moves);

  assert.equal(reactions.size, 1);
  assert.equal(reactions.get(0).eventId, reactionsFor(moves).get(0).eventId);

  // The initial deal (the page's ply 0 selection) has no move to comment on.
  assert.equal(reactionAt(moves, -1), null);
  assert.equal(reactionAt(moves, 1), null);
  assert.equal(reactionAt(moves, 0).eventId, reactions.get(0).eventId);
});

test("no game key or no analysis means no commentary", () => {
  assert.equal(buildGlitchReviewReactions({ analysis: null, gameKey: GAME }).size, 0);
  assert.equal(buildGlitchReviewReactions({ analysis: { perMove: [] }, gameKey: "" }).size, 0);
  assert.equal(buildGlitchReviewReactions({ analysis: { perMove: null }, gameKey: GAME }).size, 0);
});

// ── Non-generative guarantee ──────────────────────────────────────────────

test("the selector uses no network, model or randomness", () => {
  const source = read(REVIEW_MODULE);
  assert.doesNotMatch(source, /fetch\(|https?:\/\//);
  assert.doesNotMatch(source, /openai|anthropic|Math\.random|Date\.now/);
  // The module stays client-safe: type-only imports, no runtime dependency.
  assert.doesNotMatch(source, /from\s+["']\.\.\/solitaire-duel\/analysis["'](?!\s*;)/);
  assert.match(source, /import type \{ AnalysisEventTag, MoveRating \}/);
});

test("no English review sentence is hardcoded in the module or the page", () => {
  for (const file of [REVIEW_MODULE, REVIEW_PAGE]) {
    const source = read(file);
    assert.doesNotMatch(source, /Okay, that was clever/);
    assert.doesNotMatch(source, /Now THAT was a smart move/);
    assert.doesNotMatch(source, /That move closed off an important possibility/);
  }
});

// ── Review panel wiring ───────────────────────────────────────────────────

test("the review panel renders GLITCH inline from the selector", () => {
  const page = read(REVIEW_PAGE);

  assert.equal((page.match(/<GlitchSay/g) ?? []).length, 1);
  assert.match(page, /placement="inline"/);
  assert.match(page, /buildGlitchReviewReactions\(/);
  assert.match(page, /message=\{t\(glitchReaction\.messageKey\)\}/);
  assert.match(page, /expression=\{glitchReaction\.expression\}/);
  assert.match(page, /eventId=\{glitchReaction\.eventId\}/);
  assert.match(page, /priority=\{glitchReaction\.priority\}/);
  assert.match(page, /data-testid="review-glitch"/);

  // Inline page content only: the floating provider is not involved, so the
  // active-match suppression rules can never swallow the review's commentary.
  assert.doesNotMatch(page, /useGlitch\(/);
  assert.doesNotMatch(page, /GlitchProvider/);
  assert.doesNotMatch(page, /createPortal/);
});

test("silent moves render nothing and commentary follows the selected move", () => {
  const page = read(REVIEW_PAGE);
  assert.match(page, /\{glitchReaction && \(/);
  assert.match(
    page,
    /const glitchReaction =\s*selectedPly > 0 \? glitchReactions\.get\(selectedPly - 1\) \?\? null : null;/
  );
  // One map per analysis, never rebuilt per selection.
  assert.match(page, /const glitchReactions = useMemo\(/);
  assert.match(page, /\[analysis, data\],/);
});

test("the commentary adds no request and no storage of its own", () => {
  const page = read(REVIEW_PAGE);
  const block = page.slice(
    page.indexOf("GLITCH's reactions"),
    page.indexOf("Reconstruct ONLY the selected position")
  );
  assert.ok(block.length > 0, "GLITCH review block not found");
  assert.doesNotMatch(block, /fetch\(/);
  assert.doesNotMatch(block, /sessionStorage|localStorage/);
});
