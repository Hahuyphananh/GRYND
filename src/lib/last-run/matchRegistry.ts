// src/lib/last-run/matchRegistry.ts
//
// THE AUTHORITATIVE LAST RUN REGISTRY.
//
// ── WHAT THIS OWNS ────────────────────────────────────────────────────────
//
//   * the queue and the pairing (two players, one unique match id);
//   * the match seed and configuration (generated once, from node:crypto);
//   * the shared start instant (server clock + a fixed 3.2 s 3–2–1);
//   * each seat's recorded INPUT TRANSITIONS, and nothing else from a client;
//   * the simulation itself, advanced on the server from the shared engine;
//   * the single, idempotent finalisation of a match.
//
// A client can never submit a position, a distance, a collision, a survival
// time or a winner. It submits `{ jump, duck }`; the server stamps the tick,
// replays the engine, and decides.
//
// ── WHY IN-PROCESS ────────────────────────────────────────────────────────
//
// GRYND's other games persist matches in Postgres because their state is
// turn-based and must survive a restart. LAST RUN is a 75-second live
// simulation stepped every request; keeping it in memory means no new table,
// no migration and no per-tick database writes — the $0 constraint — at the
// cost of a restart ending in-flight matches (a clearly reported forfeit, never
// a fabricated win). The registry is process-wide, so the server that pairs the
// players is also the only server that simulates their match.
//
// ── FAIRNESS ──────────────────────────────────────────────────────────────
//
// Every input is scheduled INPUT_LEAD_TICKS ahead of the tick the server has
// already simulated. That removes the "my jump arrived late" race without
// letting a client backdate an input, and it keeps `advance()` forward-only.

import { randomInt, randomUUID } from "node:crypto";

import { snapshotForSeat, type MatchBroadcast } from "./broadcast";

import {
  COUNTDOWN_MS,
  COURSE_DURATION_S,
  DISCONNECT_GRACE_MS,
  DT,
  INPUT_LEAD_TICKS,
  RUNNER_WIDTH,
  MATCH_MAX_MS,
  MAX_INPUTS_PER_SECOND,
  QUEUE_TTL_MS,
  SEATS,
  SNAPSHOT_AHEAD_PX,
  SNAPSHOT_BEHIND_PX,
  SNAPSHOT_MAX_OBSTACLES,
  TICK_MS,
  otherSeat,
  type Seat,
} from "./constants";
import {
  createRng,
  createRunner,
  createSimulation,
  sampleInput,
  speedAt,
  stepRunner,
  stepSimulation,
  type Course,
  type InputTransition,
  type Obstacle,
  type RunnerInput,
  type RunnerState,
  type SimulationState,
} from "./engine";
import {
  DEFAULT_PRACTICE_LEVEL,
  PRACTICE_LEVELS_CONFIG,
  sanitizePracticeLevel,
  type PracticeLevel,
} from "./practice";

/**
 * The practice opponent's seat id.
 *
 * It is NOT a Clerk id, so it can never hold a durable record: a practice
 * match produces no completion record (see `getCompletionRecord`), and the one
 * seat in it that is never expected to poll is excluded from the abandonment
 * policy below.
 */
export const BOT_SEAT_ID = "last-run:ai";
export const BOT_NAME = "TRAINING AI";

// ── Types ───────────────────────────────────────────────────────────────

export type EndReason = "crash" | "time" | "abandon" | "left";

export type FinalResult = {
  result: Seat | "draw";
  reason: EndReason;
  tick: number;
  endedAt: number;
};

type MatchPlayer = {
  userId: string;
  name: string;
  /** Last authorised call touching this match; drives the abandonment policy. */
  lastSeen: number;
};

export type LastRunMatch = {
  id: string;
  seed: number;
  /** True when the second seat is the server-scripted AI (never recorded). */
  practice: boolean;
  /** The level the AI was built at; `normal` for every ranked match. */
  practiceLevel: PracticeLevel;
  createdAt: number;
  /** The simulation's tick 0. Before this the match is in countdown. */
  startsAt: number;
  players: Record<Seat, MatchPlayer>;
  inputs: Record<Seat, InputTransition[]>;
  /** Sliding-window timestamps for per-seat input rate limiting. */
  inputTimes: Record<Seat, number[]>;
  sim: SimulationState;
  final: FinalResult | null;
};

