/**
 * solitaire-bot-dialogue.test.mjs
 *
 * Phase 1 of the Solitaire opponent voices: personality data and the dialogue
 * library. No detection, no selection, no UI — so the things worth pinning are
 * the contracts a later phase will rely on:
 *
 *   1. ROSTER — six personalities, same ids and order as `bots.ts`, no extras,
 *      and the sixth keeps the storage id `perfect` while speaking as Glitch.
 *   2. LIBRARY — every supported character/event combination has 6–8 lines,
 *      identical translation keys in EN / FR / ES, and no orphan copy.
 *   3. CONTEXT — the event catalogue documents what may and may not be
 *      claimed, every event is supported by someone, and no win/loss line
 *      promises a reward.
 *   4. ISOLATION — the definitions never import the AI/rules/store engines.
 *
 * Run: npm run test:solitaire-bot-dialogue
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const { SOLITAIRE_BOTS, SOLITAIRE_BOT_BY_ID } = await import(
  "../src/lib/solitaire-duel/bots.ts"
);
const {
  SOLITAIRE_BOT_PERSONALITIES,
  SOLITAIRE_BOT_PERSONALITY_LIST,
} = await import("../src/lib/solitaire-duel/botPersonalities.ts");
const {
  DIALOGUE_EVENTS,
  DIALOGUE_EVENT_CATEGORIES,
  DIALOGUE_EVENT_TYPES,
  DIALOGUE_VARIATIONS_MIN,
  DIALOGUE_VARIATIONS_MAX,
  SOLITAIRE_BOT_DIALOGUE,
  SOLITAIRE_BOT_DIALOGUE_LIST,
  ALL_SOLITAIRE_DIALOGUE_KEYS,
  solitaireBotDialogueKey,
} = await import("../src/lib/solitaire-duel/dialogueLines.ts");
const { APP_TEXT_TRANSLATIONS } = await import(
  "../src/lib/appTextTranslations.js"
);

const LOCALES = ["en", "fr", "es"];

/** Events each character is expected to support, with the line count. */
const EXPECTED_SUPPORT = {
  rookie: 16,
  felix: 13,
  ace: 10,
  professor: 11,
  grandmaster: 8,
  perfect: 6,
};

const MAX_LINE_LENGTH = 100;

const read = (relPath) =>
  fs.readFileSync(path.join(process.cwd(), relPath), "utf8");

const resolve = (locale, key) =>
  key.split(".").reduce((node, part) => node?.[part], locale);

const flatKeys = (node, prefix = "") =>
  Object.entries(node).flatMap(([key, value]) =>
    typeof value === "string"
      ? [`${prefix}${key}`]
      : flatKeys(value, `${prefix}${key}.`),
  );

// ── Roster and identity ───────────────────────────────────────────────────

test("all six existing bots have a personality, in roster order", () => {
  const rosterIds = SOLITAIRE_BOTS.map((bot) => bot.id);
  assert.deepEqual(
    SOLITAIRE_BOT_PERSONALITY_LIST.map((personality) => personality.id),
    rosterIds,
  );
  assert.equal(SOLITAIRE_BOT_PERSONALITY_LIST.length, 6);
});

test("no additional bot ids are introduced", () => {
  const rosterIds = SOLITAIRE_BOTS.map((bot) => bot.id).sort();
  const personalityIds = Object.keys(SOLITAIRE_BOT_PERSONALITIES).sort();
  assert.deepEqual(personalityIds, rosterIds);
  assert.deepEqual(
    SOLITAIRE_BOT_DIALOGUE_LIST.map((dialogue) => dialogue.id),
    SOLITAIRE_BOTS.map((bot) => bot.id),
  );
});

test("Glitch keeps the stable internal id `perfect`", () => {
  assert.equal(SOLITAIRE_BOT_BY_ID.perfect.id, "perfect");
  assert.match(read("src/lib/solitaire-duel/bots.ts"), /id: "perfect"/);

  const glitch = SOLITAIRE_BOT_PERSONALITIES.perfect;
  assert.equal(glitch.id, "perfect");
  assert.equal(glitch.characterName, "Glitch");
  assert.equal(glitch.rosterName, "Perfect");
  assert.equal(SOLITAIRE_BOT_DIALOGUE.perfect.id, "perfect");
  assert.equal(SOLITAIRE_BOT_DIALOGUE.perfect.characterName, "Glitch");
});

