import { NextResponse } from "next/server";
import { requireAgeVerifiedUser } from "../../../../lib/auth/requireAgeVerified";
export async function POST(req: Request) {
  const gate = await requireAgeVerifiedUser();
  if (gate.response) return gate.response;

  const body = await req.json().catch(() => ({}));
  return NextResponse.json({ ok: true, ...body });
}
