"use client";

// src/components/ProTrialTimeline.tsx
//
// THE TRIAL EXPLAINER — three slides, exactly the three questions a buyer has
// before starting a free trial:
//
//   1. what do I get today, and what does it cost today,
//   2. will you remind me before the charge,
//   3. what day does money leave my account, and for how much.
//
// It is deliberately a set of slides rather than one wall of small print: each
// answer is read on its own, and the member actually picks the reminder. The
// choice is lifted into UpgradeProContent and travels to checkout, where the
// server stores it on the Stripe subscription; the daily reminder pass reads it
// back. Nothing here is decorative copy — every promise is wired to the trial
// that /api/stripe/subscribe really creates.
//
// The charge date is computed AFTER mount: `new Date()` during a server render
// would make the server HTML and the hydrated client disagree on the date.

import { useEffect, useState } from "react";
import { useTranslation } from "../hooks/useTranslation";
import {
  PRO_TRIAL_DAYS,
  PRO_TRIAL_REMINDER_DAYS,
  trialChargeDate,
  type ProTrialReminderDays,
} from "../lib/proTrial";

const STEPS = ["free", "reminder", "charge"] as const;
type TrialStep = (typeof STEPS)[number];

export type ProTrialTimelineProps = {
  /** What Stripe charges once the trial ends, already formatted. */
  priceDisplay: string;
  /** The billing unit ("month" / "year"), translated by the caller. */
  unit: string;
  reminderDays: ProTrialReminderDays;
  onReminderChange: (days: ProTrialReminderDays) => void;
};

