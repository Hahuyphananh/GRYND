import { renderTemplate } from "./base";
import { sendContactGmail } from "./gmail";

/**
 * Destination email for contact form submissions.
 * Matches the contact email advertised on /contact and in the privacy policy footer
 * (src/app/privacy-policy/page.jsx and src/app/contact/page.jsx).
 * Can be overridden by the CONTACT_TO env var.
 */
const CONTACT_FORM_RECIPIENT = "contact@goonbet.dedyn.io";

/**
 * Sends a notification to the admin when a user submits the contact form.
 *
 * Uses Gmail SMTP directly — no third-party transactional email service
 * (no Resend). The From address is the authenticated Gmail user (e.g.
 * phananhalbert@gmail.com). The To address is the dedyn.io contact mailbox
 * which is forwarded to the admin's Gmail, so the message lands in the same
 * inbox. Reply-To is set to the form-submitter's email so the admin can hit
 * "Reply" and it goes to the actual user.
 */
export async function sendContactFormEmail(params: {
  senderEmail: string;
  senderName?: string;
  message: string;
}) {
  const hourKey = new Date().toISOString().slice(0, 13); // dedupe per sender per hour
  // HTML-escape user input to prevent injection in the rendered email body.
  const escapeHtml = (s: string) =>
    s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  const safeName = escapeHtml(params.senderName ?? "Anonymous");
  const safeEmail = escapeHtml(params.senderEmail);
  const safeMessage = escapeHtml(params.message);
  const body = `
    <p><strong>From:</strong> ${safeName} (${safeEmail})</p>
    <p><strong>Message:</strong></p>
    <p style="background:#1e293b;padding:16px;border-radius:8px;white-space:pre-wrap;">${safeMessage}</p>
  `;

  // Resolve destination with a basic sanity check so a typo in CONTACT_TO
  // doesn't produce a generic 503 at the SMTP layer.
  const rawTo = process.env.CONTACT_TO?.trim();
  const looksLikeEmail = (s: string) => /^[^\s@"<>]+@[^\s@"<>]+\.[^\s@"<>]+$/.test(s);
  const to = rawTo && looksLikeEmail(rawTo) ? rawTo : CONTACT_FORM_RECIPIENT;

  return sendContactGmail({
    to,
    type: "contact_form",
    dedupeKey: `contact:${params.senderEmail}:${hourKey}`,
    subject: "New Contact Form Message",
    // Send the original sender's address back as Reply-To so the admin can
    // reply directly. The helper validates it with a strict regex; if it
    // doesn't pass, Reply-To is omitted (the body still includes the email).
    replyTo: params.senderEmail,
    html: renderTemplate("New Contact Form Message", body),
  });
}
