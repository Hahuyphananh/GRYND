import type { Metadata } from "next";
import GameLanding from "../../../components/game-landing/GameLanding";
import { ogImageUrl } from "../../../lib/ogImages";
import {
  GAME_LANDING_BY_SLUG,
  GAME_LANDING_SLUGS,
  SITE_ORIGIN,
  gameLandingPath,
  gameLandingUrl,
  relatedGames,
} from "../../../lib/gameLandingPages";

/**
 * /games/<slug> — the PUBLIC, indexable landing page for a game.
 *
 * This route is the SEO surface for every game: server-rendered content, one
 * canonical URL, its own Open Graph card. It is deliberately NOT the game
 * application — the hero's Play CTA links to `/games/<slug>/play` instead.
 *
 * ── How this URL resolves ─────────────────────────────────────────────────
 *
 * next.config.js rewrites the /games BATTLE SHAPES explicitly (`beforeFiles`):
 * `/games` to the hub, `/games/<slug>/play` to that game's lobby, and
 * `/games/<slug>/<...more>` to the matching deep app route. Bare
 * `/games/<slug>` is matched by nothing, so it lands here.
 *
 * There is no blanket `/games/:path*` catch-all any more. It used to exist, and
 * left in place it kept winning for `/games/<slug>` — the landing-page URL
 * served the game lobby instead of this page. Enumerating the sub-path shapes
 * is what makes the landing/lobby split deterministic.
 *
 * ── Unknown slugs ─────────────────────────────────────────────────────────
 *
 * They 404 at the ROUTING layer, and `dynamicParams = false` below is what
 * provides that. Calling `notFound()` from the component was measured to return
 * HTTP 200 with the not-found UI in the body: the root layout is
 * `force-dynamic` and streams, so the shell (and its 200 status) is committed
 * before the page can throw, and the status can no longer be corrected.
 * Declaring the slug space up front makes Next reject an unknown param before
 * any rendering happens — a real 404, the same way `/games/chess/ai/nope`
 * already 404s.
 *
 * That is also why the 21 slugs live in src/lib/gameLandingPages.ts and are
 * mapped here rather than left implicit: one list feeds the pages, the sitemap,
 * the tests and this param set, so they cannot drift.
 */

export const dynamicParams = false;

/** The complete public slug space — anything else is a routing-layer 404. */
export function generateStaticParams(): { slug: string }[] {
  return GAME_LANDING_SLUGS.map((slug) => ({ slug }));
}

/**
 * Per-game metadata.
 *
 * Deliberately a SINGLE return statement: `scripts/audit-social-metadata.mjs`
 * resolves the returned object literal statically to check that a page-local
 * `openGraph` re-declares every field it would otherwise drop (title,
 * description, url, siteName, locale, type) and that it carries an image. An
 * early return for the unknown-slug case would make the auditor analyse that
 * branch instead of the real block, silently dropping this page from coverage.
 *
 * `dynamicParams = false` already 404s an unknown slug before this runs, so the
 * fallbacks below exist only to keep that single shape — they are not a
 * reachable "game not found" page.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const game = GAME_LANDING_BY_SLUG[slug];

  const headline = game ? game.headline : "Game not found";
  const title = `${headline} | GRYND`;
  const description = game
    ? game.shortDescription
    : "This game page does not exist. Browse every competitive 1v1 game on GRYND instead.";
  const image = ogImageUrl(game ? game.ogImage : "/images/og-banner.png");
  const canonical = game ? gameLandingPath(slug) : "/games";
  const ogUrl = game ? gameLandingUrl(slug) : `${SITE_ORIGIN}/games`;

  return {
    title,
    description,
    alternates: { canonical },
    // Only the (unreachable) fallback is noindex; a real game page is indexable
    // and owns its own canonical.
    ...(game ? {} : { robots: { index: false, follow: true } }),
    openGraph: {
      title,
      description,
      url: ogUrl,
      siteName: "GRYND",
      locale: "en_US",
      type: "website",
      images: [{ url: image, width: 1200, height: 630, alt: headline }],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [image],
    },
  };
}

export default async function GameLandingRoute({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const game = GAME_LANDING_BY_SLUG[slug];
  if (!game) return null;

  return <GameLanding game={game} related={relatedGames(slug)} />;
}
