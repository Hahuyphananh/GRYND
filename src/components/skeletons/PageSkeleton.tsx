"use client";

import { usePathname } from "next/navigation";
import type { CSSProperties, ReactNode } from "react";

/* ── Primitives ────────────────────────────────────────────────────────────
   Every block is a `.skeleton` div (shimmer + dark navy base from
   globals.css). Radius is set per-use with Tailwind utilities. */

function Block({ className = "", style }: { className?: string; style?: CSSProperties }) {
  return <div aria-hidden className={`skeleton ${className}`} style={style} />;
}

/** A few stacked text lines of varying widths. */
function Lines({
  count = 2,
  widths = ["w-3/4", "w-1/2"],
  className = "",
}: {
  count?: number;
  widths?: string[];
  className?: string;
}) {
  return (
    <div aria-hidden className={`space-y-2 ${className}`}>
      {Array.from({ length: count }, (_, i) => (
        <Block key={i} className={`h-3 ${widths[i % widths.length]}`} />
      ))}
    </div>
  );
}

function Pill({ className = "" }: { className?: string }) {
  return <Block className={`rounded-full ${className}`} />;
}

/* ── Shared chrome ─────────────────────────────────────────────────────────
   Mirrors the fixed NavigationBar (h-24, same as navigation-bar.jsx) and
   the Footer, so the skeleton reads as the real page shell. */

function NavSkeleton() {
  return (
    <div
      aria-hidden
      className="flex h-24 items-center justify-between border-b border-[#00e5ff]/40 bg-[#050b1e]/75 px-4 sm:px-6"
    >
      {/* Render the REAL navbar logo here — the splash covers the page on
          entry (up to ~2.2s), so without it the logo slot was a tiny gray
          block and the logo appeared to be missing. Same crop + sizing as
          navigation-bar.jsx so the brand mark is visible from first paint. */}
      <img
        src="/images/navbar-logo.png"
        alt=""
        draggable={false}
        className="h-[84px] w-auto object-contain sm:h-[92px]"
      />
      <div className="hidden items-center gap-5 md:flex">
        {Array.from({ length: 4 }, (_, i) => (
          <Block key={i} className="h-3.5 w-14" />
        ))}
      </div>
      <div className="flex items-center gap-3">
        <Block className="h-8 w-8 rounded-lg md:hidden" />
        <Block className="h-9 w-24 rounded-xl sm:w-32" />
      </div>
    </div>
  );
}

function FooterSkeleton() {
  return (
    <div aria-hidden className="mt-10 border-t border-[#00e5ff]/10 px-6 py-8">
      <div className="mx-auto flex max-w-7xl flex-col items-center gap-4">
        <Block className="h-5 w-32" />
        <div className="flex flex-wrap justify-center gap-3">
          {Array.from({ length: 5 }, (_, i) => (
            <Block key={i} className="h-3 w-16" />
          ))}
        </div>
      </div>
    </div>
  );
}

function PageShell({ children, maxWidth = "max-w-7xl" }: { children: ReactNode; maxWidth?: string }) {
  return (
    <div aria-hidden className="min-h-screen pb-12">
      <NavSkeleton />
      <div className={`mx-auto ${maxWidth} px-3 py-8 sm:px-4 sm:py-10`}>{children}</div>
      <FooterSkeleton />
    </div>
  );
}

/* ── Home (/) ──────────────────────────────────────────────────────────────
   Hero → value props → stats row → game cards preview. */

function HomeSkeleton() {
  return (
    <PageShell>
      <div className="space-y-4 pb-10 text-center">
        <Block className="mx-auto h-9 w-3/4 max-w-xl rounded-xl sm:h-12" />
        <Block className="mx-auto h-4 w-2/3 max-w-md" />
        <Block className="mx-auto h-4 w-1/2 max-w-sm" />
        <div className="flex justify-center gap-3 pt-2">
          <Block className="h-11 w-36 rounded-xl" />
          <Block className="h-11 w-36 rounded-xl" />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {Array.from({ length: 3 }, (_, i) => (
          <div key={i} className="skeleton rounded-2xl border border-[#00e5ff]/10 p-5">
            <Block className="mb-3 h-8 w-8 rounded-lg" />
            <Lines count={3} widths={["w-full", "w-5/6", "w-2/3"]} />
          </div>
        ))}
      </div>

      <div className="mt-8 grid grid-cols-2 gap-4 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="skeleton rounded-xl border border-[#00e5ff]/10 p-4">
            <Lines count={2} widths={["w-1/2", "w-2/3"]} />
          </div>
        ))}
      </div>

      <div className="mt-10">
        <Block className="mb-5 h-6 w-48" />
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 8 }, (_, i) => (
            <div key={i} className="skeleton rounded-xl border border-[#00e5ff]/10 p-3">
              <Block className="mb-3 h-28 w-full rounded-lg" />
              <Lines count={2} widths={["w-3/4", "w-full"]} />
              <Block className="mt-3 h-4 w-24" />
            </div>
          ))}
        </div>
      </div>

      <div className="mt-10 space-y-3">
        <Block className="mb-4 h-6 w-40" />
        {Array.from({ length: 3 }, (_, i) => (
          <div
            key={i}
            className="skeleton flex items-center justify-between rounded-xl border border-[#00e5ff]/10 px-4 py-3"
          >
            <Block className="h-4 w-40 max-w-[60%]" />
            <Block className="h-8 w-20 rounded-lg" />
          </div>
        ))}
      </div>
    </PageShell>
  );
}

