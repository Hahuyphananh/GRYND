// app/api/debug-env/route.ts
import { NextResponse } from 'next/server';

export async function GET() {
  return NextResponse.json({
    clerkSecretKey: process.env.CLERK_SECRET_KEY 
      ? "****" + process.env.CLERK_SECRET_KEY.slice(-4)  // Mask partial key
      : "MISSING",
    nodeEnv: process.env.NODE_ENV,
     clerkJWTKey: process.env.CLERK_JWT_KEY 
  });
}