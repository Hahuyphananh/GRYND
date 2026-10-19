// src/lib/practicePause.ts
//
// FREE-PLAY PAUSE — the server side.
//
// A human-vs-AI match can be frozen while the human steps away. Pausing is a
// deliberate, participant-only action; resuming shifts the match's own clock
// forward by the paused window so the pause never costs a turn and the bot can
// never bank progress while nobody is watching.
//
// WHY A SHARED TABLE
// ------------------
// Every game stores its clock differently (`go_at`, `round_deadline`,
// `match_deadline`, `paused` blobs), so a per-game column would be 19
// migrations. One `practice_pauses` row keyed by (game, matchId) gives every
// match page the same toggle, and the game-specific resume work stays here
// instead of leaking into every store.
//
// SAFETY
// ------
// * `game` is a server-side key. A client can never name a table.
// * Pause is allowed only when the row is a live AI match and the caller holds
//   a seat. A paid PvP match is refused before any write.
// * Pause/resume take an advisory lock per (game, matchId), so two tabs cannot
//   both "resume" and shift the clock twice.
//
// The client hook is `src/hooks/usePracticePause.ts`; the route is
// `src/app/api/practice/pause/route.ts`.

import { sql, type SQL } from "drizzle-orm";
import { db } from "../db";
import {
  PRACTICE_PAUSE_GAMES,
  isPracticePauseGame,
  type PracticePauseGame,
} from "./practicePauseKeys";

export { PRACTICE_PAUSE_GAMES, isPracticePauseGame };
export type { PracticePauseGame };

type ShiftFn = (
  tx: any,
  row: Record<string, any>,
  matchId: string,
  deltaMs: number,
) => Promise<void>;

type GameConfig = {
  table: string;
  idColumn: string;
  /** The caller holds one of these seats. */
  participant: (userId: string) => SQL;
  /** The row is a human-vs-AI match. */
  ai: SQL;
  /** The match can still be paused (not a terminal/lobby row). */
  active: SQL;
  /** Shift every absolute instant forward by `deltaMs` on resume. */
  shift: ShiftFn;
};

// ── SQL building blocks ──────────────────────────────────────────────────

const col = (name: string) => sql.identifier(name);

function standardPlayer(userId: string, player1 = "player1_id", player2 = "player2_id"): SQL {
  return sql`(${col(player1)} = ${userId} or ${col(player2)} = ${userId})`;
}

const notTerminal = sql`status not in ('waiting', 'finished', 'cancelled', 'completed')`;

/** A batch of nullable timestamp columns that all move forward together. */
function shiftTimestamps(
  tx: any,
  table: string,
  idColumn: string,
  matchId: string,
  deltaMs: number,
  columns: string[],
) {
  const interval = sql`(${deltaMs}::bigint * interval '1 millisecond')`;
  return Promise.all(
    columns.map((column) =>
      tx.execute(sql`
        update ${sql.identifier(table)}
        set ${col(column)} = ${col(column)} + ${interval}
        where ${col(idColumn)} = ${matchId}
          and ${col(column)} is not null
      `),
    ),
  );
}

/** Add `deltaMs` to every epoch-ms field in a JSON state blob. */
function shiftJsonInstants(value: unknown, deltaMs: number, keys: RegExp): unknown {
  if (Array.isArray(value)) return value.map((item) => shiftJsonInstants(item, deltaMs, keys));
  if (!value || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  const next: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(source)) {
    if (keys.test(key) && typeof entry === "number" && Number.isFinite(entry)) {
      next[key] = entry + deltaMs;
    } else {
      next[key] = shiftJsonInstants(entry, deltaMs, keys);
    }
  }
  return next;
}

const JSON_INSTANT_KEYS = /(AtMs|Instant|Deadline|At)$/;

async function shiftJsonState(
  tx: any,
  table: string,
  idColumn: string,
  matchId: string,
  column: string,
  value: unknown,
  deltaMs: number,
  keys: RegExp = JSON_INSTANT_KEYS,
) {
  if (value == null) return;
  const next = shiftJsonInstants(value, deltaMs, keys);
  await tx.execute(sql`
    update ${sql.identifier(table)}
    set ${col(column)} = ${JSON.stringify(next)}::jsonb
    where ${col(idColumn)} = ${matchId}
  `);
}

// ── Per-game resume behaviour ────────────────────────────────────────────
//
// A turn-based game with no server clock needs no shift: the client simply
// stops reading and the bot has nothing to catch up on. The games below all
// run a clock the server advances on read, so their absolute instants must
// move forward by exactly the pause window.

