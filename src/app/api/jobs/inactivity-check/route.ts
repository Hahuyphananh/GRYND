import { NextResponse } from "next/server";
import { and, eq, inArray, isNull, lte } from "drizzle-orm";
import { db } from "../../../../db/index";
import { userAutomationState, users } from "../../../../db/schema";
import { sendInactivityEmail } from "../../../../lib/emails/inactivity";
import { verifyCronRequest } from "../../../../lib/security/cronAuth";

export async function POST(request: Request) {
  // Authenticate cron request before performing global state changes
  const authError = verifyCronRequest(request);
  if (authError) return authError;
  const threshold = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
  const candidates = await db
    .select({ clerkId: userAutomationState.clerkId, email: users.email })
    .from(userAutomationState)
    .innerJoin(users, eq(users.clerkId, userAutomationState.clerkId))
    .where(
      and(
        lte(userAutomationState.lastLoginAt, threshold),
        isNull(userAutomationState.lastInactivityEmailSentAt),
      ),
    );

  // Email sends are external (rate-limit friendly) so they stay
  // sequential; the dedupe marker is then stamped in ONE batched UPDATE
  // instead of N per-row round-trips.
  for (const row of candidates) {
    await sendInactivityEmail({ clerkId: row.clerkId, email: row.email });
  }

  if (candidates.length > 0) {
    await db
      .update(userAutomationState)
      .set({ lastInactivityEmailSentAt: new Date(), updatedAt: new Date() })
      .where(
        inArray(
          userAutomationState.clerkId,
          candidates.map((c) => c.clerkId),
        ),
      );
  }

  return NextResponse.json({ scanned: candidates.length });
}
