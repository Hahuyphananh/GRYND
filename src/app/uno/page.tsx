import type { Metadata } from "next";
import UnoGamePage from "../casino/uno/page";
import { OG_BASE_URL } from "../../lib/ogImages";

export const metadata: Metadata = {
  title: "Uno | GRYND",
  description:
    "Play Uno on GRYND. Match colors and numbers in a fast strategic card game against the AI or other players.",
  alternates: {
    // Alias route — consolidate indexing on the canonical /games/uno
    // (/casino/uno 308-redirects to it; see next.config.js).
    canonical: `${OG_BASE_URL}/games/uno`,
  },
};

export default function Page() {
  return <UnoGamePage />;
}
