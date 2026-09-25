// app/api/quests/claim/route.js
//
// POST /api/quests/claim  { questId }
//
// Validates the quest is complete + unclaimed, grants the Battle Pass XP
// reward, and marks it claimed (idempotent).

import { auth } from "@clerk/nextjs/server";
import { claimQuest } from "../../../../lib/quests";
import { claimIdempotency } from "../../../../lib/security/idempotency";

export async function POST(req) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return Response.json(
        { success: false, error: "Not authenticated" },
        { status: 401 },
      );
    }

    const idem = await claimIdempotency(req, "quests:claim", 180);
    if (idem.enforced && !idem.allowed) {
      return Response.json(
        { success: false, error: "Duplicate request" },
        { status: 409 },
      );
    }

    const body = await req.json().catch(() => ({}));
    const questId = Number(body.questId);
    if (!questId || !Number.isInteger(questId)) {
      return Response.json(
        { success: false, error: "Missing questId" },
        { status: 400 },
      );
    }

    const result = await claimQuest(userId, questId);
    return Response.json({ success: true, ...result });
  } catch (err) {
    console.error("[QUESTS_CLAIM_ERROR]", err);
    const message = err instanceof Error ? err.message : "Failed to claim quest";
    return Response.json({ success: false, error: message }, { status: 400 });
  }
}
