/**
 * solitaire-bot-dialogue-director.test.mjs
 *
 * Phase 2: derive dialogue events from adopted snapshots and pick one line per
 * snapshot, deterministically, within frequency limits.
 *
 * The contracts that matter here:
 *
 *   1. DETECTION — only events the server's counts can actually prove are
 *      emitted. Structural AI events (`emptyColumn`, `kingMove`) and
 *      `playerImpressive` are never invented.
 *   2. SNAPSHOTS — first reads, repeated reads, stale reads, re-deals, pauses
 *      and countdowns cannot speak; a batch of bot moves is one event.
 *   3. SELECTION — deterministic, no repeats, one line per snapshot, endings
 *      last and exempt from the ordinary cap.
 *   4. ISOLATION — state is per match; nothing reads hidden AI information and
 *      no engine is imported or mutated.
 *
 * Run: npm run test:solitaire-bot-dialogue-director
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const {
  detectDialogueEvents,
  DIALOGUE_SIGNIFICANT_MILESTONES,
  DIALOGUE_NEAR_VICTORY_FOUNDATIONS,
  DIALOGUE_CLOSE_RACE_FLOOR,
} = await import("../src/lib/solitaire-duel/dialogueEvents.ts");
const {
  createDialogueDirector,
  dialogueLineIndex,
  DIALOGUE_DIRECTOR_DEFAULTS,
} = await import("../src/lib/solitaire-duel/dialogueDirector.ts");

const read = (relPath) =>
  fs.readFileSync(path.join(process.cwd(), relPath), "utf8");

/** A presentation-safe snapshot, exactly the shape the detector accepts. */
function snapshot(overrides = {}) {
  const {
    matchId = "match-1",
    serverNow = 1_000,
    ply = 1,
    resetCount = 0,
    aiFoundation = 0,
    aiRevealed = 7,
    ownFoundation = 0,
    ownRevealed = 7,
    status = "playing",
    result = null,
    seat = "player1",
    botId = "rookie",
    goAtMs = 0,
  } = overrides;

  return {
    matchId,
    botId,
    status,
    result,
    seat,
    progress: {
      foundationCards: ownFoundation,
      revealedTableau: ownRevealed,
      progressPercent: Math.round((ownFoundation / 52) * 100),
    },
    opponent: {
      seatKey: "player2",
      foundationCards: aiFoundation,
      revealedTableau: aiRevealed,
      progressPercent: Math.round((aiFoundation / 52) * 100),
      completed: aiFoundation >= 52,
      completedAtMs: null,
    },
    view: { ply, resetCount },
    goAtMs,
    serverNow,
  };
}

const typesOf = (events) => events.map((event) => event.type);
const detect = (prev, next, options) =>
  detectDialogueEvents(prev, next, options);

// ── Detection ────────────────────────────────────────────────────────────

test("detects every event the client projection can prove", () => {
  const cases = {
    reveal: [snapshot({ aiRevealed: 7 }), snapshot({ aiRevealed: 8 })],
    foundation: [snapshot({ aiFoundation: 0 }), snapshot({ aiFoundation: 1 })],
    significantProgress: [
      snapshot({ aiFoundation: 12 }),
      snapshot({ aiFoundation: 13 }),
    ],
    aiNearVictory: [
      snapshot({ aiFoundation: 39 }),
      snapshot({ aiFoundation: 40 }),
    ],
    aiLead: [
      snapshot({ ownFoundation: 5, aiFoundation: 5 }),
      snapshot({ ownFoundation: 5, aiFoundation: 7 }),
    ],
    aiBehind: [
      snapshot({ ownFoundation: 5, aiFoundation: 5 }),
      snapshot({ ownFoundation: 7, aiFoundation: 5 }),
    ],
    playerLead: [
      snapshot({ ownFoundation: 5, aiFoundation: 5 }),
      snapshot({ ownFoundation: 7, aiFoundation: 5 }),
    ],
    playerCatchUp: [
      snapshot({ ownFoundation: 5, aiFoundation: 7 }),
      snapshot({ ownFoundation: 6, aiFoundation: 7 }),
    ],
    closeMatch: [
      snapshot({ ownFoundation: 7, aiFoundation: 7 }),
      snapshot({ ownFoundation: 8, aiFoundation: 8 }),
    ],
    playerReveal: [
      snapshot({ ownRevealed: 7 }),
      snapshot({ ownRevealed: 8 }),
    ],
    playerFoundation: [
      snapshot({ ownFoundation: 0 }),
      snapshot({ ownFoundation: 1 }),
    ],
  };

  for (const [expected, [prev, next]] of Object.entries(cases)) {
    assert.ok(
      typesOf(detect(prev, next)).includes(expected),
      `expected ${expected}, got ${typesOf(detect(prev, next)).join(", ")}`,
    );
  }

  const win = detect(
    snapshot({ status: "playing" }),
    snapshot({ status: "finished", result: "player2" }),
  );
  assert.deepEqual(typesOf(win), ["win"]);

  const loss = detect(
    snapshot({ status: "playing" }),
    snapshot({ status: "finished", result: "player1" }),
  );
  assert.deepEqual(typesOf(loss), ["loss"]);

  // A draw is neither.
  const draw = detect(
    snapshot({ status: "playing" }),
    snapshot({ status: "finished", result: "draw" }),
  );
  assert.deepEqual(draw, []);
});