const shiftChess: ShiftFn = async (tx, _row, matchId, deltaMs) => {
  await shiftTimestamps(tx, "chess_games", "id", matchId, deltaMs, ["started_at"]);
  await shiftTimestamps(tx, "chess_moves", "game_id", matchId, deltaMs, ["created_at"]);
};

const shiftDiceFlush: ShiftFn = async (tx, row, matchId, deltaMs) => {
  // Practice is untimed (`turnDeadline: null`); a legacy timed row still gets
  // its deadline moved so a resume cannot auto-bank immediately.
  const state = row?.game_state;
  if (!state || typeof state !== "object") return;
  const deadline = (state as Record<string, unknown>).turnDeadline;
  if (typeof deadline !== "string") return;
  const at = Date.parse(deadline);
  if (!Number.isFinite(at)) return;
  const next = { ...(state as Record<string, unknown>), turnDeadline: new Date(at + deltaMs).toISOString() };
  await tx.execute(sql`
    update dice_flush_rooms set game_state = ${JSON.stringify(next)}::jsonb where id = ${matchId}
  `);
};

const shiftKeno: ShiftFn = async (tx, _row, matchId, deltaMs) => {
  await shiftTimestamps(tx, "keno_pvp_matches", "id", matchId, deltaMs, [
    "live_started_at",
    "round_deadline",
    "started_at",
  ]);
};

const shiftLaneRush: ShiftFn = async (tx, _row, matchId, deltaMs) => {
  await shiftTimestamps(tx, "lane_rush_duel_matches", "id", matchId, deltaMs, [
    "round_deadline",
    "started_at",
  ]);
};

const shiftMemoryGrid: ShiftFn = async (tx, _row, matchId, deltaMs) => {
  await shiftTimestamps(tx, "memory_grid_matches", "id", matchId, deltaMs, [
    "round_deadline",
    "started_at",
  ]);
};

const shiftMines: ShiftFn = async (tx, _row, matchId, deltaMs) => {
  await shiftTimestamps(tx, "mines_pvp_matches", "id", matchId, deltaMs, [
    "match_deadline",
    "round_deadline",
    "started_at",
    "p1_completed_at",
    "p2_completed_at",
  ]);
};

const shiftPrecision: ShiftFn = async (tx, row, matchId, deltaMs) => {
  const state = row?.state;
  if (state && typeof state === "object") {
    const next = shiftJsonInstants(state, deltaMs, JSON_INSTANT_KEYS) as Record<string, unknown>;
    await tx.execute(sql`
      update precision_matches
      set state = ${JSON.stringify(next)}::jsonb,
          ai_stop_at = case
            when ai_stop_at is null then null
            else ai_stop_at + (${deltaMs}::bigint * interval '1 millisecond')
          end
      where id = ${matchId}
    `);
  } else {
    await shiftTimestamps(tx, "precision_matches", "id", matchId, deltaMs, ["ai_stop_at"]);
  }
  // The scheduler reads this column; moving it keeps a paused match from being
  // reclaimed as abandoned while it is still paused.
  await shiftTimestamps(tx, "precision_matches", "id", matchId, deltaMs, ["touched_at", "ended_at"]);
};

const shiftSolitaire: ShiftFn = async (tx, row, matchId, deltaMs) => {
  await shiftTimestamps(tx, "solitaire_duel_matches", "id", matchId, deltaMs, [
    "go_at",
    "started_at",
    "p1_last_action_at",
    "p2_last_action_at",
    "p1_finished_at",
    "p2_finished_at",
    "ended_at",
  ]);
  await shiftJsonState(tx, "solitaire_duel_matches", "id", matchId, "p1_state", row?.p1_state, deltaMs);
  await shiftJsonState(tx, "solitaire_duel_matches", "id", matchId, "p2_state", row?.p2_state, deltaMs);
};

const shiftSpeedTyping: ShiftFn = async (tx, _row, matchId, deltaMs) => {
  // `goAt` is the race's origin: every bot move and both clocks are derived
  // from it, so moving it forward by the pause window is the whole freeze.
  await shiftTimestamps(tx, "speed_typing_matches", "id", matchId, deltaMs, [
    "go_at",
    "started_at",
  ]);
  await shiftTimestamps(tx, "speed_typing_matches", "id", matchId, deltaMs, ["updated_at", "ended_at"]);
};

const shiftSudoku: ShiftFn = async (tx, row, matchId, deltaMs) => {
  await shiftTimestamps(tx, "sudoku_duel_matches", "id", matchId, deltaMs, [
    "go_at",
    "started_at",
    "p1_last_action_at",
    "p2_last_action_at",
    "p1_finished_at",
    "p2_finished_at",
    "ended_at",
  ]);
  await shiftJsonState(tx, "sudoku_duel_matches", "id", matchId, "p1_state", row?.p1_state, deltaMs);
  await shiftJsonState(tx, "sudoku_duel_matches", "id", matchId, "p2_state", row?.p2_state, deltaMs);
};

