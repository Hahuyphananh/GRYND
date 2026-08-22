// src/app/api/admin/contact-messages/route.ts
// GET    → list contact form messages + their admin replies (Messages tab)
// POST   → reply to a message (stores the reply, marks the message "replied")
// PATCH  → mark a message as new / resolved / replied manually
// DELETE → delete a message and its replies

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { isAdmin } from "../../../../lib/auth/isAdmin";
import { getNeonSql } from "../../../../db/neon";
import { ensureContactTables } from "../../../../lib/contact/ensureTables";

const MAX_REPLY_LENGTH = 5000;

export async function GET(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  if (!(await isAdmin(userId))) {
    return NextResponse.json({ success: false, error: "Forbidden" }, { status: 403 });
  }

  const statusFilter = req.nextUrl.searchParams.get("status") || "";
  // Guard against a non-numeric limit param — parseInt("abc") is NaN and
  // Math.min(NaN, 200) stays NaN, which made Postgres throw on `LIMIT NaN`.
  const rawLimit = parseInt(req.nextUrl.searchParams.get("limit") || "100", 10);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.min(rawLimit, 200)
    : 100;

  try {
    const sql = getNeonSql();
    await ensureContactTables(sql);

    const validStatuses = ["new", "replied", "resolved"];
    let messages: any[];
    if (validStatuses.includes(statusFilter)) {
      messages = await sql`
        SELECT * FROM contact_messages
        WHERE status = ${statusFilter}
        ORDER BY created_at DESC
        LIMIT ${limit}
      ` as any[];
    } else {
      messages = await sql`
        SELECT * FROM contact_messages
        ORDER BY created_at DESC
        LIMIT ${limit}
      ` as any[];
    }

    // Attach replies (oldest first) for the returned messages.
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

    const withReplies = messages.map((m: any) => ({
      ...m,
      replies: repliesByMessage[m.id] || [],
    }));

    return NextResponse.json({ success: true, messages: withReplies });
  } catch (err: any) {
    console.error("[admin/contact-messages] Failed:", err);
    return NextResponse.json(
      { success: false, error: "Failed to fetch messages" },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  if (!(await isAdmin(userId))) {
    return NextResponse.json({ success: false, error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  if (!body) {
    return NextResponse.json({ success: false, error: "Invalid request body" }, { status: 400 });
  }

  const { messageId, reply } = body as { messageId: number; reply: string };

  if (!messageId || !reply || typeof reply !== "string") {
    return NextResponse.json(
      { success: false, error: "Missing required fields: messageId, reply" },
      { status: 400 },
    );
  }

  if (reply.trim().length === 0) {
    return NextResponse.json(
      { success: false, error: "Reply cannot be empty." },
      { status: 400 },
    );
  }

  if (reply.trim().length > MAX_REPLY_LENGTH) {
    return NextResponse.json(
      { success: false, error: "Reply too long (max " + MAX_REPLY_LENGTH + " characters)." },
      { status: 400 },
    );
  }

  try {
    const sql = getNeonSql();
    await ensureContactTables(sql);

    // The message must exist.
    const existing = await sql`
      SELECT id FROM contact_messages WHERE id = ${messageId} LIMIT 1
    ` as any[];
    if (existing.length === 0) {
      return NextResponse.json(
        { success: false, error: "Message not found." },
        { status: 404 },
      );
    }

    // Record who replied: the admin's username from the users table.
    const adminRows = await sql`
      SELECT name FROM users WHERE clerk_id = ${userId} LIMIT 1
    ` as any[];
    const adminName = adminRows[0]?.name || "Admin";

    await sql`
      INSERT INTO contact_message_replies (message_id, admin_clerk_id, admin_name, reply)
      VALUES (${messageId}, ${userId}, ${adminName}, ${reply.trim()})
    `;

    // A replied message is no longer "new" — mark it replied.
    await sql`
      UPDATE contact_messages
      SET status = 'replied',
          resolved_at = NOW()
      WHERE id = ${messageId}
    `;

    return NextResponse.json({
      success: true,
      message: "Reply sent",
      reply: {
        admin_name: adminName,
        admin_clerk_id: userId,
        reply: reply.trim(),
        created_at: new Date().toISOString(),
      },
    });
  } catch (err: any) {
    console.error("[admin/contact-messages] POST failed:", err);
    return NextResponse.json(
      { success: false, error: "Failed to send reply" },
      { status: 500 },
    );
  }
}

export async function PATCH(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  if (!(await isAdmin(userId))) {
    return NextResponse.json({ success: false, error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  if (!body) {
    return NextResponse.json({ success: false, error: "Invalid request body" }, { status: 400 });
  }

  const { messageId, status } = body as { messageId: number; status: string };

  if (!messageId || !status) {
    return NextResponse.json(
      { success: false, error: "Missing required fields: messageId, status" },
      { status: 400 },
    );
  }

  const validStatuses = ["new", "replied", "resolved"];
  if (!validStatuses.includes(status)) {
    return NextResponse.json(
      { success: false, error: "Invalid status. Must be one of: " + validStatuses.join(", ") },
      { status: 400 },
    );
  }

  try {
    const sql = getNeonSql();

    if (status === "new") {
      await sql`
        UPDATE contact_messages
        SET status = 'new',
            resolved_at = NULL
        WHERE id = ${messageId}
      `;
    } else {
      await sql`
        UPDATE contact_messages
        SET status = ${status},
            resolved_at = NOW()
        WHERE id = ${messageId}
      `;
    }

    return NextResponse.json({ success: true, message: "Message updated successfully" });
  } catch (err: any) {
    console.error("[admin/contact-messages] PATCH failed:", err);
    return NextResponse.json(
      { success: false, error: "Failed to update message" },
      { status: 500 },
    );
  }
}

export async function DELETE(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  if (!(await isAdmin(userId))) {
    return NextResponse.json({ success: false, error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  if (!body) {
    return NextResponse.json({ success: false, error: "Invalid request body" }, { status: 400 });
  }

  const { messageId } = body as { messageId: number };

  if (!messageId) {
    return NextResponse.json(
      { success: false, error: "Missing required field: messageId" },
      { status: 400 },
    );
  }

  try {
    const sql = getNeonSql();

    // The FK on contact_message_replies (ON DELETE CASCADE) removes replies;
    // the explicit DELETE below is belt-and-braces for older tables that
    // predate the FK.
    await sql`
      DELETE FROM contact_message_replies WHERE message_id = ${messageId}
    `;
    await sql`
      DELETE FROM contact_messages WHERE id = ${messageId}
    `;

    return NextResponse.json({ success: true, message: "Message deleted" });
  } catch (err: any) {
    console.error("[admin/contact-messages] DELETE failed:", err);
    return NextResponse.json(
      { success: false, error: "Failed to delete message" },
      { status: 500 },
    );
  }
}
