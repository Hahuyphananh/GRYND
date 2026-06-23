// GET /api/precision/lobbies
//
// Scaffold stub: lists open PvP lobbies from the in-memory store so the
// lobby page renders a list. Mirrors the response shape of /api/pool/lobbies.

import { NextResponse } from "next/server";
import { precisionLobbyStore } from "../../../../lib/precision/serverStore";

export const dynamic = "force-dynamic";

export async function GET() {
  const lobbies = Array.from(precisionLobbyStore.values()).filter(
    (l) => l.status === "waiting",
  );
  return NextResponse.json({ success: true, lobbies });
}
