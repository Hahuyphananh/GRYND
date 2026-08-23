import { renderTemplate, sendEmailSafely, ADMIN_EMAIL, getFromAddress, escapeHtml } from "./base";

/**
 * Notifies the admin inbox when a user submits the contact form.
 * The message itself is stored in contact_messages (admin dashboard); this
 * email exists so nobody has to remember to check the dashboard. Best-effort
 * — a failure here must never break the contact form's success path.
 */
export async function sendContactNotificationEmail(params: {
  name?: string | null;
  email: string;
  message: string;
}) {
  const name = escapeHtml(params.name ?? "Anonymous");
  const email = escapeHtml(params.email);
  const message = escapeHtml(params.message);

  const body = `
    <p><strong>From:</strong> ${name} &lt;${email}&gt;</p>
    <p style="background:#1e293b;padding:16px;border-radius:8px;white-space:pre-wrap;">${message}</p>
    <p style="font-size:12px;color:#94a3b8;">Reply to the user directly at the address above, or use the Messages tab in the admin dashboard.</p>
  `;

  return sendEmailSafely({
    user: { email: ADMIN_EMAIL },
    type: "contact_message",
    category: "transactional",
    from: getFromAddress(),
    subject: `New contact message from ${name}`,
    html: renderTemplate("New Contact Message", body),
  });
}
