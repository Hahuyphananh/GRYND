// src/app/api/user/profile-customization/route.ts
//
// POST — set the caller's Grynd+ profile customization (accent color and
// avatar frame). Official profile banners use the separate owned-banner API.
//
// Security:
//   * auth-required,
//   * membership-gated: only active members can customize their profile,
//   * accent is strictly validated as a #RRGGBB hex value,
//   * frame is a whitelist key from src/lib/profileCosmetics.ts,
//   * passing null for a field clears it (back to default styling).
//     Unknown fields are rejected by the allowlist; invalid values reject the
//     whole request so partial/broken states can never be persisted.

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import { db } from "../../../../db";
import { users } from "../../../../db/schema";
import { isPremiumMember } from "../../../../lib/stripe/subscriptions";
import {
  HEX_COLOR_REGEX,
  isAvatarFrameKey,
} from "../../../../lib/profileCosmetics";
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

  // Strict allowlist: only `profileAccent` and `avatarFrame` are accepted
  // (each a value, or null to clear). Anything else — profileBanner,
  // isAdmin, balance, another user's id — is rejected as an unexpected
  // field instead of being silently ignored.
  const parsed = await parseAndValidateJson(req, {
    profileAccent: {
      type: "string",
      required: false,
      nullable: true,
      omitIfMissing: true,
      maxLength: 7,
      pattern: HEX_COLOR_REGEX,
    },
    avatarFrame: {
      type: "string",
      required: false,
      nullable: true,
      omitIfMissing: true,
      maxLength: 40,
    },
  });
  if (!parsed.ok) return parsed.response;

  const set: Record<string, unknown> = {};

  // Accent color — #RRGGBB hex (already format-checked by the schema; null
  // clears it). Official banners come from the owned-banner picker only.
  if ("profileAccent" in parsed.data) {
    set.profileAccent = parsed.data.profileAccent;
  }

  // Avatar frame — whitelist key against the cosmetics catalog (null clears).
  if ("avatarFrame" in parsed.data) {
    const frame = parsed.data.avatarFrame;
    if (frame !== null && !isAvatarFrameKey(frame)) {
      return NextResponse.json(
        { success: false, error: "Unknown avatar frame." },
        { status: 400 }
      );
    }
    set.avatarFrame = frame;
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
