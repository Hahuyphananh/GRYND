// tests/game-recommendations.test.mjs
//
// The personalization engine (src/lib/gameRecommendations.js + the tag catalog
// in src/lib/gameTags.js) and the API that serves it.
//
// What is pinned here:
//   * the tag catalog cannot drift from the casino lobby (ids, hrefs,
//     featured ORDER, and pvpMode 1v1/multi → pvp/multiplayer one-for-one);
//   * the tag vocabulary is honest — every tag discriminates, and skill/chance
//     can never both describe one game;
//   * every questionnaire option is either wired to the engine or explicitly
//     documented as analytics-only;
//   * each preference (pvp, strategy, fast-paced, casual, chance, competitive)
//     floats exactly its own slice of the catalog to the top;
//   * combinations, missing answers, incomplete answers, unknown answers and
//     existing accounts (no questionnaire) all degrade to the default order;
//   * nothing is ever hidden, scoring is explainable, and the result is
//     deterministic (no ML, no randomness, no network);
//   * the API is Clerk-authenticated with no user-id parameter, and a
//     signed-out caller gets the default order.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const {
  EXPERIENCE_MESSAGE_KEYS,
  EXPERIENCE_SIGNALS,
  GAME_TYPE_SIGNALS,
  MOTIVATION_SIGNALS,
  PERSONALIZATION_MESSAGE_KEYS,
  PRIMARY_GAME_COUNT,
  PRIMARY_GOAL_MESSAGE_KEYS,
  PRIORITY_SIGNALS,
  RECOMMENDATION_WEIGHTS,
  buildSignals,
  normalizePreferences,
  primaryGoalMessageKey,
  questionnaireCompleteness,
  rankGamesForPreferences,
  recommendGames,
  shouldShowPersonalizedSection,
} = await import("../src/lib/gameRecommendations.js");

const { DEFAULT_GAME_ORDER, GAMES_BY_ID, GAME_CATALOG, GAME_TAGS, supportsTokenWager } =
  await import("../src/lib/gameTags.js");

const { QUESTIONNAIRE_QUESTIONS, getAllowedAnswers } =
  await import("../src/lib/onboardingQuestionnaire.js");

const { t } = await import("../src/lib/appTextTranslations.js");

const LOBBY = "src/app/casino/PageClient.jsx";
const ROUTE = "src/app/api/onboarding/recommendations/route.ts";
const ENGINE = "src/lib/gameRecommendations.js";
const LOCALES = ["en", "fr", "es"];

const read = (relPath) => fs.readFileSync(path.join(process.cwd(), relPath), "utf8");
const strip = (src) => src.replace(/\r\n/g, "\n");

// ── The lobby's own game list, extracted from the real source ──────────────

/** `{ ids, hrefs, pvpModes }` in lobby order, read straight out of the
 *  casino lobby's `games` array. */
function lobbyGames() {
  const lobby = strip(read(LOBBY));
  const start = lobby.indexOf("  const games = [");
  assert.ok(start > -1, "could not find the lobby's games array");
  const end = lobby.indexOf("\n  ];", start);
  assert.ok(end > start, "could not find the end of the lobby's games array");
  const block = lobby.slice(start, end);
  const all = (re) => [...block.matchAll(re)].map((m) => m[1]);
  return {
    ids: all(/leaderboardKey: "([^"]+)"/g),
    hrefs: all(/href: "([^"]+)"/g),
    pvpModes: all(/pvpMode: "([^"]+)"/g),
  };
}

const idsOf = (answers) => recommendGames(answers).recommendations.map((game) => game.id);

/** Assert that `tag` is a real preference: every tagged game ranks above every
 *  untagged one (and the tag isn't on all — or none — of the catalog). */
