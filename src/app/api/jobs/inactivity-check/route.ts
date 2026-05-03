import { NextResponse } from "next/server";
import { and, eq, isNull, lte } from "drizzle-orm";
import { db } from "../../../../db/index";
import { userAutomationState, users } from "../../../../db/schema";
import { sendInactivityEmail } from "../../../../lib/emails/inactivity";

export async function POST() {
  const threshold = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
  const candidates = await db.select({ clerkId: userAutomationState.clerkId, email: users.email }).from(userAutomationState).innerJoin(users, eq(users.clerkId, userAutomationState.clerkId)).where(and(lte(userAutomationState.lastLoginAt, threshold), isNull(userAutomationState.lastInactivityEmailSentAt)));
  for (const row of candidates) {
    await sendInactivityEmail({ clerkId: row.clerkId, email: row.email });
    await db.update(userAutomationState).set({ lastInactivityEmailSentAt: new Date(), updatedAt: new Date() }).where(eq(userAutomationState.clerkId, row.clerkId));
  }
  return NextResponse.json({ scanned: candidates.length });
}
