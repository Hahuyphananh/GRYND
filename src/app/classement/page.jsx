import PageClient from "./PageClient";
import AdSenseScript from "../../components/AdSenseScript";

export const metadata = {
  title: "Leaderboard | GRYND",
  description:
    "See the top GRYND players. Track weekly and all-time rankings by games won, win rate, games played, streaks and PvP wins — plus daily and weekly streak boards.",
};

export default function Page() {
  return (
    <>
      <AdSenseScript />
      <PageClient />
    </>
  );
}
