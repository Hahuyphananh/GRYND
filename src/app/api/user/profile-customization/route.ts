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
//     Unknown fields are ignored; invalid values reject the whole request so
//     partial/broken states can never be persisted.

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

  let body: Record<string, unknown>;
  try {
    body = await req.json().catch(() => ({}));
  } catch {
    body = {};
  }

  const set: Record<string, unknown> = {};

  // Arbitrary banner URLs were part of the legacy Grynd+ flow. Official
  // banners are selected through /api/user/banner/select only.
  if (Object.prototype.hasOwnProperty.call(body, "profileBanner")) {
    return NextResponse.json(
      { success: false, error: "Use the official banner picker." },
      { status: 400 },
    );
  }

  // Accent color — #RRGGBB hex (or null to clear).
  if (Object.prototype.hasOwnProperty.call(body, "profileAccent")) {
    const accent = body.profileAccent;
    if (accent !== null) {
      if (typeof accent !== "string" || !HEX_COLOR_REGEX.test(accent.trim())) {
        return NextResponse.json(
          { success: false, error: "Accent color must be a hex value like #00e5ff." },
          { status: 400 }
        );
      }
      set.profileAccent = accent.trim();
    } else {
      set.profileAccent = null;
    }
  }

  // Avatar frame — whitelist key (or null to clear).
  if (Object.prototype.hasOwnProperty.call(body, "avatarFrame")) {
    const frame = body.avatarFrame;
    if (frame !== null) {
      if (typeof frame !== "string" || !isAvatarFrameKey(frame)) {
        return NextResponse.json(
          { success: false, error: "Unknown avatar frame." },
          { status: 400 }
        );
      }
      set.avatarFrame = frame;
    } else {
      set.avatarFrame = null;
    }
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
