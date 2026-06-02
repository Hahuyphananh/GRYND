import type { WebhookEventPayload } from "resend";

type ResendEmailEventType = WebhookEventPayload["type"];

export const RESEND_OUTBOUND_EMAIL_EVENT_TYPES = [
  "email.sent",
  "email.scheduled",
  "email.delivered",
  "email.delivery_delayed",
  "email.complained",
  "email.bounced",
  "email.opened",
  "email.clicked",
  "email.failed",
  "email.suppressed",
] as const satisfies readonly ResendEmailEventType[];

export type ResendOutboundEmailEvent = Extract<
  WebhookEventPayload,
  { type: (typeof RESEND_OUTBOUND_EMAIL_EVENT_TYPES)[number] }
>;

export function isResendOutboundEmailEvent(
  event: WebhookEventPayload,
): event is ResendOutboundEmailEvent {
  return RESEND_OUTBOUND_EMAIL_EVENT_TYPES.includes(
    event.type as (typeof RESEND_OUTBOUND_EMAIL_EVENT_TYPES)[number],
  );
}

export function getOutboundEmailEventSummary(event: ResendOutboundEmailEvent) {
  return {
    type: event.type,
    emailId: event.data.email_id,
    from: event.data.from,
    to: event.data.to,
    subject: event.data.subject,
    createdAt: event.created_at,
    emailCreatedAt: event.data.created_at,
    broadcastId: event.data.broadcast_id ?? null,
    templateId: event.data.template_id ?? null,
    tags: event.data.tags ?? null,
  };
}
