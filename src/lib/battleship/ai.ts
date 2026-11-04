// src/lib/battleship/ai.ts
//
// The Battleship practice bot. PURE, and deterministic under an injected random
// source, exactly like every other GRYND AI (see src/lib/barricade/ai.ts and
// src/lib/tic-tac-toe/ai.ts).
//
// ── THE ONE HARD REQUIREMENT ──────────────────────────────────────────────
//
// The bot may ONLY look at what a player sitting in its seat could see: its own
// resolved attacks (coordinate, hit/miss/sunk, and which ship it sank when it
// did). It is never handed the human's fleet — the signature has no fleet
// parameter, and this module imports nothing that could reach one. That is what
// makes "the AI cannot cheat" a property of the code rather than a promise.
//
// Simultaneous combat is preserved elsewhere: the STORE commits the bot's
// coordinate for the NEXT round as soon as the previous round resolves (and at
// combat start), so the choice exists before the human's coordinate for that
// round does. This module never sees a human submission either.
//
// ── THE TIERS (shared scale, no private difficulty system) ────────────────
//
//   EASY   — uniform random over untried cells. No hunting at all, so a
//            beginner can beat it.
//   NORMAL — hunt-and-target: adjacent cells around an unresolved hit, and a
//            checkerboard sweep when there is no target. It abandons a ship the
//            moment it is confirmed sunk, and it slips at the shared
//            `normal` mistake rate, so it is not a solver.
//   HARD   — probability density: every placement of every REMAINING ship length
//            is laid over the board; placements over known misses are discarded,
//            placements covering an unresolved hit are weighted, and the densest
//            untried cell wins (with the shared `hard` slip, so it stays
//            beatable). The enumeration is capped by AI_MAX_DENSITY_EVALS, so a
//            turn is a few milliseconds and the game can never freeze.

import {
  AI_SKILL,
  chooseAiOption,
  coerceAiDifficulty,
  type AiDifficulty,
} from "../aiDifficulty";
import { BOARD_COLUMNS, BOARD_ROWS, COLUMNS, SHIP_KEYS, SHIP_LENGTHS } from "./constants";
import { parseCoordinate } from "./rules";
import {
  allCoordinates,
  serverRandomInt,
  untriedCoordinates,
  type RandomInt,
} from "./timeouts";
import type { AttackRecord, ShipKey } from "./types";

/**
 * Hard tier's ceiling on placement checks per turn. The whole board enumeration
 * for six ships is well under this; the cap is a hard stop, not a target.
 */
export const AI_MAX_DENSITY_EVALS = 6000;

interface Cell {
  readonly x: number;
  readonly y: number;
}

function parseCell(label: string): Cell | null {
  // The rules engine owns the printed form, so the bot reads exactly the cells
  // the board exposes — including after the board's width changed.
  const coordinate = parseCoordinate(String(label));
  return coordinate ? { x: coordinate.x, y: coordinate.y } : null;
}

function cellLabel(x: number, y: number): string {
  return `${COLUMNS[x]}${y + 1}`;
}

/** The four orthogonal neighbours that exist on the board. */
function neighbours(label: string): string[] {
  const cell = parseCell(label);
  if (!cell) return [];
  const out: string[] = [];
  const steps = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  for (const [dx, dy] of steps) {
    const x = cell.x + dx;
    const y = cell.y + dy;
    if (x >= 0 && x < BOARD_COLUMNS && y >= 0 && y < BOARD_ROWS) out.push(cellLabel(x, y));
  }
  return out;
}

function pick(candidates: readonly string[], randomInt: RandomInt): string | null {
  if (candidates.length === 0) return null;
  const raw = randomInt(candidates.length);
  const index = Number.isInteger(raw) && raw >= 0 && raw < candidates.length ? raw : 0;
  return candidates[index];
}

/** Cells on the black squares — the classic no-wasted-shot sweep. */
function checkerboard(candidates: readonly string[]): string[] {
  return candidates.filter((cell) => {
    const parsed = parseCell(cell);
    return parsed ? (parsed.x + parsed.y) % 2 === 0 : false;
  });
}

export interface ChooseAiAttackInput {
  /** Canonical tier; anything else coerces to the shared default. */
  difficulty?: unknown;
  /** The bot's OWN resolved shots — never the human's fleet. */
  attacks: readonly AttackRecord[];
  /** Injectable uniform source (defaults to node:crypto on the server). */
  randomInt?: RandomInt;
  /** Injectable 0–1 source for the shared slip model. */
  random?: () => number;
}

export interface DensityEntry {
  readonly cell: string;
  readonly weight: number;
}

/**
 * The probability-density map over every UNTRIED cell.
 *
 * `misses` are excluded from every ship placement; placements that cover an
 * unresolved hit are weighted up, which is what makes the bot finish the ship it
 * has already found instead of wandering. Sunk ships are removed from the
 * remaining lengths, so it never re-hunts a wreck.
 */
