// src/app/api/contact/route.ts
// POST → store a contact form submission in the database.
// Messages are surfaced to admins in the admin dashboard's Messages tab via
// GET /api/admin/contact-messages. No email is sent and no third-party
// transactional email service is involved.

import { NextRequest, NextResponse } from "next/server";
import { getNeonSql } from "../../../db/neon";
import { ensureContactTables } from "../../../lib/contact/ensureTables";
import { sendContactNotificationEmail } from "../../../lib/emails/contact";
import { notifyAdmins } from "../../../lib/adminNotify";
import { parseAndValidateJson } from "../../../lib/security/validation";
import { encryptField } from "../../../lib/security/fieldEncryption";

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
    // Strict allowlist: only email / name / message may be sent. Any other
    // field (userId, isAdmin, messageId, ...) is rejected, not ignored.
    const parsed = await parseAndValidateJson(request, {
      email: {
        type: "string",
        required: true,
        maxLength: 254,
        pattern: EMAIL_REGEX,
      },
      name: { type: "string", required: false, maxLength: 120, default: null },
      message: { type: "string", required: true, minLength: 1, maxLength: 5000 },
    });
    if (!parsed.ok) return parsed.response;

    const email = parsed.data.email;
    const name = parsed.data.name;
    const message = parsed.data.message;

    const sql = getNeonSql();
    await ensureContactTables(sql);

    // The free-text message is encrypted at rest (AES-256-GCM) — a raw DB
    // dump exposes no message content. email/name stay plaintext because the
    // admin inbox and reply routing need them.
    await sql`
      INSERT INTO contact_messages (name, email, message)
      VALUES (${name}, ${email}, ${encryptField(message)})
    `;

    // Notify the admin inbox (best-effort — the message is already stored,
    // so an email failure must not fail the user's submission).
    sendContactNotificationEmail({
      name,
      email,
      message,
    }).catch((err) => {
      console.error("[api/contact] admin notification failed:", err);
    });

    // Live admin inbox notification via the realtime server (best-effort,
    // same fire-and-forget treatment as the email).
    notifyAdmins({ type: "message" }).catch((err) => {
      console.error("[api/contact] realtime admin notification failed:", err);
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("[api/contact] Error:", err);
    return NextResponse.json(
      { success: false, error: "An unexpected error occurred. Please try again later." },
      { status: 500 },
    );
  }
}
