// POST /api/precision/update-state
//
// Scaffold stub: accepts the pushed state payload and ignores it. The
// route only exists so the multiplayer.ts helper can call it without 404s
// during the scaffold. A real implementation will write to the database,
// validate the version, and reject stale updates — same posture as
// /api/pool/update-state.

import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function POST(_req: NextRequest) {
  return NextResponse.json({
    success: false,
    error: "Precision gameplay is not yet implemented.",
  }, { status: 501 });
}
