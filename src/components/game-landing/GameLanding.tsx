import Link from "next/link";
import NavigationBar from "../navigation-bar";
import Footer from "../Footer";
import JsonLd from "../seo/JsonLd";
import { gameLandingPath, gamePlayPath, type GameLandingPage } from "../../lib/gameLandingPages";
import { buildGameStructuredData } from "../../lib/gameJsonLd";
import { guidePath, guidesForGame } from "../../lib/guides";

/**
 * The ONE public game landing page component.
 *
 * Every `/games/<slug>` page is rendered from this component with its catalog
 * entry (src/lib/gameLandingPages.ts step), so the 21 public pages cannot drift
 * apart and no page duplicates this JSX.
 *
 * It is a SERVER component on purpose: all of the SEO content — the H1, the
 * explanation, the rules, the scoring, the tips and the FAQ — is rendered into
 * the HTML response itself, so a crawler (and a visitor with JavaScript
 * disabled) reads the whole page without executing a script. Nothing here
 * needs client state, so nothing here is deferred to the browser.
 *
 * The Play CTA points at `/games/<slug>/play`, which next.config.js rewrites to
 * the existing `/casino/<slug>` lobby. That route stays exactly as it was: the
 * same Clerk-protected clients, matchmaking and game APIs. The landing page
 * deliberately knows nothing about any of it — it only links there.
 */
