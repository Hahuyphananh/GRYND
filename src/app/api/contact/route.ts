import { NextRequest, NextResponse } from "next/server";
import { sendContactFormEmail } from "../../../lib/emails/contact";
import { isGmailConfigured, getGmailFromAddress } from "../../../lib/emails/gmail";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/contact — Diagnostic endpoint: reports Gmail SMTP configuration.
 * Returns whether GMAIL_USER + GMAIL_APP_PASSWORD are set, and what From
 * address will be used to send the message.
 */
export async function GET() {
  const configured = isGmailConfigured();
  const fromAddress = getGmailFromAddress();
  // Redact the local part of the email to discourage enumeration from this
  // auth-free endpoint while still letting the operator see what is wired up.
  const redactedFrom = fromAddress
    ? fromAddress.replace(/^(.{1,3}).*?(@.*)$/, "$1***$2")
    : null;

  return NextResponse.json({
    transport: "gmail-smtp",
    configured,
    fromAddress: redactedFrom,
    help: !configured
      ? "Gmail SMTP not configured. Set GMAIL_USER and GMAIL_APP_PASSWORD env vars (GMAIL_APP_PASSWORD is a 16-char app password from myaccount.google.com)."
      : null,
  });
}

/**
 * POST /api/contact — User submits the contact form.
 * Sends the message via Gmail SMTP to contact@grynd.dedyn.io (which the
 * dedyn.io forwarder routes to the admin's Gmail inbox). The Reply-To
 * header is set to the form-submitter's email so the admin can reply
 * directly. No third-party transactional email service is used.
 */
export async function POST(request: NextRequest) {
  try {
    // Pre-check: Gmail SMTP must be configured
    if (!isGmailConfigured()) {
      console.error("[api/contact] Gmail SMTP is not configured (missing GMAIL_USER or GMAIL_APP_PASSWORD)");
      return NextResponse.json(
        { success: false, error: "Email service is not configured. Please try again later or contact support directly." },
        { status: 503 },
      );
    }

    // Redact the From address before logging — same form as the GET diagnostic.
    const _fromAddr = getGmailFromAddress();
    const _loggedFrom = _fromAddr
      ? _fromAddr.replace(/^(.{1,3}).*?(@.*)$/, "$1***$2")
      : null;
    console.log("[api/contact] Sending via Gmail SMTP from:", _loggedFrom);

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
        not_configured: { status: 503, message: "Email service is not configured. Please try again later." },
        provider_error: { status: 503, message: "The email service is temporarily unavailable. Please try again later or contact support directly." },
      };
      const details = "details" in result ? (result as any).details : "";
      console.error(
        `[api/contact] Email send skipped — reason: ${result.reason}`,
        details ? `details: ${details}` : "",
      );
      const mapped = reasonMap[result.reason] || { status: 500, message: "Failed to send message. Please try again later." };
      // Include provider error details so the client can show specific info
      const extra: Record<string, unknown> = {};
      if (result.reason === "provider_error" && details) {
        extra.providerError = details;
      }
      return NextResponse.json(
        { success: false, error: mapped.message, ...extra },
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
