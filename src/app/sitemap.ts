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
  crashGames,
  diceFlushRooms,
  diceMatches,
  dotsAndBoxesGames,
  hexDuelGames,
  keno_games,
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

const GAME_PAGES: {
  path: string;
  source?: [AnyPgTable, AnyPgColumn];
}[] = [
  { path: "/casino/poker/multi", source: [pokerGames, pokerGames.createdAt] },
  { path: "/casino/blackjack", source: [blackjackGames, blackjackGames.createdAt] },
  { path: "/casino/roulette", source: [rouletteGames, rouletteGames.createdAt] },
  { path: "/casino/plinko", source: [plinkoGames, plinkoGames.createdAt] },
  { path: "/casino/mines-pvp", source: [minesGames, minesGames.createdAt] },
  { path: "/casino/crash-arena", source: [crashArenaRounds, crashArenaRounds.createdAt] },
  { path: "/casino/crash", source: [crashGames, crashGames.createdAt] },
  { path: "/casino/dice-flush", source: [diceFlushRooms, diceFlushRooms.createdAt] },
  { path: "/casino/dice-duel", source: [diceMatches, diceMatches.createdAt] },
  { path: "/casino/keno", source: [kenoPvpMatches, kenoPvpMatches.createdAt] },
  { path: "/casino/rps", source: [rpsPvpGames, rpsPvpGames.createdAt] },
  { path: "/casino/chess", source: [chessGames, chessGames.createdAt] },
  { path: "/casino/connect-four", source: [connectFourGames, connectFourGames.createdAt] },
  {
    path: "/casino/dots-and-boxes",
    source: [dotsAndBoxesGames, dotsAndBoxesGames.createdAt],
  },
  { path: "/casino/pool-masters", source: [poolMatches, poolMatches.createdAt] },
  { path: "/casino/precision", source: [precisionMatches, precisionMatches.createdAt] },
  { path: "/casino/neon-flush" }, // no dedicated table yet → static
  { path: "/casino/hex-duel", source: [hexDuelGames, hexDuelGames.createdAt] },
  { path: "/casino/uno", source: [unoGames, unoGames.createdAt] },
  { path: "/casino/lane-runner", source: [laneRunnerGames, laneRunnerGames.createdAt] },
  { path: "/casino/odds", source: [oddsGames, oddsGames.createdAt] },
  { path: "/casino/memory-grid", source: [memoryGridMatches, memoryGridMatches.createdAt] },
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

  // The /casino index changes whenever any game page does — computed only
  // from real dates so an empty table can't force it to report "now".
  const gameTs = GAME_PAGES.map((p) => lastModified.get(p.path)?.getTime()).filter(
    (t): t is number => typeof t === "number",
  );
  lastModified.set("/casino", gameTs.length ? new Date(Math.max(...gameTs)) : now);

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
    toEntry("/casino", "daily", 0.9),
    toEntry("/classement", "weekly", 0.7),
    ...GAME_PAGES.map((p) => toEntry(p.path, "weekly", 0.8)),
    toEntry("/contact", "monthly", 0.5),
    ...LEGAL_PAGES.map((p) => toEntry(p, "monthly", 0.3)),
  ];
}
