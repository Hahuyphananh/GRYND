"use client";

// ── /complete-profile — age gate between sign-up and the rest of onboarding ──
//
// ONE job: confirm the date of birth the platform needs for its 18+ check.
// The submit path is unchanged and still the only thing that matters —
// `calculateAge` mirrors the authoritative server calculation in
// /api/update-birthdate (src/lib/ageVerification.ts), and a pass hands the
// player to /sync.
//
// Presentation follows the 404 page's brand language so the two "edges" of the
// app feel like the same product: near-black navy stage, cyan / yellow neon
// glows over a faint grid, drifting card suits, the GRYND logo, shimmer
// gradient headings and a gold primary action. The one flourish borrowed
// outright is the 404's slot-reel styling — here rolled as a compact "18+"
// marker, so the age requirement is legible before a single word is read.
//
// Clarity work over the previous plain card:
//   * WHY the date is needed, and who can see it, stated up front.
//   * The rule is explicit ("at least 18 — born on or before <date>") and the
//     same boundary is enforced by the input's `max`, so the browser's own
//     date picker cannot offer an underage date.
//   * Live feedback: as soon as a date is picked the page reports the computed
//     age and whether it clears the gate, before the player submits anything.
//   * Accessible wiring: labelled input, `aria-invalid`, `aria-describedby`,
//     and an error banner announced through `role="alert"`.
//
// This file is presentational only: nothing here decides eligibility locally
// or trusts a client value — the server still re-checks every submission.

