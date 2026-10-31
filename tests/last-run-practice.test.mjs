// tests/last-run-practice.test.mjs
//
// Practice vs the AI is a real match: same seed, same shared course, same
// server clock and the same `{ jump, duck }` input contract. These tests pin
// the two things that make it honest:
//
//   1. the AI actually PLAYS — its scripted transitions, replayed through the
//      engine exactly as the server replays them, jump and duck across the
//      course instead of standing still; and
//   2. practice is never RECORDED — no completion record, therefore no match
//      row, Elo, trophy or history entry, while a ranked pairing still is.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  BOT_SEAT_ID,
  __resetLastRunRegistryForTests,
  createPracticeMatch,
  getCompletionRecord,
  getSnapshot,
  joinQueue,
  peekMatch,
  submitInput,
} from "../src/lib/last-run/matchRegistry.ts";
import { createRunner, sampleInput, speedAt, stepRunner } from "../src/lib/last-run/engine.ts";
import { DT, INPUT_LEAD_TICKS, RUNNER_WIDTH, TICK_MS } from "../src/lib/last-run/constants.ts";
import {
  DEFAULT_PRACTICE_LEVEL,
  PRACTICE_LEVELS,
  PRACTICE_LEVELS_CONFIG,
  sanitizePracticeLevel,
} from "../src/lib/last-run/practice.ts";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SEEDS = 12;

/** Replay one seat exactly the way the registry does: sampleInput → stepRunner. */
function replaySeat(match, seat) {
  const course = match.sim.course;
  const transitions = match.inputs[seat];
  const maxTicks = Math.ceil(course.duration / DT);
  let runner = createRunner();
  let jumped = false;
  let ducked = false;
  let crashedAt = null;

  for (let tick = 0; tick < maxTicks; tick += 1) {
    runner = stepRunner(runner, sampleInput(transitions, tick), tick, DT, course.obstacles);
    if (runner.y > 0.5) jumped = true;
    if (runner.ducking) ducked = true;
    if (!runner.alive) {
      crashedAt = Number((tick * DT).toFixed(2));
      break;
    }
  }

  return {
    jumped,
    ducked,
    crashedAt,
    survivalS: crashedAt ?? Number((maxTicks * DT).toFixed(2)),
    distance: Math.round(runner.distance),
  };
}

function withPractice(name = "Runner", level = DEFAULT_PRACTICE_LEVEL) {
  const userId = `practice-${Math.random().toString(36).slice(2)}`;
  const { matchId } = createPracticeMatch({ userId, name, level });
  const match = peekMatch(matchId);
  assert.ok(match, "the practice match must exist in the registry");
  return { userId, matchId, match };
}

test.beforeEach(() => {
  __resetLastRunRegistryForTests();
});

test("a practice match seats the scripted AI as the second seat", () => {
  const { match } = withPractice();
  assert.equal(match.practice, true, "the match is flagged as practice");
  assert.equal(match.players.player2.userId, BOT_SEAT_ID, "the AI holds the second seat");
  assert.notEqual(match.seed, undefined, "the user's seed still comes from the server");
  // Transition COUNT depends on where this seed fumbles, so the schedule is
  // pinned by what it does, not by how many entries it happens to log.
  assert.ok(match.inputs.player2.length >= 4, "the AI arrives with a scripted run, not an empty log");
  assert.ok(replaySeat(match, "player2").distance > 500, "the scripted run actually moves");
  assert.equal(match.inputs.player1.length, 0, "the human seat starts neutral");
});

test("the AI actually plays: it runs, jumps and ducks the shared course", () => {
  const runs = [];
  for (let index = 0; index < SEEDS; index += 1) {
    const { match } = withPractice(`Runner ${index}`);
    runs.push({ seed: match.seed, ...replaySeat(match, "player2") });
  }

  for (const run of runs) {
    assert.ok(run.jumped, `seed ${run.seed}: the AI must jump obstacles`);
    assert.ok(
      run.survivalS >= 5,
      `seed ${run.seed}: the AI must get past the opening (survived ${run.survivalS}s)`,
    );
    assert.ok(run.distance > 600, `seed ${run.seed}: the AI must travel (${run.distance}px)`);
  }

  assert.ok(
    runs.some((run) => run.ducked),
    "at least one of the AI's runs must duck a beam — the duck is a real input, not a decoration",
  );
  assert.ok(
    runs.some((run) => run.crashedAt === null),
    "the AI must be able to run a course clean — a bot that always dies is not a match",
  );
});

