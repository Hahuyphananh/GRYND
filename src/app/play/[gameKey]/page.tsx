import type { Metadata } from "next";
import { notFound } from "next/navigation";

import PlayGame from "./PlayGame";
import PortalSdkBridge from "../../../components/portal/PortalSdkBridge";
import PortalHomeButton from "../../../components/portal/PortalHomeButton";
import { getPortalExportGame } from "../../../lib/portal/catalog";

// /play/<gameKey> — THE PORTAL SURFACE.
//
// The chrome-free entry point a portal frames: the game, the game's own UI, and
// nothing of the site around it (see components/SiteChrome.tsx, which drops the
// navbar padding, chat, quest badge, mascot, splash, consent banner and site
// analytics for exactly this path).
//
// The game surface itself is the SAME component the app serves at
// /casino/<game>: no fork, no second implementation, no change to match
// settlement, ratings, trophies or rewards. Reusing it is the point — a portal
// visitor gets the game the app ships, not a copy that can drift.
//
// The only keys that exist here are the exportable ones (lib/portal/catalog.ts,
// pinned to the guest practice list by tests). Any other key is a 404 before
// rendering, so /play/<anything> is not a free alias for the rest of the site.

export const metadata: Metadata = {
  // A portal frame is not a search surface, and this route is one more address
  // for a page that already has a canonical landing page. Never index it.
  title: "GRYND — play",
  robots: { index: false, follow: false, nocache: true },
};

export default async function PlayPage({
  params,
  searchParams,
}: {
  params: Promise<{ gameKey: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { gameKey } = await params;
  const query = await searchParams;

  const game = getPortalExportGame(gameKey);
  if (!game) notFound();

  const portal = typeof query.portal === "string" ? query.portal : null;

  return (
    <div data-testid="portal-play" data-game={game.gameKey} className="min-h-dvh bg-[#000d1a] text-white">
      {/* CrazyGames SDK v3 — inert unless this page is running inside
          CrazyGames. Loads no script, adds no listener and changes nothing on
          a normal visit or an itch.io frame. */}
      <PortalSdkBridge portal={portal} />

      {/* "Keep playing on GRYND" — appears only once a match has finished, and
          only for the portals in lib/portal/home.ts. It is the one conversion
          a portal surface can offer; see that module for the rules it obeys. */}
      <PortalHomeButton portal={portal} />

      {/* A single slim line naming the game and the fact that this is unrated
          practice. No outbound links, no account prompts, no ads of ours:
          portal rules forbid external accounts and external ads, and hiding
          our own account CTA here is what makes the surface submittable. */}
      <div className="flex items-center justify-between gap-3 border-b border-white/10 px-3 py-2">
        <p className="truncate text-xs font-bold uppercase tracking-[0.18em] text-[#00e5ff]">
          {game.name}
        </p>
        <p className="shrink-0 text-[10px] uppercase tracking-wider text-white/45">
          Practice · unrated
        </p>
      </div>

      <PlayGame gameKey={game.gameKey} />
    </div>
  );
}
