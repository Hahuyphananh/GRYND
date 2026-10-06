import { NextResponse } from "next/server";
import { requirePracticePlayer } from "../../../../lib/auth/guestSession";
export async function POST(req: Request) {
  // Practice matches are playable by guests; PvP keeps the age gate.
  const gate = await requirePracticePlayer();
  if (gate.response) return gate.response;

  const body = await req.json().catch(() => ({}));
  return NextResponse.json({ ok: true, ...body });
}
