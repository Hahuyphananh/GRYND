// src/lib/last-run/realtime.ts
//
// SERVER-ONLY: the LAST RUN push loop.
//
// ── WHAT THIS DOES ────────────────────────────────────────────────────────
//
// While a match is being watched, the server pushes its snapshot to
// `last-run:match:<id>` ten times a second, so the world arrives on the socket
// instead of being requested frame by frame. Two transports are used, in this
// order, exactly like the other realtime games in this repo:
//
//   1. `globalThis.io` when the realtime server runs in this process (the
//      bundled deployment);
//   2. otherwise the realtime server's internal `POST /emit`, authenticated
//      with REALTIME_INTERNAL_SECRET (the split-process deployment).
//
// ── WHY A TIMER, AND WHY IT STOPS ─────────────────────────────────────────
//
// The registry advances the simulation lazily, on each read, so a push needs a
// clock of its own. The timer is per match and idempotent (`ensure…`), is
// `unref`'d so it can never keep the process alive, emits the final state once
// and then clears itself, and stops on its own when no seat has read the match
// for IDLE_STOP_MS — a closed tab must not leave a loop running.
//
// ── PRESENCE IS STILL THE READ ────────────────────────────────────────────
//
// Pushing never refreshes a seat's `lastSeen`: only an authorised read (the
// seat's own snapshot request) does. A push loop therefore cannot keep a
// disconnected player from forfeiting.
//
// ── FAILURE IS NEVER FATAL ────────────────────────────────────────────────
//
// No realtime URL, no secret, a timeout or a 500 all mean "the page falls back
// to its read". Nothing here may fail the request that started it, and a slow
// realtime server is skipped rather than queued (one push in flight per match).

import { LAST_RUN_SNAPSHOT_EVENT, lastRunMatchRoom } from "./broadcast";
import { getBroadcastSnapshot } from "./matchRegistry";
import type { MatchBroadcast } from "./broadcast";

/** Ten frames a second: the rate the arena has always drawn at. */
const PUSH_INTERVAL_MS = 100;

/** No seat has read the match for this long ⇒ nobody is watching; stop. */
const IDLE_STOP_MS = 5_000;

type InProcessIo = { to: (room: string) => { emit: (event: string, payload: unknown) => void } };

type Pusher = {
  /** The pending frame. Self-scheduled: one send at a time, never a queue. */
  timer: ReturnType<typeof setTimeout> | null;
  /** When the next frame is DUE (anchored, so timer lateness never accumulates). */
  nextAt: number;
  /** Last authorised read of this match, i.e. "someone is still watching". */
  lastReadAt: number;
  stopped: boolean;
};

const globalForLastRunPush = globalThis as typeof globalThis & {
  __lastRunPushers?: Map<string, Pusher>;
};

function pushers(): Map<string, Pusher> {
  if (!globalForLastRunPush.__lastRunPushers) {
    globalForLastRunPush.__lastRunPushers = new Map();
  }
  return globalForLastRunPush.__lastRunPushers;
}

function realtimeUrl(): string {
  return String(
    process.env.REALTIME_INTERNAL_URL || process.env.NEXT_PUBLIC_SOCKET_URL || "",
  )
    .trim()
    .replace(/\/+$/, "");
}

function inProcessIo(): InProcessIo | null {
  const io = (globalThis as { io?: InProcessIo }).io;
  return io && typeof io.to === "function" ? io : null;
}

/** Is there any realtime transport at all? Without one, nothing is scheduled. */
export function lastRunPushConfigured(): boolean {
  return Boolean(inProcessIo() || realtimeUrl());
}

/** Broadcast to one room. Returns false when the transport could not be used. */
async function emit(room: string, event: string, payload: MatchBroadcast): Promise<boolean> {
  const io = inProcessIo();
  if (io) {
    try {
      io.to(room).emit(event, payload);
      return true;
    } catch {
      // Fall through to the HTTP path below.
    }
  }

  const baseUrl = realtimeUrl();
  if (!baseUrl) return false;

  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (process.env.REALTIME_INTERNAL_SECRET) {
      headers["x-internal-secret"] = process.env.REALTIME_INTERNAL_SECRET;
    }
    await fetch(`${baseUrl}/emit`, {
      method: "POST",
      headers,
      body: JSON.stringify({ room, event, payload }),
      signal: AbortSignal.timeout(1_500),
    });
    return true;
  } catch {
    // Fire-and-forget: the seat's own read is the fallback.
    return false;
  }
}