test("never invents structural or evaluated events", () => {
  const forbidden = new Set(["emptyColumn", "kingMove", "playerImpressive"]);
  const transitions = [
    [snapshot({ aiFoundation: 0 }), snapshot({ aiFoundation: 5 })],
    [snapshot({ ownFoundation: 0 }), snapshot({ ownFoundation: 5 })],
    [snapshot({ aiFoundation: 38 }), snapshot({ aiFoundation: 45 })],
    [snapshot({ ownRevealed: 7 }), snapshot({ ownRevealed: 20 })],
  ];
  for (const [prev, next] of transitions) {
    for (const type of typesOf(detect(prev, next))) {
      assert.ok(!forbidden.has(type), `${type} must not be detected`);
    }
  }
});

test("a batch of bot moves is one event per kind, not one per move", () => {
  const events = detect(
    snapshot({ aiFoundation: 0, aiRevealed: 7 }),
    snapshot({ aiFoundation: 5, aiRevealed: 10 }),
  );
  assert.equal(typesOf(events).filter((type) => type === "foundation").length, 1);
  assert.equal(typesOf(events).filter((type) => type === "reveal").length, 1);
});

test("milestones and the endgame threshold fire once per crossing", () => {
  const first = detect(
    snapshot({ aiFoundation: 12 }),
    snapshot({ aiFoundation: 13 }),
  );
  assert.ok(typesOf(first).includes("significantProgress"));

  // Already past the milestone: no repeat.
  const again = detect(
    snapshot({ aiFoundation: 13 }),
    snapshot({ aiFoundation: 14 }),
  );
  assert.ok(!typesOf(again).includes("significantProgress"));

  // Every documented milestone is a real constant.
  assert.ok(DIALOGUE_SIGNIFICANT_MILESTONES.includes(26));
  assert.equal(
    typesOf(
      detect(
        snapshot({ ownFoundation: 0, aiFoundation: 38 }),
        snapshot({ ownFoundation: 0, aiFoundation: 40 }),
      ),
    ).includes("aiNearVictory"),
    true,
  );
  assert.equal(DIALOGUE_NEAR_VICTORY_FOUNDATIONS, 40);
  assert.equal(DIALOGUE_CLOSE_RACE_FLOOR, 8);
});

// ── Snapshot handling ────────────────────────────────────────────────────

test("the first snapshot is a baseline, not an event", () => {
  assert.deepEqual(detect(null, snapshot({ aiFoundation: 20 })), []);
});

test("a repeated snapshot cannot re-fire an event", () => {
  const prev = snapshot({ aiRevealed: 7 });
  const next = snapshot({ aiRevealed: 9 });
  assert.ok(detect(prev, next).length > 0);
  assert.deepEqual(detect(next, next), []);
});

test("a stale snapshot is ignored", () => {
  const prev = snapshot({ ply: 10, aiFoundation: 5 });
  const stale = snapshot({ ply: 9, aiFoundation: 8 });
  assert.deepEqual(detect(prev, stale), []);
});