const noShift: ShiftFn = async () => {};

const GAMES: Record<PracticePauseGame, GameConfig> = {
  chess: {
    table: "chess_games",
    idColumn: "id",
    participant: (userId) => standardPlayer(userId, "player_white_id", "player_black_id"),
    ai: sql`is_ai_game = true`,
    active: sql`status = 'in_progress'`,
    shift: shiftChess,
  },
  "dice-flush": {
    table: "dice_flush_rooms",
    idColumn: "id",
    participant: (userId) => sql`game_state->'players' @> ${JSON.stringify([{ userId }])}::jsonb`,
    ai: sql`game_state->'players' @> '[{"isAI":true}]'::jsonb`,
    active: sql`status = 'playing'`,
    shift: shiftDiceFlush,
  },
  "dots-and-boxes": {
    table: "dots_and_boxes_games",
    idColumn: "id",
    participant: (userId) => standardPlayer(userId, "host_clerk_id", "guest_clerk_id"),
    ai: sql`is_ai_game = true`,
    active: notTerminal,
    shift: noShift,
  },
  "hex-duel": {
    table: "hex_duel_games",
    idColumn: "id",
    participant: (userId) => standardPlayer(userId),
    ai: sql`is_ai_game = true`,
    active: notTerminal,
    shift: noShift,
  },
  "keno-pvp": {
    table: "keno_pvp_matches",
    idColumn: "id",
    participant: (userId) => standardPlayer(userId),
    ai: sql`is_ai = true`,
    active: notTerminal,
    shift: shiftKeno,
  },
  "lane-rush-duel": {
    table: "lane_rush_duel_matches",
    idColumn: "id",
    participant: (userId) => standardPlayer(userId),
    ai: sql`player2_id = 'AI_BOT'`,
    active: notTerminal,
    shift: shiftLaneRush,
  },
  "memory-grid": {
    table: "memory_grid_matches",
    idColumn: "id",
    participant: (userId) => standardPlayer(userId),
    ai: sql`is_ai = true`,
    active: notTerminal,
    shift: shiftMemoryGrid,
  },
  "mines-pvp": {
    table: "mines_pvp_matches",
    idColumn: "id",
    participant: (userId) => standardPlayer(userId),
    ai: sql`is_ai = true`,
    active: notTerminal,
    shift: shiftMines,
  },
  "mini-golf": {
    table: "mini_golf_matches",
    idColumn: "id",
    participant: (userId) => standardPlayer(userId),
    ai: sql`is_ai = true`,
    active: notTerminal,
    shift: noShift,
  },
  pool: {
    table: "pool_matches",
    idColumn: "id",
    participant: (userId) => standardPlayer(userId),
    ai: sql`player2_id = 'AI'`,
    active: notTerminal,
    shift: noShift,
  },
  precision: {
    table: "precision_matches",
    idColumn: "id",
    participant: (userId) => standardPlayer(userId),
    ai: sql`is_ai_game = true`,
    active: notTerminal,
    shift: shiftPrecision,
  },
  "solitaire-duel": {
    table: "solitaire_duel_matches",
    idColumn: "id",
    participant: (userId) => standardPlayer(userId),
    ai: sql`is_ai = true`,
    active: sql`status = 'playing'`,
    shift: shiftSolitaire,
  },
  "speed-typing": {
    table: "speed_typing_matches",
    idColumn: "id",
    participant: (userId) => standardPlayer(userId),
    ai: sql`is_ai = true`,
    active: sql`status = 'playing'`,
    shift: shiftSpeedTyping,
  },
  "sudoku-duel": {
    table: "sudoku_duel_matches",
    idColumn: "id",
    participant: (userId) => standardPlayer(userId),
    ai: sql`is_ai = true`,
    active: sql`status = 'playing'`,
    shift: shiftSudoku,
  },
  "tic-tac-toe": {
    table: "tic_tac_toe_matches",
    idColumn: "id",
    participant: (userId) => standardPlayer(userId),
    ai: sql`is_ai = true`,
    active: sql`status = 'playing'`,
    shift: noShift,
  },
  uno: {
    table: "uno_games",
    idColumn: "id",
    participant: (userId) => sql`(
      guest_id = ${userId}
      or user_id = (select id from users where clerk_id = ${userId} limit 1)
    )`,
    // An AI game is the row with no second account seat.
    ai: sql`player2_id is null`,
    active: sql`status = 'active'`,
    shift: noShift,
  },
};

// ── Service ──────────────────────────────────────────────────────────────

export type PracticePauseState = {
  paused: boolean;
  pausedAtMs: number | null;
};