/**
 * Build this match's snapshot now and push it once.
 *
 * Returns false when the match is not live in this process (a restart, a
 * finished-and-pruned match, or a match owned by another instance).
 */
export async function pushLastRunSnapshot(matchId: string, now = Date.now()): Promise<boolean> {
  const broadcast = getBroadcastSnapshot(matchId, now);
  if (!broadcast) return false;
  return emit(lastRunMatchRoom(matchId), LAST_RUN_SNAPSHOT_EVENT, broadcast);
}

function stop(matchId: string): void {
  const entry = pushers().get(matchId);
  if (!entry) return;
  entry.stopped = true;
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = null;
  pushers().delete(matchId);
}

/**
 * Start (or keep alive) the push loop for one match.
 *
 * Idempotent: called from every authorised read, it only marks the match as
 * still being watched. Does nothing when no realtime transport is configured,
 * so a deployment without sockets keeps its ordinary read path and no timer.
 */
export function ensureLastRunPusher(matchId: string, now = Date.now()): void {
  if (!lastRunPushConfigured()) return;

  const existing = pushers().get(matchId);
  if (existing) {
    existing.lastReadAt = now;
    return;
  }

  const entry: Pusher = { timer: null, nextAt: now + PUSH_INTERVAL_MS, lastReadAt: now, stopped: false };

  // SELF-SCHEDULING and ANCHORED, not a fixed interval. A fixed interval loses
  // a frame whenever a send outlasts the period, and a bare `setTimeout(100)`
  // accumulates the host's timer lateness (Windows quantises timers by >10 ms,
  // which turns a 100 ms cadence into ~111 ms). Here the next frame is armed
  // only after the previous one was sent, against a due-time that advances by
  // exactly one period, so a late wake-up catches up instead of drifting.
  function schedule(): void {
    if (entry.stopped) return;
    entry.timer = setTimeout(pump, Math.max(0, entry.nextAt - Date.now()));
    // Never let a per-match timer keep the process (or a test run) alive.
    (entry.timer as { unref?: () => void }).unref?.();
  }

  const pump = async (): Promise<void> => {
    if (entry.stopped) return;
    const began = Date.now();

    // Nobody has read this match for a while: the tab is gone.
    if (began - entry.lastReadAt > IDLE_STOP_MS) {
      stop(matchId);
      return;
    }

    let finished = false;
    try {
      const broadcast = getBroadcastSnapshot(matchId);
      // The match was pruned, or another instance owns it.
      if (!broadcast) {
        stop(matchId);
        return;
      }
      await emit(lastRunMatchRoom(matchId), LAST_RUN_SNAPSHOT_EVENT, broadcast);
      finished = broadcast.phase === "finished";
    } catch {
      // The next frame tries again; a sending failure is never fatal.
    }

    // A finished match has exactly one more frame to send. Without this the
    // loop would keep re-sending the result until the idle timeout.
    if (finished) {
      stop(matchId);
      return;
    }
    entry.nextAt += PUSH_INTERVAL_MS;
    // A real stall (a suspended tab, a blocked event loop) resets the anchor
    // rather than replaying a backlog of frames in one burst.
    if (Date.now() - entry.nextAt > PUSH_INTERVAL_MS) {
      entry.nextAt = Date.now() + PUSH_INTERVAL_MS;
    }
    schedule();
  };

  pushers().set(matchId, entry);
  schedule();
}

/**
 * The final frame of a match is the last thing a seat needs. Called by the read
 * that observes `final`, so the result lands on the socket at once instead of on
 * the next tick — the loop then clears itself.
 */
export function flushLastRunFinal(matchId: string, now = Date.now()): void {
  const entry = pushers().get(matchId);
  if (!entry) return;
  void pushLastRunSnapshot(matchId, now);
  stop(matchId);
}

/** Stop pushing one match (left, forfeited, cancelled). */
export function stopLastRunPusher(matchId: string): void {
  stop(matchId);
}

/** Test/QA hook: drop every loop. Never called by a route handler. */
export function __resetLastRunPushersForTests(): void {
  for (const [matchId, entry] of pushers()) {
    entry.stopped = true;
    if (entry.timer) clearTimeout(entry.timer);
    pushers().delete(matchId);
  }
}
