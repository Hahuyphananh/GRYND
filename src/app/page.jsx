import PageClient from "./PageClient";
import { ogImageUrl, SITE_URL } from "../lib/ogImages";

export const metadata = {
  title: "GRYND — Competitive PvP Skill Gaming",
  description:
    "Challenge real players in competitive games, climb the leaderboard, and prove your skill.",
  alternates: {
    canonical: "/",
  },
  openGraph: {
    title: "GRYND — Competitive PvP Skill Gaming",
    description:
      "Challenge real players in competitive games, climb the leaderboard, and prove your skill.",
    url: `${SITE_URL}/`,
    siteName: "GRYND",
    locale: "en_US",
    type: "website",
    images: [
      {
        url: ogImageUrl("/og-image.png"),
        width: 1200,
        height: 630,
        alt: "GRYND — Competitive PvP Skill Gaming",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "GRYND — Competitive PvP Skill Gaming",
    description:
      "Challenge real players in competitive games, climb the leaderboard, and prove your skill.",
    images: [ogImageUrl("/og-image.png")],
  },
};

export default function Page() {
  return <PageClient />;
}