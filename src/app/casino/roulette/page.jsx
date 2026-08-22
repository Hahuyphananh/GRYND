import { ogImageUrl } from "../../../lib/ogImages";
import PageClient from "./PageClient";

export const metadata = {
  title: "Roulette Royale — GRYND",
  description:
    "Play Roulette Royale on GRYND — place your bets on numbers, colors or sections and watch the wheel spin.",
  openGraph: { images: [ogImageUrl("/images/og/roulette.jpg")] },
};

export default function Page() {
  return <PageClient />;
}