test("the AI's run is deterministic for its own match", () => {
  const { match } = withPractice();
  const first = replaySeat(match, "player2");
  const second = replaySeat(match, "player2");
  assert.deepEqual(second, first, "the same match replays the same AI run");
});

/** A competent human seat: the obstacle read a player makes, on time. */
function humanPolicy(runner, tick, obstacles) {
  const front = runner.distance + RUNNER_WIDTH;
  const next = obstacles.find((obstacle) => obstacle.x + obstacle.width > runner.distance);
  if (!next) return { jump: false, duck: false };
  const eta = (next.x - front) / speedAt(tick * DT);
  if (next.kind === "beam") {
    const under = next.x < front && next.x + next.width > runner.distance;
    return { jump: false, duck: eta < 0.26 && (eta > 0 || under) };
  }
  return { jump: eta > 0 && eta <= 0.17, duck: false };
}

/**
 * Play the human seat the way the browser does: poll the snapshot, send only
 * transitions, and land each one on the tick it was decided for.
 */
function driveHuman({ match, userId, seconds }) {
  const obstacles = match.sim.course.obstacles;
  let runner = createRunner();
  let held = { jump: false, duck: false };
  let snapshot = null;
  const ticks = Math.ceil(seconds / DT);

  for (let tick = 0; tick < ticks; tick += 1) {
    const desired = humanPolicy(runner, tick, obstacles);
    if (desired.jump !== held.jump || desired.duck !== held.duck) {
      held = desired;
      const accepted = submitInput({
        matchId: match.id,
        userId,
        payload: held,
        now: match.startsAt + Math.max(0, tick - INPUT_LEAD_TICKS) * TICK_MS + 1,
      });
      assert.equal(accepted.ok, true, `human input rejected at tick ${tick}`);
    }
    runner = stepRunner(runner, held, tick, DT, obstacles);
    snapshot = getSnapshot({
      matchId: match.id,
      userId,
      now: match.startsAt + (tick + INPUT_LEAD_TICKS) * TICK_MS + 1,
    });
  }

  return snapshot;
}

test("the AI's silence never forfeits the match — the engine still ends the run", () => {
  const { userId, match } = withPractice();
  // Twelve seconds in, well past the disconnect grace: the AI has never polled.
  const live = driveHuman({ match, userId, seconds: 12 });
  assert.ok(live);
  assert.equal(live.opponent.connected, true, "the AI seat has no poll to miss");
  assert.equal(live.final, null, "an unanswered AI must not forfeit the practice match");
  assert.equal(live.you.alive, true, "the human seat is still running");
  assert.ok(
    live.opponent.distance > 2_000,
    `the AI must have been running (${Math.round(live.opponent.distance)}px)`,
  );

  // Poll again with no further human input: the human's own runner keeps
  // running and hits the course. The match must end on the ENGINE's verdict —
  // never as an abandonment of the AI seat, which has not polled all match.
  const later = getSnapshot({
    matchId: match.id,
    userId,
    now: match.startsAt + 32_000,
  });
  assert.ok(later?.final, "the abandoned run is still resolved");
  assert.notEqual(later.final.reason, "abandon", "the AI's silence must never forfeit the match");
  assert.ok(["crash", "time"].includes(later.final.reason), "the engine decides how it ends");
});

test("practice is never recorded, while a ranked pairing still is", () => {
  const practice = withPractice();
  const finishedPractice = getSnapshot({
    matchId: practice.matchId,
    userId: practice.userId,
    now: practice.match.startsAt + 90_000,
  });
  assert.ok(finishedPractice?.final, "the practice match finishes");
  assert.equal(finishedPractice.practice, true);
  assert.equal(
    getCompletionRecord(practice.matchId, practice.userId),
    null,
    "practice must produce no completion record — no row, no Elo, no trophy",
  );

  // Control: a real pairing still yields a completion record.
  __resetLastRunRegistryForTests();
  const one = joinQueue({ userId: "ranked-a", name: "A" });
  joinQueue({ userId: "ranked-b", name: "B" });
  assert.equal(one.status, "queued");
  const paired = joinQueue({ userId: "ranked-a", name: "A" });
  assert.equal(paired.status, "matched");
  getSnapshot({ matchId: paired.matchId, userId: "ranked-a", now: Date.now() + 90_000 });
  const record = getCompletionRecord(paired.matchId, "ranked-a");
  assert.ok(record, "a ranked match is still recorded");
  assert.equal(record.playerCount, 2);
});