function assertTagFloatsToTop(answers, tag) {
  const ranked = recommendGames(answers).recommendations;
  const matching = GAME_CATALOG.filter((game) => game.tags.includes(tag));
  assert.ok(matching.length > 0, `no game is tagged ${tag}`);
  assert.ok(
    matching.length < GAME_CATALOG.length,
    `"${tag}" matches every game — not a preference`
  );
  for (const game of ranked.slice(0, matching.length)) {
    assert.ok(game.tags.includes(tag), `${game.id} ranked above a ${tag} game but is not ${tag}`);
  }
  for (const game of ranked.slice(matching.length)) {
    assert.ok(
      !game.tags.includes(tag),
      `${game.id} is ${tag} but did not rank in the ${tag} block`
    );
  }
}

// ── 1. The catalog cannot drift from the lobby ────────────────────────────

test("the tag catalog mirrors the casino lobby exactly (ids, hrefs, order)", () => {
  const { ids, hrefs } = lobbyGames();
  assert.equal(ids.length, GAME_CATALOG.length, "lobby/catalog length mismatch");
  assert.deepEqual(
    GAME_CATALOG.map((game) => game.id),
    ids,
    "catalog ids/order must match the lobby's featured order — it is the fallback order"
  );
  assert.deepEqual(
    GAME_CATALOG.map((game) => game.href),
    hrefs,
    "catalog hrefs must match the lobby's card links"
  );
  assert.deepEqual(DEFAULT_GAME_ORDER, ids);
  // No duplicate ids, and every id is addressable.
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.ok(GAMES_BY_ID[id], `GAMES_BY_ID is missing ${id}`);
});

test("pvp / multiplayer tags match the lobby's pvpMode one-for-one", () => {
  const { ids, pvpModes } = lobbyGames();
  assert.equal(pvpModes.length, ids.length);
  const expected = ids.map((id, i) => (pvpModes[i] === "multi" ? "multiplayer" : "pvp"));
  for (const game of GAME_CATALOG) {
    const want = expected[ids.indexOf(game.id)];
    assert.ok(game.tags.includes(want), `${game.id} should be tagged ${want}`);
    const other = want === "pvp" ? "multiplayer" : "pvp";
    assert.ok(!game.tags.includes(other), `${game.id} must not be tagged ${other}`);
  }
});

test("the tag vocabulary is used honestly", () => {
  for (const game of GAME_CATALOG) {
    assert.ok(game.tags.length > 0, `${game.id} has no tags`);
    assert.equal(new Set(game.tags).size, game.tags.length, `${game.id} has duplicate tags`);
    for (const tag of game.tags) {
      assert.ok(GAME_TAGS.includes(tag), `${game.id} uses unknown tag ${tag}`);
    }
    // A game whose outcome is primarily luck is not primarily ability.
    assert.ok(
      !(game.tags.includes("chance") && game.tags.includes("skill")),
      `${game.id} is tagged both chance and skill`
    );
  }
  // Every declared tag is actually used — otherwise it is dead vocabulary.
  const used = new Set(GAME_CATALOG.flatMap((game) => game.tags));
  for (const tag of GAME_TAGS) assert.ok(used.has(tag), `tag "${tag}" is never used`);
});

test("every questionnaire option is either wired up or documented as analytics-only", () => {
  // Q2 → a real tag.
  for (const value of getAllowedAnswers("game_types")) {
    const tag = GAME_TYPE_SIGNALS[value];
    assert.ok(tag, `game_types option "${value}" has no signal — it would be silently ignored`);
    assert.ok(GAME_TAGS.includes(tag), `game_types option "${value}" maps to unknown tag ${tag}`);
  }
  // Q1 → a mapping or an explicit exclusion (variety is a breadth preference).
  for (const value of getAllowedAnswers("motivation")) {
    if (value === "variety") {
      assert.equal(MOTIVATION_SIGNALS[value], undefined);
      continue;
    }
    assert.ok(MOTIVATION_SIGNALS[value], `motivation option "${value}" has no signal`);
  }
  // Q4 → a signal AND a message.
  for (const value of getAllowedAnswers("priorities")) {
    assert.ok(PRIORITY_SIGNALS[value], `priorities option "${value}" has no signal`);
    assert.ok(PRIMARY_GOAL_MESSAGE_KEYS[value], `priorities option "${value}" has no message`);
  }
  // Q3 → a message, and a signal key that exists (null = no game bias).
  for (const value of getAllowedAnswers("experience")) {
    assert.ok(EXPERIENCE_MESSAGE_KEYS[value], `experience option "${value}" has no message`);
    assert.ok(value in EXPERIENCE_SIGNALS, `experience option "${value}" has no signal entry`);
  }
  // Q5 is analytics-only and must not reach the ranking.
  const discovery = QUESTIONNAIRE_QUESTIONS.find((q) => q.key === "discovery");
  assert.match(discovery.options[0].labelKey, /\.q5\./);
  assert.equal(normalizePreferences({ discovery: "tiktok" }).game_types.length, 0);
  assert.deepEqual(Object.keys(normalizePreferences({ discovery: "tiktok" })), [
    "game_types",
    "motivation",
    "priorities",
    "experience",
  ]);
});

