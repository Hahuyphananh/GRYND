// src/app/api/admin/mfa/status/route.ts
// GET — which self-hosted second factors are actually available on this host.
//
// This used to report `email: true` unconditionally, which meant the MFA page
// offered an email code that could never be sent when no mail provider was
// configured — exactly the failure mode after the move to a new VM. Every value
// here is now derived from configuration presence.
//
// Presence only: no value, no prefix, no length. Admins may call this (the
// middleware treats /api/* as public so the MFA gate does not block the
// setup/verify endpoints, so the checks below are the gate).

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";

import { isAdmin } from "../../../../../lib/auth/isAdmin";
import { buildMfaDiagnostics, requiredMfaVariables } from "../../../../../lib/admin/mfaDiagnostics";

export async function GET() {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }
  if (!(await isAdmin(userId))) {
    return NextResponse.json({ success: false, error: "Forbidden" }, { status: 403 });
  }

  const diagnostics = buildMfaDiagnostics(process.env);

  return NextResponse.json({
    success: true,
    methods: {
      email: diagnostics.factors.email.configured,
      totp: diagnostics.factors.totp.configured,
      passphrase: diagnostics.factors.passphrase.configured,
    },
    anyConfigured: diagnostics.anyConfigured,
    warnings: diagnostics.warnings.map((warning) => ({
      code: warning.code,
      severity: warning.severity,
      message: warning.message,
    })),
    otpStore: diagnostics.otpStore.kind,
    sessionSecret: diagnostics.sessionSecret.source,
    // Names only, and only when nothing is configured, so the page can tell an
    // operator exactly what to set after a migration.
    requiredVariables: diagnostics.anyConfigured ? [] : requiredMfaVariables(),
  });
}
