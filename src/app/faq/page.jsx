import PageClient from "./PageClient";
import { GAME_CARDS } from "../../lib/gameLandingPages";

export const metadata = {
  alternates: { canonical: "/faq" },
  title: "FAQ | GRYND",
  description:
    "Answers to the most common questions about GRYND — how ranked Solitaire works, ratings, trophies, match history, GRYND PRO, your account, and the rules page for the game.",
};

export default function Page() {
  // The public game directory still resolves from the catalogue on the SERVER
  // (archived games are filtered out there), so the FAQ keeps its directory
  // without this page knowing which games are live.
  return <PageClient gameCards={GAME_CARDS} />;
}
