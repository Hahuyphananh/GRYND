"use client";

// /welcome — first-time-user onboarding flow.
//
// A five-step, game-styled walkthrough shown to brand-new accounts (routed
// here from /sync) and re-runnable from Settings → Help & Support via
// ?replay=1. Steps: welcome → what is Grynd → how tokens work → how PvP
// works → "your first match is free". The final step completes onboarding
// (server-authoritative via users.onboarding_completed_at, written through
// /api/onboarding/complete) and launches the player straight into the
// EXISTING Free Play vs AI tutorial match (Rock Paper Scissors — reused
// as-is, no duplicate game), whose finish grants the one-time onboarding XP
// through the existing Battle Pass pipeline.
//
// This page only renders the flow, it never decides "is this user new" on
// its own. Refreshing resumes the current step (sessionStorage, per user +
// tab); completing or skipping marks the account done permanently, so
// logout/login, refresh and other tabs can never re-trigger onboarding.
//
// The copy reuses the repo's actual token/PvP/Battle Pass terminology (see
// src/lib/appTextTranslations.js → onboarding.*).

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "framer-motion";
import { useUser } from "@clerk/nextjs";
import {
  IconArrowLeft,
  IconArrowRight,
  IconBolt,
  IconCoins,
  IconDeviceGamepad2,
  IconRobot,
  IconStar,
  IconSwords,
  IconTarget,
  IconTrophy,
  IconUser,
  IconUsers,
} from "@tabler/icons-react";
import { useTranslation } from "../../hooks/useTranslation";

const TOTAL_STEPS = 5;
const STEP_STORAGE_PREFIX = "grynd:welcome:step:";

// The final step launches the player into the existing Free Play vs AI
// tutorial match (reused as-is; no new game system). The first-match stage
// is gated server-side by users.first_game_completed_at.
const FIRST_GAME_URL = "/casino/rps/play-ai?onboarding=1";

type Props = {
  /** ?replay=1 — opened from Settings → Help & Support; skips the "already
   *  completed" bounce so the user can walk the tutorial again. */
  replay?: boolean;
};

