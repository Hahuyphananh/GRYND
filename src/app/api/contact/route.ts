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
    // Pre-check: Resend API key must be configured
    if (!process.env.RESEND_API_KEY) {
      console.error("[api/contact] RESEND_API_KEY is not configured");
      return NextResponse.json(
        { success: false, error: "Email service is not configured. Please try again later or contact support directly." },
        { status: 503 },
      );
    }

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

    // Basic email format validation
    if (!email.includes("@") || !email.includes(".")) {
      return NextResponse.json(
        { success: false, error: "Please enter a valid email address." },
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
      // Determine appropriate status code based on reason
      const reasonMap: Record<string, { status: number; message: string }> = {
        missing_email: { status: 400, message: "A valid email address is required." },
        idempotent: { status: 429, message: "You've already sent a message recently. Please wait before sending another." },
        marketing_rate_limited: { status: 429, message: "Too many messages. Please try again later." },
        provider_error: { status: 503, message: "The email service is temporarily unavailable. Please try again later or contact support directly." },
      };
      console.error(
        `[api/contact] Email send skipped — reason: ${result.reason}`,
      );
      const mapped = reasonMap[result.reason] || { status: 500, message: "Failed to send message. Please try again later." };
      return NextResponse.json(
        { success: false, error: mapped.message },
        { status: mapped.status },
      );
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("[api/contact] Error:", err);
    return NextResponse.json(
      { success: false, error: "An unexpected error occurred. Please try again later." },
      { status: 500 },
    );
  }
}