export default function GameLanding({
  game,
  related,
}: {
  game: GameLandingPage;
  related: GameLandingPage[];
}) {
  const playHref = gamePlayPath(game.slug);

  // Every node this page declares — its own application identity, its
  // breadcrumb and its FAQ — built from the SAME catalogue entry that is
  // rendered below, so the markup cannot describe a page other than this one.
  // src/lib/gameJsonLd.ts documents what is deliberately absent (no rating, no
  // review, no price) and why.
  const structuredData = buildGameStructuredData(game.slug);

  // The guides that genuinely discuss THIS game, capped at three so the rail
  // stays a next step rather than a link dump. A game no guide covers simply
  // renders no rail. Resolved from the guide catalogue, so adding a guide that
  // names a game lists it here automatically.
  const gameGuides = guidesForGame(game.slug).slice(0, 3);

  return (
    <div className="relative min-h-screen overflow-x-clip pb-16">
      <NavigationBar currentPath="/games" />

      {/* Structured data through the shared component, not a JSON blob copied
          into this file — the page only says what it already renders. */}
      <JsonLd data={structuredData} />

      <div className="mx-auto max-w-4xl px-4 py-8 sm:py-12">
        {/* Breadcrumb — real internal links, and it tells a visitor where this
            page sits in the site. */}
        <nav aria-label="Breadcrumb" className="mb-6 text-xs text-[#9dd8ff]">
          <ol className="flex flex-wrap items-center gap-2">
            <li>
              <Link href="/" className="underline underline-offset-2 hover:text-[#d8fbff]">
                Home
              </Link>
            </li>
            <li aria-hidden="true">/</li>
            <li>
              <Link href="/games" className="underline underline-offset-2 hover:text-[#d8fbff]">
                All games
              </Link>
            </li>
            <li aria-hidden="true">/</li>
            <li aria-current="page" className="text-[#d8fbff]">
              {game.name}
            </li>
          </ol>
        </nav>

        {/* ── Hero ───────────────────────────────────────────────────────── */}
        <header className="mb-10">
          <p className="mb-3 inline-block rounded-full border border-[#00e5ff]/50 bg-[#00e5ff]/10 px-3 py-1 text-[11px] font-bold uppercase tracking-wider text-[#00e5ff]">
            {game.category} · 1v1
          </p>
          <h1 className="text-3xl font-black leading-tight tracking-tight text-[#f5ff3b] sm:text-4xl md:text-5xl">
            {game.headline}
          </h1>

          <div className="mt-5 space-y-3">
            {game.introduction.map((paragraph) => (
              <p key={paragraph} className="text-base leading-relaxed text-[#d8fbff]">
                {paragraph}
              </p>
            ))}
          </div>

          <div className="mt-7 flex flex-wrap items-center gap-3">
            <Link
              href={playHref}
              className="inline-flex items-center justify-center gap-2 rounded-lg border border-[#00e5ff]/60 bg-[#00e5ff] px-6 py-3 text-base font-bold text-black transition-all hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff] focus-visible:ring-offset-2 focus-visible:ring-offset-[#030817]"
            >
              Play {game.name}
              <svg
                aria-hidden="true"
                className="h-4 w-4"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M5 12h14M12 5l7 7-7 7" />
              </svg>
            </Link>
            <Link
              href="/games"
              className="inline-flex items-center justify-center rounded-lg border border-[#00e5ff]/35 px-5 py-3 text-sm font-semibold text-[#9dd8ff] transition hover:bg-[#00e5ff]/10 hover:text-[#d8fbff] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff]"
            >
              Browse all games
            </Link>
          </div>

          <p className="mt-3 text-xs text-[#9dd8ff]/80">
            {game.aiPractice
              ? `Free to play. Sign in to play a ranked match against another player, or try a free practice match against the bot.`
              : "Free to play. Sign in to play a ranked match against another player."}
          </p>
        </header>

        <div className="space-y-10">
          <Section title={`How to play ${game.name}`}>
            <ol className="space-y-3">
              {game.howToPlay.map((step, index) => (
                <li key={step} className="flex gap-3">
                  <span
                    aria-hidden="true"
                    className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-[#00e5ff]/50 bg-[#00e5ff]/10 text-xs font-bold text-[#00e5ff]"
                  >
                    {index + 1}
                  </span>
                  <span className="text-[#d8fbff]">{step}</span>
                </li>
              ))}
            </ol>
          </Section>

          <Section title="Rules">
            <Bullets items={game.rules} />
          </Section>

          <Section title="Scoring — what decides the winner">
            <Bullets items={game.scoring} />
          </Section>

          <Section title={`Strategy and tips for ${game.name}`}>
            <Bullets items={game.strategy} />
          </Section>

          <Section title="What it tests">
            <p className="text-[#d8fbff]">{game.competitive}</p>
          </Section>

          {/* ── FAQ ──────────────────────────────────────────────────────── */}
          <section aria-labelledby="faq-heading">
            <h2
              id="faq-heading"
              className="mb-4 text-2xl font-extrabold tracking-tight text-[#f5ff3b]"
            >
              {game.name} FAQ
            </h2>
            <dl className="space-y-4">
              {game.faq.map((entry) => (
                <div
                  key={entry.q}
                  className="rounded-xl border border-[#00e5ff]/25 bg-[#040d24] p-4"
                >
                  <dt className="mb-1.5 font-bold text-[#00e5ff]">{entry.q}</dt>
                  <dd className="text-sm leading-relaxed text-[#d8fbff]">{entry.a}</dd>
                </div>
              ))}
            </dl>
          </section>

          {/* ── Related games ────────────────────────────────────────────── */}
          {related.length > 0 && (
            <section aria-labelledby="related-heading">
              <h2
                id="related-heading"
                className="mb-4 text-2xl font-extrabold tracking-tight text-[#f5ff3b]"
              >
                Related games
              </h2>
              <ul className="grid gap-3 sm:grid-cols-2">
                {related.map((entry) => (
                  <li key={entry.slug}>
                    <Link
                      href={gameLandingPath(entry.slug)}
                      className="block h-full rounded-xl border border-[#00e5ff]/30 bg-[#040d24] p-4 transition-all hover:-translate-y-0.5 hover:border-[#00e5ff]/60 hover:shadow-[0_0_24px_rgba(0,229,255,0.25)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff]"
                    >
                      <span className="block font-bold text-[#f5ff3b]">{entry.name}</span>
                      <span className="mt-1 block text-sm leading-relaxed text-[#9dd8ff]">
                        {entry.shortDescription}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* ── Guides for this game ────────────────────────────────────────
              The landing page teaches the rules; these teach the skill behind
              them. Only the guides that actually name this game are listed, so
              the section is specific rather than a generic "read our blog". */}
          {gameGuides.length > 0 && (
            <section aria-labelledby="guide-links-heading">
              <h2
                id="guide-links-heading"
                className="mb-4 text-2xl font-extrabold tracking-tight text-[#f5ff3b]"
              >
                Getting better at {game.name}
              </h2>
              <ul className="space-y-3">
                {gameGuides.map((entry) => (
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

          {/* ── Informational links ────────────────────────────────────────
              The prose above is about a competitive, RATED game, so the site's
              help and policy pages are the genuinely relevant next reads — not
              a link dump. Plain server-rendered links with descriptive anchor
              text: no button, no client state, nothing a crawler has to
              click. */}
          <nav
            aria-labelledby="more-info-heading"
            className="rounded-2xl border border-[#00e5ff]/25 bg-[#040d24] p-6"
          >
            <h2 id="more-info-heading" className="text-xl font-black tracking-tight text-[#f5ff3b]">
              More about competitive play
            </h2>
            <ul className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-sm">
              <li>
                <Link
                  href="/faq"
                  className="text-[#9dd8ff] underline underline-offset-2 transition-colors hover:text-[#f5ff3b]"
                >
                  How matches, tokens and rankings work
                </Link>
              </li>
              <li>
                <Link
                  href="/fair-play"
                  className="text-[#9dd8ff] underline underline-offset-2 transition-colors hover:text-[#f5ff3b]"
                >
                  How GRYND keeps matches fair
                </Link>
              </li>
              <li>
                <Link
                  href="/classement"
                  className="text-[#9dd8ff] underline underline-offset-2 transition-colors hover:text-[#f5ff3b]"
                >
                  Rankings and leaderboards
                </Link>
              </li>
            </ul>
          </nav>

          {/* ── Closing CTA ──────────────────────────────────────────────── */}
          <section
            aria-labelledby="cta-heading"
            className="rounded-2xl border border-[#f5ff3b]/35 bg-gradient-to-r from-[#0a214d]/90 to-[#08142f]/90 p-6"
          >
            <h2
              id="cta-heading"
              className="text-xl font-black tracking-tight text-[#f5ff3b] sm:text-2xl"
            >
              Ready to play {game.name}?
            </h2>
            <p className="mt-1.5 text-sm text-[#d8fbff]">
              Ranked matches are 1v1 against another player and count toward this game&apos;s own
              Elo rating and trophy ladder. Nothing is wagered — you just have to be better.
            </p>
            <Link
              href={playHref}
              className="mt-4 inline-flex items-center justify-center gap-2 rounded-lg border border-[#f5ff3b]/60 bg-[#f5ff3b] px-6 py-3 text-base font-bold text-[#041125] transition-all hover:bg-[#f5ff3b]/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f5ff3b] focus-visible:ring-offset-2 focus-visible:ring-offset-[#08142f]"
            >
              Play {game.name}
            </Link>
          </section>
        </div>
      </div>

      <Footer />
    </div>
  );
}

/** One titled content block. */
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const id = title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return (
    <section aria-labelledby={`${id}-heading`}>
      <h2
        id={`${id}-heading`}
        className="mb-4 text-2xl font-extrabold tracking-tight text-[#f5ff3b]"
      >
        {title}
      </h2>
      {children}
    </section>
  );
}

/** A list of points. */
function Bullets({ items }: { items: string[] }) {
  return (
    <ul className="space-y-2">
      {items.map((item) => (
        <li key={item} className="flex gap-3 text-[#d8fbff]">
          <span
            aria-hidden="true"
            className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-[#00e5ff]"
          />
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}
