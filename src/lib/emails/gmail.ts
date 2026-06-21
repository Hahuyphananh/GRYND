import nodemailer from "nodemailer";
import { db } from "../../db/index";
import { emailEvents } from "../../db/schema";
import { and, eq } from "drizzle-orm";

/** Maximum time (ms) to wait for a DB query before skipping it */
const DB_TIMEOUT_MS = 5_000;

/** Race a promise against a timeout — returns null on timeout without rejecting */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  const timer = new Promise<null>((resolve) => setTimeout(() => resolve(null), ms));
  return Promise.race([promise, timer]);
}

let transporter: nodemailer.Transporter | null = null;

/**
 * Build (lazily) and cache a Nodemailer SMTP transport for Gmail.
 * Returns null when GMAIL_USER / GMAIL_APP_PASSWORD are missing.
 *
 * Required env:
 *   - GMAIL_USER           e.g. "phananhalbert@gmail.com"
 *   - GMAIL_APP_PASSWORD   16-char app password from myaccount.google.com
 */
function getGmailTransport() {
  if (transporter) return transporter;
  const user = process.env.GMAIL_USER?.trim();
  const pass = process.env.GMAIL_APP_PASSWORD?.trim();
  if (!user || !pass) return null;
  transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    // Fail fast on stalled SMTP connections instead of hanging the route.
    connectionTimeout: 10_000,
    socketTimeout: 15_000,
    auth: { user, pass },
    tls: { minVersion: "TLSv1.2" },
  });
  return transporter;
}

export function getGmailFromAddress(): string | null {
  return process.env.GMAIL_USER?.trim() || null;
}

export function isGmailConfigured(): boolean {
  return Boolean(
    process.env.GMAIL_USER?.trim() && process.env.GMAIL_APP_PASSWORD?.trim()
  );
}

/**
 * Strict email regex for header safety (e.g. Reply-To).
 * Whitespace / quotes / angle brackets are not allowed because they
 * could conflate with CRLF / quoting abuse of an SMTP header.
 * HTML body escaping is the responsibility of callers.
 */
const EMAIL_REGEX = /^[^\s@"<>]+@[^\s@"<>]+\.[^\s@"<>]+$/;

/**
 * Send a transactional email via Gmail SMTP.
 * Mirrors the dedupe / event-logging shape of sendEmailSafely (Resend) but
 * does NOT require a Resend API key — uses Gmail's SMTP with an app password.
 */
export async function sendContactGmail({
  to,
  subject,
  html,
  type,
  dedupeKey,
  replyTo,
}: {
  to: string;
  subject: string;
  html: string;
  type: string;
  dedupeKey?: string;
  replyTo?: string | null;
}) {
  if (!isGmailConfigured()) {
    return {
      skipped: true,
      reason: "not_configured",
      details:
        "Gmail SMTP is not configured. Set GMAIL_USER and GMAIL_APP_PASSWORD env vars.",
    };
  }

  // Per-sender dedupe (best-effort, time-limited — never block sending)
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
    console.warn(
      "[sendContactGmail] Dedupe check failed (non-blocking):",
      (dbErr as Error).message
    );
  }

  // Send mail via Gmail SMTP
  const transport = getGmailTransport();
  if (!transport) {
    // Race-y fallback: config validation passed above but transport is null.
    return {
      skipped: true,
      reason: "not_configured",
      details: "Gmail transport could not be initialized.",
    };
  }

  const fromAddress = getGmailFromAddress()!;
  let error: string | null = null;
  try {
    await transport.sendMail({
      from: fromAddress,
      to,
      subject,
      html,
      // Only set Reply-To if it matches a strict email regex.
      replyTo: replyTo && EMAIL_REGEX.test(replyTo) ? replyTo : undefined,
    });
  } catch (sendErr) {
    error = (sendErr as Error).message || String(sendErr);
    console.error("[sendContactGmail] Gmail SMTP send failed:", sendErr);
  }

  // Event logging (best-effort, non-blocking)
  try {
    await db.insert(emailEvents).values({
      userEmail: to,
      type,
      category: "transactional",
      dedupeKey: dedupeKey ?? null,
      status: error ? "failed" : "sent",
      meta: {
        subject,
        err: error,
        transport: "gmail-smtp",
        from: fromAddress,
        replyTo: replyTo && EMAIL_REGEX.test(replyTo) ? replyTo : null,
      },
    });
  } catch (dbErr) {
    console.warn(
      "[sendContactGmail] Event logging failed (non-blocking):",
      (dbErr as Error).message
    );
  }

  return error
    ? { skipped: true, reason: "provider_error", details: error }
    : { sent: true };
}
