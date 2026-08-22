// src/app/api/admin/mfa/verify/route.ts
// POST { method: "email" | "totp" | "passphrase", code } — verify a second
// factor and issue the signed 24h admin-MFA cookie.

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import crypto from "crypto";
import { isAdmin } from "../../../../../lib/auth/isAdmin";
import { verifyOtp } from "../../../../../lib/auth/adminOtp";
import { verifyTotp } from "../../../../../lib/auth/totp";
import {
  ADMIN_MFA_COOKIE,
  ADMIN_MFA_MAX_AGE_SECONDS,
  issueAdminMfaToken,
} from "../../../../../lib/auth/adminMfa";
import { adminAuditLog } from "../../../../../lib/security/adminAuditLog";

type Method = "email" | "totp" | "passphrase";

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }
  if (!(await isAdmin(userId))) {
    return NextResponse.json({ success: false, error: "Forbidden" }, { status: 403 });
  }

  let body: { method?: string; code?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON body." }, { status: 400 });
  }

  const method = body?.method as Method;
  const code = typeof body?.code === "string" ? body.code.trim() : "";

  if (method !== "email" && method !== "totp" && method !== "passphrase") {
    return NextResponse.json({ success: false, error: "Unknown method." }, { status: 400 });
  }

  let ok = false;
  if (method === "email") {
    ok = await verifyOtp(userId, code);
  } else if (method === "totp") {
    const secret = process.env.ADMIN_TOTP_SECRET?.trim();
    ok = secret ? verifyTotp(secret, code) : false;
  } else {
    const expected = (process.env.ADMIN_MFA_PASSPHRASE ?? "").trim();
    ok = expected.length > 0 && safeEqual(code, expected);
  }

  if (!ok) {
    adminAuditLog("admin_mfa_verify_failed", {
      clerkId: userId,
      details: { method },
    }).catch(() => {});
    return NextResponse.json(
      { success: false, error: "Invalid code. Please try again." },
      { status: 401 },
    );
  }

  adminAuditLog("admin_mfa_verified", {
    clerkId: userId,
    details: { method },
  }).catch(() => {});

  const res = NextResponse.json({ success: true });
  res.cookies.set(ADMIN_MFA_COOKIE, await issueAdminMfaToken(userId), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: ADMIN_MFA_MAX_AGE_SECONDS,
  });
  return res;
}
