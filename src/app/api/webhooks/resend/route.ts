import type { NextRequest } from "next/server";
import type { WebhookEventPayload } from "resend";
import { NextResponse } from "next/server";
import { processInboundEmailEvent } from "../../../../lib/emails/inbound";
import {
  getOutboundEmailEventSummary,
  isResendOutboundEmailEvent,
} from "../../../../lib/emails/outboundEvents";
import { resend } from "../../../../lib/resend";
import { auditLog } from "../../../../lib/security/auditLog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type VerifiedResendWebhook = {
  event: WebhookEventPayload;
  svixId: string;
};

function getRequiredHeader(request: NextRequest, name: string) {
  return request.headers.get(name) || request.headers.get(name.toLowerCase());
}

async function verifyResendWebhook(request: NextRequest): Promise<VerifiedResendWebhook> {
  const webhookSecret = process.env.RESEND_WEBHOOK_SECRET;

  if (!webhookSecret) {
    throw new Error("RESEND_WEBHOOK_SECRET is not configured.");
  }

  const svixId = getRequiredHeader(request, "svix-id");
  const svixTimestamp = getRequiredHeader(request, "svix-timestamp");
  const svixSignature = getRequiredHeader(request, "svix-signature");

  if (!svixId || !svixTimestamp || !svixSignature) {
    throw new Error("Missing Resend webhook verification headers.");
  }

  const payload = await request.text();
  const event = resend.webhooks.verify({
    payload,
    headers: {
      id: svixId,
      timestamp: svixTimestamp,
      signature: svixSignature,
    },
    webhookSecret,
  }) as WebhookEventPayload;

  return { event, svixId };
}

export async function POST(request: NextRequest) {
  let verifiedWebhook: VerifiedResendWebhook;

  try {
    verifiedWebhook = await verifyResendWebhook(request);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown verification error";

    if (message === "RESEND_WEBHOOK_SECRET is not configured.") {
      auditLog("resend_webhook_secret_missing");
      return NextResponse.json({ success: false, error: message }, { status: 500 });
    }

    auditLog("resend_webhook_verification_failed", { error: message });
    return NextResponse.json(
      { success: false, error: "Invalid Resend webhook signature." },
      { status: 400 },
    );
  }

  const { event, svixId } = verifiedWebhook;

  if (event.type === "email.received") {
    const result = await processInboundEmailEvent(event);

    auditLog("resend_email_received", {
      svixId,
      emailId: event.data.email_id,
      from: event.data.from,
      to: event.data.to,
      routedTo: result.routedTo,
      subject: event.data.subject,
      attachmentCount: event.data.attachments.length,
      contentFetched: Boolean(result.content),
      contentError: result.contentError,
    });

    return NextResponse.json({
      success: true,
      type: event.type,
      svixId,
      emailId: event.data.email_id,
      to: event.data.to,
      routedTo: result.routedTo,
      subject: event.data.subject,
      attachmentCount: event.data.attachments.length,
      contentFetched: Boolean(result.content),
      contentError: result.contentError,
    });
  }

  if (isResendOutboundEmailEvent(event)) {
    const summary = getOutboundEmailEventSummary(event);

    auditLog("resend_email_sending_event", {
      svixId,
      ...summary,
    });

    return NextResponse.json({
      success: true,
      svixId,
      ...summary,
    });
  }

  auditLog("resend_webhook_ignored", { svixId, type: event.type });
  return NextResponse.json({ success: true, svixId, ignored: event.type });
}
