// src/app/api/ads/post-match/route.ts
//
// GET — the post-match advertisement surface for the CURRENT request.
//
// The shared result screen renders on every game, so the two things that
// decide whether it may show an ad are answered here, once per result screen,
// on the server:
//
//   { enabled: boolean, adFree: boolean }
//
//   * `enabled` folds in the runtime kill switch (`POST_MATCH_ADS_ENABLED`) and
//     the membership answer, so it is already false for a GRYND PRO member.
//   * `adFree` is sent as well so the client can refuse independently.
//
// It takes NO input: no query parameter, no body, no cookie can change it. The
// membership comes from the Clerk session and the caller's own subscription
// row (src/lib/vast/entitlement.ts → src/lib/adEntitlement.ts), exactly like
// every other ad surface. A signed-out visitor is simply "not a member".
//
// This is the only piece of the ad surface that is a request: nothing loads
// until a result screen asks, and the component still does not touch the VAST
// tag until the player clicks "Watch video".

import { NextResponse } from "next/server";
import { postMatchAdSurface } from "../../../../lib/vast/entitlement";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const { enabled, adFree } = await postMatchAdSurface();
  return NextResponse.json(
    { enabled, adFree },
    { headers: { "Cache-Control": "no-store" } },
  );
}