export default function WelcomePageClient({ replay = false }: Props) {
  const { isLoaded, isSignedIn, user } = useUser();
  const { t } = useTranslation();

  // status: "loading" → checking server flag | "ready" → show flow |
  // "error" → server flag couldn't be read (graceful retry).
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [step, setStep] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

  const storageKey = user?.id ? `${STEP_STORAGE_PREFIX}${user.id}` : null;
  const doneTarget = replay ? "/settings" : "/games";

  const clearStepStorage = useCallback(() => {
    if (storageKey) {
      try {
        sessionStorage.removeItem(storageKey);
      } catch {
        // sessionStorage unavailable — harmless.
      }
    }
  }, [storageKey]);

  // 1) Check the server-side completion flag once Clerk is ready.
  const checkStatus = useCallback(async () => {
    if (!isLoaded || !isSignedIn) return;
    setStatus("loading");
    try {
      const res = await fetch("/api/onboarding/status", { credentials: "include" });
      const data = await res.json();
      if (!res.ok || data?.success !== true) throw new Error("bad status response");

      if (data.onboardingCompleted === true && !replay) {
        // Already onboarded (existing user, or completed in another tab).
        // Existing users must never be dropped into onboarding — go home,
        // exactly like the returning-user /sync path.
        window.location.replace("/");
        return;
      }

      // New account (or replay). Resume where the user left off if they
      // refreshed mid-flow; replay always restarts from the beginning.
      if (!replay && storageKey) {
        try {
          const saved = Number(sessionStorage.getItem(storageKey));
          // Resume any step the user reached (including the final screen,
          // e.g. when the completion POST failed and they refreshed). Step 0
          // is never restored — a fresh visit starts the walkthrough over.
          if (Number.isInteger(saved) && saved > 0 && saved <= TOTAL_STEPS - 1) {
            setStep(saved);
          }
        } catch {
          // ignore
        }
      }
      setStatus("ready");
    } catch (err) {
      console.error("[WELCOME_STATUS_ERROR]", err);
      setStatus("error");
    }
  }, [isLoaded, isSignedIn, replay, storageKey]);

  useEffect(() => {
    if (!isLoaded) return;
    // Signed-out visitors can't complete onboarding — send them to the
    // public home (which owns the sign-in/up CTAs).
    if (!isSignedIn) {
      window.location.replace("/");
      return;
    }
    checkStatus();
  }, [isLoaded, isSignedIn, checkStatus]);

  // 2) Persist the in-progress step so a refresh doesn't restart onboarding.
  useEffect(() => {
    if (status !== "ready" || !storageKey || replay) return;
    try {
      sessionStorage.setItem(storageKey, String(step));
    } catch {
      // ignore
    }
  }, [step, status, storageKey, replay]);

  // 3) Move focus to the step heading on every transition (keyboard UX).
  useEffect(() => {
    if (status === "ready") contentRef.current?.focus();
  }, [step, status]);

  const goTo = useCallback(
    (next: number) => {
      setSaveFailed(false);
      setStep(Math.max(0, Math.min(TOTAL_STEPS - 1, next)));
    },
    [],
  );

  const completeOnboarding = useCallback(async () => {
    const res = await fetch("/api/onboarding/complete", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
    });
    const data = await res.json();
    if (!res.ok || data?.success !== true) throw new Error("complete failed");
  }, []);

  const finish = useCallback(async () => {
    setSaving(true);
    setSaveFailed(false);
    try {
      await completeOnboarding();
      clearStepStorage();
      // Full navigation (not router.replace): back/refresh can't resubmit
      // and the destination gets a clean mount.
      window.location.replace(doneTarget);
    } catch (err) {
      console.error("[WELCOME_COMPLETE_ERROR]", err);
      setSaving(false);
      setSaveFailed(true);
    }
  }, [completeOnboarding, clearStepStorage, doneTarget]);

  const skip = useCallback(() => {
    void finish();
  }, [finish]);

  // Final-step primary CTA: completes onboarding (server flag), clears the
  // in-progress step, then hands over to the Free Play vs AI tutorial match.
  // A failed completion POST shows the retry/continue state instead of
  // silently dropping the user — the game page itself also backfills the
  // flag when the match finishes, so nothing can be lost permanently.
  const launch = useCallback(async () => {
    setSaving(true);
    setSaveFailed(false);
    try {
      await completeOnboarding();
      clearStepStorage();
      // Full navigation (not router.replace): back/refresh can't resubmit
      // and the game page gets a clean mount.
      window.location.replace(FIRST_GAME_URL);
    } catch (err) {
      console.error("[WELCOME_LAUNCH_ERROR]", err);
      setSaving(false);
      setSaveFailed(true);
    }
  }, [completeOnboarding, clearStepStorage]);

  // Arrow-key navigation between steps (Back/Next are the visible controls).
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (status !== "ready") return;
      if (e.key === "ArrowRight" && step < TOTAL_STEPS - 1) {
        e.preventDefault();
        goTo(step + 1);
      } else if (e.key === "ArrowLeft" && step > 0) {
        e.preventDefault();
        goTo(step - 1);
      }
    },
    [status, step, goTo],
  );

  // ── Loading / error shells ────────────────────────────────────────────
  // The root layout reserves pt-[68px] sm:pt-16 for the fixed navbar, but
  // /welcome is a standalone flow without one (like /sync and /thank-you).
  // Pull the wrapper up over that padding so the page is truly full-bleed.
  const fullBleed = "-mt-[68px] min-h-screen sm:-mt-16";

  if (!isLoaded || status === "loading") {
    return (
      <div
        className={`flex items-center justify-center ${fullBleed}`}
        style={{ background: "linear-gradient(135deg, #001933 0%, #000d1a 100%)" }}
      >
        <div className="flex flex-col items-center gap-5">
          <div className="relative">
            <div className="h-14 w-14 rounded-full border-4 border-[#00e5ff]/20" />
            <div className="absolute top-0 left-0 h-14 w-14 rounded-full border-4 border-[#00e5ff] border-t-transparent animate-spin shadow-[0_0_20px_#00e5ff]" />
          </div>
          <p className="animate-pulse text-sm font-semibold tracking-wide text-[#00e5ff]">
            {t("ui.loading")}
          </p>
        </div>
      </div>
    );
  }

  if (status === "error") {
    return (
      <div
        className={`flex items-center justify-center px-4 ${fullBleed}`}
        style={{ background: "linear-gradient(135deg, #001933 0%, #000d1a 100%)" }}
      >
        <div className="w-full max-w-md rounded-2xl border border-[#ff2d9b]/40 bg-[#040d24]/80 p-8 text-center shadow-[0_0_30px_rgba(255,45,155,0.15)]">
          <p className="mb-2 text-4xl">⚠️</p>
          <h1 className="mb-2 text-lg font-extrabold text-white">{t("ui.error")}</h1>
          <p className="mb-6 text-sm leading-relaxed text-[#9dd8ff]">{t("onboarding.error.text")}</p>
          <div className="flex flex-col items-center gap-3 sm:flex-row sm:justify-center">
            <button
              type="button"
              onClick={() => void checkStatus()}
              className="rounded-xl bg-[#00e5ff] px-6 py-2.5 text-sm font-extrabold text-[#001a2e] shadow-[0_0_18px_rgba(0,229,255,0.5)] transition hover:brightness-110"
            >
              {t("onboarding.error.retry")}
            </button>
            <Link
              href="/games"
              className="text-sm font-semibold text-[#9dd8ff]/80 underline-offset-4 transition hover:text-[#d8fbff] hover:underline"
            >
              {t("onboarding.error.continue")} →
            </Link>
          </div>
        </div>
      </div>
    );
  }

  // ── Step content ──────────────────────────────────────────────────────
  const eyebrow = (text: string) => (
    <p className="mb-2 text-[11px] font-bold uppercase tracking-[0.3em] text-[#00e5ff]">
      ✦ {text}
    </p>
  );

  const cardCls =
    "rounded-2xl border border-[#00e5ff]/25 bg-[#040d24]/80 backdrop-blur-sm";

  let content: React.ReactNode = null;

  switch (step) {
    // 0 — Welcome hero.
    case 0: {
      content = (
        <div className="text-center">
          <div className="mx-auto mb-5 flex h-16 w-16 items-center justify-center">
            <div className="h-14 w-14 rotate-45 rounded-lg border-2 border-[#00e5ff] bg-gradient-to-br from-[#FF2D9B]/20 to-[#00e5ff]/20 shadow-[0_0_30px_rgba(0,229,255,0.5)]" />
          </div>
          <p className="mb-1 text-sm font-bold uppercase tracking-[0.25em] text-[#00e5ff]">
            {t("onboarding.welcome.kicker")}
          </p>
          <h1 className="logo-text mb-4 bg-gradient-to-r from-[#FFD700] via-[#FFB300] to-[#FFD700] bg-clip-text text-5xl font-bold tracking-tight text-transparent drop-shadow-[0_0_25px_rgba(255,215,0,0.35)] sm:text-6xl">
            {t("onboarding.welcome.title")}
          </h1>
          <p className="mx-auto max-w-md text-base leading-relaxed text-[#c9f7ff]/90 sm:text-lg">
            {t("onboarding.welcome.subtitle")}
          </p>
          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <button
              type="button"
              onClick={() => goTo(1)}
              className="w-full rounded-2xl bg-gradient-to-r from-[#FFD700] to-[#FFB300] px-10 py-4 text-lg font-extrabold text-black shadow-[0_0_30px_rgba(255,215,0,0.5)] transition-all hover:brightness-110 active:scale-[0.98] sm:w-auto"
            >
              {t("onboarding.welcome.play")} →
            </button>
            <button
              type="button"
              onClick={skip}
              disabled={saving}
              className="w-full rounded-2xl border border-[#00e5ff]/40 px-8 py-4 text-sm font-bold text-[#9dd8ff] transition hover:bg-[#00e5ff]/10 hover:text-[#d8fbff] disabled:opacity-60 sm:w-auto"
            >
              {t("onboarding.welcome.skip")}
            </button>
          </div>
          {saveFailed && <SaveError onRetry={finish} targetLabel={t("onboarding.error.continue")} targetHref={doneTarget} />}
        </div>
      );
      break;
    }

    // 1 — What is Grynd? Play / Outplay / Progress.
    case 1: {
      const pillars = [
        { icon: IconSwords, title: t("onboarding.what.playTitle"), desc: t("onboarding.what.playDesc"), color: "#00e5ff" },
        { icon: IconTarget, title: t("onboarding.what.outplayTitle"), desc: t("onboarding.what.outplayDesc"), color: "#FF2D9B" },
        { icon: IconTrophy, title: t("onboarding.what.progressTitle"), desc: t("onboarding.what.progressDesc"), color: "#FFD700" },
      ];
      content = (
        <div>
          {eyebrow(t("onboarding.what.kicker"))}
          <h2 className="mb-6 text-3xl font-extrabold tracking-tight text-white sm:text-4xl">
            {t("onboarding.what.title")}
          </h2>
          <div className="grid gap-3 sm:grid-cols-3">
            {pillars.map((p) => (
              <div key={p.title} className={`${cardCls} p-5 text-center`}>
                <p.icon
                  size={30}
                  className="mx-auto mb-3"
                  style={{ color: p.color, filter: `drop-shadow(0 0 10px ${p.color}66)` }}
                />
                <h3 className="mb-1.5 text-lg font-extrabold text-white">{p.title}</h3>
                <p className="text-sm leading-relaxed text-[#9dd8ff]">{p.desc}</p>
              </div>
            ))}
          </div>
        </div>
      );
      break;
    }

    // 2 — How tokens work (real terminology: balance chip top-right, wager to
    // enter matches, free AI practice).
    case 2: {
      const rows = [
        { icon: IconCoins, title: t("onboarding.tokens.areTitle"), desc: t("onboarding.tokens.areDesc"), color: "#FFD700" },
        { icon: IconUser, title: t("onboarding.tokens.whereTitle"), desc: t("onboarding.tokens.whereDesc"), color: "#00e5ff" },
        { icon: IconSwords, title: t("onboarding.tokens.usedTitle"), desc: t("onboarding.tokens.usedDesc"), color: "#FF2D9B" },
        { icon: IconDeviceGamepad2, title: t("onboarding.tokens.freeTitle"), desc: t("onboarding.tokens.freeDesc"), color: "#00FFA3" },
      ];
      content = (
        <div>
          {eyebrow(t("onboarding.tokens.kicker"))}
          <h2 className="mb-2 text-3xl font-extrabold tracking-tight text-white sm:text-4xl">
            {t("onboarding.tokens.title")}
          </h2>
          <p className="mb-6 text-base text-[#9dd8ff]">{t("onboarding.tokens.lead")}</p>
          <div className="space-y-3">
            {rows.map((r) => (
              <div key={r.title} className={`${cardCls} flex items-start gap-4 p-4`}>
                <div
                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl"
                  style={{ backgroundColor: `${r.color}1a`, border: `1px solid ${r.color}55` }}
                >
                  <r.icon size={22} style={{ color: r.color }} />
                </div>
                <div>
                  <h3 className="mb-0.5 font-extrabold text-white">{r.title}</h3>
                  <p className="text-sm leading-relaxed text-[#9dd8ff]">{r.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      );
      break;
    }

    // 3 — How PvP / matchmaking works.
    case 3: {
      const steps = [
        { icon: IconUsers, title: t("onboarding.pvp.s1Title"), desc: t("onboarding.pvp.s1Desc"), color: "#00e5ff" },
        { icon: IconBolt, title: t("onboarding.pvp.s2Title"), desc: t("onboarding.pvp.s2Desc"), color: "#FFD700" },
        { icon: IconSwords, title: t("onboarding.pvp.s3Title"), desc: t("onboarding.pvp.s3Desc"), color: "#FF2D9B" },
        { icon: IconTrophy, title: t("onboarding.pvp.s4Title"), desc: t("onboarding.pvp.s4Desc"), color: "#00FFA3" },
      ];
      content = (
        <div>
          {eyebrow(t("onboarding.pvp.kicker"))}
          <h2 className="mb-2 text-3xl font-extrabold tracking-tight text-white sm:text-4xl">
            {t("onboarding.pvp.title")}
          </h2>
          <p className="mb-6 text-base text-[#9dd8ff]">{t("onboarding.pvp.lead")}</p>
          <div className="space-y-3">
            {steps.map((s, i) => (
              <div key={s.title} className="flex items-start gap-4">
                <div className="flex flex-col items-center">
                  <div
                    className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full"
                    style={{ backgroundColor: `${s.color}1a`, border: `1px solid ${s.color}66`, boxShadow: `0 0 14px ${s.color}33` }}
                  >
                    <s.icon size={20} style={{ color: s.color }} />
                  </div>
                  {i < steps.length - 1 && <div className="my-1 h-5 w-px bg-[#00e5ff]/30" />}
                </div>
                <div className={`${cardCls} flex-1 p-4`}>
                  <h3 className="mb-0.5 font-extrabold text-white">
                    <span className="mr-1.5 text-[#00e5ff]/70">{i + 1}.</span>
                    {s.title}
                  </h3>
                  <p className="text-sm leading-relaxed text-[#9dd8ff]">{s.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      );
      break;
    }

    // 4 — "Your first match is free": the transition screen. It completes
    // onboarding and launches the player into the existing Free Play vs AI
    // tutorial match (the first-match stage is gated server-side by
    // users.first_game_completed_at — see /api/onboarding/first-game-complete).
    default: {
      const points = [
        { icon: IconTarget, text: t("onboarding.firstMatch.point1"), color: "#00e5ff" },
        { icon: IconRobot, text: t("onboarding.firstMatch.point2"), color: "#FFD700" },
        { icon: IconStar, text: t("onboarding.firstMatch.point3"), color: "#00FFA3" },
      ];
      content = (
        <div>
          <div className="mx-auto mb-5 max-w-md rounded-2xl border border-amber-500/40 bg-[#0a0f2e]/70 p-6 text-center shadow-[0_0_40px_rgba(255,215,0,0.14)] backdrop-blur-sm">
            <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl border border-[#00e5ff]/50 bg-[#00e5ff]/10 shadow-[0_0_25px_rgba(0,229,255,0.25)]">
              <IconRobot size={34} className="text-[#7cefff]" />
            </div>
            {eyebrow(t("onboarding.firstMatch.kicker"))}
            <span className="inline-block rounded-full border border-[#00FFA3]/50 bg-[#00FFA3]/10 px-3 py-1 text-[10px] font-black uppercase tracking-[0.2em] text-[#00FFA3]">
              Free Play · VS AI
            </span>
            <h2 className="mt-3 text-3xl font-extrabold tracking-tight text-white sm:text-4xl">
              {t("onboarding.firstMatch.title")}
            </h2>
            <p className="mx-auto mt-3 max-w-sm text-sm leading-relaxed text-[#c9f7ff]/90 sm:text-base">
              {t("onboarding.firstMatch.lead")}
            </p>
          </div>

          <div className="mx-auto mb-7 flex max-w-md flex-wrap items-center justify-center gap-2">
            {points.map((p) => (
              <span
                key={p.text}
                className={`${cardCls} inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold text-white/90`}
              >
                <p.icon size={15} style={{ color: p.color }} aria-hidden="true" />
                {p.text}
              </span>
            ))}
          </div>

          <div className="mx-auto flex max-w-md flex-col items-stretch gap-3 sm:flex-row sm:justify-center">
            <button
              type="button"
              onClick={() => void launch()}
              disabled={saving}
              className="rounded-2xl bg-gradient-to-r from-[#FFD700] to-[#FFB300] px-8 py-4 text-base font-extrabold text-black shadow-[0_0_30px_rgba(255,215,0,0.5)] transition-all hover:brightness-110 active:scale-[0.98] disabled:opacity-60 sm:px-10"
            >
              {saving ? t("ui.loading") : `${t("onboarding.firstMatch.cta")} →`}
            </button>
            <button
              type="button"
              onClick={() => void finish()}
              disabled={saving}
              className="rounded-2xl border border-[#00e5ff]/40 px-8 py-4 text-sm font-bold text-[#9dd8ff] transition hover:bg-[#00e5ff]/10 hover:text-[#d8fbff] disabled:opacity-60"
            >
              {saving ? t("ui.loading") : t("onboarding.firstMatch.alt")}
            </button>
          </div>
          {saveFailed && (
            <SaveError
              onRetry={() => void launch()}
              targetLabel={t("onboarding.error.continue")}
              targetHref="/games"
            />
          )}
        </div>
      );
      break;
    }
  }

  const isWelcome = step === 0;
  const isLast = step === TOTAL_STEPS - 1;

  return (
    <div
      className={`relative flex flex-col items-center overflow-hidden px-4 py-6 ${fullBleed}`}
      style={{ background: "linear-gradient(135deg, #001933 0%, #000d1f 50%, #000814 100%)" }}
    >
      {/* Ambient neon glows */}
      <div className="pointer-events-none absolute -top-40 left-1/2 h-96 w-[42rem] -translate-x-1/2 rounded-full bg-[#00e5ff]/10 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-48 left-1/4 h-96 w-96 rounded-full bg-[#FF2D9B]/10 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-40 right-1/4 h-72 w-72 rounded-full bg-[#00FFA3]/10 blur-3xl" />

      {/* Progress header (hidden on the full-bleed welcome hero) */}
      {!isWelcome && (
        <div className="relative z-10 mb-6 flex w-full max-w-2xl items-center justify-between gap-3">
          <button
            type="button"
            onClick={() => goTo(step - 1)}
            disabled={step === 0 || saving}
            aria-label={t("onboarding.controls.back")}
            className="flex h-10 w-10 items-center justify-center rounded-full border border-[#00e5ff]/40 text-[#9dd8ff] transition hover:bg-[#00e5ff]/10 hover:text-[#d8fbff] disabled:opacity-40"
          >
            <IconArrowLeft size={18} />
          </button>

          {/* Dots + step counter */}
          <div className="flex flex-col items-center gap-1.5" aria-hidden="true">
            <div className="flex items-center gap-1.5">
              {Array.from({ length: TOTAL_STEPS }).map((_, i) => (
                <span
                  key={i}
                  className={`h-1.5 rounded-full transition-all duration-300 ${
                    i === step
                      ? "w-6 bg-[#FFD700] shadow-[0_0_8px_rgba(255,215,0,0.8)]"
                      : i < step
                        ? "w-1.5 bg-[#00e5ff]"
                        : "w-1.5 bg-[#00e5ff]/30"
                  }`}
                />
              ))}
            </div>
            <p className="text-[10px] font-bold tracking-widest text-[#9dd8ff]/60">
              {step + 1} / {TOTAL_STEPS}
            </p>
          </div>
          <p className="sr-only" role="status">
            Step {step + 1} of {TOTAL_STEPS}
          </p>

          {!isLast && (
            <button
              type="button"
              onClick={skip}
              disabled={saving}
              className="h-10 rounded-full px-3 text-xs font-bold text-[#9dd8ff]/70 underline-offset-4 transition hover:text-[#d8fbff] hover:underline disabled:opacity-40"
            >
              {saving ? t("ui.loading") : t("onboarding.controls.skip")}
            </button>
          )}
        </div>
      )}

      {/* Step body */}
      <div className="relative z-10 flex w-full flex-1 items-center justify-center">
        <div
          ref={contentRef}
          tabIndex={-1}
          onKeyDown={onKeyDown}
          className="w-full max-w-2xl outline-none"
          role="group"
          aria-label={isWelcome ? t("onboarding.welcome.kicker") : `Step ${step + 1} of ${TOTAL_STEPS}`}
        >
          <AnimatePresence mode="wait">
            <motion.div
              key={step}
              initial={{ opacity: 0, y: 18 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -12 }}
              transition={{ duration: 0.28, ease: "easeOut" }}
            >
              {content}
            </motion.div>
          </AnimatePresence>
        </div>
      </div>

      {/* Footer controls (hidden on welcome hero + final step) */}
      {!isWelcome && !isLast && (
        <div className="relative z-10 mt-8 w-full max-w-2xl">
          <button
            type="button"
            onClick={() => goTo(step + 1)}
            className="flex w-full items-center justify-center gap-2 rounded-2xl bg-[#00e5ff] px-8 py-4 text-base font-extrabold text-[#001a2e] shadow-[0_0_25px_rgba(0,229,255,0.45)] transition hover:brightness-110 active:scale-[0.99]"
          >
            {/* On the PvP step the next control is the "Let's Play" that
                leads into the free-match transition screen. */}
            {step === 3 ? t("onboarding.welcome.play") : t("onboarding.controls.next")}{" "}
            <IconArrowRight size={18} />
          </button>
        </div>
      )}
    </div>
  );
}

function SaveError({
  onRetry,
  targetLabel,
  targetHref = "/games",
}: {
  onRetry: () => void;
  targetLabel: string;
  targetHref?: string;
}) {
  const { t } = useTranslation();
  return (
    <div className="mx-auto mt-5 max-w-md rounded-xl border border-red-400/40 bg-red-500/10 px-4 py-3 text-sm text-red-200" role="alert">
      <p className="mb-2">{t("onboarding.error.text")}</p>
      <div className="flex flex-wrap items-center justify-center gap-3">
        <button
          type="button"
          onClick={onRetry}
          className="rounded-lg bg-red-400/90 px-4 py-1.5 text-xs font-extrabold text-black transition hover:brightness-110"
        >
          {t("onboarding.error.retry")}
        </button>
        <Link
          href={targetHref}
          className="text-xs font-semibold text-red-200/80 underline-offset-4 hover:underline"
        >
          {targetLabel} →
        </Link>
      </div>
    </div>
  );
}
