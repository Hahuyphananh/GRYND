"use client";

// ── /access-denied — the other half of the age gate ─────────────────────────
//
// The middleware sends a SIGNED-IN account here from any game route when its
// recorded date of birth makes the player under 18 (see the `underage_redirect`
// branch in src/proxy.ts). It is a dead end by design — nothing here can lift
// the restriction, because the restriction is the player's own date of birth.
//
// So the page owes the player three answers, in this order: WHY they are here,
// whether it can be corrected (a wrong DOB can — support can fix it), and what
// to do next (contact support, or sign out to use another account). The old
// version said "Access Denied" over a paragraph of regulation prose and left
// the player to guess.
//
// Presentation is the same brand family as /complete-profile and the 404 page
// (dark navy stage, neon glows over a faint grid, drifting card suits, the
// GRYND logo, shimmer headings, navy glass card, gold primary action) — with
// the family's "18+" reel marker SLASHED, so the stop reads before the copy
// does. The denial accent is the brand's rose (#ff5d8f) rather than a flat
// error red, which keeps it on-brand and non-alarming while still reading as a
// hard stop.
//
// The sign-out path is unchanged: it still goes through <SignOutButton>, which
// sweeps app-owned session artifacts before revoking the Clerk session.

import Link from "next/link";
import Image from "next/image";
import { useUser } from "@clerk/nextjs";
import {
  IconArrowRight,
  IconLifebuoy,
  IconLogout,
  IconShieldX,
} from "@tabler/icons-react";
import LogoSmiley from "../../images/logo1.png";
import { SignOutButton } from "../../components/SignOutButton";
import { useTranslation } from "../../hooks/useTranslation";

/* Drifting card suits — the family backdrop, kept faint so the card leads. */
const FLOATING_SUITS = [
  {
    char: "♠",
    className: "left-[7%] top-[16%] text-5xl text-[#00e5ff] sm:text-6xl",
    rot: "-10deg",
    duration: "8s",
    delay: "0s",
  },
  {
    char: "♦",
    className: "right-[9%] top-[22%] text-4xl text-[#f5ff3b] sm:text-5xl",
    rot: "8deg",
    duration: "7s",
    delay: "1.2s",
  },
  {
    char: "♣",
    className: "bottom-[14%] left-[11%] text-4xl text-[#7c3aed] sm:text-5xl",
    rot: "6deg",
    duration: "9s",
    delay: "0.6s",
  },
  {
    char: "♥",
    className: "bottom-[20%] right-[10%] text-5xl text-[#ff5d8f] sm:text-6xl",
    rot: "-6deg",
    duration: "7.5s",
    delay: "1.8s",
  },
];

/* The same "18+" reel marker as /complete-profile, slashed. */
const AGE_CELLS = ["1", "8", "+"];
const WHY_KEYS = ["why1", "why2", "why3"];

