import { auth, currentUser } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { ensureClickerUser, getRecentRounds, getTokens } from "../../../../lib/goonbet-clicker-db";

export const runtime = "nodejs";

export async function GET() {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const clerkUser = await currentUser();
  await ensureClickerUser(userId, clerkUser?.emailAddresses?.[0]?.emailAddress ?? null);

  const [tokens, rounds] = await Promise.all([getTokens(userId), getRecentRounds(userId)]);
  return NextResponse.json({ tokens: tokens.toString(), rounds });
}
