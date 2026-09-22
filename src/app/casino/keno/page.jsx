import { ogImageUrl } from "../../../lib/ogImages";
import PageClient from "./PageClient";

export const metadata = {
  title: "Keno | GRYND",
  description:
    "Play 1v1 Keno on GRYND. A survival duel: 3 lives each, one lit tile and a window that tightens with every claim. Tap faster than your rival or lose a life.",
  openGraph: { images: [ogImageUrl("/images/og/keno.jpg")] },
};

export default function Page() {
  return <PageClient />;
}
