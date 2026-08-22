import { ogImageUrl } from "../../../lib/ogImages";
import PageClient from "./PageClient";

export const metadata = {
  title: "Chess — GoonBet",
  description:
    "Play chess on GoonBet — challenge players in multiplayer chess matches or sharpen your skills against the AI.",
  openGraph: { images: [ogImageUrl("/images/og/chess.jpg")] },
};

export default function Page() {
  return <PageClient />;
}
