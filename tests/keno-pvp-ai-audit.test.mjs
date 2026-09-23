/**
 * PvP Keno — AI AUDIT.
 *
 * Drives the REAL `createAiMatch` / `fetchMatchWithAutoResolve` / `playAiTurn`
 * / `claimTile` store functions against a fake database and a virtual clock,
 * simulating the client's actual request cadence (the 5s status poll, the
 * deadline nudge, and the ai-turn probe burst), and asserts the bot really
 * plays: its plan is materialised as taps, it never taps outside the tile's
 * window, and a full match reaches a terminal result.
 *
 * Under the own-miss rules a tap saves the tapper's life and never costs the
 * opponent one, so the counts below separate TAPS (who touched the tile, and
 * therefore kept their life) from CREDITS (the one tile per round that is
 * scored). A human who taps every tile is unbeatable; a human who does not is
 * beaten by their own misses — both shapes are asserted.
 *
 * Run:  npm run test:keno-ai-audit -- [--experimental-test-module-mocks]
 * (module mocking needs --experimental-test-module-mocks; without the flag the
 * suite skips instead of failing.)
 *
 * Trace: KENO_AUDIT_TRACE=1 prints every step of a run.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";

import {
  KENO_AI_PLAYER_ID,
  MATCH_STATUS,
  RESULT,
  STARTING_LIVES,
  TAP_GRACE_MS,
} from "../src/lib/keno-pvp/constants.js";
import { chooseAiClaim, tileWindowMs } from "../src/lib/keno-pvp/engine.js";

const MODULE_MOCKING_AVAILABLE = typeof mock?.module === "function";
const SKIP_REASON = MODULE_MOCKING_AVAILABLE
  ? false
  : "module mocking is off — run: npm run test:keno-ai-audit";

const HUMAN = "human-1";
const TRACE = process.env.KENO_AUDIT_TRACE === "1";
/** The bot's own seed, mirroring `playAiTurnInTransaction`. */
const aiSeedFor = (matchId) => `keno-pvp:${matchId}:ai`;

// The client's constants (src/app/casino/keno-pvp/[matchId]/PageClient.jsx).
const AI_TURN_PROBE_OFFSETS_MS = [140, 300, 460];
const DEADLINE_NUDGE_CUSHION_MS = 300;
const STATUS_POLL_MS = 5000;

// ── Fake database ─────────────────────────────────────────────────────
//
// Supports exactly the drizzle chains the keno-pvp store uses:
//   tx.select().from(t).where(…).for("update")   → rows
//   tx.update(t).set(…).where(…).returning()     → [row]
//   tx.insert(t).values(…).returning()           → [row]
// Rows are keyed by the table object the store passes in, so the audit never
// has to import the schema.
function createFakeDb() {
  const state = { tables: new Map(), nextId: 1, transactions: 0 };

  const rowsOf = (table) => {
    if (!state.tables.has(table)) state.tables.set(table, []);
    return state.tables.get(table);
  };
  /**
   * The single (match) row — the free AI flow only touches one table.
   * A snapshot, not the live object the store mutates: a scheduled callback
   * that captured the live row would silently read the NEXT tile's state.
   */
  const matchRow = () => {
    for (const rows of state.tables.values()) if (rows.length) return { ...rows[0] };
    return null;
  };

  const select = () => {
    let table = null;
    const builder = {
      from(t) {
        table = t;
        return builder;
      },
      where: () => builder,
      for: () => builder,
      orderBy: () => builder,
      limit: () => builder,
      leftJoin: () => builder,
      then: (resolve, reject) =>
        Promise.resolve(rowsOf(table).map((r) => ({ ...r }))).then(resolve, reject),
    };
    return builder;
  };

  const update = (table) => {
    let values = null;
    const builder = {
      set(v) {
        values = v;
        return builder;
      },
      where: () => builder,
      returning: () =>
        Promise.resolve(
          rowsOf(table).map((row) => ({ ...Object.assign(row, values) })),
        ),
      then: (resolve, reject) => builder.returning().then(resolve, reject),
    };
    return builder;
  };

  const insert = (table) => ({
    values: (v) => ({
      returning: () => {
        const row = { id: state.nextId++, createdAt: new Date(), ...v };
        rowsOf(table).push(row);
        return Promise.resolve([{ ...row }]);
      },
    }),
  });

  const tx = { select, update, insert, execute: async () => {} };

  /**
   * Back to an empty database. The fake does not implement WHERE clauses (the
   * store always targets the one match row under test), so each scenario must
   * start from a database holding exactly ONE match — otherwise every read
   * would resolve to the first row and the audit would grade the wrong match.
   */
  const reset = (firstId = 1) => {
    state.tables.clear();
    state.nextId = firstId;
    state.transactions = 0;
  };

  return {
    state,
    reset,
    matchRow,
    db: {
      transaction: async (fn) => {
        state.transactions += 1;
        return fn(tx);
      },
      select,
      update,
      insert,
    },
  };
}

