import { ogImageUrl } from "../../../lib/ogImages";
import PageClient from "./PageClient";

export const metadata = {
  title: "Uno — GoonBet",
  description:
    "Play Uno on GoonBet — match colors and numbers in a fast strategic card game against the AI or other players.",
  openGraph: { images: [ogImageUrl("/images/og/neon-flush.jpg")] },
};

export default function Page() {
  return <PageClient />;
}