export type MatchPhase = "countdown" | "racing" | "finished";

export type SnapshotSeat = {
  seat: Seat;
  name: string;
  distance: number;
  y: number;
  /**
   * Vertical velocity, px/s. A client that is not predicting the rival's inputs
   * can still continue its jump arc exactly from `(y, vy)` — airborne motion is
   * pure gravity — so the arc stays smooth between authoritative reads.
   */
  vy: number;
  /** True while the feet are on the ground line. */
  onGround: boolean;
  ducking: boolean;
  alive: boolean;
  crashedAtTick: number | null;
  survivalMs: number;
  connected: boolean;
};

export type MatchSnapshot = {
  matchId: string;
  seed: number;
  /** Practice matches are unrated and never written to `last_run_matches`. */
  practice: boolean;
  /** The AI's difficulty, so the result screen and a rematch can name it. */
  practiceLevel: PracticeLevel;
  phase: MatchPhase;
  serverNow: number;
  startsAt: number;
  elapsedMs: number;
  tick: number;
  you: SnapshotSeat;
  opponent: SnapshotSeat;
  course: {
    duration: number;
    length: number;
    obstacles: Pick<Obstacle, "id" | "kind" | "x" | "width" | "height" | "minY">[];
  };
  final: FinalResult | null;
};

type QueueEntry = { userId: string; name: string; at: number };

type Registry = {
  queue: QueueEntry[];
  matches: Map<string, LastRunMatch>;
  /** userId → { matchId, at } so a polling player learns it was paired. */
  assignments: Map<string, { matchId: string; at: number }>;
};

/** A single registry per Node process (Next dev reloads must not fork it). */
const globalForLastRun = globalThis as typeof globalThis & {
  __lastRunRegistry?: Registry;
};

function registry(): Registry {
  if (!globalForLastRun.__lastRunRegistry) {
    globalForLastRun.__lastRunRegistry = { queue: [], matches: new Map(), assignments: new Map() };
  }
  return globalForLastRun.__lastRunRegistry;
}

// ── Small helpers ───────────────────────────────────────────────────────

/** Display-only name. Never used for authorisation. */
export function sanitizeName(raw: unknown): string {
  if (typeof raw !== "string") return "Runner";
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 24);
  return cleaned.length > 0 ? cleaned : "Runner";
}

function seatOf(match: LastRunMatch, userId: string): Seat | null {
  if (match.players.player1.userId === userId) return "player1";
  if (match.players.player2.userId === userId) return "player2";
  return null;
}

function prune(now: number): void {
  const state = registry();
  state.queue = state.queue.filter((entry) => now - entry.at < QUEUE_TTL_MS);
  for (const [userId, assignment] of state.assignments) {
    if (now - assignment.at > QUEUE_TTL_MS) state.assignments.delete(userId);
  }
  // Drop matches that have been finished for long enough to be irrelevant,
  // and any match that never finished and can no longer be played (both seats
  // long gone). Without this second sweep a never-polled match would leak for
  // the life of the process.
  for (const [id, match] of state.matches) {
    if (match.final) {
      if (now - match.final.endedAt > 10 * 60_000) state.matches.delete(id);
    } else if (now - match.createdAt > MATCH_MAX_MS + 2 * 60_000) {
      state.matches.delete(id);
    }
  }
}

// ── Queue / pairing ─────────────────────────────────────────────────────

export type QueueResult =
  | { status: "queued" }
  | { status: "matched"; matchId: string };

/**
 * Add a player to the queue, or pair them with the longest-waiting opponent.
 *
 * Idempotent: calling it again as the same player returns the same status and
 * never creates a second queue entry or a second match.
 */