// ── Virtual clock ─────────────────────────────────────────────────────

function createWorld() {
  return {
    clock: 1_700_000_000_000,
    queue: [],
    seq: 0,
    steps: 0,
    trace: [],
    at: null,
  };
}

function schedule(world, at, kind, run) {
  world.queue.push({ at, seq: world.seq++, kind, run });
  world.queue.sort((a, b) => a.at - b.at || a.seq - b.seq);
}

// The store module is cached across the whole file, so every test must be
// mocked with THE SAME fake database — a fresh instance per test would leave
// the cached module pointing at the first one. Instead the one fake is reset
// before each test.
let sharedFake = null;
function sharedFakeDb() {
  if (!sharedFake) sharedFake = createFakeDb();
  return sharedFake;
}

async function installMocks(t) {
  const fake = sharedFakeDb();
  fake.reset();
  t.mock.module("../src/db/client.ts", { namedExports: { db: fake.db } });
  t.mock.module("../src/lib/keno-pvp/canonicalLifecycle.js", {
    namedExports: { mirrorKenoQueued: () => {}, mirrorKenoTransition: () => {} },
  });
  t.mock.module("../src/lib/prestige.js", {
    namedExports: { applyPrestigeResult: async () => {} },
  });
  t.mock.module("../src/lib/leaderboardCounters.js", {
    namedExports: { applyLeaderboardCounters: async () => {} },
  });
  t.mock.module("../src/lib/cosmetics.ts", {
    namedExports: { getFrameDecorations: async () => [] },
  });
  t.mock.module("../src/lib/emails/system.ts", {
    namedExports: { sendSystemNotificationEmail: async () => {} },
  });
  t.mock.module("../src/lib/stripe/subscriptions.ts", {
    namedExports: { ACTIVE_SUBSCRIPTION_STATUSES: ["active", "trialing"] },
  });
  return fake;
}

/** Freeze the store's clock to the virtual one. */
function installClock(t, world) {
  const realNow = Date.now;
  Date.now = () => world.clock;
  t.after(() => {
    Date.now = realNow;
  });
}

// ── Play a whole match the way the real client does ───────────────────

async function createAiMatch(store) {
  const result = await store.createAiMatch({ userId: HUMAN });
  assert.ok(!result.error, `createAiMatch failed: ${result.error}`);
  const row = result.match;
  assert.equal(row.player1Id, HUMAN);
  assert.equal(row.player2Id, KENO_AI_PLAYER_ID);
  assert.equal(row.isAi, true);
  assert.equal(row.status, MATCH_STATUS.READY);
  return row;
}

/**
 * @param humanDelayMs ({ tile, index, row, windowMs, plan }) → ms after the
 *        client learned of the tile, or null to not tap.
 */