/* ── Casino (/casino) ──────────────────────────────────────────────────────
   Title block → search bar → filter chips → game-card grid (1/2/3/4 cols). */

function CasinoSkeleton() {
  return (
    <PageShell>
      <div className="space-y-3 pb-8 text-center">
        <Block className="mx-auto h-9 w-64 max-w-full rounded-xl sm:h-11" />
        <Block className="mx-auto h-4 w-3/4 max-w-lg" />
        <Block className="mx-auto h-4 w-1/2 max-w-md" />
      </div>

      <div className="mx-auto mb-6 max-w-4xl">
        <Block className="h-12 w-full rounded-xl" />
      </div>

      <div className="mb-8 flex justify-center gap-3">
        {Array.from({ length: 4 }, (_, i) => (
          <Pill key={i} className="h-9 w-24" />
        ))}
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-6 lg:grid-cols-3 xl:grid-cols-4">
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i} className="skeleton rounded-xl border border-[#00e5ff]/10 p-4">
            <Block className="mb-3 h-32 w-full rounded-lg" />
            <Lines count={2} widths={["w-2/3", "w-full"]} />
            <Block className="mt-3 h-4 w-28" />
          </div>
        ))}
      </div>
    </PageShell>
  );
}

/* ── Classement (/classement) ─────────────────────────────────────────────
   Big title → podium → leaderboard rows. */

function ClassementSkeleton() {
  return (
    <PageShell maxWidth="max-w-4xl">
      <div className="pb-8 text-center">
        <Block className="mx-auto h-9 w-72 max-w-full rounded-xl sm:h-11" />
        <Block className="mx-auto mt-3 h-4 w-56 max-w-full" />
      </div>

      <div className="mb-8 flex items-end justify-center gap-4">
        {[24, 32, 20].map((h, i) => (
          <Block key={i} className="w-20 rounded-t-xl sm:w-24" style={{ height: `${h * 4}px` }} />
        ))}
      </div>

      <div className="space-y-2">
        {Array.from({ length: 7 }, (_, i) => (
          <div
            key={i}
            className="skeleton flex items-center gap-3 rounded-xl border border-[#00e5ff]/10 p-3"
          >
            <Block className="h-8 w-8 rounded-full" />
            <Block className="h-4 w-1/3 max-w-[40%]" />
            <div className="ml-auto flex items-center gap-3">
              <Block className="h-4 w-14" />
              <Block className="h-4 w-14" />
            </div>
          </div>
        ))}
      </div>
    </PageShell>
  );
}

/* ── Game (/casino/*) ──────────────────────────────────────────────────────
   Title + stake pill → board (left) + bet panel (right) → recent games. */

function GameSkeleton() {
  return (
    <PageShell>
      <div className="mb-6 flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div className="space-y-2">
          <Block className="h-8 w-48 sm:h-9" />
          <Block className="h-4 w-72 max-w-full" />
        </div>
        <Pill className="h-10 w-28" />
      </div>

      <div className="grid grid-cols-1 gap-6 md:grid-cols-[1fr_320px]">
        <div className="skeleton rounded-2xl border border-[#00e5ff]/10 p-4">
          <Block className="aspect-square w-full max-w-md rounded-xl md:mx-auto md:aspect-[4/3]" />
        </div>

        <aside className="space-y-4">
          <div className="skeleton rounded-xl border border-[#00e5ff]/10 p-5">
            <Lines count={2} widths={["w-24", "w-full"]} />
            <Block className="mt-3 h-12 w-full rounded-xl" />
            <Block className="mt-3 h-11 w-full rounded-xl" />
            <Block className="mt-4 h-5 w-32" />
          </div>
          <div className="skeleton rounded-xl border border-[#00e5ff]/10 p-5">
            <Lines count={3} widths={["w-1/2", "w-2/3", "w-3/4"]} />
          </div>
        </aside>
      </div>

      <div className="mt-8 space-y-2">
        <Block className="mb-3 h-5 w-36" />
        {Array.from({ length: 3 }, (_, i) => (
          <div
            key={i}
            className="skeleton flex items-center justify-between rounded-xl border border-[#00e5ff]/10 px-4 py-3"
          >
            <Block className="h-4 w-40 max-w-[60%]" />
            <Block className="h-4 w-16" />
          </div>
        ))}
      </div>
    </PageShell>
  );
}