test("a re-deal suppresses dialogue", () => {
  assert.deepEqual(
    detect(
      snapshot({ resetCount: 0, aiFoundation: 5 }),
      snapshot({ resetCount: 1, aiFoundation: 20 }),
    ),
    [],
  );
});

test("countdown and pause suppress ordinary dialogue", () => {
  const prev = snapshot({ goAtMs: 5_000, serverNow: 1_000 });
  const next = snapshot({
    goAtMs: 5_000,
    serverNow: 2_000,
    aiFoundation: 3,
  });
  assert.deepEqual(detect(prev, next), []);
  assert.deepEqual(
    detect(snapshot({ aiFoundation: 0 }), snapshot({ aiFoundation: 2 }), {
      paused: true,
    }),
    [],
  );
});

test("terminal snapshots never leak progress events", () => {
  const events = detect(
    snapshot({ aiFoundation: 10 }),
    snapshot({ status: "finished", result: "player2", aiFoundation: 40 }),
  );
  assert.deepEqual(typesOf(events), ["win"]);
});

// ── Director: selection ──────────────────────────────────────────────────

function directorAt(botId = "rookie", config) {
  return createDialogueDirector(config ? { config } : undefined);
}

test("one snapshot produces at most one line", () => {
  const director = directorAt();
  const line = director.observe(
    snapshot({ aiFoundation: 0, aiRevealed: 7, ownFoundation: 0 }),
    snapshot({ aiFoundation: 1, aiRevealed: 8, ownFoundation: 1 }),
    { nowMs: 1_000 },
  );
  assert.ok(line);
  assert.equal(typeof line.key, "string");
  assert.ok(line.key.startsWith(`solitaireBots.rookie.`));
});

test("selection is deterministic for the same match and event", () => {
  // AI already ahead, so this transition is a clean foundation event with no
  // lead flip competing for the snapshot.
  const prev = snapshot({ ownFoundation: 0, aiFoundation: 5 });
  const next = snapshot({
    ownFoundation: 0,
    aiFoundation: 6,
    serverNow: 2_000,
  });

  const a = directorAt();
  const b = directorAt();
  const lineA = a.observe(prev, next, { nowMs: 2_000 });
  const lineB = b.observe(prev, next, { nowMs: 2_000 });

  assert.ok(lineA && lineB);
  assert.equal(lineA.key, lineB.key);
  assert.equal(lineA.id, lineB.id);
  assert.equal(
    lineA.key,
    `solitaireBots.rookie.foundation.${dialogueLineIndex(
      "match-1:foundation:1",
      6,
    )}`,
  );
});

test("the same event in a different match may pick a different line", () => {
  const keys = new Set();
  for (let index = 0; index < 12; index += 1) {
    const id = `match-${index}`;
    const director = directorAt();
    const line = director.observe(
      snapshot({ matchId: id, aiFoundation: 0 }),
      snapshot({ matchId: id, aiFoundation: 1, serverNow: 2_000 }),
      { nowMs: 2_000 },
    );
    assert.ok(line);
    keys.add(line.key);
  }
  assert.ok(keys.size > 1, "the hash should vary across matches");
});

test("a repeated observe of the same transition is suppressed", () => {
  const director = directorAt();
  const prev = snapshot({ aiFoundation: 0 });
  const next = snapshot({ aiFoundation: 1, serverNow: 2_000 });

  assert.ok(director.observe(prev, next, { nowMs: 2_000 }));
  // Same transition again, even much later: the event id is already processed.
  assert.equal(director.observe(prev, next, { nowMs: 90_000 }), null);
});

test("a character never receives an event it does not support", () => {
  // Grandmaster does not react to individual reveals.
  const grandmaster = directorAt();
  assert.equal(
    grandmaster.observe(
      // The viewer is well ahead on revealed cards, so the AI reveal does not
      // flip the race: this transition is a pure reveal event.
      snapshot({ botId: "grandmaster", ownRevealed: 20, aiRevealed: 7 }),
      snapshot({
        botId: "grandmaster",
        ownRevealed: 20,
        aiRevealed: 9,
        serverNow: 2_000,
      }),
      { nowMs: 2_000 },
    ),
    null,
  );

  // Ace does not react to the player's reveal.
  const ace = directorAt();
  assert.equal(
    ace.observe(
      snapshot({ botId: "ace", ownRevealed: 7, aiRevealed: 20 }),
      snapshot({
        botId: "ace",
        ownRevealed: 9,
        aiRevealed: 20,
        serverNow: 2_000,
      }),
      { nowMs: 2_000 },
    ),
    null,
  );
});

