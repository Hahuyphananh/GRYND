import type { Metadata } from "next";
import UnoGamePage from "../casino/uno/page";
import { OG_BASE_URL } from "../../lib/ogImages";

export const metadata: Metadata = {
  title: "Uno | GRYND",
  description:
    "Play Uno on GRYND. Match colors and numbers in a fast strategic card game against the AI or other players.",
  // Alias route for the Uno lobby: it renders the game application, not the
  // public landing page, so it points at the play URL and is noindex — the
  // indexable page for this game is /games/uno.
  alternates: { canonical: `${OG_BASE_URL}/games/uno/play` },
  robots: { index: false, follow: true },
};

export default function Page() {
  return <UnoGamePage />;
}
