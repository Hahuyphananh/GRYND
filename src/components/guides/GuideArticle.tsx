import Link from "next/link";
import NavigationBar from "../navigation-bar";
import Footer from "../Footer";
import JsonLd from "../seo/JsonLd";
import { guidePath, type Guide } from "../../lib/guides";
import { GAME_LANDING_BY_SLUG, gameLandingPath } from "../../lib/gameLandingPages";
import { buildGuideStructuredData } from "../../lib/guideJsonLd";

/**
 * The ONE public guide page component.
 *
 * Every `/guides/<slug>` page is rendered from this component with its catalog
 * entry (src/lib/guides.ts), so the twelve pages cannot drift apart and no page
 * duplicates this JSX. It is a SERVER component on purpose: the whole article —
 * H1, summary, every section and every link — is in the HTML response, so a
 * crawler (or a visitor with JavaScript disabled) reads all of it without
 * executing a script.
 *
 * The links out are deliberately few and contextual: the games the guide
 * actually discusses, the guides worth reading next, and the informational
 * pages the article refers to. This is a reading surface, not a link farm.
 */
export default function GuideArticle({ guide, related }: { guide: Guide; related: Guide[] }) {
  // The games this guide names, resolved from the game catalogue. Unknown
  // slugs are dropped rather than rendered as a link to a 404, and the guide
  // is authored against real games (tests/guides.test.mjs asserts it).
  const games = guide.gameSlugs
    .map((slug) => GAME_LANDING_BY_SLUG[slug])
    .filter((game): game is NonNullable<typeof game> => Boolean(game));

  return (
    <div className="relative min-h-screen overflow-x-clip pb-16">
      <NavigationBar currentPath="/guides" />

      <JsonLd data={buildGuideStructuredData(guide.slug)} />

      <div className="mx-auto max-w-3xl px-4 py-8 sm:py-12">
        {/* Breadcrumb — real links, and it tells a visitor where this page
            sits in the site. */}
        <nav aria-label="Breadcrumb" className="mb-6 text-xs text-[#9dd8ff]">
          <ol className="flex flex-wrap items-center gap-2">
            <li>
              <Link href="/" className="underline underline-offset-2 hover:text-[#d8fbff]">
                Home
              </Link>
            </li>
            <li aria-hidden="true">/</li>
            <li>
              <Link href="/guides" className="underline underline-offset-2 hover:text-[#d8fbff]">
                Guides
              </Link>
            </li>
            <li aria-hidden="true">/</li>
            <li aria-current="page" className="text-[#d8fbff]">
              {guide.title}
            </li>
          </ol>
        </nav>

        {/* ── Article ─────────────────────────────────────────────────────── */}
        <article>
          <header className="mb-10">
            <p className="mb-3 inline-block rounded-full border border-[#00e5ff]/50 bg-[#00e5ff]/10 px-3 py-1 text-[11px] font-bold uppercase tracking-wider text-[#00e5ff]">
              GRYND Guides · Skill
            </p>
            <h1 className="text-3xl font-black leading-tight tracking-tight text-[#f5ff3b] sm:text-4xl">
              {guide.h1}
            </h1>
            <p className="mt-4 text-base leading-relaxed text-[#d8fbff]">{guide.summary}</p>
          </header>

          <div className="space-y-10">
            {guide.sections.map((section) => (
              <section key={section.heading}>
                <h2 className="mb-3 text-2xl font-extrabold tracking-tight text-[#f5ff3b]">
                  {section.heading}
                </h2>
                {section.paragraphs?.map((paragraph) => (
                  <p key={paragraph} className="mt-3 leading-relaxed text-[#d8fbff]">
                    {paragraph}
                  </p>
                ))}
                {section.bullets && (
                  <ul className="mt-4 space-y-2">
                    {section.bullets.map((bullet) => (
                      <li key={bullet} className="flex gap-3 text-[#d8fbff]">
                        <span
                          aria-hidden="true"
                          className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-[#00e5ff]"
                        />
                        <span>{bullet}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            ))}
          </div>
        </article>

        {/* ── Games in this guide ─────────────────────────────────────────── */}
        {games.length > 0 && (
          <section
            aria-labelledby="guide-games-heading"
            className="mt-12 rounded-2xl border border-[#00e5ff]/25 bg-[#040d24] p-6"
          >
            <h2
              id="guide-games-heading"
              className="text-xl font-black tracking-tight text-[#f5ff3b]"
            >
              Games in this guide
            </h2>
            <p className="mt-1.5 text-sm text-[#9dd8ff]">
              Every game below is free to play and 1v1 against another player. Each one has its own
              page with the rules, the scoring and the strategy.
            </p>
            <ul className="mt-4 grid gap-3 sm:grid-cols-2">
              {games.map((game) => (
                <li key={game.slug}>
                  <Link
                    href={gameLandingPath(game.slug)}
                    className="block h-full rounded-xl border border-[#00e5ff]/30 bg-[#061329] p-4 transition-all hover:-translate-y-0.5 hover:border-[#00e5ff]/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff]"
                  >
                    <span className="block font-bold text-[#f5ff3b]">{game.name}</span>
                    <span className="mt-1 block text-sm leading-relaxed text-[#9dd8ff]">
                      {game.shortDescription}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* ── Read next ───────────────────────────────────────────────────── */}
        {related.length > 0 && (
          <section aria-labelledby="guide-related-heading" className="mt-10">
            <h2
              id="guide-related-heading"
              className="text-xl font-black tracking-tight text-[#f5ff3b]"
            >
              Read next
            </h2>
            <ul className="mt-4 space-y-3">
              {related.map((entry) => (
                <li key={entry.slug}>
                  <Link
                    href={guidePath(entry.slug)}
                    className="block rounded-xl border border-[#00e5ff]/25 bg-[#040d24] p-4 transition-all hover:border-[#00e5ff]/55 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff]"
                  >
                    <span className="block font-bold text-[#00e5ff]">{entry.title}</span>
                    <span className="mt-1 block text-sm leading-relaxed text-[#9dd8ff]">
                      {entry.metaDescription}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* ── Informational links ─────────────────────────────────────────── */}
        <nav
          aria-labelledby="guide-info-heading"
          className="mt-10 rounded-2xl border border-[#00e5ff]/25 bg-[#040d24] p-6"
        >
          <h2 id="guide-info-heading" className="text-xl font-black tracking-tight text-[#f5ff3b]">
            Keep going
          </h2>
          <ul className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-sm">
            <li>
              <Link
                href="/guides"
                className="text-[#9dd8ff] underline underline-offset-2 transition-colors hover:text-[#f5ff3b]"
              >
                All GRYND guides
              </Link>
            </li>
            <li>
              <Link
                href="/games"
                className="text-[#9dd8ff] underline underline-offset-2 transition-colors hover:text-[#f5ff3b]"
              >
                Browse every game
              </Link>
            </li>
            <li>
              <Link
                href="/faq"
                className="text-[#9dd8ff] underline underline-offset-2 transition-colors hover:text-[#f5ff3b]"
              >
                How GRYND works — FAQ
              </Link>
            </li>
            <li>
              <Link
                href="/fair-play"
                className="text-[#9dd8ff] underline underline-offset-2 transition-colors hover:text-[#f5ff3b]"
              >
                Fair Play Policy
              </Link>
            </li>
          </ul>
        </nav>

        {/* ── Closing CTA ─────────────────────────────────────────────────── */}
        <section
          aria-labelledby="guide-cta-heading"
          className="mt-10 rounded-2xl border border-[#f5ff3b]/35 bg-gradient-to-r from-[#0a214d]/90 to-[#08142f]/90 p-6"
        >
          <h2
            id="guide-cta-heading"
            className="text-xl font-black tracking-tight text-[#f5ff3b] sm:text-2xl"
          >
            Put it into practice
          </h2>
          <p className="mt-1.5 text-sm text-[#d8fbff]">
            Every game on GRYND is free to play, 1v1 against another player, and results move a
            per-game rating and trophy ladder. Pick one game and give the advice above a real test.
          </p>
          <Link
            href="/games"
            className="mt-4 inline-flex items-center justify-center gap-2 rounded-lg border border-[#f5ff3b]/60 bg-[#f5ff3b] px-6 py-3 text-base font-bold text-[#041125] transition-all hover:bg-[#f5ff3b]/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f5ff3b] focus-visible:ring-offset-2 focus-visible:ring-offset-[#08142f]"
          >
            Choose a game
          </Link>
        </section>
      </div>

      <Footer />
    </div>
  );
}
