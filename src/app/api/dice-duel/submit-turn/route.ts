import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../db";
import { and, eq } from "drizzle-orm";
import { diceMatches, diceTurns } from "../../../../db/schema";

const d6 = () => Math.floor(Math.random() * 6) + 1;
function calc(actionType: string) {
  const r1 = d6();
  const r2 = actionType === "POWER_ROLL" ? d6() : null;
  let damage = 0; let selfDamage = 0;
  if (actionType === "SAFE_ROLL") damage = r1 <= 2 ? 0 : r1 <= 4 ? 2 : 4;
  if (actionType === "POWER_ROLL") {
    const total = r1 + (r2 || 0);
    if (total <= 4) selfDamage = 3;
    else if (total <= 7) damage = 3;
    else if (total <= 10) damage = 6;
    else damage = 8;
  }
  return { r1, r2, damage, selfDamage };
}

export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ ok: false }, { status: 401 });
  const { matchId, actionType } = await req.json();
  const [m] = await db.select().from(diceMatches).where(and(eq(diceMatches.id, matchId), eq(diceMatches.status, "active"))).limit(1);
  if (!m) return NextResponse.json({ ok: false, message: "Match unavailable" }, { status: 404 });
  if (m.turnUserId !== userId) return NextResponse.json({ ok: false, message: "Not your turn" }, { status: 400 });

  const turn = calc(actionType);
  let hp1 = m.hp1;
  let hp2 = m.hp2;
  if (m.player1Id === userId) { hp2 = Math.max(0, hp2 - turn.damage); hp1 = Math.max(0, hp1 - turn.selfDamage); }
  else { hp1 = Math.max(0, hp1 - turn.damage); hp2 = Math.max(0, hp2 - turn.selfDamage); }
  let nextTurn = m.player1Id === userId ? m.player2Id : m.player1Id;
  let round = m.round + 1;
  let status = (hp1 <= 0 || hp2 <= 0 || round > 20) ? "finished" : "active";
  let winnerId = hp1 === hp2 ? null : (hp1 > hp2 ? m.player1Id : m.player2Id);

  await db.insert(diceTurns).values({ matchId, userId, round: m.round, actionType, roll1: turn.r1, roll2: turn.r2, damageDealt: turn.damage, selfDamage: turn.selfDamage });

  if (status === "active" && nextTurn === "AI_BOT") {
    const aiAction = Math.random() < 0.65 ? "POWER_ROLL" : "SAFE_ROLL";
    const ai = calc(aiAction);
    hp1 = Math.max(0, hp1 - ai.damage);
    hp2 = Math.max(0, hp2 - ai.selfDamage);
    await db.insert(diceTurns).values({ matchId, userId: "AI_BOT", round, actionType: aiAction, roll1: ai.r1, roll2: ai.r2, damageDealt: ai.damage, selfDamage: ai.selfDamage });
    round += 1;
    nextTurn = m.player1Id;
    status = (hp1 <= 0 || hp2 <= 0 || round > 20) ? "finished" : "active";
    winnerId = hp1 === hp2 ? null : (hp1 > hp2 ? m.player1Id : m.player2Id);
  }

  await db.update(diceMatches).set({ hp1, hp2, round, turnUserId: nextTurn, status, winnerId, endedAt: status === "finished" ? new Date() : null }).where(eq(diceMatches.id, matchId));
  return NextResponse.json({ ok: true });
}
