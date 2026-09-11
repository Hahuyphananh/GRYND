// src/app/api/user/profile-customization/route.ts
//
// POST — set the caller's Grynd+ profile customization (accent color).
//
// Security:
//   * auth-required,
//   * membership-gated: only active members can customize their profile,
//   * accent is strictly validated as a #RRGGBB hex value,
//   * passing null clears it (back to default styling).
//     Unknown fields are rejected by the allowlist; invalid values reject the
//     whole request so partial/broken states can never be persisted.

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import { db } from "../../../../db";
import { users } from "../../../../db/schema";
import { isPremiumMember } from "../../../../lib/stripe/subscriptions";
import { HEX_COLOR_REGEX } from "../../../../lib/profileCosmetics";
import { parseAndValidateJson } from "../../../../lib/security/validation";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  if (!(await isPremiumMember(userId))) {
    return NextResponse.json(
      { success: false, error: "This perk requires an active Grynd+ membership." },
      { status: 403 }
    );
  }

  // Strict allowlist: only `profileAccent` is accepted (a value, or null to
  // clear). Anything else — isAdmin, balance, another user's id — is rejected
  // as an unexpected field instead of being silently ignored.
  const parsed = await parseAndValidateJson(req, {
    profileAccent: {
      type: "string",
      required: false,
      nullable: true,
      omitIfMissing: true,
      maxLength: 7,
      pattern: HEX_COLOR_REGEX,
    },
  });
  if (!parsed.ok) return parsed.response;

  const set: Record<string, unknown> = {};

  // Accent color — #RRGGBB hex (already format-checked by the schema; null
  // clears it).
  if ("profileAccent" in parsed.data) {
    set.profileAccent = parsed.data.profileAccent;
  }

  if (Object.keys(set).length === 0) {
    return NextResponse.json(
      { success: false, error: "Nothing to update." },
      { status: 400 }
    );
  }

  await db.update(users).set(set).where(eq(users.clerkId, userId));

  return NextResponse.json({ success: true, ...set });
}
