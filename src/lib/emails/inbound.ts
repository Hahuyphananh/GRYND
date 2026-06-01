import type { GetReceivingEmailResponseSuccess, WebhookEventPayload } from "resend";
import { resend } from "../resend";

type EmailReceivedEvent = Extract<WebhookEventPayload, { type: "email.received" }>;

export type InboundEmailProcessingResult = {
  event: EmailReceivedEvent;
  content: GetReceivingEmailResponseSuccess | null;
  contentError: string | null;
  routedTo: string[];
};

function extractMailbox(address: string) {
  return address.split("@")[0]?.toLowerCase() || address.toLowerCase();
}

export function getInboundEmailRoutes(recipients: string[]) {
  return [...new Set(recipients.map(extractMailbox).filter(Boolean))];
}

export async function processInboundEmailEvent(
  event: EmailReceivedEvent,
): Promise<InboundEmailProcessingResult> {
  const routedTo = getInboundEmailRoutes(event.data.to);
  const receivedEmail = await resend.emails.receiving.get(event.data.email_id);

  if (receivedEmail.error) {
    return {
      event,
      content: null,
      contentError: receivedEmail.error.message,
      routedTo,
    };
  }

  return {
    event,
    content: receivedEmail.data,
    contentError: null,
    routedTo,
  };
}
