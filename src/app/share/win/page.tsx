// src/app/share/win/page.tsx
//
// THE SHARE LANDING PAGE — what a shared win actually links to.
//
// Its only job is to make the link preview the run: `generateMetadata` points
// og:image / twitter:image at /api/share/win-card with the same query, so the
// post renders the real card (mode, time, moves, badge) instead of the site's
// generic banner. The page itself is the human version of that card, with one
// call to action: play the game.
//
// NOINDEX on purpose. These pages exist to be previewed, not indexed — they are
// generated from query parameters and would otherwise compete with the ranking
// and landing pages for a player's name and result. Crawlers still fetch the
// metadata and the image, which is the whole point.
//
// The query is untrusted, so it is narrowed by parseShareCardQuery before any
// text is rendered.

import type { Metadata } from "next";
import Link from "next/link";

import { ogImageUrl } from "../../../lib/ogImages";
import {
  buildWinShareText,
  parseShareCardQuery,
  shareCardHref,
  shareGameLabel,
  shareModeLabel,
  shareMovesLabel,
  shareSolvedLabel,
  shareTimeLabel,
} from "../../../lib/shareWin";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export async function generateMetadata({
  searchParams,
}: {
  searchParams: SearchParams;
}): Promise<Metadata> {
  const { input, locale } = parseShareCardQuery(await searchParams);
  const text = buildWinShareText(input, locale);
  const image = ogImageUrl(shareCardHref(input, locale));

  return {
    title: `${text.split(".")[0]} · GRYND`,
    description: text,
    robots: { index: false, follow: true },
    openGraph: {
      type: "article",
      title: text.split(".")[0],
      description: text,
      images: [{ url: image, width: 1200, height: 630, alt: text }],
    },
    twitter: {
      card: "summary_large_image",
      title: text.split(".")[0],
      description: text,
      images: [image],
    },
  };
}

export default async function ShareWinPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const { input, locale } = parseShareCardQuery(await searchParams);

  const game = shareGameLabel(input.game, locale);
  const mode = shareModeLabel(input.mode, locale) ?? shareSolvedLabel(locale);
  const time = shareTimeLabel(input.durationMs);
  const moves = shareMovesLabel(input.moves, locale);

  return (
    <main className="mx-auto flex min-h-[70vh] w-full max-w-3xl flex-col items-center justify-center px-4 py-12">
      <p className="text-[11px] font-black uppercase tracking-[0.3em] text-emerald-300">
        Shared result
      </p>
      <h1 className="mt-2 text-center text-3xl font-black text-white sm:text-4xl">
        {game} — {mode}
      </h1>
      {time && (
        <p className="mt-2 font-mono text-6xl font-black text-white" data-testid="share-win-time">
          {time}
        </p>
      )}
      {moves && <p className="mt-2 text-sm text-slate-400">{moves}</p>}

      {/* The same image a social platform previews. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={shareCardHref(input, locale)}
        alt={`${game} ${mode} result card`}
        width={1200}
        height={630}
        className="mt-6 w-full rounded-2xl border border-white/10"
      />

      <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
        <Link
          href="/casino/solitaire-duel"
          className="inline-flex items-center justify-center rounded-xl bg-emerald-500 px-5 py-3 text-sm font-bold text-slate-950 transition hover:bg-emerald-400"
        >
          Play Solitaire Duel
        </Link>
        <Link
          href="/upgrade-pro"
          className="inline-flex items-center justify-center rounded-xl border border-white/15 px-5 py-3 text-sm font-semibold text-white/80 transition hover:bg-white/5 hover:text-white"
        >
          GRYND PRO
        </Link>
      </div>
    </main>
  );
}
