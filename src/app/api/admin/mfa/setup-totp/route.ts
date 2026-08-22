// src/app/api/admin/mfa/setup-totp/route.ts
// GET — return the shared TOTP secret + otpauth URL + a QR code so an admin
// can enroll the instance in their authenticator app. The secret lives in the
// ADMIN_TOTP_SECRET env var (set it to a base32 secret).

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import QRCode from "qrcode";
import { isAdmin } from "../../../../../lib/auth/isAdmin";
import { buildOtpauthUrl } from "../../../../../lib/auth/totp";

export async function GET() {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }
  if (!(await isAdmin(userId))) {
    return NextResponse.json({ success: false, error: "Forbidden" }, { status: 403 });
  }

  const secret = process.env.ADMIN_TOTP_SECRET?.trim();
  if (!secret) {
    return NextResponse.json(
      {
        success: false,
        error: "Authenticator app is not configured. Set the ADMIN_TOTP_SECRET env var first.",
      },
      { status: 404 },
    );
  }

  const otpauthUrl = buildOtpauthUrl(secret);
  let qrDataUrl: string | null = null;
  try {
    qrDataUrl = await QRCode.toDataURL(otpauthUrl, {
      errorCorrectionLevel: "M",
      margin: 2,
      width: 240,
      color: { dark: "#0a0f1e", light: "#ffffff" },
    });
  } catch (err) {
    console.warn("[admin/mfa/setup-totp] QR generation failed:", err);
  }

  return NextResponse.json({
    success: true,
    secret,
    otpauthUrl,
    qrDataUrl,
  });
}
