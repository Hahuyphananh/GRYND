// POST /api/precision/join-lobby
//
// Join a public waiting lobby as seat 2. On success the lobby id — which is
// also the match id — is returned so the client can route to
// /casino/precision/game/[matchId].
//
// The whole operation is one atomic UPDATE in `serverStore.joinLobbyById`:
//
//   UPDATE precision_lobbies
//      SET status = 'active', opponent_user_id = $me
//    WHERE id = $lobby AND status = 'waiting' AND host_user_id <> $me
//   RETURNING ...
//
// Whoever wins that UPDATE owns the pairing, so two players clicking Join at
// the same instant can never both land in the same seat.
//
// ── Identity (IDOR hardening) ────────────────────────────────────────────
// The joiner's userId comes from the Clerk SESSION, never from the body — a
// client could previously join a lobby as ANY user by sending a spoofed
// `body.userId`. `playerName` is display-only: trimmed and capped.
//
// ── Why an id that already has a match is refused ────────────────────────
// A lobby id becomes the MATCH id the moment two players are paired, so any
// id that already has a match row must never be handed out as joinable
// again. That single rule is also what keeps a free "vs AI" practice match
// un-joinable: a practice match only ever has a `precision_matches` row and
// no lobby row at all.

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { joinLobbyById } from "../../../../lib/precision/serverStore";

export const dynamic = "force-dynamic";

/**
 * Display name only — NEVER an identity. Trimmed and capped so a hostile
 * client can't stuff a paragraph into the match UI.
 */
function sanitizeName(value: unknown, fallback: string): string {
  const name = String(value ?? "").replace(/\s+/g, " ").trim();
  return name ? name.slice(0, 24) : fallback;
}

export async function POST(req: NextRequest) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json(
        { success: false, error: "Unauthorized" },
        { status: 401 },
      );
    }
    const body = await req.json().catch(() => ({}));
    const lobbyId = String(body?.lobbyId ?? "");
    if (!lobbyId) {
      return NextResponse.json(
        { success: false, error: "Missing lobbyId." },
        { status: 400 },
      );
    }

    const result = await joinLobbyById({
      lobbyId,
      userId,
      userName: sanitizeName(body?.playerName, "Player 2"),
    });
    if (!result.matchId) {
      return NextResponse.json(
        { success: false, error: result.error ?? "Unable to join this lobby." },
        { status: result.status ?? 409 },
      );
    }
    return NextResponse.json({ success: true, matchId: result.matchId });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: (err as Error)?.message ?? "Unknown error" },
      { status: 500 },
    );
  }
}
