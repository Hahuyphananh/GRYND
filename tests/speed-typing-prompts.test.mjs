/**
 * speed-typing-prompts.test.mjs
 *
 * The PROMPT SYSTEM: server-authoritative prompt selection for Speed Typing.
 *
 * A "prompt" is a passage — the exact text both seats race on. The library
 * (src/lib/speed-typing/passages.ts) is the one place a prompt is defined, and
 * the `(id, version)` pair stored on the match row is the one place a selection
 * is frozen. These tests prove the five properties the race depends on:
 *
 *   1. a match receives exactly ONE prompt;
 *   2. both players receive the SAME prompt;
 *   3. the prompt cannot change after the match is armed;
 *   4. invalid / retired prompts can never be selected;
 *   5. the catalog metadata is complete and self-consistent.
 *
 * Plus the exposure rule: a client is told WHICH prompt it races, never the
 * selection inputs (the race seed / catalog index) the server used to choose it.
 *
 * There is no randomness anywhere here: selection is a pure function of the
 * seed, so two servers, a replay and this test all resolve the same prompt.
 *
 * Run:  node --import tsx --test tests/speed-typing-prompts.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  ENABLED_PASSAGES,
  ENABLED_PASSAGE_IDS,
  PASSAGE_DIFFICULTIES,
  PASSAGE_IDS,
  PASSAGE_LANGUAGES,
  PASSAGE_VERSION,
  SPEED_TYPING_PASSAGES,
  isEnabledPassageId,
  isPassageId,
  passageById,
  passageForRow,
  passageMeta,
  passageWordCount,
  selectPassageForSeed,
} from "../src/lib/speed-typing/passages.ts";
import { createRaceState, raceViewFor } from "../src/lib/speed-typing/rules.ts";
import { SEAT } from "../src/lib/speed-typing/constants.ts";

const read = (rel) => fs.readFileSync(rel, "utf8");
const code = (rel) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");

const STORE = "src/lib/speed-typing/serverStore.ts";

const GO = 1_700_000_000_000;

/** An ARMED match row, exactly the shape the store's arming step writes. */
function armedRow({ seed = 987654, ...overrides } = {}) {
  const passage = selectPassageForSeed({ seed });
  assert.ok(passage, `seed ${seed} must select a prompt for the fixture`);
  return {
    id: "55555555-5555-4555-8555-555555555555",
    player1Id: "a",
    player2Id: "b",
    status: "playing",
    raceSeed: seed,
    passageId: passage.id,
    passageVersion: PASSAGE_VERSION,
    goAt: new Date(GO),
    revision: 1,
    raceState: createRaceState({ version: 1 }),
    ...overrides,
  };
}

// ════════════════════════════════════════════════════════════════════════
// 1. A match receives exactly one prompt
// ════════════════════════════════════════════════════════════════════════

test("one prompt: an armed match resolves to exactly one passage, every time", () => {
  const row = armedRow();
  const resolved = passageForRow(row);
  assert.ok(resolved, "an armed row must resolve a prompt");
  assert.equal(typeof resolved.id, "string");
  assert.equal(typeof resolved.text, "string");

  // One id, one text — never a list, and never a fresh pick per read: the same
  // row, read twice, resolves the same single passage.
  assert.equal(passageForRow(row).id, resolved.id);
  assert.equal(passageForRow({ ...row }).text, resolved.text);

  // The row stores the pair it raced, and that stored pair is what resolves.
  assert.equal(typeof row.passageId, "string");
  assert.equal(resolved.id, row.passageId);

  // The race view carries exactly one prompt, for each seat.
  for (const seat of [SEAT.PLAYER1, SEAT.PLAYER2]) {
    const view = raceViewFor({ match: row, seat, nowMs: GO });
    assert.equal(view.passageId, row.passageId);
    assert.equal(view.prompt?.id, row.passageId);
    assert.equal(view.prompt?.version, PASSAGE_VERSION);
  }
});