async function playMatch({
  store,
  world,
  fake,
  humanDelayMs = () => null,
  networkLagMs = 0,
  probeOffsetsMs = AI_TURN_PROBE_OFFSETS_MS,
  maxSteps = 20000,
}) {
  const created = await createAiMatch(store);
  const matchId = created.id;
  const userId = HUMAN;
  const stats = {
    botClaims: 0,
    humanClaims: 0,
    humanTaps: 0,
    humanRejections: [],
    probes: 0,
    statusReads: 0,
  };
  let lastSeenKey = null;
  let pollScheduled = false;
  const t0 = world.clock;

  const state = (label) => {
    const row = fake.matchRow();
    if (!TRACE) return;
    world.trace.push(
      `+${String(world.clock - t0).padStart(5)}ms ${label.padEnd(22)} status=${row?.status} ` +
        `tile=${row?.liveTile ?? "-"} idx=${row?.liveTileIndex} lives=${row?.p1Lives}/${row?.p2Lives} ` +
        `tiles=${row?.p1Tiles ?? 0}/${row?.p2Tiles ?? 0}`,
    );
  };

  const readStatus = async () => {
    stats.statusReads += 1;
    const result = await store.fetchMatchWithAutoResolve(userId, matchId);
    assert.ok(!result.error, `status read failed: ${result.error}`);
    const row = fake.matchRow();
    if (!row) return row;

    if (!pollScheduled) {
      pollScheduled = true;
      schedule(world, world.clock + STATUS_POLL_MS, "status", readStatus);
    }
    // The client's deadline nudge: one read just after the window closes, so
    // a both-miss (and the next tile) never waits for the 5s poll.
    const deadline = row.roundDeadline ? new Date(row.roundDeadline).getTime() : null;
    if (deadline && row.status !== MATCH_STATUS.FINISHED) {
      schedule(world, deadline + TAP_GRACE_MS + DEADLINE_NUDGE_CUSHION_MS, "status", readStatus);
    }

    const key =
      row.status === MATCH_STATUS.FINISHED ? "finished" : `${row.liveTileIndex}:${row.liveTile}`;
    if (key === lastSeenKey || row.status === MATCH_STATUS.FINISHED) return row;
    lastSeenKey = key;
    if (!row.liveTile) return row;
    state(`learned tile ${row.liveTile}`);

    // The probe burst re-arms for every newly learned live tile.
    schedule(world, world.clock + networkLagMs, "probe", runProbe);
    for (const offset of probeOffsetsMs) {
      schedule(world, world.clock + offset + networkLagMs, "probe", runProbe);
    }
    const windowMs = tileWindowMs((row.p1Tiles || 0) + (row.p2Tiles || 0));
    // Snapshot the tile: the tap callback fires later, after the row has
    // moved on to the next tile.
    const tile = row.liveTile;
    const index = row.liveTileIndex;
    const plan = chooseAiClaim({
      seed: aiSeedFor(matchId),
      index,
      tile,
      windowMs,
      startedMs: 0,
    });
    const delay = humanDelayMs({ tile, index, row, windowMs, plan });
    if (TRACE) {
      world.trace.push(
        `      plan idx=${index} tile=${tile} window=${windowMs} ` +
          `claims=${plan.claims} reaction=${plan.reactionMs} humanTapIn=${delay}`,
      );
    }
    if (delay != null) {
      schedule(world, world.clock + delay + networkLagMs, "tap", () => humanTap(tile));
    }
    return row;
  };

  const runProbe = async () => {
    stats.probes += 1;
    if (fake.matchRow()?.status === MATCH_STATUS.FINISHED) return;
    const result = await store.playAiTurn({ userId, matchId });
    assert.ok(!result.error, `ai-turn failed: ${result.error}`);
    if (Number(result.actions) > 0) {
      stats.botClaims += 1;
      state("BOT CLAIMED");
      await store.fetchMatchWithAutoResolve(userId, matchId);
      schedule(world, world.clock, "status", readStatus);
    }
  };

  const humanTap = async (tile) => {
    stats.humanTaps += 1;
    const row = fake.matchRow();
    if (!row || row.status === MATCH_STATUS.FINISHED) return;
    if (Number(row.liveTile) !== Number(tile)) {
      stats.humanRejections.push("That tile is not live");
      return;
    }
    const result = await store.claimTile({ userId, matchId, tile });
    if (result.error) {
      stats.humanRejections.push(result.error);
      state(`human tap rejected`);
      await store.fetchMatchWithAutoResolve(userId, matchId);
      schedule(world, world.clock, "status", readStatus);
      return;
    }
    stats.humanClaims += 1;
    state("HUMAN CLAIMED");
    await store.fetchMatchWithAutoResolve(userId, matchId);
    schedule(world, world.clock, "status", readStatus);
  };

  // The page mount: one status read kicks everything off.
  schedule(world, world.clock, "status", readStatus);

  while (world.queue.length) {
    if (world.steps++ > maxSteps) throw new Error("audit: the run never settled");
    const event = world.queue.shift();
    world.clock = Math.max(world.clock, event.at);
    await event.run();
    if (fake.matchRow()?.status === MATCH_STATUS.FINISHED) break;
  }

  return { matchId, stats, finalRow: fake.matchRow(), elapsedMs: world.clock - t0 };
}

