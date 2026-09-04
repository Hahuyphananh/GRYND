// GET/PUT /api/user/default-wagers — per-game default wager (tokens).
//
//   GET → { wagers: { [gameKey]: number } } (empty object = all game defaults)
//   PUT { wagers: { [gameKey]: number } } → merges over existing, allowlisted
//     to the WAGER_GAMES catalog; values must be positive integers (1..10M).
//
// Security: auth-required, updates only the caller's own row, unknown game
// keys rejected.

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import { db } from "../../../../db";
import { users } from "../../../../db/schema";
import { WAGER_GAME_KEYS } from "../../../../lib/defaultWagers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_WAGER = 10_000_000;

export async function GET() {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  const [row] = await db
    .select({ defaultWagers: users.defaultWagers })
    .from(users)
    .where(eq(users.clerkId, userId))
    .limit(1);

  return NextResponse.json({
    success: true,
    wagers: row?.defaultWagers ?? {},
  });
}

export async function PUT(req: Request) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  let body: { wagers?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON payload" }, { status: 400 });
  }

  const incoming = body?.wagers;
  if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) {
    return NextResponse.json(
      { success: false, error: "wagers must be an object." },
      { status: 400 },
    );
  }

  const entries = Object.entries(incoming as Record<string, unknown>);
  const next: Record<string, number> = {};
  for (const [key, value] of entries) {
    if (!WAGER_GAME_KEYS.includes(key)) {
      return NextResponse.json(
        { success: false, error: `Unknown game key: ${key}` },
        { status: 400 },
      );
    }
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_WAGER) {
      return NextResponse.json(
        { success: false, error: `Invalid wager for ${key}: expected a whole number of tokens between 1 and ${MAX_WAGER}.` },
        { status: 400 },
      );
    }
    next[key] = value;
  }

  const [row] = await db
    .select({ defaultWagers: users.defaultWagers })
    .from(users)
    .where(eq(users.clerkId, userId))
    .limit(1);

  const merged = { ...(row?.defaultWagers ?? {}), ...next };

  await db
    .update(users)
    .set({ defaultWagers: merged })
    .where(eq(users.clerkId, userId));

  return NextResponse.json({ success: true, wagers: merged });
}