export function joinQueue({
  userId,
  name,
  now = Date.now(),
}: {
  userId: string;
  name: unknown;
  now?: number;
}): QueueResult {
  prune(now);
  const state = registry();

  // Already paired? Re-use the assignment instead of queueing twice.
  const existing = state.assignments.get(userId);
  if (existing) {
    const match = state.matches.get(existing.matchId);
    if (match) return { status: "matched", matchId: match.id };
    state.assignments.delete(userId);
  }

  // Already waiting? Refresh the entry rather than duplicating it.
  const queued = state.queue.find((entry) => entry.userId === userId);
  if (queued) {
    queued.at = now;
    queued.name = sanitizeName(name);
    return { status: "queued" };
  }

  const opponent = state.queue.find((entry) => entry.userId !== userId);
  if (!opponent) {
    state.queue.push({ userId, name: sanitizeName(name), at: now });
    return { status: "queued" };
  }

  state.queue = state.queue.filter((entry) => entry.userId !== opponent.userId);
  const match = createMatch({ player1: opponent, player2: { userId, name: sanitizeName(name) }, now });
  state.matches.set(match.id, match);
  state.assignments.set(opponent.userId, { matchId: match.id, at: now });
  state.assignments.set(userId, { matchId: match.id, at: now });
  return { status: "matched", matchId: match.id };
}

/** Leave the queue. Safe when the player was never in it. */
export function leaveQueue(userId: string): boolean {
  const state = registry();
  const before = state.queue.length;
  state.queue = state.queue.filter((entry) => entry.userId !== userId);
  state.assignments.delete(userId);
  return state.queue.length !== before;
}

/** Where does this player stand right now? */
export function queueStatus(userId: string, now = Date.now()): QueueResult | { status: "idle" } {
  prune(now);
  const state = registry();
  const assignment = state.assignments.get(userId);
  if (assignment) {
    const match = state.matches.get(assignment.matchId);
    if (match) return { status: "matched", matchId: match.id };
    state.assignments.delete(userId);
  }
  if (state.queue.some((entry) => entry.userId === userId)) return { status: "queued" };
  return { status: "idle" };
}

/**
 * Create ONE match from two queue entries.
 *
 * The seed is minted here, once, with node:crypto — both seats share it, and
 * neither client ever chooses it. `startsAt` is the server's clock plus the
 * fixed countdown, so both clients count down to the SAME authoritative instant.
 */
function createMatch({
  player1,
  player2,
  now,
  practice = false,
  practiceLevel = DEFAULT_PRACTICE_LEVEL,
}: {
  player1: QueueEntry;
  player2: { userId: string; name: string };
  now: number;
  practice?: boolean;
  practiceLevel?: PracticeLevel;
}): LastRunMatch {
  const seed = randomInt(0, 0x100000000);
  return {
    id: randomUUID(),
    seed,
    practice,
    practiceLevel,
    createdAt: now,
    startsAt: now + COUNTDOWN_MS,
    players: {
      player1: { userId: player1.userId, name: player1.name, lastSeen: now },
      player2: { userId: player2.userId, name: player2.name, lastSeen: now },
    },
    inputs: { player1: [], player2: [] },
    inputTimes: { player1: [], player2: [] },
    sim: createSimulation(seed, COURSE_DURATION_S),
    final: null,
  };
}

// ── Practice vs the AI ──────────────────────────────────────────────────
//
// The AI is a SCRIPTED runner, not a second engine: its input transitions are
// generated once, up front, from the same course the player gets, and then
// replayed through the same `sampleInput` -> `stepRunner` path as any seat. It
// never sees the player's position, never gets a different obstacle list, and
// every collision is decided by the normal engine. Nothing about it is peer to
// the player's authority: the match is still advanced by the server alone.

/** Takeoff lead before a crate/spike's leading edge, seconds. */
const BOT_JUMP_LEAD_S = 0.17;
/** Duck lead before a beam's leading edge, seconds. */
const BOT_DUCK_LEAD_S = 0.26;
/**
 * How often the AI runs the whole course clean is a LEVEL decision — see
 * src/lib/last-run/practice.ts. A scripted runner that never missed would make
 * every practice run a draw at best, which is a bad training partner, so even
 * the hard bot misses occasionally and the player wins by outlasting it.
 */

function nextObstacle(obstacles: readonly Obstacle[], distance: number): Obstacle | null {
  for (const obstacle of obstacles) {
    if (obstacle.x + obstacle.width > distance) return obstacle;
  }
  return null;
}

