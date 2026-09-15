"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { useUser } from "@clerk/nextjs";
import { IconBell, IconCoins, IconGlobe, IconHelp, IconMail, IconRotateClockwise, IconShield, IconSettings, IconShoppingBag, IconUser, IconVolume, IconWand } from "@tabler/icons-react";
import NavigationBar from "../../components/navigation-bar";
import SoundToggle from "../../components/SoundToggle";
import { useToast } from "../../components/toast/ToastProvider";
import { useLanguage } from "../../context/LanguageContext";
import { useTranslation } from "../../hooks/useTranslation";
import { WAGER_GAMES } from "../../lib/defaultWagers";
import { QUESTIONNAIRE_QUESTIONS } from "../../lib/onboardingQuestionnaire";

/**
 * Settings hub. Hosts the preferences that used to live directly in the nav
 * bar (sound toggle, language picker) plus account preferences:
 * responsible play (daily loss limit), account security (self-hosted email
 * OTP second factor), email notification opt-outs, and per-game default
 * wagers. Admin-only tools are rendered only for actual admins.
 */
export default function SettingsPageClient() {
  const { isLoaded, isSignedIn, user } = useUser();
  const { language, setLanguage } = useLanguage();
  const { t } = useTranslation();
  // Global branded toasts (UX plan P0-1): save/security successes toast;
  // errors stay inline next to the field (Law 15 — tell the user how to
  // fix it in place).
  const { showToast } = useToast();
  const [isAdmin, setIsAdmin] = useState(false);

  // ── Responsible play: daily loss limit (moved from the profile page) ──
  const [lossLimit, setLossLimit] = useState(null);
  const [lossLimitMode, setLossLimitMode] = useState("default");
  const [lossLimitDraft, setLossLimitDraft] = useState("");
  const [lossLimitSaving, setLossLimitSaving] = useState(false);
  const [lossLimitMsg, setLossLimitMsg] = useState(null);

  // ── Account security: self-hosted email-OTP second factor ──
  const [mfaEnabled, setMfaEnabled] = useState(false);
  const [mfaEmail, setMfaEmail] = useState(null);
  const [mfaBusy, setMfaBusy] = useState(false);
  const [mfaOtpSent, setMfaOtpSent] = useState(false);
  const [mfaCode, setMfaCode] = useState("");
  const [mfaMsg, setMfaMsg] = useState(null);

  // ── Email notification preferences ──
  const [prefs, setPrefs] = useState({
    promotions: true,
    daily: true,
    summary: true,
    progress: true,
  });
  const [prefsSaving, setPrefsSaving] = useState(false);
  const [prefsMsg, setPrefsMsg] = useState(null);

  // ── Per-game default wagers ──
  const [wagerDrafts, setWagerDrafts] = useState({});
  const [wagerSaving, setWagerSaving] = useState(false);
  const [wagerMsg, setWagerMsg] = useState(null);

  // ── Your GRYND Preferences (the onboarding questionnaire, in edit mode) ──
  // This card only READS the saved answers (one request) and links into the
  // questionnaire flow to change them — the same question catalog, the same
  // translation keys and the same API as onboarding. There is deliberately no
  // second preference store. null = still loading.
  const [gamePreferences, setGamePreferences] = useState(null);

  // Read the player's questionnaire state once per mount. Failures load as
  // "not answered yet", which is the safe reading: the card then offers the
  // setup CTA instead of pretending to show preferences it doesn't have.
  useEffect(() => {
    if (!user?.id) {
      setGamePreferences({ ok: false, completed: false, answers: {} });
      return;
    }
    let cancelled = false;
    fetch("/api/onboarding/questionnaire", { credentials: "include" })
      .then((res) => res.json().catch(() => null))
      .then((data) => {
        if (cancelled) return;
        const ok = data?.success === true;
        setGamePreferences({
          ok,
          completed: ok && data.completed === true,
          answers: ok && data.answers && typeof data.answers === "object" ? data.answers : {},
        });
      })
      .catch(() => {
        if (!cancelled) {
          setGamePreferences({ ok: false, completed: false, answers: {} });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [user?.id]);

  // Same DB-backed admin check + sessionStorage cache the nav bar uses —
  // the admin section below renders only for actual admins.
  useEffect(() => {
    if (!user?.id) return;

    const cacheKey = `admin:${user.id}`;
    try {
      const cached = sessionStorage.getItem(cacheKey);
      if (cached !== null) {
        setIsAdmin(cached === "true");
        return;
      }
    } catch {
      // sessionStorage unavailable (e.g. SSR)
    }

    fetch("/api/user/is-admin")
      .then((res) => res.json())
      .then((data) => {
        const adminVal = data.isAdmin === true;
        setIsAdmin(adminVal);
        try {
          sessionStorage.setItem(cacheKey, String(adminVal));
        } catch {
          // ignore
        }
      })
      .catch(() => setIsAdmin(false));
  }, [user?.id]);

  // ── Loaders (only when signed in) ──
  useEffect(() => {
    if (!isSignedIn || !user) return;

    const loadLossLimit = async () => {
      try {
        const response = await fetch("/api/user/daily-loss-limit", {
          credentials: "include",
        });
        const data = await response.json();
        if (response.ok && data?.success) {
          setLossLimit(data.limit ?? null);
          if (data.limit === 0) setLossLimitMode("off");
          else if (typeof data.limit === "number" && data.limit > 0) {
            setLossLimitMode("custom");
            setLossLimitDraft(String(data.limit));
          } else setLossLimitMode("default");
        }
      } catch (err) {
        console.error("[SETTINGS_LOAD_LOSS_LIMIT_ERROR]", err);
      }
    };

    const loadSecurity = async () => {
      try {
        const response = await fetch("/api/user/security", {
          credentials: "include",
        });
        const data = await response.json();
        if (response.ok && data?.success) {
          setMfaEnabled(Boolean(data.mfaEnabled));
          setMfaEmail(data.email ?? null);
        }
      } catch (err) {
        console.error("[SETTINGS_LOAD_SECURITY_ERROR]", err);
      }
    };

    const loadPrefs = async () => {
      try {
        const response = await fetch("/api/user/notification-preferences", {
          credentials: "include",
        });
        const data = await response.json();
        if (response.ok && data?.success && data.prefs) {
          setPrefs({ ...data.prefs });
        }
      } catch (err) {
        console.error("[SETTINGS_LOAD_PREFS_ERROR]", err);
      }
    };

    const loadWagers = async () => {
      try {
        const response = await fetch("/api/user/default-wagers", {
          credentials: "include",
        });
        const data = await response.json();
        if (response.ok && data?.success && data.wagers) {
          setWagerDrafts(Object.fromEntries(
            WAGER_GAMES.map((g) => [g.key, data.wagers[g.key] != null ? String(data.wagers[g.key]) : ""]),
          ));
        }
      } catch (err) {
        console.error("[SETTINGS_LOAD_WAGERS_ERROR]", err);
      }
    };

    loadLossLimit();
    loadSecurity();
    loadPrefs();
    loadWagers();
  }, [isSignedIn, user]);

  // ── Handlers ──
  const saveLossLimit = async () => {
    setLossLimitSaving(true);
    setLossLimitMsg(null);
    try {
      let limit = null; // default
      if (lossLimitMode === "off") limit = 0;
      else if (lossLimitMode === "custom") {
        const n = Number(lossLimitDraft);
        if (!Number.isInteger(n) || n <= 0) {
          setLossLimitMsg({ ok: false, text: "Enter a whole number of tokens above 0." });
          return;
        }
        limit = n;
      }
      const response = await fetch("/api/user/daily-loss-limit", {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ limit }),
      });
      const data = await response.json();
      if (response.ok && data?.success) {
        setLossLimit(limit);
        showToast(
          limit === null
            ? "Using the global default warning."
            : limit === 0
              ? "Warnings disabled."
              : `Warn me when I'm down ${limit.toLocaleString()} tokens in a day.`,
          "success",
        );
      } else {
        setLossLimitMsg({ ok: false, text: data?.error || "Failed to save." });
      }
    } catch {
      setLossLimitMsg({ ok: false, text: "Failed to save — try again." });
    } finally {
      setLossLimitSaving(false);
    }
  };

  const sendMfaOtp = async () => {
    setMfaBusy(true);
    setMfaMsg(null);
    try {
      const res = await fetch("/api/user/security/mfa/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
      });
      const data = await res.json();
      if (res.ok && data.success) {
        setMfaOtpSent(true);
        showToast("Code sent to your email. It expires in 5 minutes.", "success");
      } else {
        setMfaMsg({ ok: false, text: data.error || "Failed to send the code." });
      }
    } catch {
      setMfaMsg({ ok: false, text: "Network error. Please try again." });
    } finally {
      setMfaBusy(false);
    }
  };

  const verifyMfa = async () => {
    if (mfaCode.trim().length === 0) {
      setMfaMsg({ ok: false, text: "Enter the code first." });
      return;
    }
    setMfaBusy(true);
    setMfaMsg(null);
    try {
      const res = await fetch("/api/user/security/mfa/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ code: mfaCode }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        setMfaEnabled(true);
        setMfaOtpSent(false);
        setMfaCode("");
        showToast(
          "Two-factor authentication is now on. A code will be required on new sessions for 24h windows.",
          "success",
        );
      } else {
        setMfaMsg({ ok: false, text: data.error || "Verification failed." });
      }
    } catch {
      setMfaMsg({ ok: false, text: "Network error. Please try again." });
    } finally {
      setMfaBusy(false);
    }
  };

  const disableMfa = async () => {
    if (!window.confirm("Turn off two-factor authentication? Your account will only be protected by your password.")) {
      return;
    }
    setMfaBusy(true);
    setMfaMsg(null);
    try {
      const res = await fetch("/api/user/security/mfa/disable", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
      });
      const data = await res.json();
      if (res.ok && data.success) {
        setMfaEnabled(false);
        showToast("Two-factor authentication is off.", "success");
      } else {
        setMfaMsg({ ok: false, text: data.error || "Failed to disable." });
      }
    } catch {
      setMfaMsg({ ok: false, text: "Network error. Please try again." });
    } finally {
      setMfaBusy(false);
    }
  };

  const savePrefs = async () => {
    setPrefsSaving(true);
    setPrefsMsg(null);
    try {
      const res = await fetch("/api/user/notification-preferences", {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prefs }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        setPrefs({ ...data.prefs });
        showToast("Notification preferences saved.", "success");
      } else {
        setPrefsMsg({ ok: false, text: data.error || "Failed to save." });
      }
    } catch {
      setPrefsMsg({ ok: false, text: "Failed to save — try again." });
    } finally {
      setPrefsSaving(false);
    }
  };

  const saveWagers = async () => {
    setWagerSaving(true);
    setWagerMsg(null);
    const wagers = {};
    for (const g of WAGER_GAMES) {
      const raw = String(wagerDrafts[g.key] ?? "").trim();
      if (raw === "") continue;
      const n = Number(raw);
      if (!Number.isInteger(n) || n <= 0) {
        setWagerMsg({ ok: false, text: `Enter a valid token amount for ${g.label} (or leave it empty to use the game default).` });
        setWagerSaving(false);
        return;
      }
      wagers[g.key] = n;
    }
    try {
      const res = await fetch("/api/user/default-wagers", {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wagers }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        showToast("Default wagers saved. They apply the next time you open a game.", "success");
      } else {
        setWagerMsg({ ok: false, text: data.error || "Failed to save." });
      }
    } catch {
      setWagerMsg({ ok: false, text: "Failed to save — try again." });
    } finally {
      setWagerSaving(false);
    }
  };

  // The player's answers as displayable rows: the catalog's own question
  // order, labelled through the same keys the questionnaire renders. Only
  // questions with a valid saved answer are listed, so a partial profile can
  // never render an empty-looking row.
  const preferenceRows = QUESTIONNAIRE_QUESTIONS.map((question) => {
    const raw = gamePreferences?.answers?.[question.key];
    const values = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
    return {
      key: question.key,
      title: t(question.titleKey),
      labels: question.options
        .filter((option) => values.includes(option.value))
        .map((option) => t(option.labelKey)),
    };
  }).filter((row) => row.labels.length > 0);

  if (!isLoaded) {
    return (
      <div className="flex h-screen items-center justify-center bg-[#003366]">
        <div className="text-2xl text-[#00e5ff]">Loading...</div>
      </div>
    );
  }

  return (
    <div
      className="min-h-screen text-white"
      style={{
        backgroundImage: "linear-gradient(135deg, #001933 0%, #000d1a 100%)",
      }}
    >
      <div className="max-w-6xl mx-auto px-6 pt-24 pb-20">
        <NavigationBar currentPath="/settings" />
        <h1
          className="text-4xl font-extrabold text-center mb-8
  bg-gradient-to-r from-purple-400 to-pink-500
  bg-clip-text text-transparent"
        >
          Settings
        </h1>

        {!isSignedIn ? (
          <div className="mx-auto max-w-md rounded-xl border border-[#00e5ff]/30 bg-[#0b224f]/85 p-8 text-center shadow-[0_0_24px_rgba(0,229,255,0.15)]">
            <p className="mb-4 text-lg text-gray-300">
              Sign in to manage your GRYND settings.
            </p>
            <Link
              href="/sign-in?redirect_url=/settings"
              className="inline-flex rounded-lg border border-[#00e5ff]/40 bg-[#00e5ff]/20 px-6 py-2.5 font-medium text-[#d8fbff] hover:bg-[#00e5ff]/35"
            >
              {t("nav.sign_in")}
            </Link>
          </div>
        ) : (
          <div className="grid gap-8 md:grid-cols-2">
            {/* Sound */}
            <div className="rounded-xl border border-[#00e5ff]/30 bg-[#0b224f]/85 p-6 shadow-[0_0_24px_rgba(0,229,255,0.15)]">
              <h2 className="mb-4 flex items-center gap-2 text-xl text-[#00e5ff]">
                <IconVolume size={20} /> Sound
              </h2>
              <p className="mb-4 text-sm text-gray-300">
                Mute or restore game sound effects from every game. Applies
                across all your tabs.
              </p>
              <SoundToggle className="px-4 py-2 text-sm" />
            </div>

            {/* Language */}
            <div className="rounded-xl border border-[#00e5ff]/30 bg-[#0b224f]/85 p-6 shadow-[0_0_24px_rgba(0,229,255,0.15)]">
              <h2 className="mb-4 flex items-center gap-2 text-xl text-[#00e5ff]">
                <IconGlobe size={20} /> Language
              </h2>
              <p className="mb-4 text-sm text-gray-300">
                Choose the language of the app. Saved on this device.
              </p>
              <div className="flex gap-2">
                {[
                  { value: "en", label: "English" },
                  { value: "fr", label: "Français" },
                  { value: "es", label: "Español" },
                ].map((lang) => (
                  <button
                    key={lang.value}
                    onClick={() => setLanguage(lang.value)}
                    aria-pressed={language === lang.value}
                    className={`cursor-pointer rounded-lg border px-4 py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0b224f] ${
                      language === lang.value
                        ? "border-[#f5ff3b]/60 bg-[#f5ff3b]/15 text-[#f5ff3b]"
                        : "border-[#00e5ff]/50 bg-[#091737] text-[#c9f7ff] hover:bg-[#00e5ff]/10"
                    }`}
                  >
                    {lang.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Responsible Play — per-player daily loss limit (moved from profile) */}
            <div className="rounded-xl border border-amber-400/35 bg-[#1d1605]/85 p-6 shadow-[0_0_24px_rgba(245,255,59,0.12)]">
              <h2 className="text-xl text-amber-300">Responsible Play</h2>
              <p className="mb-4 mt-1 text-sm text-gray-300">
                Set your own daily loss limit. When you're down more than this
                in one day, the casino lobby will warn you before you keep
                playing — it never blocks you.
              </p>

              <div className="flex flex-wrap gap-2">
                {[
                  { key: "default", label: "Global default (50k)" },
                  { key: "off", label: "Warnings off" },
                  { key: "custom", label: "Custom" },
                ].map((opt) => (
                  <button
                    key={opt.key}
                    type="button"
                    onClick={() => setLossLimitMode(opt.key)}
                    className={`rounded-full border px-4 py-1.5 text-sm font-semibold transition ${
                      lossLimitMode === opt.key
                        ? "border-amber-400 bg-amber-500/20 text-amber-200"
                        : "border-gray-600 bg-gray-800/40 text-gray-400 hover:border-amber-500/50 hover:text-amber-200"
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>

              {lossLimitMode === "custom" && (
                <div className="mt-3 flex flex-wrap items-end gap-2">
                  <label className="flex flex-col gap-1 text-xs font-semibold text-amber-200">
                    Daily loss limit (tokens)
                    <input
                      type="number"
                      min={1}
                      value={lossLimitDraft}
                      onChange={(e) => setLossLimitDraft(e.target.value)}
                      className="w-44 rounded-md border border-amber-600/50 bg-[#020617] px-2 py-1.5 text-sm text-white outline-none focus:border-amber-400"
                      aria-label="Custom daily loss limit in tokens"
                    />
                  </label>
                  <div className="flex flex-wrap gap-1.5">
                    {[5000, 10000, 25000, 50000].map((v) => (
                      <button
                        key={v}
                        type="button"
                        onClick={() => setLossLimitDraft(String(v))}
                        className="rounded-full border border-gray-600 bg-gray-800/40 px-2.5 py-1 text-[11px] font-bold text-gray-300 transition hover:border-amber-500/50 hover:text-amber-200"
                      >
                        {v.toLocaleString()}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div className="mt-4 flex items-center gap-3">
                <button
                  type="button"
                  onClick={saveLossLimit}
                  disabled={lossLimitSaving}
                  className="rounded-xl border-b-4 border-amber-700 bg-amber-500 px-5 py-2 text-sm font-extrabold text-black transition hover:brightness-110 disabled:opacity-60"
                >
                  {lossLimitSaving ? "Saving…" : "Save limit"}
                </button>
                {lossLimitMsg && (
                  <span className={`text-sm ${lossLimitMsg.ok ? "text-emerald-300" : "text-red-300"}`}>
                    {lossLimitMsg.text}
                  </span>
                )}
              </div>
            </div>

            {/* Account Security — self-hosted email-OTP second factor */}
            <div className="rounded-xl border border-emerald-400/35 bg-[#052e1f]/85 p-6 shadow-[0_0_24px_rgba(52,211,153,0.15)]">
              <h2 className="mb-1 flex items-center gap-2 text-xl text-emerald-300">
                <IconShield size={20} /> Account Security
              </h2>
              <p className="mb-4 text-sm text-gray-300">
                Two-factor authentication (email code). When enabled, a
                one-time code is required on each new session window (24h) —
                even for pages that don't otherwise require sign-in.
              </p>

              {mfaEnabled ? (
                <div>
                  <div className="mb-3 flex items-center gap-2 rounded-lg border border-emerald-400/40 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300">
                    <span className="h-2 w-2 rounded-full bg-emerald-400" />
                    Enabled — codes go to {mfaEmail || "your email"}.
                  </div>
                  <button
                    type="button"
                    onClick={disableMfa}
                    disabled={mfaBusy}
                    className="rounded-lg border border-red-400/50 bg-red-500/10 px-4 py-2 text-sm font-medium text-red-300 transition hover:bg-red-500/20 disabled:opacity-60"
                  >
                    {mfaBusy ? "Working…" : "Turn off"}
                  </button>
                </div>
              ) : (
                <div className="space-y-3">
                  {!mfaOtpSent ? (
                    <button
                      type="button"
                      onClick={sendMfaOtp}
                      disabled={mfaBusy}
                      className="rounded-lg border border-emerald-400/50 bg-emerald-500/15 px-4 py-2 text-sm font-semibold text-emerald-300 transition hover:bg-emerald-500/25 disabled:opacity-60"
                    >
                      {mfaBusy ? "Sending…" : "Turn on — send me a code"}
                    </button>
                  ) : (
                    <>
                      <div className="flex gap-2">
                        <input
                          type="text"
                          inputMode="numeric"
                          maxLength={6}
                          autoComplete="one-time-code"
                          placeholder="6-digit code"
                          value={mfaCode}
                          onChange={(e) => setMfaCode(e.target.value.replace(/\D/g, ""))}
                          className="w-40 rounded-lg border border-[#00e5ff]/40 bg-[#08142f] px-3 py-2 text-center text-lg tracking-[0.4em] text-[#ecf8ff] focus:outline-none focus:ring-2 focus:ring-[#00e5ff]"
                        />
                        <button
                          type="button"
                          onClick={verifyMfa}
                          disabled={mfaBusy}
                          className="rounded-lg border border-emerald-400/50 bg-emerald-500/15 px-4 py-2 text-sm font-semibold text-emerald-300 transition hover:bg-emerald-500/25 disabled:opacity-60"
                        >
                          {mfaBusy ? "Verifying…" : "Verify & enable"}
                        </button>
                        <button
                          type="button"
                          onClick={sendMfaOtp}
                          disabled={mfaBusy}
                          className="rounded-lg border border-[#00e5ff]/40 px-3 py-2 text-sm font-medium text-[#d8fbff] transition hover:bg-[#00e5ff]/10 disabled:opacity-60"
                        >
                          Resend
                        </button>
                      </div>
                    </>
                  )}
                </div>
              )}
              {mfaMsg && (
                <p className={`mt-3 text-sm ${mfaMsg.ok ? "text-emerald-300" : "text-red-300"}`}>
                  {mfaMsg.text}
                </p>
              )}
            </div>

            {/* Email notification preferences */}
            <div className="rounded-xl border border-[#00e5ff]/30 bg-[#0b224f]/85 p-6 shadow-[0_0_24px_rgba(0,229,255,0.15)]">
              <h2 className="mb-1 flex items-center gap-2 text-xl text-[#00e5ff]">
                <IconBell size={20} /> Email Notifications
              </h2>
              <p className="mb-4 text-sm text-gray-300">
                Choose which GRYND emails you receive. Security alerts and
                payment receipts are always sent.
              </p>
              <div className="space-y-3">
                {[
                  { key: "promotions", label: "Offers & promos", desc: "New games, bonuses, comeback offers." },
                  { key: "daily", label: "Daily reward reminders", desc: "Nudge when your daily bonus is ready." },
                  { key: "summary", label: "Weekly summaries", desc: "Your wins, losses and net for the week." },
                  { key: "progress", label: "Progress updates", desc: "Level-ups, big wins, streak encouragement." },

                ].map((opt) => (
                  <label
                    key={opt.key}
                    className="flex cursor-pointer items-center justify-between gap-3 rounded-lg border border-[#00e5ff]/20 bg-[#091737] px-3 py-2.5"
                  >
                    <span>
                      <span className="block text-sm font-medium text-[#c9f7ff]">{opt.label}</span>
                      <span className="block text-xs text-[#7dd3fc]/70">{opt.desc}</span>
                    </span>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={Boolean(prefs[opt.key])}
                      aria-label={opt.label}
                      onClick={() => setPrefs((p) => ({ ...p, [opt.key]: !p[opt.key] }))}
                      className={`relative h-6 w-11 shrink-0 rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff] ${
                        prefs[opt.key] ? "bg-[#00e5ff]" : "bg-gray-600"
                      }`}
                    >
                      <span
                        className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${
                          prefs[opt.key] ? "left-[22px]" : "left-0.5"
                        }`}
                      />
                    </button>
                  </label>
                ))}
              </div>
              <div className="mt-4 flex items-center gap-3">
                <button
                  type="button"
                  onClick={savePrefs}
                  disabled={prefsSaving}
                  className="rounded-xl border-b-4 border-[#0087a8] bg-[#00e5ff] px-5 py-2 text-sm font-extrabold text-[#001a2e] transition hover:brightness-110 disabled:opacity-60"
                >
                  {prefsSaving ? "Saving…" : "Save preferences"}
                </button>
                {prefsMsg && (
                  <span className={`text-sm ${prefsMsg.ok ? "text-emerald-300" : "text-red-300"}`}>
                    {prefsMsg.text}
                  </span>
                )}
              </div>
            </div>

            {/* Per-game default wagers */}
            <div className="rounded-xl border border-fuchsia-400/35 bg-[#18071f]/85 p-6 shadow-[0_0_24px_rgba(217,70,239,0.12)] md:col-span-2">
              <h2 className="mb-1 flex items-center gap-2 text-xl text-fuchsia-300">
                <IconCoins size={20} /> Default Wagers
              </h2>
              <p className="mb-4 text-sm text-gray-300">
                Set the wager each game starts with. Leave a game empty to use
                its built-in default. Changes apply the next time you open that
                game.
              </p>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                {WAGER_GAMES.map((g) => (
                  <label key={g.key} className="flex flex-col gap-1 rounded-lg border border-[#00e5ff]/20 bg-[#091737] px-3 py-2">
                    <span className="text-xs font-semibold text-[#c9f7ff]">{g.label}</span>
                    <span className="text-[10px] text-[#7dd3fc]/70">default: {g.fallback}</span>
                    <input
                      type="number"
                      min={1}
                      inputMode="numeric"
                      placeholder={String(g.fallback)}
                      value={wagerDrafts[g.key] ?? ""}
                      onChange={(e) => setWagerDrafts((d) => ({ ...d, [g.key]: e.target.value }))}
                      aria-label={`Default wager for ${g.label}`}
                      className="w-full rounded-md border border-fuchsia-500/40 bg-[#020617] px-2 py-1.5 text-sm text-white outline-none focus:border-fuchsia-400"
                    />
                  </label>
                ))}
              </div>
              <div className="mt-4 flex items-center gap-3">
                <button
                  type="button"
                  onClick={saveWagers}
                  disabled={wagerSaving}
                  className="rounded-xl border-b-4 border-fuchsia-700 bg-fuchsia-500 px-5 py-2 text-sm font-extrabold text-black transition hover:brightness-110 disabled:opacity-60"
                >
                  {wagerSaving ? "Saving…" : "Save wagers"}
                </button>
                {wagerMsg && (
                  <span className={`text-sm ${wagerMsg.ok ? "text-emerald-300" : "text-red-300"}`}>
                    {wagerMsg.text}
                  </span>
                )}
              </div>
            </div>

            {/* Account */}
            <div className="rounded-xl border border-[#00e5ff]/30 bg-[#0b224f]/85 p-6 shadow-[0_0_24px_rgba(0,229,255,0.15)]">
              <h2 className="mb-4 flex items-center gap-2 text-xl text-[#00e5ff]">
                <IconUser size={20} /> Account
              </h2>
              <ul className="space-y-2 text-sm">
                <li>
                  <Link
                    href="/profil"
                    className="inline-flex items-center gap-1.5 text-[#9dd8ff] hover:text-[#00e5ff]"
                  >
                    My Profile →
                  </Link>
                </li>
                <li>
                  <Link
                    href="/battlepass"
                    className="inline-flex items-center gap-1.5 text-[#9dd8ff] hover:text-[#00e5ff]"
                  >
                    Battlepass →
                  </Link>
                </li>
                <li>
                  <Link
                    href="/shop"
                    className="inline-flex items-center gap-1.5 text-[#9dd8ff] hover:text-[#00e5ff]"
                  >
                    <IconShoppingBag size={15} /> Shop →
                  </Link>
                </li>
              </ul>
            </div>

            {/* Your GRYND Preferences — view + edit the onboarding
                questionnaire answers. This is THE preference surface: the
                lobby's "Make GRYND yours" card points here for players who
                chose "Maybe Later", and the questionnaire itself reopens in
                edit mode (?from=settings) and returns to this page. */}
            <div className="rounded-xl border border-[#00e5ff]/30 bg-[#0b224f]/85 p-6 shadow-[0_0_24px_rgba(0,229,255,0.15)] md:col-span-2">
              <h2 className="mb-1 flex items-center gap-2 text-xl text-[#00e5ff]">
                <IconWand size={20} /> {t("onboarding.preferences.title")}
              </h2>

              {gamePreferences === null && (
                <p className="text-sm text-[#9dd8ff]" role="status">
                  {t("ui.loading")}
                </p>
              )}

              {gamePreferences !== null && gamePreferences.completed && preferenceRows.length > 0 && (
                <>
                  <p className="mb-4 text-sm text-[#9dd8ff]">
                    {t("onboarding.preferences.note")}
                  </p>
                  <dl className="mb-4 grid gap-3 sm:grid-cols-2">
                    {preferenceRows.map((row) => (
                      <div
                        key={row.key}
                        className="rounded-lg border border-[#00e5ff]/20 bg-[#091737] px-3 py-2.5"
                      >
                        <dt className="text-[11px] font-bold uppercase tracking-widest text-[#7dd3fc]/80">
                          {row.title}
                        </dt>
                        <dd className="mt-1.5 flex flex-wrap gap-1.5">
                          {row.labels.map((label) => (
                            <span
                              key={label}
                              className="rounded-full border border-[#00e5ff]/30 bg-[#00e5ff]/10 px-2.5 py-1 text-xs font-semibold text-[#c9f7ff]"
                            >
                              {label}
                            </span>
                          ))}
                        </dd>
                      </div>
                    ))}
                  </dl>
                  <Link
                    href="/welcome/questionnaire?from=settings"
                    className="inline-flex items-center gap-2 rounded-lg border border-[#00e5ff]/60 bg-[#00e5ff]/15 px-4 py-3 text-sm font-bold text-[#00e5ff] transition hover:bg-[#00e5ff]/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff]"
                  >
                    <IconWand size={15} /> {t("onboarding.preferences.update")}
                  </Link>
                </>
              )}

              {gamePreferences !== null && !(gamePreferences.completed && preferenceRows.length > 0) && (
                <>
                  <p className="mb-1 text-sm font-semibold text-[#c9f7ff]">
                    {gamePreferences.ok
                      ? t("onboarding.preferences.empty")
                      : t("onboarding.preferences.error")}
                  </p>
                  <p className="mb-4 text-sm text-[#9dd8ff]/80">
                    {t("onboarding.preferences.emptyHint")}
                  </p>
                  <Link
                    href="/welcome/questionnaire?from=settings"
                    className="inline-flex items-center gap-2 rounded-lg border-b-4 border-[#0087a8] bg-[#00e5ff] px-4 py-3 text-sm font-extrabold text-[#001a2e] transition hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff]"
                  >
                    <IconWand size={15} /> {t("onboarding.preferences.cta")}
                  </Link>
                </>
              )}
            </div>

            {/* Help & support */}
            <div className="rounded-xl border border-[#00e5ff]/30 bg-[#0b224f]/85 p-6 shadow-[0_0_24px_rgba(0,229,255,0.15)]">
              <h2 className="mb-4 flex items-center gap-2 text-xl text-[#00e5ff]">
                <IconHelp size={20} /> Help & Support
              </h2>
              <ul className="space-y-2 text-sm">
                <li>
                  <Link
                    href="/welcome?replay=1"
                    className="inline-flex items-center gap-1.5 text-[#9dd8ff] hover:text-[#00e5ff]"
                  >
                    <IconRotateClockwise size={15} /> {t("onboarding.replay")} →
                  </Link>
                </li>
                <li>
                  <Link
                    href="/faq"
                    className="inline-flex items-center gap-1.5 text-[#9dd8ff] hover:text-[#00e5ff]"
                  >
                    FAQ →
                  </Link>
                </li>
                <li>
                  <Link
                    href="/contact"
                    className="inline-flex items-center gap-1.5 text-[#9dd8ff] hover:text-[#00e5ff]"
                  >
                    <IconMail size={15} /> Contact →
                  </Link>
                </li>
              </ul>
            </div>

            {/* Admin — visible only to real admins (same DB-backed check as
                the nav bar / admin dashboard gate). */}
            {isAdmin && (
              <div className="rounded-xl border border-[#ff8c42]/50 bg-[#2a1206]/85 p-6 shadow-[0_0_24px_rgba(255,140,66,0.15)] md:col-span-2">
                <h2 className="mb-2 flex items-center gap-2 text-xl text-[#ff8c42]">
                  <IconSettings size={20} /> Admin
                </h2>
                <p className="mb-4 text-sm text-orange-200/80">
                  Admin-only tools. This section is hidden from regular
                  players.
                </p>
                <Link
                  href="/admin"
                  className="inline-flex items-center gap-1.5 rounded-lg border border-[#ff8c42]/60 bg-[#ff8c42]/15 px-4 py-2 text-sm font-medium text-[#ffb347] hover:bg-[#ff8c42]/25"
                >
                  Open Admin Dashboard →
                </Link>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}