test("the practice route exists and only serves signed-in POSTs", () => {
  const route = path.join(ROOT, "src/app/api/last-run/practice/route.ts");
  assert.ok(fs.existsSync(route), "the lobby's Race the AI button needs this route");
  const source = fs.readFileSync(route, "utf8");
  assert.match(source, /export async function POST/);
  assert.match(source, /Unauthorized/);
  assert.match(source, /createPracticeMatch/);
});

test("difficulty: the server sanitises the level and defaults to normal", () => {
  assert.equal(sanitizePracticeLevel(undefined), "normal");
  assert.equal(sanitizePracticeLevel(null), "normal");
  assert.equal(sanitizePracticeLevel(" HARDCORE "), "normal", "an unknown level is not an error");
  assert.equal(sanitizePracticeLevel({ level: "easy" }), "normal");
  assert.equal(sanitizePracticeLevel("HARD"), "hard", "case is not part of the contract");
  assert.deepEqual([...PRACTICE_LEVELS], ["easy", "normal", "hard"]);
});

test("difficulty: each level is a measurably different opponent", () => {
  __resetLastRunRegistryForTests();
  const averageSurvival = (level) => {
    const runs = [];
    for (let index = 0; index < 16; index += 1) {
      const { match } = withPractice(`Level ${level} ${index}`, level);
      runs.push(replaySeat(match, "player2").survivalS);
    }
    return runs.reduce((total, value) => total + value, 0) / runs.length;
  };

  const easy = averageSurvival("easy");
  const normal = averageSurvival("normal");
  const hard = averageSurvival("hard");

  assert.ok(
    easy < normal,
    `easy (avg ${easy.toFixed(1)}s) must be weaker than normal (avg ${normal.toFixed(1)}s)`,
  );
  assert.ok(
    normal < hard,
    `normal (avg ${normal.toFixed(1)}s) must be weaker than hard (avg ${hard.toFixed(1)}s)`,
  );
  assert.ok(
    PRACTICE_LEVELS_CONFIG.easy.cleanRunChance < PRACTICE_LEVELS_CONFIG.normal.cleanRunChance &&
      PRACTICE_LEVELS_CONFIG.normal.cleanRunChance < PRACTICE_LEVELS_CONFIG.hard.cleanRunChance,
    "the level table is ordered from weakest to strongest",
  );
  // A difficulty may only change how often the AI misses, never the course:
  // the finish line is the same distance whatever level is chosen (obstacle
  // COUNTS differ between seeds by construction, so compare the course length).
  const { match: easyMatch } = withPractice("Fairness", "easy");
  const { match: hardMatch } = withPractice("Fairness", "hard");
  assert.equal(easyMatch.sim.course.duration, hardMatch.sim.course.duration);
  assert.equal(
    Math.round(easyMatch.sim.course.length),
    Math.round(hardMatch.sim.course.length),
    "the finish line is the same distance at every level",
  );
  for (const level of PRACTICE_LEVELS) {
    const { match } = withPractice(`Same course ${level}`, level);
    const sameSeed = withPractice(`Same course ${level}`, level).match;
    assert.notEqual(match.seed, sameSeed.seed, "each practice still draws its own seed");
  }
});

test("difficulty: the chosen level rides on the match and its snapshot", () => {
  const { userId, match } = withPractice("Elite", "hard");
  assert.equal(match.practiceLevel, "hard");
  const snapshot = getSnapshot({ matchId: match.id, userId, now: match.startsAt + 500 });
  assert.equal(snapshot.practiceLevel, "hard", "the result screen can name the bot it played");

  // A ranked pairing is never a practice level.
  __resetLastRunRegistryForTests();
  joinQueue({ userId: "level-a", name: "A" });
  joinQueue({ userId: "level-b", name: "B" });
  const paired = joinQueue({ userId: "level-a", name: "A" });
  const ranked = getSnapshot({ matchId: paired.matchId, userId: "level-a", now: Date.now() });
  assert.equal(ranked.practice, false);
  assert.equal(ranked.practiceLevel, DEFAULT_PRACTICE_LEVEL);
});

// Guard: the AI's scripted run is an INPUT LOG, never a recorded position.
test("the AI submits inputs only — the engine still decides the crash", () => {
  const { match } = withPractice();
  for (const transition of match.inputs.player2) {
    assert.deepEqual(
      Object.keys(transition).sort(),
      ["duck", "jump", "tick"],
      "a transition is { tick, jump, duck } and nothing else",
    );
    assert.equal(typeof transition.jump, "boolean");
    assert.equal(typeof transition.duck, "boolean");
  }
  const run = replaySeat(match, "player2");
  assert.ok(run.distance > RUNNER_WIDTH * 10, "the AI's distance comes from the engine stepping");
});
