import { NextResponse } from "next/server";

// This route is forcefully disabled on Vercel (production or preview).
// The NODE_ENV guard is a convenience for local dev; the real gate is
// the VERCEL env variable which cannot be spoofed at runtime.
export async function GET() {
  // VERCEL env var is always set on Vercel deployments and never locally.
  // Combined with NODE_ENV for defense-in-depth.
  if (process.env.NODE_ENV === "production" || process.env.VERCEL) {
    return NextResponse.json(
      { success: false, error: "Not found" },
      { status: 404 },
    );
  }

  return NextResponse.json({
    success: true,
    nodeEnv: process.env.NODE_ENV,
    hasClerkSecretKey: Boolean(process.env.CLERK_SECRET_KEY),
    hasClerkJWTKey: Boolean(process.env.CLERK_JWT_KEY),
    hasOddsApiKey: Boolean(process.env.ODDS_API_KEY),
  });
}
