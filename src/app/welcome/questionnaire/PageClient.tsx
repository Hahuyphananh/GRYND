"use client";

// /welcome/questionnaire — the GRYND onboarding questionnaire.
//
// A five-question, one-question-per-screen flow that collects GAME
// PREFERENCES ONLY (never sensitive data) and stores them server-side through
// /api/onboarding/questionnaire (rows in onboarding_responses + the separate
// users.questionnaire_completed_at flag).
//
// Where it sits in the onboarding architecture (the decisions themselves live
// in src/lib/onboardingFlow.js, shared with /welcome and the lobby card):
//
//   Sign up → /welcome/questionnaire → existing /welcome tutorial →
//   "your first match is free" → existing RPS Free Play vs AI onboarding match
//
// Existing players are never sent through the tutorial again: they arrive
// here from the lobby invitation or from Settings and go straight back.
// Skipping never marks the questionnaire answered — it records the same
// server-authoritative "Maybe Later" as the lobby invitation (dismissal), so
// it is not asked again but stays reachable from Settings.
//
// This page deliberately does NOT replace or re-implement the welcome
// tutorial, and it never marks the tutorial complete: the two completion
// states are independent on purpose. Answers are drafted locally so a
// refresh or an accidental back-navigation mid-flow doesn't lose them, and
// existing accounts that already answered can reopen this page to edit —
// it prefills from the server and PUTs a replacement.
//
// TWO MODES, ONE FLOW (and one API):
//
//   FIRST TIME  (`completed === false`) — reached from signup (or the lobby
//               invitation): the whole onboarding questionnaire.
//   EDIT MODE   (`completed === true`)  — reached from Settings → "Your GRYND
//               Preferences": the SAME five questions, prefilled from the
//               server, with copy that says so ("Editing your preferences",
//               "Save changes") and a Cancel that writes nothing. Saving PUTs a
//               replacement, so answers are updated in place — never
//               duplicated.
//
// All copy comes from src/lib/appTextTranslations.js
// (`onboarding.questionnaire.*`); the question/option ids come from
// src/lib/onboardingQuestionnaire.js.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "framer-motion";
import { useUser } from "@clerk/nextjs";
import { IconArrowLeft, IconArrowRight, IconCheck, IconPencil } from "@tabler/icons-react";
import { useTranslation } from "../../../hooks/useTranslation";
import {
  QUESTIONNAIRE_QUESTIONS,
  QUESTIONNAIRE_VERSION,
} from "../../../lib/onboardingQuestionnaire";
import { questionnaireDestination } from "../../../lib/onboardingFlow";

type AnswerValue = string | string[];
type Answers = Record<string, AnswerValue>;
type Status = "loading" | "ready" | "error";

const TOTAL = QUESTIONNAIRE_QUESTIONS.length;
const DRAFT_PREFIX = "grynd:questionnaire:draft:";

// Per-question accent colours, matching the neon palette used across the
// welcome flow (cyan / pink / gold / green / lilac).
const ACCENTS = ["#00e5ff", "#FF2D9B", "#FFD700", "#00FFA3", "#f0abfc"];

type Props = {
  /** ?from=welcome|lobby|settings — opened from the signup hand-off (welcome)
   *  or from an existing-user surface. Only affects the destination. */
  from?: "welcome" | "lobby" | "settings";
};