/** One mocked store + patched clock, reused for every run in a test. */
async function createSession(t) {
  const fake = await installMocks(t);
  const world = createWorld();
  installClock(t, world);
  const store = await import("../src/lib/keno-pvp/serverStore.js");
  return { fake, world, store };
}

function resetWorld(world) {
  world.clock = 1_700_000_000_000;
  world.queue = [];
  world.seq = 0;
  world.steps = 0;
  world.trace = [];
  return world;
}

async function runScenario(
  session,
  humanDelayMs,
  { networkLagMs = 0, maxSteps, seed = 1, probeOffsetsMs } = {},
) {
  const world = resetWorld(session.world);
  // The match id is the plan's seed, so bumping `seed` runs a different
  // deterministic bot plan/tile draw for the same scenario.
  session.fake.reset(seed);
  const run = await playMatch({
    store: session.store,
    world,
    fake: session.fake,
    humanDelayMs,
    networkLagMs,
    probeOffsetsMs,
    maxSteps,
  });
  if (TRACE) console.log(`\n${world.trace.join("\n")}`);
  return run;
}

/** Who was CREDITED a tile: the named seat, or the faster tap on a tie. */
const creditedSeat = (e) => {
  if (e.outcome === "player1" || e.outcome === "player2") return e.outcome;
  if (e.outcome !== "both_claim") return null;
  const a = e.p1ReactionMs;
  const b = e.p2ReactionMs;
  if (a == null) return "player2";
  if (b == null) return "player1";
  return a <= b ? "player1" : "player2";
};

const outcomeCounts = (row) => {
  const entries = row.tileLog || [];
  return {
    entries,
    // Taps: touching the tile is what keeps that player's life.
    botTaps: entries.filter((e) => e.p2Claimed === true),
    humanTaps: entries.filter((e) => e.p1Claimed === true),
    // Credits: exactly one per resolved tile (zero on a both-miss).
    bot: entries.filter((e) => creditedSeat(e) === "player2"),
    human: entries.filter((e) => creditedSeat(e) === "player1"),
    // Neither player touched the tile — the only way BOTH lose a life.
    miss: entries.filter((e) => e.p1Claimed === false && e.p2Claimed === false),
  };
};

/** The bot's own plan for one resolved tile (same seed/index/tile/window). */
const planForEntry = (matchId, entry) =>
  chooseAiClaim({
    seed: aiSeedFor(matchId),
    index: entry.index,
    tile: entry.tile,
    windowMs: entry.windowMs,
    startedMs: 0,
  });

/**
 * The invariants the bot must satisfy over a whole match:
 *
 *   1. every tile the bot TAPPED was a tile its plan went for, and the graded
 *      reaction is the plan's own reaction — inside the tile's window;
 *   2. the bot's tap is what keeps its OWN life: it never loses a life on a
 *      tile it tapped, and it loses exactly one on every tile it did not;
 *   3. a both-miss only ever happens on a tile the bot's plan DECLINED. A
 *      tile the bot went for can never be a both-miss: that is exactly the
 *      "the AI is not playing" failure.
 */
function assertBotInvariants(run) {
  let expectedP2Lives = STARTING_LIVES;
  for (const entry of run.finalRow.tileLog || []) {
    const plan = planForEntry(run.matchId, entry);
    if (entry.p2Claimed) {
      assert.equal(
        plan.claims,
        true,
        `the bot tapped tile ${entry.tile} without a plan for it ` +
          `match=${run.matchId} entry=${JSON.stringify(entry)} plan=${JSON.stringify(plan)}`,
      );
      assert.equal(
        entry.p2ReactionMs,
        plan.reactionMs,
        `bot reaction on tile ${entry.tile} is not the plan's reaction`,
      );
      assert.ok(
        entry.p2ReactionMs >= 200 && entry.p2ReactionMs <= entry.windowMs,
        `bot reaction ${entry.p2ReactionMs}ms outside its window (${entry.windowMs}ms)`,
      );
    } else {
      // No tap is the bot's own miss — the only thing that costs it a life.
      expectedP2Lives -= 1;
      assert.equal(
        plan.claims,
        false,
        `AUDIT FAILED: tile ${entry.tile} was a miss for the bot although its plan went for it ` +
          `(reaction ${plan.reactionMs}ms, window ${entry.windowMs}ms)`,
      );
    }
    assert.equal(
      entry.p2Lives,
      Math.max(0, expectedP2Lives),
      `the bot's lives after tile ${entry.tile} do not match its own taps`,
    );
  }
}

