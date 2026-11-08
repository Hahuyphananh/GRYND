import { resend } from "../../../../lib/resend";
import { db } from "../../../../db";
import { emailEvents } from "../../../../db/schema";
import { getFromAddress } from "../../../../lib/emails/base";
import { verifyCronRequest } from "../../../../lib/security/cronAuth";

// POST /api/email/test — Sends a verification test email via Resend.
// Use this endpoint to validate backend email sending is configured correctly.
//
// Sending mail is a side effect with a real cost, so it is authenticated like
// every other job: an anonymous caller used to be able to trigger an email to
// the hard-coded address on every request, which burns the Resend quota and
// fills the inbox. Fail-secure when CRON_SECRET is unset.
export async function POST(request: Request) {
  const authError = verifyCronRequest(request);
  if (authError) return authError;

  const to = "huyphananhha@gmail.com";

  const { data, error } = await resend.emails.send({
    from: getFromAddress(),
    to,
    subject: "System Test",
    html: "<p>This is a backend verification test for automatic email sending.</p>",
  });

  // Log the event for audit/dedup tracking
  try {
    await db.insert(emailEvents).values({
      clerkId: null,
      userEmail: to,
      type: "test_email",
      category: "transactional",
      status: error ? "failed" : "sent",
      meta: { subject: "System Test", err: error?.message ?? null },
    });
  } catch {
    // Non-critical — don't fail the request if DB logging fails
  }

  if (error) {
    return Response.json({ error }, { status: 500 });
  }

  return Response.json({ success: true, data });
}

// A state-changing GET can be triggered by an <img> tag or a link preview, so
// the backwards-compatible GET is gone; callers must POST with the secret.
export async function GET() {
  return Response.json(
    { error: "Method Not Allowed" },
    { status: 405, headers: { Allow: "POST" } },
  );
}
