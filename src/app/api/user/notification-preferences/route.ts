// GET/PUT /api/user/notification-preferences — email notification opt-outs.
//
//   GET → { prefs: { promotions, daily, summary, progress } }
//   PUT { prefs } → merges the provided keys over the defaults (all true).
//
// Only marketing-style emails are gated (see src/lib/emails/base.ts) —
// security and transactional mail is always sent.

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import { db } from "../../../../db";
import { users, DEFAULT_NOTIFICATION_PREFS, type NotificationPrefs } from "../../../../db/schema";
import { recordUnsubscribeEvent } from "../../../../lib/emails/unsubscribe";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PREF_KEYS = Object.keys(DEFAULT_NOTIFICATION_PREFS) as Array<keyof NotificationPrefs>;

export async function GET() {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  const [row] = await db
    .select({ notificationPrefs: users.notificationPrefs })
    .from(users)
    .where(eq(users.clerkId, userId))
    .limit(1);

  const prefs = { ...DEFAULT_NOTIFICATION_PREFS, ...(row?.notificationPrefs ?? {}) };
  return NextResponse.json({ success: true, prefs });
}

export async function PUT(req: Request) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  let body: { prefs?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON payload" }, { status: 400 });
  }

  const incoming = body?.prefs;
  if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) {
    return NextResponse.json(
      { success: false, error: "prefs must be an object." },
      { status: 400 },
    );
  }

  const prefsInput = incoming as Partial<Record<keyof NotificationPrefs, unknown>>;
  const merged: NotificationPrefs = { ...DEFAULT_NOTIFICATION_PREFS };

  let touched = false;
  for (const key of PREF_KEYS) {
    if (typeof prefsInput[key] === "boolean") {
      merged[key] = prefsInput[key] as boolean;
      touched = true;
    }
  }
  if (!touched) {
    return NextResponse.json(
      { success: false, error: "No valid preference keys provided." },
      { status: 400 },
    );
  }

  // Read the current row so we can tell a real "unsubscribe from everything"
  // transition (all marketing prefs just turned off) from an ordinary save of
  // an already-off state — only the transition is a compliance audit event.
  const [current] = await db
    .select({ email: users.email, notificationPrefs: users.notificationPrefs })
    .from(users)
    .where(eq(users.clerkId, userId))
    .limit(1);
  const before = { ...DEFAULT_NOTIFICATION_PREFS, ...(current?.notificationPrefs ?? {}) };

  await db
    .update(users)
    .set({ notificationPrefs: merged })
    .where(eq(users.clerkId, userId));

  const allOff = (prefs: NotificationPrefs) =>
    PREF_KEYS.every((key) => prefs[key] === false);
  if (current?.email && allOff(merged) && !allOff(before)) {
    await recordUnsubscribeEvent({
      clerkId: userId,
      email: current.email,
      source: "settings",
    });
  }

  return NextResponse.json({ success: true, prefs: merged });
}