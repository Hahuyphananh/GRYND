import type { Metadata } from "next";
import PageClient from "./PageClient";

/**
 * RUNTIME kill switch for post-match advertising.
 *
 * Read on the SERVER, per request, from a non-public variable: setting
 * `POST_MATCH_ADS_ENABLED=false` in the deployment's environment stops the
 * surface on the very next request — no rebuild, no redeploy. The build-time
 * public switch (`NEXT_PUBLIC_POST_MATCH_ADS_ENABLED`) is still applied inside
 * the ad component, so either one disables advertising.
 */
function postMatchAdsEnabledOnServer(): boolean {
  return (
    (process.env.POST_MATCH_ADS_ENABLED ?? "").trim().toLowerCase() !== "false"
  );
}

// The match page is authenticated and per-match; never prerender it, so the
// flag above is always evaluated against the running deployment's environment.
export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ matchId: string }>;
}): Promise<Metadata> {
  const { matchId } = await params;
  const shortId = matchId.length > 10 ? matchId.slice(0, 8) : matchId;
  return {
    robots: { index: false, follow: false },
    title: `Ultimate Tic-Tac-Toe Match #${shortId} | GRYND`,
    description: `Live Ultimate Tic-Tac-Toe match #${shortId} on GRYND — a rated 1v1 duel on nine mini-boards, three boards in a line to win.`,
  };
}

export default function Page() {
  return <PageClient postMatchAdsEnabled={postMatchAdsEnabledOnServer()} />;
}
