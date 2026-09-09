import type { Metadata } from "next";
import { ogImageUrl } from "../../../lib/ogImages";
import PageClient from "./PageClient";

export const metadata: Metadata = {
  title: "Plinko | GRYND",
  description:
    "Play Plinko PvP on GRYND. Duel on the same peg field — 3 balls each. Pick your launch and out-score your rival.",
  openGraph: { images: [ogImageUrl("/images/og/plinko.jpg")] },
};

export default function Page() {
  return <PageClient />;
}
