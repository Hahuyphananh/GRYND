import type { Metadata } from "next";
import { ogImageUrl } from "../../../../lib/ogImages";
import PageClient from "./PageClient";

export const metadata: Metadata = {
  title: "Poker | GRYND",
  description:
    "Play Texas Hold'em Poker on GRYND. Create or join multiplayer tables and compete against other players.",
  openGraph: { images: [ogImageUrl("/images/og/poker.jpg")] },
};

export default function Page() {
  return <PageClient />;
}
