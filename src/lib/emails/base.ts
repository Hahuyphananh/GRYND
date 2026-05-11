import { resend } from "../resend";
import { db } from "../../db/index";
import { emailEvents } from "../../db/schema";
import { and, eq, gte } from "drizzle-orm";

export const EMAIL_FROM = "GoonBet <noreply@mail.goonbet.dedyn.io>";

type UserRef = {
  id?: number;
  clerkId?: string;
  email: string;
  username?: string;
  name?: string;
};

export async function sendEmailSafely({
  user,
  subject,
  html,
  type,
  category = "marketing",
  dedupeKey,
}: {
  user: UserRef;
  subject: string;
  html: string;
  type: string;
  category?: "marketing" | "transactional" | "security";
  dedupeKey?: string;
}) {
  try {
    if (!user?.email) return { skipped: true, reason: "missing_email" };
    if (dedupeKey) {
      const existing = await db.query.emailEvents.findFirst({
        where: and(
          eq(emailEvents.type, type),
          eq(emailEvents.dedupeKey, dedupeKey),
          eq(emailEvents.status, "sent"),
        ),
      });
      if (existing) return { skipped: true, reason: "idempotent" };
    }
    if (category === "marketing" && user.clerkId) {
      const last24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const recentMarketing = await db.query.emailEvents.findFirst({
        where: and(
          eq(emailEvents.clerkId, user.clerkId),
          eq(emailEvents.category, "marketing"),
          gte(emailEvents.createdAt, last24h),
          eq(emailEvents.status, "sent"),
        ),
      });
      if (recentMarketing)
        return { skipped: true, reason: "marketing_rate_limited" };
    }

    const { error } = await resend.emails.send({
      from: EMAIL_FROM,
      to: user.email,
      subject,
      html,
    });
    await db
      .insert(emailEvents)
      .values({
        clerkId: user.clerkId ?? null,
        userEmail: user.email,
        type,
        category,
        dedupeKey: dedupeKey ?? null,
        status: error ? "failed" : "sent",
        meta: { subject, err: error?.message ?? null },
      });
    return error ? { skipped: true, reason: "provider_error" } : { sent: true };
  } catch {
    return { skipped: true, reason: "silent_failure" };
  }
}

export function renderTemplate(
  title: string,
  body: string,
  ctaLabel?: string,
  ctaUrl?: string,
) {
  const cta =
    ctaLabel && ctaUrl
      ? `<p style="margin-top:24px"><a href="${ctaUrl}" style="background:#10b981;color:#fff;padding:12px 18px;border-radius:8px;text-decoration:none;">${ctaLabel}</a></p>`
      : "";
  return `<div style="font-family:Inter,Arial,sans-serif;max-width:620px;margin:auto;background:#0f172a;color:#e2e8f0;padding:24px;border-radius:14px"><h1 style="color:#fbbf24">GoonBet Casino</h1><h2>${title}</h2><div>${body}</div>${cta}<p style="opacity:.75;margin-top:28px">— GoonBet Team</p></div>`;
}
