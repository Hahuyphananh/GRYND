import { NextRequest, NextResponse } from "next/server";
import {
  sendSystemNotificationEmail,
  type SystemEventType,
} from "../../../../lib/emails/system";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID_EVENT_TYPES: SystemEventType[] = [
  "bet_placed",
  "action_completed",
  "error_event",
  "system_event",
];

/**
 * POST /api/system/notify — Triggers a system notification email to the admin.
 *
 * Body:
 *   eventType: "bet_placed" | "action_completed" | "error_event" | "system_event"
 *   description: string (what happened)
 *   metadata?: Record<string, unknown> (optional extra context)
 */
export async function POST(request: NextRequest) {
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