// ── The audit ─────────────────────────────────────────────────────────

test("AUDIT: createAiMatch makes a free human-vs-bot match ready to race", { skip: SKIP_REASON }, async (t) => {
  const { store, world } = await createSession(t);
  const created = await createAiMatch(store);
  const row = await store.fetchMatch(created.id);
  assert.equal(row.isAi, true);
  assert.equal(Number(row.stakeAmount), 0);
  assert.equal(row.p1Lives, STARTING_LIVES);
  assert.equal(row.p2Lives, STARTING_LIVES);
  assert.ok(new Date(row.roundDeadline).getTime() > world.clock, "the ready banner has a deadline");
});

test("AUDIT: a passive human loses every tile the bot goes for", { skip: SKIP_REASON }, async (t) => {
  const session = await createSession(t);
  const run = await runScenario(session, () => null);
  const { entries, botTaps, humanTaps, miss } = outcomeCounts(run.finalRow);

  assert.equal(humanTaps.length, 0, "the passive human somehow tapped a tile");
  assert.ok(botTaps.length > 0, "AUDIT FAILED: the bot never tapped a single tile");
  assert.equal(run.stats.botClaims, botTaps.length, "every bot tap reported must be in the public log");
  assert.equal(entries.length, botTaps.length + miss.length, "no tile resolved without a log entry");
  assertBotInvariants(run);

  assert.equal(run.finalRow.status, MATCH_STATUS.FINISHED, "the match must settle");
  assert.equal(run.finalRow.result, RESULT.PLAYER2);
  // The passive human never taps, so every tile is THEIR miss: three tiles
  // and their life bar is gone. The bot's own misses are the only thing that
  // ever costs the bot a life.
  assert.equal(run.finalRow.p1Lives, 0);
  assert.equal(run.finalRow.p2Lives, STARTING_LIVES - miss.length);
  assert.equal(entries.length, STARTING_LIVES, "the passive run ends after 3 misses");
});

test("AUDIT: real network lag must not stop the bot from playing", { skip: SKIP_REASON }, async (t) => {
  const session = await createSession(t);
  for (const networkLagMs of [0, 60, 150, 300]) {
    const run = await runScenario(session, () => null, { networkLagMs });
    assert.ok(
      outcomeCounts(run.finalRow).botTaps.length > 0,
      `with ${networkLagMs}ms of lag the bot never tapped a tile`,
    );
    assertBotInvariants(run);
    assert.equal(run.finalRow.status, MATCH_STATUS.FINISHED, `lag ${networkLagMs}ms never settled`);
  }
});

test("AUDIT: a human who taps slower than the bot does not steal its tiles", { skip: SKIP_REASON }, async (t) => {
  // The human watches the tile light and taps 150ms AFTER the bot's own
  // scheduled reaction — the bot's tap instant is earlier, so the tile is the
  // bot's. The slower human still keeps their life (that is the point of the
  // own-miss rules) but must never take the tile credit.
  const session = await createSession(t);
  const run = await runScenario(session, ({ tile, plan }) => {
    if (!tile || !plan?.claims) return null;
    return plan.reactionMs + 150;
  });
  const { bot, human, humanTaps } = outcomeCounts(run.finalRow);
  assert.ok(bot.length > 0, "the bot never claimed a tile at all");
  assert.ok(humanTaps.length > 0, "the slower human never tapped at all");
  assert.equal(
    human.length,
    0,
    `the human stole ${human.length} tile(s) the bot had already tapped — the AI looks like it is not playing`,
  );
  assertBotInvariants(run);
});

