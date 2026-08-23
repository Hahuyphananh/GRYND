import type { Metadata } from "next";
import { ogImageUrl } from "../../../lib/ogImages";
import PageClient from "./PageClient";

export const metadata: Metadata = {
  title: "Rock-Paper-Scissors | GRYND",
  description:
    "Play Rock-Paper-Scissors on GRYND. Best-of-7 mind games against a live opponent, or play the AI for free.",
  openGraph: { images: [ogImageUrl("/images/og/rps.jpg")] },
};

export default function Page() {
  return <PageClient />;
}
