import type { Metadata } from "next";
import { ogImageUrl } from "../../../lib/ogImages";
import PageClient from "./PageClient";

export const metadata: Metadata = {
  title: "Mines Duel | GRYND",
  description:
    "Play Mines Duel on GRYND. Stake tokens and face another player on a shared 5×5 board. Host picks the mine count, winner takes 1.9×.",
  openGraph: { images: [ogImageUrl("/images/og/mines.jpg")] },
};

export default function Page() {
  return <PageClient />;
}
