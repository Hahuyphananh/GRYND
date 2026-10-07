import type { MetadataRoute } from "next";
import { max } from "drizzle-orm";
import type { AnyPgColumn, AnyPgTable } from "drizzle-orm/pg-core";
import { getSiteUrl } from "../lib/siteUrl";
import { db } from "../db";
import { PUBLIC_SEO_PAGES } from "../lib/seoPages";

// Same base-URL convention used by src/lib/emails/*.ts. The shared resolver
// strips trailing slashes and refuses a retired host, so a stale env var can
// never list sitemap URLs on a domain that no longer serves the site.
const BASE_URL = getSiteUrl();

// ISR: the XML is prerendered at build time and served instantly from cache,
// then regenerated in the background at most once per hour so the DB-backed
// `lastmod` values stay fresh without a full redeploy. Tune to taste.
export const revalidate = 3600;

// ── Which URL is in the sitemap ───────────────────────────────────────────
// NOT HERE. The inventory lives in ONE place — src/lib/seoPages.ts — and the
// game entries in it are generated from the game catalog
// (GAME_LANDING_PAGES), so adding a game publishes its URL automatically and
// forgetting to edit this file can no longer silently drop a page from the
// crawl. This route only turns that inventory into XML and resolves the
// `lastmod` dates. `tests/sitemap.test.mjs` owns the rules about what may
// appear there: canonical, public, indexable URLs only.

/**
 * Latest row timestamp for a table, or null when the table is empty or the
 * database is unreachable (e.g. a build without DATABASE_URL). Callers omit
 * `lastmod`, so a broken/absent DB can never fail the build — same guarantee
 * as the lazy db proxy in src/db/client.ts.
 */
function latestOf(table: AnyPgTable, column: AnyPgColumn): Promise<Date | null> {
  try {
    return db
      .select({ ts: max(column) })
      .from(table)
      .then((rows) => (rows[0]?.ts as Date | null) ?? null)
      .catch((err) => {
        // Only log when a DB was expected — builds without DATABASE_URL
        // intentionally fall back and should stay silent.
        if (process.env.DATABASE_URL) {
          console.error("[sitemap] failed to fetch last-modified date:", err);
        }
        return null;
      });
  } catch {
    return Promise.resolve(null);
  }
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const now = new Date();

  // One query per DISTINCT freshness source. Several pages deliberately share
  // one table — the two UNO-family landing pages, and the home page with the
  // ladder — and re-querying it per page would scale with page count for no
  // extra information. Keyed by the column object, which is the same imported
  // instance everywhere it is referenced.
  const sources = new Map<AnyPgColumn, { table: AnyPgTable; column: AnyPgColumn }>();
  for (const page of PUBLIC_SEO_PAGES) {
    if (page.freshness) sources.set(page.freshness.column, page.freshness);
  }

  const resolved = new Map<AnyPgColumn, Date | null>();
  await Promise.all(
    [...sources.values()].map(async ({ table, column }) => {
      resolved.set(column, await latestOf(table, column));
    }),
  );

  // Fire every lookup in parallel, keyed by path. Only genuine DB dates are
  // stored — empty tables and failures leave the map untouched, so a fresh
  // page never claims to have been "modified now".
  const lastModified = new Map<string, Date>();
  for (const page of PUBLIC_SEO_PAGES) {
    const ts = page.freshness ? resolved.get(page.freshness.column) : null;
    if (ts) lastModified.set(page.path, ts);
  }

  // The /games index changes whenever any game landing page does — computed
  // only from real dates so an empty table can't force it to report "now".
  const gameTs = PUBLIC_SEO_PAGES.filter((page) => page.group === "games")
    .map((page) => lastModified.get(page.path)?.getTime())
    .filter((ts): ts is number => typeof ts === "number");

  for (const page of PUBLIC_SEO_PAGES) {
    if (page.group !== "hub") continue;
    lastModified.set(page.path, gameTs.length ? new Date(Math.max(...gameTs)) : now);
  }

  // One entry per inventory page, in inventory order. `url` is absolute by
  // construction: BASE_URL is an origin with no trailing slash and every path
  // in the inventory starts with one.
  return PUBLIC_SEO_PAGES.map((page) => {
    const entry: MetadataRoute.Sitemap[number] = {
      url: `${BASE_URL}${page.path}`,
      changeFrequency: page.changeFrequency,
      priority: page.priority,
    };
    // lastmod is optional in the protocol — omit it when there is no real
    // data instead of inventing a date.
    const real = lastModified.get(page.path);
    if (real) entry.lastModified = real;
    return entry;
  });
}
