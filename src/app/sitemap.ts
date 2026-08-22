import type { MetadataRoute } from "next";
import { max } from "drizzle-orm";
import type { AnyPgColumn, AnyPgTable } from "drizzle-orm/pg-core";
import { db } from "../db";
import {
  bigWins,
  blackjackGames,
  chessGames,
  connectFourGames,
  crashArenaRounds,
  diceFlushRooms,
  diceMatches,
  dotsAndBoxesGames,
  hexDuelGames,
  laneRunnerGames,
  memoryGridMatches,
  minesGames,
  oddsGames,
  plinkoGames,
  pokerGames,
  poolMatches,
  precisionMatches,
  rouletteGames,
  rpsPvpGames,
  kenoPvpMatches,
  unoGames,
  userStats,
} from "../db/schema";

// Same base-URL convention used by src/lib/emails/*.ts.
const BASE_URL = process.env.NEXT_PUBLIC_APP_URL ?? "https://goonbet.dedyn.io";

// ISR: the XML is prerendered at build time and served instantly from cache,
// then regenerated in the background at most once per hour so the DB-backed
// `lastmod` values stay fresh without a full redeploy. Tune to taste.
export const revalidate = 3600;

/**
 * Latest row timestamp for a table, or null when the table is empty or the
 * database is unreachable (e.g. a build without DATABASE_URL). Callers fall
 * back to the current date, so a broken/absent DB can never fail the build —
 * same guarantee as the lazy db proxy in src/db/client.ts.
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

// ── Page → source table ────────────────────────────────────────────────────
// Each entry maps a sitemap path to the DB table whose newest row represents
// "this page last changed". Omit `source` for pages with no DB representation
// (they fall back to the regeneration date).

// Every path here is a real route under /games/* — the canonical location for
// each game: /games/:path* rewrites to the /casino/:path* app routes and
// stays in the address bar, while /casino/:path* 308-redirects to /games/*
// (see next.config.js). Listing /casino URLs would send crawlers through a
// redirect chain. `/games/crash` is intentionally omitted: it's a redirect to
// `/games/crash-arena` (already listed) and shouldn't be indexed separately.
const GAME_PAGES: {
  path: string;
  source?: [AnyPgTable, AnyPgColumn];
}[] = [
  { path: "/games/poker/multi", source: [pokerGames, pokerGames.createdAt] },
  { path: "/games/blackjack", source: [blackjackGames, blackjackGames.createdAt] },
  { path: "/games/roulette", source: [rouletteGames, rouletteGames.createdAt] },
  { path: "/games/plinko", source: [plinkoGames, plinkoGames.createdAt] },
  { path: "/games/mines-pvp", source: [minesGames, minesGames.createdAt] },
  { path: "/games/crash-arena", source: [crashArenaRounds, crashArenaRounds.createdAt] },
  { path: "/games/dice-flush", source: [diceFlushRooms, diceFlushRooms.createdAt] },
  { path: "/games/dice-duel", source: [diceMatches, diceMatches.createdAt] },
  { path: "/games/keno", source: [kenoPvpMatches, kenoPvpMatches.createdAt] },
  { path: "/games/rps", source: [rpsPvpGames, rpsPvpGames.createdAt] },
  { path: "/games/chess", source: [chessGames, chessGames.createdAt] },
  { path: "/games/connect-four", source: [connectFourGames, connectFourGames.createdAt] },
  {
    path: "/games/dots-and-boxes",
    source: [dotsAndBoxesGames, dotsAndBoxesGames.createdAt],
  },
  { path: "/games/pool-masters", source: [poolMatches, poolMatches.createdAt] },
  { path: "/games/precision", source: [precisionMatches, precisionMatches.createdAt] },
  { path: "/games/neon-flush" }, // no dedicated table yet → static
  { path: "/games/hex-duel", source: [hexDuelGames, hexDuelGames.createdAt] },
  { path: "/games/uno", source: [unoGames, unoGames.createdAt] },
  { path: "/games/uno/multiplayer" }, // same game, no separate table
  { path: "/games/lane-runner", source: [laneRunnerGames, laneRunnerGames.createdAt] },
  { path: "/games/odds", source: [oddsGames, oddsGames.createdAt] },
  { path: "/games/memory-grid", source: [memoryGridMatches, memoryGridMatches.createdAt] },
];

const LEGAL_PAGES = ["/terms", "/privacy-policy", "/security-policy", "/fair-play", "/accessibility"];

type ChangeFrequency = MetadataRoute.Sitemap[number]["changeFrequency"];

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const now = new Date();

  // Fire every DB lookup in parallel, keyed by path. Only genuine DB dates
  // are stored — empty tables and failures leave the map untouched, so a
  // fresh page never claims to have been "modified now".
  const lastModified = new Map<string, Date>();

  const record = async (path: string, promise: Promise<Date | null>) => {
    const ts = await promise;
    if (ts) lastModified.set(path, ts);
  };

  const queries: Promise<void>[] = [
    record("/", latestOf(bigWins, bigWins.createdAt)),
    record("/classement", latestOf(userStats, userStats.updatedAt)),
  ];

  for (const page of GAME_PAGES) {
    if (page.source) {
      queries.push(record(page.path, latestOf(page.source[0], page.source[1])));
    }
  }

  await Promise.all(queries);

  // The /games index changes whenever any game page does — computed only
  // from real dates so an empty table can't force it to report "now".
  const gameTs = GAME_PAGES.map((p) => lastModified.get(p.path)?.getTime()).filter(
    (t): t is number => typeof t === "number",
  );
  lastModified.set("/games", gameTs.length ? new Date(Math.max(...gameTs)) : now);

  const toEntry = (path: string, changeFrequency: ChangeFrequency, priority: number) => {
    const entry: MetadataRoute.Sitemap[number] = {
      url: `${BASE_URL}${path}`,
      changeFrequency,
      priority,
    };
    // lastmod is optional in the protocol — omit it when there's no real
    // data instead of inventing a date. `/casino` always has one via the max.
    const real = lastModified.get(path);
    if (real) entry.lastModified = real;
    return entry;
  };

  return [
    toEntry("/", "daily", 1),
    toEntry("/games", "daily", 0.9),
    toEntry("/classement", "weekly", 0.7),
    ...GAME_PAGES.map((p) => toEntry(p.path, "weekly", 0.8)),
    toEntry("/contact", "monthly", 0.5),
    ...LEGAL_PAGES.map((p) => toEntry(p, "monthly", 0.3)),
  ];
}