// ── Director: frequency ──────────────────────────────────────────────────

test("the global interval is enforced", () => {
  const director = directorAt();
  const first = director.observe(
    snapshot({ aiFoundation: 0 }),
    snapshot({ aiFoundation: 1, serverNow: 2_000 }),
    { nowMs: 2_000 },
  );
  assert.ok(first);

  // 5s later, a different event type: still inside the 9s floor.
  assert.equal(
    director.observe(
      snapshot({ aiFoundation: 1, aiRevealed: 7 }),
      snapshot({ aiFoundation: 1, aiRevealed: 8, serverNow: 7_000 }),
      { nowMs: 7_000 },
    ),
    null,
  );

  // Past the floor.
  assert.ok(
    director.observe(
      snapshot({ aiFoundation: 1, aiRevealed: 8 }),
      snapshot({ aiFoundation: 1, aiRevealed: 9, serverNow: 20_000 }),
      { nowMs: 20_000 },
    ),
  );
});

test("the per-event cooldown is enforced", () => {
  const director = directorAt();
  assert.ok(
    director.observe(
      // Viewer ahead on reveals, so these are pure reveal events.
      snapshot({ ownRevealed: 20, aiRevealed: 7 }),
      snapshot({ ownRevealed: 20, aiRevealed: 8, serverNow: 2_000 }),
      { nowMs: 2_000 },
    ),
  );

  // Same event 20s later: global gap is fine, event cooldown (25s) is not.
  assert.equal(
    director.observe(
      snapshot({ ownRevealed: 20, aiRevealed: 8 }),
      snapshot({ ownRevealed: 20, aiRevealed: 9, serverNow: 22_000 }),
      { nowMs: 22_000 },
    ),
    null,
  );

  // 30s after the first line: both limits clear.
  assert.ok(
    director.observe(
      snapshot({ ownRevealed: 20, aiRevealed: 9 }),
      snapshot({ ownRevealed: 20, aiRevealed: 10, serverNow: 32_000 }),
      { nowMs: 32_000 },
    ),
  );
});

test("the match-wide cap is enforced, and the ending is exempt", () => {
  const director = directorAt("rookie");
  let aiRevealed = 7;
  let aiFoundation = 0;
  let emitted = 0;

  // Two event kinds, so the cap is reached before a single kind's six keys are
  // exhausted. One line per snapshot still holds.
  for (let index = 1; index <= 20; index += 1) {
    const now = 2_000 + index * 30_000;
    const line = director.observe(
      snapshot({ aiRevealed, aiFoundation }),
      snapshot({
        aiRevealed: aiRevealed + 1,
        aiFoundation: aiFoundation + 1,
        serverNow: now,
        ply: index,
      }),
      { nowMs: now },
    );
    aiRevealed += 1;
    aiFoundation += 1;
    if (line) emitted += 1;
  }

  const cap = Math.min(
    DIALOGUE_DIRECTOR_DEFAULTS.maxLinesPerMatch,
    // Rookie's Phase 1 ceiling.
    12,
  );
  assert.equal(emitted, cap);

  const ending = director.observe(
    snapshot({ aiRevealed, status: "playing" }),
    snapshot({
      aiRevealed,
      status: "finished",
      result: "player2",
      serverNow: 2_000 + 21 * 30_000,
    }),
    { nowMs: 2_000 + 21 * 30_000 },
  );
  assert.ok(ending, "the win line must not be swallowed by the ordinary cap");
  assert.equal(ending.event, "win");
  assert.ok(ending.durationMs > DIALOGUE_DIRECTOR_DEFAULTS.lineDurationMs);
});

