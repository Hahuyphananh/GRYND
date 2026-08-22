// src/app/api/contact/route.ts
// POST → store a contact form submission in the database.
// Messages are surfaced to admins in the admin dashboard's Messages tab via
// GET /api/admin/contact-messages. No email is sent and no third-party
// transactional email service is involved.

import { NextRequest, NextResponse } from "next/server";
import { getNeonSql } from "../../../db/neon";
import { ensureContactTables } from "../../../lib/contact/ensureTables";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Strict real-email check: requires a local part, an @, and a dotted domain
// (e.g. name@example.com). Same rule the client enforces before submitting.
const EMAIL_REGEX = /^[^\s@"<>]+@[^\s@"<>]+\.[^\s@"<>]+$/;

/**
 * POST /api/contact — User submits the contact form.
 * Validates the input and stores the message in contact_messages so admins
 * can read it in the admin dashboard. The user's email is stored so the
 * admin can reply to them.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => null);
    const { email, name, message } = body ?? {};

    if (!email || !message) {
      return NextResponse.json(
        { success: false, error: "Email and message are required." },
        { status: 400 },
      );
    }

    if (typeof email !== "string" || typeof message !== "string") {
      return NextResponse.json(
        { success: false, error: "Invalid field types." },
        { status: 400 },
      );
    }

    // Basic email format validation — must be a real-looking address (name@domain.tld)
    if (!EMAIL_REGEX.test(email.trim())) {
      return NextResponse.json(
        { success: false, error: "Please enter a valid email address (e.g. name@example.com)." },
        { status: 400 },
      );
    }

    if (message.trim().length > 5000) {
      return NextResponse.json(
        { success: false, error: "Message too long (max 5000 characters)." },
        { status: 400 },
      );
    }

    const sql = getNeonSql();
    await ensureContactTables(sql);

    await sql`
      INSERT INTO contact_messages (name, email, message)
      VALUES (${name?.trim() || null}, ${email.trim()}, ${message.trim()})
    `;

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("[api/contact] Error:", err);
    return NextResponse.json(
      { success: false, error: "An unexpected error occurred. Please try again later." },
      { status: 500 },
    );
  }
}
