import { ogImageUrl } from "../../../lib/ogImages";
import PageClient from "./PageClient";
import AdSenseScript from "../../../components/AdSenseScript";

export const metadata = {
  title: "Crash Arena | GRYND",
  description:
    "Join a Crash Arena table on GRYND. Post the blinds, then fold, call or raise at every betting checkpoint as the multiplier climbs. Last player standing takes the pot.",
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
