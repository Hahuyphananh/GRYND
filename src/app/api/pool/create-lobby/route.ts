import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../db";
import { poolLobbies } from "../../../../db/schema";

function validateWager(value: unknown) {
  const wager = Number(value ?? 10);
  if (!Number.isInteger(wager) || wager <= 0) {
    return { error: "Invalid wager" } as const;
  }
  return { wager } as const;
}

export async function POST(req: Request) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ ok: false, message: "Unauthorized" }, { status: 401 });
    }

    let body: { wager?: unknown } = {};
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ ok: false, message: "Invalid JSON payload" }, { status: 400 });
    }

    const parsed = validateWager(body.wager);
    if ("error" in parsed) {
      return NextResponse.json({ ok: false, message: parsed.error }, { status: 400 });
    }

    const [row] = await db
      .insert(poolLobbies)
      .values({
        hostUserId: userId,
        wager: parsed.wager,
        gameMode: "pvp",
        status: "waiting",
      })
      .returning({ id: poolLobbies.id });

    return NextResponse.json({ ok: true, lobbyId: row.id });
  } catch (error) {
    console.error("Pool create-lobby error:", error);
    return NextResponse.json(
      { ok: false, message: error instanceof Error ? error.message : "Unable to create lobby" },
      { status: 500 }
    );
  }
}
