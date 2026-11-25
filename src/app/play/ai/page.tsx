import type { Metadata } from "next";

import SolitairePlayAiPage from "../../casino/solitaire-duel/play-ai/PageClient";
import { pageMetadata } from "../../../lib/seo";

const AI_TITLE = "Play Solitaire vs AI — six opponents | GRYND";
const AI_DESCRIPTION =
  "Challenge Rookie, Felix, Ace, Professor, Grandmaster or Perfect. The existing unrated Solitaire bot picker, reachable from the Play hub.";

export const metadata = pageMetadata({
  title: AI_TITLE,
  description: AI_DESCRIPTION,
  path: "/play/ai",
});

/**
 * Reuse, do not duplicate: this route renders the SAME bot picker as
 * /casino/solitaire-duel/play-ai. Bot profiles, avatars, match creation and the
 * unrated practice match are untouched.
 */
export default function PlayAiLobbyPage() {
  return <SolitairePlayAiPage />;
}
