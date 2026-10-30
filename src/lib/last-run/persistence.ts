// src/lib/last-run/persistence.ts
//
// LAST RUN → GRYND's durable progression records.
//
// ── WHAT IS WRITTEN, AND WHERE ────────────────────────────────────────────
//
//   * `match_lifecycle` — the canonical platform match record every game
//     mirrors (created at pairing, advanced to `ready`, then `started` when the
//     server's clock reaches the race, then `completed` exactly once).
//   * `match_lifecycle_events` — the canonical outbox; its completion payload
//     carries participants, outcome, survival/distance, duration and seed.
//   * `last_run_matches` — the durable per-match row (migration 0233): both
//     Clerk ids, the seat-absolute result, the engine's survival times and
//     distances, the seed and the rating flag. This is what the result screen
//     and the match history read.
//   * `rating_events` / `trophy_events` — via the shared writers inside the
//     SAME transaction, keyed by (user, game_key, match_id).
//
// All of it happens in `settleLastRunMatch` (./settlement.ts), in ONE
// transaction, so a match record, its lifecycle completion and its rating can
// never be partially applied.
//
// ── FAILURE POLICY ────────────────────────────────────────────────────────
//
// Every write is triggered off the authoritative path and awaited only where a
// caller explicitly wants the persisted answer (the result endpoint). A
// database hiccup is logged and NEVER fails the player's request or delays the
// result screen. Without DATABASE_URL (local UI work, tests) the module is a
// no-op, and the screen says the result could not be recorded — it never
// invents one.
//
// ── IDEMPOTENCY ───────────────────────────────────────────────────────────
//
//   * `last_run_matches.id` is the match id, inserted with ON CONFLICT DO
//     NOTHING;
//   * the lifecycle transition is rejected by the canonical state machine once
//     the row is `completed`, and the completion event uses a DETERMINISTIC id;
//   * `rating_events` / `trophy_events` are unique per (user, game, match);
//   * concurrent calls for one match are coalesced in-process.

import { eq } from "drizzle-orm";

import { db } from "../../db";
import { matchLifecycle } from "../../db/schema";
import type { MatchLifecycleStatus } from "../matchLifecycle";
import { createMatchLifecycle, transitionMatchLifecycle } from "../matchLifecycleStore";
import { LAST_RUN_GAME_KEY } from "./constants";
import type { LastRunCompletion } from "./outcome";
import { settleLastRunMatch } from "./settlement";

export type { LastRunCompletion } from "./outcome";

const MODE = "pvp";

type Pairing = { matchId: string; queuedAt: number; playerCount: number };

/** Per-process coalescing. A failure is never cached, so a retry can succeed. */
const inflight = new Map<string, Promise<void>>();
const startRecorded = new Set<string>();
const completionsWritten = new Set<string>();

function databaseConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

function runOnce(key: string, work: () => Promise<void>): Promise<void> {
  if (!databaseConfigured()) return Promise.resolve();
  const existing = inflight.get(key);
  if (existing) return existing;
  const job = work()
    .catch((error) => {
      console.error(
        "[last-run] progression write failed:",
        error instanceof Error ? error.message : error,
      );
    })
    .finally(() => {
      inflight.delete(key);
    });
  inflight.set(key, job);
  return job;
}

async function statusOf(matchId: string): Promise<MatchLifecycleStatus | null> {
  const [row] = await db
    .select({ status: matchLifecycle.status })
    .from(matchLifecycle)
    .where(eq(matchLifecycle.matchId, matchId))
    .limit(1);
  return (row?.status as MatchLifecycleStatus | undefined) ?? null;
}

/**
 * Create the canonical lifecycle row at pairing and move it to `ready`.
 *
 * `queued → forming → ready` is the platform's own path for a match that was
 * found and seated immediately, so LAST RUN never invents a transition the
 * canonical state machine forbids.
 */
export function mirrorLastRunPairing(pairing: Pairing): Promise<void> {
  return runOnce(`pairing:${pairing.matchId}`, async () => {
    try {
      await createMatchLifecycle({
        matchId: pairing.matchId,
        gameKey: LAST_RUN_GAME_KEY,
        mode: MODE,
        playerCount: pairing.playerCount,
        queuedAt: new Date(pairing.queuedAt),
      });
    } catch (error) {
      // A retry finds the row already there; anything else is logged by runOnce.
      const message = error instanceof Error ? error.message : String(error);
      if (!/duplicate key|already exists/i.test(message)) throw error;
    }
    for (const status of ["forming", "ready"] as const) {
      try {
        await transitionMatchLifecycle({
          matchId: pairing.matchId,
          to: status,
          at: new Date(pairing.queuedAt),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/Invalid match lifecycle transition/i.test(message)) throw error;
      }
    }
  });
}

/**
 * Record the moment the authoritative simulation actually starts.
 *
 * Called from the snapshot route once the server's clock has passed `startsAt`.
 * Idempotent: the state machine refuses a second `started`, and the process
 * remembers the successful write. A settlement that arrives first simply brings
 * the row straight to `started` + `completed` itself.
 */
export function markLastRunStarted({ matchId, at }: { matchId: string; at: number }): Promise<void> {
  if (startRecorded.has(matchId)) return Promise.resolve();
  return runOnce(`start:${matchId}`, async () => {
    const status = await statusOf(matchId);
    if (!status) {
      // Pairing mirror never landed (e.g. a server restart). Rebuild it.
      await mirrorLastRunPairing({ matchId, queuedAt: at, playerCount: 2 });
    }
    let current = await statusOf(matchId);
    if (!current || current === "started" || current === "completed" || current === "cancelled") {
      startRecorded.add(matchId);
      return;
    }
    // A row that only reached `queued` (pairing partially failed) walks the
    // canonical path to `started` rather than skipping a forbidden edge.
    if (current === "queued") {
      for (const status of ["forming", "ready"] as const) {
        await transitionMatchLifecycle({ matchId, to: status, at: new Date(at) });
      }
      current = "ready";
    }
    try {
      await transitionMatchLifecycle({ matchId, to: "started", at: new Date(at), playerCount: 2 });
      startRecorded.add(matchId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/Invalid match lifecycle transition/i.test(message)) {
        startRecorded.add(matchId);
        return;
      }
      throw error;
    }
  });
}

/**
 * Persist one authoritative completion.
 *
 * The single entry point used by the snapshot route, the forfeit route and the
 * result route. Every durable effect (match row, lifecycle completion, Elo,
 * trophies) is committed by `settleLastRunMatch` in one transaction; a
 * duplicate call is a no-op at the database regardless of this process.
 */
export function persistLastRunCompletion(completion: LastRunCompletion): Promise<void> {
  if (!databaseConfigured()) return Promise.resolve();
  if (completionsWritten.has(completion.matchId)) return Promise.resolve();
  return runOnce(`completion:${completion.matchId}`, async () => {
    const outcome = await settleLastRunMatch(completion);
    if (outcome.settled || outcome.duplicate) {
      completionsWritten.add(completion.matchId);
    }
  });
}

/** Test/QA hook: forget the in-process caches. Never called by a route. */
export function __resetLastRunPersistenceForTests(): void {
  inflight.clear();
  startRecorded.clear();
  completionsWritten.clear();
}