// ── 2. Each preference floats its own slice to the top ───────────────────

test("PvP preference ranks head-to-head duels first", () => {
  assertTagFloatsToTop({ game_types: ["pvp_duels"] }, "pvp");
  assert.equal(idsOf({ game_types: ["pvp_duels"] })[0], "roulette");
  // Same signal from Q1 ("playing against other players").
  assertTagFloatsToTop({ motivation: ["versus_players"] }, "pvp");
});

test("strategy preference ranks strategy games first", () => {
  assertTagFloatsToTop({ game_types: ["strategy"] }, "strategy");
  // Catalog order breaks the tie: Blackjack is the first strategy game.
  assert.equal(idsOf({ game_types: ["strategy"] })[0], "blackjack");
});

test("fast-paced preference ranks fast games first", () => {
  assertTagFloatsToTop({ game_types: ["fast_paced"] }, "fast_paced");
  assert.equal(idsOf({ game_types: ["fast_paced"] })[0], "roulette");
});

test("casual preference ranks pick-up-and-play games first", () => {
  assertTagFloatsToTop({ game_types: ["casual"] }, "casual");
  assert.equal(idsOf({ game_types: ["casual"] })[0], "memory-grid");
  // Q1 "just having fun" leans the same way.
  assertTagFloatsToTop({ motivation: ["fun"] }, "casual");
});

test("luck/chance preference ranks high-variance games first", () => {
  assertTagFloatsToTop({ game_types: ["luck_chance"] }, "chance");
  assert.equal(idsOf({ game_types: ["luck_chance"] })[0], "roulette");
});

test("competitive preference ranks ladder-style games first", () => {
  assertTagFloatsToTop({ game_types: ["competitive"] }, "competitive");
  assert.equal(idsOf({ game_types: ["competitive"] })[0], "mines-pvp");
  // Q4 "ranking up" and Q1 "competition" push the same way.
  assertTagFloatsToTop({ priorities: ["ranking_up"] }, "competitive");
  assertTagFloatsToTop({ motivation: ["competition"] }, "competitive");
});

test("goal-driven preferences (winning, tokens, skill) work too", () => {
  // Winning / improving skills → skill games.
  assertTagFloatsToTop({ priorities: ["winning"] }, "skill");
  assertTagFloatsToTop({ priorities: ["improving_skills"] }, "skill");
  // Earning tokens → games that support a configurable wager (real data from
  // src/lib/defaultWagers.js, not a hand tag).
  const ranked = recommendGames({ priorities: ["earning_tokens"] }).recommendations;
  const wagered = GAME_CATALOG.filter((game) => supportsTokenWager(game.id));
  assert.ok(wagered.length > 0 && wagered.length < GAME_CATALOG.length);
  for (const game of ranked.slice(0, wagered.length)) assert.ok(supportsTokenWager(game.id));
  for (const game of ranked.slice(wagered.length)) assert.ok(!supportsTokenWager(game.id));
  // Rewards (Q1) uses the same wager signal.
  assert.equal(idsOf({ motivation: ["rewards"] })[0], idsOf({ priorities: ["earning_tokens"] })[0]);
});

