import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../db";
import { and, eq } from "drizzle-orm";
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
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  const { matchId, actionType } = await req.json();

  const [m] = await db
    .select()
    .from(diceMatches)
    .where(
      and(
        eq(diceMatches.id, matchId),
        eq(diceMatches.status, "active")
      )
    )
    .limit(1);

  if (!m) {
    return NextResponse.json(
      { ok: false, message: "Match unavailable" },
      { status: 404 }
    );
  }

  if (m.turnUserId !== userId) {
    return NextResponse.json(
      { ok: false, message: "Not your turn" },
      { status: 400 }
    );
  }

  const turn = calc(actionType);

const isPlayer1 = m.player1Id === userId;


// normalize perspective
let playerHP = isPlayer1 ? m.hp1 : m.hp2;
let enemyHP = isPlayer1 ? m.hp2 : m.hp1;

// APPLY DAMAGE (same logic for both players + AI)
enemyHP = Math.max(0, enemyHP - turn.damage);
playerHP = Math.max(0, playerHP - turn.selfDamage);
playerHP += turn.heal;

// write back to correct DB fields
let hp1 = isPlayer1 ? playerHP : enemyHP;
let hp2 = isPlayer1 ? enemyHP : playerHP;

  let nextTurn =
    m.player1Id === userId ? m.player2Id : m.player1Id;

  let round = m.round;

  let status =
    hp1 <= 0 || hp2 <= 0 || round > 20
      ? "finished"
      : "active";

  let winnerId =
    hp1 === hp2
      ? null
      : hp1 > hp2
      ? m.player1Id
      : m.player2Id;

  await db.insert(diceTurns).values({
    matchId,
    userId,
    round: m.round,
    actionType,
    roll1: turn.r1,
    roll2: turn.r2,
    damageDealt: turn.damage,
    selfDamage: turn.selfDamage,
  });

  await db
    .update(diceMatches)
    .set({
      hp1,
      hp2,
      round,
      turnUserId: nextTurn,
      status,
      winnerId,
      endedAt:
        status === "finished" ? new Date() : null,
    })
    .where(eq(diceMatches.id, matchId));

    const isAI = m.player2Id === "AI_BOT";

return NextResponse.json({
  ok: true,
  actionType,
  aiTurn: isAI && status === "active" && nextTurn === "AI_BOT",
  turnResult: {
    roll1: turn.r1,
    roll2: turn.r2,
    damage: turn.damage,
    selfDamage: turn.selfDamage,
    heal: turn.heal,
    actor: userId
  }
});
}