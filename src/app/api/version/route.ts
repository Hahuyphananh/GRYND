import { NextResponse } from "next/server";

// A static JSON response, prerendered at build time from the deployment's own
// commit/deployment id. Because the ROOT LAYOUT is `force-dynamic`, the navbar's
// old deploy check — a HEAD to `window.location.href` — re-ran a FULL server
// render (and its data fetches) every few minutes just to read an ETag. Pointing
// it at this tiny static payload turns that into a single CDN response with no
// function invocation at all: the value is baked per build, so a new deploy
// changes the ETag and the client still detects it exactly as before.
export const dynamic = "force-static";

export function GET() {
  const id =
    process.env.VERCEL_GIT_COMMIT_SHA ||
    process.env.VERCEL_DEPLOYMENT_ID ||
    process.env.VERCEL_URL ||
    "dev";
  return NextResponse.json({ id });
}
