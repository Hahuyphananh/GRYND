// src/app/api/user/chat-color/route.ts
//
// POST { color } — set the caller's custom chat name color (a Grynd+ perk).
//
// Security:
//   * auth-required,
//   * membership-gated: only active members can set a custom color (the
//     column is otherwise never populated),
//   * the color is strictly validated as a #RRGGBB hex value before it is
//     stored, so it can never inject markup into the chat UI.

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import { db } from "../../../../db";
import { users } from "../../../../db/schema";
import { isPremiumMember } from "../../../../lib/stripe/subscriptions";

export const runtime = "nodejs";

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

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

  let body: { color?: unknown };
  try {
    body = await req.json().catch(() => ({}));
  } catch {
    body = {};
  }

  // color: null clears the custom color (back to the default).
  if (body?.color === null) {
    await db
      .update(users)
      .set({ chatColor: null })
      .where(eq(users.clerkId, userId));
    return NextResponse.json({ success: true, color: null });
  }

  const color = typeof body?.color === "string" ? body.color.trim() : "";
  if (!HEX_COLOR.test(color)) {
    return NextResponse.json(
      { success: false, error: "Color must be a hex value like #00e5ff." },
      { status: 400 }
    );
  }

  await db
    .update(users)
    .set({ chatColor: color })
    .where(eq(users.clerkId, userId));

  return NextResponse.json({ success: true, color });
}
