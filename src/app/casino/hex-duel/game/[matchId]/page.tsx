import type { Metadata } from "next";
import PageClient from "./PageClient";

// The board lives here, not in the lobby: /casino/hex-duel is the lobby (create
// a PvP table, start a practice match, browse open games) and this route plays
// the one match the URL names — `/game/<id>` for a staked duel, `/game/ai` for
// free practice. Nothing is ever created from this page, which is why it is
// noindex and has no lobby chrome.
export async function generateMetadata({
  params,
}: {
  params: Promise<{ matchId: string }>;
}): Promise<Metadata> {
  const { matchId } = await params;
  const shortId = matchId.length > 10 ? matchId.slice(0, 8) : matchId;
  return {
    robots: { index: false, follow: false },
    title:
      matchId === "ai"
        ? "Hex Duel Practice | GRYND"
        : `Hex Duel Match #${shortId} | GRYND`,
    description:
      matchId === "ai"
        ? "Free Hex Duel practice against the bot on GRYND. Capture tiles, outmaneuver the AI and hold the capitals."
        : `Live Hex Duel match #${shortId} on GRYND — capture tiles, break the line and hold the capitals to win.`,
  };
}

export default function Page() {
  return <PageClient />;
}
