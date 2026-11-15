// src/app/api/streaks/me/route.ts
//
// GET /api/streaks/me — the streak state, unlocks, equipped board cosmetics and
// the catalog the appearance drawer previews.
//
// Read-only. Nothing here advances a streak: the only writer is
// `recordStreakCompletion` in src/lib/streaks/server.ts, called by a completion
// route that has already verified the play.
//
// A signed-out caller gets `signedIn: false` with a 200, so the chip and the
// drawer can simply stay quiet instead of treating a normal state as an error.

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";

import { readStreakState } from "../../../../lib/streaks/server";
import {
  BOARD_ITEMS,
  CARD_BACKS,
  DECK_SKINS,
  PROFILE_STREAK_ITEMS,
} from "../../../../lib/solitaire-duel/boardCosmetics";
import { BOARD_THEMES } from "../../../../lib/solitaire-duel/boardThemes";
import {
  msUntilUtcMidnight,
  prestigeBadgeLabel,
  utcDateKey,
} from "../../../../lib/streaks/schedule";
import { isProMember } from "../../../../lib/proStatus";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ success: true, signedIn: false });
  }

  const state = await readStreakState(userId);
  if (!state) {
    return NextResponse.json(
      { success: false, error: "Profile not found" },
      { status: 404 },
    );
  }

  const pro = await isProMember(userId);

  return NextResponse.json({
    success: true,
    signedIn: true,
    pro,
    equipped: state.equipped,
    streak: {
      ...state,
      dayKey: utcDateKey(),
      msUntilReset: msUntilUtcMidnight(),
      prestigeLabel: prestigeBadgeLabel(state.currentStreak, state.prestigePips),
    },
    catalog: {
      board: BOARD_ITEMS,
      profile: PROFILE_STREAK_ITEMS,
      cardBacks: CARD_BACKS,
      deckSkins: DECK_SKINS,
      felts: BOARD_THEMES.map((theme) => ({
        key: theme.key,
        label: theme.label,
        blurb: theme.blurb,
        streakDay: theme.streakDay ?? 0,
        felt: theme.felt,
      })),
    },
  });
}
