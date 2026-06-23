// ── Anomaly-detection ledger for the Precision PvP casino game ─────────
//
// PURPOSE — Audit-only suspicious-behavior tracker.
//
// We watch for three classes of behavior on the server-side stop
// telemetry:
//   1. `IMPOSSIBLE_REACTION` — a single `elapsedMs` below
//      `PRECISION_IMPOSSIBLE_REACTION_MS` (~80ms). Below this threshold
//      the server-measured reaction time is faster than humanly
//      plausible regardless of target knowledge; only programmatic
//      input / spoofing / pre-cognition would land there.
//   2. `LOW_VARIANCE` — across a per-match sliding window, the user's
//      coefficient-of-variation (CV = stddev / mean) is below
//      `PRECISION_LOW_VARIANCE_CV` (1%). Human reaction-time variance
//      in a reaction game typically lands at CV > 0.05; sub-1% CV is
//      robotic / scripted.
//   3. `HIGH_VARIANCE` — across the same sliding window, CV is above
//      `PRECISION_HIGH_VARIANCE_CV` (100% — stddev at-or-greater than
//      the mean). Wildly inconsistent performance suggests multi-
//      devices / hot-swapping inputs.
//
// All three flags fire `console.warn` lines that operators can grep
// for in production logs. We DO NOT auto-ban — the ledger is purely
// observational and any ban decision is left to the operator / a
// downstream process.
//
// ── LOG DEDUP POLICY ──
// To avoid log spam while preserving audit fidelity:
//   * `impossible` — logs every round that triggers it (each is a
//     distinct event with its own `elapsedMs` and `roundSequence`).
//   * `lowVariance` / `highVariance` — log ONCE per match per user
//     because they describe a per-match STATE, not a per-round event.
//     Tracked via an in-memory `notedFlags` Set on the entry.
//
// ── SCOPE ──
// The ledger is per-match. We DO NOT aggregate across matches here —
// cross-match aggregation is intentionally out of scope so each match
// can be reviewed in isolation. EXPORTING the ledger over a live
// socket or DB write is a follow-up if/when the operator team wants
// a dedicated tool surface.
//
// ── STORAGE ──
// In-memory only, anchored on `globalThis` so hot reloads don't lose
// mid-match samples. Memory is bounded by
// `PRECISION_ANOMALY_LEDGER_MAX_PER_MATCH` per user per match to
// prevent pathological matches from leaking memory. Survives process
// restarts ONLY via the same persistence layer as `precisionMatchStore`
// (which it does NOT — and intentionally so, because the ledger is
// diagnostic-only).
//
// ── INVARIANTS ──
//   * Never mutates `precisionMatchStore` state.
//   * Never rejects stop packets — the existing MIN_STOP_MS / MAX_STOP_MS
//     guards in `recordRoundStop` remain the canonical gating point;
//     anomaly flagging is layered AFTER that gate.
//   * Never used by gameplay — UI never reads the ledger.

import {
  PRECISION_ANOMALY_LEDGER_MAX_PER_MATCH,
  PRECISION_HIGH_VARIANCE_CV,
  PRECISION_IMPOSSIBLE_REACTION_MS,
  PRECISION_LOW_VARIANCE_CV,
  PRECISION_VARIANCE_MIN_SAMPLES,
} from "./constants";

/** A single stop event bucketed for anomaly analysis. All four fields
 *  are server-stamped; the client never supplies any of them. */
export interface PrecisionAnomalySample {
  /** Monotonic round identifier — ties the sample to a specific round. */
  roundSequence: number;
  /** Server-measured `elapsedMs = stopInstant - roundGoInstant`. */
  elapsedMs: number;
  /** Server-measured `diffMs = |elapsedMs - targetMs|`. */
  diffMs: number;
  /** Epoch (ms) when the stop packet was received. */
  stopInstant: number;
}

/** A typed anomaly event — kind-tagged so downstream code can dedup
 *  on the discriminator rather than parsing free-form strings. */
