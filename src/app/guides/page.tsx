import type { Metadata } from "next";
import Link from "next/link";
import NavigationBar from "../../components/navigation-bar";
import Footer from "../../components/Footer";
import { GUIDE_INDEX, guidePath } from "../../lib/guides";

/**
 * /guides — the public index of the guides library.
 *
 * A server component with no client state: every guide is a real anchor in the
 * HTML, so a crawler (or a visitor without JavaScript) can reach the whole
 * library from one page. It is deliberately a reading list rather than a
 * search surface — there are twelve guides, and a search box for twelve items
 * would be noise.
 */

export const metadata: Metadata = {
  title: "Guides | GRYND",
  description:
    "Practical guides to the skills GRYND's games test: typing, memory, reaction time, Sudoku, chess, concentration, practice habits and reading an opponent.",
  alternates: { canonical: "/guides" },
};

export default function GuidesIndexPage() {
  return (
    <div className="relative min-h-screen overflow-x-clip pb-16">
      <NavigationBar currentPath="/guides" />

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
            A small, deliberately short library. Each guide teaches one transferable skill — typing
            accuracy, pattern recall, reaction time, calculation, concentration, practice habits —
            and shows where that skill decides the outcome in a specific GRYND game. There is no
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
                className="block rounded-2xl border border-[#00e5ff]/30 bg-[#040d24] p-5 transition-all hover:-translate-y-0.5 hover:border-[#00e5ff]/60 hover:shadow-[0_0_24px_rgba(0,229,255,0.2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff]"
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

      <Footer />
    </div>
  );
}