function botInput(
  runner: RunnerState,
  obstacle: Obstacle | null,
  tick: number,
): RunnerInput {
  if (!obstacle) return { jump: false, duck: false };
  const front = runner.distance + RUNNER_WIDTH;
  const speed = speedAt(tick * DT);
  const eta = (obstacle.x - front) / speed;
  if (obstacle.kind === "beam") {
    const under = obstacle.x < front && obstacle.x + obstacle.width > runner.distance;
    return { jump: false, duck: eta < BOT_DUCK_LEAD_S && (eta > 0 || under) };
  }
  return { jump: eta > 0 && eta <= BOT_JUMP_LEAD_S, duck: false };
}

/**
 * The AI's whole run, as recorded transitions.
 *
 * Simulated here with `stepRunner` — the very function the match replays — so
 * the scripted seat behaves EXACTLY as it will inside the live match. A crash
 * is left in the script; the engine, not this helper, decides the result.
 */
function scriptBotRun(course: Course, seed: number, level: PracticeLevel): InputTransition[] {
  const transitions: InputTransition[] = [{ tick: 0, jump: false, duck: false }];
  const config = PRACTICE_LEVELS_CONFIG[level];
  const rand = createRng(seed ^ 0x9e3779b9);
  const lastId = course.obstacles[course.obstacles.length - 1]?.id ?? 0;
  const windowEnd = Math.floor(lastId * config.fumbleWindow);
  const candidates = course.obstacles.filter(
    (obstacle) => obstacle.id >= config.fumbleFromId && obstacle.id <= windowEnd,
  );
  const fumbleId =
    candidates.length > 0 && rand() > config.cleanRunChance
      ? candidates[Math.min(candidates.length - 1, Math.floor(rand() * candidates.length))].id
      : -1;
  let runner = createRunner();
  let held: RunnerInput = { jump: false, duck: false };
  const maxTicks = Math.ceil(course.duration / DT);

  for (let tick = 0; tick < maxTicks; tick += 1) {
    const next = nextObstacle(course.obstacles, runner.distance);
    // The one deliberate miss: no input at all for that obstacle, so the crash
    // is the ordinary engine collision, never a scripted "bot loses" event.
    const desired =
      next && next.id === fumbleId ? { jump: false, duck: false } : botInput(runner, next, tick);
    if (desired.jump !== held.jump || desired.duck !== held.duck) {
      held = desired;
      transitions.push({ tick, jump: held.jump, duck: held.duck });
    }
    runner = stepRunner(runner, held, tick, DT, course.obstacles);
    if (!runner.alive) break;
  }

  return transitions;
}

/**
 * Start (or resume) a free practice match against the scripted AI.
 *
 * One live practice per player: a second click re-uses the match already
 * running instead of minting another (which would leak a registry entry for
 * every double-click). The AI's name is display-only and its seat id is not a
 * Clerk id, so `getCompletionRecord` never yields a record for this match and
 * no rating, trophy, history row or `last_run_matches` row is written.
 */
export function createPracticeMatch({
  userId,
  name,
  level,
  now = Date.now(),
}: {
  userId: string;
  name: unknown;
  /** Untrusted: sanitised here, so an unknown value is `normal`, not an error. */
  level?: unknown;
  now?: number;
}): { matchId: string; level: PracticeLevel } {
  prune(now);
  const state = registry();
  const practiceLevel = sanitizePracticeLevel(level);

  // One live practice per player PER LEVEL: asking for the same bot again
  // resumes the run in progress, asking for a different one starts that bot
  // instead of silently handing back the old difficulty.
  for (const match of state.matches.values()) {
    if (
      match.practice &&
      !match.final &&
      match.practiceLevel === practiceLevel &&
      match.players.player1.userId === userId
    ) {
      return { matchId: match.id, level: match.practiceLevel };
    }
  }

  const match = createMatch({
    player1: { userId, name: sanitizeName(name), at: now },
    player2: { userId: BOT_SEAT_ID, name: BOT_NAME },
    now,
    practice: true,
    practiceLevel,
  });
  match.inputs.player2 = scriptBotRun(match.sim.course, match.seed, practiceLevel);
  state.matches.set(match.id, match);
  return { matchId: match.id, level: practiceLevel };
}

// ── Finalisation ─────────────────────────────────────────────────────────

