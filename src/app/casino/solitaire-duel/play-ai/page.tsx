import type { Metadata } from "next";

import SolitairePlayAiPage from "./PageClient";

export const metadata: Metadata = {
  title: "Play vs Bots | Solitaire Duel",
  description:
    "Challenge six named Solitaire opponents from Rookie to Perfect. Free, unrated practice with increasingly stronger decision-making.",
};

export default function Page() {
  return <SolitairePlayAiPage />;
}
