// app/api/quests/reroll/route.js
//
// POST /api/quests/reroll  { questId }
//
// Swaps one unclaimed daily quest for a fresh one, consuming a single
// `quest_reroll` consumable charge (server-authoritative: the replacement is
// seeded per player/slot/day — the client never chooses its content).
// Idempotent per request; a rerolled quest's deterministic seed means the
// same slot day resolves to the same quest on replay.

import { auth } from "@clerk/nextjs/server";
import { rerollQuest } from "../../../../lib/quests";
import { claimIdempotency } from "../../../../lib/security/idempotency";

export async function POST(req) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return Response.json(
        { success: false, error: "Not authenticated" },
        { status: 401 }
      );
    }

    const idem = await claimIdempotency(req, "quests:reroll", 60);
    if (idem.enforced && !idem.allowed) {
      return Response.json(
        { success: false, error: "Duplicate request" },
        { status: 409 }
      );
    }

    const body = await req.json().catch(() => ({}));
    const questId = Number(body.questId);
    if (!questId || !Number.isInteger(questId)) {
      return Response.json(
        { success: false, error: "Missing questId" },
        { status: 400 }
      );
    }

    const result = await rerollQuest(userId, questId);
    return Response.json({ success: true, quest: result });
  } catch (err) {
    console.error("[QUESTS_REROLL_ERROR]", err);
    const message = err instanceof Error ? err.message : "Failed to reroll quest";
    return Response.json({ success: false, error: message }, { status: 400 });
  }
}