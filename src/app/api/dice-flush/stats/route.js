import { NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../../../../db/client";
import { diceFlushRooms, diceFlushPlayers } from "../../../../db/schema";
import { requireUser } from "../_lib";
import { matchBreakdown } from "../../../../../game-engine/diceFlushEngine";

// GET /api/dice-flush/stats
//
// Match history + stats for Dice Flush (shared-sheet format).
//
//   ?roomId=<id>            → full breakdown of ONE finished match
//                             (participant-only — 403-equivalent for
//                             non-participants)
//   (no params)             → the requesting user's finished matches
//                             (newest first, capped at 100) plus aggregate
//                             stats computed over ALL of their finished
//                             matches.
//
// Scores are computed from the room's gameState via the engine's
// `matchBreakdown`, which understands BOTH the new shared-sheet shape
// (scorecardOwner) and legacy per-player scorecards, so history stays
// correct across the format change.

function buildMatchView(room, userId) {
  const state =
    room.gameState && typeof room.gameState === "object" ? room.gameState : {};
  const players = Array.isArray(state.players) ? state.players : [];
  const breakdown = matchBreakdown(state);
  const isAi = players.some((p) => p.isAI);

  const views = players.map((p) => {
    const b =
      breakdown[p.userId] ?? { categories: {}, upper: 0, bonus: 0, raw: 0, total: 0 };
    return {
      userId: p.userId,
      name: p.name,
      isAI: !!p.isAI,
      categories: b.categories,
      upper: b.upper,
      bonus: b.bonus,
      raw: b.raw,
      total: b.total,
    };
  });

  // Winner = strictly higher total; equal totals count as a draw (ties are
  // practically impossible across 12 claimed categories, but never report a
  // false win).
  let winnerId = null;
  if (views.length === 2) {
    const [a, b] = views;
    if (a.total > b.total) winnerId = a.userId;
    else if (b.total > a.total) winnerId = b.userId;
  }

  const mine = views.find((v) => v.userId === userId) ?? null;
  const opponent = views.find((v) => v.userId !== userId) ?? null;
  const myResult = winnerId ? (winnerId === userId ? "won" : "lost") : "draw";

  // PvP money math (AI / free-play matches never move tokens). Winner takes
  // ~95% of the pot; loser loses their wager.
  const wager = Number(room.wager ?? 0);
  const pot = Number(room.pot ?? 0);
  const payout = Math.floor(pot * 0.95);
  const netTokens =
    isAi || myResult === "draw"
      ? 0
      : myResult === "won"
        ? payout - wager
        : -wager;

  return {
    roomId: room.id,
    status: room.status,
    createdAt: room.createdAt ? new Date(room.createdAt).toISOString() : null,
    wager,
    pot,
    mode: isAi ? "ai" : "pvp",
    winnerId,
    players: views,
    myResult,
    myTotal: mine?.total ?? 0,
    myBonus: mine?.bonus ?? 0,
    opponentName: opponent?.name ?? null,
    opponentTotal: opponent?.total ?? 0,
    netTokens,
  };
}

export async function GET(req) {
  try {
    const userId = await requireUser();
    const { searchParams } = new URL(req.url);
    const roomId = searchParams.get("roomId");

    // ── Single-match detail (participant-only) ───────────────────────
    if (roomId) {
      const [room] = await db
        .select()
        .from(diceFlushRooms)
        .where(eq(diceFlushRooms.id, roomId))
        .limit(1);
      if (!room) throw new Error("Room not found");
      const [participant] = await db
        .select({ id: diceFlushPlayers.id })
        .from(diceFlushPlayers)
        .where(
          and(
            eq(diceFlushPlayers.roomId, roomId),
            eq(diceFlushPlayers.userId, userId),
          ),
        )
        .limit(1);
      if (!participant) throw new Error("Not a participant");
      return NextResponse.json({ success: true, match: buildMatchView(room, userId) });
    }

    // ── History list + aggregate stats for the requesting user ───────
    const rows = await db
      .select()
      .from(diceFlushPlayers)
      .innerJoin(diceFlushRooms, eq(diceFlushPlayers.roomId, diceFlushRooms.id))
      .where(
        and(
          eq(diceFlushPlayers.userId, userId),
          eq(diceFlushRooms.status, "finished"),
        ),
      )
      .orderBy(desc(diceFlushRooms.createdAt));

    const matches = rows.map((r) => buildMatchView(r.dice_flush_rooms, userId));

    const won = matches.filter((m) => m.myResult === "won").length;
    const lost = matches.filter((m) => m.myResult === "lost").length;
    const drawn = matches.filter((m) => m.myResult === "draw").length;

    const stats = {
      matchesPlayed: matches.length,
      wins: won,
      losses: lost,
      draws: drawn,
      winRate: matches.length ? won / matches.length : 0,
      bestScore: matches.length
        ? Math.max(...matches.map((m) => m.myTotal))
        : 0,
      avgScore: matches.length
        ? Math.round(
            (matches.reduce((s, m) => s + m.myTotal, 0) / matches.length) * 100,
          ) / 100
        : 0,
      upperBonusCount: matches.filter((m) => m.myBonus > 0).length,
      pvpMatches: matches.filter((m) => m.mode === "pvp").length,
      aiMatches: matches.filter((m) => m.mode === "ai").length,
      totalNetTokens: matches.reduce((s, m) => s + m.netTokens, 0),
    };

    return NextResponse.json({
      success: true,
      stats,
      matches: matches.slice(0, 100),
    });
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e.message || "Failed" },
      { status: 400 },
    );
  }
}