export default function AccessDeniedPage() {
  const { user } = useUser();
  const { t } = useTranslation();
  const accountName = user?.firstName || user?.username || user?.fullName || null;

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-[#030817] px-4 py-10 sm:py-14">
      {/* Backdrop: neon glows + subtle grid (the family's stage). */}
      <div aria-hidden className="pointer-events-none absolute inset-0">
        <div className="absolute -left-28 -top-28 h-80 w-80 rounded-full bg-[#00e5ff]/10 blur-[110px]" />
        <div className="absolute -bottom-32 -right-24 h-96 w-96 rounded-full bg-[#7c3aed]/10 blur-[130px]" />
        <div className="absolute right-1/4 top-1/3 h-64 w-64 rounded-full bg-[#ff5d8f]/5 blur-[100px]" />
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
            style={{
              "--float-rot": s.rot,
              "--float-duration": s.duration,
              "--float-delay": s.delay,
            }}
          >
            {s.char}
          </span>
        ))}
      </div>

      <section className="relative z-10 w-full max-w-lg">
        {/* Branding */}
        <Link
          href="/"
          className="mx-auto block w-fit rounded-lg transition-transform duration-300 hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff] focus-visible:ring-offset-2 focus-visible:ring-offset-[#030817]"
        >
          <Image
            src={LogoSmiley}
            alt="GRYND"
            width={150}
            height={60}
            priority
            className="h-auto w-[132px] object-contain drop-shadow-[0_0_14px_rgba(245,255,59,0.3)] sm:w-[150px]"
          />
        </Link>

        <div className="mt-6 overflow-hidden rounded-3xl border-2 border-[#ff5d8f]/40 bg-[#0b224f]/85 shadow-[0_0_45px_rgba(255,93,143,0.16)] backdrop-blur-sm">
          {/* Accent strip — the denial palette, same rule as the sibling card. */}
          <div className="h-1 bg-gradient-to-r from-[#ff5d8f] via-[#f5ff3b] to-[#ff5d8f]" />

          <div className="px-5 py-6 text-center sm:px-9 sm:py-8">
            {/* Slashed 18+ marker: the family's reel styling, stopped. */}
            <div
              role="img"
              aria-label={t("accessDenied.badge")}
              className="relative mx-auto flex w-fit items-center justify-center gap-2 [perspective:300px]"
            >
              {AGE_CELLS.map((cell) => (
                <span
                  key={cell}
                  className="flex h-11 w-10 items-center justify-center rounded-lg border-2 border-[#ff5d8f]/45 bg-[#1a0a16] text-xl font-black text-[#ff5d8f]/90 shadow-[inset_0_0_18px_rgba(255,93,143,0.18)]"
                >
                  {cell}
                </span>
              ))}
              {/* the slash */}
              <span
                aria-hidden
                className="pointer-events-none absolute left-[-6%] right-[-6%] top-1/2 h-1.5 -translate-y-1/2 -rotate-[8deg] rounded-full bg-[#ff5d8f] shadow-[0_0_14px_rgba(255,93,143,0.85)]"
              />
            </div>

            {/* Eyebrow badge + which account is restricted */}
            <div className="mt-5 flex flex-wrap items-center justify-between gap-2">
              <span className="inline-flex items-center gap-1.5 rounded-full border border-[#ff5d8f]/45 bg-[#ff5d8f]/10 px-3 py-1 text-[10px] font-black uppercase tracking-[0.22em] text-[#ffb3c9]">
                <IconShieldX size={13} aria-hidden />
                {t("accessDenied.badge")}
              </span>
              {accountName && (
                <span className="max-w-[55%] truncate text-[11px] text-[#6b91b3]">
                  {t("accessDenied.signedInAs", { name: accountName })}
                </span>
              )}
            </div>

            <h1 className="mt-4 text-3xl font-extrabold tracking-tight sm:text-4xl">
              <span className="animate-shimmer-elegant bg-gradient-to-r from-[#ff5d8f] via-[#f5ff3b] to-[#ff5d8f] bg-clip-text text-transparent">
                {t("accessDenied.title")}
              </span>
            </h1>
            <p className="mx-auto mt-3 max-w-md text-sm leading-relaxed text-[#9dd8ff] sm:text-base">
              {t("accessDenied.subtitle")}
            </p>

            {/* What now — the page's real job. */}
            <div className="mt-5 rounded-2xl border border-[#00e5ff]/20 bg-[#061530]/70 p-4 text-left">
              <p className="text-[10px] font-black uppercase tracking-[0.22em] text-[#ffb3c9]">
                {t("accessDenied.whatTitle")}
              </p>
              <ul className="mt-2.5 space-y-2 text-[13px] leading-snug text-[#c9f7ff]">
                {WHY_KEYS.map((key) => (
                  <li key={key} className="flex items-start gap-2.5">
                    <span
                      aria-hidden
                      className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-[#ff5d8f] shadow-[0_0_8px_rgba(255,93,143,0.8)]"
                    />
                    <span>{t(`accessDenied.${key}`)}</span>
                  </li>
                ))}
              </ul>
            </div>

            {/* Actions: correcting a wrong date of birth is the real remedy, so
                support leads; signing out is the quiet alternative. */}
            <Link
              href="/contact"
              className="mt-6 flex w-full items-center justify-center gap-2 rounded-2xl bg-[#FFD700] px-7 py-4 text-base font-extrabold tracking-wide text-[#030817] shadow-[0_0_22px_rgba(255,215,0,0.45)] transition-all duration-200 hover:scale-[1.02] hover:bg-[#ffe14f] hover:shadow-[0_0_32px_rgba(255,215,0,0.65)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f5ff3b] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0b224f] active:scale-95"
            >
              <IconLifebuoy size={18} aria-hidden />
              {t("accessDenied.contact")}
              <IconArrowRight size={18} aria-hidden />
            </Link>

            <SignOutButton>
              <button
                type="button"
                className="mt-3 flex w-full items-center justify-center gap-2 rounded-2xl border border-[#ff5d8f]/50 bg-[#ff5d8f]/10 px-7 py-3.5 text-base font-bold text-[#ffb3c9] transition-colors duration-200 hover:bg-[#ff5d8f]/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#ff5d8f] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0b224f] active:scale-[0.98]"
              >
                <IconLogout size={18} aria-hidden />
                {t("accessDenied.signOut")}
              </button>
            </SignOutButton>

            <p className="mt-4 text-[11px] leading-relaxed text-[#6b91b3]">
              {t("accessDenied.footnote")}{" "}
              <Link
                href="/terms"
                className="font-medium text-[#00e5ff] underline-offset-4 transition-colors hover:text-[#f5ff3b] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff]"
              >
                {t("accessDenied.termsLink")}
              </Link>
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