test("Glitch is a distinct character, not the floating app mascot", () => {
  const glitch = SOLITAIRE_BOT_PERSONALITIES.perfect;
  assert.equal(glitch.speaksAsAppMascot, false);
  assert.equal(glitch.frequency, "rare");
  assert.ok(
    glitch.avoids.some((rule) => /mascot/i.test(rule)),
    "Glitch must explicitly avoid speaking as the app mascot",
  );

  // Speaks less than every other opponent.
  for (const other of SOLITAIRE_BOT_PERSONALITY_LIST) {
    if (other.id === "perfect") continue;
    assert.ok(
      glitch.maxLinesPerMatch < other.maxLinesPerMatch,
      `Glitch (${glitch.maxLinesPerMatch}) should speak less than ${other.id} (${other.maxLinesPerMatch})`,
    );
    assert.ok(glitch.minIntervalMs > other.minIntervalMs);
  }

  // Every personality is the opponent, never the mascot.
  for (const personality of SOLITAIRE_BOT_PERSONALITY_LIST) {
    assert.equal(personality.speaksAsAppMascot, false);
  }

  // Copy lives in its own namespace, not in `glitch.*`.
  for (const key of ALL_SOLITAIRE_DIALOGUE_KEYS) {
    assert.ok(key.startsWith("solitaireBots."), key);
    assert.ok(!key.startsWith("glitch."), key);
  }
});

test("each personality declares tone, vocabulary and frequency", () => {
  for (const personality of SOLITAIRE_BOT_PERSONALITY_LIST) {
    assert.ok(personality.description.length > 40, personality.id);
    assert.ok(personality.tone.length >= 2, personality.id);
    assert.ok(personality.vocabulary.length >= 2, personality.id);
    assert.ok(personality.avoids.length >= 2, personality.id);
    assert.equal(
      typeof personality.maxLinesPerMatch,
      "number",
      personality.id,
    );
    assert.equal(typeof personality.minIntervalMs, "number", personality.id);
    assert.ok(
      ["frequent", "steady", "measured", "rare"].includes(
        personality.frequency,
      ),
      personality.id,
    );
  }
});

// ── Event catalogue ───────────────────────────────────────────────────────

test("all four event categories are documented with semantics", () => {
  assert.equal(DIALOGUE_EVENTS.length, 16);
  assert.equal(new Set(DIALOGUE_EVENT_TYPES).size, DIALOGUE_EVENTS.length);

  for (const category of DIALOGUE_EVENT_CATEGORIES) {
    const inCategory = DIALOGUE_EVENTS.filter(
      (event) => event.category === category,
    );
    assert.ok(inCategory.length > 0, `no events documented for ${category}`);
  }

  for (const event of DIALOGUE_EVENTS) {
    assert.ok(event.label.length > 0, event.type);
    assert.ok(event.requires.length > 20, `${event.type} needs a requires rule`);
    assert.ok(
      event.mustNotClaim.length > 10,
      `${event.type} needs a mustNotClaim rule`,
    );
  }

  // Every documented event is actually used by at least one character.
  const supported = new Set(
    SOLITAIRE_BOT_DIALOGUE_LIST.flatMap((dialogue) => dialogue.supportedEvents),
  );
  for (const type of DIALOGUE_EVENT_TYPES) {
    assert.ok(supported.has(type), `no character supports ${type}`);
  }
});

// ── Library coverage ─────────────────────────────────────────────────────

test("every character supports the expected number of events", () => {
  for (const [botId, expected] of Object.entries(EXPECTED_SUPPORT)) {
    const dialogue = SOLITAIRE_BOT_DIALOGUE[botId];
    assert.equal(
      dialogue.supportedEvents.length,
      expected,
      `${botId} supports ${dialogue.supportedEvents.length} events`,
    );

    const personality = SOLITAIRE_BOT_PERSONALITIES[botId];
    assert.deepEqual(
      [...dialogue.supportedEvents].sort(),
      [...personality.supportedEvents].sort(),
    );
  }
});

test("every supported combination has 6–8 variations", () => {
  for (const dialogue of SOLITAIRE_BOT_DIALOGUE_LIST) {
    for (const event of dialogue.supportedEvents) {
      const keys = dialogue.lines[event];
      assert.ok(Array.isArray(keys), `${dialogue.id}.${event} has no lines`);
      assert.ok(
        keys.length >= DIALOGUE_VARIATIONS_MIN &&
          keys.length <= DIALOGUE_VARIATIONS_MAX,
        `${dialogue.id}.${event} has ${keys.length} variations`,
      );
    }
  }
});

test("unsupported events have no keys", () => {
  for (const dialogue of SOLITAIRE_BOT_DIALOGUE_LIST) {
    for (const type of DIALOGUE_EVENT_TYPES) {
      if (dialogue.supportedEvents.includes(type)) continue;
      assert.equal(
        dialogue.lines[type],
        undefined,
        `${dialogue.id} should not have ${type} lines`,
      );
    }
  }
});

