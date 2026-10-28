import PageClient from "./PageClient";
import AdSenseScript from "../../components/AdSenseScript";
import AdSlot from "../../components/AdSlot";
import GameDiscovery from "../../components/games/GameDiscovery";
import { GAME_INDEX } from "../../lib/gameLandingPages";

export const metadata = {
  alternates: { canonical: "/games" },
  title: "Skill Games | GRYND",
  description:
    "Browse all GRYND skill games. Blackjack PvP, Roulette, Plinko, Minesweeper, Keno, Crash Arena, Tower Arena and more. Competitive multiplayer games where your ability decides the outcome.",
};

export default function Page() {
  // Every public game, A–Z, resolved from the catalogue on the SERVER and
  // handed to the client hub as plain data. The hub renders this as a
  // crawlable directory of real links (see PageClient), and the projection is
  // built here because the catalogue carries each game's full prose — pulling
  // it into a "use client" module would ship all of it to the browser.
  const gameIndex = GAME_INDEX.map(({ slug, name }) => ({ slug, name }));

  return (
    <>
      <AdSenseScript />
      {/* Games HUB only — the individual game lobbies keep the loader they
          already had, and no slot exists on any match/board route. */}
      {/* `discoverySlot` is the SERVER-rendered discovery content (skills and
          categories), so the hub answers "which game is for me?" in its own
          HTML rather than only in the client-filtered card grid. It is built
          from the same catalogue the game pages and the sitemap are. */}
      <PageClient
        adSlot={<AdSlot placement="hub" />}
        gameIndex={gameIndex}
        discoverySlot={<GameDiscovery />}
      />
    </>
  );
}
