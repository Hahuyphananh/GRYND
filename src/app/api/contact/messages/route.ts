// src/app/api/contact/messages/route.ts
// GET → the signed-in user's contact messages + admin replies, newest first.
// Messages are matched by the user's account email (looked up from the users
// table by clerk id), so a user can only ever see their own messages.

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { getNeonSql } from "../../../../db/neon";
import { ensureContactTables } from "../../../../lib/contact/ensureTables";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest) {
  const { userId } = await auth();
  if (!userId) {
    // Not signed in — no history to show. 200 with empty list so the client
    // doesn't treat it as an error.
    return NextResponse.json({ success: true, messages: [] });
  }

  try {
    const sql = getNeonSql();
    await ensureContactTables(sql);

    const userRows = await sql`
      SELECT email FROM users WHERE clerk_id = ${userId} LIMIT 1
    ` as any[];
    const email = userRows[0]?.email;
    if (!email) {
      return NextResponse.json({ success: true, messages: [] });
    }

    const messages = await sql`
      SELECT * FROM contact_messages
      WHERE LOWER(email) = LOWER(${email})
      ORDER BY created_at DESC
      LIMIT 50
    ` as any[];

    let replies: any[] = [];
    if (messages.length > 0) {
      const ids = messages.map((m: any) => m.id);
      replies = await sql`
        SELECT * FROM contact_message_replies
        WHERE message_id = ANY(${ids})
        ORDER BY created_at ASC
      ` as any[];
    }

    const repliesByMessage: Record<number, any[]> = {};
    for (const r of replies) {
      (repliesByMessage[r.message_id] ||= []).push(r);
    }

    const result = messages.map((m: any) => ({
      ...m,
      replies: repliesByMessage[m.id] || [],
    }));

    return NextResponse.json({ success: true, messages: result });
  } catch (err) {
    console.error("[api/contact/messages] Error:", err);
    return NextResponse.json(
      { success: false, error: "Failed to load messages." },
      { status: 500 },
    );
  }
}
