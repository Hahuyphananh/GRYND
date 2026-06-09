import { renderTemplate, sendEmailSafely, ADMIN_EMAIL, CONTACT_FORM_FROM } from "./base";

/**
 * Sends a notification to the admin when a user submits the contact form.
 * The admin receives the sender's info and message, from contact@goonbet.dedyn.io.
 */
export async function sendContactFormEmail(params: {
  senderEmail: string;
  senderName?: string;
  message: string;
}) {
  const hourKey = new Date().toISOString().slice(0, 13); // dedupe per sender per hour
  // HTML-escape user input to prevent injection
  const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const safeName = escapeHtml(params.senderName ?? "Anonymous");
  const safeEmail = escapeHtml(params.senderEmail);
  const safeMessage = escapeHtml(params.message);
  const body = `
    <p><strong>From:</strong> ${safeName} (${safeEmail})</p>
    <p><strong>Message:</strong></p>
    <p style="background:#1e293b;padding:16px;border-radius:8px;white-space:pre-wrap;">${safeMessage}</p>
  `;

  return sendEmailSafely({
    user: {
      email: ADMIN_EMAIL,
    },
    type: "contact_form",
    category: "transactional",
    dedupeKey: `contact:${params.senderEmail}:${hourKey}`,
    from: CONTACT_FORM_FROM,
    subject: "New Contact Form Message",
    html: renderTemplate("New Contact Form Message", body),
  });
}
