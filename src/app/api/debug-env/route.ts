import { NextResponse } from 'next/server';

export async function GET() {
  if (process.env.NODE_ENV === 'production') {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 });
  }

  return NextResponse.json({
    success: true,
    nodeEnv: process.env.NODE_ENV,
    hasClerkSecretKey: Boolean(process.env.CLERK_SECRET_KEY),
    hasClerkJWTKey: Boolean(process.env.CLERK_JWT_KEY),
    hasOddsApiKey: Boolean(process.env.ODDS_API_KEY),
  });
}
