import { NextResponse } from 'next/server';
export async function GET() { return NextResponse.json({ ok: true, lobbies: [] }); }
export async function POST(req: Request) { const body = await req.json().catch(() => ({})); return NextResponse.json({ ok: true, ...body, lobbyId: body?.lobbyId || crypto.randomUUID() }); }