test("one prompt: nothing downstream lets a second prompt exist", () => {
  // The only way a prompt enters a match is `selectPassageForSeed`, called once
  // while arming, and its result is written as a single id + version pair.
  const store = code(STORE);
  assert.equal(
    (store.match(/selectPassageForSeed\(/g) ?? []).length,
    1,
    "a prompt must be selected in exactly one place",
  );
  assert.match(store, /selectPassageForSeed\(\{ seed: raceSeed, version: PASSAGE_VERSION \}\)/);
  assert.match(store, /passageId: passage\?\.id \?\? null/);
  assert.match(store, /passageVersion: PASSAGE_VERSION/);
  // There is no second table and no per-keystroke prompt: the pair lives on the
  // match row, which is the only place a race's prompt is written.
  assert.doesNotMatch(store, /insert\([^)]*[Pp]rompt/);
});

// ════════════════════════════════════════════════════════════════════════
// 2. Both players receive the same prompt
// ════════════════════════════════════════════════════════════════════════

test("same prompt: both seats are served the identical text and metadata", () => {
  for (const seed of [0, 1, 7, 12345, 4294967295]) {
    const row = armedRow({ seed });
    const p1 = raceViewFor({ match: row, seat: SEAT.PLAYER1, nowMs: GO });
    const p2 = raceViewFor({ match: row, seat: SEAT.PLAYER2, nowMs: GO });

    assert.equal(p1.passageText, p2.passageText, "the text must be identical");
    assert.equal(p1.passageId, p2.passageId);
    assert.equal(p1.passageVersion, p2.passageVersion);
    assert.deepEqual(p1.prompt, p2.prompt);
    assert.ok(p1.passageText.length > 0);

    // …and it is the canonical catalog text, not a per-client derivation.
    assert.equal(p1.passageText, passageById(row.passageId, PASSAGE_VERSION)?.text);
  }
});

test("same prompt: the seat is the only thing a view redacts — never the text", () => {
  const row = armedRow();
  const p1 = raceViewFor({ match: row, seat: SEAT.PLAYER1, nowMs: GO });
  const p2 = raceViewFor({ match: row, seat: SEAT.PLAYER2, nowMs: GO });
  // The two views differ only in the seat / self-vs-opponent projection.
  assert.equal(p1.seat, 1);
  assert.equal(p2.seat, 2);
  assert.equal(p1.seatKey, "player1");
  assert.equal(p2.seatKey, "player2");
  assert.equal(p1.passageText, p2.passageText);
});

// ════════════════════════════════════════════════════════════════════════
// 3. The prompt cannot change after the match starts
// ════════════════════════════════════════════════════════════════════════

test("fixed: the stored prompt outranks any later re-derivation", () => {
  const row = armedRow({ seed: 987654 });
  const stored = passageById(row.passageId, PASSAGE_VERSION);
  assert.ok(stored);

  // Find a seed that would pick a DIFFERENT prompt, then edit the seed column to
  // it: the stored pair must still win, so neither seat can be moved onto text
  // the server never selected for this match.
  const otherSeed = [...Array(500).keys()].find(
    (seed) => selectPassageForSeed({ seed })?.id !== stored.id,
  );
  assert.ok(otherSeed != null, "the catalog must contain more than one prompt");
  assert.equal(passageForRow({ ...row, raceSeed: otherSeed }).id, stored.id);
  assert.equal(passageForRow({ ...row, raceSeed: otherSeed }).text, stored.text);
});

test("fixed: a RETIRED prompt still resolves for a match already armed with it", () => {
  const retired = SPEED_TYPING_PASSAGES.find((passage) => !passage.enabled);
  assert.ok(retired, "the catalog must contain a retired prompt to prove this");
  const row = {
    raceSeed: null,
    passageId: retired.id,
    passageVersion: PASSAGE_VERSION,
  };
  assert.equal(passageForRow(row)?.id, retired.id);
  assert.equal(passageForRow(row)?.text, retired.text);
});

test("fixed: arming is idempotent — an armed race is never re-armed", () => {
  // `armRace` exists to cover legacy/retried rows; calling it on a row that
  // already carries a GO instant and a seed must return without touching them,
  // so a retry can never restart a live race on a fresh prompt.
  const store = code(STORE);
  assert.match(
    store,
    /if \(instantFromDate\(match\.goAt\) != null && match\.raceSeed != null\) \{\s*return \{ match, armed: false \}/,
  );
});

// ════════════════════════════════════════════════════════════════════════
// 4. Invalid / retired prompts can never be selected
// ════════════════════════════════════════════════════════════════════════

test("selectable: a retired prompt can never be chosen for a new match", () => {
  const retired = SPEED_TYPING_PASSAGES.filter((passage) => !passage.enabled);
  assert.ok(retired.length >= 1, "the fixture needs at least one retired prompt");
  const enabledIds = new Set(ENABLED_PASSAGE_IDS);

  for (const passage of retired) {
    assert.equal(enabledIds.has(passage.id), false);
    assert.equal(isEnabledPassageId(passage.id), false);
    // …yet it is still a real catalog id, so an armed match verifies.
    assert.equal(isPassageId(passage.id), true);
    assert.equal(passageById(passage.id, PASSAGE_VERSION)?.id, passage.id);
  }

  // A wide seed sweep can only ever land on a selectable prompt.
  for (let seed = 0; seed < 2000; seed += 1) {
    const chosen = selectPassageForSeed({ seed });
    assert.ok(chosen, `seed ${seed} selected nothing`);
    assert.equal(chosen.enabled, true, `seed ${seed} selected a retired prompt`);
    assert.equal(enabledIds.has(chosen.id), true);
  }
});

test("selectable: an unknown id, version, language or difficulty selects nothing", () => {
  assert.equal(passageById("pt-99", PASSAGE_VERSION), null);
  assert.equal(passageById("pt-01", PASSAGE_VERSION + 1), null);
  assert.equal(selectPassageForSeed({ seed: 1, version: PASSAGE_VERSION + 1 }), null);

  // A filter nothing satisfies must FAIL CLOSED — the server refuses to arm
  // rather than quietly racing an unsupported language or difficulty.
  assert.equal(selectPassageForSeed({ seed: 1, language: "xx" }), null);
  assert.equal(selectPassageForSeed({ seed: 1, difficulty: "impossible" }), null);

  // …and a supported filter selects only a matching prompt.
  const english = selectPassageForSeed({ seed: 1, language: "en" });
  assert.ok(english);
  assert.equal(english.language, "en");
  for (const difficulty of PASSAGE_DIFFICULTIES) {
    const chosen = selectPassageForSeed({ seed: 42, difficulty });
    assert.ok(chosen, `no enabled prompt for difficulty ${difficulty}`);
    assert.equal(chosen.difficulty, difficulty);
    assert.equal(chosen.enabled, true);
  }
});

// ════════════════════════════════════════════════════════════════════════
// 5. Prompt metadata is complete and consistent
// ════════════════════════════════════════════════════════════════════════

test("metadata: every catalog entry is complete, coherent and self-consistent", () => {
  assert.ok(SPEED_TYPING_PASSAGES.length >= 8, "a small catalog would repeat quickly");
  const ids = new Set();

  for (const passage of SPEED_TYPING_PASSAGES) {
    assert.match(passage.id, /^pt-[0-9]{2}$/);
    assert.equal(ids.has(passage.id), false, `duplicate id ${passage.id}`);
    ids.add(passage.id);

    assert.equal(typeof passage.text, "string");
    assert.ok(passage.text.length > 0);
    assert.equal(passage.text, passage.text.trim());
    assert.equal(
      passage.charCount,
      passage.text.length,
      `${passage.id}: charCount is derived and cannot drift`,
    );
    assert.match(passage.text, /^[\x20-\x7E]+$/, `${passage.id} must be plain ASCII`);
    assert.doesNotMatch(passage.text, /"/, `${passage.id} must not need an escaped quote`);
    assert.doesNotMatch(passage.text, /\s{2,}/, `${passage.id} must not rely on double spaces`);

    assert.ok(PASSAGE_LANGUAGES.includes(passage.language), `${passage.id} language`);
    assert.ok(PASSAGE_DIFFICULTIES.includes(passage.difficulty), `${passage.id} difficulty`);
    assert.equal(typeof passage.enabled, "boolean", `${passage.id} enabled`);

    const words = passageWordCount(passage.text);
    assert.ok(words >= 18 && words <= 60, `${passage.id} has ${words} words`);
  }

  // The id lists agree with the catalog and with the selectable subset.
  assert.deepEqual(PASSAGE_IDS, SPEED_TYPING_PASSAGES.map((passage) => passage.id));
  assert.deepEqual(
    ENABLED_PASSAGE_IDS,
    SPEED_TYPING_PASSAGES.filter((passage) => passage.enabled).map((passage) => passage.id),
  );
  assert.equal(ENABLED_PASSAGES.length, ENABLED_PASSAGE_IDS.length);
  assert.ok(ENABLED_PASSAGES.length >= 1);

  // Every difficulty is represented among the selectable prompts, so a future
  // difficulty filter can never come up empty for a shipped tier.
  for (const difficulty of PASSAGE_DIFFICULTIES) {
    assert.ok(
      ENABLED_PASSAGES.some((passage) => passage.difficulty === difficulty),
      `no selectable ${difficulty} prompt`,
    );
  }
});

test("metadata: the public metadata is a faithful, non-secret projection", () => {
  const passage = ENABLED_PASSAGES[0];
  assert.deepEqual(passageMeta(passage), {
    id: passage.id,
    version: PASSAGE_VERSION,
    difficulty: passage.difficulty,
    language: passage.language,
    charCount: passage.charCount,
  });
  assert.equal(passageMeta(null), null);
  assert.equal(passageMeta(undefined), null);
  // The metadata of a resolved row matches the catalog entry.
  const row = armedRow({ seed: 42 });
  assert.deepEqual(passageMeta(passageForRow(row)), passageMeta(passageById(row.passageId, PASSAGE_VERSION)));
});

// ════════════════════════════════════════════════════════════════════════
// Exposure — the prompt, never the selection inputs
// ════════════════════════════════════════════════════════════════════════

test("exposure: a participant is told the prompt, never how it was chosen", () => {
  const row = armedRow();
  for (const seat of [SEAT.PLAYER1, SEAT.PLAYER2]) {
    const view = raceViewFor({ match: row, seat, nowMs: GO });
    assert.equal("raceSeed" in view, false, "the seed is a selection input, not a client fact");
    assert.equal("passageIndex" in view, false);
    assert.doesNotMatch(JSON.stringify(view), /raceSeed|passageIndex/);
    // The metadata the client DOES get is limited to text facts.
    assert.deepEqual(Object.keys(view.prompt).sort(), [
      "charCount",
      "difficulty",
      "id",
      "language",
      "version",
    ]);
  }

  // The lifecycle DTO — the public read path — stays free of the prompt too, so
  // a non-participant can never learn which text a race is using.
  const store = read(STORE);
  const dto = store.slice(store.indexOf("export function matchToDto("));
  const body = dto.slice(0, dto.indexOf("\n}\n"));
  assert.doesNotMatch(body, /raceSeed|passage|prompt|text/i);
});
