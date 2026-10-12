// src/lib/deadlineRead.ts
//
// The ONE authoritative READ a clocked match needs, and which stamped instant
// each game's board is waiting on.
//
// Every clocked game on the platform stores its pacing in the database as an
// absolute instant (`turnDeadline`, `matchDeadline`, `roundDeadline`, …) and
// turns that instant into a transition ONLY inside a read — the store's
// `fetchMatchWithAutoResolve` / `advanceMatchOnPoll` / `game-state` path. That
// read comes from the client, and the match pages no longer poll: they moved to
// `useMatchSync` (one read on socket reconnect, one on tab focus, never on a
// timer).
//
// A deadline nobody read past therefore just ran out, and the failure looked
// like the game being broken rather than like a missing request. Reported
// symptoms, all one defect:
//
//   * "when the cooldown finishes, the game doesn't start" — the pre-game
//     countdown (Tower Arena, Mines Duel, Four in a Row, Keno, Lane Rush,
//     Precision): both players sat on a finished countdown and the first move
//     never came; a countdown that DID have a reader could still be a beat late,
//     which is what `DEADLINE_READ_ANCHORED_SLACK_MS` is for;
//   * a stalling opponent was never timed out, and a race whose clock expired
//     with both seats idle was never graded.
//
// The fix is one bounded, deadline-driven read per pending instant — NEVER a
// recurring poll. `useDeadlineRead` arms it; the selectors below say which
// instant a game is waiting on. Bring the read forward with the matching
// selector rather than hand-rolling a `setTimeout` in the page, so every game
// keeps the same timing rule (`deadlineReadDelayMs`) and the same bound.
//
// Timing rule:
//
//   * the read must land AFTER the deadline, because the stores only advance
//     once the deadline has passed (`deadline > now` → not yet); and
//   * it may be retried a few times, because a device clock skewed ahead of the
//     server's can make the first read arrive early and a backgrounded tab can
//     have its timers throttled.
//
// The retries are deliberately BOUNDED: this watches one stamped instant for the
// few seconds it lasts. A deadline that somehow cannot be advanced costs a
// handful of reads and then stops.

/** Slack added to the stamped deadline so the read lands after it, covering the
 *  round trip and any device/server clock difference. */
export const DEADLINE_READ_SLACK_MS = 400;

/**
 * Slack used INSTEAD of `DEADLINE_READ_SLACK_MS` when the caller can express
 * the current time in the SERVER's clock (see `useDeadlineRead`'s `serverNow`).
 *
 * The 400ms above is one number covering two very different errors: the device's
 * clock skew (seconds, and the only reason it is that large) and the request's
 * own flight time. A caller that carries a server-aligned clock — every match
 * page that estimates the offset from its own poll round trip, which is most of
 * them — has already removed the first error, so anchoring the read in server
 * time leaves only the offset estimate's residual (the RTT asymmetry, a few ms)
 * and the timer's own firing slop.
 *
 * That is what the player SEES: the countdown reaching 0 and the game then
 * starting. The read cannot land before the stamped instant — the stores advance
 * only once it has passed — so this is the one place where a smaller number is
 * both safe and directly visible, and every millisecond of the old 400 was spent
 * showing a finished countdown (reported as "when the countdown reaches 0 the
 * game doesn't start immediately", in Keno and Precision alike). The retry below
 * is the backstop for the residual: an estimate that lands early costs one
 * retry, not the round.
 */
export const DEADLINE_READ_ANCHORED_SLACK_MS = 120;

/**
 * How long to wait before re-reading a deadline that did not advance.
 *
 * This is the recovery path for BOTH remaining failure modes of the first read:
 * a device clock (or an offset estimate) skewed AHEAD of the server's, which
 * makes the read arrive before the store will advance; and a backgrounded tab
 * whose timers were throttled past the deadline. Keeping it short is what bounds
 * how late the game can start when the first read misses — at 1s the recovery
 * alone was longer than the stall players complained about.
 */
export const DEADLINE_READ_RETRY_MS = 250;

/** Hard cap on reads per deadline, including the first one. Start countdowns
 *  are a few seconds and turn windows at most a minute, so this window stays
 *  bounded whatever the deadline says. */
export const DEADLINE_READ_MAX_ATTEMPTS = 6;

