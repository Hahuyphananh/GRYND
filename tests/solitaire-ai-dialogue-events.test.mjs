/**
 * solitaire-ai-dialogue-events.test.mjs
 *
 * Phase 4: authoritative server-derived AI event summaries.
 *
 *   1. DERIVATION — reveal, foundation gains, suit completion, an opened column,
 *      a King into an empty column, and completion are each derived from the
 *      before/after states plus the planned moves.
 *   2. AGGREGATION — a multi-move catch-up batch produces one summary with
 *      counts, not one event per hidden move.
 *   3. PRIVACY — the summary exposes booleans and counts only, and the DTO gains
 *      one optional field.
 *   4. INTEGRATION — the existing Phase 2 detector consumes only the structural
 *      events counts cannot see (`emptyColumn`, `kingMove`) and the existing
 *      director still selects the line.
 *
 * Run: npm run test:solitaire-ai-dialogue-events
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const { summarizeAiDialogueEvents } = await import(
  "../src/lib/solitaire-duel/aiDialogueEvents.ts"
);
const { detectDialogueEvents } = await import(
  "../src/lib/solitaire-duel/dialogueEvents.ts"
);
const { createDialogueDirector } = await import(
  "../src/lib/solitaire-duel/dialogueDirector.ts"
);

const read = (rel) =>
  fs.readFileSync(path.join(process.cwd(), rel), "utf8");

const SUITS = ["spades", "hearts", "diamonds", "clubs"];
const card = (rank, suit = "spades") => ({ rank, suit });
const pile = (rank, faceUp = true, suit = "spades") => ({
  card: rank == null ? null : card(rank, suit),
  faceUp,
});
const emptyFoundations = () => ({
  spades: [],
  hearts: [],
  diamonds: [],
  clubs: [],
});
const foundationRun = (length, suit = "spades") =>
  Array.from({ length }, (_, index) => card(index + 1, suit));

function state({
  tableau = Array.from({ length: 7 }, () => []),
  foundations = emptyFoundations(),
  completed = false,
} = {}) {
  return {
    variant: "klondike-1",
    variantVersion: 3,
    tableau,
    stock: [],
    waste: [],
    foundations,
    ply: 0,
    resetCount: 0,
    peakFoundation: 0,
    completed,
    completedAtMs: completed ? 1 : null,
  };
}

function emptySummary() {
  return {
    reveal: false,
    foundation: 0,
    foundationSuitsCompleted: 0,
    emptyColumnsOpened: 0,
    kingToEmptyColumn: false,
    completed: false,
  };
}

// ── Derivation ───────────────────────────────────────────────────────────

test("a revealed face-down card is reported once for the batch", () => {
  const before = state({
    tableau: [
      [pile(null, false), pile(5)],
      [],
      [],
      [],
      [],
      [],
      [],
    ],
  });
  const after = state({
    tableau: [[pile(null, false)], [pile(5)], [], [], [], [], []],
  });
  // The 5 moved away; in real play the exposed card flips, so count it as
  // revealed by making the source face-up in `after`.
  after.tableau[0] = [pile(9, true)];
  const summary = summarizeAiDialogueEvents({
    before,
    after,
    moves: [
      {
        kind: "tableau-to-tableau",
        fromColumn: 0,
        toColumn: 1,
        card: card(5),
      },
    ],
  });
  assert.equal(summary.reveal, true);
  assert.equal(summary.emptyColumnsOpened, 0);
});

test("foundation gains and suit completion are counted, never listed", () => {
  const before = state({
    tableau: [[pile(13)]],
    foundations: { ...emptyFoundations(), spades: foundationRun(12) },
  });
  const after = state({
    tableau: [[], [], [], [], [], [], []],
    foundations: { ...emptyFoundations(), spades: foundationRun(13) },
  });
  const summary = summarizeAiDialogueEvents({
    before,
    after,
    moves: [
      {
        kind: "tableau-to-foundation",
        fromColumn: 0,
        card: card(13),
        suit: "spades",
      },
    ],
  });
  assert.equal(summary.foundation, 1);
  assert.equal(summary.foundationSuitsCompleted, 1);
  // Pulling a card back never makes the gain negative.
  const pulledBack = summarizeAiDialogueEvents({
    before: after,
    after: state({
      tableau: [[pile(13)]],
      foundations: { ...emptyFoundations(), spades: foundationRun(12) },
    }),
    moves: [
      {
        kind: "foundation-to-tableau",
        suit: "spades",
        toColumn: 0,
      },
    ],
  });
  assert.equal(pulledBack.foundation, 0);
});

test("an opened column is counted even when another move refills it", () => {
  const before = state({
    tableau: [[pile(4)], [pile(9)], [], [], [], [], []],
  });
  const after = state({
    tableau: [[], [pile(4)], [pile(9)], [], [], [], []],
  });
  const summary = summarizeAiDialogueEvents({
    before,
    after,
    moves: [
      { kind: "tableau-to-tableau", fromColumn: 0, toColumn: 1, card: card(4) },
      { kind: "tableau-to-tableau", fromColumn: 1, toColumn: 0, card: card(4) },
    ],
  });
  assert.equal(summary.emptyColumnsOpened, 1);
  assert.equal(summary.kingToEmptyColumn, false);
});

test("a King into an empty column is detected at the moment it lands", () => {
  const before = state({
    tableau: [[pile(13)], [pile(2)], [], [], [], [], []],
  });
  const after = state({
    tableau: [[], [pile(2), pile(13)], [], [], [], [], []],
  });
  const summary = summarizeAiDialogueEvents({
    before,
    after,
    moves: [
      {
        kind: "tableau-to-tableau",
        fromColumn: 0,
        toColumn: 2,
        card: card(13),
      },
    ],
  });
  assert.equal(summary.kingToEmptyColumn, true);
  assert.equal(summary.emptyColumnsOpened, 1);
});

test("a King moved onto a non-empty column is not a kingMove", () => {
  const before = state({
    tableau: [[pile(13)], [pile(14 % 13 || 12)]],
  });
  // Use a legal-looking target of a different colour; the summary only checks
  // emptiness, not legality (applyMove already did that).
  before.tableau[1] = [pile(6)];
  const after = state({
    tableau: [[], [pile(6), pile(13)]],
  });
  const summary = summarizeAiDialogueEvents({
    before,
    after,
    moves: [
      {
        kind: "tableau-to-tableau",
        fromColumn: 0,
        toColumn: 1,
        card: card(13),
      },
    ],
  });
  assert.equal(summary.kingToEmptyColumn, false);
});

test("multiple moves aggregate into one count-only summary", () => {
  const before = state({
    tableau: [[pile(1)], [pile(2)], [], [], [], [], []],
    foundations: emptyFoundations(),
  });
  const after = state({
    tableau: [[], [], [], [], [], [], []],
    foundations: {
      ...emptyFoundations(),
      spades: foundationRun(1),
      hearts: foundationRun(1, "hearts"),
    },
  });
  const summary = summarizeAiDialogueEvents({
    before,
    after,
    moves: [
      {
        kind: "tableau-to-foundation",
        fromColumn: 0,
        card: card(1),
        suit: "spades",
      },
      {
        kind: "tableau-to-foundation",
        fromColumn: 1,
        card: card(2),
        suit: "hearts",
      },
    ],
  });
  assert.equal(summary.foundation, 2);
  assert.equal(summary.emptyColumnsOpened, 2);
  assert.equal(summary.kingToEmptyColumn, false);
});

test("bot completion is a summary flag", () => {
  const before = state({ tableau: [[pile(13)]], foundations: { ...emptyFoundations(), spades: foundationRun(12) } });
  const after = state({
    tableau: [[], [], [], [], [], [], []],
    foundations: { ...emptyFoundations(), spades: foundationRun(13) },
    completed: true,
  });
  const summary = summarizeAiDialogueEvents({
    before,
    after,
    moves: [
      {
        kind: "tableau-to-foundation",
        fromColumn: 0,
        card: card(13),
        suit: "spades",
      },
    ],
  });
  assert.equal(summary.completed, true);
});

test("empty batches, completed boards and reset ticks are silent", () => {
  const before = state({ tableau: [[pile(5)]] });
  const after = state({ tableau: [[]] });
  const move = {
    kind: "tableau-to-tableau",
    fromColumn: 0,
    toColumn: 1,
    card: card(5),
  };

  assert.equal(
    summarizeAiDialogueEvents({ before, after, moves: [] }),
    null,
  );
  assert.equal(
    summarizeAiDialogueEvents({
      before: state({ completed: true }),
      after,
      moves: [move],
    }),
    null,
  );
  assert.equal(
    summarizeAiDialogueEvents({
      before,
      after,
      moves: [move],
      suppressed: true,
    }),
    null,
  );
});

// ── Privacy ──────────────────────────────────────────────────────────────

test("the summary exposes only booleans, counts and a completion flag", () => {
  const before = state({ tableau: [[pile(5)]] });
  const after = state({ tableau: [[], [pile(5)]] });
  const summary = summarizeAiDialogueEvents({
    before,
    after,
    moves: [
      { kind: "tableau-to-tableau", fromColumn: 0, toColumn: 1, card: card(5) },
    ],
  });

  assert.deepEqual(Object.keys(summary).sort(), Object.keys(emptySummary()).sort());
  for (const [key, value] of Object.entries(summary)) {
    assert.equal(
      typeof value,
      key === "reveal" ||
        key === "kingToEmptyColumn" ||
        key === "completed"
        ? "boolean"
        : "number",
      key,
    );
  }
  // Scan the VALUES, not the field names: `foundationSuitsCompleted` is a count.
  const serialized = JSON.stringify(Object.values(summary)).toLowerCase();
  for (const forbidden of ["card", "rank", "suit", "stock", "tableau", "waste", "seed", "ply"]) {
    assert.ok(!serialized.includes(forbidden), `leaked "${forbidden}"`);
  }
});

test("the store's DTO field is additive and the summary is server-derived", () => {
  const store = read("src/lib/solitaire-duel/serverStore.ts");
  assert.match(store, /aiEvents: AiDialogueEventSummary \| null = null/);
  assert.match(store, /\n    aiEvents,/);
  assert.match(store, /summarizeAiDialogueEvents\(\{/);
  assert.match(store, /before: beforeState/);
  assert.match(store, /moves: plan\.moves/);
  assert.match(store, /after: state/);
  assert.match(store, /suppressed: stuck/);
  // Existing public fields untouched.
  assert.match(store, /opponent:\s*\n?\s*revealed && otherState && opponentSeat/);
  assert.match(store, /view: revealed && ownState \? viewForState\(ownState\) : null/);
});

test("the summary module imports no gameplay engine", () => {
  const source = read("src/lib/solitaire-duel/aiDialogueEvents.ts");
  assert.doesNotMatch(source, /from\s+["']\.\/(ai|rules|serverStore|realtime)["']/);
  assert.doesNotMatch(
    source,
    /\b(chooseAiMove|planAiMoves|applyMove|advanceAiMatch|createAiMatch)\s*\(/,
  );
});

// ── Client integration (existing detector + director) ───────────────────

function snapshot(overrides = {}) {
  const {
    matchId = "match-1",
    serverNow = 2_000,
    aiFoundation = 5,
    aiRevealed = 7,
    ownFoundation = 5,
    ownRevealed = 7,
    aiEvents = null,
    botId = "rookie",
  } = overrides;
  return {
    matchId,
    botId,
    status: "playing",
    result: null,
    seat: "player1",
    progress: { foundationCards: ownFoundation, revealedTableau: ownRevealed, progressPercent: 0 },
    opponent: {
      seatKey: "player2",
      foundationCards: aiFoundation,
      revealedTableau: aiRevealed,
      progressPercent: 0,
      completed: false,
      completedAtMs: null,
    },
    view: { ply: 1, resetCount: 0 },
    goAtMs: 0,
    serverNow,
    aiEvents,
  };
}

test("the detector emits emptyColumn and kingMove from the safe summary", () => {
  const prev = snapshot();
  const empty = snapshot({
    aiEvents: { ...emptySummary(), emptyColumnsOpened: 1 },
  });
  assert.ok(
    detectDialogueEvents(prev, empty).some((event) => event.type === "emptyColumn"),
  );

  const king = snapshot({
    aiEvents: { ...emptySummary(), kingToEmptyColumn: true },
  });
  assert.ok(
    detectDialogueEvents(prev, king).some((event) => event.type === "kingMove"),
  );

  // Without a summary the same unchanged counts stay silent.
  assert.deepEqual(detectDialogueEvents(prev, snapshot()), []);
});

test("the existing director selects a line for a structural event", () => {
  const director = createDialogueDirector();
  const line = director.observe(
    snapshot({ ownFoundation: 2 }),
    snapshot({
      ownFoundation: 2,
      aiEvents: { ...emptySummary(), emptyColumnsOpened: 1 },
    }),
    { nowMs: 2_000 },
  );
  assert.ok(line);
  assert.equal(line.event, "emptyColumn");
  assert.ok(line.key.startsWith("solitaireBots.rookie.emptyColumn."));
});

test("a King summary is filtered by the character's supported events", () => {
  // Ace does not react to King placements; Rookie does.
  const ace = createDialogueDirector();
  assert.equal(
    ace.observe(snapshot({ botId: "ace" }), snapshot({ botId: "ace", aiEvents: { ...emptySummary(), kingToEmptyColumn: true } }), { nowMs: 2_000 }),
    null,
  );
  const rookie = createDialogueDirector();
  const line = rookie.observe(
    snapshot(),
    snapshot({ aiEvents: { ...emptySummary(), kingToEmptyColumn: true } }),
    { nowMs: 2_000 },
  );
  assert.ok(line);
  assert.equal(line.event, "kingMove");
});

test("the client snapshot forwards the summary without any board", () => {
  const page = read("src/app/casino/solitaire-duel/[matchId]/PageClient.tsx");
  assert.match(page, /aiEvents: match\.aiEvents \?\? null/);
  assert.match(page, /aiEvents\?: AiDialogueEventSummary \| null/);
});

test("AI move selection, pacing and settlement sources are untouched", () => {
  const ai = read("src/lib/solitaire-duel/ai.ts");
  assert.match(ai, /export function planAiMoves\(/);
  assert.match(ai, /return \{ moves, state: current, completed: Boolean\(current\.completed\), stuck \}/);
  const store = read("src/lib/solitaire-duel/serverStore.ts");
  assert.match(store, /const delayMs = aiMoveDelayMs\(match\.aiDifficulty\)/);
  assert.match(store, /floor\(\(nowMs - goAtMs\) \/ delayMs\)/);
  assert.match(store, /const outcome = resolveRace\(\{/);
});
