import { ogImageUrl } from "../../../lib/ogImages";
import PageClient from "./PageClient";
import AdSenseScript from "../../../components/AdSenseScript";

export const metadata = {
  title: "Chess | GRYND",
  description:
    "Play chess on GRYND. Challenge players in multiplayer chess matches or sharpen your skills against the AI.",
  openGraph: { images: [ogImageUrl("/images/og/chess.jpg")] },
};

export default function Page() {
  return (
    <>
      <AdSenseScript />
      <PageClient />
    </>
  );
}
