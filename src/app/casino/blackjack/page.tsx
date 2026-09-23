import type { Metadata } from "next";
import { ogImageUrl } from "../../../lib/ogImages";
import PageClient from "./PageClient";
import AdSenseScript from "../../../components/AdSenseScript";

export const metadata: Metadata = {
  title: "Blackjack PvP | GRYND",
  description:
    "Play Blackjack PvP on GRYND. Best-of-3 head-to-head duels against a real opponent. Read the table, time your swaps, and outplay the seat across from you.",
  openGraph: { images: [ogImageUrl("/images/og/blackjack.jpg")] },
};

export default function Page() {
  return (
    <>
      <AdSenseScript />
      <PageClient />
    </>
  );
}
