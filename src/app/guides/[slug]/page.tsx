import type { Metadata } from "next";
import GuideArticle from "../../../components/guides/GuideArticle";
import { ogImageUrl } from "../../../lib/ogImages";
import {
  GUIDE_BY_SLUG,
  GUIDE_SLUGS,
  SITE_ORIGIN,
  guidePath,
  guideUrl,
  relatedGuidesFor,
} from "../../../lib/guides";

/**
 * /guides/<slug> — one PUBLIC, indexable guide.
 *
 * Same architecture as the game landing pages (src/app/games/[slug]/page.tsx):
 * a server-rendered article, one canonical URL, its own Open Graph card, and
 * `dynamicParams = false` so an unknown slug is a routing-layer 404 rather than
 * a soft 404 rendered after the shell has already been flushed with a 200.
 *
 * The article body lives in src/lib/guides.ts and is rendered by
 * src/components/guides/GuideArticle.tsx, so this route is only the URL and its
 * metadata.
 */

export const dynamicParams = false;

/** The complete public guide slug space — anything else is a 404. */
export function generateStaticParams(): { slug: string }[] {
  return GUIDE_SLUGS.map((slug) => ({ slug }));
}

/**
 * Per-guide metadata.
 *
 * Deliberately a SINGLE return statement, for the same reason the game page
 * documents: scripts/audit-social-metadata.mjs resolves the returned object
 * literal statically, and an early return would make it analyse the fallback
 * branch instead of the real block. `dynamicParams = false` already 404s an
 * unknown slug before this runs.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const guide = GUIDE_BY_SLUG[slug];

  const title = `${guide ? guide.title : "Guide not found"} | GRYND`;
  const description = guide
    ? guide.metaDescription
    : "This guide does not exist. Browse every GRYND guide instead.";
  const image = ogImageUrl("/images/og-banner.png");
  const canonical = guide ? guidePath(slug) : "/guides";
  const ogUrl = guide ? guideUrl(slug) : `${SITE_ORIGIN}/guides`;

  return {
    title,
    description,
    alternates: { canonical },
    // A real guide is indexable and owns its own canonical; only the
    // (unreachable) fallback is noindex.
    ...(guide ? {} : { robots: { index: false, follow: true } }),
    openGraph: {
      title,
      description,
      url: ogUrl,
      siteName: "GRYND",
      locale: "en_US",
      type: "article",
      images: [{ url: image, width: 1200, height: 630, alt: guide ? guide.title : "GRYND Guides" }],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [image],
    },
  };
}

export default async function GuidePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const guide = GUIDE_BY_SLUG[slug];
  if (!guide) return null;

  return <GuideArticle guide={guide} related={relatedGuidesFor(slug)} />;
}
