import type { Metadata } from "next";
import PageClient from "./PageClient";
import { postMatchAdSurface } from "../../../../lib/vast/entitlement";

// The match page is authenticated and per-match; never prerender it, so the
// kill switch and the membership answer are always evaluated against the
// running deployment and the caller's own subscription row.
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

/**
 * The post-match surface is resolved on the SERVER, per request:
 *
 *   * `POST_MATCH_ADS_ENABLED=false` is the runtime kill switch — it stops the
 *     surface on the very next request, no rebuild or redeploy;
 *   * an active GRYND PRO member is `ad_free`, so the post-match video is
 *     withheld from them like every other advertisement;
 *   * the build-time public switches (`NEXT_PUBLIC_POST_MATCH_ADS_ENABLED`,
 *     `NEXT_PUBLIC_HILLTOPS_ENABLED`) are still applied inside the component.
 */
export default async function Page() {
  const ads = await postMatchAdSurface();
  return (
    <PageClient postMatchAdsEnabled={ads.enabled} postMatchAdFree={ads.adFree} />
  );
}
