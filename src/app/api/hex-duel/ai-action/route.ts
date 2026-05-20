import { NextResponse } from "next/server";
import { decideAIAction, type AIDifficulty } from "../../../../lib/hexDuelAI";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const difficulty = (body?.difficulty === "easy" || body?.difficulty === "medium") ? body.difficulty as AIDifficulty : "medium";
    const action = decideAIAction(body?.snapshot, difficulty);
    return NextResponse.json({ success: true, action });
  } catch (error) {
    console.error("hex-duel ai-action error", error);
    return NextResponse.json({ success: false, error: "Unable to compute AI action" }, { status: 400 });
  }
}
