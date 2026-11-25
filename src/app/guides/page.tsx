import type { Metadata } from "next";
import Link from "next/link";
import NavigationBar from "../../components/navigation-bar";
import Footer from "../../components/Footer";
import AdSenseScript from "../../components/AdSenseScript";
import AdSlot from "../../components/AdSlot";
import { GUIDE_INDEX, guidePath } from "../../lib/guides";
import { pageMetadata, DEFAULT_OG_IMAGE } from "../../lib/seo";

/**
 * /guides — the public index of the guides library.
 *
 * A server component with no client state: every guide is a real anchor in the
 * HTML, so a crawler (or a visitor without JavaScript) can reach the whole
 * library from one page. It is deliberately a reading list rather than a
 * search surface — there are twelve guides, and a search box for twelve items
 * would be noise.
 */

export const metadata = pageMetadata({
  title: "Solitaire guides",
  description: "Practical Klondike Solitaire guides: the rules, strategy for beginners, common mistakes, memory and concentration, tempo, and how to practise for a competitive race.",
  path: "/guides",
  image: DEFAULT_OG_IMAGE,
});

export default function GuidesIndexPage() {
  return (
    <div className="relative min-h-screen overflow-x-clip pb-16">
      <NavigationBar currentPath="/guides" />
      {/* The guides are the site's editorial surface, so this is the
          placement a reader is actually engaged with — and the one a site
          review reads as content rather than inventory. */}
      <AdSenseScript />

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
              Guides
            </li>
          </ol>
        </nav>

        <header className="mb-10">
          <p className="mb-3 inline-block rounded-full border border-[#00e5ff]/50 bg-[#00e5ff]/10 px-3 py-1 text-[11px] font-bold uppercase tracking-wider text-[#00e5ff]">
            GRYND Guides
          </p>
          <h1 className="text-3xl font-black leading-tight tracking-tight text-[#f5ff3b] sm:text-4xl">
            Guides for the skills GRYND actually tests
          </h1>
          <p className="mt-4 leading-relaxed text-[#d8fbff]">
            A small, deliberately short library. Each guide covers one part of competitive Klondike —
            the rules, reveals and promotion, empty columns, memory, tempo, concentration and
            practice — and shows where that decision decides a real Solitaire Duel. There is no
            filler here: if a guide is not useful, it does not belong on this page.
          </p>
          <p className="mt-3 text-sm text-[#9dd8ff]">
            New to the site? Start with{" "}
            <Link href="/games" className="text-[#00e5ff] underline hover:text-[#f5ff3b]">
              the full game catalogue
            </Link>{" "}
            or{" "}
            <Link href="/faq" className="text-[#00e5ff] underline hover:text-[#f5ff3b]">
              how GRYND works
            </Link>
            .
          </p>
        </header>

        <ul className="space-y-4">
          {GUIDE_INDEX.map((guide) => (
            <li key={guide.slug}>
              <Link
                href={guidePath(guide.slug)}
                className="block rounded-2xl border border-[#00e5ff]/30 bg-surface p-5 transition-all hover:-translate-y-0.5 hover:border-[#00e5ff]/60 hover:shadow-[0_0_24px_rgba(0,229,255,0.2)] focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[#00e5ff]"
              >
                <span className="block text-lg font-black tracking-tight text-[#f5ff3b]">
                  {guide.title}
                </span>
                <span className="mt-1.5 block text-sm leading-relaxed text-[#9dd8ff]">
                  {guide.metaDescription}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </div>

      <AdSlot placement="guides" />
      <Footer />
    </div>
  );
}
