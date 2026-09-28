import { ogImageUrl } from "../../../lib/ogImages";
import PageClient from "./PageClient";
import AdSenseScript from "../../../components/AdSenseScript";

export const metadata = {
  title: "Crash Arena | GRYND",
  description:
    "Play Crash Arena on GRYND, a head-to-head crash duel. Both players ante, the multiplier climbs, and one button folds you out — fold later than your opponent to take the pot.",
  openGraph: { images: [ogImageUrl("/images/og/crash-arena.jpg")] },
};

export default function Page() {
  return (
    <>
      <AdSenseScript />
      <PageClient />
    </>
  );
}