test("AUDIT: a human tap that arrives after the bot's instant loses the TILE but not a life", { skip: SKIP_REASON }, async (t) => {
  const session = await createSession(t);
  const { store, world, fake } = session;
  world.clock = 1_700_000_000_000;
  const created = await createAiMatch(store);
  const matchId = created.id;

  // Walk to the first tile the bot actually goes for (a tile its plan declines
  // resolves as a both-miss, which is not what this test is about).
  let learned = await store.fetchMatchWithAutoResolve(HUMAN, matchId);
  let plan = null;
  let guard = 0;
  while (guard++ < 40) {
    const row = fake.matchRow();
    if (row.status !== MATCH_STATUS.READY && row.liveTile) {
      const windowMs = tileWindowMs((row.p1Tiles || 0) + (row.p2Tiles || 0));
      plan = chooseAiClaim({
        seed: aiSeedFor(matchId),
        index: row.liveTileIndex,
        tile: row.liveTile,
        windowMs,
        startedMs: new Date(row.liveStartedAt).getTime(),
      });
      if (plan.claims) break;
    }
    // Advance past this tile's window (a both-miss lights the next one).
    const deadline = row.roundDeadline ? new Date(row.roundDeadline).getTime() : world.clock;
    world.clock = deadline + TAP_GRACE_MS + DEADLINE_NUDGE_CUSHION_MS;
    learned = await store.fetchMatchWithAutoResolve(HUMAN, matchId);
    assert.ok(!learned.error, `status read failed: ${learned.error}`);
  }
  assert.ok(plan?.claims, "no tile in this match has the bot going for it");
  const row = fake.matchRow();
  const tile = row.liveTile;
  const startedMs = new Date(row.liveStartedAt).getTime();
  const p1LivesBefore = row.p1Lives;

  // The human taps 1ms AFTER the bot's own scheduled instant — slower, so the
  // tile is already the bot's. No probe has run: nothing has materialised the
  // bot's claim yet, which is exactly the case a live client hits.
  world.clock = startedMs + plan.reactionMs + 1;
  const result = await store.claimTile({ userId: HUMAN, matchId, tile });

  // The tap LANDS — losing the race no longer rejects it, because losing the
  // race must not cost the human a life. It only loses the tile credit.
  assert.ok(!result.error, `the human tap should be accepted, got ${result.error}`);
  assert.equal(result.claim.aiClaimed, true, "the bot got there first");
  assert.equal(result.claim.credited, false, "the credit is the bot's");
  assert.equal(result.claim.complete, true, "both players have now tapped");
  const entry = result.match.tileLog.at(-1);
  assert.equal(entry.tile, tile);
  assert.equal(entry.outcome, "both_claim", "both tapped — the tile is a shared claim");
  assert.equal(entry.p1Claimed, true, "the human's tap is on the record");
  assert.equal(entry.p2Claimed, true);
  assert.equal(entry.p2ReactionMs, plan.reactionMs, "the log carries the bot's own reaction");
  assert.equal(result.match.p1Lives, p1LivesBefore, "losing the race must not cost the human a life");
  assert.equal(result.match.p2Tiles, 1, "the bot took the tile credit");
});

test("AUDIT: over many matches the bot is a real opponent, not a bystander", { skip: SKIP_REASON }, async (t) => {
  const session = await createSession(t);
  const summary = [];
  // Two human profiles. Under the own-miss rules a life is lost ONLY for
  // your own miss, so a human who never misses cannot be eliminated — the
  // win column belongs to whoever misses. The sloppy profile shows the bot
  // taking matches; the perfect one shows the bot is still beatable.
  const PROFILES = {
    perfect: ({ tile }) => (tile ? 350 : null),
    // Misses roughly one tile in fifteen — close enough to the bot's own ~10%
    // skip rate that either side can run out of lives first.
    sloppy: ({ tile, index }) => (tile ? (index % 15 === 0 ? null : 350) : null),
  };
  for (const [name, humanDelayMs] of Object.entries(PROFILES)) {
    let botTiles = 0;
    let humanTiles = 0;
    let matchesWithBotClaim = 0;
    let botWins = 0;
    let humanWins = 0;
    const matches = 24;
    for (let seed = 1; seed <= matches; seed += 1) {
      const run = await runScenario(session, humanDelayMs, { seed });
      const { bot, human } = outcomeCounts(run.finalRow);
      botTiles += bot.length;
      humanTiles += human.length;
      if (bot.length > 0) matchesWithBotClaim += 1;
      if (run.finalRow.result === RESULT.PLAYER2) botWins += 1;
      if (run.finalRow.result === RESULT.PLAYER1) humanWins += 1;
    }
    summary.push({ name, botTiles, humanTiles, matchesWithBotClaim, botWins, humanWins, matches });
    if (TRACE) {
      console.log(
        `${name} human over ${matches} matches → bot tiles ${botTiles}, human tiles ${humanTiles}, ` +
          `matches where the bot was credited: ${matchesWithBotClaim}, bot wins: ${botWins}, ` +
          `human wins: ${humanWins}`,
      );
    }
  }
  const perfect = summary.find((s) => s.name === "perfect");
  const sloppy = summary.find((s) => s.name === "sloppy");

  // Whatever the human's profile, the bot must actually show up.
  for (const s of summary) {
    assert.ok(
      s.botTiles > 0,
      `a ${s.name} human: the bot never won a tile in ${s.matches} matches`,
    );
    assert.ok(
      s.matchesWithBotClaim >= Math.ceil(s.matches / 2),
      `a ${s.name} human: the bot was credited a tile in only ` +
        `${s.matchesWithBotClaim}/${s.matches} matches`,
    );
  }

  // A human who taps every tile never loses a life, so they take every match:
  // the bot can only win by capitalising on a human's OWN misses.
  assert.equal(perfect.botWins, 0, "a perfect human lost a match the bot could not have won");
  assert.equal(perfect.humanWins, perfect.matches);

  // A human who misses hands the bot matches…
  assert.ok(sloppy.botWins > 0, "a human who skips tiles never lost to the bot");
  // …but the bot is never unbeatable.
  assert.ok(sloppy.humanWins > 0, `the bot won all ${sloppy.matches} matches against a sloppy human`);
});

