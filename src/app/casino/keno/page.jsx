import { ogImageUrl } from "../../../lib/ogImages";
import PageClient from "./PageClient";

export const metadata = {
  title: "Keno | GRYND",
  description:
    "Play 1v1 Keno on GRYND. Both players chase the same 10-ball draw in a best-of-5 Catch Duel. Out-catch your rival and take the pot.",
  openGraph: { images: [ogImageUrl("/images/og/keno.jpg")] },
};

export default function Page() {
  return <PageClient />;
}
