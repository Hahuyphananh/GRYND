// src/lib/guideJsonLd.ts
//
// Structured data for the guide pages (src/lib/guides.ts).
//
// Two nodes, both describing something the page already renders:
//
//   * an Article, whose author and publisher are the GRYND ORGANISATION node —
//     NOT an invented person. The site has no bylines and no fake author
//     profiles, and marking up a fictional author would be exactly the kind of
//     markup that earns a manual action.
//   * a BreadcrumbList mirroring the visible Home → Guides → guide trail.
//
// Deliberately absent: datePublished / dateModified, because there is no real
// publication date to report and inventing one is worse than omitting it (the
// same rule src/lib/reviewJsonLd.ts applies to ratings).

import { ORGANIZATION_ID, WEBSITE_ID, type JsonLdNode } from "./reviewJsonLd";
import { GUIDE_BY_SLUG, GUIDE_SLUGS, guideUrl } from "./guides";
import { SITE_ORIGIN } from "./gameLandingPages";

/** The stable @id of a guide's Article node. */
export function guideArticleId(slug: string): string {
  return `${guideUrl(slug)}#article`;
}

/** The Article node for one guide, or null when the slug is unknown. */
export function buildGuideArticleJsonLd(slug: string): JsonLdNode | null {
  const guide = GUIDE_BY_SLUG[slug];
  if (!guide) return null;

  const url = guideUrl(slug);
  return {
    "@context": "https://schema.org",
    "@type": "Article",
    "@id": guideArticleId(slug),
    headline: guide.h1,
    name: guide.title,
    description: guide.metaDescription,
    url,
    mainEntityOfPage: url,
    inLanguage: "en",
    author: { "@id": ORGANIZATION_ID },
    publisher: { "@id": ORGANIZATION_ID },
    isPartOf: { "@id": WEBSITE_ID },
  };
}

/** The visible Home → Guides → guide trail, as a BreadcrumbList. */
export function buildGuideBreadcrumbJsonLd(slug: string): JsonLdNode | null {
  const guide = GUIDE_BY_SLUG[slug];
  if (!guide) return null;

  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    "@id": `${guideUrl(slug)}#breadcrumb`,
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Home", item: `${SITE_ORIGIN}/` },
      { "@type": "ListItem", position: 2, name: "Guides", item: `${SITE_ORIGIN}/guides` },
      { "@type": "ListItem", position: 3, name: guide.title, item: guideUrl(slug) },
    ],
  };
}

/** Everything a guide page declares, filtered to the nodes that exist. */
export function buildGuideStructuredData(slug: string): JsonLdNode[] {
  return [buildGuideArticleJsonLd(slug), buildGuideBreadcrumbJsonLd(slug)].filter(
    (node): node is JsonLdNode => node !== null
  );
}

/** Every guide slug that has structured data (i.e. all of them), for tests. */
export const GUIDE_STRUCTURED_DATA_SLUGS: readonly string[] = GUIDE_SLUGS;
