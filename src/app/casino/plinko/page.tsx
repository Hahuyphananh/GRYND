import type { Metadata } from "next";
import { ogImageUrl } from "../../../lib/ogImages";
import PageClient from "./PageClient";

export const metadata: Metadata = {
  title: "Plinko — GRYND",
  description:
    "Play Plinko on GRYND — drop the chip and watch it fall to multiply your winnings.",
  openGraph: { images: [ogImageUrl("/images/og/plinko.jpg")] },
};

export default function Page() {
  return <PageClient />;
}
