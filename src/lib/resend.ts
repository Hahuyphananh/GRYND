import { Resend } from "resend";
import nodemailer from "nodemailer";

let resendClient: Resend | null = null;
let smtpTransport: nodemailer.Transporter | null = null;

function getResendClient() {
  if (resendClient) return resendClient;
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return null;
  resendClient = new Resend(apiKey);
  return resendClient;
}

function getSmtpTransport() {
  if (smtpTransport) return smtpTransport;
  const host = process.env.SMTP_HOST?.trim();
  if (!host) return null;
  const port = Number(process.env.SMTP_PORT || (process.env.SMTP_SECURE === "true" ? 465 : 587));
  const user = process.env.SMTP_USER?.trim();
  const pass = process.env.SMTP_PASS ?? "";
  smtpTransport = nodemailer.createTransport({
    host,
    port,
    secure: process.env.SMTP_SECURE === "true" || port === 465,
    auth: user ? { user, pass } : undefined,
    connectionOptions: {
      family: Number(process.env.SMTP_FAMILY || "4"),
    },
    tls: process.env.SMTP_TLS_INSECURE === "true" ? { rejectUnauthorized: false } : undefined,
  } as nodemailer.TransportOptions);
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
      const smtp = getSmtpTransport();
      if (smtp) {
        try {
          const [opts] = args;
          const info = await smtp.sendMail({
            from: opts.from ?? getSmtpFrom(),
            to: opts.to,
            subject: opts.subject,
            html: opts.html,
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