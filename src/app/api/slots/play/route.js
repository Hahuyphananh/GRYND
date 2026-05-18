import { auth, currentUser } from "@clerk/nextjs/server";
import { db } from "../../../../db/client";
import { users } from "../../../../db/schema";
import { eq, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { recordBigWinIfNeeded } from "../../../../lib/bigWins";

export async function POST(req) {
  try {
    const { userId } = await auth();
    if (!userId)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { bet } = await req.json();
    if (typeof bet !== "number" || bet <= 0) {
      return NextResponse.json(
        { error: "Invalid bet amount" },
        { status: 400 },
      );
    }

    // Deduct bet
    const [user] = await db
      .update(users)
      .set({ balance: sql`balance - ${bet}` })
      .where(sql`${users.clerkId} = ${userId} AND ${users.balance} >= ${bet}`)
      .returning({ balance: users.balance });

    if (!user)
      return NextResponse.json(
        { error: "Insufficient balance" },
        { status: 400 },
      );

    const fruitIcons = [
      "🍉",
      "🍌",
      "🍍",
      "🍏",
      "🍓",
      "🥭",
      "🍈",
      "🍇",
      "🍒",
      "🍎",
      "🍊",
      "🍋",
      "🥝",
      "🍐",
      "🍑",
      "🥥",
      "🍅",
      "🍆",
      "🌽",
      "🍠",
    ];

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
      fruitIcons[Math.floor(Math.random() * fruitIcons.length)];

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
        () => fruitIcons[Math.floor(Math.random() * fruitIcons.length)],
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
    // 💰 PAYOUT
    // ---------------------------
    let winAmount = 0;

    if (matchCount === 5)
      winAmount = bet * 6; // bet + 5x
    else if (matchCount === 4)
      winAmount = bet * 4; // bet + 3x
    else if (matchCount === 3) winAmount = bet * 3; // bet + 2x

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
        game: "Slots",
        betAmount: bet,
        winAmount: winAmount,
        multiplier: winAmount / bet,
      }).catch(() => {}); // Fire and forget
    }

    return NextResponse.json({
      success: true,
      data: {
        reels,
        winAmount,
        profit: winAmount - bet,
        newBalance,
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
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