function densityMap({
  remaining,
  misses,
  hits,
  untried,
}: {
  remaining: readonly ShipKey[];
  misses: ReadonlySet<string>;
  hits: ReadonlySet<string>;
  untried: ReadonlySet<string>;
}): DensityEntry[] {
  const weights = new Map<string, number>();
  let evaluations = 0;

  for (const ship of remaining) {
    const length = SHIP_LENGTHS[ship];
    for (const orientation of ["horizontal", "vertical"] as const) {
      const maxX = orientation === "horizontal" ? BOARD_COLUMNS - length : BOARD_COLUMNS - 1;
      const maxY = orientation === "horizontal" ? BOARD_ROWS - 1 : BOARD_ROWS - length;
      for (let y = 0; y <= maxY; y += 1) {
        for (let x = 0; x <= maxX; x += 1) {
          evaluations += 1;
          if (evaluations > AI_MAX_DENSITY_EVALS) break;

          const cells: string[] = [];
          for (let index = 0; index < length; index += 1) {
            cells.push(
              orientation === "horizontal" ? cellLabel(x + index, y) : cellLabel(x, y + index),
            );
          }
          if (cells.some((cell) => misses.has(cell))) continue;

          // A placement that covers an unresolved hit is far more plausible: the
          // hit has to belong to SOME remaining ship.
          const coversHit = cells.some((cell) => hits.has(cell));
          const weight = coversHit ? 6 : 1;
          for (const cell of cells) {
            if (!untried.has(cell)) continue;
            weights.set(cell, (weights.get(cell) ?? 0) + weight);
          }
        }
        if (evaluations > AI_MAX_DENSITY_EVALS) break;
      }
      if (evaluations > AI_MAX_DENSITY_EVALS) break;
    }
    if (evaluations > AI_MAX_DENSITY_EVALS) break;
  }

  return [...weights.entries()]
    .map(([cell, weight]) => ({ cell, weight }))
    .sort((a, b) => b.weight - a.weight || a.cell.localeCompare(b.cell));
}

/**
 * The bot's next coordinate for a round, or null when the board is exhausted.
 *
 * Deterministic for a given (difficulty, attacks, random sources) triple, which
 * is what lets a test replay a whole match and lets a bug report be reproduced.
 */
export function chooseAiAttack({
  difficulty,
  attacks,
  randomInt = serverRandomInt,
  random = Math.random,
}: ChooseAiAttackInput): string | null {
  const tier: AiDifficulty = coerceAiDifficulty(difficulty);
  const fired = new Set((attacks ?? []).map((attack) => String(attack.coordinate).toUpperCase()));
  const untried = untriedCoordinates([...fired]);
  if (untried.length === 0) return null;
  const untriedSet = new Set(untried);

  // EASY — a uniformly random legal shot, with no hunting whatsoever.
  if (tier === "easy") return pick(untried, randomInt);

  const misses = new Set(
    (attacks ?? [])
      .filter((attack) => attack.result === "miss")
      .map((attack) => String(attack.coordinate).toUpperCase()),
  );
  // A hit whose ship is NOT named is still afloat — that is the target.
  const unresolvedHits = new Set(
    (attacks ?? [])
      .filter((attack) => attack.result !== "miss" && !attack.ship)
      .map((attack) => String(attack.coordinate).toUpperCase()),
  );
  const sunkShips = new Set(
    (attacks ?? [])
      .filter((attack) => attack.result === "sunk" && attack.ship)
      .map((attack) => String(attack.ship)),
  );

  if (tier === "normal") {
    const targets = new Set<string>();
    for (const hit of unresolvedHits) {
      for (const neighbour of neighbours(hit)) {
        if (untriedSet.has(neighbour)) targets.add(neighbour);
      }
    }
    const preferred = targets.size > 0 ? [...targets].sort() : checkerboard(untried);
    const pool = preferred.length > 0 ? preferred : untried;

    // The shared slip keeps `normal` beatable: sometimes it takes a random shot
    // instead of the one it found.
    if (random() < AI_SKILL.normal.mistakeRate) return pick(untried, randomInt);
    return pick(pool, randomInt);
  }

  // HARD — probability density over the remaining fleet.
  const remaining = SHIP_KEYS.filter((ship) => !sunkShips.has(ship));
  const density = densityMap({ remaining, misses, hits: unresolvedHits, untried: untriedSet });
  if (density.length === 0) return pick(untried, randomInt);

  // The shared tier policy ranks by density and applies the `hard` slip, so the
  // strongest tier is still fallible — it is never a perfect solver.
  const chosen = chooseAiOption(tier, density, (entry) => entry.weight, random, 0);
  return chosen ? chosen.cell : pick(untried, randomInt);
}

/** The board, exposed for tests that assert every shot is an address. */
export function boardCoordinates(): string[] {
  return allCoordinates();
}
