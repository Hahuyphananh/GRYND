// src/lib/seo.ts
//
// THE ONE PLACE A PAGE'S SEARCH/SOCIAL IDENTITY IS BUILT.
//
// Every indexable page used to hand-write its own `metadata` object: title,
// description, canonical, openGraph (title, description, url, siteName,
// locale, type, images) and twitter (card, title, description, images). That
// duplication drifted in exactly the ways duplication does:
//
//   * titles ended in "| GRYND", "— GRYND", "— GRYND Academy" or no brand at
//     all, depending on when the page was written;
//   * some pages set openGraph but no twitter card, or a canonical but no
//     openGraph.url, so the same page previewed differently in different
//     places;
//   * /classement still described a multi-game catalogue that no longer exists.
//
// `pageMetadata` now owns that shape. A page supplies only what is genuinely
// page-owned — its title, its description and its path — and the helper
// derives the rest. The rules it encodes:
//
//   1. ONE TITLE SUFFIX. Titles are "%s | GRYND". A title that already ends in
//      "| GRYND" is not suffixed twice. Two deliberate voices are preserved:
//      a brand-first homepage title ("GRYND — …") and the Academy product
//      title ("… — GRYND Academy").
//   2. CANONICAL AND og:url COME FROM THE SAME PATH. They can never disagree,
//      and both are absolute (crawlers fetch og:image/og:url directly).
//   3. SOCIAL CARDS ARE COMPLETE. Every page gets siteName, locale, type and a
//      summary_large_image card, so a shared link never falls back to a
//      thumbnail or a blank card.
//   4. IMAGES ARE OPT-IN. A route with its own `opengraph-image.tsx` must not
//      have a default banner injected, or the file convention would be
//      replaced by a generic image. Pass `image` only when the page has no
//      file-based card (or wants an explicit one).
//   5. DESCRIPTIONS STAY PAGE-OWNED. Nothing here writes marketing copy: the
//      page that knows what it contains states it, and the helper only carries
//      it to every surface.
//
// The origin comes from lib/siteUrl.ts (via lib/ogImages.ts), so a retired
// host can never leak into a canonical or a social card.

import type { Metadata } from "next";

import { ogImageUrl } from "./ogImages";

/** The site name, as it must appear in titles, og:site_name and JSON-LD. */
export const SITE_NAME = "GRYND";

/** The single title suffix. */
export const TITLE_SUFFIX = ` | ${SITE_NAME}`;

/** The 1200×630 brand banner, reused by pages with no card of their own. */
export const DEFAULT_OG_IMAGE = "/images/og-banner.png";

/** Alias used by the dynamic routes where the banner is a fallback. */
export const DEFAULT_SOCIAL_IMAGE = DEFAULT_OG_IMAGE;

/**
 * A page title with exactly one site suffix.
 *
 * Explicitly preserved as-is:
 *   • brand-first homepage titles beginning "GRYND —",
 *   • the Academy product title ending "— GRYND Academy",
 * because in both the page name and the brand are one phrase.
 */
export function withSiteTitle(title: string): string {
  const trimmed = title.trim().replace(/\s*\|\s*GRYND$/, "");
  if (/^GRYND\s+—/.test(trimmed)) return trimmed;
  if (/\s—\sGRYND Academy$/.test(trimmed)) return trimmed;
  return `${trimmed}${TITLE_SUFFIX}`;
}

export type PageMetadataInput = {
  /** Page-owned title, without the "| GRYND" suffix. */
  title: string;
  /** Page-owned description. */
  description: string;
  /** The canonical path, e.g. "/guides" or "/play/ai". */
  path: string;
  /**
   * Root-relative or absolute social image. Omit for routes that ship their
   * own `opengraph-image.tsx`.
   */
  image?: string;
  /** Alt text for the social image; defaults to the full title. */
  imageAlt?: string;
  type?: "website" | "article" | "video.other";
  robots?: Metadata["robots"];
  other?: Metadata["other"];
};

/**
 * Build the complete `Metadata` for an indexable page.
 *
 * ```ts
 * export const metadata = pageMetadata({
 *   title: "Solitaire guides",
 *   description: "…",
 *   path: "/guides",
 *   image: DEFAULT_SOCIAL_IMAGE,
 * });
 * ```
 */
export function pageMetadata({
  title,
  description,
  path,
  image,
  imageAlt,
  type = "website",
  robots,
  other,
}: PageMetadataInput): Metadata {
  const fullTitle = withSiteTitle(title);
  const absoluteImage = image ? ogImageUrl(image) : null;

  return {
    title: fullTitle,
    description,
    alternates: { canonical: path },
    ...(robots ? { robots } : {}),
    ...(other ? { other } : {}),
    openGraph: {
      title: fullTitle,
      description,
      url: ogImageUrl(path),
      siteName: SITE_NAME,
      locale: "en_US",
      type,
      ...(absoluteImage
        ? {
            images: [
              {
                url: absoluteImage,
                width: 1200,
                height: 630,
                alt: imageAlt ?? fullTitle,
              },
            ],
          }
        : {}),
    },
    twitter: {
      card: "summary_large_image",
      title: fullTitle,
      description,
      ...(absoluteImage ? { images: [absoluteImage] } : {}),
    },
  };
}
