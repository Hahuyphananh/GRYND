"use client";

// /welcome — Solitaire-first onboarding for brand-new accounts.
//
// Six steps, one guide (Glitch, inline), and a real first game:
//
//   0  Welcome to GRYND          — what the platform is now: Solitaire
//   1  Meet the Solitaire board  — stock · waste · tableau · foundations
//   2  Learn the rules           — the actual Klondike rules, in plain words
//   3  Interactive first game    — a REAL deal played through the REAL engine
//   4  Competitive Solitaire     — Solo · Daily · Bots · Ranked PvP
//   5  Completion                — Glitch's send-off + the lobby CTA
//
// There is deliberately no token, RPS, Mines or multi-game-catalogue copy in
// this flow: GRYND is a competitive Solitaire platform, and the first game the
// player touches is Solitaire.
//
// State model (unchanged from the previous flow, so existing users are safe):
//   * `users.onboarding_completed_at` (via /api/onboarding/complete) is the
//     server-authoritative "onboarded" flag. Existing users already have it, so
//     they are never re-onboarded unless they open ?replay=1 from Settings.
//   * The current step is mirrored in sessionStorage per user + tab, so a
//     refresh resumes mid-flow (step 0 always restarts).
//   * Completion is only ever written by the final CTA or Skip — opening the
//     page never marks anything complete.
//
// Tutorial tracking (started / completed / skipped) is best-effort and goes to
// /api/onboarding/progress; a failure there never blocks the player.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "framer-motion";
import { useUser } from "@clerk/nextjs";
import {
  IconArrowLeft,
  IconArrowRight,
  IconCards,
  IconCheck,
  IconClock,
  IconSwords,
  IconTarget,
  IconTrophy,
} from "@tabler/icons-react";
import { useTranslation } from "../../hooks/useTranslation";
import { shouldRouteWelcomeToQuestionnaire } from "../../lib/onboardingFlow";
import { GAME_ROUTE } from "../../lib/solitaire-duel/constants";
import {
  MODE_LABEL_KEYS,
  recommendedMode,
  recommendationReasonKey,
  SOLITAIRE_MODES,
  tutorialToneMessageKey,
  wantsRankedExplainer,
} from "../../lib/solitairePersonalization";
import PlayingCard from "../../components/solitaire-duel/PlayingCard";
import SolitaireTutorial from "../../components/solitaire-duel/SolitaireTutorial";
import GlitchSay from "../../components/mascot/GlitchSay";
import { glitchWelcomeLine } from "../../lib/mascot/glitchOnboarding";

const TOTAL_STEPS = 6;
const STEP_STORAGE_PREFIX = "grynd:welcome:step:";

/** The real Solitaire lobby (never a guessed or archived route). */
const LOBBY_URL = GAME_ROUTE;

type Props = {
  /** ?replay=1 — opened from Settings; skips the "already completed" bounce. */
  replay?: boolean;
  /** ?from=questionnaire — the questionnaire just handed the player here. */
  fromQuestionnaire?: boolean;
};

type Answers = Record<string, string | string[]>;

