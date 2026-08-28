import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../db";
import { diceLobbies } from "../../../../db/schema";
import { logError } from "../../../../lib/logError";

export async function POST(req: Request) {
  try {
    const { userId } = await auth();
    if (!userId)
      return NextResponse.json(
        { ok: false, message: "Unauthorized" },
        { status: 401 },
      );
    const { wager = 10 } = await req.json().catch(() => ({}));
    const [row] = await db
      .insert(diceLobbies)
      .values({ hostUserId: userId, wager: Number(wager), status: "waiting" })
      .returning({ id: diceLobbies.id });
    return NextResponse.json({ ok: true, lobbyId: row.id });
  } catch (error) {
    await logError({
      errorType: "dice_duel_lobby_creation_error",
      errorMessage: error instanceof Error ? error.message : "Dice Duel lobby creation failed",
      stackTrace: error instanceof Error ? error.stack : undefined,
      endpoint: "/api/dice-duel/create-lobby",
      game: "Dice Duel",
      metadata: { operation: "create_lobby" },
    });
    return NextResponse.json({ ok: false, message: "Unable to create lobby" }, { status: 500 });
  }
}