test("personality frequency makes a character quieter", () => {
  // Glitch requires a 30s gap even though the global floor is 9s, and caps at 4.
  const director = directorAt();
  const glitch = (overrides) => snapshot({ ...overrides, botId: "perfect" });

  // A lead flip at t=2s.
  const first = director.observe(
    glitch({ ownFoundation: 5, aiFoundation: 5, serverNow: 2_000 }),
    glitch({ ownFoundation: 5, aiFoundation: 7, serverNow: 2_001, ply: 2 }),
    { nowMs: 2_001 },
  );
  assert.ok(first);
  assert.ok(first.key.startsWith("solitaireBots.perfect.aiLead."));

  // Equalise, then lead again 12s after the line: inside Glitch's 30s gap.
  director.observe(
    glitch({ ownFoundation: 6, aiFoundation: 6, serverNow: 12_000, ply: 3 }),
    glitch({ ownFoundation: 6, aiFoundation: 6, serverNow: 12_001, ply: 4 }),
    { nowMs: 12_001 },
  );
  assert.equal(
    director.observe(
      glitch({ ownFoundation: 6, aiFoundation: 6, serverNow: 14_000, ply: 5 }),
      glitch({ ownFoundation: 6, aiFoundation: 8, serverNow: 14_001, ply: 6 }),
      { nowMs: 14_001 },
    ),
    null,
  );

  // 32s after the line: clear.
  director.observe(
    glitch({ ownFoundation: 7, aiFoundation: 7, serverNow: 33_000, ply: 7 }),
    glitch({ ownFoundation: 7, aiFoundation: 7, serverNow: 33_001, ply: 8 }),
    { nowMs: 33_001 },
  );
  assert.ok(
    director.observe(
      glitch({ ownFoundation: 7, aiFoundation: 7, serverNow: 34_000, ply: 9 }),
      glitch({ ownFoundation: 7, aiFoundation: 9, serverNow: 34_001, ply: 10 }),
      { nowMs: 34_001 },
    ),
  );
});

// ── Director: state isolation ────────────────────────────────────────────

test("different matches keep independent state", () => {
  const left = directorAt();
  const right = directorAt();

  const leftLine = left.observe(
    snapshot({ matchId: "left", aiFoundation: 0 }),
    snapshot({ matchId: "left", aiFoundation: 1, serverNow: 2_000 }),
    { nowMs: 2_000 },
  );
  const rightLine = right.observe(
    snapshot({ matchId: "right", aiFoundation: 0 }),
    snapshot({ matchId: "right", aiFoundation: 1, serverNow: 2_000 }),
    { nowMs: 2_000 },
  );

  assert.ok(leftLine && rightLine);
  assert.equal(left.getState().totalLines, 1);
  assert.equal(right.getState().totalLines, 1);
  assert.equal(left.getState().matchId, "left");
  assert.equal(right.getState().matchId, "right");
});

test("a re-deal clears the director and stays silent", () => {
  const director = directorAt();
  assert.ok(
    director.observe(
      snapshot({ aiFoundation: 0 }),
      snapshot({ aiFoundation: 1, serverNow: 2_000 }),
      { nowMs: 2_000 },
    ),
  );

  assert.equal(
    director.observe(
      snapshot({ aiFoundation: 1, resetCount: 0, serverNow: 40_000 }),
      snapshot({ resetCount: 1, aiFoundation: 10, serverNow: 40_001 }),
      { nowMs: 40_001 },
    ),
    null,
  );

  const state = director.getState();
  assert.equal(state.totalLines, 0);
  assert.equal(state.lastResetCount, 1);
  assert.deepEqual(state.usedKeys, []);
  assert.deepEqual(state.processedEventIds, []);

  // The new board can speak again.
  assert.ok(
    director.observe(
      snapshot({ aiFoundation: 10, resetCount: 1, serverNow: 80_000 }),
      snapshot({ aiFoundation: 11, resetCount: 1, serverNow: 80_001 }),
      { nowMs: 80_001 },
    ),
  );
});

test("a fresh director never speaks on a finished match", () => {
  const director = directorAt();
  assert.equal(
    director.observe(null, snapshot({ status: "finished", result: "player2" }), {
      nowMs: 2_000,
    }),
    null,
  );
});