export interface PrecisionAnomalyEvent {
  kind: NotedFlagKind;
  /** Human-readable message surfaced in operator logs and the per-match
   *  summary. Format is stable per `kind` so dedup is reliable. */
  message: string;
}

/** Tri-state flags plus a typed events array. The events array is the
 *  canonical audit surface — every flag lands a structured event with
 *  a discriminator `kind` and a stable `message`. Downstream code
 *  (dedup, summary) discriminates on `kind`, not on prefix-string
 *  matches of `message`. */
export interface PrecisionAnomalyFlags {
  impossible: boolean;
  lowVariance: boolean;
  highVariance: boolean;
  /** Structured events captured at the moment a flag fired. */
  events: PrecisionAnomalyEvent[];
}

/** Tag for log-dedup. Each value identifies a single flag-class so we
 *  can log per-event (impossible) vs per-match (variance) cleanly. */
type NotedFlagKind = "impossible" | "lowVariance" | "highVariance";

/** Per-user-per-match ledger entry — running sample list + last
 *  computed flag state + dedup tracker for variance flags.
 *
 *  INVARIANT: `flags` is recomputed on every new sample, so reading
 *  `ledger[userId].flags` after the record-call yields the latest
 *  snapshot. `notedFlags` is a permanent accumulator within a match
 *  that survives across multiple round decisions and is cleared only
 *  when the match ends. */
export interface PrecisionAnomalyLedgerEntry {
  samples: PrecisionAnomalySample[];
  flags: PrecisionAnomalyFlags;
  /** Set of variance flag-kinds already emitted to the operator log
   *  for the current match. Variance flags are per-match STATES, not
   *  per-round EVENTS, so each kind fires at most once per user per
   *  match. `impossible` is NOT in this set — it's logged on every
   *  occurrence. */
  notedFlags: Set<NotedFlagKind>;
}

/** Server-only ledger anchored on globalThis so hot reloads don't lose
 *  in-flight samples. Keyed by matchId then userId. */
const globalForAnomaly = globalThis as typeof globalThis & {
  __precisionAnomalyLedger?: Map<
    string,
    Map<string, PrecisionAnomalyLedgerEntry>
  >;
};
if (!globalForAnomaly.__precisionAnomalyLedger) {
  globalForAnomaly.__precisionAnomalyLedger = new Map();
}
const precisionAnomalyLedger = globalForAnomaly.__precisionAnomalyLedger;

/** Computes mean + sample standard deviation (Bessel's correction) for
 *  a list of reaction times. Returns null for empty / single-sample
 *  inputs — we never compute variance with fewer than `minSamples`
 *  entries.
 *
 *  SAMPLE STANDEV divides by (N-1) — not population stddev (N).
 *  Rationale: the per-match Precision window is tiny (3-5 samples)
 *  and we want maximum sensitivity for the anomaly signal. Sample
 *  stddev is the UNBIASED estimator and lifts CV slightly relative to
 *  population stddev on small N, making the high-variance flag
 *  reachable on legitimately inconsistent players without false
 *  negatives from under-estimated variance. Logging in the audit
 *  output uses `n=N-1` for the divisor to surface the math. */
function computeMeanStddev(
  values: number[],
): { mean: number; stddev: number; sampleCount: number } | null {
  if (values.length < PRECISION_VARIANCE_MIN_SAMPLES) return null;
  let sum = 0;
  for (const v of values) sum += v;
  const mean = sum / values.length;
  let sqDiffSum = 0;
  for (const v of values) {
    const diff = v - mean;
    sqDiffSum += diff * diff;
  }
  // Sample stddev (Bessel's correction). For N=1 there's no variance
  // to estimate — return mean-only with stddev=0 so downstream code
  // can still consume the shape.
  const divisor = values.length - 1;
  const stddev = divisor > 0 ? Math.sqrt(sqDiffSum / divisor) : 0;
  return { mean, stddev, sampleCount: values.length };
}

/** Pure function — returns flags for a sample list + a potential new
 *  sample. Does NOT mutate state. Centralising the rules here makes
 *  the threshold tunables testable in isolation. */