// ── 3. Combinations stack ────────────────────────────────────────────────

test("combination: pvp + strategy + competitive puts the ranked strategists on top", () => {
  const ranked = recommendGames({
    game_types: ["pvp_duels", "strategy", "competitive"],
    motivation: ["competition"],
    experience: "experienced",
    priorities: ["ranking_up"],
  }).recommendations;
  // pvp(10) + strategy(10) + competitive(10) + competition(4) + ranking_up(4)
  // + experienced(2) = 40; only Chess and Hex Duel are tagged all three.
  assert.deepEqual(
    ranked.slice(0, 2).map((g) => g.id),
    ["chess", "hex-duel"]
  );
  assert.equal(ranked[0].score, 40);
  for (const tag of ["pvp", "strategy", "competitive"]) {
    assert.ok(ranked[0].tags.includes(tag));
  }
  // Multiplayer strategists score lower — the pvp preference is respected.
  const towerArena = ranked.find((g) => g.id === "tower-arena");
  assert.ok(towerArena.score < ranked[0].score);
});

test("combination: chance + fun puts the casual lucky game on top", () => {
  const ranked = recommendGames({
    game_types: ["luck_chance"],
    motivation: ["fun"],
  }).recommendations;
  // Keno is the only game tagged both chance and casual: 10 + 3 = 13.
  assert.equal(ranked[0].id, "keno");
  assert.equal(
    ranked[0].score,
    RECOMMENDATION_WEIGHTS.gameType + RECOMMENDATION_WEIGHTS.motivation
  );
  // Then the remaining chance games, in featured order, ahead of casual-only.
  assert.deepEqual(
    ranked.slice(1, 6).map((g) => g.id),
    ["roulette", "mines-pvp", "plinko", "crash", "yahtzee"]
  );
});

test("combination: the same answers always produce the same order", () => {
  const answers = {
    game_types: ["strategy", "fast_paced"],
    motivation: ["rewards", "competition"],
    priorities: ["winning", "earning_tokens"],
    experience: "highly_competitive",
  };
  assert.deepEqual(recommendGames(answers), recommendGames(answers));
  const core = (input) => rankGamesForPreferences(normalizePreferences(input)).recommendations;
  assert.deepEqual(core(answers), core(answers));
  // …and the ranking does not depend on the key order of the answers object.
  const reordered = {
    experience: answers.experience,
    priorities: answers.priorities,
    motivation: answers.motivation,
    game_types: answers.game_types,
  };
  assert.deepEqual(core(reordered), core(answers));
});

// ── 4. Fallbacks (backwards compatibility) ───────────────────────────────

test("missing answers → exactly the default lobby order", () => {
  for (const answers of [null, undefined, {}, { game_types: [] }, [], 42, "nope"]) {
    const result = recommendGames(answers);
    assert.equal(result.personalized, false, `${JSON.stringify(answers)} should not personalize`);
    assert.equal(result.source, "default");
    assert.deepEqual(
      result.recommendations.map((g) => g.id),
      DEFAULT_GAME_ORDER
    );
    assert.deepEqual(
      result.recommendations.map((g) => g.score),
      DEFAULT_GAME_ORDER.map(() => 0)
    );
    assert.deepEqual(
      result.recommendations.map((g) => g.reasons),
      DEFAULT_GAME_ORDER.map(() => [])
    );
  }
});

test("incomplete or unknown answers never break the ranking", () => {
  // Partial: only one question answered → personalized, rest keeps order.
  const partial = recommendGames({ game_types: ["casual"] });
  assert.equal(partial.personalized, true);
  assert.deepEqual(
    partial.recommendations.map((g) => g.id).slice(4),
    DEFAULT_GAME_ORDER.filter((id) => !GAMES_BY_ID[id].tags.includes("casual"))
  );

  // Unknown option values, wrong types and unknown keys are dropped, leaving
  // no usable signal → default order, no crash.
  const junk = recommendGames({
    game_types: ["not_a_type", 7],
    motivation: null,
    experience: "wizard",
    priorities: ["not_a_priority"],
    extra_key: ["whatever"],
  });
  assert.equal(junk.personalized, false);
  assert.deepEqual(
    junk.recommendations.map((g) => g.id),
    DEFAULT_GAME_ORDER
  );

  // A known single answer is still honored next to junk.
  const mixed = recommendGames({ game_types: ["strategy"], experience: "wizard" });
  assert.equal(mixed.personalized, true);
  assert.equal(mixed.experienceMessageKey, null);
  assert.equal(mixed.recommendations[0].id, "blackjack");
});

