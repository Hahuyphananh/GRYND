import crypto from "crypto";
import { db } from "../../db";
import {
  emailEvents,
  DEFAULT_NOTIFICATION_PREFS,
  type NotificationPrefs,
} from "../../db/schema";

// ── ONE-CLICK UNSUBSCRIBE ────────────────────────────────────────────────────
// Every marketing email carries an unsubscribe link that works WITHOUT a login
// (the recipient is often reading in a mail client). The link is authorised by
// an HMAC over the recipient's Clerk id, so no token table / expiry bookkeeping
// is needed and a recipient can never unsubscribe someone else.
//
// The same signed URL is used for the RFC 8058 `List-Unsubscribe` header, which
// is what makes Gmail/Apple Mail show their native one-click "Unsubscribe"
// button next to the sender.

/** Marketing preference keys — exactly the ones a full unsubscribe flips off. */
export const MARKETING_PREF_KEYS = Object.keys(
  DEFAULT_NOTIFICATION_PREFS,
) as Array<keyof NotificationPrefs>;

/** All marketing preferences off — the state a full unsubscribe writes. */
export const ALL_MARKETING_OFF: NotificationPrefs = Object.fromEntries(
  MARKETING_PREF_KEYS.map((key) => [key, false]),
) as NotificationPrefs;

/** email_events.type recorded whenever a recipient unsubscribes. */
export const UNSUBSCRIBE_EVENT_TYPE = "unsubscribe";

/** Where an unsubscribe came from — stored on the audit row's meta. */
export type UnsubscribeSource = "email_link" | "one_click" | "settings";

/**
 * Appends a compliance audit row to email_events. Best-effort: an audit-write
 * failure must never block (or fail) the unsubscribe itself, so errors are
 * logged and swallowed. Uses the existing email_events table with
 * type="unsubscribe" / status="unsubscribed" so unsubscribes are queryable
 * alongside the sends they relate to.
 */
export async function recordUnsubscribeEvent({
  clerkId,
  email,
  source,
}: {
  clerkId: string;
  email: string;
  source: UnsubscribeSource;
}): Promise<void> {
  try {
    await db.insert(emailEvents).values({
      clerkId: clerkId ?? null,
      userEmail: email,
      type: UNSUBSCRIBE_EVENT_TYPE,
      category: "marketing",
      status: "unsubscribed",
      meta: { source },
    });
  } catch (err) {
    console.warn(
      "[emails/unsubscribe] Audit event write failed (non-blocking):",
      (err as Error)?.message,
    );
  }
}

let hasWarnedMissingSecret = false;

/**
 * Secret used to sign unsubscribe tokens. Falls back through the same secrets
 * the rest of the app signs with so this works without extra configuration —
 * set EMAIL_UNSUBSCRIBE_SECRET to rotate the link signature independently.
 */
function getSigningSecret(): string {
  const configured =
    process.env.EMAIL_UNSUBSCRIBE_SECRET ||
    process.env.GAME_SESSION_SECRET ||
    process.env.NEXTAUTH_SECRET ||
    process.env.CLERK_SECRET_KEY;

  if (!configured) {
    if (!hasWarnedMissingSecret) {
      console.warn(
        "[emails/unsubscribe] No signing secret configured. Using development fallback secret.",
      );
      hasWarnedMissingSecret = true;
    }
    return "development-only-insecure-secret";
  }

  return configured;
}

function sign(payload: string): string {
  return crypto
    .createHmac("sha256", getSigningSecret())
    .update(`grynd:unsubscribe:${payload}`)
    .digest("base64url");
}

/**
 * Builds the opaque unsubscribe token for a recipient. The payload is the
 * Clerk user id, base64url-encoded so the token stays a single URL-safe string.
 */
export function createUnsubscribeToken(clerkId: string): string {
  const payload = Buffer.from(String(clerkId), "utf8").toString("base64url");
  return `${payload}.${sign(payload)}`;
}

