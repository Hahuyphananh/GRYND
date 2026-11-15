import type { Metadata } from "next";

import SolitairePlayAiPage from "../../casino/solitaire-duel/play-ai/PageClient";

export const metadata: Metadata = {
  title: "Play Solitaire vs AI — six opponents | GRYND",
  description:
    "Challenge Rookie, Felix, Ace, Professor, Grandmaster or Perfect. The existing unrated Solitaire bot picker, reachable from the Play hub.",
  alternates: { canonical: "/play/ai" },
};

/**
 * Reuse, do not duplicate: this route renders the SAME bot picker as
 * /casino/solitaire-duel/play-ai. Bot profiles, avatars, match creation and the
 * unrated practice match are untouched.
 */
export default function PlayAiLobbyPage() {
  return <SolitairePlayAiPage />;
}