export function computeFlags(
  existingSamples: PrecisionAnomalySample[],
  newSample: PrecisionAnomalySample,
): PrecisionAnomalyFlags {
  const events: PrecisionAnomalyEvent[] = [];
  // Single-sample impossible-reaction check fires regardless of
  // variance-window eligibility. This is the only signal that can
  // trip from a single data point.
  if (newSample.elapsedMs > 0 &&
      newSample.elapsedMs < PRECISION_IMPOSSIBLE_REACTION_MS) {
    // elapsedMs may be 0 if the server clock danced; skip on that
    // pathological case to avoid noisy false positives.
    events.push({
      kind: "impossible",
      message: `impossible reaction: ${newSample.elapsedMs}ms (roundSeq ${newSample.roundSequence})`,
    });
  }
  const allSamples = existingSamples.concat([newSample]);
  const elapsedList = allSamples.map((s) => s.elapsedMs).filter((v) => v > 0);
  const stats = computeMeanStddev(elapsedList);
  if (stats && stats.mean > 0) {
    const cv = stats.stddev / stats.mean;
    if (cv < PRECISION_LOW_VARIANCE_CV) {
      events.push({
        kind: "lowVariance",
        message: `low variance: cv=${cv.toFixed(4)} mean=${stats.mean.toFixed(0)}ms stddev=${stats.stddev.toFixed(2)}ms n=${stats.sampleCount}`,
      });
    } else if (cv > PRECISION_HIGH_VARIANCE_CV) {
      events.push({
        kind: "highVariance",
        message: `high variance: cv=${cv.toFixed(4)} mean=${stats.mean.toFixed(0)}ms stddev=${stats.stddev.toFixed(2)}ms n=${stats.sampleCount}`,
      });
    }
  }
  const flags: PrecisionAnomalyFlags = {
    impossible: events.some((e) => e.kind === "impossible"),
    lowVariance: events.some((e) => e.kind === "lowVariance"),
    highVariance: events.some((e) => e.kind === "highVariance"),
    events,
  };
  return flags;
}

/** Build the initial empty-flags + empty-notedFlags shape for a fresh
 *  per-user ledger entry. Centralised so every constructor path uses
 *  the same defaults. */
function makeEmptyFlags(): PrecisionAnomalyFlags {
  return {
    impossible: false,
    lowVariance: false,
    highVariance: false,
    events: [],
  };
}

/** Record a sample into the ledger, recompute flags for the affected
 *  user, and emit a `console.warn` for each newly-fired event.
 *  Dedup policy:
 *    - `impossible`: log every occurrence (each is a distinct event).
 *    - variance flags: log once per match per user via `notedFlags`.
 *  Silent on no-flag samples so a normal player's traffic isn't
 *  log-spammed. */
