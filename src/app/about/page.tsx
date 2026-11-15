import type { Metadata } from "next";
import Link from "next/link";
import NavigationBar from "../../components/navigation-bar";
import Footer from "../../components/Footer";

/**
 * /about — who runs GRYND, how it is paid for, and what it will not do.
 *
 * WHY THIS PAGE EXISTS
 * A site review is not only "does the ad tag load". A reviewer opens the site
 * and asks who published it, whether the content is original, whether the
 * advertising is disclosed, and whether the pages exist for any reason other
 * than showing ads. Those questions had no single page to answer them: the
 * privacy policy described data, the terms described the contract, and the
 * guides described strategy. This page is the publisher statement, and it is
 * deliberately plain prose rather than marketing copy — every claim here is one
 * the rest of the site already enforces (see the ad placement list in
 * src/lib/ads.ts and docs/adsense-readiness.md).
 *
 * It carries NO ad slot and NO ad loader, on purpose: an informational page
 * about the site is not a content page, and AdSense's own placement policy
 * treats ads there as inventory without content behind it.
 */

export const metadata: Metadata = {
  title: "About GRYND | Who runs it and how it is funded",
  description:
    "GRYND is a free, browser-based competitive Solitaire site: one deterministic deal, two real players, a server-verified ranked ladder. Read who runs it, how it is funded and what it will never do.",
  alternates: { canonical: "/about" },
};

const H2 = "text-xl font-black tracking-tight text-[#f5ff3b] sm:text-2xl";
const P = "mt-3 leading-relaxed text-[#d8fbff]";
const LINK = "text-[#00e5ff] underline underline-offset-2 hover:text-[#f5ff3b]";

export default function AboutPage() {
  return (
    <div className="relative min-h-screen overflow-x-clip pb-16">
      <NavigationBar currentPath="/about" />

      <div className="mx-auto max-w-3xl px-4 py-8 sm:py-12">
        <nav aria-label="Breadcrumb" className="mb-6 text-xs text-[#9dd8ff]">
          <ol className="flex flex-wrap items-center gap-2">
            <li>
              <Link href="/" className="underline underline-offset-2 hover:text-[#d8fbff]">
                Home
              </Link>
            </li>
            <li aria-hidden="true">/</li>
            <li aria-current="page" className="text-[#d8fbff]">
              About
            </li>
          </ol>
        </nav>

        <header>
          <h1 className="text-3xl font-black leading-tight tracking-tight text-[#f5ff3b] sm:text-4xl">
            About GRYND
          </h1>
          <p className="mt-4 leading-relaxed text-[#d8fbff]">
            GRYND is a free, browser-based competitive card-game site. Today it is built around
            one game: ranked Klondike Solitaire, played head to head. Both players receive the
            same deterministic deal, every accepted move is judged by the server, and the result
            moves a per-game rating on a public ladder.
          </p>
        </header>

        <section className="mt-10" aria-labelledby="what-grynd-is">
          <h2 id="what-grynd-is" className={H2}>
            What this site is
          </h2>
          <p className={P}>
            One deal, two players. The deal is generated from a committed server seed before
            either player starts, so neither player can have a different board and the replay of
            a finished match is checkable. The ladder is free to enter, there is no entry fee and
            nothing on GRYND can be bought to improve a result: a rating moves because a match
            was won or lost, and for no other reason.
          </p>
          <p className={P}>
            Everything you read on the site — the rules pages, the guides, the FAQ — is written
            and maintained in-house by the same team that runs the game. There are no purchased
            articles, no syndicated content feeds, and no pages generated for search engines.
            When a rule changes, the page describing it changes with it.
          </p>
        </section>

        <section className="mt-10" aria-labelledby="funding">
          <h2 id="funding" className={H2}>
            How GRYND is funded
          </h2>
          <p className={P}>
            GRYND is free to play and is paid for by advertising. Ads are served by Google
            AdSense and appear only on pages you browse <em>between</em> games: the home page,
            the game hub, the leaderboard, the profile page, the game lobbies and the guides.
            Every ad block is labelled “Advertisement”.
          </p>
          <p className={P}>
            There is no advertising on a live board and none on a match page. A match in progress
            is never interrupted, covered, or pushed down by an ad — the ad code is not present in
            a match document at all, so it cannot load there even by accident. A GRYND PRO
            subscription removes advertising entirely: no ad code is sent, and no ad request is
            made for a member.
          </p>
          <p className={P}>
            Advertisers have no influence over the site. No advertiser can buy a place in a
            guide, a review, a rating, a ladder position or a match result, and paid placements
            are not sold anywhere on GRYND. See the{" "}
            <Link href="/cookie-policy" className={LINK}>
              cookie policy
            </Link>{" "}
            for exactly which cookies advertising sets and how to turn personalised advertising
            off.
          </p>
        </section>

        <section className="mt-10" aria-labelledby="adults">
          <h2 id="adults" className={H2}>
            Adults only, and not a gambling site
          </h2>
          <p className={P}>
            GRYND is intended for people aged 18 and over, and accounts are age-checked at sign-up.
            It is entertainment, not gambling: <strong>no real money is wagered, won or lost</strong>{" "}
            on this site, there are no cash prizes, and nothing here can be exchanged for money or
            anything of monetary value. Any credits shown in the product are virtual, have no cash
            value and cannot be withdrawn.
          </p>
          <p className={P}>
            If gambling is affecting you or someone you know, support is available from services
            such as Gamblers Anonymous and, in Quebec, the CAI-accredited help lines listed on the{" "}
            <Link href="/fair-play" className={LINK}>
              fair play
            </Link>{" "}
            page. GRYND is not a treatment service and does not offer gambling facilities.
          </p>
        </section>

        <section className="mt-10" aria-labelledby="corrections">
          <h2 id="corrections" className={H2}>
            Corrections and contact
          </h2>
          <p className={P}>
            If something on GRYND is wrong, misleading or out of date — a rule, a guide, a
            published deck or a rating explanation — tell us and we will correct it. Reports about
            an advertisement (a creative that is inappropriate, misleading or broken) are passed to
            Google as well, because the creative itself is served by them rather than chosen by us.
          </p>
          <p className={P}>
            The fastest route is the{" "}
            <Link href="/contact" className={LINK}>
              contact form
            </Link>
            . How your data is handled is described in the{" "}
            <Link href="/privacy-policy" className={LINK}>
              privacy policy
            </Link>
            , and the rules of the site are in the{" "}
            <Link href="/terms" className={LINK}>
              terms of service
            </Link>
            .
          </p>
        </section>

        <p className="mt-10 text-xs text-[#9dd8ff]/70">Last updated: 15 November 2026.</p>
      </div>

      <Footer />
    </div>
  );
}
