import Link from "next/link";
import { CATEGORY_GROUPS, SKILL_GROUPS } from "../../lib/gameDiscovery";
import { gameLandingPath } from "../../lib/gameLandingPages";

/**
 * The /games hub's discovery content.
 *
 * A SERVER component, rendered into the hub's HTML before any client state
 * exists. It answers the question the card grid does not: "which of these is
 * for me?" — first by what a game asks of you (skill groups), then by the kind
 * of game it is (category groups, with each game's own one-line description).
 *
 * It is rendered from the same catalogue the pages and the sitemap are built
 * from (src/lib/gameDiscovery.ts), so a newly added game appears here without
 * anyone editing this file, and a game can never be listed under a category it
 * does not actually have.
 *
 * The `/games` A–Z directory below still lists every game as a plain link. This
 * section is the human-readable layer above it, not a replacement.
 */
export default function GameDiscovery() {
  const totalGames = new Set(CATEGORY_GROUPS.flatMap((group) => group.games.map((g) => g.slug)))
    .size;

  return (
    <section aria-labelledby="game-discovery-heading" className="mt-14">
      <h2
        id="game-discovery-heading"
        className="text-2xl font-extrabold tracking-tight text-[#f5ff3b] sm:text-3xl"
      >
        Find a game by what it asks of you
      </h2>
      <p className="mt-2 max-w-3xl text-sm leading-relaxed text-[#9dd8ff]">
        All {totalGames} games on GRYND are free, 1v1 duels against another player, and every result
        moves that game&apos;s own rating and trophy ladder. The difference between them is the
        skill they test — so start there if you are not sure what to play.
      </p>

      {/* ── By skill ─────────────────────────────────────────────────────── */}
      <div className="mt-8 space-y-6">
        {SKILL_GROUPS.map((group) => (
          <div
            key={group.key}
            className="rounded-2xl border border-[#00e5ff]/25 bg-[#040d24] p-5 sm:p-6"
          >
            <h3 className="text-lg font-black tracking-tight text-[#00e5ff]">{group.label}</h3>
            <p className="mt-1 text-sm leading-relaxed text-[#9dd8ff]">{group.description}</p>
            <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-sm">
              {group.games.map((game) => (
                <li key={game.slug}>
                  <Link
                    href={gameLandingPath(game.slug)}
                    className="text-[#d8fbff] underline underline-offset-2 transition-colors hover:text-[#f5ff3b]"
                  >
                    {game.name}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      {/* ── By category ──────────────────────────────────────────────────── */}
      <h2
        id="game-categories-heading"
        className="mt-14 text-2xl font-extrabold tracking-tight text-[#f5ff3b] sm:text-3xl"
      >
        Every game, by category
      </h2>
      <p className="mt-2 max-w-3xl text-sm leading-relaxed text-[#9dd8ff]">
        The same catalogue grouped the way the game pages group it, with each game&apos;s own
        description. Nothing below is a placeholder: every entry is a game you can play right now.
      </p>

      <div className="mt-8 grid gap-5 md:grid-cols-2">
        {CATEGORY_GROUPS.map((group) => (
          <section
            key={group.key}
            aria-labelledby={`category-${group.key}-heading`}
            className="rounded-2xl border border-[#f5ff3b]/20 bg-[#040d24]/70 p-5"
          >
            <h3
              id={`category-${group.key}-heading`}
              className="text-lg font-black tracking-tight text-[#f5ff3b]"
            >
              {group.label}
            </h3>
            <p className="mt-1 text-sm leading-relaxed text-[#9dd8ff]">{group.description}</p>
            <ul className="mt-3 space-y-3">
              {group.games.map((game) => (
                <li key={game.slug}>
                  <Link
                    href={gameLandingPath(game.slug)}
                    className="block rounded-lg px-2 py-1.5 transition-colors hover:bg-[#00e5ff]/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff]"
                  >
                    <span className="font-bold text-[#d8fbff]">{game.name}</span>
                    <span className="mt-0.5 block text-xs leading-relaxed text-[#9dd8ff]">
                      {game.shortDescription}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>

      <p className="mt-8 text-sm text-[#9dd8ff]">
        Not sure how ranked play works yet?{" "}
        <Link href="/faq" className="text-[#00e5ff] underline hover:text-[#f5ff3b]">
          The FAQ covers matches, ratings and trophies
        </Link>
        , and the{" "}
        <Link href="/guides" className="text-[#00e5ff] underline hover:text-[#f5ff3b]">
          guides
        </Link>{" "}
        cover how to get better at the skills above.
      </p>
    </section>
  );
}
