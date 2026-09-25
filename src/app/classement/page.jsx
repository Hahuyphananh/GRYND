import PageClient from "./PageClient";
import AdSenseScript from "../../components/AdSenseScript";
import AdSlot from "../../components/AdSlot";

export const metadata = {
  title: "Leaderboard | GRYND",
  description:
    "See the top GRYND players. Every game has its own Elo leaderboard — Chess, Pool Masters, Precision, Memory Grid and more — plus all-time and weekly boards for wins, win rate, games played, streaks and PvP wins.",
};

export default function Page() {
  return (
    <>
      <AdSenseScript />
      <PageClient adSlot={<AdSlot placement="leaderboard" />} />
    </>
  );
}