test("AUDIT: the bot's play does not depend on the client's probe cadence", { skip: SKIP_REASON }, async (t) => {
  const session = await createSession(t);
  // Same seed, same human, two wildly different probe cadences: the shipped
  // burst, one lone ask, and a deliberately useless burst that lands after the
  // whole window. The bot's plan is server-side, so all three must resolve the
  // match identically — that is what the instant-graded tap buys.
  const cadences = {
    shipped: AI_TURN_PROBE_OFFSETS_MS,
    single: [],
    late: [1200, 1500, 1800],
  };
  const results = {};
  for (const [name, offsets] of Object.entries(cadences)) {
    for (const humanMs of [250, 450]) {
      const run = await runScenario(session, ({ tile }) => (tile ? humanMs : null), {
        seed: 7,
        probeOffsetsMs: offsets,
      });
      const { bot, human } = outcomeCounts(run.finalRow);
      results[`${name}:${humanMs}`] = {
        bot: bot.length,
        human: human.length,
        result: run.finalRow.result,
        tiles: run.finalRow.p1Tiles + run.finalRow.p2Tiles,
      };
      assertBotInvariants(run);
    }
  }
  if (TRACE) console.log(JSON.stringify(results, null, 1));
  for (const humanMs of [250, 450]) {
    assert.deepEqual(
      results[`shipped:${humanMs}`],
      results[`single:${humanMs}`],
      "a client that asks the server once must see the same bot as one that asks four times",
    );
    assert.deepEqual(
      results[`shipped:${humanMs}`],
      results[`late:${humanMs}`],
      "a late probe must not change who won a tile",
    );
  }
});

test("AUDIT: a decent human and the bot both claim tiles over a match", { skip: SKIP_REASON }, async (t) => {
  const session = await createSession(t);
  // ~350ms is a real human reaction: inside the bot's 200–420ms band, so the
  // match should be a genuine contest rather than a walkover either way.
  const results = [];
  for (const humanMs of [250, 350, 450]) {
    const run = await runScenario(session, ({ tile }) => (tile ? humanMs : null));
    const { bot, human } = outcomeCounts(run.finalRow);
    results.push({ humanMs, run, bot: bot.length, human: human.length });
    if (TRACE) console.log(`human ${humanMs}ms → bot ${bot.length}, human ${human.length}`);
  }
  for (const r of results) {
    assert.ok(r.human > 0, `a ${r.humanMs}ms human never claimed a tile`);
    assertBotInvariants(r.run);
    assert.equal(r.run.finalRow.status, MATCH_STATUS.FINISHED);
  }
});

test("AUDIT: a fast human still beats the bot to tiles", { skip: SKIP_REASON }, async (t) => {
  const session = await createSession(t);
  const run = await runScenario(session, ({ tile }) => (tile ? 60 : null));
  const { entries, human } = outcomeCounts(run.finalRow);
  assert.ok(human.length > 0, "a 60ms human never claimed a tile");
  assert.equal(run.finalRow.status, MATCH_STATUS.FINISHED);
  assert.ok(entries.length > 0);
  assertBotInvariants(run);
});
