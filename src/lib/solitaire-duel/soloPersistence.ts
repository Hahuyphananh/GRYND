// src/lib/solitaire-duel/soloPersistence.ts
//
// CANONICAL MOVE HISTORY for Solo Solitaire and the Daily Challenge.
//
// The routes already prove a submitted log is legal by replaying it through the
// real engine. What they store must be the NORMALISED log, not the client's raw
// JSON: `normalizeMove` is the engine's own canonicaliser (it rebuilds the move
// with exactly the fields the rules use), so a stored log cannot carry extra
// client keys or type coercions that a later reader would have to re-validate.
//
// The digest is the idempotency key for solo submissions. It covers the ordered
// canonical log, so the same game retried twice maps to one row, while a
// different attempt (different moves) maps to a different row. The deal seed is
// part of the unique index, not the digest, so the digest itself stays a pure
// function of the log (tests rely on that).
//
// SERVER-SAFE ONLY: `node:crypto` is imported here, so this module must never be
// pulled into a client component. The client keeps its logs in localStorage and
// never needs a digest.

import { createHash } from "node:crypto";

import { normalizeMove } from "./rules";
import type { SolitaireMove } from "./types";

/** The stored shape: exactly `{kind, move}` for every accepted ply, in order. */
export type CanonicalMoveLogEntry = {
  kind: SolitaireMove["kind"];
  move: SolitaireMove;
};

export type CanonicalMoveLogResult =
  | { ok: true; log: CanonicalMoveLogEntry[] }
  | { ok: false; rejectedAt: number };

/**
 * Canonicalise an ALREADY-REPLAYED log.
 *
 * The caller must have verified the log with `replayMoves` first; this pass only
 * normalises. It still refuses malformed entries and a `kind` that disagrees
 * with the move's own kind, so a route can never persist a shape the engine
 * would read differently on a later replay.
 */
export function canonicalMoveLog(moves: unknown): CanonicalMoveLogResult {
  if (!Array.isArray(moves)) return { ok: false, rejectedAt: 0 };

  const log: CanonicalMoveLogEntry[] = [];
  for (let index = 0; index < moves.length; index += 1) {
    const entry = moves[index] as { kind?: unknown; move?: unknown } | null;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return { ok: false, rejectedAt: index };
    }
    const normalized = normalizeMove(entry.move);
    if (!normalized.ok || normalized.move.kind !== entry.kind) {
      return { ok: false, rejectedAt: index };
    }
    log.push({ kind: normalized.move.kind, move: normalized.move });
  }
  return { ok: true, log };
}

/**
 * SHA-256 over the ordered canonical log.
 *
 * NUL/FS separators keep the encoding unambiguous: `kind` and `move` can never
 * run together, and one entry can never be confused with two. JSON key order is
 * deterministic because every move object comes from `normalizeMove`.
 */
export function moveLogDigest(log: readonly CanonicalMoveLogEntry[]): string {
  const hash = createHash("sha256");
  for (const entry of log) {
    hash.update(entry.kind);
    hash.update("\u0000");
    hash.update(JSON.stringify(entry.move));
    hash.update("\u0001");
  }
  return hash.digest("hex");
}