/**
 * Close the match EXACTLY once.
 *
 * Every path (a crash the engine found, a disconnect, a timeout) funnels
 * through here, and a second call returns the first result unchanged. That is
 * what makes result submission idempotent: no path can settle twice.
 */
function finalize(match: LastRunMatch, result: Seat | "draw", reason: EndReason, tick: number, now: number): FinalResult {
  if (match.final) return match.final;
  match.final = { result, reason, tick, endedAt: now };
  return match.final;
}

// ── Simulation advance ──────────────────────────────────────────────────

function currentTick(match: LastRunMatch, now: number): number {
  const maxTicks = Math.ceil(MATCH_MAX_MS / TICK_MS);
  return Math.max(0, Math.min(maxTicks, Math.floor((now - match.startsAt) / TICK_MS)));
}

/**
 * Advance the match to `now`, applying only inputs the server has already
 * accepted, and finalise it if the engine says it is over.
 *
 * Forward-only: `sim.tick` never moves backwards, so a late duplicate call is
 * free and can never rewrite history.
 */
function advance(match: LastRunMatch, now: number): void {
  if (match.final) return;

  const target = currentTick(match, now);

  // Abandonment: a seat that has not made a single authorised call for longer
  // than the platform's grace window forfeits. This is the same policy as the
  // Socket.IO disconnect-forfeit timers used by the other games, applied to
  // this registry instead of to a realtime-server participant map.
  //
  // The clock is anchored at the START of the race, not at pairing. `lastSeen`
  // is initialised when the match is created, so measuring from it would forfeit
  // a player whose page is still loading (a slow phone, a backgrounded tab) a
  // few seconds after the countdown begins — a win for whoever polled first,
  // without either runner moving. Grace therefore counts from whichever is
  // later: the last authorised call, or tick 0.
  // The scripted AI seat never polls and is never expected to: measuring its
  // silence would forfeit every practice match ten seconds in.
  const silent = SEATS.filter(
    (seat) =>
      match.players[seat].userId !== BOT_SEAT_ID &&
      now - Math.max(match.players[seat].lastSeen, match.startsAt) > DISCONNECT_GRACE_MS,
  );
  if (silent.length === SEATS.length) {
    finalize(match, "draw", "abandon", match.sim.tick, now);
    return;
  }
  if (silent.length === 1) {
    finalize(match, otherSeat(silent[0]), "abandon", match.sim.tick, now);
    return;
  }

  while (match.sim.tick < target && !match.sim.end) {
    const tick = match.sim.tick;
    match.sim = stepSimulation(match.sim, {
      player1: sampleInput(match.inputs.player1, tick),
      player2: sampleInput(match.inputs.player2, tick),
    });
  }

  if (match.sim.end) {
    finalize(match, match.sim.end.result, match.sim.end.reason, match.sim.end.tick, now);
  }
}

// ── Input submission ────────────────────────────────────────────────────

export type InputAcceptance =
  | { ok: true; tick: number }
  | { ok: false; status: number; error: string };

/**
 * Record one input transition for a seat.
 *
 * Validation, in order: the caller must hold a seat in this match, the match
 * must be live and un-finished, the payload must be booleans, and the seat must
 * stay under MAX_INPUTS_PER_SECOND. The tick is the SERVER's — received-at plus
 * the input lead — so a client cannot claim a position in the past.
 */