test("answers that only express breadth or discovery do not reorder anything", () => {
  // "Playing different games" is a breadth preference → no signal at all.
  const variety = recommendGames({ motivation: ["variety"] });
  assert.equal(variety.personalized, false);
  assert.deepEqual(
    variety.recommendations.map((g) => g.id),
    DEFAULT_GAME_ORDER
  );
  assert.equal(buildSignals(normalizePreferences({ motivation: ["variety"] })).length, 0);

  // Discovery source is analytics-only: it can never change the ranking.
  const base = { game_types: ["strategy"], priorities: ["winning"] };
  assert.deepEqual(idsOf({ ...base, discovery: "tiktok" }), idsOf(base));
  assert.equal(normalizePreferences({ ...base, discovery: "tiktok" }).discovery, undefined);
});

test("an existing account (tutorial done, no questionnaire) keeps the default order", () => {
  // The engine is fed only questionnaire answers, so an existing player who
  // never answered gets the default order and personalized:false — the lobby's
  // normal "All Games" experience, untouched.
  const existing = recommendGames(null);
  assert.equal(existing.personalized, false);
  assert.equal(existing.source, "default");
  assert.equal(existing.messageKey, null);
  assert.equal(existing.experienceMessageKey, null);
  assert.deepEqual(existing.primaryGameIds, DEFAULT_GAME_ORDER.slice(0, PRIMARY_GAME_COUNT));
});

test("a new account with answers is personalized (and still sees every game)", () => {
  const fresh = recommendGames({
    game_types: ["pvp_duels", "fast_paced"],
    motivation: ["competition", "fun"],
    experience: "new",
    priorities: ["fun"],
    discovery: "tiktok",
  });
  assert.equal(fresh.personalized, true);
  assert.equal(fresh.source, "questionnaire");
  assert.notDeepEqual(
    fresh.recommendations.map((g) => g.id),
    DEFAULT_GAME_ORDER
  );
});

// ── 5. Nothing is hidden, scoring is explainable ─────────────────────────

test("every game is always returned — personalization only reorders", () => {
  for (const answers of [
    null,
    { game_types: ["pvp_duels"] },
    { game_types: ["casual", "strategy"] },
  ]) {
    const ranked = recommendGames(answers).recommendations;
    assert.equal(ranked.length, GAME_CATALOG.length);
    assert.deepEqual(
      [...ranked.map((g) => g.id)].sort(),
      [...GAME_CATALOG.map((g) => g.id)].sort()
    );
  }
});

test("scores are the sum of the stated weights, and every score is explained", () => {
  const ranked = recommendGames({
    game_types: ["strategy"],
    priorities: ["ranking_up"],
  }).recommendations;
  const chess = ranked.find((g) => g.id === "chess");
  assert.equal(chess.score, RECOMMENDATION_WEIGHTS.gameType + RECOMMENDATION_WEIGHTS.priority);
  assert.deepEqual(chess.reasons, ["game_type:strategy", "priority:ranking_up"]);
  // A game nothing matched is explained as such.
  const roulette = ranked.find((g) => g.id === "roulette");
  assert.equal(roulette.score, 0);
  assert.deepEqual(roulette.reasons, []);
  // Every reason code names its question and its answer value.
  for (const game of ranked) {
    for (const reason of game.reasons) {
      const [source, value] = reason.split(":");
      assert.ok(["game_type", "motivation", "priority", "experience"].includes(source), reason);
      const allowed =
        source === "experience"
          ? getAllowedAnswers("experience")
          : getAllowedAnswers(
              source === "priority"
                ? "priorities"
                : source === "motivation"
                  ? "motivation"
                  : "game_types"
            );
      assert.ok(allowed.includes(value), `${reason} is not a questionnaire option`);
    }
  }
});

