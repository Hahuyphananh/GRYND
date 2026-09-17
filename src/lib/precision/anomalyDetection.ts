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
//     Remembered per user via the entry's `noted` list.
//
// ── SCOPE ──
// The ledger is per-match. We DO NOT aggregate across matches here —
// cross-match aggregation is intentionally out of scope so each match
// can be reviewed in isolation; the per-match summary line at completion
// is the operator's tool surface.
//
// ── STORAGE ──
// Persisted on the match row (`precision_matches.anomaly_ledger`) as plain
// JSON. It used to be a `globalThis` Map beside the in-memory match store,
// which stopped working the moment matches moved into Postgres: each request
// can land on any instance, so a sample folded on one instance was invisible
// to the round decided on another. Entries are bounded by
// `PRECISION_ANOMALY_LEDGER_MAX_PER_MATCH` per user per match, and the whole
// ledger dies with the row.
//
// ── INVARIANTS ──
//   * Never mutates match state — the store only ever folds samples into the
//     `anomaly_ledger` column.
//   * Never rejects stop packets — the MIN_STOP_MS / MAX_STOP_MS guards in
//     `recordRoundStop` remain the canonical gating point; anomaly flagging
//     is layered AFTER that gate.
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

// ── Persisted ledger (serverless-safe) ───────────────────────────────────
//
// The Match store used to be a `globalThis` Map, so the ledger above could
// live beside it in memory. Matches are now rows in Postgres and each request
// can land on any instance, so the ledger is persisted on the match row
// (`precision_matches.anomaly_ledger`) and the two helpers below operate on
// that plain-JSON snapshot instead of a process-local Map.
//
// Same policy as `recordAnomalySample`, just made explicit and pure: fold the
// sample in, return the events that should be logged NOW, let the caller log
// them with the shared formatter and write the entry back.

export interface PrecisionAnomalyPersistedEntry {
  samples: PrecisionAnomalySample[];
  /** Variance flag kinds already logged for this user in this match. */
  noted: NotedFlagKind[];
}

/** Per-match persisted ledger, keyed by userId. Plain JSON — this is exactly
 *  the shape stored in `precision_matches.anomaly_ledger`. */
export type PrecisionAnomalyPersistedLedger = Record<
  string,
  PrecisionAnomalyPersistedEntry
>;

/** Normalise whatever the jsonb column returned into a usable ledger. A
 *  malformed/legacy value degrades to "no history" rather than throwing
 *  inside a gameplay transaction. */
export function readPersistedLedger(
  raw: unknown,
): PrecisionAnomalyPersistedLedger {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const ledger: PrecisionAnomalyPersistedLedger = {};
  for (const [userId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!userId || !value || typeof value !== "object") continue;
    const entry = value as Partial<PrecisionAnomalyPersistedEntry>;
    ledger[userId] = {
      samples: Array.isArray(entry.samples) ? entry.samples : [],
      noted: Array.isArray(entry.noted) ? (entry.noted as NotedFlagKind[]) : [],
    };
  }
  return ledger;
}

/**
 * Fold one server-stamped sample into a persisted ledger entry.
 *
 * PURE — no logging, no mutation of `ledger`. Returns the entry to write
 * back plus the events to log now, applying the same dedup policy as
 * `recordAnomalySample`:
 *   * `impossible` logs on every occurrence (each is a distinct event),
 *   * variance flags log once per match per user (they describe a state).
 */
export function foldPersistedSample(args: {
  ledger: PrecisionAnomalyPersistedLedger;
  userId: string;
  sample: PrecisionAnomalySample;
}): {
  ledger: PrecisionAnomalyPersistedLedger;
  events: PrecisionAnomalyEvent[];
} {
  const { ledger, userId, sample } = args;
  if (!userId) return { ledger, events: [] };
  const prior = ledger[userId] ?? { samples: [], noted: [] };
  // Bounded per user per match, exactly like the in-memory ledger: past the
  // cap the sample still contributes to the variance maths but is not stored.
  const capped = prior.samples.length >= PRECISION_ANOMALY_LEDGER_MAX_PER_MATCH;
  const flags = computeFlags(prior.samples, sample);
  const samples = capped ? prior.samples : prior.samples.concat([sample]);
  const noted = new Set<NotedFlagKind>(prior.noted);

  const events: PrecisionAnomalyEvent[] = [];
  for (const ev of flags.events) {
    if (ev.kind === "impossible") {
      events.push(ev);
      continue;
    }
    if (noted.has(ev.kind)) continue;
    noted.add(ev.kind);
    events.push(ev);
  }

  return {
    ledger: {
      ...ledger,
      [userId]: { samples, noted: Array.from(noted) },
    },
    events,
  };
}

/** Emit the shared, grep-friendly audit lines. Keyed by `kind` so a flagged
 *  user is a stable `grep "precision-anomaly"` target for operators. */
export function logAnomalyEvents(args: {
  matchId: string;
  userId: string;
  events: PrecisionAnomalyEvent[];
}): void {
  const { matchId, userId, events } = args;
  for (const ev of events) {
    // eslint-disable-next-line no-console
    console.warn(
      `[precision-anomaly] matchId=${matchId} userId=${userId} kind=${ev.kind} flag=${ev.message}`,
    );
  }
}

/** Per-match summary line for the operator log, emitted when a match ends.
 *  Silent when nobody was flagged. */
export function summarizePersistedLedger(
  matchId: string,
  ledger: PrecisionAnomalyPersistedLedger,
): { flagCount: number } {
  const summary: Array<{
    userId: string;
    sampleCount: number;
    events: PrecisionAnomalyEvent[];
  }> = [];
  for (const [userId, entry] of Object.entries(ledger)) {
    const flags = entry.samples.length
      ? computeFlags(entry.samples.slice(0, -1), entry.samples[entry.samples.length - 1])
      : null;
    if (!flags) continue;
    if (flags.impossible || flags.lowVariance || flags.highVariance) {
      summary.push({
        userId,
        sampleCount: entry.samples.length,
        events: flags.events,
      });
    }
  }
  if (summary.length > 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `[precision-anomaly] matchId=${matchId} flushed flaggedUsers=${summary.length} summary=${JSON.stringify(summary)}`,
    );
  }
  return { flagCount: summary.length };
}
