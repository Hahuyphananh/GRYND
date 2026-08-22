import { ogImageUrl } from "../../../lib/ogImages";
import PageClient from "./PageClient";

export const metadata = {
  title: "Roulette Royale — GoonBet",
  description:
    "Play Roulette Royale on GoonBet — place your bets on numbers, colors or sections and watch the wheel spin.",
  openGraph: { images: [ogImageUrl("/images/og/roulette.jpg")] },
};

export default function Page() {
  return <PageClient />;
}
