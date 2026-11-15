import type { Metadata } from "next";

import SolitairePlayAiPage from "../../casino/solitaire-duel/play-ai/PageClient";

const AI_TITLE = "Play Solitaire vs AI — six opponents | GRYND";
const AI_DESCRIPTION =
  "Challenge Rookie, Felix, Ace, Professor, Grandmaster or Perfect. The existing unrated Solitaire bot picker, reachable from the Play hub.";

export const metadata: Metadata = {
  title: AI_TITLE,
  description: AI_DESCRIPTION,
  alternates: { canonical: "/play/ai" },
  openGraph: {
    title: AI_TITLE,
    description: AI_DESCRIPTION,
    url: "/play/ai",
    type: "website",
  },
  // Card: ./opengraph-image.tsx — unrated bots, explicitly not the ranked lobby.
  twitter: {
    card: "summary_large_image",
    title: AI_TITLE,
    description: AI_DESCRIPTION,
  },
};

/**
 * Reuse, do not duplicate: this route renders the SAME bot picker as
 * /casino/solitaire-duel/play-ai. Bot profiles, avatars, match creation and the
 * unrated practice match are untouched.
 */
export default function PlayAiLobbyPage() {
  return <SolitairePlayAiPage />;
}
