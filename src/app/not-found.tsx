import Link from "next/link";
import Image from "next/image";
import type { Metadata } from "next";
import type { CSSProperties } from "react";
import LogoSmiley from "../images/logo1.png";

export const metadata: Metadata = {
  title: "Page Not Found — GoonBet",
  description:
    "The page you're looking for doesn't exist. Head back to GoonBet and keep playing.",
};

/* ── Slot reels ─────────────────────────────────────────────
   Each reel is a vertical strip of digits that "rolls" down and
   settles on its target digit (4 · 0 · 4). `--reel-cells` is the
   total travel distance in 6rem cells (digits.length - 1). */
const REELS: {
  digits: number[];
  cells: number;
  duration: string;
  delay: string;
  digitClass: string;
}[] = [
  {
    digits: [9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 1, 2, 3, 4],
    cells: 13,
    duration: "1.9s",
    delay: "0.15s",
    digitClass: "text-[#f5ff3b] drop-shadow-[0_0_10px_rgba(245,255,59,0.45)]",
  },
  {
    digits: [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
    cells: 9,
    duration: "2.2s",
    delay: "0.4s",
    digitClass: "text-[#00e5ff] drop-shadow-[0_0_10px_rgba(0,229,255,0.5)]",
  },
  {
    digits: [9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 1, 2, 3, 4],
    cells: 13,
    duration: "1.6s",
    delay: "0.05s",
    digitClass: "text-[#f5ff3b] drop-shadow-[0_0_10px_rgba(245,255,59,0.45)]",
  },
];

/* Floating card suits drifting in the background. */
const FLOATING_SUITS: {
  char: string;
  className: string;
  rot: string;
  duration: string;
  delay: string;
}[] = [
  {
    char: "♠",
    className: "left-[6%] top-[14%] text-5xl text-[#00e5ff] sm:text-6xl",
    rot: "-10deg",
    duration: "8s",
    delay: "0s",
  },
  {
    char: "♥",
    className: "right-[8%] top-[10%] text-4xl text-[#ff5d8f] sm:text-5xl",
    rot: "8deg",
    duration: "7s",
    delay: "1.2s",
  },
  {
    char: "♦",
    className: "bottom-[18%] left-[12%] text-4xl text-[#f5ff3b] sm:text-5xl",
    rot: "6deg",
    duration: "9s",
    delay: "0.6s",
  },
  {
    char: "♣",
    className: "bottom-[24%] right-[12%] text-5xl text-[#7c3aed] sm:text-6xl",
    rot: "-6deg",
    duration: "7.5s",
    delay: "1.8s",
  },
];

function Reel({ reel }: { reel: (typeof REELS)[number] }) {
  return (
    <div
      aria-hidden
      className="relative h-24 w-20 overflow-hidden rounded-xl border-2 border-[#00e5ff]/40 bg-[#08142f] shadow-[inset_0_0_20px_rgba(0,229,255,0.15)]"
    >
      <div
        className="slot-reel-spin flex flex-col"
        style={
          {
            "--reel-cells": reel.cells,
            "--reel-duration": reel.duration,
            "--reel-delay": reel.delay,
          } as CSSProperties
        }
      >
        {reel.digits.map((d, i) => (
          <div
            key={i}
            className={`flex h-24 w-20 items-center justify-center bg-gradient-to-b from-[#0b224f]/60 to-[#050d1f] text-5xl font-black ${reel.digitClass}`}
          >
            {d}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── Tumbling dice ──────────────────────────────────────────
   Two CSS 3D cubes (w-16/h-16 = 4rem, so each face is pushed
   out 2rem via translateZ). Pips use a 3x3 grid (indices 0-8). */
const DIE_FACES: { transform: string; pips: number[] }[] = [
  { transform: "rotateY(0deg) translateZ(2rem)", pips: [4] },
  { transform: "rotateY(180deg) translateZ(2rem)", pips: [0, 8] },
  { transform: "rotateY(90deg) translateZ(2rem)", pips: [0, 4, 8] },
  { transform: "rotateY(-90deg) translateZ(2rem)", pips: [0, 2, 6, 8] },
  { transform: "rotateX(90deg) translateZ(2rem)", pips: [0, 2, 4, 6, 8] },
  { transform: "rotateX(-90deg) translateZ(2rem)", pips: [0, 2, 3, 5, 6, 8] },
];

function Die({ duration, delay, lift }: { duration: string; delay: string; lift: string }) {
  return (
    /* preserve-3d so the row's perspective reaches the cube */
    <div className={`${lift} [transform-style:preserve-3d]`}>
      <div
        className="dice-cube dice-tumble relative h-16 w-16"
        style={{ "--tumble-duration": duration, "--tumble-delay": delay } as CSSProperties}
      >
        {DIE_FACES.map((face, i) => (
          <div
            key={i}
            className="dice-face absolute inset-0 rounded-xl border border-[#8fb3c9]/60 bg-gradient-to-br from-[#f7fbff] to-[#bcd6e8] shadow-[inset_0_2px_6px_rgba(255,255,255,0.8),inset_0_-2px_6px_rgba(11,34,79,0.25)]"
            style={{ transform: face.transform }}
          >
            <div className="grid h-full w-full grid-cols-3 grid-rows-3 p-2">
              {Array.from({ length: 9 }, (_, j) => (
                <div key={j} className="flex items-center justify-center">
                  {face.pips.includes(j) && (
                    <span className="h-2.5 w-2.5 rounded-full bg-[radial-gradient(circle_at_35%_30%,#2a4a8a,#0b224f)] shadow-[0_1px_2px_rgba(0,0,0,0.45)]" />
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

const QUICK_LINKS = [
  { label: "Casino", href: "/casino" },
  { label: "Rankings", href: "/classement" },
  { label: "Profile", href: "/profil" },
];

export default function NotFound() {
  return (
    <main
      id="main-content"
      className="relative flex min-h-[calc(100vh-68px)] items-center justify-center overflow-hidden bg-[#030817] px-4 py-14 sm:min-h-[calc(100vh-4rem)]"
    >
      {/* Backdrop: neon glows + subtle grid */}
      <div aria-hidden className="pointer-events-none absolute inset-0">
        <div className="absolute -left-28 -top-28 h-80 w-80 rounded-full bg-[#00e5ff]/10 blur-[110px]" />
        <div className="absolute -bottom-32 -right-24 h-96 w-96 rounded-full bg-[#7c3aed]/10 blur-[130px]" />
        <div className="absolute right-1/4 top-1/3 h-64 w-64 rounded-full bg-[#f5ff3b]/5 blur-[100px]" />
        <div
          className="absolute inset-0 opacity-35"
          style={{
            backgroundImage:
              "linear-gradient(rgba(0,229,255,0.06) 1px, transparent 1px), linear-gradient(90deg, rgba(0,229,255,0.05) 1px, transparent 1px)",
            backgroundSize: "44px 44px",
          }}
        />
      </div>

      {/* Floating card suits */}
      <div aria-hidden className="pointer-events-none absolute inset-0 select-none overflow-hidden">
        {FLOATING_SUITS.map((s, i) => (
          <span
            key={i}
            className={`animate-float-slow absolute opacity-15 ${s.className}`}
            style={
              {
                "--float-rot": s.rot,
                "--float-duration": s.duration,
                "--float-delay": s.delay,
              } as CSSProperties
            }
          >
            {s.char}
          </span>
        ))}
      </div>

      <section className="relative z-10 w-full max-w-xl text-center">
        {/* Branding */}
        <Link
          href="/"
          className="inline-block rounded-lg transition-transform duration-300 hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff] focus-visible:ring-offset-2 focus-visible:ring-offset-[#030817]"
        >
          <Image
            src={LogoSmiley}
            alt="GoonBet"
            width={150}
            height={60}
            className="mx-auto h-auto w-[150px] object-contain drop-shadow-[0_0_14px_rgba(245,255,59,0.3)]"
          />
        </Link>

        {/* Slot machine */}
        <div className="mt-8 rounded-3xl border-2 border-[#00e5ff]/35 bg-[#0b224f]/85 px-6 py-7 shadow-[0_0_45px_rgba(0,229,255,0.2)] backdrop-blur-sm sm:px-10 sm:py-9">
          <p className="animate-shimmer-elegant bg-gradient-to-r from-[#00e5ff] via-[#f5ff3b] to-[#00e5ff] bg-clip-text text-sm font-black uppercase tracking-[0.35em] text-transparent">
            Bad Beat
          </p>

          <div className="mt-5 flex items-center justify-center gap-3 sm:gap-4">
            <div className="h-px w-8 bg-gradient-to-r from-transparent to-[#00e5ff]/70 sm:w-12" />
            <div className="flex gap-2.5 sm:gap-3">
              {REELS.map((reel, i) => (
                <Reel key={i} reel={reel} />
              ))}
            </div>
            <div className="h-px w-8 bg-gradient-to-l from-transparent to-[#00e5ff]/70 sm:w-12" />
          </div>
        </div>

        {/* Tumbling dice */}
        <div aria-hidden className="mt-7 flex items-end justify-center gap-7 [perspective:300px]">
          <Die duration="2.6s" delay="0s" lift="translate-y-1" />
          <Die duration="3.4s" delay="0.5s" lift="-translate-y-1" />
        </div>

        <h1 className="mt-8 text-4xl font-extrabold tracking-tight sm:text-5xl">
          <span className="sr-only">404 — </span>
          <span className="animate-shimmer-elegant bg-gradient-to-r from-[#00e5ff] via-[#f5ff3b] to-[#00e5ff] bg-clip-text text-transparent">
            Page Not Found
          </span>
        </h1>

        <p className="mx-auto mt-4 max-w-md text-base leading-relaxed text-[#9dd8ff] sm:text-lg">
          The reels landed on 404 — this page has been dealt out of the deck. It may have
          been moved, renamed, or never existed at all.
        </p>

        {/* Actions */}
        <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <Link
            href="/"
            className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-[#FFD700] px-7 py-3 font-bold text-[#030817] shadow-[0_0_18px_rgba(255,215,0,0.45)] transition-all duration-200 hover:scale-[1.04] hover:bg-[#ffe14f] hover:shadow-[0_0_30px_rgba(255,215,0,0.7)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f5ff3b] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0b224f] active:scale-95 sm:w-auto"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="h-5 w-5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2.5}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 12H5m7-7-7 7 7 7" />
            </svg>
            Back to Home
          </Link>
          <Link
            href="/games"
            className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-[#00e5ff]/50 bg-[#00e5ff]/10 px-7 py-3 font-bold text-[#00e5ff] transition-all duration-200 hover:bg-[#00e5ff]/20 hover:shadow-[0_0_20px_rgba(0,229,255,0.35)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0b224f] active:scale-95 sm:w-auto"
          >
            Explore the Games
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="h-5 w-5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2.5}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 12h14m-7-7 7 7-7 7" />
            </svg>
          </Link>
        </div>

        {/* Quick links */}
        <div className="mt-9">
          <p className="text-xs font-semibold uppercase tracking-[0.25em] text-[#6b91b3]">
            Popular shortcuts
          </p>
          <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
            {QUICK_LINKS.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                className="rounded-full border border-[#00e5ff]/25 bg-[#08142f] px-3.5 py-1.5 text-xs font-medium text-[#c9f7ff] transition-colors duration-200 hover:border-[#00e5ff]/60 hover:text-[#f5ff3b] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff]"
              >
                {l.label}
              </Link>
            ))}
          </div>
        </div>

        <p className="mt-8 text-xs text-[#6b91b3]">
          Think this is a mistake?{" "}
          <Link
            href="/contact"
            className="font-medium text-[#00e5ff] underline-offset-4 transition-colors hover:text-[#f5ff3b] hover:underline"
          >
            Let us know
          </Link>
          .
        </p>
      </section>
    </main>
  );
}
