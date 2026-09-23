import { ogImageUrl } from "../../../lib/ogImages";
import PageClient from "./PageClient";
import AdSenseScript from "../../../components/AdSenseScript";

export const metadata = {
  title: "Uno | GRYND",
  description:
    "Play Uno on GRYND. Match colors and numbers in a fast strategic card game against the AI or other players.",
  openGraph: { images: [ogImageUrl("/images/og/neon-flush.jpg")] },
};

export default function Page() {
  return (
    <>
      <AdSenseScript />
      <PageClient />
    </>
  );
}
