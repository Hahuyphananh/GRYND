import type { Metadata } from "next";
import Link from "next/link";

import NavigationBar from "../../components/navigation-bar";
import Footer from "../../components/Footer";
import {
  GAME_INDEX,
  GAME_LANDING_BY_SLUG,
  gameLandingPath,
} from "../../lib/gameLandingPages";
import { ogImageUrl } from "../../lib/ogImages";
import { pageMetadata, DEFAULT_OG_IMAGE } from "../../lib/seo";

/**
 * /games — the public game hub.
 *
 * This is a REAL page. It used to be a `beforeFiles` rewrite to /casino, and
 * /casino redirects to /games/solitaire-duel, so the URL the sitemap lists at
 * priority 0.9 answered with a 200 shell, a generic layout title, `noindex`
 * and a soft redirect. A sitemap may only advertise canonical, indexable URLs,
 * so the hub now renders its own server-side page and owns its own metadata.
 *
 * The directory is projected from GAME_INDEX (src/lib/gameLandingPages.ts),
 * not hand-written, so a game added to the catalogue appears here without
 * anyone remembering to edit this file. Every entry is an ordinary anchor in
 * the HTML response, so a crawler can reach every landing page from here.
 */

const TITLE = "Games on GRYND — free 1v1 Solitaire";
const DESCRIPTION =
  "Browse the games on GRYND. Solitaire Duel is a free, server-verified Klondike race against a real opponent, with ranked, daily, solo and puzzle modes.";

export const metadata = pageMetadata({
  title: TITLE,
  description: DESCRIPTION,
  path: "/games",
  image: DEFAULT_OG_IMAGE,
});

/** The public mode surfaces — the ways to play the one game the hub offers. */
const MODES = [
  {
    href: "/play/ranked",
    label: "Ranked",
    blurb: "Race a real player on the same deterministic deal for Elo and trophies.",
  },
  {
    href: "/play/ai",
    label: "Play vs AI",
    blurb: "Unrated practice against the built-in bot, with a difficulty you choose.",
  },
  {
    href: "/daily",
    label: "Daily Challenge",
    blurb: "One deal every UTC day, identical for every player, with one official result.",
  },
  {
    href: "/solitaire",
    label: "Solo",
    blurb: "A full timed Klondike game at your own pace, with undo and personal bests.",
  },
  {
    href: "/play/daily-puzzle",
    label: "Daily Puzzle",
    blurb: "Three verified positions from one deal — one wrong move ends the run.",
  },
  {
    href: "/play/unlimited-puzzles",
    label: "Unlimited Puzzles",
    blurb: "One position, one best move. Five free puzzles per UTC day, unlimited on PRO.",
  },
];

const H2 = "text-2xl font-black tracking-tight text-[#f5ff3b]";
const CARD =
  "block h-full rounded-2xl border border-[#00e5ff]/30 bg-surface p-5 transition-all hover:-translate-y-0.5 hover:border-[#00e5ff]/60 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[#00e5ff]";

export default function GamesHubPage() {
  return (
    <div className="relative min-h-dvh overflow-x-clip pb-16">
      <NavigationBar currentPath="/games" />

      <div className="mx-auto max-w-4xl px-4 py-8 sm:py-12">
        <nav aria-label="Breadcrumb" className="mb-6 text-xs text-[#9dd8ff]">
          <ol className="flex flex-wrap items-center gap-2">
            <li>
              <Link href="/" className="underline underline-offset-2 hover:text-[#d8fbff]">
                Home
              </Link>
            </li>
            <li aria-hidden="true">/</li>
            <li aria-current="page" className="text-[#d8fbff]">
              Games
            </li>
          </ol>
        </nav>

        <header className="mb-10">
          <p className="mb-3 inline-block rounded-full border border-[#00e5ff]/50 bg-[#00e5ff]/10 px-3 py-1 text-[11px] font-bold uppercase tracking-wider text-[#00e5ff]">
            GRYND Games
          </p>
          <h1 className="text-3xl font-black leading-tight tracking-tight text-[#f5ff3b] sm:text-4xl">
            Games on GRYND
          </h1>
          <p className="mt-4 leading-relaxed text-[#d8fbff]">
            GRYND is built around one game: Klondike Solitaire, played head to head. Both players
            receive the exact same server-dealt board, every move is judged on the server, and a
            ranked result moves an Elo rating and a trophy ladder rather than a pot. There is no
            entry fee and nothing can be bought to improve a result.
          </p>
        </header>

        <section aria-labelledby="every-game-heading" className="mb-12">
          <h2 id="every-game-heading" className={H2}>
            Every game
          </h2>
          <ul className="mt-4 grid gap-4 sm:grid-cols-2">
            {GAME_INDEX.map((game) => {
              const entry = GAME_LANDING_BY_SLUG[game.slug];
              return (
                <li key={game.slug}>
                  <Link href={gameLandingPath(game.slug)} className={CARD}>
                    <span className="block text-lg font-black tracking-tight text-[#f5ff3b]">
                      {game.name}
                    </span>
                    {entry ? (
                      <span className="mt-1.5 block text-sm leading-relaxed text-[#9dd8ff]">
                        {entry.shortDescription}
                      </span>
                    ) : null}
                    <span className="mt-3 block text-sm font-bold text-[#00e5ff]">
                      Read the rules and play →
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>

        <section aria-labelledby="ways-to-play-heading" className="mb-12">
          <h2 id="ways-to-play-heading" className={H2}>
            Ways to play
          </h2>
          <ul className="mt-4 grid gap-4 sm:grid-cols-2">
            {MODES.map((mode) => (
              <li key={mode.href}>
                <Link href={mode.href} className={CARD}>
                  <span className="block font-bold text-[#f5ff3b]">{mode.label}</span>
                  <span className="mt-1 block text-sm leading-relaxed text-[#9dd8ff]">
                    {mode.blurb}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="learn-heading">
          <h2 id="learn-heading" className={H2}>
            Before you play
          </h2>
          <ul className="mt-4 flex flex-wrap gap-x-6 gap-y-2 text-sm">
            <li>
              <Link href="/learn" className="text-[#9dd8ff] underline underline-offset-2 hover:text-[#f5ff3b]">
                GRYND Academy
              </Link>
            </li>
            <li>
              <Link href="/guides" className="text-[#9dd8ff] underline underline-offset-2 hover:text-[#f5ff3b]">
                Strategy guides
              </Link>
            </li>
            <li>
              <Link href="/faq" className="text-[#9dd8ff] underline underline-offset-2 hover:text-[#f5ff3b]">
                How GRYND works
              </Link>
            </li>
            <li>
              <Link href="/classement" className="text-[#9dd8ff] underline underline-offset-2 hover:text-[#f5ff3b]">
                Solitaire leaderboard
              </Link>
            </li>
          </ul>
        </section>
      </div>

      <Footer />
    </div>
  );
}
