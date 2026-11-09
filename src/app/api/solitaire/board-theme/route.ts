// src/app/api/solitaire/board-theme/route.ts
//
// THE PLAYER'S SAVED SOLITAIRE TABLE — the cross-device half of the theme
// preference. The local half lives in localStorage (see
// src/hooks/useSolitaireBoardTheme.ts), so a guest and an offline tab still
// work; this route is what carries the choice to another device.
//
//   GET  → { success, signedIn, theme: BoardThemeKey | null }
//   PUT  { theme } → { success, theme }        401 when signed out
//
// Guests get `signedIn: false` with a 200 (not a 401) so the client can simply
// leave its local preference alone instead of treating a normal state as an
// error.
//
// `theme: null` means "no choice saved" — distinct from Classic Green, which is
// an actual choice. That distinction is what lets a guest's local selection be
// uploaded on first sign-in rather than being overwritten by the default.
//
// The key is validated against the catalog on the way in and on the way out, so
// this column can never hold a value the board cannot render.

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import { db } from "../../../../db";
import { users } from "../../../../db/schema";
import { isBoardThemeKey } from "../../../../lib/solitaire-duel/boardThemes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ success: true, signedIn: false, theme: null });
  }

  const [row] = await db
    .select({ theme: users.solitaireBoardTheme })
    .from(users)
    .where(eq(users.clerkId, userId))
    .limit(1);

  return NextResponse.json({
    success: true,
    signedIn: true,
    // A key that is no longer a preset reads as "no choice", never as an
    // unstyled board.
    theme: isBoardThemeKey(row?.theme) ? row.theme : null,
  });
}

export async function PUT(req: Request) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON payload" }, { status: 400 });
  }

  const incoming = (body as { theme?: unknown } | null)?.theme;
  if (!isBoardThemeKey(incoming)) {
    return NextResponse.json({ success: false, error: "Unknown theme." }, { status: 400 });
  }

  await db
    .update(users)
    .set({ solitaireBoardTheme: incoming })
    .where(eq(users.clerkId, userId));

  return NextResponse.json({ success: true, theme: incoming });
}