export function submitInput({
  matchId,
  userId,
  payload,
  now = Date.now(),
}: {
  matchId: string;
  userId: string;
  payload: unknown;
  now?: number;
}): InputAcceptance {
  const match = registry().matches.get(matchId);
  if (!match) return { ok: false, status: 404, error: "Match not found" };

  const seat = seatOf(match, userId);
  if (!seat) return { ok: false, status: 403, error: "You are not in this match" };

  match.players[seat].lastSeen = now;

  if (match.final) return { ok: false, status: 409, error: "Match already finished" };
  if (now < match.startsAt) return { ok: false, status: 409, error: "Countdown still running" };

  const body = payload as { jump?: unknown; duck?: unknown } | null;
  if (!body || typeof body.jump !== "boolean" || typeof body.duck !== "boolean") {
    return { ok: false, status: 400, error: "jump and duck must be booleans" };
  }

  // Sliding-window rate limit. A client spamming transitions cannot buy extra
  // simulation steps; it can only lose its own inputs after the cap.
  const times = match.inputTimes[seat].filter((at) => now - at < 1000);
  if (times.length >= MAX_INPUTS_PER_SECOND) {
    return { ok: false, status: 429, error: "Too many input events" };
  }
  times.push(now);
  match.inputTimes[seat] = times;

  advance(match, now);
  if (match.final) return { ok: false, status: 409, error: "Match already finished" };

  // Schedule ahead of the simulated tick: the server has already stepped
  // through every earlier tick, so this transition lands in untouched time.
  const tick = currentTick(match, now) + INPUT_LEAD_TICKS;
  const log = match.inputs[seat];
  const previous = log[log.length - 1];
  if (previous && previous.tick === tick) {
    // Two transitions inside one tick collapse: the last one wins.
    previous.jump = body.jump;
    previous.duck = body.duck;
  } else if (!previous || previous.tick < tick) {
    log.push({ tick, jump: body.jump, duck: body.duck });
  } else {
    return { ok: false, status: 409, error: "Out-of-order input" };
  }

  return { ok: true, tick };
}

/** A player who leaves deliberately forfeits — never a free win for both. */
export function forfeitMatch({
  matchId,
  userId,
  reason = "left",
  now = Date.now(),
}: {
  matchId: string;
  userId: string;
  reason?: EndReason;
  now?: number;
}): FinalResult | null {
  const match = registry().matches.get(matchId);
  if (!match) return null;
  const seat = seatOf(match, userId);
  if (!seat) return null;
  if (match.final) return match.final;
  return finalize(match, otherSeat(seat), reason, match.sim.tick, now);
}

// ── Snapshot ────────────────────────────────────────────────────────────

function windowObstacles(match: LastRunMatch): MatchSnapshot["course"]["obstacles"] {
  const { player1, player2 } = match.sim.runners;
  const from = Math.min(player1.distance, player2.distance) - SNAPSHOT_BEHIND_PX;
  const to = Math.max(player1.distance, player2.distance) + SNAPSHOT_AHEAD_PX;
  const window = match.sim.course.obstacles.filter(
    (obstacle) => obstacle.x + obstacle.width >= from && obstacle.x <= to,
  );
  return window.slice(0, SNAPSHOT_MAX_OBSTACLES).map((o) => ({
    id: o.id,
    kind: o.kind,
    x: o.x,
    width: o.width,
    height: o.height,
    minY: o.minY,
  }));
}

function seatSnapshot(match: LastRunMatch, seat: Seat, now: number): SnapshotSeat {
  const player = match.players[seat];
  const runner = match.sim.runners[seat];
  const crashedAtTick = runner.crashedAtTick;
  return {
    seat,
    name: player.name,
    distance: runner.distance,
    y: runner.y,
    vy: runner.vy,
    onGround: runner.onGround,
    ducking: runner.ducking,
    alive: runner.alive,
    crashedAtTick,
    survivalMs: Math.round((crashedAtTick ?? match.sim.tick) * TICK_MS),
    // Same anchor as the forfeit rule: nobody is "disconnected" for failing to
    // poll during the countdown they never had to poll through. The AI seat is
    // always connected — it has no poll to miss.
    connected:
      player.userId === BOT_SEAT_ID ||
      now - Math.max(player.lastSeen, match.startsAt) <= DISCONNECT_GRACE_MS,
  };
}

function phaseOf(match: LastRunMatch, now: number): MatchPhase {
  return match.final ? "finished" : now < match.startsAt ? "countdown" : "racing";
}

/**
 * The viewer-NEUTRAL snapshot of a live match, addressed by seat.
 *
 * This is the payload the realtime push carries: ONE build per match instead of
 * one per player, with no opinion about who is asking. It advances the
 * simulation exactly like `getSnapshot` does.
 *
 * It deliberately does NOT refresh a seat's `lastSeen`. Presence is the seat's
 * own authorised read; if a push loop could refresh it, a closed tab would look
 * alive forever and the abandonment policy would stop working.
 */
