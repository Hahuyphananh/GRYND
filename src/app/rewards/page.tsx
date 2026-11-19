import type { Metadata } from "next";
import PageClient from "./PageClient";
import { pageMetadata, DEFAULT_OG_IMAGE } from "../../lib/seo";

export const metadata = pageMetadata({
  title: "Rewards",
  description: "Track your daily streak and the milestone titles it earns. Finishing a game advances the streak; miss a day and the current streak resets. Coins are virtual and have no cash value.",
  path: "/rewards",
  image: DEFAULT_OG_IMAGE,
});

/**
 * The Rewards surface (/rewards).
 *
 * Publicly reachable — the page itself holds nothing account-specific. The
 * caller's coin balance is read on the client from the EXISTING coin system
 * (the shared useCoinBalance hook, which reads /api/get-user-tokens); this page
 * neither owns nor writes any currency. When a visitor is signed out the page
 * still renders in full and simply prompts them to sign in to see their streak.
 * The streak state is read server-side only (GET /api/user/daily-streak); the
 * page neither advances nor rewrites it.
 */
export default function Page() {
  return <PageClient />;
}
