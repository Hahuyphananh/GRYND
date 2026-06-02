import { resend } from "../../../../lib/resend";
import { db } from "../../../../db";
import { emailEvents } from "../../../../db/schema";

// POST /api/email/test — Sends a verification test email via Resend.
// Use this endpoint to validate backend email sending is configured correctly.
export async function POST() {
  const to = "huyphananhha@gmail.com";

  const { data, error } = await resend.emails.send({
    from: "GoonBet <noreply@mail.goonbet.dedyn.io>",
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

// Keep GET for backwards compatibility
export async function GET() {
  return POST();
}
