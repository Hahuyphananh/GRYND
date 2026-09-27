// src/app/evaluation/[gameKey]/[matchId]/page.tsx
//
// The shared Game Evaluation page.
//
// It mirrors the conventions of the other dynamic game pages in this app
// (src/app/casino/chess-game/[gameId]/page.jsx): a tiny server component that
// resolves the route params, sets metadata, and hands the rendering to a
// `PageClient`. All of the real work — auth, the Free/Pro limit, the engine,
// the model — lives behind POST /api/evaluation/[gameKey]/[matchId] (see
// src/lib/evaluation/evaluationService.ts); this route only renders it.
//
// It is deliberately ONE page for every game: adding a game means adding an
// evaluator server-side, not another route here.
//
// The caller must be signed in: /evaluation is not in the proxy's public
// matcher, so Clerk's middleware redirects a signed-out visitor to /sign-in
// (and an account with no recorded age to /complete-profile), exactly like
// every other protected app page.

import PageClient from "./PageClient";
import { getRatingGameLabel } from "../../../../lib/rating";

export async function generateMetadata({ params }) {
  const resolved = (await params) || {};
  const gameKey = String(resolved.gameKey ?? "")
    .trim()
    .toLowerCase();
  const matchId = String(resolved.matchId ?? "").trim();
  const label = getRatingGameLabel(gameKey);
  const shortId = matchId.length > 8 ? matchId.slice(0, 8) : matchId;

  return {
    title: `${label} Evaluation${shortId ? ` #${shortId}` : ""} | GRYND`,
    description: `An engine-backed, AI-written breakdown of your ${label} match: accuracy, blunders, the moments that decided it, and what to work on next.`,
    // Personal match analysis — never indexed.
    robots: { index: false, follow: false },
  };
}

export default async function Page({ params }) {
  const resolved = (await params) || {};
  const gameKey = String(resolved.gameKey ?? "")
    .trim()
    .toLowerCase();
  return <PageClient gameLabel={getRatingGameLabel(gameKey)} />;
}
