import { resend } from "../resend";
import { db } from "../../db/index";
import { emailEvents } from "../../db/schema";
import { and, eq, gte } from "drizzle-orm";

/** Maximum time (ms) to wait for a DB query before skipping it */
const DB_TIMEOUT_MS = 5_000;

/** Race a promise against a timeout — returns null on timeout without rejecting */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  const timer = new Promise<null>((resolve) => setTimeout(() => resolve(null), ms));
  return Promise.race([promise, timer]);
}

/** Resend shared test domain — always works without domain verification.
 *  NOTE: Resend's test domain only delivers to verified identities in the Resend dashboard.
 *  Set RESEND_FROM_EMAIL env var to use a custom verified domain in production. */
const RESEND_TEST_DOMAIN = "onboarding@resend.dev";

/** Returns the from address at call time (reads env var fresh each call). */
export function getFromAddress(): string {
  const custom = process.env.RESEND_FROM_EMAIL?.trim();
  if (custom) {
    return custom.includes("<") ? custom : `GRYND <${custom}>`;
  }
  return `GRYND <${RESEND_TEST_DOMAIN}>`;
}

export const ADMIN_EMAIL = "phananhalbert@gmail.com";

/**
 * HTML-escape a value for safe interpolation into email templates.
 * User-controlled fields (usernames, names, messages) must always be
 * escaped before being embedded in HTML — otherwise a malicious
 * value like `<img src=x onerror=...>` executes in the recipient's
 * mail client.
 */
export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

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
  from,
}: {
  user: UserRef;
  subject: string;
  html: string;
  type: string;
  category?: "marketing" | "transactional" | "security";
  dedupeKey?: string;
  /** Override the default sender address. Defaults to getFromAddress(). */
  from?: string;
}) {
  if (!user?.email) return { skipped: true, reason: "missing_email" };

  // ── DB checks (best-effort, time-limited — never block email delivery) ──────
  try {
    if (dedupeKey) {
      const existing = await withTimeout(
        db.query.emailEvents.findFirst({
          where: and(
            eq(emailEvents.type, type),
            eq(emailEvents.dedupeKey, dedupeKey),
            eq(emailEvents.status, "sent"),
          ),
        }),
        DB_TIMEOUT_MS,
      );
      if (existing) return { skipped: true, reason: "idempotent" };
    }
  } catch (dbErr) {
    console.warn("[sendEmailSafely] Dedupe check failed (non-blocking):", (dbErr as Error).message);
  }

  try {
    if (category === "marketing" && user.clerkId) {
      const last24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const recentMarketing = await withTimeout(
        db.query.emailEvents.findFirst({
          where: and(
            eq(emailEvents.clerkId, user.clerkId),
            eq(emailEvents.category, "marketing"),
            gte(emailEvents.createdAt, last24h),
            eq(emailEvents.status, "sent"),
          ),
        }),
        DB_TIMEOUT_MS,
      );
      if (recentMarketing)
        return { skipped: true, reason: "marketing_rate_limited" };
    }
  } catch (dbErr) {
    console.warn("[sendEmailSafely] Marketing rate-limit check failed (non-blocking):", (dbErr as Error).message);
  }

  // ── Send email (always, regardless of DB state) ───────────────
  let error: { message?: string; name?: string } | null = null;
  try {
    const result = await resend.emails.send({
      from: from ?? getFromAddress(),
      to: user.email,
      subject,
      html,
    });
    error = result.error;
    if (error) {
      console.error("[sendEmailSafely] Resend API returned error:", JSON.stringify(error));
    }
  } catch (sendErr) {
    error = { message: (sendErr as Error).message || "Resend send failed" };
    console.error("[sendEmailSafely] Resend send threw:", sendErr);
  }

  // ── DB event logging (best-effort, non-blocking) ──────────────
  try {
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
  } catch (dbErr) {
    console.warn("[sendEmailSafely] Event logging failed (non-blocking):", (dbErr as Error).message);
  }

  return error ? { skipped: true, reason: "provider_error", details: error.message || JSON.stringify(error) } : { sent: true };
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
  return `<div style="font-family:Inter,Arial,sans-serif;max-width:620px;margin:auto;background:#0f172a;color:#e2e8f0;padding:24px;border-radius:14px"><h1 style="color:#fbbf24">GRYND</h1><h2>${title}</h2><div>${body}</div>${cta}<p style="opacity:.75;margin-top:28px">- GRYND Team</p></div>`;
}
