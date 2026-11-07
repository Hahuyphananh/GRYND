import type { Metadata } from "next";
import { notFound } from "next/navigation";

import PlayMatch from "./PlayMatch";
import PortalSdkBridge from "../../../../components/portal/PortalSdkBridge";
import PortalHomeButton from "../../../../components/portal/PortalHomeButton";
import { getPortalExportGame } from "../../../../lib/portal/catalog";
import { hasPortalMatchRoute, portalPlayRoute } from "../../../../lib/portal/framing";

// /play/<gameKey>/<matchId> — THE BOARD, ON THE FRAMABLE PATH.
//
// Why this route exists: three of the four games navigate to their board after
// "Play vs AI" (`/casino/<game>/<id>`, or `/casino/odds/game/<id>`), and those
// paths keep `frame-ancestors 'self'`. Inside a portal iframe the navigation was
// therefore refused and the surface went blank at the first move.
//
// This route renders the SAME match component the app serves — no fork — so the
// board, its polling, its socket events and its result screen are identical.
// The only differences are the ones a portal requires: the framing policy (via
// lib/portal/framing), no GRYND post-match ad, and no site chrome (the root
// layout's gate in components/SiteChrome covers /play/*).
//
// The match id is opaque here. The games' APIs authorise by seat, so this route
// grants nothing: an id that does not belong to this visitor is refused by the
// server exactly as it is on /casino.

export const metadata: Metadata = {
  robots: { index: false, follow: false, nocache: true },
  title: "GRYND — play",
};

export default async function PlayMatchPage({
  params,
  searchParams,
}: {
  params: Promise<{ gameKey: string; matchId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { gameKey, matchId } = await params;
  const query = await searchParams;

  const game = getPortalExportGame(gameKey);
  // One parser decides what a portal path is (lib/portal/framing), so this
  // route cannot accept an id the framing policy would reject.
  const route = portalPlayRoute(`/play/${gameKey}/${matchId}`);
  if (!game || !route || route.matchId === null) notFound();
  // Battleship plays inside its lobby page (no board route); anything other
  // than the three board games is a 404 rather than an alias.
  if (!hasPortalMatchRoute(game.gameKey)) notFound();

  const portal = typeof query.portal === "string" ? query.portal : null;

  return (
    <div
      data-testid="portal-match"
      data-game={game.gameKey}
      className="min-h-dvh bg-[#000d1a] text-white"
    >
      {/* The SDK bridge belongs on the board too: gameplayStart/Stop and the
          end-of-match ad break are measured here, not on the lobby. */}
      <PortalSdkBridge portal={portal} />

      <PlayMatch gameKey={game.gameKey} />

      {/* The match is exactly where a portal visitor finishes, so the "keep
          playing" button has to be mounted here as well as on the lobby. */}
      <PortalHomeButton portal={portal} />
    </div>
  );
}