import { useMemo, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { useUser } from "@clerk/nextjs";
import { useRouter } from "next/navigation";
import {
  IconAlertTriangle,
  IconLock,
  IconShieldCheck,
} from "@tabler/icons-react";
import LogoSmiley from "../../images/logo1.png";
import { calculateAge, MINIMUM_AGE } from "../../lib/ageVerification";
import { useTranslation } from "../../hooks/useTranslation";

/* Drifting card suits — the 404 page's backdrop, kept at low opacity so it can
   never compete with the form. */
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

/* The three cells of the "18+" marker, drawn in the 404's reel style. */
const AGE_CELLS = ["1", "8", "+"];

/* The "why we ask" bullets, in order. */
const WHY_KEYS = ["why1", "why2", "why3"];

export default function CompleteProfilePage() {
  const { user } = useUser();
  const router = useRouter();
  const { t, language } = useTranslation();
  const [birthDate, setBirthDate] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState("");

  // The latest birth date that still clears the gate, in `yyyy-mm-dd` — the
  // input's `max` uses it (calendar maths in UTC, matching calculateAge) and
  // the hint below spells the same boundary out in the player's language.
  const latestAllowedDate = useMemo(() => {
    const now = new Date();
    return new Date(
      Date.UTC(now.getUTCFullYear() - MINIMUM_AGE, now.getUTCMonth(), now.getUTCDate()),
    )
      .toISOString()
      .slice(0, 10);
  }, []);
  const latestAllowedLabel = useMemo(
    () =>
      new Date(`${latestAllowedDate}T00:00:00Z`).toLocaleDateString(language, {
        day: "numeric",
        month: "short",
        year: "numeric",
        timeZone: "UTC",
      }),
    [latestAllowedDate, language],
  );

  // Live preview only — the submit path below recomputes through the same
  // shared helper, and the server remains authoritative.
  const previewAge = birthDate ? calculateAge(birthDate) : null;
  const previewOk = previewAge !== null && previewAge >= MINIMUM_AGE;
  const accountName = user?.firstName || user?.username || user?.fullName || null;

  const handleSubmit = async (e) => {
    e.preventDefault();
    setIsSubmitting(true);
    setError("");

    // Defensive only — the button and the input's `max` already prevent these
    // from being reachable through the UI. The check is kept because the
    // server stays the authority and nothing here may trust a client value.
    if (!birthDate) {
      setError(t("completeProfile.errorRequired"));
      setIsSubmitting(false);
      return;
    }

    // Calendar-based age, kept in sync with the authoritative server check
    // in /api/update-birthdate (src/lib/ageVerification.ts).
    const age = calculateAge(birthDate);

    if (age === null || age < MINIMUM_AGE) {
      setError(t("completeProfile.errorTooYoung"));
      setIsSubmitting(false);
      return;
    }

    try {
      const response = await fetch("/api/update-birthdate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ birthDate }),
      });

      const result = await response.json();

      if (!result.success) {
        throw new Error(result.error || "Unknown error");
      }

      router.push("/sync");
    } catch (err) {
      // The server's message can be an internal detail, so the player sees the
      // actionable copy; the trace stays in the console for support.
      console.error("complete-profile: update-birthdate failed", err);
      setError(t("completeProfile.errorFailed"));
      setIsSubmitting(false);
    }
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-[#030817] px-4 py-10 sm:py-14">
      {/* Backdrop: neon glows + subtle grid (same stage as the 404 page). */}
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

        <div className="mt-6 overflow-hidden rounded-3xl border-2 border-[#00e5ff]/35 bg-[#0b224f]/85 shadow-[0_0_45px_rgba(0,229,255,0.18)] backdrop-blur-sm">
          {/* Accent strip — the 404 card's top rule. */}
          <div className="h-1 bg-gradient-to-r from-[#00e5ff] via-[#f5ff3b] to-[#00e5ff]" />

          <div className="px-5 py-6 text-center sm:px-9 sm:py-8">
            {/* 18+ reel marker — the 404's slot styling, rolled down to the one
                thing this page is about. */}
            <div className="flex items-center justify-center gap-2 [perspective:300px]">
              {AGE_CELLS.map((cell, i) => (
                <span
                  key={cell}
                  className={`flex h-11 w-10 items-center justify-center rounded-lg border-2 border-[#00e5ff]/40 bg-[#08142f] text-xl font-black text-[#f5ff3b] shadow-[inset_0_0_18px_rgba(0,229,255,0.18)] ${
                    i === 1 ? "animate-float-slow" : ""
                  }`}
                  style={i === 1 ? { "--float-duration": "6s", "--float-rot": "0deg" } : undefined}
                >
                  {cell}
                </span>
              ))}
            </div>

            {/* Eyebrow badge + which account is being verified */}
            <div className="mt-5 flex flex-wrap items-center justify-between gap-2">
              <span className="inline-flex items-center gap-1.5 rounded-full border border-[#f5ff3b]/40 bg-[#f5ff3b]/10 px-3 py-1 text-[10px] font-black uppercase tracking-[0.22em] text-[#f5ff3b]">
                <IconShieldCheck size={13} aria-hidden />
                {t("completeProfile.badge")}
              </span>
              {accountName && (
                <span className="max-w-[55%] truncate text-[11px] text-[#6b91b3]">
                  {t("completeProfile.signedInAs", { name: accountName })}
                </span>
              )}
            </div>

            <h1 className="mt-4 text-3xl font-extrabold tracking-tight sm:text-4xl">
              <span className="animate-shimmer-elegant bg-gradient-to-r from-[#00e5ff] via-[#f5ff3b] to-[#00e5ff] bg-clip-text text-transparent">
                {t("completeProfile.title")}
              </span>
            </h1>
            <p className="mx-auto mt-3 max-w-md text-sm leading-relaxed text-[#9dd8ff] sm:text-base">
              {t("completeProfile.subtitle")}
            </p>

            {/* Why we ask — answered before the player has to wonder. */}
            <ul className="mt-5 space-y-2 rounded-2xl border border-[#00e5ff]/20 bg-[#061530]/70 p-4 text-left text-[13px] leading-snug text-[#c9f7ff]">
              {WHY_KEYS.map((key) => (
                <li key={key} className="flex items-start gap-2.5">
                  <span
                    aria-hidden
                    className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-[#00e5ff] shadow-[0_0_8px_rgba(0,229,255,0.8)]"
                  />
                  <span>{t(`completeProfile.${key}`)}</span>
                </li>
              ))}
            </ul>

            <form onSubmit={handleSubmit} className="mt-6 text-left">
              <label
                htmlFor="birthDate"
                className="block text-[11px] font-black uppercase tracking-[0.22em] text-[#9dd8ff]"
              >
                {t("completeProfile.dateLabel")}
              </label>

              <input
                type="date"
                id="birthDate"
                name="birthDate"
                value={birthDate}
                min="1900-01-01"
                max={latestAllowedDate}
                onChange={(e) => setBirthDate(e.target.value)}
                aria-invalid={Boolean(error)}
                aria-describedby="birthDateHelp birthDateStatus"
                required
                className="mt-2 w-full rounded-2xl border-2 border-[#00e5ff]/30 bg-[#040d24] px-4 py-3.5 text-base font-semibold text-[#d8fbff] outline-none transition [color-scheme:dark] focus:border-[#00e5ff] focus:ring-2 focus:ring-[#00e5ff]/40 sm:text-lg"
              />

              <p id="birthDateHelp" className="mt-2 text-xs text-[#6b91b3]">
                {t("completeProfile.dateHint", {
                  age: MINIMUM_AGE,
                  date: latestAllowedLabel,
                })}
              </p>

              {/* Live verdict — shown as soon as the picker yields a date. */}
              <p
                id="birthDateStatus"
                aria-live="polite"
                className={`mt-2 min-h-[1.15rem] text-xs font-bold ${
                  previewAge === null
                    ? "text-transparent"
                    : previewOk
                      ? "text-[#4ade80]"
                      : "text-[#fbbf24]"
                }`}
              >
                {previewAge === null
                  ? ""
                  : previewOk
                    ? t("completeProfile.statusOk", { age: previewAge })
                    : t("completeProfile.statusTooYoung", { age: MINIMUM_AGE })}
              </p>

              {error && (
                <div
                  role="alert"
                  className="mt-3 flex items-start gap-2.5 rounded-2xl border border-[#ff5d8f]/50 bg-[#ff5d8f]/10 px-4 py-3 text-sm text-[#ffc2d6]"
                >
                  <IconAlertTriangle size={18} aria-hidden className="mt-0.5 shrink-0 text-[#ff5d8f]" />
                  <span>{error}</span>
                </div>
              )}

              {/* Locked until the date clears the gate: the browser's own
                  `max` guard already refuses an underage date, so offering a
                  submit that could only ever fail would just be a dead end.
                  The live line above says why in the player's language. */}
              <button
                type="submit"
                disabled={isSubmitting || !previewOk}
                className="mt-6 flex w-full items-center justify-center gap-2 rounded-2xl bg-[#FFD700] px-7 py-4 text-base font-extrabold tracking-wide text-[#030817] shadow-[0_0_22px_rgba(255,215,0,0.45)] transition-all duration-200 hover:scale-[1.02] hover:bg-[#ffe14f] hover:shadow-[0_0_32px_rgba(255,215,0,0.65)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f5ff3b] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0b224f] active:scale-95 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:scale-100"
              >
                {isSubmitting && (
                  <span
                    aria-hidden
                    className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-[#030817]/30 border-t-[#030817]"
                  />
                )}
                {isSubmitting ? t("completeProfile.submitting") : t("completeProfile.submit")}
              </button>
            </form>

            <p className="mt-4 flex items-center justify-center gap-1.5 text-[11px] text-[#6b91b3]">
              <IconLock size={13} aria-hidden />
              {t("completeProfile.secure")}
            </p>
          </div>
        </div>

        {/* Escape hatch — the 404 page offers the same "keep exploring" out. */}
        <p className="mt-6 text-center text-xs text-[#6b91b3]">
          {t("completeProfile.skip")}{" "}
          <Link
            href="/games"
            className="font-medium text-[#00e5ff] underline-offset-4 transition-colors hover:text-[#f5ff3b] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff]"
          >
            {t("completeProfile.skipLink")}
          </Link>
        </p>
      </section>
    </div>
  );
}
