import type { Metadata } from "next";
import PageClient from "./PageClient";
import { postMatchAdSurface } from "../../../../lib/vast/entitlement";

export const metadata: Metadata = {
  title: "Barrier Blitz vs AI | GRYND",
  description:
    "Play Barrier Blitz free against the AI on GRYND. Race your pawn across the 9×9 board, drop barriers to slow your opponent down, and practise before facing real players.",
};

// The post-match offer is decided per request (kill switch + membership), so
// this page is never prerendered.
export const dynamic = "force-dynamic";

/**
 * Free practice has no match row, so the post-match video's cadence is driven
 * by an id minted once per finished game in the client. Everything about
 * WHETHER to offer it is decided here, on the server: the runtime kill switch
 * and the `ad_free` PRO entitlement.
 */
export default async function Page() {
  const ads = await postMatchAdSurface();
  return (
    <PageClient postMatchAdsEnabled={ads.enabled} postMatchAdFree={ads.adFree} />
  );
}