test("the payload exposes primary suggestions and copy keys", () => {
  const result = recommendGames({ priorities: ["ranking_up"], experience: "experienced" });
  assert.equal(result.primaryGameIds.length, PRIMARY_GAME_COUNT);
  assert.deepEqual(
    result.primaryGameIds,
    result.recommendations.slice(0, PRIMARY_GAME_COUNT).map((g) => g.id)
  );
  assert.equal(result.messageKey, "onboarding.personalization.goals.ranking_up");
  assert.equal(result.experienceMessageKey, "onboarding.personalization.experience.experienced");
  // Goal copy follows catalog order of the selected priorities (not click order).
  assert.equal(
    primaryGoalMessageKey(normalizePreferences({ priorities: ["earning_tokens", "winning"] })),
    "onboarding.personalization.goals.winning"
  );
  assert.equal(primaryGoalMessageKey(normalizePreferences({})), null);
  assert.equal(
    recommendGames({ experience: "new" }).experienceMessageKey,
    "onboarding.personalization.experience.new"
  );
});

// ── 6. Deterministic, no ML, no I/O ──────────────────────────────────────

test("the engine is deterministic and dependency-free (no ML, no network)", () => {
  const source = read(ENGINE);
  assert.doesNotMatch(source, /Math\.random/, "scoring must be deterministic");
  assert.doesNotMatch(source, /\bfetch\(/, "the engine must not do I/O");
  assert.doesNotMatch(source, /\brequire\(/);
  const imports = [...source.matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(imports.sort(), ["./gameTags", "./onboardingQuestionnaire"]);
  // Deterministic across instances and independent of input key order.
  const a = { game_types: ["strategy"], motivation: ["competition"] };
  const b = { motivation: ["competition"], game_types: ["strategy"] };
  assert.deepEqual(idsOf(a), idsOf(b));
  assert.deepEqual(idsOf(a), idsOf(a));
});

// ── 6b. Completeness + the personalized-surface gate ─────────────────────

/** A complete questionnaire submission (every catalog question answered). */
const FULL_ANSWERS = {
  motivation: ["competition"],
  game_types: ["strategy", "pvp_duels"],
  experience: "new",
  priorities: ["winning"],
  discovery: "tiktok",
};

test("completeness uses the same required-questions rule as the write API", () => {
  assert.equal(questionnaireCompleteness(FULL_ANSWERS).complete, true);
  assert.deepEqual(questionnaireCompleteness(FULL_ANSWERS).missingQuestionKeys, []);

  const partial = questionnaireCompleteness({ game_types: ["strategy"] });
  assert.equal(partial.complete, false);
  assert.deepEqual(partial.missingQuestionKeys, [
    "motivation",
    "experience",
    "priorities",
    "discovery",
  ]);

  // An unknown option value is not an answer.
  assert.equal(
    questionnaireCompleteness({ ...FULL_ANSWERS, experience: "wizard" }).complete,
    false
  );
  assert.equal(questionnaireCompleteness({ ...FULL_ANSWERS, priorities: [] }).complete, false);
  for (const answers of [null, undefined, {}, [], 42, "nope"]) {
    assert.equal(questionnaireCompleteness(answers).complete, false, String(answers));
  }
  // The analytics-only question still counts: it is required at write time.
  const { discovery, ...withoutDiscovery } = FULL_ANSWERS;
  assert.equal(questionnaireCompleteness(withoutDiscovery).complete, false);
});

test("a partial answer set still ranks, but is not complete", () => {
  const partial = recommendGames({ game_types: ["strategy"] });
  assert.equal(partial.personalized, true);
  assert.equal(partial.complete, false);
  assert.equal(partial.source, "questionnaire");
  assert.equal(partial.recommendations[0].id, "blackjack");

  const full = recommendGames(FULL_ANSWERS);
  assert.equal(full.personalized, true);
  assert.equal(full.complete, true);

  assert.equal(recommendGames(null).complete, false);
  assert.equal(recommendGames({}).complete, false);
});

test("the personalized-surface gate is strict and fails closed", () => {
  const good = recommendGames(FULL_ANSWERS);
  assert.equal(shouldShowPersonalizedSection(good), true);

  for (const payload of [
    null,
    undefined,
    "nope",
    [],
    {},
    { ...good, success: false, error: "Failed to load recommendations" },
    // An explicit failure is rejected even if it somehow carried the fields.
    { success: false, ...good },
    { ...good, personalized: false },
    { ...good, complete: false },
    { ...good, primaryGameIds: [] },
    { ...good, primaryGameIds: null },
    { ...good, primaryGameIds: "chess" },
  ]) {
    assert.equal(shouldShowPersonalizedSection(payload), false, JSON.stringify(payload));
  }

  // The two realistic non-personalized payloads.
  assert.equal(shouldShowPersonalizedSection(recommendGames({ game_types: ["strategy"] })), false);
  assert.equal(shouldShowPersonalizedSection(recommendGames(null)), false);
});

// ── 7. API contract ──────────────────────────────────────────────────────

test("the recommendations API is authenticated and takes no user id", () => {
  const src = strip(read(ROUTE));
  // Clerk session is the only identity source…
  assert.match(src, /const \{ userId \} = await auth\(\);/);
  assert.match(src, /where\(eq\(users\.clerkId, userId\)\)/);
  // …and there is no way to ask for someone else's preferences.
  assert.doesNotMatch(src, /searchParams/);
  assert.doesNotMatch(src, /request\.url|request\.json/);
  assert.doesNotMatch(src, /user_?[Ii]d\s*[:=]\s*(searchParams|body|\()/);
  assert.doesNotMatch(src, /\brequest\b\s*[,)]/);
  // Signed-out callers get the default order (no lookup, no user data).
  assert.match(src, /if \(!userId\) return payload\(null\);/);
  // A player who never answered costs one query: responses are only read once
  // the questionnaire is complete.
  assert.match(src, /if \(user\.questionnaireCompletedAt == null\) return payload\(null\);/);
  assert.match(src, /export async function GET\(\)/);
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    assert.doesNotMatch(src, new RegExp(`export async function ${method}`), `unexpected ${method}`);
  }
  // Errors never leak a stack or a partial payload.
  assert.match(src, /status: 500/);
  assert.doesNotMatch(src, /questionnaireDismissedAt/);
});

test("the API returns the engine payload unchanged", () => {
  const src = strip(read(ROUTE));
  assert.match(src, /recommendGames\(answers\)/);
  assert.match(src, /groupStoredResponses\(rows\)/);
});

// ── 8. Localization ──────────────────────────────────────────────────────

test("every personalization message key exists in all three locales", () => {
  assert.ok(PERSONALIZATION_MESSAGE_KEYS.length >= 11);
  for (const locale of LOCALES) {
    for (const key of PERSONALIZATION_MESSAGE_KEYS) {
      assert.notEqual(t(locale, key), key, `${locale} is missing ${key}`);
    }
  }
});

test("the English follow-up copy matches the agreed product wording", () => {
  assert.equal(t("en", PRIMARY_GOAL_MESSAGE_KEYS.winning), "Ready to compete?");
  assert.equal(t("en", PRIMARY_GOAL_MESSAGE_KEYS.ranking_up), "Climb the rankings.");
  assert.equal(
    t("en", PRIMARY_GOAL_MESSAGE_KEYS.earning_tokens),
    "Find games where you can put your tokens to work."
  );
  assert.equal(
    t("en", PRIMARY_GOAL_MESSAGE_KEYS.improving_skills),
    "Practice and sharpen your game."
  );
  assert.equal(t("en", PRIMARY_GOAL_MESSAGE_KEYS.fun), "Here's something you might enjoy.");
});
