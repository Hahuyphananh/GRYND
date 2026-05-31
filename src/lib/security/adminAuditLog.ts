// src/lib/security/adminAuditLog.ts
// Persist admin actions to the admin_audit_logs DB table.
// Also emits console audit for log aggregation services.

import { db } from "../../db";
import { adminAuditLogs } from "../../db/schema";

export interface AdminAuditPayload {
  clerkId: string;
  targetClerkId?: string;
  details?: Record<string, unknown>;
}

export async function adminAuditLog(event: string, payload: AdminAuditPayload) {
  // Console log for external log aggregation
  console.info(
    JSON.stringify({
      type: "admin_audit",
      event,
      timestamp: new Date().toISOString(),
      ...payload,
      details: payload.details ?? {},
    }),
  );

  // Persist to DB
  try {
    await db.insert(adminAuditLogs).values({
      event,
      clerkId: payload.clerkId,
      targetClerkId: payload.targetClerkId ?? null,
      details: payload.details ?? {},
    });
  } catch (err) {
    // Don't fail the operation just because audit logging failed
    console.error("[adminAuditLog] Failed to persist audit event:", err);
  }
}