function rowOf(result: any): Record<string, any> | null {
  return result?.rows?.[0] ?? null;
}

async function loadPauseRow(tx: any, game: PracticePauseGame, matchId: string) {
  const result = await tx.execute(sql`
    select paused_at from practice_pauses
    where game = ${game} and match_id = ${matchId}
    limit 1
  `);
  return rowOf(result);
}

/** Cheap read used by a game store to no-op its poll/advance while paused. */
export async function isPracticePaused(
  game: PracticePauseGame,
  matchId: string,
): Promise<boolean> {
  try {
    const result = await db.execute(sql`
      select 1 from practice_pauses
      where game = ${game} and match_id = ${matchId}
      limit 1
    `);
    return Boolean(rowOf(result));
  } catch {
    // A missing migration must not take a live match down; fail open, the
    // client-side overlay still prevents the human from acting.
    return false;
  }
}

export async function getPracticePause({
  game,
  matchId,
  userId,
}: {
  game: PracticePauseGame;
  matchId: string;
  userId: string;
}): Promise<PracticePauseState | { error: string; status: number }> {
  if (!userId) return { error: "Unauthorized", status: 401 };
  const cfg = GAMES[game];
  if (!cfg) return { error: "Unknown game", status: 400 };

  const row = await db.transaction(async (tx) => {
    const gameRow = rowOf(
      await tx.execute(sql`
        select * from ${sql.identifier(cfg.table)}
        where ${col(cfg.idColumn)} = ${matchId}
        limit 1
      `),
    );
    if (!gameRow) return null;
    const authorized = rowOf(
      await tx.execute(sql`
        select 1 from ${sql.identifier(cfg.table)}
        where ${col(cfg.idColumn)} = ${matchId}
          and ${cfg.ai}
          and ${cfg.participant(userId)}
        limit 1
      `),
    );
    if (!authorized) return null;
    return loadPauseRow(tx, game, matchId);
  });

  if (!row) return { paused: false, pausedAtMs: null };
  const at = row.paused_at ? new Date(row.paused_at).getTime() : NaN;
  return { paused: true, pausedAtMs: Number.isFinite(at) ? at : null };
}

export async function setPracticePause({
  game,
  matchId,
  userId,
  paused,
}: {
  game: PracticePauseGame;
  matchId: string;
  userId: string;
  paused: boolean;
}): Promise<{ ok: true; paused: boolean } | { error: string; status: number }> {
  if (!userId) return { error: "Unauthorized", status: 401 };
  const cfg = GAMES[game];
  if (!cfg) return { error: "Unknown game", status: 400 };

  return await db.transaction(async (tx) => {
    // One toggle per match at a time: two tabs must not both shift the clock.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`practice-pause:${game}:${matchId}`}))`);

    const gameRow = rowOf(
      await tx.execute(sql`
        select * from ${sql.identifier(cfg.table)}
        where ${col(cfg.idColumn)} = ${matchId}
        limit 1
      `),
    );
    if (!gameRow) return { error: "Match not found", status: 404 };

    const authorized = rowOf(
      await tx.execute(sql`
        select 1 from ${sql.identifier(cfg.table)}
        where ${col(cfg.idColumn)} = ${matchId}
          and ${cfg.ai}
          and ${cfg.active}
          and ${cfg.participant(userId)}
        limit 1
      `),
    );
    if (!authorized) {
      const aiMatch = rowOf(
        await tx.execute(sql`
          select 1 from ${sql.identifier(cfg.table)}
          where ${col(cfg.idColumn)} = ${matchId} and ${cfg.ai}
          limit 1
        `),
      );
      if (!aiMatch) return { error: "Only free-play matches can be paused", status: 400 };
      return { error: "Match is not active for this player", status: 409 };
    }

    const existing = await loadPauseRow(tx, game, matchId);

    if (paused) {
      if (existing) return { ok: true as const, paused: true };
      await tx.execute(sql`
        insert into practice_pauses (game, match_id, user_id, paused_at)
        values (${game}, ${matchId}, ${userId}, now())
      `);
      return { ok: true as const, paused: true };
    }

    if (!existing) return { error: "Match is not paused", status: 409 };
    const pausedAtMs = existing.paused_at ? new Date(existing.paused_at).getTime() : NaN;
    const deltaMs = Number.isFinite(pausedAtMs) ? Math.max(0, Date.now() - pausedAtMs) : 0;
    if (deltaMs > 0) await cfg.shift(tx, gameRow, matchId, deltaMs);
    await tx.execute(sql`
      delete from practice_pauses where game = ${game} and match_id = ${matchId}
    `);
    return { ok: true as const, paused: false };
  });
}