export function recordAnomalySample(args: {
  matchId: string;
  userId: string;
  sample: PrecisionAnomalySample;
}): PrecisionAnomalyFlags {
  const { matchId, userId, sample } = args;
  if (!matchId || !userId) {
    return makeEmptyFlags();
  }
  const matchMap =
    precisionAnomalyLedger.get(matchId) ??
    new Map<string, PrecisionAnomalyLedgerEntry>();
  const existingEntry = matchMap.get(userId);
  const entry: PrecisionAnomalyLedgerEntry = existingEntry ?? {
    samples: [],
    flags: makeEmptyFlags(),
    notedFlags: new Set<NotedFlagKind>(),
  };
  // Defensive — if a prior in-memory entry was constructed without
  // `notedFlags` (older versions of this module), upgrade it.
  if (!entry.notedFlags) entry.notedFlags = new Set<NotedFlagKind>();

  // Enforce per-user-per-match cap so a pathological match with many
  // repeated arms cannot leak memory.
  if (entry.samples.length < PRECISION_ANOMALY_LEDGER_MAX_PER_MATCH) {
    entry.samples.push(sample);
    entry.flags = computeFlags(entry.samples.slice(0, -1), sample);
  } else {
    // Cap was hit — we still recompute flags (the dropped sample
    // contributes to the variance computation), but can't store it.
    // Note: we DON'T update notedFlags in this branch on the basis of
    // the dropped sample alone — the reconciliation in any subsequent
    // sample will surface it.
    entry.flags = computeFlags(entry.samples, sample);
  }
  matchMap.set(userId, entry);
  precisionAnomalyLedger.set(matchId, matchMap);

  // Diff events vs prior noted-flags to decide what gets logged now.
  // The discriminator is the typed `kind`, not a prefix-string match
  // on `message` — adding a new reason kind never silently falls
  // through to log-every-occurrence (which would re-introduce log
  // spam if a future kind is added without updating dedup logic).
  // IMMUTABILITY: we don't mutate the entry's flags.events; we read
  // them. The decision loop below only USES the events array.
  const eventsToLog: PrecisionAnomalyEvent[] = [];
  for (const ev of entry.flags.events) {
    if (ev.kind === "impossible") {
      // Per-event: log every occurrence. Each impossible reaction
      // carries its own `elapsedMs` + `roundSequence` so duplicates
      // here are pathological and worth a log line. (Defensive
      // exact-string dedup against the previous line is omitted —
      // computeFlags already includes roundSequence which differs per
      // round, so identical strings are practically impossible.)
      eventsToLog.push(ev);
      continue;
    }
    // Variance flag — per-match dedup so a fresh CV doesn't relog.
    if (entry.notedFlags.has(ev.kind)) continue;
    entry.notedFlags.add(ev.kind);
    eventsToLog.push(ev);
  }
  for (const ev of eventsToLog) {
    // Structured log line — operators can `grep "precision-anomaly"` to
    // find suspicious activity. The key=value format is grep-friendly
    // even when the JSON `console.log` is interleaved with HTTP traffic.
    // eslint-disable-next-line no-console
    console.warn(
      `[precision-anomaly] matchId=${matchId} userId=${userId} kind=${ev.kind} flag=${ev.message}`,
    );
  }
  return entry.flags;
}

/** Emit a per-match summary line if any user has at least one flag,
 *  then clear the match's ledger entry. Called on match-finish (and
 *  defensively from any future resign handler). Idempotent: a
 *  second call on an empty match is a no-op. */
export function flushLedgerForMatch(matchId: string): {
  flushed: boolean;
  flagCount: number;
} {
  const matchMap = precisionAnomalyLedger.get(matchId);
  if (!matchMap) return { flushed: false, flagCount: 0 };
  let flagCount = 0;
  const summary: Array<{
    userId: string;
    sampleCount: number;
    events: PrecisionAnomalyEvent[];
  }> = [];
  for (const [userId, entry] of matchMap) {
    if (
      entry.flags.impossible ||
      entry.flags.lowVariance ||
      entry.flags.highVariance
    ) {
      flagCount += 1;
      summary.push({
        userId,
        sampleCount: entry.samples.length,
        events: entry.flags.events.slice(),
      });
    }
  }
  if (flagCount > 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `[precision-anomaly] matchId=${matchId} flushed flaggedUsers=${flagCount} summary=${JSON.stringify(summary)}`,
    );
  }
  precisionAnomalyLedger.delete(matchId);
  return { flushed: flagCount > 0, flagCount };
}

/** Silent ledger clear — used when a match is torn down without going
 *  through the normal finish path (e.g. resign mid-arming). Does NOT
 *  emit a summary; pairs with `flushLedgerForMatch` if the operator
 *  wants a record even on aborts. EXPORTED for symmetry. */
export function clearAnomalyLedgerForMatch(matchId: string): void {
  precisionAnomalyLedger.delete(matchId);
}

/** Test-only helper — drops the entire ledger so unit tests can
 *  simulate multiple matches. Not used by production code paths. */
export function _resetAnomalyLedgerForTests(): void {
  precisionAnomalyLedger.clear();
}
