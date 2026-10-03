"use client";

import NavigationBar from "../navigation-bar";

/**
 * Full-page loading gate for PvP match screens.
 *
 * Every match page holds its authoritative state in a raw `fetch` on mount
 * (match state is user-scoped and deliberately never persisted to the SWR
 * disk cache). Before that first response lands, the page has no board to
 * draw — so instead of rendering an empty grid, match screens early-return
 * this skeleton until their first payload arrives.
 *
 * Also usable as the mid-match "reconnecting" shell: pass a different
 * `label` rather than inventing a second spinner.
 */
export default function MatchLoading({
  label = "Loading match…",
  currentPath = "/casino",
}: {
  label?: string;
  currentPath?: string;
}) {
  return (
    <div className="min-h-screen overflow-x-clip bg-gradient-to-br from-[#001933] to-[#000d1a] px-3 pb-24 pt-20 text-white sm:px-6 md:pb-8">
      <NavigationBar currentPath={currentPath} />
      <div
        role="status"
        aria-live="polite"
        className="mx-auto mt-12 flex max-w-3xl items-center justify-center gap-3 text-cyan-200"
      >
        <span aria-hidden="true" className="flex items-center gap-1">
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="h-2 w-2 animate-pulse rounded-full bg-cyan-300"
              style={{ animationDelay: `${i * 150}ms` }}
            />
          ))}
        </span>
        <span>{label}</span>
      </div>
    </div>
  );
}
