import { ogImageUrl } from "../../../lib/ogImages";
import PageClient from "./PageClient";

export const metadata = {
  title: "Roulette Royale | GRYND",
  description:
    "Play Roulette Royale PvP on GRYND. Same wheel, one winner — remove numbers, steal points, and outplay your opponent across 3 rounds.",
  openGraph: { images: [ogImageUrl("/images/og/roulette.jpg")] },
};

export default function Page() {
  return <PageClient />;
}
