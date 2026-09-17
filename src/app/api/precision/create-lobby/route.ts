// POST /api/precision/create-lobby
//
// PvP-only matchmaking for the Precision reaction-time casino game.
// Auto-pairs two callers at the SAME wager or, if no waiting lobby is
// at that wager, enqueues a single waiting lobby so the caller can
// poll the public lobby list until someone joins.
//
// Solo practice lives client-side at `/casino/precision/test` and
// never touches this route — Precision's PvP wagering is
// intentionally the only entry point here so we don't fake a "vs AI"
// opponent that would be game-theoretically rigged.
//
// ── Identity (IDOR hardening) ────────────────────────────────────────────
// The host's userId comes from the Clerk SESSION, never from the body
// (mirrors `/api/pool/create-lobby`, which also uses `auth()`). The body
// used to be the source of truth and the client never sent one, so every
// lobby on the platform was stored with the literal placeholder
// `hostUserId: "host"`. That single line was the root cause of the PvP
// breakage: because `tryAutoMatch` pairs on `lobby.hostUserId !== hostUserId`
// and de-duplicates on `===`, no two players could EVER be paired (every
// host looked like the same player), every caller was instead handed the
// first waiting lobby at that wager — someone else's — and the host could
// never ready up or stop (`/api/precision/ready` + `/round-stop` resolve the
// caller from the session and then require a matching seat, so the
// placeholder host always got a 403).
//
// The response carries a unified `gameId` so the client has a single
// field to navigate to regardless of whether they were queued or
// matched.

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { MIN_WAGER, MAX_WAGER } from "../../../../lib/precision/constants";
import { tryAutoMatch } from "../../../../lib/precision/matchmaking";

export const dynamic = "force-dynamic";

function clampWager(value: number): number {
  if (Number.isNaN(value)) return MIN_WAGER;
  return Math.max(MIN_WAGER, Math.min(MAX_WAGER, Math.floor(value)));
}

/**
 * Display name only — NEVER an identity. Trimmed and capped so a hostile
 * client can't stuff a paragraph into the lobby list.
 */
function sanitizeName(value: unknown): string {
  const name = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!name) return "Player 1";
  return name.slice(0, 24);
}

export async function POST(req: NextRequest) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json(
        { success: false, error: "Sign in to play a staked Precision duel." },
        { status: 401 },
      );
    }

    const body = await req.json().catch(() => ({}));
    const wager = clampWager(Number(body?.wager));
    const hostUserId = userId;
    const hostName = sanitizeName(body?.hostName);

    // PvP-only — any `gameMode` other than "pvp" is normalised away in
    // case a stale client still sends the legacy `"ai"` literal. Solo
    // practice goes through `/casino/precision/test` instead.
    //
    // Pairing happens in Postgres (`precision_lobbies`, claim + match insert
    // in one transaction), so two callers on different instances can finally
    // see each other's queue entries.
    const result = await tryAutoMatch({ wager, hostUserId, hostName });

    if (result.status === "waiting") {
      return NextResponse.json({
        success: true,
        status: "waiting",
        gameId: result.gameId,
        lobbyId: result.gameId,
        matchId: null,
      });
    }

    // Matched PvP pair — the lobby id becomes the match id so both
    // players navigate to the same /casino/precision/game/[id] URL.
    return NextResponse.json({
      success: true,
      status: "matched",
      gameId: result.gameId,
      lobbyId: null,
      matchId: result.gameId,
      opponent: result.opponent,
    });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: (err as Error)?.message ?? "Unknown error" },
      { status: 500 },
    );
  }
}
