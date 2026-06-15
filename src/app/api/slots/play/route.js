import { auth, currentUser } from "@clerk/nextjs/server";
import { db } from "../../../../db/client";
import { users, slotJackpots } from "../../../../db/schema";
import { eq, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { recordBigWinIfNeeded } from "../../../../lib/bigWins";
import { getTheme } from "../../../../lib/slotThemes.jsx";
import { sendSystemNotificationEmail } from "../../../../lib/emails/system";

export async function POST(req) {
  try {
    const { userId } = await auth();
    if (!userId)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { bet, theme, freeSpin } = await req.json();
    const isFreeSpin = !!freeSpin;
    if (typeof bet !== "number" || bet <= 0) {
      return NextResponse.json(
        { error: "Invalid bet amount" },
        { status: 400 },
      );
    }

    const themeConfig = getTheme(theme || "fruit");
    const symbols = themeConfig.symbols;

    // Deduct bet (skip for free spins)
    let user;
    if (!isFreeSpin) {
      const [deducted] = await db
        .update(users)
        .set({ balance: sql`balance - ${bet}` })
        .where(sql`${users.clerkId} = ${userId} AND ${users.balance} >= ${bet}`)
        .returning({ balance: users.balance });

      if (!deducted)
        return NextResponse.json(
          { error: "Insufficient balance" },
          { status: 400 },
        );
      user = deducted;
    } else {
      const [current] = await db
        .select({ balance: users.balance })
        .from(users)
        .where(eq(users.clerkId, userId));
      if (!current)
        return NextResponse.json(
          { error: "User not found" },
          { status: 400 },
        );
      user = current;
    }

    // ---------------------------
    // 🎰 DECIDE OUTCOME FIRST
    // ---------------------------
    const roll = Math.random() * 100;

    let matchCount = 0;
    if (roll < 3)
      matchCount = 5; // 3%
    else if (roll < 10)
      matchCount = 4; // 7%
    else if (roll < 25)
      matchCount = 3; // 15%
    else matchCount = 0; // 75%

    const matchSymbol =
      symbols[Math.floor(Math.random() * symbols.length)];

    const paylines = [
      { name: "top", rows: [0, 0, 0, 0, 0] },
      { name: "middle", rows: [1, 1, 1, 1, 1] },
      { name: "bottom", rows: [2, 2, 2, 2, 2] },
      { name: "v-shape", rows: [0, 1, 2, 1, 0] },
      { name: "inverted-v", rows: [2, 1, 0, 1, 2] },
    ];

    // ---------------------------
    // 🎰 BUILD REELS
    // ---------------------------
    const reels = Array.from({ length: 5 }, () =>
      Array.from(
        { length: 3 },
        () => symbols[Math.floor(Math.random() * symbols.length)],
      ),
    );

    let chosenPayline = null;

    if (matchCount >= 3) {
      chosenPayline = paylines[Math.floor(Math.random() * paylines.length)];

      for (let col = 0; col < matchCount; col++) {
        const row = chosenPayline.rows[col];
        reels[col][row] = matchSymbol;
      }
    }

    // ---------------------------
    // 🎰 PROGRESSIVE JACKPOT
    // ---------------------------
    const themeKey = theme || "fruit";
    const contribution = isFreeSpin ? 0 : Math.floor(bet * 0.02); // 2% of bet (0 for free spins)
    let jackpotAmount = 0;
    let jackpotWon = false;

    if (contribution > 0) {
      try {
        // Contribute to jackpot (atomic upsert)
        await db
          .insert(slotJackpots)
          .values({
            theme: themeKey,
            amount: sql`${contribution}`,
            totalContributed: sql`${contribution}`,
          })
          .onConflictDoUpdate({
            target: slotJackpots.theme,
            set: {
              amount: sql`${slotJackpots.amount} + ${contribution}`,
              totalContributed: sql`${slotJackpots.totalContributed} + ${contribution}`,
              updatedAt: sql`NOW()`,
            },
          });
      } catch {
        // Jackpot table may not exist yet — gracefully skip
      }
    }

    // ---------------------------
    // 💰 PAYOUT
    // ---------------------------
    let winAmount = 0;

    if (matchCount === 5) {
      winAmount = bet * 6; // base 5x win

      // Award progressive jackpot on 5-match
      try {
        const [jpRow] = await db
          .select({ amount: slotJackpots.amount })
          .from(slotJackpots)
          .where(eq(slotJackpots.theme, themeKey));

        if (jpRow && Number(jpRow.amount) > 0) {
          jackpotAmount = Number(jpRow.amount);
          winAmount += jackpotAmount;
          jackpotWon = true;

          // Reset jackpot to seed
          await db
            .update(slotJackpots)
            .set({
              amount: sql`${slotJackpots.seedAmount}`,
              timesWon: sql`${slotJackpots.timesWon} + 1`,
              lastWonBy: userId,
              lastWonAmount: sql`${jackpotAmount}`,
              lastWonAt: sql`NOW()`,
              updatedAt: sql`NOW()`,
            })
            .where(eq(slotJackpots.theme, themeKey));
        }
      } catch {
        // Jackpot table not available — base win only
      }
    } else if (matchCount === 4)
      winAmount = bet * 4;
    else if (matchCount === 3) winAmount = bet * 3;

    await db
      .update(users)
      .set({ balance: sql`balance + ${winAmount}` })
      .where(eq(users.clerkId, userId));

    const newBalance = Number(user.balance) + winAmount;

    // Record big win if winAmount >= 1 million tokens
    if (winAmount >= 1000000) {
      const clerkUser = await currentUser();
      recordBigWinIfNeeded({
        userId: userId,
        username: clerkUser?.firstName ? `${clerkUser.firstName} ${clerkUser.lastName || ""}`.trim() : "Player",
        game: `Slots (${theme || "fruit"})`,
        betAmount: bet,
        winAmount: winAmount,
        multiplier: winAmount / bet,
      }).catch(() => {}); // Fire and forget
    }

    // Fire system notification for large slots bets (≥ 1000 tokens)
    if (bet >= 1000) {
      sendSystemNotificationEmail({
        eventType: "bet_placed",
        description: `User ${userId} spun slots with ${bet} tokens (win: ${winAmount}, profit: ${winAmount - bet}).`,
        metadata: { userId, bet, winAmount, matchCount },
      }).catch((err) => console.warn("[system_notify] Failed to send slots:", err));
    }

    return NextResponse.json({
      success: true,
      data: {
        reels,
        winAmount,
        profit: winAmount - bet,
        newBalance,
        jackpotWon,
        jackpotAmount,
        winningLine:
          matchCount >= 3
            ? {
                line: chosenPayline.name,
                symbol: matchSymbol,
                count: matchCount,
                positions: Array.from({ length: matchCount }, (_, i) => ({
                  col: i,
                  row: chosenPayline.rows[i],
                })),
              }
            : null,
      },
    });
  } catch (err) {
    console.error("Slots play error:", err);

    sendSystemNotificationEmail({
      eventType: "error_event",
      description: `Slots error for user ${userId}: ${(err).message || "Unknown error"}`,
      metadata: { userId, error: (err).stack?.slice(0, 500) || String(err) },
    }).catch((ew) => console.warn("[system_notify] Failed to send slots error:", ew));

    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
