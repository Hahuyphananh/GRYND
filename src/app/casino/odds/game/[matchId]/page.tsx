import type { Metadata } from "next";
import PageClient from "./PageClient";

// The Odds board lives here, not in the lobby: /casino/odds is the lobby (pick
// a stake, open or join a table, start a practice duel) and this route plays
// the one match the URL names — `/game/<id>` for a staked duel, `/game/ai` for
// free practice. Nothing is created from this page, which is why it is noindex
// and carries no lobby chrome.
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
        ? "Odds Practice | GRYND"
        : `Odds Match #${shortId} | GRYND`,
    description:
      matchId === "ai"
        ? "Free Odds practice against the bot on GRYND. Five rounds, one secret number each, the same clue for both seats — call it with a number or a range."
        : `Live Odds match #${shortId} on GRYND — one secret number a round, the same clue for both, and the tighter call takes the pot.`,
  };
}

export default function Page() {
  return <PageClient />;
}
