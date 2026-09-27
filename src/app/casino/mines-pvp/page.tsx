import type { Metadata } from "next";
import { ogImageUrl } from "../../../lib/ogImages";
import PageClient from "./PageClient";
import AdSenseScript from "../../../components/AdSenseScript";

export const metadata: Metadata = {
  title: "Mines Duel | GRYND",
  description:
    "Play Mines Duel on GRYND. Face another player on a shared 10×10 board with 10 mines — every safe reveal and its clue is public, flags are private. Step on a mine and you lose instantly; confirm every mine and you win.",
  openGraph: { images: [ogImageUrl("/images/og/mines.jpg")] },
};

export default function Page() {
  return (
    <>
      <AdSenseScript />
      <PageClient />
    </>
  );
}
