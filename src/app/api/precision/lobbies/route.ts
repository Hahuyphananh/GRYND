// GET /api/precision/lobbies
//
// Public list of open PvP lobbies so the lobby page can render a list.
// Mirrors the response shape of /api/pool/lobbies.
//
// The queue lives in `precision_lobbies` (Postgres). It used to be read from
// a process-local Map, which is why a lobby created on one instance was
// invisible to the list served by another.

import { NextResponse } from "next/server";
import { listWaitingLobbies, toClientLobby } from "../../../../lib/precision/serverStore";

export const dynamic = "force-dynamic";

export async function GET() {
  const rows = await listWaitingLobbies();
  return NextResponse.json({ success: true, lobbies: rows.map(toClientLobby) });
}
