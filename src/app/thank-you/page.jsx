import PageClient from "./PageClient";
import { ogImageUrl } from "../../lib/ogImages";

export const metadata = {
  title: "Welcome to GoonBet!",
  description:
    "Your GoonBet account is ready and your free tokens are waiting. Pick a skill-based game and start playing.",
  openGraph: {
    title: "Welcome to GoonBet!",
    description: "Your GoonBet account is ready and your free tokens are waiting.",
    url: ogImageUrl("/thank-you"),
    siteName: "GoonBet",
    images: [{ url: ogImageUrl("/og-image.png"), width: 1200, height: 630, alt: "GoonBet" }],
    type: "website",
  },
};

export default function Page() {
  return <PageClient />;
}
