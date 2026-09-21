// src/lib/crash-arena/aiBot.ts
//
// Server-side identity + lifecycle helpers for the free Crash Arena
// practice mode ("Play vs AI").
//
// Design (mirrors the poker-table AIs): the bot is a real row in
// `users` with a reserved Clerk id — exactly like a seated player — so
// the existing crash-arena engine (rounds, entries, settle, winner
// determination) runs UNCHANGED. The only difference is that AI tables
// are flagged `is_ai = true`, which every money-touching path checks to
// guarantee practice chips stay virtual:
//
//   • create-ai seats the human with a free table balance (no wallet
//     deduction, no BUY_IN transaction).
//   • settle skips WIN/RAKE transactions.
//   • leave / disconnect-cleanup / stale-sweep never refund the balance
//     to the wallet — they just close the practice table.
//   • start-round is host-only on AI tables.
//   • join rejects AI tables (they're private practice rooms).
//
// The bot never connects a socket, so the realtime-server's disconnect
// tracking never sees it, and the stale sweep explicitly skips AI-table
// rows so it can't be swept as a "stale seat".

import crypto from "node:crypto";
import { db } from "../../db/client";
import {
  users,
  crashArenaTables,
  crashArenaPlayers,
  crashArenaRounds,
  crashArenaEntries,
} from "../../db/schema";
import { eq, and, ne, inArray, sql } from "drizzle-orm";
import { searchNameFor } from "../searchName";

/** Reserved Clerk id of the FIRST Crash Arena practice bot. Never a real account. */
export const CRASH_ARENA_AI_CLERK_ID = "crash_arena_ai_bot";

/** Display name shown for the first bot. */
export const CRASH_ARENA_AI_NAME = "GRYND AI";

/** Unique email for the reserved bot row (never used for logins). */
export const CRASH_ARENA_AI_EMAIL = "crash-arena-ai-bot@grynd.local";

/**
 * Clerk id for the n-th bot (0-based). Every AI seat at a private table is
 * a DISTINCT reserved user so multiple bots can sit one table (a single
 * users.id can only hold one entry per hand).
 */
export function crashArenaAiClerkId(index: number): string {
  const n = Math.max(0, Math.floor(index));
  return n === 0 ? CRASH_ARENA_AI_CLERK_ID : `${CRASH_ARENA_AI_CLERK_ID}_${n + 1}`;
}

/** True when a clerkId belongs to a reserved Crash Arena bot. */
export function isCrashArenaAiBotClerkId(clerkId: string | null | undefined): boolean {
  return typeof clerkId === "string" && clerkId.startsWith(`${CRASH_ARENA_AI_CLERK_ID}`);
}

/**
 * Resolve ALL reserved bot users (read-only; never creates).
 * @returns Map<users.id, users.clerkId>
 */
export async function resolveCrashArenaAiBotIds(): Promise<Map<number, string>> {
  const rows = await db
    .select({ id: users.id, clerkId: users.clerkId })
    .from(users)
    .where(sql`${users.clerkId} LIKE ${`${CRASH_ARENA_AI_CLERK_ID}%`}`);
  return new Map(rows.map((r) => [r.id, r.clerkId]));
}

/** True when the given internal user id is one of the reserved bots. */
export async function isCrashArenaAiBotId(userId: number): Promise<boolean> {
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.id, userId),
        sql`${users.clerkId} LIKE ${`${CRASH_ARENA_AI_CLERK_ID}%`}`,
      ),
    )
    .limit(1);
  return Boolean(row);
}

/**
 * Get (creating on first use) the reserved bot user #index. Idempotent —
 * safe to call from any AI-table / add-AI API route. Returns the bot's
 * internal users.id.
 */
export async function getOrCreateCrashArenaAiBot(index = 0): Promise<number> {
  const clerkId = crashArenaAiClerkId(index);
  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.clerkId, clerkId))
    .limit(1);
  if (existing[0]) return existing[0].id;

  const botName =
    index === 0 ? CRASH_ARENA_AI_NAME : `${CRASH_ARENA_AI_NAME} ${index + 1}`;

  const [created] = await db
    .insert(users)
    .values({
      clerkId,
      name: botName,
      // Bots are real users rows, so they carry the same folded search key as
      // everyone else (src/lib/searchName.ts).
      searchName: searchNameFor(botName),
      email:
        index === 0
          ? CRASH_ARENA_AI_EMAIL
          : `crash-arena-ai-bot-${index + 1}@grynd.local`,
      // Never used — the bot has no login. Random so the column stays
      // populated like every other row (it is NOT NULL).
      password: crypto.randomBytes(24).toString("hex"),
    })
    .onConflictDoNothing({ target: users.clerkId })
    .returning({ id: users.id });

  if (created) return created.id;

  // Lost an insert race — the other request created it.
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.clerkId, clerkId))
    .limit(1);
  if (!row) {
    throw new Error(`[crash-arena:ai] failed to resolve AI bot user ${clerkId}`);
  }
  return row.id;
}

/**
 * Resolve the FIRST bot's internal users.id WITHOUT creating it. Returns
 * null when the bot row doesn't exist yet (read-only callers like the
 * tables listing use this so a GET never writes).
 */
export async function resolveCrashArenaAiBotId(): Promise<number | null> {
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.clerkId, CRASH_ARENA_AI_CLERK_ID))
    .limit(1);
  return row?.id ?? null;
}

/**
 * Close an AI practice table: mark every seated/waiting player "left"
 * and set the table status to "closed". Never refunds balances to any
 * wallet — practice chips are virtual. Idempotent.
 *
 * Used when the human permanently leaves ("Back to Lobby") or when their
 * seat is released after a disconnect — a practice table has no reason
 * to outlive its only human.
 */
export async function closeAiCrashArenaTable(tableId: number): Promise<void> {
  // Lock any unresolved mid-round entries as losses (nobody is left at
  // the table to cash out or settle them).
  const openRound = await db
    .select({ id: crashArenaRounds.id })
    .from(crashArenaRounds)
    .where(
      and(
        eq(crashArenaRounds.tableId, tableId),
        ne(crashArenaRounds.status, "settled"),
      ),
    )
    .orderBy(sql`${crashArenaRounds.createdAt} DESC`)
    .limit(1);

  if (openRound[0]) {
    await db
      .update(crashArenaEntries)
      .set({ result: "lost" })
      .where(
        and(
          eq(crashArenaEntries.roundId, openRound[0].id),
          eq(crashArenaEntries.result, "pending"),
        ),
      );
  }

  await db
    .update(crashArenaPlayers)
    .set({ status: "left" })
    .where(
      and(
        eq(crashArenaPlayers.tableId, tableId),
        inArray(crashArenaPlayers.status, ["seated", "waiting"]),
      ),
    );

  await db
    .update(crashArenaTables)
    .set({ status: "closed" })
    .where(eq(crashArenaTables.id, tableId));
}
