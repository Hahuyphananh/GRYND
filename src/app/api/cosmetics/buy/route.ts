// src/app/api/cosmetics/buy/route.ts
//
// POST /api/cosmetics/buy  { key: string }
//
// Server-authoritative token purchase of a catalog cosmetic. Validates the
// catalog row carries a price and the user can pay; atomically debits the
// balance, writes the `spend` ledger row (reference_type `cosmetic`) and
// inserts the ownership row. All logic lives in src/lib/cosmetics.ts
// (buyCosmetic).

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { buyCosmetic } from "../../../../lib/cosmetics";

export async function POST(req: Request) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json(
        { success: false, error: "Unauthorized" },
        { status: 401 },
      );
    }

    let body: { key?: unknown } = {};
    try {
      body = await req.json();
    } catch {
      body = {};
    }

    const result = await buyCosmetic(userId, body?.key);
    if (result.ok === false) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: result.status ?? 400 },
      );
    }

    return NextResponse.json({
      success: true,
      cosmeticKey: result.cosmeticKey,
      name: result.name,
      balance: result.balance,
    });
  } catch (error) {
    console.error("[POST /api/cosmetics/buy] error:", error);
    return NextResponse.json(
      { success: false, error: "Failed to buy cosmetic" },
      { status: 500 },
    );
  }
}