export function getBroadcastSnapshot(matchId: string, now = Date.now()): MatchBroadcast | null {
  prune(now);
  const match = registry().matches.get(matchId);
  if (!match) return null;

  advance(match, now);

  return {
    matchId: match.id,
    seed: match.seed,
    practice: match.practice,
    practiceLevel: match.practiceLevel,
    phase: phaseOf(match, now),
    serverNow: now,
    startsAt: match.startsAt,
    elapsedMs: Math.max(0, Math.min(MATCH_MAX_MS, now - match.startsAt)),
    tick: match.sim.tick,
    seats: {
      player1: seatSnapshot(match, "player1", now),
      player2: seatSnapshot(match, "player2", now),
    },
    course: {
      duration: match.sim.course.duration,
      length: match.sim.course.length,
      obstacles: windowObstacles(match),
    },
    final: match.final,
  };
}

/**
 * The authoritative snapshot for one seat.
 *
 * Membership is enforced here: a caller without a seat gets `null`, so knowing a
 * match id is still not enough to watch it over HTTP. The seat's own read is
 * what records presence, and the same neutral build the push uses is filtered
 * down to this seat — so both delivery paths render identically.
 */
export function getSnapshot({
  matchId,
  userId,
  now = Date.now(),
}: {
  matchId: string;
  userId: string;
  now?: number;
}): MatchSnapshot | null {
  prune(now);
  const match = registry().matches.get(matchId);
  if (!match) return null;
  const seat = seatOf(match, userId);
  if (!seat) return null;

  match.players[seat].lastSeen = now;

  const broadcast = getBroadcastSnapshot(matchId, now);
  return broadcast ? snapshotForSeat(broadcast, seat) : null;
}

/** Test/QA hook: a clean registry. Never called by a route handler. */
export function __resetLastRunRegistryForTests(): void {
  globalForLastRun.__lastRunRegistry = { queue: [], matches: new Map(), assignments: new Map() };
}

/** Read-only view of a match, for diagnostics and tests. */
export function peekMatch(matchId: string): LastRunMatch | undefined {
  return registry().matches.get(matchId);
}

/**
 * The SERVER-computed completion record for progression, or null.
 *
 * Membership is enforced (a caller without a seat gets null), and the record
 * carries only what the platform's match record can support: seat results,
 * server survival times, server distances and the authoritative timestamps.
 * The input log and the simulation itself never leave the process.
 */
export function getCompletionRecord(matchId: string, userId: string): {
  matchId: string;
  seed: number;
  queuedAt: number;
  startedAt: number;
  endedAt: number;
  result: Seat | "draw";
  reason: EndReason;
  outcome: "win" | "loss" | "draw";
  /** The two Clerk ids the server paired — never client-supplied. */
  player1Id: string;
  player2Id: string;
  durations: { player1: number; player2: number };
  distances: { player1: number; player2: number };
  playerCount: number;
} | null {
  const match = registry().matches.get(matchId);
  if (!match || !match.final) return null;
  // Practice is never recorded: no match record, no Elo, no trophy.
  if (match.practice) return null;
  const seat = seatOf(match, userId);
  if (!seat) return null;

  const runner = (side: Seat) => match.sim.runners[side];
  const survival = (side: Seat) => {
    const crashed = runner(side).crashedAtTick;
    return Math.round((crashed ?? match.sim.tick) * TICK_MS);
  };
  const outcome: "win" | "loss" | "draw" =
    match.final.result === "draw" ? "draw" : match.final.result === seat ? "win" : "loss";

  return {
    matchId: match.id,
    seed: match.seed,
    queuedAt: match.createdAt,
    startedAt: match.startsAt,
    endedAt: match.final.endedAt,
    result: match.final.result,
    reason: match.final.reason,
    outcome,
    player1Id: match.players.player1.userId,
    player2Id: match.players.player2.userId,
    durations: { player1: survival("player1"), player2: survival("player2") },
    distances: {
      player1: Math.round(runner("player1").distance),
      player2: Math.round(runner("player2").distance),
    },
    playerCount: 2,
  };
}

/** How many players are waiting. Cheap, used by the lobby indicator. */
export function queueLength(now = Date.now()): number {
  prune(now);
  return registry().queue.length;
}

export const LAST_RUN_TICK_SECONDS = DT;