/**
 * Delay from `nowMs` until the first read that can advance the match.
 *
 * Never negative (an already-elapsed deadline reads immediately), and always at
 * least `slackMs` past the stamped instant — a read that landed before the
 * deadline would return the unchanged state and, without this, leave the match
 * sitting on it.
 *
 * `slackMs` defaults to `DEADLINE_READ_SLACK_MS`. A caller that has already
 * expressed `nowMs` in the SERVER's clock passes
 * `DEADLINE_READ_ANCHORED_SLACK_MS` instead: the slack is there to cover the
 * device clock's skew, and a server-anchored clock has had that skew taken out
 * of it already.
 */
export function deadlineReadDelayMs(
  deadlineMs: number,
  nowMs: number,
  slackMs: number = DEADLINE_READ_SLACK_MS,
): number {
  const slack = Number.isFinite(slackMs) ? slackMs : DEADLINE_READ_SLACK_MS;
  if (!Number.isFinite(deadlineMs)) return slack;
  return Math.max(0, deadlineMs - nowMs) + slack;
}

/** A stamped instant, in whatever shape the API/projection hands over. */
export type StampedInstant = string | number | Date | null | undefined;

// ── Which instant each game's board is waiting on ────────────────────────
//
// Every selector is pure and takes a STRUCTURAL match view, so the rule can be
// unit-tested without importing a page, and so a projection can be renamed
// without silently disabling the read. Each returns `null` when the match is
// waiting on nothing, which is what stops the timer.

/** Tower Arena. `status`/`phase`/`turnDeadline`, `paused` for free play. */
export interface TowerArenaReadSource {
  status?: string | null;
  phase?: string | null;
  isAi?: boolean | null;
  paused?: boolean | null;
  turnDeadline?: StampedInstant;
}

/**
 * Tower Arena: the start countdown in any mode, plus an ONLINE placement turn's
 * own window.
 *
 *   * `countdown` — the 10s start countdown. The read is what starts the match
 *     (`startMatchTx`), and it is also what broadcasts the start, so the other
 *     seat follows without a timer of its own.
 *   * an ACTIVE `placement` turn — humans only: a vs-AI match is untimed for the
 *     human, and its bot turns are already driven by the client's `/ai-turn`
 *     call plus the store's own bot backstop.
 *
 * A paused free-play match is excluded: the server freezes the turn engine while
 * paused, so there is nothing at the deadline to advance.
 */
export function towerArenaDueRead(
  match: TowerArenaReadSource | null | undefined,
): StampedInstant {
  if (!match || !match.turnDeadline) return null;
  if (match.phase === "countdown") return match.turnDeadline;
  if (
    match.status === "active" &&
    match.phase === "placement" &&
    !match.isAi &&
    !match.paused
  ) {
    return match.turnDeadline;
  }
  return null;
}

/** Four in a Row. `status`/`readyDeadlineAt`/`moveDeadlineAt`/`isAiGame`. */
export interface FourInARowReadSource {
  status?: string | null;
  isAiGame?: boolean | null;
  readyDeadlineAt?: StampedInstant;
  moveDeadlineAt?: StampedInstant;
}

/**
 * Four in a Row: the ready countdown in any mode, plus a HUMAN match's move
 * window.
 *
 *   * `ready` — `advanceReadyIfNeeded` flips the game to `in_progress` (and
 *     stamps the first move deadline) only once `readyDeadlineAt` has passed.
 *     The route's own comment calls it "Poll-driven (the game-state route calls
 *     this on every fetch)"; without a reader the board sat on "Get ready…"
 *     forever.
 *   * `in_progress` — a human's move window. `settleTimeoutIfNeeded` awards the
 *     game to the opponent, and with no reader a stalling player could never
 *     lose on time. A vs-AI game is left out on purpose: the timer is visible
 *     but the server settles it on any incidental read, and a practice game
 *     should not be lost by a player who stepped away from the screen.
 */
export function fourInARowDueRead(
  game: FourInARowReadSource | null | undefined,
): StampedInstant {
  if (!game) return null;
  if (game.status === "ready") return game.readyDeadlineAt ?? null;
  if (game.status === "in_progress" && !game.isAiGame) {
    return game.moveDeadlineAt ?? null;
  }
  return null;
}

/** Mines Duel. `status`/`readyDeadline`/`matchDeadline`/`isAi`. */
export interface MinesPvpReadSource {
  status?: string | null;
  isAi?: boolean | null;
  readyDeadline?: StampedInstant;
  matchDeadline?: StampedInstant;
}

