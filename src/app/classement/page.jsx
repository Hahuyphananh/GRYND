import PageClient from "./PageClient";
import AdSenseScript from "../../components/AdSenseScript";
import AdSlot from "../../components/AdSlot";
import HilltopBanner from "../../components/ads/HilltopBanner";
import { pageMetadata, DEFAULT_OG_IMAGE } from "../../lib/seo";

export const metadata = pageMetadata({
  title: "Leaderboard",
  description: "See the GRYND Solitaire Duel ladder — Elo ratings, wins, win rate, games played and streaks, plus the all-time and weekly boards.",
  path: "/classement",
  image: DEFAULT_OG_IMAGE,
});

export default function Page() {
  return (
    <>
      <AdSenseScript />
      <PageClient
        adSlot={<AdSlot placement="leaderboard" />}
        hilltopSlot={<HilltopBanner placement="leaderboard" />}
      />
    </>
  );
}
