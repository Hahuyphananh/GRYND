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
  boardItem,
} from "../../../../lib/solitaire-duel/boardCosmetics";
import { BOARD_THEMES } from "../../../../lib/solitaire-duel/boardThemes";
import {
  STREAK_MILESTONES,
  msUntilUtcMidnight,
  prestigeBadgeLabel,
  titleForStreak,
  utcDateKey,
} from "../../../../lib/streaks/schedule";
import { getEnabledCosmetics } from "../../../../lib/cosmetics";
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
  const owned = new Set(state.unlocks);
  const profileItems = new Map(
    PROFILE_STREAK_ITEMS.map((item) => [item.id, item]),
  );
  const catalog = await getEnabledCosmetics();
  const visualByKey = new Map(catalog.map((row) => [row.key, row.visual]));

  // ONE LADDER for titles and rewards. Ownership comes from `user_unlocks`;
  // `kind` tells the rewards surface which equip endpoint to call. `visual` is
  // the catalog payload used by the rewards-page previews and never by a
  // client-chosen value.
  const ladder = STREAK_MILESTONES.map((milestone) => ({
    day: milestone.day,
    title: milestone.title ?? null,
    items: milestone.items.map((id) => {
      const board = boardItem(id);
      const profileItem = profileItems.get(id);
      const rawKind =
        board?.kind ??
        profileItem?.kind ??
        (id.startsWith("badge_") ? "badge" : id.startsWith("frame_") ? "profile_frame" : "title");
      // The profile catalog calls the frame slot `frame`; the equip API and
      // equipped map call it `profile_frame`. Normalize once here.
      const kind = rawKind === "frame" ? "profile_frame" : rawKind;
      return {
        id,
        label: board?.label ?? profileItem?.label ?? id,
        kind,
        visual: visualByKey.get(id) ?? null,
        owned: owned.has(id),
      };
    }),
    achieved: state.currentStreak >= milestone.day,
    isNext: state.nextMilestone?.day === milestone.day,
  }));

  return NextResponse.json({
    success: true,
    signedIn: true,
    pro,
    equipped: state.equipped,
    equippedCosmetics: state.profileEquipped,
    selectedSpecialTitle: state.selectedSpecialTitle,
    streak: {
      ...state,
      dayKey: utcDateKey(),
      msUntilReset: msUntilUtcMidnight(),
      prestigeLabel: prestigeBadgeLabel(state.currentStreak, state.prestigePips),
      title: titleForStreak(state.currentStreak),
      milestones: ladder,
      nextMilestoneTitle: state.nextMilestone
        ? titleForStreak(state.nextMilestone.day)
        : null,
    },
    ladder,
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
