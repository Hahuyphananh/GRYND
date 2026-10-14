// src/app/api/user/chat-color/route.ts
//
// POST { color } — set the caller's custom chat name color.
//
// FREE FOR EVERYONE. This was a GRYND PRO perk; customization is no longer
// sold, so the membership check is gone and any signed-in user can set their
// color. The column is only ever written here, so a value that predates the
// change keeps working for its owner — nobody lost their color.
//
// Security:
//   * auth-required — a caller can only ever write their OWN row (the clerk id
//     comes from the session, never from the request body),
//   * the color is strictly validated as a #RRGGBB hex value before it is
//     stored, so it can never inject markup into the chat UI.

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import { db } from "../../../../db";
import { users } from "../../../../db/schema";
import { parseAndValidateJson } from "../../../../lib/security/validation";

export const runtime = "nodejs";

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  // Strict allowlist: only `color` is accepted (a #RRGGBB string, or null to
  // clear). Any other field is rejected rather than silently ignored.
  const parsed = await parseAndValidateJson(req, {
    color: { type: "string", required: true, nullable: true, pattern: HEX_COLOR },
  });
  if (!parsed.ok) return parsed.response;

  const color = parsed.data.color;

  // color: null clears the custom color (back to the default).
  if (color === null) {
    await db
      .update(users)
      .set({ chatColor: null })
      .where(eq(users.clerkId, userId));
    return NextResponse.json({ success: true, color: null });
  }

  await db
    .update(users)
    .set({ chatColor: color })
    .where(eq(users.clerkId, userId));

  return NextResponse.json({ success: true, color });
}
