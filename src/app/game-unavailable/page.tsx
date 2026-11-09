import type { Metadata } from "next";
import Link from "next/link";
import { GAME_UNAVAILABLE_MESSAGE } from "../../lib/gameAvailability";

/**
 * /game-unavailable — the graceful answer for an archived game's URL.
 *
 * src/proxy.ts rewrites every archived game route (the public page, the lobby,
 * old bookmarks and match links) here before any game code can mount, so this
 * page is the only thing a visitor sees: no engine, no assets, no sockets, no
 * matchmaking.
 *
 * Deliberately noindex and deliberately free of internal details. It is not
 * listed in the sitemap (see EXCLUDED_FROM_SITEMAP in src/lib/seoPages.ts).
 */
export const metadata: Metadata = {
  title: "Game temporarily unavailable | GRYND",
  description: GAME_UNAVAILABLE_MESSAGE,
  robots: { index: false, follow: true },
};

export default function GameUnavailablePage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-6 py-20 text-center">
      <p className="mb-3 inline-block rounded-full border border-[#00e5ff]/50 bg-[#00e5ff]/10 px-3 py-1 text-[11px] font-bold uppercase tracking-wider text-[#00e5ff]">
        Temporarily unavailable
      </p>
      <h1 className="max-w-xl text-3xl font-black leading-tight tracking-tight text-[#f5ff3b] sm:text-4xl">
        This game is not available right now
      </h1>
      <p className="mt-4 max-w-lg text-base leading-relaxed text-[#d8fbff]">
        {GAME_UNAVAILABLE_MESSAGE}
      </p>
      <Link
        href="/games"
        className="mt-8 inline-flex items-center justify-center rounded-lg border border-[#00e5ff]/60 bg-[#00e5ff] px-6 py-3 text-base font-bold text-black transition-all hover:brightness-110 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[#00e5ff]"
      >
        Browse the games catalogue
      </Link>
    </main>
  );
}
