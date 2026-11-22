// src/lib/solitaire-puzzle/ai.ts
//
// PUZZLE vs AI — the practice opponent, built on the SIX EXISTING bots.
//
// There is no seventh identity, no puzzle-only difficulty ladder and no second
// bot roster here: a seat's `ai_difficulty` is one of
// `rookie|felix|ace|professor|grandmaster|perfect`, and every decision is made
// with that bot's own shipped profile from `../solitaire-duel/bots.ts` —
// including its `moveDelayMs`, which is the pacing the server uses to schedule
// the bot's moves.
//
// HOW THE BOT PLAYS
//   1. It races the SAME frozen puzzle as the human, from the SAME start state,
//      through the SAME `applySeatMove` engine, so it can never make an illegal
//      move or a move the objective verifier does not score.
//   2. It follows a VERIFIED solution path (the library replayed every accepted
//      line through `./rules.ts`). This is the brief's "use verified solution
//      paths as a reliable basis": it guarantees every bot can finish every
//      supported puzzle, and it is what makes practice predictable.
//   3. Different bots do NOT look identical: a stronger bot always takes the
//      shortest accepted line, while Rookie/Felix deterministically choose
//      among the accepted lines (so their runs can be longer), and each bot's
//      pacing comes from its existing profile.
//   4. FAIRNESS: choosing a line needs only the puzzle's public objective and
//      the library's server-side data; it never reads a face-down identity or
//      the stock order, and nothing here is ever serialized to a client. When
//      the board is off every line (only possible if a caller replays a
//      different line), the fallback is a fair heuristic that evaluates LEGAL
//      moves from visible information only — the same rule the duel AI uses.
//
// DETERMINISM: the choice is a pure function of (puzzle, bot, bot seat). There
// is no random source and no clock in the choice. The clock only decides HOW
// MANY moves are due; the same board always produces the same next move.
//
// SERVER-ONLY: imports the manifest/spec type and the solution lines. Never
// import this from a client component.

import { botRoll, legalMoves, scoreMove } from "../solitaire-duel/ai";
import { solitaireBotFor, type SolitaireBotId } from "../solitaire-duel/bots";
import { applyMove } from "../solitaire-duel/rules";
import {
  objectiveProgress,
  type PuzzleSessionStats,
} from "../solitaire-duel/puzzleSession";
import {
  objectiveReached,
  puzzleMoveSignature,
} from "../solitaire-duel/puzzleValidation";
import { puzzleLibraryPuzzles } from "../solitaire-duel/puzzleLibrary";
import type { SolitaireMove, SolitaireState } from "../solitaire-duel/types";
import {
  PUZZLE_SESSION_MODE,
  PUZZLE_SESSION_STATUS,
} from "./constants";
import { applySeatMove } from "./state";
import type {
  PuzzleManifestEntry,
  PuzzleSeatSnapshot,
  PuzzleSessionSnapshot,
} from "./types";

/** The most bot moves one read may apply, so a long absence cannot stall a read. */
export const PUZZLE_AI_MAX_MOVES_PER_READ = 6;

export type PuzzleAiDecision = {
  move: SolitaireMove;
  /** `line` = a verified solution path; `heuristic` = fair visible-info fallback. */
  source: "line" | "heuristic";
};

export type PuzzleAiMoveLog = {
  ply: number;
  puzzleIndex: number;
  kind: string;
  move: SolitaireMove;
  atMs: number;
};

export type PuzzleAiAdvance = {
  seat: PuzzleSeatSnapshot;
  moves: PuzzleAiMoveLog[];
  completed: boolean;
};

/** The bot's existing pacing, in ms between accepted moves. */
export function puzzleAiPaceMs(botId: unknown): number {
  return solitaireBotFor(botId).ai.moveDelayMs;
}

/** The six shipped bot ids, in roster order. */
export const PUZZLE_AI_BOT_IDS: readonly SolitaireBotId[] = Object.freeze(
  ["rookie", "felix", "ace", "professor", "grandmaster", "perfect"] as const,
);

// ── Visible-position identity ─────────────────────────────────────────────

function cardKey(card: { suit: string; rank: number }): string {
  return `${card.suit[0]}${card.rank}`;
}

/**
 * What a player can SEE, as a comparable string.
 *
 * Face-down slots are `?` (never their identity) and the stock is a COUNT (never
 * its order). Waste and foundations are public. Two boards with the same
 * signature are indistinguishable to a human, which is exactly the test the
 * line matcher and the fairness suite use.
 */