/**
 * Verifies an unsubscribe token and returns the Clerk user id it authorises,
 * or null when the token is missing, malformed or the signature doesn't match.
 */
export function verifyUnsubscribeToken(token: unknown): string | null {
  if (!token || typeof token !== "string" || !token.includes(".")) return null;

  const index = token.lastIndexOf(".");
  const payload = token.slice(0, index);
  const signature = token.slice(index + 1);
  if (!payload || !signature) return null;

  const expected = sign(payload);
  const provided = Buffer.from(signature);
  const wanted = Buffer.from(expected);
  if (provided.length !== wanted.length) return null;
  if (!crypto.timingSafeEqual(provided, wanted)) return null;

  try {
    const clerkId = Buffer.from(payload, "base64url").toString("utf8").trim();
    return clerkId || null;
  } catch {
    return null;
  }
}

// ── Language ────────────────────────────────────────────────────────────────
// The unsubscribe page is server-rendered and opened straight from a mail
// client, so there is no localStorage to read the app's saved language from.
// We honour an explicit ?lang= (when a caller can supply one) and otherwise
// fall back to the browser's Accept-Language header, then to English. The
// list mirrors the languages the app ships (src/lib/appTextTranslations.js).
export const UNSUBSCRIBE_LANGUAGES = ["en", "fr", "es"] as const;

export function resolveUnsubscribeLanguage(
  acceptLanguage: string | null,
  requested?: string | null,
): string {
  const wanted = requested?.trim().toLowerCase().split("-")[0];
  if (wanted && (UNSUBSCRIBE_LANGUAGES as readonly string[]).includes(wanted)) {
    return wanted;
  }

  for (const part of (acceptLanguage ?? "").split(",")) {
    const base = part.trim().toLowerCase().split(";")[0].split("-")[0];
    if (base && (UNSUBSCRIBE_LANGUAGES as readonly string[]).includes(base)) {
      return base;
    }
  }

  return "en";
}

/** Public app URL used to build links for mail clients. */
export function getAppBaseUrl(): string {
  const configured =
    process.env.NEXT_PUBLIC_BASE_URL || process.env.NEXT_PUBLIC_APP_URL;
  return (configured?.trim() || "https://www.grynd.dedyn.io").replace(/\/+$/, "");
}

/** Absolute, signed unsubscribe URL for a recipient. */
export function buildUnsubscribeUrl(clerkId: string): string {
  return `${getAppBaseUrl()}/api/emails/unsubscribe?token=${encodeURIComponent(
    createUnsubscribeToken(clerkId),
  )}`;
}

/** Footer appended to every marketing email (never transactional/security). */
export function buildUnsubscribeFooter(clerkId: string): string {
  const url = buildUnsubscribeUrl(clerkId);
  const settings = `${getAppBaseUrl()}/settings`;
  return (
    `<p style="opacity:.6;font-size:12px;margin-top:24px;border-top:1px solid #1e293b;padding-top:12px">` +
    `You're receiving this because you have a GRYND account. ` +
    `<a href="${url}" style="color:#7dd3fc">Unsubscribe</a> from marketing emails, ` +
    `or manage which emails you get in your ` +
    `<a href="${settings}" style="color:#7dd3fc">notification settings</a>.` +
    `</p>`
  );
}

/**
 * Injects the unsubscribe footer into an already-rendered email body. The
 * footer goes just before the template's closing container so it reads as part
 * of the card; if the wrapper can't be found it is appended instead. Safe to
 * call twice — a body that already carries the footer is returned unchanged.
 */
export function withUnsubscribeFooter(html: string, clerkId: string): string {
  if (!html || html.includes("/api/emails/unsubscribe")) return html;

  const footer = buildUnsubscribeFooter(clerkId);
  const closingIndex = html.lastIndexOf("</div>");
  if (closingIndex === -1) return `${html}${footer}`;
  return `${html.slice(0, closingIndex)}${footer}${html.slice(closingIndex)}`;
}