/* ── Profile (/profil) ─────────────────────────────────────────────────────
   Avatar header → stats grid → tabs → content rows. */

function ProfileSkeleton() {
  return (
    <PageShell maxWidth="max-w-5xl">
      <div className="mb-8 flex flex-col items-center gap-4 sm:flex-row sm:items-center">
        <Block className="h-20 w-20 rounded-full" />
        <div className="flex-1 space-y-2 text-center sm:text-left">
          <Block className="mx-auto h-6 w-44 sm:mx-0" />
          <Block className="mx-auto h-4 w-64 max-w-full sm:mx-0" />
          <Pill className="mx-auto h-8 w-32 sm:mx-0" />
        </div>
      </div>

      <div className="mb-8 grid grid-cols-2 gap-4 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="skeleton rounded-xl border border-[#00e5ff]/10 p-4">
            <Lines count={2} widths={["w-1/2", "w-2/3"]} />
          </div>
        ))}
      </div>

      <div className="mb-6 flex gap-3">
        {Array.from({ length: 4 }, (_, i) => (
          <Pill key={i} className="h-10 w-24" />
        ))}
      </div>

      <div className="space-y-3">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="skeleton h-16 w-full rounded-xl border border-[#00e5ff]/10" />
        ))}
      </div>
    </PageShell>
  );
}

/* ── Generic fallback (legal pages, contact, auth, …) ───────────────────── */

function GenericSkeleton() {
  return (
    <PageShell maxWidth="max-w-3xl">
      <div className="space-y-3 pb-8 text-center">
        <Block className="mx-auto h-9 w-72 max-w-full rounded-xl sm:h-11" />
        <Block className="mx-auto h-4 w-3/4 max-w-lg" />
        <Block className="mx-auto h-4 w-2/3 max-w-md" />
      </div>

      <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
        <div className="skeleton rounded-2xl border border-[#00e5ff]/10 p-6">
          <Lines count={4} widths={["w-full", "w-5/6", "w-3/4", "w-2/3"]} />
        </div>
        <div className="skeleton rounded-2xl border border-[#00e5ff]/10 p-6">
          <Lines count={4} widths={["w-full", "w-4/5", "w-2/3", "w-1/2"]} />
        </div>
      </div>

      <div className="skeleton mt-5 rounded-2xl border border-[#00e5ff]/10 p-6">
        <Lines count={3} widths={["w-3/4", "w-1/2", "w-2/3"]} />
      </div>
    </PageShell>
  );
}

/* ── Selector ──────────────────────────────────────────────────────────────
   NOTE: this app's layout is `force-dynamic`, so usePathname() is populated
   during SSR and the page-specific skeleton is what ships in the HTML. On a
   statically prerendered page it would be null and the generic skeleton
   would render, then swap after hydration. */

export default function PageSkeleton() {
  const pathname = usePathname();

  let content: ReactNode = <GenericSkeleton />;
  if (pathname) {
    if (pathname === "/") content = <HomeSkeleton />;
    else if (pathname === "/casino" || pathname === "/games")
      content = <CasinoSkeleton />;
    else if (
      pathname.startsWith("/casino/") ||
      pathname.startsWith("/games/")
    )
      content = <GameSkeleton />;
    else if (pathname === "/classement" || pathname.startsWith("/classement/"))
      content = <ClassementSkeleton />;
    else if (pathname === "/profil" || pathname.startsWith("/profil/"))
      content = <ProfileSkeleton />;
  }

  return (
    <>
      {/* Announce loading to assistive tech — must live OUTSIDE the
          aria-hidden wrapper so it isn't hidden along with the visuals. */}
      <span className="sr-only">Loading page…</span>
      <div aria-hidden className="pointer-events-none select-none">{content}</div>
    </>
  );
}
