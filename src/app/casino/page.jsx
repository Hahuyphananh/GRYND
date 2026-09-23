import PageClient from "./PageClient";
import AdSenseScript from "../../components/AdSenseScript";

export const metadata = {
  title: "Skill Games | GRYND",
  description:
    "Browse all GRYND skill games. Blackjack PvP, Poker, Roulette, Plinko, Mines Duel, Keno, Crash Arena and more. Competitive multiplayer games where your ability decides the outcome.",
};

export default function Page() {
  return (
    <>
      <AdSenseScript />
      <PageClient />
    </>
  );
}
