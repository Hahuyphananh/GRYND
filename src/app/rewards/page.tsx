import type { Metadata } from "next";
import PageClient from "./PageClient";
import { pageMetadata, DEFAULT_OG_IMAGE } from "../../lib/seo";

export const metadata = pageMetadata({
  title: "Rewards",
  description: "Track your daily streak and the milestone titles it earns. Finishing a game advances the streak; miss a day and the current streak resets.",
  path: "/rewards",
  image: DEFAULT_OG_IMAGE,
});

/**
 * The Rewards surface (/rewards).
 *
 * Publicly reachable — the page itself holds nothing account-specific. The
 * coin wallet and coin shop were removed with the coin system, so this surface
 * is the streak ladder only. The streak state is read server-side only
 * (GET /api/user/daily-streak); the page neither advances nor rewrites it.
 */
export default function Page() {
  return <PageClient />;
}
