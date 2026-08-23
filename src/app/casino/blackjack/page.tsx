import type { Metadata } from "next";
import { ogImageUrl } from "../../../lib/ogImages";
import PageClient from "./PageClient";

export const metadata: Metadata = {
  title: "Blackjack PvP | GRYND",
  description:
    "Play Blackjack PvP on GRYND. Best-of-3 head-to-head duels against a real opponent. Pick a stake, match another player and win the pot.",
  openGraph: { images: [ogImageUrl("/images/og/blackjack.jpg")] },
};

export default function Page() {
  return <PageClient />;
}