export default function ProTrialTimeline({
  priceDisplay,
  unit,
  reminderDays,
  onReminderChange,
}: ProTrialTimelineProps) {
  const { t } = useTranslation();
  const [step, setStep] = useState<TrialStep>("free");
  const [chargeDate, setChargeDate] = useState<string | null>(null);

  useEffect(() => {
    setChargeDate(trialChargeDate().toLocaleDateString());
  }, []);

  const stepIndex = STEPS.indexOf(step);

  const labels: Record<TrialStep, string> = {
    free: t("pro.trial.step_free"),
    reminder: t("pro.trial.step_reminder"),
    charge: t("pro.trial.step_charge"),
  };

  return (
    <section
      data-testid="pro-trial-timeline"
      aria-labelledby="pro-trial-heading"
      className="mt-6 rounded-xl border border-[#00e5ff]/25 bg-[#00e5ff]/5 p-4 text-left"
    >
      <h3
        id="pro-trial-heading"
        className="text-sm font-bold uppercase tracking-wider text-[#00e5ff]"
      >
        {t("pro.trial.title", { days: PRO_TRIAL_DAYS })}
      </h3>
      <p className="mt-1 text-xs leading-snug text-[#9dd8ff]/75">{t("pro.trial.subtitle")}</p>

      {/* The three slides, each one clickable so a member can jump to the
          answer they care about (usually the charge date). */}
      <ol className="mt-3 grid grid-cols-3 gap-2">
        {STEPS.map((id, index) => {
          const active = id === step;
          return (
            <li key={id}>
              <button
                type="button"
                aria-pressed={active}
                onClick={() => setStep(id)}
                data-testid={`pro-trial-step-${id}`}
                className={`flex h-full w-full flex-col items-center gap-1 rounded-lg border px-1.5 py-2 text-center transition focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[#00e5ff] ${
                  active
                    ? "border-[#f5ff3b]/60 bg-[#f5ff3b]/10 text-[#f5ff3b]"
                    : "border-[#00e5ff]/20 bg-surface/70 text-[#9dd8ff]/80 hover:border-[#00e5ff]/45"
                }`}
              >
                <span
                  aria-hidden
                  className={`flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-bold ${
                    active ? "bg-[#f5ff3b] text-[#1f1700]" : "bg-[#00e5ff]/15 text-[#00e5ff]"
                  }`}
                >
                  {index + 1}
                </span>
                <span className="text-[11px] font-semibold leading-tight">{labels[id]}</span>
              </button>
            </li>
          );
        })}
      </ol>

      <div className="mt-3 min-h-[5.5rem]" aria-live="polite">
        {step === "free" && (
          <div data-testid="pro-trial-panel-free">
            <p className="text-sm font-semibold text-white">
              {t("pro.trial.free_title", { days: PRO_TRIAL_DAYS })}
            </p>
            <p className="mt-1 text-xs leading-snug text-[#c9f7ff]/85">
              {t("pro.trial.free_body", { days: PRO_TRIAL_DAYS })}
            </p>
          </div>
        )}

        {step === "reminder" && (
          <div data-testid="pro-trial-panel-reminder">
            <p className="text-sm font-semibold text-white">{t("pro.trial.reminder_title")}</p>
            <p className="mt-1 text-xs leading-snug text-[#c9f7ff]/85">
              {t("pro.trial.reminder_body")}
            </p>
            <div
              role="radiogroup"
              aria-label={t("pro.trial.reminder_title")}
              className="mt-2 grid grid-cols-1 gap-1.5 sm:grid-cols-3"
            >
              {PRO_TRIAL_REMINDER_DAYS.map((days) => {
                const selected = reminderDays === days;
                return (
                  <button
                    key={days}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    data-testid={`pro-trial-reminder-${days}`}
                    onClick={() => onReminderChange(days)}
                    className={`rounded-lg border px-2 py-1.5 text-[11px] font-semibold transition focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[#00e5ff] ${
                      selected
                        ? "border-[#00ffa6]/60 bg-[#00ffa6]/10 text-[#00ffa6]"
                        : "border-[#00e5ff]/25 bg-surface/70 text-[#9dd8ff]/80 hover:border-[#00e5ff]/45"
                    }`}
                  >
                    {t(`pro.trial.reminder_${days}`)}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {step === "charge" && (
          <div data-testid="pro-trial-panel-charge">
            <p className="text-sm font-semibold text-white">
              {chargeDate
                ? t("pro.trial.charge_title", { date: chargeDate })
                : t("pro.trial.charge_pending")}
            </p>
            <p className="mt-1 text-xs leading-snug text-[#c9f7ff]/85">
              {t("pro.trial.charge_body", {
                price: priceDisplay,
                unit,
                date: chargeDate ?? t("pro.trial.charge_pending"),
              })}
            </p>
            <p className="mt-1 text-[11px] leading-snug text-[#9dd8ff]/70">
              {reminderDays === 0
                ? t("pro.trial.charge_no_reminder")
                : t("pro.trial.charge_reminder", {
                    when: t(`pro.trial.reminder_${reminderDays}`),
                  })}
            </p>
          </div>
        )}
      </div>

      <div className="mt-2 flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setStep(STEPS[Math.max(0, stepIndex - 1)])}
          data-testid="pro-trial-back"
          disabled={stepIndex === 0}
          className="rounded-lg px-2 py-1 text-[11px] font-semibold text-[#9dd8ff]/80 transition hover:text-[#00e5ff] disabled:opacity-30 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[#00e5ff]"
        >
          ← {t("pro.trial.back")}
        </button>
        <span className="text-[11px] font-semibold uppercase tracking-wider text-[#9dd8ff]/50">
          {t("pro.trial.step_of", { current: stepIndex + 1, total: STEPS.length })}
        </span>
        <button
          type="button"
          onClick={() => setStep(STEPS[Math.min(STEPS.length - 1, stepIndex + 1)])}
          data-testid="pro-trial-next"
          disabled={stepIndex === STEPS.length - 1}
          className="rounded-lg px-2 py-1 text-[11px] font-semibold text-[#9dd8ff]/80 transition hover:text-[#00e5ff] disabled:opacity-30 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[#00e5ff]"
        >
          {t("pro.trial.next")} →
        </button>
      </div>
    </section>
  );
}