export default function QuestionnairePageClient({ from }: Props) {
  const { isLoaded, isSignedIn, user } = useUser();
  const { t } = useTranslation();

  const [status, setStatus] = useState<Status>("loading");
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState<Answers>({});
  const [onboardingCompleted, setOnboardingCompleted] = useState(false);
  // Server-authoritative "has answered before" — decides FIRST TIME vs EDIT
  // MODE. Coming from Settings to answer for the first time is still a first
  // run; coming from anywhere with saved answers is an edit.
  const [completed, setCompleted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  // Set when the user tries to move on without answering — the Next/Finish
  // controls stay usable so the validation message is actually reachable
  // (a permanently disabled button would silently explain nothing).
  const [showValidation, setShowValidation] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const submittedRef = useRef(false);

  // Draft key is per user + versioned: a shape change can't resurrect stale
  // answers ("sessionStorage can throw" — every access is guarded).
  const draftKey = useMemo(
    () => (user?.id ? `${DRAFT_PREFIX}v${QUESTIONNAIRE_VERSION}:${user.id}` : null),
    [user?.id]
  );

  const clearDraft = useCallback(() => {
    if (!draftKey) return;
    try {
      sessionStorage.removeItem(draftKey);
    } catch {
      // storage unavailable — harmless
    }
  }, [draftKey]);

  // 1) Load server state (prefill + completion) once Clerk is ready.
  const load = useCallback(async () => {
    if (!isLoaded || !isSignedIn) return;
    setStatus("loading");
    try {
      const res = await fetch("/api/onboarding/questionnaire", {
        credentials: "include",
      });
      const data = await res.json();
      if (!res.ok || data?.success !== true) throw new Error("bad response");

      const serverAnswers: Answers =
        data.answers && typeof data.answers === "object" ? data.answers : {};
      setOnboardingCompleted(data.onboardingCompleted === true);
      setCompleted(data.completed === true);

      // A local draft (mid-flow refresh) wins over the server snapshot — it is
      // the user's most recent intent — but only question by question, so the
      // server prefill still backs it up.
      let nextAnswers: Answers = serverAnswers;
      let nextStep = 0;
      if (draftKey) {
        try {
          const raw = sessionStorage.getItem(draftKey);
          const parsed = raw ? JSON.parse(raw) : null;
          if (
            parsed?.answers &&
            typeof parsed.answers === "object" &&
            Object.keys(parsed.answers).length > 0
          ) {
            nextAnswers = { ...serverAnswers, ...parsed.answers };
            if (Number.isInteger(parsed.step)) {
              nextStep = Math.max(0, Math.min(TOTAL - 1, parsed.step));
            }
          }
        } catch {
          // ignore malformed draft
        }
      }

      setAnswers(nextAnswers);
      setStep(nextStep);
      setStatus("ready");
    } catch (err) {
      console.error("[QUESTIONNAIRE_LOAD_ERROR]", err);
      setStatus("error");
    }
  }, [draftKey, isLoaded, isSignedIn]);

  useEffect(() => {
    if (!isLoaded) return;
    // Signed-out visitors can't answer — same hand-off as /welcome.
    if (!isSignedIn) {
      window.location.replace("/");
      return;
    }
    void load();
  }, [isLoaded, isSignedIn, load]);

  // 2) Keep the draft in step with the selections (survives refresh/back).
  useEffect(() => {
    if (status !== "ready" || !draftKey || submittedRef.current) return;
    try {
      sessionStorage.setItem(draftKey, JSON.stringify({ step, answers }));
    } catch {
      // ignore
    }
  }, [status, draftKey, step, answers]);

  // 3) Move focus to the question heading on every transition (keyboard UX).
  useEffect(() => {
    if (status === "ready") contentRef.current?.focus();
  }, [step, status]);

  // `mode` drives every first-time vs edit difference in this page.
  const mode: "first" | "edit" = completed ? "edit" : "first";

  const isAnswered = useCallback(
    (question: (typeof QUESTIONNAIRE_QUESTIONS)[number]) => {
      const value = answers[question.key];
      if (question.type === "single") return typeof value === "string" && value.length > 0;
      return (
        Array.isArray(value) && value.length > 0 && value.length <= (question.maxSelect ?? Infinity)
      );
    },
    [answers]
  );

  const allAnswered = useMemo(
    () => QUESTIONNAIRE_QUESTIONS.every((q) => isAnswered(q)),
    [isAnswered]
  );

  const question = QUESTIONNAIRE_QUESTIONS[step];
  const accent = ACCENTS[step % ACCENTS.length];
  const isLast = step === TOTAL - 1;
  const canAdvance = isAnswered(question);

  const toggleOption = useCallback(
    (questionKey: string, type: "single" | "multi", value: string) => {
      setSaveFailed(false);
      setShowValidation(false);
      setAnswers((prev) => {
        if (type === "single") return { ...prev, [questionKey]: value };
        const current = Array.isArray(prev[questionKey]) ? (prev[questionKey] as string[]) : [];
        const limit =
          QUESTIONNAIRE_QUESTIONS.find((q) => q.key === questionKey)?.maxSelect ?? Infinity;
        if (current.includes(value)) {
          return { ...prev, [questionKey]: current.filter((v) => v !== value) };
        }
        if (current.length >= limit) return prev; // limit reached — ignore extras
        return { ...prev, [questionKey]: [...current, value] };
      });
    },
    []
  );

  const goTo = useCallback((next: number) => {
    setSaveFailed(false);
    setShowValidation(false);
    setStep(Math.max(0, Math.min(TOTAL - 1, next)));
  }, []);

  // Where the user goes once they're done (or skip) — see
  // questionnaireDestination: existing accounts land in the lobby, brand-new
  // ones continue into the existing /welcome tutorial (carrying
  // `from=questionnaire` so /welcome never hands them back here).
  const destination = useMemo(
    () => questionnaireDestination({ from, onboardingCompleted }),
    [from, onboardingCompleted]
  );

  // "Skip for now" = the same server-authoritative "Maybe Later" as the lobby
  // invitation: it deliberately does NOT mark the questionnaire answered, it
  // just stops us asking again (and keeps the Settings entry usable).
  // Fire-and-forget with keepalive so a slow network can never trap the user
  // on this page — the destination's `from=questionnaire` marker already
  // prevents a bounce if the dismissal never lands.
  const skip = useCallback(() => {
    try {
      void fetch("/api/onboarding/questionnaire/dismiss", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        keepalive: true,
      }).catch(() => {});
    } catch {
      // fetch unavailable — navigation still proceeds
    }
    window.location.replace(destination);
  }, [destination]);

  const submit = useCallback(async () => {
    // Guard: never submit a partially answered questionnaire.
    if (!QUESTIONNAIRE_QUESTIONS.every((q) => isAnswered(q))) return;
    setSaving(true);
    setSaveFailed(false);
    try {
      const res = await fetch("/api/onboarding/questionnaire", {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answers }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || data?.success !== true) throw new Error("submit failed");
      submittedRef.current = true;
      clearDraft();
      // Full navigation (not router.replace): back/refresh can't resubmit and
      // the destination gets a clean mount — same convention as /welcome.
      window.location.replace(destination);
    } catch (err) {
      console.error("[QUESTIONNAIRE_SUBMIT_ERROR]", err);
      setSaving(false);
      setSaveFailed(true);
    }
  }, [answers, clearDraft, destination, isAnswered]);

  // Next: validate before proceeding (and explain why when it can't).
  const advance = useCallback(() => {
    if (!canAdvance) {
      setShowValidation(true);
      return;
    }
    goTo(step + 1);
  }, [canAdvance, goTo, step]);

  // Finish: if anything is still unanswered, jump to that question instead of
  // submitting an incomplete payload — the API validates too.
  const finish = useCallback(() => {
    if (!allAnswered) {
      const firstMissing = QUESTIONNAIRE_QUESTIONS.findIndex((q) => !isAnswered(q));
      setShowValidation(true);
      if (firstMissing !== -1 && firstMissing !== step) setStep(firstMissing);
      return;
    }
    void submit();
  }, [allAnswered, isAnswered, step, submit]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (status !== "ready" || saving) return;
      if (e.key === "ArrowRight" && !isLast) {
        e.preventDefault();
        advance();
      } else if (e.key === "ArrowLeft" && step > 0) {
        e.preventDefault();
        goTo(step - 1);
      }
    },
    [status, saving, isLast, step, goTo, advance]
  );

  // Pull the page up over the root layout's fixed-navbar padding — same
  // full-bleed shell as /welcome.
  const fullBleed = "-mt-[68px] min-h-screen sm:-mt-16";

  if (!isLoaded || status === "loading") {
    return (
      <div
        className={`flex items-center justify-center ${fullBleed}`}
        style={{ background: "linear-gradient(135deg, #001933 0%, #000d1a 100%)" }}
        aria-busy="true"
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
          <h1 className="mb-2 text-lg font-extrabold text-white">
            {t("onboarding.questionnaire.error.title")}
          </h1>
          <p className="mb-6 text-sm leading-relaxed text-[#9dd8ff]">
            {t("onboarding.questionnaire.error.text")}
          </p>
          <div className="flex flex-col items-center gap-3 sm:flex-row sm:justify-center">
            <button
              type="button"
              onClick={() => void load()}
              className="rounded-xl bg-[#00e5ff] px-6 py-2.5 text-sm font-extrabold text-[#001a2e] shadow-[0_0_18px_rgba(0,229,255,0.5)] transition hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff]"
            >
              {t("onboarding.questionnaire.error.retry")}
            </button>
            <Link
              href={destination}
              className="text-sm font-semibold text-[#9dd8ff]/80 underline-offset-4 transition hover:text-[#d8fbff] hover:underline"
            >
              {t("onboarding.questionnaire.error.continue")} →
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const selectedCount = Array.isArray(answers[question.key])
    ? (answers[question.key] as string[]).length
    : 0;

  return (
    <div
      className={`relative flex flex-col items-center overflow-hidden px-4 py-6 ${fullBleed}`}
      style={{ background: "linear-gradient(135deg, #001933 0%, #000d1f 50%, #000814 100%)" }}
    >
      {/* Ambient neon glows */}
      <div className="pointer-events-none absolute -top-40 left-1/2 h-96 w-[42rem] -translate-x-1/2 rounded-full bg-[#00e5ff]/10 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-48 left-1/4 h-96 w-96 rounded-full bg-[#FF2D9B]/10 blur-3xl" />

      {/* Progress header */}
      <div className="relative z-10 mb-6 flex w-full max-w-2xl items-center justify-between gap-3">
        <button
          type="button"
          onClick={() => goTo(step - 1)}
          disabled={step === 0 || saving}
          aria-label={t("onboarding.questionnaire.back")}
          className="flex h-11 w-11 items-center justify-center rounded-full border border-[#00e5ff]/40 text-[#9dd8ff] transition hover:bg-[#00e5ff]/10 hover:text-[#d8fbff] disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff]"
        >
          <IconArrowLeft size={18} />
        </button>

        <div className="flex flex-col items-center gap-1.5">
          <div className="flex items-center gap-1.5" aria-hidden="true">
            {QUESTIONNAIRE_QUESTIONS.map((q, i) => (
              <span
                key={q.key}
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
            {t("onboarding.questionnaire.progress", {
              current: step + 1,
              total: TOTAL,
            })}
          </p>
        </div>
        <p className="sr-only" role="status" aria-live="polite">
          {t("onboarding.questionnaire.progress", {
            current: step + 1,
            total: TOTAL,
          })}
        </p>

        {mode === "edit" ? (
          /* Edit mode: a plain way out that writes NOTHING (no dismissal, no
             completion) — changing your mind must never alter server state. */
          <Link
            href={destination}
            className="flex h-11 items-center rounded-full px-3 text-xs font-bold text-[#9dd8ff]/70 underline-offset-4 transition hover:text-[#d8fbff] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff]"
          >
            {t("onboarding.questionnaire.edit.cancel")}
          </Link>
        ) : (
          <button
            type="button"
            onClick={skip}
            disabled={saving}
            className="h-11 rounded-full px-3 text-xs font-bold text-[#9dd8ff]/70 underline-offset-4 transition hover:text-[#d8fbff] hover:underline disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff]"
          >
            {t("onboarding.questionnaire.skip")}
          </button>
        )}
      </div>

      {/* Question body */}
      <div className="relative z-10 flex w-full flex-1 items-center justify-center">
        <div
          ref={contentRef}
          tabIndex={-1}
          onKeyDown={onKeyDown}
          className="w-full max-w-2xl outline-none"
        >
          <AnimatePresence mode="wait">
            <motion.div
              key={question.key}
              initial={{ opacity: 0, y: 18 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -12 }}
              transition={{ duration: 0.28, ease: "easeOut" }}
            >
              {mode === "edit" && (
                <span className="mb-3 inline-flex items-center gap-1.5 rounded-full border border-[#f0abfc]/50 bg-[#f0abfc]/10 px-3 py-1 text-[10px] font-black uppercase tracking-[0.2em] text-[#f0abfc]">
                  <IconPencil size={12} aria-hidden="true" />
                  {t("onboarding.questionnaire.edit.badge")}
                </span>
              )}
              <p
                className="mb-2 text-[11px] font-bold uppercase tracking-[0.3em]"
                style={{ color: accent }}
              >
                ✦ {t("onboarding.questionnaire.kicker")}
              </p>
              <h1
                id="questionnaire-question"
                className="mb-2 text-2xl font-extrabold tracking-tight text-white sm:text-3xl"
              >
                {t(question.titleKey)}
              </h1>
              <p className="mb-6 text-sm leading-relaxed text-[#9dd8ff] sm:text-base">
                {question.type === "multi"
                  ? t("onboarding.questionnaire.multiHint")
                  : t(question.hintKey)}
              </p>

              {question.type === "single" ? (
                <div
                  role="radiogroup"
                  aria-labelledby="questionnaire-question"
                  className="space-y-3"
                >
                  {question.options.map((option) => {
                    const selected = answers[question.key] === option.value;
                    return (
                      <button
                        key={option.value}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        onClick={() => toggleOption(question.key, "single", option.value)}
                        className={`flex w-full items-center gap-3 rounded-2xl border px-4 py-3.5 text-left transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff] ${
                          selected
                            ? "border-[#00e5ff]/70 bg-[#00e5ff]/10 shadow-[0_0_20px_rgba(0,229,255,0.25)]"
                            : "border-[#00e5ff]/25 bg-[#040d24]/80 hover:bg-[#0b1b3f]/80"
                        }`}
                      >
                        <span
                          aria-hidden="true"
                          className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 transition ${
                            selected ? "border-[#00e5ff]" : "border-[#00e5ff]/40"
                          }`}
                        >
                          {selected && (
                            <span className="h-2.5 w-2.5 rounded-full bg-[#00e5ff] shadow-[0_0_10px_rgba(0,229,255,0.8)]" />
                          )}
                        </span>
                        <span className="text-sm font-bold text-white sm:text-base">
                          {t(option.labelKey)}
                        </span>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div
                  role="group"
                  aria-labelledby="questionnaire-question"
                  className="grid gap-3 sm:grid-cols-2"
                >
                  {question.options.map((option) => {
                    const current = Array.isArray(answers[question.key])
                      ? (answers[question.key] as string[])
                      : [];
                    const selected = current.includes(option.value);
                    const atLimit = current.length >= (question.maxSelect ?? Infinity) && !selected;
                    return (
                      <button
                        key={option.value}
                        type="button"
                        aria-pressed={selected}
                        disabled={atLimit}
                        onClick={() => toggleOption(question.key, "multi", option.value)}
                        className={`flex items-center gap-3 rounded-2xl border px-4 py-3.5 text-left transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff] disabled:opacity-40 ${
                          selected
                            ? "border-[#00e5ff]/70 bg-[#00e5ff]/10 shadow-[0_0_20px_rgba(0,229,255,0.25)]"
                            : "border-[#00e5ff]/25 bg-[#040d24]/80 hover:bg-[#0b1b3f]/80"
                        }`}
                      >
                        <span
                          aria-hidden="true"
                          className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md border-2 transition ${
                            selected
                              ? "border-[#00e5ff] bg-[#00e5ff] text-black"
                              : "border-[#00e5ff]/40"
                          }`}
                        >
                          {selected && <IconCheck size={13} stroke={3} />}
                        </span>
                        <span className="text-sm font-bold text-white sm:text-base">
                          {t(option.labelKey)}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}

              {question.type === "multi" && (
                <p className="mt-4 text-xs font-semibold text-[#9dd8ff]/70">
                  {t("onboarding.questionnaire.selectedCount", { count: selectedCount })}
                  {question.maxSelect
                    ? ` · ${t("onboarding.questionnaire.maxSelect", { max: question.maxSelect })}`
                    : ""}
                </p>
              )}

              {showValidation && !canAdvance && (
                <p className="mt-3 text-xs font-bold text-[#FFD700]/80" role="status">
                  {t("onboarding.questionnaire.selectAtLeastOne")}
                </p>
              )}
            </motion.div>
          </AnimatePresence>
        </div>
      </div>

      {/* Footer controls */}
      <div className="relative z-10 mt-8 w-full max-w-2xl">
        {!isLast ? (
          <button
            type="button"
            onClick={advance}
            disabled={saving}
            className="flex w-full items-center justify-center gap-2 rounded-2xl bg-[#00e5ff] px-8 py-4 text-base font-extrabold text-[#001a2e] shadow-[0_0_25px_rgba(0,229,255,0.45)] transition hover:brightness-110 active:scale-[0.99] disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff]"
          >
            {t("onboarding.questionnaire.next")} <IconArrowRight size={18} />
          </button>
        ) : (
          <button
            type="button"
            onClick={finish}
            disabled={saving}
            className="flex w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-[#FFD700] to-[#FFB300] px-8 py-4 text-base font-extrabold text-black shadow-[0_0_30px_rgba(255,215,0,0.5)] transition-all hover:brightness-110 active:scale-[0.99] disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FFD700]"
          >
            {saving
              ? t("onboarding.questionnaire.saving")
              : mode === "edit"
                ? t("onboarding.questionnaire.edit.save")
                : t("onboarding.questionnaire.finish")}
          </button>
        )}

        <p className="mt-3 text-center text-xs text-[#9dd8ff]/60">
          {mode === "edit"
            ? t("onboarding.questionnaire.edit.note")
            : t("onboarding.questionnaire.editNote")}
        </p>

        {saveFailed && (
          <div
            role="alert"
            className="mx-auto mt-4 max-w-md rounded-xl border border-red-400/40 bg-red-500/10 px-4 py-3 text-sm text-red-200"
          >
            <p className="mb-2">{t("onboarding.questionnaire.saveFailed")}</p>
            <div className="flex flex-wrap items-center justify-center gap-3">
              <button
                type="button"
                onClick={() => void submit()}
                className="rounded-lg bg-red-400/90 px-4 py-1.5 text-xs font-extrabold text-black transition hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300"
              >
                {t("onboarding.error.retry")}
              </button>
              <button
                type="button"
                onClick={skip}
                className="text-xs font-semibold text-red-200/80 underline-offset-4 hover:underline"
              >
                {t("onboarding.questionnaire.skip")}
              </button>
            </div>
          </div>
        )}

        {saving && (
          <p className="mt-3 text-center text-xs font-semibold text-[#00e5ff]" role="status">
            {t("onboarding.questionnaire.savingHint")}
          </p>
        )}
      </div>
    </div>
  );
}
