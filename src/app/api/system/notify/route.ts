import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import {
  sendSystemNotificationEmail,
  type SystemEventType,
} from "../../../../lib/emails/system";
import { isAdmin } from "../../../../lib/auth/isAdmin";
import { auditLog } from "../../../../lib/security/auditLog";
import { readBearerToken, timingSafeEqualString } from "../../../../lib/security/bearerToken";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID_EVENT_TYPES: SystemEventType[] = [
  "bet_placed",
  "action_completed",
  "error_event",
  "system_event",
];

/** Cap on the serialised metadata so one request cannot mail a huge payload. */
const MAX_METADATA_CHARS = 8_000;

/**
 * POST /api/system/notify — send a system notification email to the admin.
 *
 * AUTHORISATION: a scheduler presenting CRON_SECRET as a bearer token, or a
 * signed-in admin. The route used to accept anonymous callers, which let
 * anyone on the internet mail the admin inbox with arbitrary HTML (and burn
 * the Resend quota) at the route rate limit.
 */
async function authoriseSystemNotify(request: NextRequest): Promise<Response | null> {
  const cronSecret = process.env.CRON_SECRET?.trim();
  if (cronSecret) {
    const presented = readBearerToken(request.headers.get("authorization"));
    if (presented && timingSafeEqualString(presented, cronSecret)) return null;
  }

  const { userId } = await auth();
  if (!userId) {
    auditLog("system_notify_unauthorized", { path: "/api/system/notify" });
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 },
    );
  }

  if (!(await isAdmin(userId))) {
    auditLog("system_notify_forbidden", { userId, path: "/api/system/notify" });
    return NextResponse.json(
      { success: false, error: "Forbidden" },
      { status: 403 },
    );
  }

  return null;
}

/**
 * Body:
 *   eventType: "bet_placed" | "action_completed" | "error_event" | "system_event"
 *   description: string (what happened)
 *   metadata?: Record<string, unknown> (optional extra context)
 */
export async function POST(request: NextRequest) {
  const denied = await authoriseSystemNotify(request);
  if (denied) return denied;

  try {
    const body = await request.json();
    const { eventType, description, metadata } = body;

    if (!eventType || !description) {
      return NextResponse.json(
        { success: false, error: "eventType and description are required." },
        { status: 400 },
      );
    }

    if (!VALID_EVENT_TYPES.includes(eventType)) {
      return NextResponse.json(
        {
          success: false,
          error: `Invalid eventType. Must be one of: ${VALID_EVENT_TYPES.join(", ")}`,
        },
        { status: 400 },
      );
    }

    if (typeof description !== "string" || description.length > 5000) {
      return NextResponse.json(
        { success: false, error: "Description must be a string (max 5000 chars)." },
        { status: 400 },
      );
    }

    // metadata is rendered into the admin email. Keep it a plain object and
    // bounded; the email template escapes the content.
    if (
      metadata !== undefined &&
      (metadata === null || typeof metadata !== "object" || Array.isArray(metadata))
    ) {
      return NextResponse.json(
        { success: false, error: "metadata must be a JSON object." },
        { status: 400 },
      );
    }
    if (metadata && JSON.stringify(metadata).length > MAX_METADATA_CHARS) {
      return NextResponse.json(
        { success: false, error: "metadata is too large." },
        { status: 400 },
      );
    }

    const result = await sendSystemNotificationEmail({
      eventType,
      description,
      metadata,
    });

    if ("skipped" in result) {
      return NextResponse.json(
        { success: false, error: `Email could not be sent: ${result.reason}` },
        { status: 500 },
      );
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("[api/system/notify] Error:", err);
    return NextResponse.json(
      { success: false, error: "Internal server error." },
      { status: 500 },
    );
  }
}
