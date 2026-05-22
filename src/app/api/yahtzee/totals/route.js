import { NextResponse } from "next/server";
import { db, eq, loadRoom, requireUser, yahtzeeRooms } from "../_lib";

const UPPER_CATS = ["ones","twos","threes","fours","fives","sixes"];

function computeTotals(scorecards) {
  return Object.fromEntries(
    Object.entries(scorecards).map(([userId, card]) => {
      const cardEntries = card || {};
      const upper = UPPER_CATS.reduce((t, k) => t + ((cardEntries)[k] ?? 0), 0);
      const bonus = upper >= 63 ? 35 : 0;
      const raw = Object.values(cardEntries).reduce((a, b) => a + (b ?? 0), 0);
      return [userId, { upper, bonus, raw, total: raw + bonus }];
    })
  );
}

export async function GET(req) {
  try {
    const userId = await requireUser();
    const { searchParams } = new URL(req.url);
    const roomId = searchParams.get("roomId");
    if (!roomId) throw new Error("Missing roomId");

    const room = await loadRoom(roomId);
    const state = room.gameState;
    if (!state) throw new Error("No game state found");

    const totals = computeTotals(state.scorecards || {});
    const playerTotals = (state.players || []).map((p) => ({
      userId: p.userId,
      name: p.name,
      isAI: p.isAI || false,
      ...(totals[p.userId] || { upper: 0, bonus: 0, raw: 0, total: 0 }),
    }));

    return NextResponse.json({ success: true, playerTotals });
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e.message || "Failed" },
      { status: 400 }
    );
  }
}
