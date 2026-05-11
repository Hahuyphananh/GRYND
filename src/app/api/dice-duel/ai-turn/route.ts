import { NextResponse } from "next/server";
import { db } from "../../../../db";
import { eq, and } from "drizzle-orm";
import { diceMatches, diceTurns } from "../../../../db/schema";

const d6 = () => Math.floor(Math.random() * 6) + 1;

function calc(actionType: string) {
  const r1 = d6();
  const r2 = d6();

  let damage = 0;
  let selfDamage = 0;
  let heal = 0;

  if (actionType === "SAFE_ROLL") {
    damage = r1 <= 2 ? 0 : r1 <= 4 ? 2 : 4;
  }

  if (actionType === "POWER_ROLL") {
    const total = r1 + r2;
    if (total <= 4) selfDamage = 3;
    else if (total <= 7) damage = 3;
    else if (total <= 10) damage = 6;
    else damage = 8;
  }

  if (actionType === "SHIELD") {
    heal = r1 >= 4 ? 3 : 2;
  }

  if (actionType === "DOUBLE_DOWN") {
    const total = r1 + r2;
    if (total >= 8) damage = 10;
    else selfDamage = 5;
  }

  return { r1, r2, damage, selfDamage, heal };
}

export async function POST(req: Request) {
  const { matchId } = await req.json();

  const [m] = await db
    .select()
    .from(diceMatches)
    .where(and(eq(diceMatches.id, matchId), eq(diceMatches.status, "active")))
    .limit(1);

  if (!m || m.turnUserId !== "AI_BOT") {
    return NextResponse.json({ ok: false });
  }

  const aiMoves = ["SAFE_ROLL", "POWER_ROLL", "SHIELD", "DOUBLE_DOWN"];

  const aiAction = aiMoves[Math.floor(Math.random() * aiMoves.length)];

  const ai = calc(aiAction);

  let hp1 = Math.max(0, m.hp1 - ai.damage);
  let hp2 = Math.max(0, m.hp2 - ai.selfDamage + ai.heal);

  let round = m.round + 1;
  let status = hp1 <= 0 || hp2 <= 0 || round > 20 ? "finished" : "active";

  let winnerId = hp1 === hp2 ? null : hp1 > hp2 ? m.player1Id : m.player2Id;

  await db.insert(diceTurns).values({
    matchId,
    userId: "AI_BOT",
    round: m.round,
    actionType: aiAction,
    roll1: ai.r1,
    roll2: ai.r2,
    damageDealt: ai.damage,
    selfDamage: ai.selfDamage,
  });

  await db
    .update(diceMatches)
    .set({
      hp1,
      hp2,
      round,
      turnUserId: m.player1Id,
      status,
      winnerId,
      endedAt: status === "finished" ? new Date() : null,
    })
    .where(eq(diceMatches.id, matchId));

  return NextResponse.json({ ok: true });
}
