import PageClient from "./PageClient";
import AdSenseScript from "../../components/AdSenseScript";
import AdSlot from "../../components/AdSlot";

export const metadata = {
  title: "Skill Games | GRYND",
  description:
    "Browse all GRYND skill games. Blackjack PvP, Poker, Roulette, Plinko, Mines Duel, Keno, Crash Arena and more. Competitive multiplayer games where your ability decides the outcome.",
};

export default function Page() {
  return (
    <>
      <AdSenseScript />
      {/* Games HUB only — the individual game lobbies keep the loader they
          already had, and no slot exists on any match/board route. */}
      <PageClient adSlot={<AdSlot placement="hub" />} />
    </>
  );
}
