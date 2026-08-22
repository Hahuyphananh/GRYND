// src/app/api/admin/mfa/status/route.ts
// GET — which self-hosted second factors are configured for this admin.
// Only admins may call this (verified here; the middleware treats /api/* as
// public so the MFA gate doesn't block setup/verify endpoints).

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { isAdmin } from "../../../../../lib/auth/isAdmin";

export async function GET() {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }
  if (!(await isAdmin(userId))) {
    return NextResponse.json({ success: false, error: "Forbidden" }, { status: 403 });
  }

  return NextResponse.json({
    success: true,
    methods: {
      email: true,
      totp: Boolean(process.env.ADMIN_TOTP_SECRET?.trim()),
      passphrase: Boolean(process.env.ADMIN_MFA_PASSPHRASE?.trim()),
    },
  });
}
