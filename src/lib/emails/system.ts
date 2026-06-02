import { renderTemplate, sendEmailSafely, ADMIN_EMAIL, CONTACT_FORM_FROM } from "./base";

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
 */
export async function sendSystemNotificationEmail(params: {
  eventType: SystemEventType;
  description: string;
  metadata?: Record<string, unknown>;
}) {
  const label = EVENT_LABELS[params.eventType] || params.eventType;
  const metadataBlock = params.metadata
    ? `<p style="font-size:12px;color:#94a3b8;margin-top:16px;"><strong>Metadata:</strong> <pre style="white-space:pre-wrap;font-size:12px;">${JSON.stringify(params.metadata, null, 2)}</pre></p>`
    : "";

  const body = `
    <p><strong>Event:</strong> ${label}</p>
    <p style="background:#1e293b;padding:16px;border-radius:8px;">${params.description}</p>
    ${metadataBlock}
  `;

  return sendEmailSafely({
    user: {
      email: ADMIN_EMAIL,
    },
    type: "system_notification",
    category: "transactional",
    from: CONTACT_FORM_FROM,
    subject: `System Notification — ${label}`,
    html: renderTemplate("System Notification", body),
  });
}
