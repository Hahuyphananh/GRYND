// src/app/api/user/emotes/route.ts
//
// GET  — the signed-in user's complete emote state:
//   * equippedEmotes — the ordered loadout (max 9, already sanitized
//                      server-side), exactly what the in-game picker shows
//   * emotes         — every enabled catalog emote with ownership /
//                      equipped flags + Battle Pass unlock info for locked
//                      entries (profile manager renders locked/unowned here)
//   * maxLoadout     — the server-enforced 9-slot cap
// The client renders emotes ONLY from these catalog keys via emoteAssetUrl —
// never from a client-supplied URL.
//
// POST — replace the entire loadout in ONE atomic request:
//   { "emotes": ["laugh", "shock", ...] }
// Server validation (never trust the client):
//   1. authenticated user,
//   2. body is an array of strings,
//   3. every key exists in the official catalog and is enabled,
//   4. every key is owned by the user (user_emotes),
//   5. no duplicate keys,
//   6. max 9 entries.
// The complete ordered list is saved atomically to users.equipped_emotes.
// Unlocking an emote via request tampering is impossible: ownership is
// checked server-side and grants only happen through the Battle Pass / free
// reconciliation paths.

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { getEmoteState, setEquippedEmotes } from "../../../../lib/emotes";
import { MAX_EQUIPPED_EMOTES } from "../../../../lib/emoteAssets";

export const runtime = "nodejs";

export async function GET() {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
    }

    const state = await getEmoteState(userId);
    if (!state) {
      return NextResponse.json({ success: false, error: "User not found" }, { status: 404 });
    }

    return NextResponse.json({
      success: true,
      equippedEmotes: state.equippedEmotes,
      emotes: state.emotes,
      maxLoadout: MAX_EQUIPPED_EMOTES,
    });
  } catch (error) {
    console.error("[GET /api/user/emotes] error:", error);
    return NextResponse.json({ success: false, error: "Failed to load emotes" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
    }

    let body: { emotes?: unknown } = {};
    try {
      body = await req.json();
    } catch {
      body = {};
    }

    const result = await setEquippedEmotes(userId, body?.emotes);
    if (result.ok === false) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: result.status ?? 400 }
      );
    }

    return NextResponse.json({
      success: true,
      equippedEmotes: result.equippedEmotes,
    });
  } catch (error) {
    console.error("[POST /api/user/emotes] error:", error);
    return NextResponse.json({ success: false, error: "Failed to update emotes" }, { status: 500 });
  }
}
