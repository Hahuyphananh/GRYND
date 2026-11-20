"use client";

// src/components/ProTrialReminderSettings.tsx
//
// The trial reminder is editable AFTER checkout, too — the paywall lets a
// member pick it while buying, and this panel lets them move it (or turn it
// off) during the trial without opening Stripe or contacting anyone.
//
// It renders NOTHING unless the server confirms a live trial for this caller,
// and the server only ever writes the caller's own subscription metadata. Every
// chosen value is one of the options the reminder job understands, so "no
// reminder" really does stop the email.

import { useEffect, useState } from "react";
import { useTranslation } from "../hooks/useTranslation";
import {
  DEFAULT_PRO_TRIAL_REMINDER_DAYS,
  PRO_TRIAL_REMINDER_DAYS,
  type ProTrialReminderDays,
} from "../lib/proTrial";
import {
  fetchProTrialReminder,
  updateProTrialReminder,
  type ProTrialReminderStatus,
} from "../lib/upgradePro";

export default function ProTrialReminderSettings() {
  const { t } = useTranslation();
  const [trial, setTrial] = useState<ProTrialReminderStatus | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchProTrialReminder().then((next) => {
      if (!cancelled) setTrial(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Unknown, signed out, or not actually trialing: nothing to manage.
  if (!trial?.trialing) return null;

  const current = trial.reminderDays ?? DEFAULT_PRO_TRIAL_REMINDER_DAYS;
  const trialEnd = trial.trialEndsAt
    ? new Date(trial.trialEndsAt).toLocaleDateString()
    : null;

  const choose = async (days: ProTrialReminderDays) => {
    if (days === current || saving) return;
    setSaving(true);
    setSaved(false);
    setError(null);
    const result = await updateProTrialReminder(days);
    setSaving(false);
    if (!result.ok) {
      setError(result.error ?? t("pro.trial.manage_error"));
      return;
    }
    setTrial({ ...trial, reminderDays: days });
    setSaved(true);
  };

  return (
    <section
      data-testid="pro-trial-reminder-settings"
      className="mt-6 rounded-xl border border-[#00e5ff]/25 bg-[color:var(--bg-panel)] px-5 py-4"
    >
      <h2 className="text-sm font-bold uppercase tracking-wider text-[color:var(--accent-strong)]">
        {t("pro.trial.manage_title")}
      </h2>
      <p className="mt-2 text-xs leading-relaxed text-white/65">
        {trialEnd ? t("pro.trial.manage_body", { date: trialEnd }) : t("pro.trial.manage_body_no_date")}
      </p>

      <div
        role="radiogroup"
        aria-label={t("pro.trial.manage_title")}
        className="mt-3 grid grid-cols-1 gap-1.5 sm:grid-cols-3"
      >
        {PRO_TRIAL_REMINDER_DAYS.map((days) => {
          const selected = current === days;
          return (
            <button
              key={days}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={saving}
              data-testid={`pro-trial-manage-reminder-${days}`}
              onClick={() => void choose(days)}
              className={`rounded-lg border px-2 py-1.5 text-[11px] font-semibold transition focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[#00e5ff] disabled:opacity-60 ${
                selected
                  ? "border-[#00ffa6]/60 bg-[#00ffa6]/10 text-[#00ffa6]"
                  : "border-[color:var(--border-hairline)] bg-[color:var(--bg-surface)] text-white/70 hover:border-[#00e5ff]/45"
              }`}
            >
              {t(`pro.trial.reminder_${days}`)}
            </button>
          );
        })}
      </div>

      {saved && (
        <p role="status" className="mt-2 text-[11px] font-semibold text-[#00ffa6]">
          {t("pro.trial.manage_saved")}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-2 text-[11px] text-red-400">
          {error}
        </p>
      )}

      {trialEnd && (
        <p className="mt-2 text-[11px] leading-snug text-white/45">
          {t("pro.trial.manage_cancel_hint", { date: trialEnd })}
        </p>
      )}
    </section>
  );
}