/**
 * Mines Duel: the ready banner in any mode, plus a HUMAN match's own timer.
 *
 *   * `ready` — `fetchMatchWithAutoResolve`'s first step is "Ready banner
 *     elapsed → go live (opens the single 180s timer)". Nothing else calls it.
 *   * `active` — the 180s match timer. `isMatchExpired` → `maybeResolve` decides
 *     the winner, so a human duel where neither seat finishes needs this read or
 *     the match never resolves. Practice is left out for the same reason as
 *     Four in a Row.
 */
export function minesPvpDueRead(
  match: MinesPvpReadSource | null | undefined,
): StampedInstant {
  if (!match) return null;
  if (match.status === "ready") return match.readyDeadline ?? null;
  if (match.status === "active" && !match.isAi) return match.matchDeadline ?? null;
  return null;
}

/** Lane Rush Duel. `status`/`roundDeadline`. */
export interface LaneRushReadSource {
  status?: string | null;
  roundDeadline?: StampedInstant;
}

/**
 * Lane Rush Duel: the READY window only.
 *
 * `roundDeadline` carries two different instants in this game — the ready
 * window, then the 15s tile window — and the page already nudges the tile window
 * from its own countdown. Only the ready window (`advanceFromReady`) had no
 * reader, which is why the page could sit on "Get ready…".
 */
export function laneRushDueRead(
  match: LaneRushReadSource | null | undefined,
): StampedInstant {
  if (!match || match.status !== "ready") return null;
  return match.roundDeadline ?? null;
}

/** Keno Duel. `status`/`readyDeadline`. */
export interface KenoPvpReadSource {
  status?: string | null;
  readyDeadline?: StampedInstant;
}

/**
 * Keno Duel: the ready banner only.
 *
 * The tile window is a separate instant (`liveDeadline`) and the page already
 * nudges it. The ready banner — `lightNextTile` on the read's first step — had
 * no reader, so "Get ready…" never became the first lit tile.
 */
export function kenoPvpDueRead(
  match: KenoPvpReadSource | null | undefined,
): StampedInstant {
  if (!match || match.status !== "ready") return null;
  return match.readyDeadline ?? null;
}

/** Precision. `phase`/`countdownEndsAt`. */
export interface PrecisionReadSource {
  phase?: string | null;
  countdownEndsAt?: StampedInstant;
}

/**
 * Precision: the pre-round `arming` countdown.
 *
 * The round opens when the `arming` → `active` transition is APPLIED, and the
 * realtime server's due scheduler is an accelerator, not a requirement: it only
 * runs while a socket is in the match room and only from a process that is up.
 * Without a reader in the page, the countdown reaching 0 was therefore followed
 * by dead air until some other event (a socket broadcast, a tab refocus) happened
 * to read the match — the reported "when the countdown reaches 0, the game
 * doesn't start immediately".
 *
 * Only the arming countdown is listed. The bot's own stop instant is deliberately
 * NOT a public field (it is published as `state.aiStop` only once it has been
 * applied), so a client cannot read for it — and it does not need to: the store
 * reports that instant to the realtime server as `nextDueAtMs`, whose scheduler
 * wakes on it, records the bot's stop and announces the round result. A human's
 * own stop does NOT bring it forward (that parked both rockets while the bot was
 * still flying); the round is decided when the LAST stop lands.
 */
export function precisionDueRead(
  state: PrecisionReadSource | null | undefined,
): StampedInstant {
  if (!state || state.phase !== "arming") return null;
  return state.countdownEndsAt ?? null;
}

/**
 * Speed Typing: the race limit.
 *
 * The DTO's `deadlineMs` is the absolute instant (`goAt + RACE_LIMIT_MS`) at
 * which `resolveRaceIfDue` grades the race on the read path — both seats stop
 * being able to score at it, so a race where nobody finishes sits in `playing`
 * with a finished clock. The store's comment justifies the read with "the arena
 * polls the snapshot every 2 s", a poll the sync migration removed. Practice is
 * NOT excluded: the bot heartbeat stops once the bot has finished, so a human
 * who walked away mid-race still needs this read to settle.
 */
export function speedTypingDueRead(race: {
  deadlineMs?: number | null;
  goAtMs?: number | null;
  finished?: boolean;
  resolved?: boolean;
} | null | undefined): number | null {
  if (!race || race.finished || race.resolved) return null;
  if (race.goAtMs === null || race.goAtMs === undefined) return null;
  const deadline = Number(race.deadlineMs);
  if (!Number.isFinite(deadline) || deadline <= 0) return null;
  return deadline;
}