export function visiblePuzzleSignature(state: SolitaireState): string {
  const tableau = state.tableau
    .map((column) =>
      column
        .map((pile) => (pile.faceUp && pile.card ? cardKey(pile.card) : "?"))
        .join(","),
    )
    .join("/");
  const waste = state.waste.map(cardKey).join(",");
  const foundations = ["spades", "hearts", "diamonds", "clubs"]
    .map((suit) => state.foundations?.[suit as "spades"]?.length ?? 0)
    .join(",");
  return `${tableau}|${state.stock.length}|${waste}|${foundations}`;
}

function hashText(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

// ── Verified solution paths ───────────────────────────────────────────────

/**
 * The accepted lines, in the order THIS bot prefers them.
 *
 * Strong profiles take the shortest verified line first; the beginner profiles
 * deterministically pick among all accepted lines (a stable hash of bot + puzzle
 * id), so their runs can be longer without ever being unsolvable.
 */
/**
 * The verified lines for a manifest entry's library puzzle.
 *
 * Deliberately NOT stored on the session manifest: a session row carries only
 * the spec it needs to play (`types.ts` keeps the manifest free of solutions and
 * verification data). The library is the one server-side source, memoised here
 * so a decision is a map lookup.
 */
let solutionIndex: Map<string, SolitaireMove[][]> | null = null;

function solutionsFor(entry: PuzzleManifestEntry): SolitaireMove[][] {
  if (!solutionIndex) {
    solutionIndex = new Map(
      puzzleLibraryPuzzles().map((puzzle) => [
        puzzle.id,
        puzzle.spec.solutions.map((line) => [...line]),
      ]),
    );
  }
  return solutionIndex.get(entry.id) ?? [];
}

function orderedLines(
  entry: PuzzleManifestEntry,
  botId: SolitaireBotId,
): SolitaireMove[][] {
  const bot = solitaireBotFor(botId);
  // A puzzle with no library line is answered by the fair heuristic instead.
  const lines = solutionsFor(entry).map((line) => [...line]);
  lines.sort((a, b) => a.length - b.length);
  if (bot.order >= 3 || lines.length < 2) return lines;
  const pick = hashText(`${bot.id}:${entry.id}`) % lines.length;
  return [lines[pick], ...lines.filter((_, index) => index !== pick)];
}

type LineCandidate = {
  signature: string;
  index: number;
  move: SolitaireMove;
};

/**
 * Every (visible position → next verified move) pair the bot may follow.
 *
 * Built by replaying each accepted line from the puzzle's declared start. Only
 * visible information enters the signature, so the map is safe to compare
 * against the bot's own board.
 */
function lineCandidates(
  entry: PuzzleManifestEntry,
  botId: SolitaireBotId,
): LineCandidate[] {
  const out: LineCandidate[] = [];
  for (const line of orderedLines(entry, botId)) {
    let state = entry.spec.startState;
    for (let index = 0; index < line.length; index += 1) {
      out.push({ signature: visiblePuzzleSignature(state), index, move: line[index] });
      const applied = applyMove({ state, move: line[index] });
      if (!applied.ok) break;
      state = applied.state;
    }
  }
  return out;
}

/** The verified next move from this board, or null when no line applies. */
function lineMove({
  entry,
  seat,
  botId,
}: {
  entry: PuzzleManifestEntry;
  seat: PuzzleSeatSnapshot;
  botId: SolitaireBotId;
}): SolitaireMove | null {
  const signature = visiblePuzzleSignature(seat.state);
  const matches = lineCandidates(entry, botId).filter((candidate) => {
    if (candidate.signature !== signature) return false;
    return applyMove({ state: seat.state, move: candidate.move }).ok;
  });
  if (matches.length === 0) return null;

  // Prefer the position the bot's own per-puzzle move count points at, so a
  // repeated visible position cannot send it backwards.
  const played = Math.max(0, Number(seat.stats?.moves) || 0);
  matches.sort(
    (a, b) => Math.abs(a.index - played) - Math.abs(b.index - played),
  );
  return matches[0].move;
}

// ── Fair fallback heuristic ───────────────────────────────────────────────

function objectiveMove({
  entry,
  seat,
  botId,
}: {
  entry: PuzzleManifestEntry;
  seat: PuzzleSeatSnapshot;
  botId: SolitaireBotId;
}): SolitaireMove | null {
  const state = seat.state;
  const moves = legalMoves(state);
  if (moves.length === 0) return null;

  const objective = entry.spec.objective;
  const stats: PuzzleSessionStats = seat.stats;
  const hiddenCount = (applied: { revealed: readonly unknown[] }) =>
    stats.revealed + applied.revealed.length;

  const before = objectiveProgress(objective, state, {
    revealed: stats.revealed,
    signatures: stats.path.map(puzzleMoveSignature),
  });

  const scored: Array<{ move: SolitaireMove; score: number; reached: boolean }> = [];
  for (const move of moves) {
    const applied = applyMove({ state, move });
    // `applyMove` is the game's own validator. A refused move never enters the
    // pool, so the heuristic cannot invent an illegal answer.
    if (!applied.ok) continue;
    const revealed = hiddenCount(applied);
    const signatures = [...stats.path.map(puzzleMoveSignature), puzzleMoveSignature(move)];
    const progress = objectiveProgress(objective, applied.state, { revealed, signatures });
    const reached = objectiveReached(objective, applied.state, { revealed, signatures });
    const gained = progress.measurable ? progress.current - before.current : 0;
    scored.push({
      move,
      // Completing dominates; measurable progress next; visible structure last.
      score:
        (reached ? 1_000_000_000 : 0) +
        gained * 1_000_000 +
        progress.current * 1_000 +
        scoreMove(state, move),
      reached,
    });
  }
  if (scored.length === 0) return null;
  scored.sort((a, b) => b.score - a.score);

  const bot = solitaireBotFor(botId);
  const roll = botRoll(seat.ply * 11 + bot.order);
  const failureBudget = bot.ai.blunderRate + bot.ai.mistakeRate;
  if (bot.order <= 4 && roll < failureBudget) {
    // A beginner's believable slip is a legal move that makes no objective
    // progress — never an illegal one, and never when it would throw away a
    // completion.
    const slip = scored.find((option) => !option.reached && option.score < 1_000_000);
    if (slip) return slip.move;
  }
  return scored[0].move;
}

// ── Decision ──────────────────────────────────────────────────────────────

/**
 * The bot's next move for one puzzle position.
 *
 * A verified line is followed whenever the current board is ON it (the normal
 * case). The fair heuristic answers only boards that are off every line, so a
 * caller that replays a different line still gets a legal, objective-directed
 * move instead of a dead bot.
 */
export function choosePuzzleAiMove({
  entry,
  seat,
  botId,
}: {
  entry: PuzzleManifestEntry;
  seat: PuzzleSeatSnapshot;
  botId: unknown;
}): PuzzleAiDecision | null {
  const bot = solitaireBotFor(botId);
  const line = lineMove({ entry, seat, botId: bot.id });
  if (line) return { move: line, source: "line" };

  const heuristic = objectiveMove({ entry, seat, botId: bot.id });
  return heuristic ? { move: heuristic, source: "heuristic" } : null;
}

// ── Server pacing ─────────────────────────────────────────────────────────

/**
 * Advance the bot seat as far as the server clock allows, purely.
 *
 * The bot's board is its OWN copy of the frozen puzzle. Each due move is applied
 * with `applySeatMove` — the same transition the human's moves use — and stamped
 * with the server instant it became due, so a reload cannot rewind or double-apply
 * bot progress. Returns null when nothing is due.
 */
export function planPuzzleAiSeat({
  snapshot,
  nowMs,
  maxMoves = PUZZLE_AI_MAX_MOVES_PER_READ,
}: {
  snapshot: PuzzleSessionSnapshot;
  nowMs: number;
  maxMoves?: number;
}): PuzzleAiAdvance | null {
  if (snapshot.mode !== PUZZLE_SESSION_MODE.AI) return null;
  if (snapshot.status !== PUZZLE_SESSION_STATUS.PLAYING) return null;
  if (!snapshot.aiDifficulty) return null;

  const bot = solitaireBotFor(snapshot.aiDifficulty);
  const delay = Math.max(1, bot.ai.moveDelayMs);
  const base =
    snapshot.p2.lastActionAtMs ?? snapshot.goAtMs ?? snapshot.createdAtMs;
  const due = Math.min(
    Math.max(1, Math.floor(maxMoves)),
    Math.max(0, Math.floor((nowMs - base) / delay)),
  );
  if (due <= 0) return null;

  let seat = snapshot.p2;
  const moves: PuzzleAiMoveLog[] = [];
  let completed = false;

  for (let step = 0; step < due; step += 1) {
    const entry = snapshot.manifest[seat.puzzleIndex];
    if (!entry) break;

    const decision = choosePuzzleAiMove({ entry, seat, botId: bot.id });
    if (!decision) break;

    const at = base + (step + 1) * delay;
    const applied = applySeatMove({
      manifest: snapshot.manifest,
      seat,
      move: decision.move,
      nowMs: at,
    });
    if (applied.status === "illegal") break;

    moves.push({
      ply: seat.ply,
      puzzleIndex: seat.puzzleIndex,
      kind: decision.move.kind,
      move: decision.move,
      atMs: at,
    });
    seat = applied.seat;
    if (applied.completedSession) {
      completed = true;
      break;
    }
  }

  if (moves.length === 0) return null;
  return { seat, moves, completed };
}