test("the output contains only presentation-safe fields", () => {
  const director = directorAt();
  const line = director.observe(
    snapshot({ aiFoundation: 0 }),
    snapshot({ aiFoundation: 1, serverNow: 2_000 }),
    { nowMs: 2_000 },
  );
  assert.ok(line);
  assert.deepEqual(Object.keys(line).sort(), [
    "botId",
    "durationMs",
    "event",
    "id",
    "key",
  ]);
  for (const value of Object.values(line)) {
    assert.equal(typeof value === "string" || typeof value === "number", true);
  }
});

// ── Hidden information and gameplay isolation ────────────────────────────

const SNAPSHOT_FIELDS = new Set([
  "matchId",
  "botId",
  "status",
  "result",
  "seat",
  "progress",
  "opponent",
  "view",
  "goAtMs",
  "serverNow",
  "aiEvents",
]);
const PROGRESS_FIELDS = new Set([
  "foundationCards",
  "revealedTableau",
  "progressPercent",
]);
const OPPONENT_FIELDS = new Set([
  "seatKey",
  "foundationCards",
  "revealedTableau",
  "progressPercent",
  "completed",
  "completedAtMs",
]);
const VIEW_FIELDS = new Set(["ply", "resetCount"]);

function guard(value, allowed) {
  return new Proxy(value, {
    get(target, property) {
      if (typeof property === "symbol") return target[property];
      if (!allowed.has(property)) {
        throw new Error(`dialogue read forbidden field: ${String(property)}`);
      }
      return target[property];
    },
  });
}

function guardedSnapshot(overrides) {
  const value = snapshot(overrides);
  return {
    ...value,
    progress: guard(value.progress, PROGRESS_FIELDS),
    opponent: guard(value.opponent, OPPONENT_FIELDS),
    view: guard(value.view, VIEW_FIELDS),
  };
}

test("detection and selection read no hidden AI information", () => {
  const prev = guard(guardedSnapshot({ aiFoundation: 0 }), SNAPSHOT_FIELDS);
  const next = guard(
    guardedSnapshot({ aiFoundation: 1, aiRevealed: 9, serverNow: 2_000 }),
    SNAPSHOT_FIELDS,
  );

  assert.doesNotThrow(() => detect(prev, next));
  const director = directorAt();
  assert.doesNotThrow(() =>
    director.observe(prev, next, { nowMs: 2_000 }),
  );
});

test("the director never mutates a snapshot", () => {
  const prev = snapshot({ aiFoundation: 0 });
  const next = snapshot({ aiFoundation: 1, serverNow: 2_000 });
  const expectedPrev = JSON.parse(JSON.stringify(prev));
  const expectedNext = JSON.parse(JSON.stringify(next));

  Object.freeze(prev);
  Object.freeze(prev.progress);
  Object.freeze(prev.opponent);
  Object.freeze(prev.view);
  Object.freeze(next);
  Object.freeze(next.progress);
  Object.freeze(next.opponent);
  Object.freeze(next.view);

  assert.doesNotThrow(() => detect(prev, next));
  const director = directorAt();
  assert.doesNotThrow(() => director.observe(prev, next, { nowMs: 2_000 }));

  assert.deepEqual(prev, expectedPrev);
  assert.deepEqual(next, expectedNext);
});

test("the dialogue modules import no gameplay engine", () => {
  const sources = [
    read("src/lib/solitaire-duel/dialogueEvents.ts"),
    read("src/lib/solitaire-duel/dialogueDirector.ts"),
    read("src/hooks/useSolitaireBotDialogue.ts"),
  ];

  for (const source of sources) {
    assert.doesNotMatch(
      source,
      /from\s+["']\.\.?\/[^"']*\/(ai|rules|serverStore|realtime|analysis)["']/,
    );
    assert.doesNotMatch(source, /from\s+["']\.\/(ai|rules|serverStore|realtime|analysis)["']/);
    assert.doesNotMatch(
      source,
      /\b(chooseAiMove|planAiMoves|planAiSolution|applyMove|createAiMatch|advanceAiMatch|botCanFinishDeal)\b/,
    );
  }
});
