/**
 * solitaire-bot-phase5.test.mjs
 *
 * Phase 5: player reactions, decisive-lead hysteresis, character-specific
 * match endings, and the regression contracts around them.
 *
 *   1. PLAYER EVENTS — reveal / foundation / catch-up / lead come from the
 *      player's own authoritative counts. No board, no hidden AI data.
 *   2. HYSTERESIS — a one-card edge is level for dialogue, so oscillation does
 *      not alternate taunts; a decisive two-card crossing speaks once.
 *   3. ENDINGS — every opponent has win and loss lines, Glitch keeps `perfect`,
 *      and a terminal event bypasses cooldowns but is emitted exactly once.
 *   4. PRACTICE ONLY — no bot line in a human duel, and the strip bubble is
 *      suppressed while the result screen owns the voice.
 *   5. CONTENT — every win/loss line exists in EN / FR / ES and promises no
 *      reward. `playerImpressive` remains unsupported.
 *
 * Run: npm run test:solitaire-bot-phase5
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const {
  detectDialogueEvents,
  DIALOGUE_LEAD_HYSTERESIS,
  DIALOGUE_CLOSE_RACE_FLOOR,
  DIALOGUE_CLOSE_RACE_MARGIN,
} = await import("../src/lib/solitaire-duel/dialogueEvents.ts");
const {
  createDialogueDirector,
  DIALOGUE_DIRECTOR_DEFAULTS,
} = await import("../src/lib/solitaire-duel/dialogueDirector.ts");
const { SOLITAIRE_BOTS } = await import("../src/lib/solitaire-duel/bots.ts");
const { APP_TEXT_TRANSLATIONS } = await import(
  "../src/lib/appTextTranslations.js"
);

const read = (rel) =>
  fs.readFileSync(path.join(process.cwd(), rel), "utf8");

const LOCALES = ["en", "fr", "es"];
const ALL_BOT_IDS = SOLITAIRE_BOTS.map((bot) => bot.id);

function snapshot(overrides = {}) {
  const {
    matchId = "match-1",
    serverNow = 2_000,
    botId = "rookie",
    status = "playing",
    result = null,
    aiFoundation = 0,
    aiRevealed = 7,
    ownFoundation = 0,
    ownRevealed = 7,
    aiCompleted = false,
  } = overrides;
  return {
    matchId,
    botId,
    status,
    result,
    seat: "player1",
    progress: {
      foundationCards: ownFoundation,
      revealedTableau: ownRevealed,
      progressPercent: 0,
    },
    opponent: {
      seatKey: "player2",
      foundationCards: aiFoundation,
      revealedTableau: aiRevealed,
      progressPercent: 0,
      completed: aiCompleted,
      completedAtMs: aiCompleted ? 9_000 : null,
    },
    view: { ply: 1, resetCount: 0 },
    goAtMs: 0,
    serverNow,
  };
}

const typesOf = (events) => events.map((event) => event.type);

// ── Player reactions ─────────────────────────────────────────────────────

test("player reveal and foundation progress produce their own events", () => {
  const reveal = detectDialogueEvents(
    snapshot({ ownRevealed: 7 }),
    snapshot({ ownRevealed: 8 }),
  );
  assert.ok(typesOf(reveal).includes("playerReveal"));

  const foundation = detectDialogueEvents(
    snapshot({ ownFoundation: 0, aiFoundation: 0 }),
    snapshot({ ownFoundation: 1, aiFoundation: 0 }),
  );
  assert.ok(typesOf(foundation).includes("playerFoundation"));
});

test("the director reacts in the character's voice to player progress", () => {
  const director = createDialogueDirector();
  director.observe(snapshot(), snapshot(), { nowMs: 2_000 });

  const line = director.observe(
    snapshot(),
    snapshot({ ownRevealed: 8 }),
    { nowMs: 2_500 },
  );
  assert.ok(line);
  assert.equal(line.event, "playerReveal");
  assert.ok(line.key.startsWith("solitaireBots.rookie.playerReveal."));
});

test("playerImpressive is never invented from ordinary progress", () => {
  const transitions = [
    [snapshot({ ownFoundation: 0 }), snapshot({ ownFoundation: 40 })],
    [snapshot({ ownRevealed: 7 }), snapshot({ ownRevealed: 28 })],
    [snapshot(), snapshot({ ownFoundation: 7, ownRevealed: 10 })],
  ];
  for (const [prev, next] of transitions) {
    assert.ok(
      !typesOf(detectDialogueEvents(prev, next)).includes("playerImpressive"),
    );
  }
});

// ── Lead hysteresis ──────────────────────────────────────────────────────

test("one-card edges do not alternate lead and behind lines", () => {
  // 6-5 is a one-card edge: still level for dialogue.
  assert.ok(
    !typesOf(
      detectDialogueEvents(
        snapshot({ ownFoundation: 6, aiFoundation: 5 }),
        snapshot({ ownFoundation: 7, aiFoundation: 5 }),
      ),
    ).includes("playerLead"),
  );
  // Dropping back to the edge is not the AI taking the lead.
  assert.ok(
    !typesOf(
      detectDialogueEvents(
        snapshot({ ownFoundation: 7, aiFoundation: 5 }),
        snapshot({ ownFoundation: 6, aiFoundation: 5 }),
      ),
    ).includes("aiLead"),
  );
  // Hovering across the boundary again does not re-announce.
  assert.ok(
    !typesOf(
      detectDialogueEvents(
        snapshot({ ownFoundation: 6, aiFoundation: 5 }),
        snapshot({ ownFoundation: 7, aiFoundation: 5 }),
      ),
    ).includes("playerLead"),
  );
});

test("a decisive two-card crossing is announced exactly once", () => {
  const player = typesOf(
    detectDialogueEvents(
      snapshot({ ownFoundation: 5, aiFoundation: 5 }),
      snapshot({ ownFoundation: 7, aiFoundation: 5 }),
    ),
  );
  assert.ok(player.includes("playerLead"));
  assert.ok(player.includes("aiBehind"));

  const ai = typesOf(
    detectDialogueEvents(
      snapshot({ ownFoundation: 5, aiFoundation: 5 }),
      snapshot({ ownFoundation: 5, aiFoundation: 7 }),
    ),
  );
  assert.ok(ai.includes("aiLead"));

  assert.equal(DIALOGUE_LEAD_HYSTERESIS, 2);
});

test("catch-up means reaching the level zone from a decisive deficit", () => {
  const caught = typesOf(
    detectDialogueEvents(
      snapshot({ ownFoundation: 5, aiFoundation: 7 }),
      snapshot({ ownFoundation: 6, aiFoundation: 7 }),
    ),
  );
  assert.ok(caught.includes("playerCatchUp"));

  const edgeOnly = typesOf(
    detectDialogueEvents(
      snapshot({ ownFoundation: 5, aiFoundation: 6 }),
      snapshot({ ownFoundation: 6, aiFoundation: 6 }),
    ),
  );
  assert.ok(!edgeOnly.includes("playerCatchUp"));
});

test("close match fires on entering the level zone and not on every poll", () => {
  const into = typesOf(
    detectDialogueEvents(
      snapshot({ ownFoundation: 7, aiFoundation: 7 }),
      snapshot({ ownFoundation: 8, aiFoundation: 8 }),
    ),
  );
  assert.ok(into.includes("closeMatch"));

  const stays = typesOf(
    detectDialogueEvents(
      snapshot({ ownFoundation: 8, aiFoundation: 8 }),
      snapshot({
        ownFoundation: 8 + DIALOGUE_CLOSE_RACE_MARGIN,
        aiFoundation: 8,
      }),
    ),
  );
  assert.ok(!stays.includes("closeMatch"));

  assert.equal(DIALOGUE_CLOSE_RACE_FLOOR, 8);
});

// ── Match-end dialogue ───────────────────────────────────────────────────

function terminalSnapshot(botId, playerWon, serverNow = 9_000) {
  return snapshot({
    botId,
    status: "finished",
    result: playerWon ? "player1" : "player2",
    serverNow,
    ownFoundation: playerWon ? 52 : 40,
    aiFoundation: playerWon ? 40 : 52,
  });
}

test("every opponent has a character-specific victory and defeat line", () => {
  for (const botId of ALL_BOT_IDS) {
    const victory = createDialogueDirector();
    victory.observe(snapshot({ botId }), snapshot({ botId }), { nowMs: 2_000 });
    const aiWin = victory.observe(
      snapshot({ botId }),
      terminalSnapshot(botId, false),
      { nowMs: 9_000 },
    );
    assert.ok(aiWin, `${botId} has no AI-victory line`);
    // The AI's own victory is the `win` event; the player's is `loss`.
    assert.equal(aiWin.event, "win");
    assert.ok(aiWin.key.startsWith(`solitaireBots.${botId}.win.`));

    const defeat = createDialogueDirector();
    defeat.observe(snapshot({ botId }), snapshot({ botId }), { nowMs: 2_000 });
    const playerWin = defeat.observe(
      snapshot({ botId }),
      terminalSnapshot(botId, true),
      { nowMs: 9_000 },
    );
    assert.ok(playerWin, `${botId} has no player-victory line`);
    assert.equal(playerWin.event, "loss");
    assert.ok(playerWin.key.startsWith(`solitaireBots.${botId}.loss.`));
  }
});

test("Glitch keeps the perfect id and speaks as Glitch at the end", () => {
  assert.ok(SOLITAIRE_BOTS.some((bot) => bot.id === "perfect"));
  const director = createDialogueDirector();
  director.observe(snapshot({ botId: "perfect" }), snapshot({ botId: "perfect" }), {
    nowMs: 2_000,
  });
  const line = director.observe(
    snapshot({ botId: "perfect" }),
    terminalSnapshot("perfect", false),
    { nowMs: 9_000 },
  );
  assert.ok(line);
  assert.equal(line.botId, "perfect");
  assert.ok(line.key.startsWith("solitaireBots.perfect.win."));
  assert.equal(
    APP_TEXT_TRANSLATIONS.en.solitaireBots.perfect.loss[3],
    "You have earned my attention. Briefly.",
  );
});

test("a terminal event bypasses the cap and is emitted only once", () => {
  const director = createDialogueDirector({
    config: {
      maxLinesPerMatch: 0,
      globalMinIntervalMs: 999_999,
      eventCooldownMs: 999_999,
    },
  });
  director.observe(snapshot(), snapshot(), { nowMs: 2_000 });

  const first = director.observe(snapshot(), terminalSnapshot("rookie", false), {
    nowMs: 9_000,
  });
  assert.ok(first, "an ending must bypass ordinary limits");
  assert.equal(first.event, "win");
  assert.equal(first.durationMs, DIALOGUE_DIRECTOR_DEFAULTS.endingDurationMs);

  // The result screen rerenders / polls arrive: terminal stays deduplicated.
  const rerender = director.observe(
    terminalSnapshot("rookie", false),
    terminalSnapshot("rookie", false, 10_000),
    { nowMs: 10_000 },
  );
  assert.equal(rerender, null);
});

test("a repeated transition never speaks twice", () => {
  const director = createDialogueDirector();
  director.observe(snapshot(), snapshot(), { nowMs: 2_000 });
  const prev = snapshot({ ownRevealed: 7 });
  const next = snapshot({ ownRevealed: 8 });
  assert.ok(director.observe(prev, next, { nowMs: 2_500 }));
  assert.equal(director.observe(prev, next, { nowMs: 2_600 }), null);
});

// ── Practice-only and one-voice guarantees ──────────────────────────────

test("a human duel has no bot id and therefore no dialogue", () => {
  const director = createDialogueDirector();
  const human = snapshot({ botId: null, result: "player1", status: "finished" });
  assert.equal(director.observe(snapshot({ botId: null }), human), null);
});

test("the result owns the only voice once the match ends", () => {
  const page = read("src/app/casino/solitaire-duel/[matchId]/PageClient.tsx");
  // The strip is muted while the result screen is mounted…
  assert.ok(page.includes('line={phase === "result" ? null : botLine}'));
  // …and the result line is practice-only and ending-only.
  assert.ok(page.includes("showGlitch={!isPractice}"));
  assert.ok(page.includes('botLine.event === "win" || botLine.event === "loss"'));
  assert.ok(page.includes('testId="solitaire-bot-result-speech"'));
});

test("terminal lines persist across result rerenders, ordinary lines expire", () => {
  const hook = read("src/hooks/useSolitaireBotDialogue.ts");
  assert.ok(
    hook.includes('if (line.event === "win" || line.event === "loss") return undefined;'),
  );
  assert.ok(hook.includes("const id = window.setTimeout(() => setLine(null), line.durationMs);"));
});

// ── Translation coverage and tone ────────────────────────────────────────

function resolve(node, key) {
  return key.split(".").reduce((value, part) => value?.[part], node);
}

test("every win and loss line exists in EN, FR and ES", () => {
  for (const locale of LOCALES) {
    for (const botId of ALL_BOT_IDS) {
      for (const event of ["win", "loss"]) {
        for (let index = 0; index < 6; index += 1) {
          const key = `solitaireBots.${botId}.${event}.${index}`;
          const value = resolve(APP_TEXT_TRANSLATIONS[locale], key);
          assert.equal(typeof value, "string", `${locale}: ${key} missing`);
          assert.ok(value.trim().length > 0, `${locale}: ${key} empty`);
        }
      }
    }
  }
});

test("ending copy is distinct, concise, and promises no reward", () => {
  const forbidden = new Set([
    "token",
    "tokens",
    "coin",
    "coins",
    "prize",
    "reward",
    "elo",
    "rating",
    "trophy",
    "trophies",
    "wager",
    "stake",
  ]);
  for (const locale of LOCALES) {
    for (const botId of ALL_BOT_IDS) {
      for (const event of ["win", "loss"]) {
        const values = Array.from({ length: 6 }, (_, index) =>
          resolve(
            APP_TEXT_TRANSLATIONS[locale],
            `solitaireBots.${botId}.${event}.${index}`,
          ),
        );
        assert.equal(new Set(values).size, 6, `${locale}: ${botId}.${event} repeats`);
        for (const value of values) {
          assert.ok(value.length <= 100, `${locale}: line too long`);
          const words = value.toLowerCase().match(/[a-z]+/g) ?? [];
          for (const word of words) {
            assert.ok(!forbidden.has(word), `${locale}: "${word}" in "${value}"`);
          }
        }
      }
    }
  }
  // Glitch's defeat reaction is intentionally ungracious and memorable.
  assert.match(APP_TEXT_TRANSLATIONS.en.solitaireBots.perfect.loss[0], /ERROR/);
});

// ── Isolation ───────────────────────────────────────────────────────────

test("no dormant evaluator or gameplay engine is pulled into dialogue", () => {
  for (const file of [
    "src/lib/solitaire-duel/dialogueEvents.ts",
    "src/lib/solitaire-duel/dialogueDirector.ts",
    "src/hooks/useSolitaireBotDialogue.ts",
  ]) {
    const source = read(file);
    assert.ok(!source.includes('from "./ai"'));
    assert.ok(!source.includes('from "./rules"'));
    assert.ok(!source.includes('from "./serverStore"'));
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    assert.ok(!code.includes("Math.random"));
  }

  const ai = read("src/lib/solitaire-duel/ai.ts");
  const rules = read("src/lib/solitaire-duel/rules.ts");
  assert.ok(!ai.toLowerCase().includes("dialogue"));
  assert.ok(!rules.toLowerCase().includes("dialogue"));
  assert.ok(ai.includes("export function planAiMoves("));
});
