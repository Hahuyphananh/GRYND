// src/app/api/user/prestige-badge/route.js
//
// Equip / unequip the "Prestige N" badge preference
// (users.show_prestige_badge, migration 0137).
//
// Server-authoritative by construction:
//   * The client only toggles a boolean preference. It never submits a
//     prestige level, net wins, or any progression value — those columns
//     are only ever written by authoritative settlement (src/lib/prestige.js).
//   * The displayed badge text is always derived server-side from the user's
//     prestige_level via resolvePrestigeBadge(), which requires an actual
//     Level-100 (XP-derived) player with prestige >= 1.
//   * Toggling on below Level 100 is stored but never rendered — the
//     response always reflects what will actually be shown (display: null).

import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { db } from "../../../../db";
import { eq } from "drizzle-orm";
import { users } from "../../../../db/schema";
import {
  getPrestigeStatus,
  resolvePrestigeBadge,
} from "../../../../lib/prestige";

async function loadState(clerkId) {
  const [row] = await db
    .select({
      xp: users.xp,
      prestigeLevel: users.prestigeLevel,
      showPrestigeBadge: users.showPrestigeBadge,
    })
    .from(users)
    .where(eq(users.clerkId, clerkId))
    .limit(1);
  if (!row) return null;

  const xp = Number(row.xp) || 0;
  const enabled = Boolean(row.showPrestigeBadge);
  const status = getPrestigeStatus({
    prestigeLevel: row.prestigeLevel,
    prestigeNetWins: 0,
    xp,
  });

  return {
    enabled,
    display: resolvePrestigeBadge({
      xp,
      prestigeLevel: row.prestigeLevel,
      showPrestigeBadge: enabled,
    }),
    prestige: status.prestige,
    prestigeUnlocked: status.prestigeUnlocked,
  };
}

export async function GET() {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 },
    );
  }
  const state = await loadState(userId);
  if (!state) {
    return NextResponse.json(
      { success: false, error: "User not found" },
      { status: 404 },
    );
  }
  return NextResponse.json({ success: true, badge: state });
}

export async function POST(req) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 },
    );
  }

  const body = await req.json().catch(() => ({}));
  // Only a boolean preference is accepted — never a prestige level.
  const enabled = body?.enabled === true;

  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.clerkId, userId))
    .limit(1);
  if (!row) {
    return NextResponse.json(
      { success: false, error: "User not found" },
      { status: 404 },
    );
  }

  if (enabled) {
    // Showing the Prestige badge clears every other title slot —
    // the user can only ever display one title at a time.
    await db
      .update(users)
      .set({
        showPrestigeBadge: true,
        selectedTitle: null,
        selectedSpecialTitle: null,
        selectedStreakType: null,
      })
      .where(eq(users.id, row.id));
  } else {
    await db
      .update(users)
      .set({ showPrestigeBadge: false })
      .where(eq(users.id, row.id));
  }

  const state = await loadState(userId);
  return NextResponse.json({ success: true, badge: state });
}
