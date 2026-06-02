import { NextRequest, NextResponse } from "next/server";
import { sendContactFormEmail } from "../../../lib/emails/contact";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/contact — User submits the contact form.
 * Sends the message to the admin via Resend.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { email, name, message } = body;

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

    if (message.length > 5000) {
      return NextResponse.json(
        { success: false, error: "Message too long (max 5000 characters)." },
        { status: 400 },
      );
    }

    const result = await sendContactFormEmail({
      senderEmail: email.trim(),
      senderName: name?.trim(),
      message: message.trim(),
    });

    if ("skipped" in result) {
      return NextResponse.json(
        { success: false, error: `Email could not be sent: ${result.reason}` },
        { status: 500 },
      );
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("[api/contact] Error:", err);
    return NextResponse.json(
      { success: false, error: "Internal server error." },
      { status: 500 },
    );
  }
}
