// src/app/api/solitaire-duel/lobby/route.ts
//
// GET — the read-only lobby snapshot the Solitaire hub renders on `/`.
//
// Three facts, all from the platform's own tables:
//
//   * `open`      — the waiting lobbies anyone can be paired into. Built by the
//                   store's `listOpenMatches` + `lobbyEntry`, the SAME helpers
//                   `createOrJoin` fills, so the list can never advertise a
//                   lobby the matchmaker would not actually join.
//   * `myWaiting` — the caller's own waiting lobby, from `listMyWaitingMatch`.
//                   This is what makes "resume / cancel your search" real
//                   instead of a client-side guess.
//   * `recent`    — the caller's last few matches, for the dashboard.
//
// NOTHING here decides or changes a match. It is a projection of rows the
// matchmaker already owns; every write still goes through create-or-join,
// create-ai, cancel and the match routes. `lobbyEntry` deliberately exposes no
// board, no deal and no seed — an open lobby is public.
//
// Signed-out visitors get `open` only (with `myWaiting`/`recent` empty), which
// is exactly the public discovery surface.

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { desc, eq, or } from "drizzle-orm";

import { db } from "../../../../db/client";
import { solitaireDuelMatches } from "../../../../db/schema";
import { logError } from "../../../../lib/logError";
import {
  listMyWaitingMatch,
  listOpenMatches,
  lobbyEntry,
} from "../../../../lib/solitaire-duel/serverStore";
import { MATCH_STATUS } from "../../../../lib/solitaire-duel/constants";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RecentMatch = {
  matchId: string;
  status: string;
  outcome: "win" | "loss" | "draw" | null;
  isAi: boolean;
  opponent: string;
  createdAtMs: number | null;
  endedAtMs: number | null;
};

function instantMs(value: unknown): number | null {
  if (!value) return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(String(value));
  return Number.isFinite(ms) ? ms : null;
}

export async function GET() {
  const { userId } = await auth();
  const nowMs = Date.now();

  try {
    const openRows = await listOpenMatches({ limit: 8 });
    const open = openRows
      // Never advertise the caller's own lobby as somebody else's to join.
      .filter((row) => !userId || row.player1Id !== userId)
      .map((row) => lobbyEntry(row, nowMs));

    let myWaiting: { matchId: string; createdAtMs: number | null } | null = null;
    let recent: RecentMatch[] = [];

    if (userId) {
      const waiting = await listMyWaitingMatch({ userId });
      if (waiting) {
        myWaiting = {
          matchId: String(waiting.id),
          createdAtMs: instantMs(waiting.createdAt),
        };
      }

      const rows = await db
        .select({
          id: solitaireDuelMatches.id,
          status: solitaireDuelMatches.status,
          result: solitaireDuelMatches.result,
          winnerId: solitaireDuelMatches.winnerId,
          isAi: solitaireDuelMatches.isAi,
          createdAt: solitaireDuelMatches.createdAt,
          endedAt: solitaireDuelMatches.endedAt,
        })
        .from(solitaireDuelMatches)
        .where(
          or(
            eq(solitaireDuelMatches.player1Id, userId),
            eq(solitaireDuelMatches.player2Id, userId),
          ),
        )
        .orderBy(desc(solitaireDuelMatches.createdAt))
        .limit(6);

      recent = rows.map((row) => ({
        matchId: String(row.id),
        status: String(row.status),
        // The winner is the server's column; the UI only names the caller's side
        // of it. A finished row with no winner was a draw.
        outcome: row.winnerId
          ? row.winnerId === userId
            ? "win"
            : "loss"
          : row.status === MATCH_STATUS.FINISHED
            ? "draw"
            : null,
        isAi: Boolean(row.isAi),
        opponent: row.isAi ? "GRYND AI" : "Live player",
        createdAtMs: instantMs(row.createdAt),
        endedAtMs: instantMs(row.endedAt),
      }));
    }

    return NextResponse.json(
      {
        success: true,
        data: { open, myWaiting, recent, serverNow: nowMs },
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    await logError({
      errorType: "solitaire_duel_lobby_error",
      errorMessage:
        error instanceof Error ? error.message : "Solitaire lobby snapshot failed",
      stackTrace: error instanceof Error ? error.stack : undefined,
      endpoint: "/api/solitaire-duel/lobby",
      game: "Solitaire Duel",
      metadata: { operation: "lobby_snapshot" },
    });
    // A lobby read must degrade to an empty board rather than take the hub down.
    return NextResponse.json(
      { success: false, error: "Unable to load the lobby", data: null },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
