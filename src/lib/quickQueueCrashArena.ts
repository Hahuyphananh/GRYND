import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db/client";
import { crashArenaPlayers, crashArenaTables, crashArenaTransactions, users } from "../db/schema";
import { CRASH_MAX_BUYIN, CRASH_MIN_WAGER, CRASH_MAX_WAGER, CRASH_MIN_BUYIN_MULTIPLIER } from "./games/crash/constants";
import { computeBlinds } from "./crash-poker/roundSystem";

export async function createOrJoinCrashArenaDestination({ userId, wager = 10, buyInAmount }: { userId: string; wager?: number; buyInAmount?: number }) {
  const wagerNum = Math.round(Number(wager) * 100) / 100;
  if (!Number.isFinite(wagerNum) || wagerNum < CRASH_MIN_WAGER || wagerNum > CRASH_MAX_WAGER) return { error: "Invalid Crash Arena wager", status: 400 };
  const minimumBuyin = wagerNum * CRASH_MIN_BUYIN_MULTIPLIER;
  const buyIn = Number.isFinite(Number(buyInAmount)) ? Number(buyInAmount) : minimumBuyin;
  if (buyIn < minimumBuyin || buyIn > CRASH_MAX_BUYIN) return { error: "Invalid Crash Arena buy-in", status: 400 };

  return db.transaction(async (tx) => {
    const [user] = await tx.select({ id: users.id }).from(users).where(eq(users.clerkId, userId)).limit(1);
    if (!user) return { error: "User not found", status: 404 };

    const [open] = await tx.select().from(crashArenaTables)
      .where(and(eq(crashArenaTables.status, "waiting"), eq(crashArenaTables.isAi, false), eq(crashArenaTables.isPrivate, false), eq(crashArenaTables.wagerAmount, wagerNum.toFixed(2))))
      .orderBy(crashArenaTables.createdAt).for("update").limit(1);

    if (open) {
      const [existing] = await tx.select({ id: crashArenaPlayers.id }).from(crashArenaPlayers).where(and(eq(crashArenaPlayers.tableId, open.id), eq(crashArenaPlayers.userId, user.id), inArray(crashArenaPlayers.status, ["seated", "waiting"]))).limit(1);
      if (existing) return { error: "Already seated at Crash Arena table", status: 400 };
      const [funded] = await tx.update(users).set({ balance: sql`${users.balance} - ${buyIn}` }).where(and(eq(users.id, user.id), sql`${users.balance} >= ${buyIn}`)).returning({ balance: users.balance });
      if (!funded) return { error: "Insufficient balance", status: 400 };
      const [player] = await tx.insert(crashArenaPlayers).values({ tableId: open.id, userId: user.id, balance: buyIn.toFixed(2), status: "seated" }).returning();
      await tx.insert(crashArenaTransactions).values({ userId: user.id, tableId: open.id, amount: buyIn.toFixed(2), type: "BUY_IN", reason: `Joined ${open.name}` });
      return { match: { id: open.id, tableId: open.id, playerId: player.id }, joined: true };
    }

    const { smallBlind } = computeBlinds(wagerNum);
    const [table] = await tx.insert(crashArenaTables).values({ name: `$${wagerNum} Crash Arena`, wagerAmount: wagerNum.toFixed(2), minimumBuyin: minimumBuyin.toFixed(2), maxPlayers: 6, hostId: user.id, status: "waiting", isAi: false, isPrivate: false, smallBlind: smallBlind.toFixed(2) }).returning();
    const [funded] = await tx.update(users).set({ balance: sql`${users.balance} - ${buyIn}` }).where(and(eq(users.id, user.id), sql`${users.balance} >= ${buyIn}`)).returning({ balance: users.balance });
    if (!funded) return { error: "Insufficient balance", status: 400 };
    const [player] = await tx.insert(crashArenaPlayers).values({ tableId: table.id, userId: user.id, balance: buyIn.toFixed(2), status: "seated" }).returning();
    await tx.insert(crashArenaTransactions).values({ userId: user.id, tableId: table.id, amount: buyIn.toFixed(2), type: "BUY_IN", reason: `Created ${table.name}` });
    return { match: { id: table.id, tableId: table.id, playerId: player.id }, joined: false };
  });
}
