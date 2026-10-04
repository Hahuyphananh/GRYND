import { Resend } from "resend";
// nodemailer 10 ships its own declarations and exports them BY NAME (its
// default export is a value, not a namespace), so the transporter and options
// types are imported directly rather than reached through `nodemailer.*`.
//
// TYPE-ONLY, and deliberately so: this import is erased at compile time. The
// nodemailer VALUE is loaded lazily inside `getSmtpTransport()` instead — see
// the note there for why a static import is unsafe on Cloudflare Workers.
import type { Transporter, TransportOptions } from "nodemailer";

/**
 * Symbol under which `@opennextjs/cloudflare` publishes the Cloudflare context
 * on `globalThis` in a deployed Worker (the same slot `src/db/pool.ts` reads
 * for Hyperdrive). Its presence means "this code is running on Cloudflare
 * Workers", which is what we branch on to disable SMTP.
 */
const CLOUDFLARE_CONTEXT_SYMBOL = Symbol.for("__cloudflare-context__");

/**
 * True when running inside a Cloudflare Worker.
 *
 * Workers cannot open the raw TCP/TLS sockets that SMTP needs (`node:net` and
 * `node:tls` are not usable for outbound SMTP there), so every SMTP path is
 * skipped and Resend — a plain HTTPS API — becomes the only transport. On
 * Vercel/Node (and in unit tests) the global slot is absent, so this is false
 * and the existing SMTP fallback is untouched.
 */
export function isCloudflareWorkers(): boolean {
  try {
    return Boolean(
      (globalThis as Record<symbol, unknown>)[CLOUDFLARE_CONTEXT_SYMBOL],
    );
  } catch {
    // A malformed/partial global must never break email sending.
    return false;
  }
}

let resendClient: Resend | null = null;
let smtpTransport: Transporter | null = null;

function getResendClient() {
  if (resendClient) return resendClient;
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return null;
  resendClient = new Resend(apiKey);
  return resendClient;
}

async function getSmtpTransport(): Promise<Transporter | null> {
  if (smtpTransport) return smtpTransport;
  // Cloudflare Workers must never take the SMTP path: nodemailer opens a raw
  // TCP/TLS socket on first use, which Workers cannot do. Bailing out before
  // the `await import` below also keeps nodemailer — which eagerly imports
  // `node:net`/`node:tls` at module scope — out of the Worker's module graph
  // entirely. Resend over HTTPS is the only transport there.
  if (isCloudflareWorkers()) return null;
  const host = process.env.SMTP_HOST?.trim();
  if (!host) return null;
  const port = Number(process.env.SMTP_PORT || (process.env.SMTP_SECURE === "true" ? 465 : 587));
  const user = process.env.SMTP_USER?.trim();
  const pass = process.env.SMTP_PASS ?? "";
  // Lazy, on-demand load so the (Node-only) nodemailer module is only pulled
  // in when an SMTP server is actually configured on a non-Worker runtime.
  const { default: nodemailer } = await import("nodemailer");
  smtpTransport = nodemailer.createTransport({
    host,
    port,
    secure: process.env.SMTP_SECURE === "true" || port === 465,
    auth: user ? { user, pass } : undefined,
    connectionOptions: {
      family: Number(process.env.SMTP_FAMILY || "4"),
    },
    tls: process.env.SMTP_TLS_INSECURE === "true" ? { rejectUnauthorized: false } : undefined,
  } as TransportOptions);
  return smtpTransport;
}

function getSmtpFrom(): string {
  const custom = process.env.SMTP_FROM?.trim() || process.env.RESEND_FROM_EMAIL?.trim();
  if (custom) return custom.includes("<") ? custom : `GRYND <${custom}>`;
  return `GRYND <no-reply@${process.env.SMTP_HOST || "localhost"}>`;
}

export const resend = {
  emails: {
    send: async (...args: Parameters<Resend["emails"]["send"]>) => {
      const smtp = await getSmtpTransport();
      if (smtp) {
        try {
          const [opts] = args;
          const info = await smtp.sendMail({
            from: opts.from ?? getSmtpFrom(),
            to: opts.to,
            subject: opts.subject,
            html: opts.html,
            // Propagate custom headers (List-Unsubscribe / -Post, etc.) so the
            // SMTP fallback keeps the same one-click unsubscribe affordance
            // mail clients get from the Resend API path.
            headers: opts.headers,
          });
          return { data: { id: info.messageId }, error: null } as any;
        } catch (err) {
          const message = (err as Error).message || "SMTP send failed";
          console.error("[resend-smtp] SMTP send threw:", message);
          return {
            data: null,
            error: { name: "SmtpError", message },
          } as any;
        }
      }

      const client = getResendClient();
      if (!client) {
        return {
          data: null,
          error: {
            name: "MissingApiKey",
            message: "RESEND_API_KEY is not configured",
          },
        } as any;
      }
      return client.emails.send(...args);
    },
    receiving: {
      get: async (...args: Parameters<Resend["emails"]["receiving"]["get"]>) => {
        const client = getResendClient();
        if (!client) {
          return {
            data: null,
            error: {
              name: "MissingApiKey",
              message: "RESEND_API_KEY is not configured",
            },
          } as any;
        }
        return client.emails.receiving.get(...args);
      },
    },
  },
  webhooks: {
    verify: (...args: Parameters<Resend["webhooks"]["verify"]>) => {
      const client = resendClient ?? new Resend(process.env.RESEND_API_KEY || "missing-api-key");
      return client.webhooks.verify(...args);
    },
  },
};