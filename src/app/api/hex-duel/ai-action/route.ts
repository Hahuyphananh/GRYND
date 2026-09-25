import { NextResponse } from "next/server";
import { decideAIAction } from "../../../../lib/hexDuelAI";
import { coerceAiDifficulty } from "../../../../lib/aiDifficulty";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    // Canonical tier; legacy `medium` (and anything else) coerces to `normal`.
    const difficulty = coerceAiDifficulty(body?.difficulty);
    const snapshot = body?.snapshot ?? {};
    const powerNodeValues = Array.isArray(snapshot.powerNodes) ? snapshot.powerNodes : [];
    const action = decideAIAction(
      {
        ...snapshot,
        powerNodes: new Set<string>(powerNodeValues),
      },
      difficulty,
    );
    return NextResponse.json({ success: true, action });
  } catch (error) {
    console.error("hex-duel ai-action error", error);
    return NextResponse.json({ success: false, error: "Unable to compute AI action" }, { status: 400 });
  }
}
