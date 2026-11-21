import {
  renderTemplate,
  sendEmailSafely,
  ADMIN_EMAIL,
  getFromAddress,
  escapeHtml,
} from "./base";

export type SystemEventType =
  | "bet_placed"
  | "action_completed"
  | "error_event"
  | "system_event";

const EVENT_LABELS: Record<SystemEventType, string> = {
  bet_placed: "Bet Placed",
  action_completed: "Action Completed",
  error_event: "Error Event",
  system_event: "System Event",
};

/**
 * Sends a system notification email to the admin.
 * Triggered by important system events: bets placed, actions completed, errors, etc.
 *
 * EVERY interpolated value is HTML-escaped. description and metadata arrive
 * from a caller (the /api/system/notify route accepts them from the request
 * body) and the recipient is the admin inbox: unescaped markup there is a
 * phishing vector, not just a rendering bug.
 */
export async function sendSystemNotificationEmail(params: {
  eventType: SystemEventType;
  description: string;
  metadata?: Record<string, unknown>;
}) {
  const label = EVENT_LABELS[params.eventType] || params.eventType;
  const metadataBlock = params.metadata
    ? `<p style="font-size:12px;color:#94a3b8;margin-top:16px;"><strong>Metadata:</strong> <pre style="white-space:pre-wrap;font-size:12px;">${escapeHtml(JSON.stringify(params.metadata, null, 2))}</pre></p>`
    : "";

  const body = `
    <p><strong>Event:</strong> ${escapeHtml(label)}</p>
    <p style="background:#1e293b;padding:16px;border-radius:8px;">${escapeHtml(params.description)}</p>
    ${metadataBlock}
  `;

  return sendEmailSafely({
    user: {
      email: ADMIN_EMAIL,
    },
    type: "system_notification",
    category: "transactional",
    from: getFromAddress(),
    subject: `System Notification: ${label}`,
    html: renderTemplate("System Notification", body),
  });
}
