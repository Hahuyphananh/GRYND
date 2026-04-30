import { NextResponse } from "next/server";

const body = { success: false, deprecated: true, message: "Tanks has been replaced by Dice Duel Arena. Use /casino/dice-duel and /api/dice-duel/* endpoints." };

export async function GET() { return NextResponse.json(body, { status: 410 }); }
export async function POST() { return NextResponse.json(body, { status: 410 }); }