test("translation keys follow the documented namespace", () => {
  for (const dialogue of SOLITAIRE_BOT_DIALOGUE_LIST) {
    for (const event of dialogue.supportedEvents) {
      dialogue.lines[event].forEach((key, index) => {
        assert.equal(
          key,
          `solitaireBots.${dialogue.id}.${event}.${index}`,
        );
        assert.equal(solitaireBotDialogueKey(dialogue.id, event, index), key);
      });
    }
  }
});

// ── Translations ─────────────────────────────────────────────────────────

test("every line exists in English, French and Spanish", () => {
  for (const locale of LOCALES) {
    const bundle = APP_TEXT_TRANSLATIONS[locale];
    assert.ok(bundle, `missing locale ${locale}`);
    assert.ok(bundle.solitaireBots, `missing solitaireBots in ${locale}`);

    for (const key of ALL_SOLITAIRE_DIALOGUE_KEYS) {
      const value = resolve(bundle, key);
      assert.equal(
        typeof value,
        "string",
        `${locale} is missing ${key} — the UI would fall back silently`,
      );
      assert.ok(value.trim().length > 0, `${locale}.${key} is empty`);
    }
  }
});

test("all three locales expose exactly the same dialogue keys", () => {
  const reference = flatKeys(
    APP_TEXT_TRANSLATIONS.en.solitaireBots,
    "solitaireBots.",
  ).sort();
  assert.deepEqual(reference, [...ALL_SOLITAIRE_DIALOGUE_KEYS].sort());

  for (const locale of LOCALES.slice(1)) {
    assert.deepEqual(
      flatKeys(
        APP_TEXT_TRANSLATIONS[locale].solitaireBots,
        "solitaireBots.",
      ).sort(),
      reference,
      `${locale} key set differs from en`,
    );
  }
});

test("no orphan copy exists outside the declared library", () => {
  const declared = new Set(ALL_SOLITAIRE_DIALOGUE_KEYS);
  for (const key of flatKeys(
    APP_TEXT_TRANSLATIONS.en.solitaireBots,
    "solitaireBots.",
  )) {
    assert.ok(declared.has(key), `${key} is not referenced by the library`);
  }
});

test("lines are short enough for a mobile speech bubble", () => {
  for (const locale of LOCALES) {
    const bundle = APP_TEXT_TRANSLATIONS[locale];
    for (const key of ALL_SOLITAIRE_DIALOGUE_KEYS) {
      const line = resolve(bundle, key);
      assert.ok(
        line.length <= MAX_LINE_LENGTH,
        `${locale}.${key} is ${line.length} chars: ${line}`,
      );
      assert.ok(line.length >= 4, `${locale}.${key} is too short: ${line}`);
    }
  }
});

test("a line is never reused verbatim within or across characters", () => {
  for (const locale of LOCALES) {
    const bundle = APP_TEXT_TRANSLATIONS[locale];
    const seen = new Map();
    for (const key of ALL_SOLITAIRE_DIALOGUE_KEYS) {
      const line = resolve(bundle, key).trim().toLowerCase();
      const previous = seen.get(line);
      assert.equal(
        previous,
        undefined,
        `${locale}: "${line}" is used by both ${previous} and ${key}`,
      );
      seen.set(line, key);
    }
  }
});

test("win and loss lines never promise a reward", () => {
  const forbidden = [
    "trophy",
    "trophée",
    "trofeo",
    "reward",
    "récompense",
    "recompensa",
    "rating",
    "elo",
    "coins",
    "pièces",
    "monedas",
    "prize",
  ];

  for (const locale of LOCALES) {
    const bundle = APP_TEXT_TRANSLATIONS[locale];
    for (const dialogue of SOLITAIRE_BOT_DIALOGUE_LIST) {
      for (const event of ["win", "loss"]) {
        for (const key of dialogue.lines[event] ?? []) {
          const line = resolve(bundle, key).toLowerCase();
          for (const word of forbidden) {
            const pattern = new RegExp(
              `\\b${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
              "i",
            );
            assert.ok(
              !pattern.test(line),
              `${locale} ${key} promises "${word}" — the bot cannot know that`,
            );
          }
        }
      }
    }
  }
});

// ── Isolation ────────────────────────────────────────────────────────────

test("definitions do not import or call the AI, rules or store engines", () => {
  const sources = [
    read("src/lib/solitaire-duel/botPersonalities.ts"),
    read("src/lib/solitaire-duel/dialogueLines.ts"),
  ];

  for (const source of sources) {
    assert.doesNotMatch(
      source,
      /from\s+["']\.\/(ai|rules|serverStore|realtime|analysis)["']/,
    );
    assert.doesNotMatch(
      source,
      /\b(chooseAiMove|planAiMoves|planAiSolution|applyMove|createAiMatch|advanceAiMatch|botCanFinishDeal)\b/,
    );
    assert.doesNotMatch(source, /from\s+["'][^"']*mascot/);
  }
});