export default function WelcomePageClient({ replay = false, fromQuestionnaire = false }: Props) {
  const { isLoaded, isSignedIn, user } = useUser();
  const { t } = useTranslation();

  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [step, setStep] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const [answers, setAnswers] = useState<Answers>({});
  const contentRef = useRef<HTMLDivElement>(null);

  const storageKey = user?.id ? `${STEP_STORAGE_PREFIX}${user.id}` : null;
  const doneTarget = replay ? "/settings" : LOBBY_URL;
  const recommended = useMemo(() => recommendedMode(answers), [answers]);

  const clearStepStorage = useCallback(() => {
    if (!storageKey) return;
    try {
      sessionStorage.removeItem(storageKey);
    } catch {
      // sessionStorage unavailable — harmless.
    }
  }, [storageKey]);

  /** Fire-and-forget tutorial tracking; never blocks the flow. */
  const track = useCallback((event: "welcome_started" | "tutorial_started" | "tutorial_completed" | "tutorial_skipped") => {
    try {
      void fetch("/api/onboarding/progress", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event }),
        keepalive: true,
      }).catch(() => {});
    } catch {
      // fetch unavailable — the flow still works
    }
  }, []);

  // 1) Check the server-side completion flag once Clerk is ready.
  const checkStatus = useCallback(async () => {
    if (!isLoaded || !isSignedIn) return;
    setStatus("loading");
    try {
      const res = await fetch("/api/onboarding/status", { credentials: "include" });
      const data = await res.json();
      if (!res.ok || data?.success !== true) throw new Error("bad status response");

      if (data.onboardingCompleted === true && !replay) {
        // Existing user (or completed elsewhere). Never re-onboard them.
        window.location.replace("/");
        return;
      }

      // Brand-new account that hasn't answered (or declined) the Solitaire
      // questionnaire yet: questionnaire first, then this flow. Existing
      // accounts cannot reach this branch; replay and the questionnaire
      // hand-off are exempt, so the two pages can never loop.
      if (
        shouldRouteWelcomeToQuestionnaire({
          onboardingCompleted: data.onboardingCompleted === true,
          questionnaireCompleted: data.questionnaireCompleted === true,
          questionnaireDismissed: data.questionnaireDismissed === true,
          replay,
          fromQuestionnaire,
        })
      ) {
        window.location.replace("/welcome/questionnaire?from=welcome");
        return;
      }

      // Personalization is optional and best-effort: it only decides which
      // mode is highlighted and which tutorial framing Glitch uses.
      try {
        const answersRes = await fetch("/api/onboarding/questionnaire", {
          credentials: "include",
        });
        const answersData = await answersRes.json();
        if (answersRes.ok && answersData?.success === true && answersData.answers) {
          setAnswers(answersData.answers as Answers);
        }
      } catch {
        // no answers — Solo practice is the default
      }

      if (!replay && storageKey) {
        try {
          const saved = Number(sessionStorage.getItem(storageKey));
          if (Number.isInteger(saved) && saved > 0 && saved <= TOTAL_STEPS - 1) {
            setStep(saved);
          }
        } catch {
          // ignore
        }
      }
      setStatus("ready");
      track("welcome_started");
    } catch (err) {
      console.error("[WELCOME_STATUS_ERROR]", err);
      setStatus("error");
    }
  }, [isLoaded, isSignedIn, replay, fromQuestionnaire, storageKey, track]);

  useEffect(() => {
    if (!isLoaded) return;
    if (!isSignedIn) {
      window.location.replace("/");
      return;
    }
    void checkStatus();
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

  const goTo = useCallback((next: number) => {
    setSaveFailed(false);
    setStep(Math.max(0, Math.min(TOTAL_STEPS - 1, next)));
  }, []);

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
      window.location.replace(doneTarget);
    } catch (err) {
      console.error("[WELCOME_COMPLETE_ERROR]", err);
      setSaving(false);
      setSaveFailed(true);
    }
  }, [completeOnboarding, clearStepStorage, doneTarget]);

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

  const fullBleed = "-mt-[68px] min-h-screen sm:-mt-16";
  const recommendedLabel = t(MODE_LABEL_KEYS[recommended]);

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
              href={LOBBY_URL}
              className="text-sm font-semibold text-[#9dd8ff]/80 underline-offset-4 transition hover:text-[#d8fbff] hover:underline"
            >
              {t("onboarding.error.continue")} →
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const eyebrow = (text: string) => (
    <p className="mb-2 text-[11px] font-bold uppercase tracking-[0.3em] text-[#00e5ff]">✦ {text}</p>
  );
  const cardCls = "rounded-2xl border border-[#00e5ff]/25 bg-[#040d24]/80 backdrop-blur-xs";

  let content: React.ReactNode = null;

  switch (step) {
    // 0 — Welcome to GRYND.
    case 0: {
      content = (
        <div className="text-center">
          <GlitchGuide step={0} center />
          <p className="mb-1 text-sm font-bold uppercase tracking-[0.25em] text-[#00e5ff]">
            {t("onboarding.solitaire.welcome.kicker")}
          </p>
          <h1 className="logo-text mb-4 bg-linear-to-r from-[#FFD700] via-[#FFB300] to-[#FFD700] bg-clip-text text-4xl font-bold tracking-tight text-transparent drop-shadow-[0_0_25px_rgba(255,215,0,0.35)] sm:text-6xl">
            {t("onboarding.solitaire.welcome.title")}
          </h1>
          <p className="mx-auto max-w-md text-base leading-relaxed text-[#c9f7ff]/90 sm:text-lg">
            {t("onboarding.solitaire.welcome.subtitle")}
          </p>
          <div className="mx-auto mt-6 flex max-w-md flex-wrap items-center justify-center gap-2">
            {(["solo_practice", "daily_challenge", "play_vs_bots", "ranked_pvp"] as const).map(
              (mode) => (
                <span
                  key={mode}
                  className={`${cardCls} inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold text-white/90`}
                >
                  {t(MODE_LABEL_KEYS[mode])}
                </span>
              ),
            )}
          </div>
          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <button
              type="button"
              onClick={() => goTo(1)}
              className="w-full rounded-2xl bg-linear-to-r from-[#FFD700] to-[#FFB300] px-10 py-4 text-lg font-extrabold text-black shadow-[0_0_30px_rgba(255,215,0,0.5)] transition-all hover:brightness-110 active:scale-[0.98] sm:w-auto"
            >
              {t("onboarding.solitaire.welcome.play")} →
            </button>
            <button
              type="button"
              onClick={() => void finish()}
              disabled={saving}
              className="w-full rounded-2xl border border-[#00e5ff]/40 px-8 py-4 text-sm font-bold text-[#9dd8ff] transition hover:bg-[#00e5ff]/10 hover:text-[#d8fbff] disabled:opacity-60 sm:w-auto"
            >
              {saving ? t("ui.loading") : t("onboarding.controls.skip")}
            </button>
          </div>
          {saveFailed && <SaveError onRetry={() => void finish()} targetLabel={t("onboarding.error.continue")} targetHref={doneTarget} />}
        </div>
      );
      break;
    }

    // 1 — Meet the board: stock, waste, tableau, foundations.
    case 1: {
      const areas = [
        { key: "stock", icon: IconCards, accent: "#00e5ff" },
        { key: "waste", icon: IconCards, accent: "#FF2D9B" },
        { key: "tableau", icon: IconTarget, accent: "#FFD700" },
        { key: "foundations", icon: IconTrophy, accent: "#00FFA3" },
      ] as const;
      content = (
        <div>
          <GlitchGuide step={1} />
          {eyebrow(t("onboarding.solitaire.board.kicker"))}
          <h2 className="mb-2 text-3xl font-extrabold tracking-tight text-white sm:text-4xl">
            {t("onboarding.solitaire.board.title")}
          </h2>
          <p className="mb-5 text-sm leading-relaxed text-[#9dd8ff] sm:text-base">
            {t("onboarding.solitaire.board.lead")}
          </p>

          {/* A real card face + real board slots, so the lesson looks like the
              board the player is about to use. */}
          <div className="mb-5 rounded-2xl border border-[#00e5ff]/20 bg-[#02101f]/80 p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-3">
                <div className="flex flex-col items-center gap-1">
                  <PlayingCard card={null} faceUp={false} style={{ width: 44, height: 62 }} />
                  <span className="text-[9px] font-bold uppercase tracking-wider text-[#9dd8ff]/70">
                    {t("onboarding.solitaire.board.stock")}
                  </span>
                </div>
                <div className="flex flex-col items-center gap-1">
                  <PlayingCard
                    card={{ suit: "spades", rank: 13 }}
                    faceUp
                    style={{ width: 44, height: 62 }}
                  />
                  <span className="text-[9px] font-bold uppercase tracking-wider text-[#9dd8ff]/70">
                    {t("onboarding.solitaire.board.waste")}
                  </span>
                </div>
              </div>
              <div className="flex items-start gap-1.5">
                {(["spades", "hearts", "diamonds", "clubs"] as const).map((suit, index) => (
                  <div
                    key={suit}
                    className="flex flex-col items-center gap-1"
                    aria-hidden="true"
                  >
                    <div
                      className="flex items-center justify-center rounded-md border-2 border-dashed border-[#00e5ff]/35 bg-white/[0.03] text-sm text-[#9dd8ff]"
                      style={{ width: 44, height: 62 }}
                    >
                      {["♠", "♥", "♦", "♣"][index]}
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <p className="mt-2 text-center text-[9px] font-bold uppercase tracking-wider text-[#9dd8ff]/70">
              {t("onboarding.solitaire.board.foundations")}
            </p>
            <div className="mt-4 flex items-end justify-center gap-2">
              {[
                { rank: 9, suit: "hearts" as const, offset: 0 },
                { rank: 6, suit: "clubs" as const, offset: 14 },
                { rank: 5, suit: "diamonds" as const, offset: 28 },
              ].map((column) => (
                <div key={`${column.suit}-${column.rank}`} className="flex flex-col items-center">
                  <div className="relative" style={{ height: 62, width: 44 }}>
                    <div style={{ marginTop: column.offset }}>
                      <PlayingCard
                        card={{ suit: column.suit, rank: column.rank as 5 | 6 | 9 }}
                        faceUp
                        style={{ width: 44, height: 62 }}
                      />
                    </div>
                  </div>
                </div>
              ))}
            </div>
            <p className="mt-2 text-center text-[9px] font-bold uppercase tracking-wider text-[#9dd8ff]/70">
              {t("onboarding.solitaire.board.tableau")}
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            {areas.map((area) => (
              <div key={area.key} className={`${cardCls} flex items-start gap-3 p-4`}>
                <div
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl"
                  style={{ backgroundColor: `${area.accent}1a`, border: `1px solid ${area.accent}55` }}
                >
                  <area.icon size={20} style={{ color: area.accent }} aria-hidden="true" />
                </div>
                <div>
                  <h3 className="text-sm font-extrabold text-white">
                    {t(`onboarding.solitaire.board.${area.key}Title`)}
                  </h3>
                  <p className="mt-0.5 text-xs leading-relaxed text-[#9dd8ff]">
                    {t(`onboarding.solitaire.board.${area.key}Desc`)}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      );
      break;
    }

    // 2 — The actual Klondike rules, in plain language.
    case 2: {
      const rules = [
        { key: "descending", icon: IconCards, accent: "#00e5ff" },
        { key: "alternate", icon: IconTarget, accent: "#FF2D9B" },
        { key: "runs", icon: IconSwords, accent: "#FFD700" },
        { key: "reveal", icon: IconCheck, accent: "#00FFA3" },
        { key: "aces", icon: IconTrophy, accent: "#f0abfc" },
        { key: "draw", icon: IconClock, accent: "#7cefff" },
      ] as const;
      content = (
        <div>
          <GlitchGuide step={2} />
          {eyebrow(t("onboarding.solitaire.rules.kicker"))}
          <h2 className="mb-2 text-3xl font-extrabold tracking-tight text-white sm:text-4xl">
            {t("onboarding.solitaire.rules.title")}
          </h2>
          <p className="mb-5 text-sm leading-relaxed text-[#9dd8ff] sm:text-base">
            {t("onboarding.solitaire.rules.lead")}
          </p>
          <ol className="space-y-2.5">
            {rules.map((rule, index) => (
              <li key={rule.key} className={`${cardCls} flex items-start gap-3 p-3.5`}>
                <span
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[11px] font-black"
                  style={{ backgroundColor: `${rule.accent}1a`, color: rule.accent, border: `1px solid ${rule.accent}55` }}
                  aria-hidden="true"
                >
                  {index + 1}
                </span>
                <div>
                  <h3 className="text-sm font-extrabold text-white">
                    {t(`onboarding.solitaire.rules.${rule.key}Title`)}
                  </h3>
                  <p className="mt-0.5 text-xs leading-relaxed text-[#9dd8ff]">
                    {t(`onboarding.solitaire.rules.${rule.key}Desc`)}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      );
      break;
    }

    // 3 — The interactive first game (real engine, real deal).
    case 3: {
      content = (
        <div>
          <GlitchGuide step={3} messageKey={tutorialToneMessageKey(answers)} />
          {eyebrow(t("onboarding.solitaire.tutorial.kicker"))}
          <h2 className="mb-2 text-3xl font-extrabold tracking-tight text-white sm:text-4xl">
            {t("onboarding.solitaire.tutorial.ledeTitle")}
          </h2>
          <p className="mb-4 text-sm leading-relaxed text-[#9dd8ff] sm:text-base">
            {t("onboarding.solitaire.tutorial.lead")}
          </p>
          <SolitaireTutorial
            onStarted={() => track("tutorial_started")}
            onComplete={() => {
              track("tutorial_completed");
              goTo(4);
            }}
            onSkip={() => {
              track("tutorial_skipped");
              goTo(4);
            }}
            recommendedLabel={recommendedLabel}
          />
        </div>
      );
      break;
    }

    // 4 — The four competitive Solitaire modes.
    case 4: {
      const modes = SOLITAIRE_MODES.map((mode) => ({ mode, key: MODE_LABEL_KEYS[mode] }));
      content = (
        <div>
          <GlitchGuide step={4} />
          {eyebrow(t("onboarding.solitaire.modes.kicker"))}
          <h2 className="mb-2 text-3xl font-extrabold tracking-tight text-white sm:text-4xl">
            {t("onboarding.solitaire.modes.title")}
          </h2>
          <p className="mb-5 text-sm leading-relaxed text-[#9dd8ff] sm:text-base">
            {t("onboarding.solitaire.modes.lead")}
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            {modes.map(({ mode, key }) => {
              const isRecommended = mode === recommended;
              return (
                <div
                  key={mode}
                  className={`${cardCls} p-4 ${isRecommended ? "border-[#FFD700]/60 shadow-[0_0_22px_rgba(255,215,0,0.16)]" : ""}`}
                >
                  <div className="mb-1 flex items-center gap-2">
                    <h3 className="text-sm font-extrabold text-white">{t(key)}</h3>
                    {isRecommended && (
                      <span className="rounded-full border border-[#FFD700]/50 bg-[#FFD700]/10 px-2 py-0.5 text-[9px] font-black uppercase tracking-widest text-[#FFD700]">
                        {t("onboarding.solitaire.modes.recommended")}
                      </span>
                    )}
                  </div>
                  <p className="text-xs leading-relaxed text-[#9dd8ff]">
                    {t(`onboarding.solitaire.modes.${mode}.desc`)}
                  </p>
                </div>
              );
            })}
          </div>
          <p className="mt-3 text-xs font-semibold text-[#FFD700]/90">
            {t(recommendationReasonKey(answers))}
          </p>
          <div className="mt-4 space-y-2">
            <p className="rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 text-[11px] leading-relaxed text-[#9dd8ff]">
              {t("onboarding.solitaire.modes.botsNote")}
            </p>
            <p className="rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 text-[11px] leading-relaxed text-[#9dd8ff]">
              {wantsRankedExplainer(answers)
                ? t("onboarding.solitaire.modes.rankedNote")
                : t("onboarding.solitaire.modes.rankedNoteShort")}
            </p>
          </div>
        </div>
      );
      break;
    }

    // 5 — Completion.
    default: {
      content = (
        <div className="text-center">
          <GlitchGuide step={5} center />
          <div className="mx-auto mb-5 max-w-md rounded-2xl border border-[#00FFA3]/35 bg-[#00FFA3]/5 p-6">
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl border border-[#00FFA3]/50 bg-[#00FFA3]/10">
              <IconCheck size={28} className="text-[#b6ffe0]" aria-hidden="true" />
            </div>
            {eyebrow(t("onboarding.solitaire.done.kicker"))}
            <h2 className="text-3xl font-extrabold tracking-tight text-white sm:text-4xl">
              {t("onboarding.solitaire.done.title")}
            </h2>
            <p className="mx-auto mt-3 max-w-sm text-sm leading-relaxed text-[#c9f7ff]/90">
              {t("onboarding.solitaire.done.lead")}
            </p>
            <p className="mt-3 text-xs font-semibold text-[#FFD700]">
              {t("onboarding.solitaire.done.recommended", { mode: recommendedLabel })}
            </p>
          </div>
          <div className="mx-auto flex max-w-md flex-col items-stretch gap-3 sm:flex-row sm:justify-center">
            <button
              type="button"
              onClick={() => void finish()}
              disabled={saving}
              className="rounded-2xl bg-linear-to-r from-[#FFD700] to-[#FFB300] px-8 py-4 text-base font-extrabold text-black shadow-[0_0_30px_rgba(255,215,0,0.5)] transition-all hover:brightness-110 active:scale-[0.98] disabled:opacity-60 sm:px-10"
            >
              {saving ? t("ui.loading") : `${t("onboarding.solitaire.done.cta")} →`}
            </button>
            {replay && (
              <Link
                href="/settings"
                className="rounded-2xl border border-[#00e5ff]/40 px-8 py-4 text-sm font-bold text-[#9dd8ff] transition hover:bg-[#00e5ff]/10 hover:text-[#d8fbff]"
              >
                {t("onboarding.solitaire.done.backToSettings")}
              </Link>
            )}
          </div>
          {saveFailed && (
            <SaveError onRetry={() => void finish()} targetLabel={t("onboarding.error.continue")} targetHref={doneTarget} />
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
      <div className="pointer-events-none absolute -top-40 left-1/2 h-96 w-[42rem] -translate-x-1/2 rounded-full bg-[#00e5ff]/10 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-48 left-1/4 h-96 w-96 rounded-full bg-[#FF2D9B]/10 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-40 right-1/4 h-72 w-72 rounded-full bg-[#00FFA3]/10 blur-3xl" />

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
              onClick={() => void finish()}
              disabled={saving}
              className="h-10 rounded-full px-3 text-xs font-bold text-[#9dd8ff]/70 underline-offset-4 transition hover:text-[#d8fbff] hover:underline disabled:opacity-40"
            >
              {saving ? t("ui.loading") : t("onboarding.controls.skip")}
            </button>
          )}
        </div>
      )}

      <div className="relative z-10 flex w-full flex-1 items-center justify-center">
        <div
          ref={contentRef}
          tabIndex={-1}
          onKeyDown={onKeyDown}
          className="w-full max-w-2xl outline-hidden"
          role="group"
          aria-label={isWelcome ? t("onboarding.solitaire.welcome.kicker") : `Step ${step + 1} of ${TOTAL_STEPS}`}
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

      {!isWelcome && !isLast && (
        <div className="relative z-10 mt-8 w-full max-w-2xl">
          <button
            type="button"
            onClick={() => goTo(step + 1)}
            className="flex w-full items-center justify-center gap-2 rounded-2xl bg-[#00e5ff] px-8 py-4 text-base font-extrabold text-[#001a2e] shadow-[0_0_25px_rgba(0,229,255,0.45)] transition hover:brightness-110 active:scale-[0.99]"
          >
            {t("onboarding.controls.next")} <IconArrowRight size={18} />
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Glitch's line for one onboarding step, INLINE in the page.
 *
 * Inline, never floating: the mascot is part of the step, so it can never
 * cover the heading, the progress dots or the Back/Next/Skip controls. The
 * expression and copy come from src/lib/mascot/glitchOnboarding.ts →
 * appTextTranslations (`onboarding.glitch.welcome.*`, en/fr/es).
 */
function GlitchGuide({
  step,
  center = false,
  messageKey,
}: {
  step: number;
  center?: boolean;
  /** Overrides the step's default line (e.g. the tutorial tone by experience). */
  messageKey?: string;
}) {
  const { t } = useTranslation();
  const line = glitchWelcomeLine(step);
  if (!line) return null;
  return (
    <div className={center ? "mb-5 flex justify-center" : "mb-5"}>
      <GlitchSay
        expression={line.expression}
        message={t(messageKey ?? line.messageKey)}
        placement="inline"
        size={step === 0 ? "md" : "sm"}
      />
    </div>
  );
}

function SaveError({
  onRetry,
  targetLabel,
  targetHref,
}: {
  onRetry: () => void;
  targetLabel: string;
  targetHref: string;
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
        <Link href={targetHref} className="text-xs font-semibold text-red-200/80 underline-offset-4 hover:underline">
          {targetLabel} →
        </Link>
      </div>
    </div>
  );
}
