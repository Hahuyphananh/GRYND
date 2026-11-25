"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { useUser } from "@clerk/nextjs";
import { IconBell, IconGlobe, IconHelp, IconMail, IconRotateClockwise, IconShield, IconSettings, IconUser, IconVolume, IconWand } from "@tabler/icons-react";
import NavigationBar from "../../components/navigation-bar";
import SoundToggle from "../../components/SoundToggle";
import UpgradeProButton from "../../components/UpgradeProButton";
import { useToast } from "../../components/toast/ToastProvider";
import { useLanguage } from "../../context/LanguageContext";
import { useTranslation } from "../../hooks/useTranslation";
import { QUESTIONNAIRE_QUESTIONS } from "../../lib/onboardingQuestionnaire";
import { runOptimistically } from "../../lib/optimistic";
import PageSkeleton from "../../components/skeletons/PageSkeleton";
// The six product primitives. Every colour on this page now comes from the
// semantic layer in globals.css, so dark and light are correct together.
import {
  Button,
  EmptyState,
  PageHeader,
  StatTile,
  Surface,
  Tabs,
} from "../../components/ui";

/**
 * Settings hub. Hosts the preferences that used to live directly in the nav
 * bar (sound toggle, language picker) plus account preferences:
 * responsible play (daily loss limit), account security (self-hosted email
 * OTP second factor) and email notification opt-outs. Admin-only tools are
 * rendered only for actual admins.
 *
 * Stakes are retired: the per-game "default wager"
 * card is gone — there is no wager for a game to start with.
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

    loadLossLimit();
    loadSecurity();
    loadPrefs();
  }, [isSignedIn, user]);

  // ── Handlers ──
  const saveLossLimit = async () => {
    setLossLimitSaving(true);
    setLossLimitMsg(null);
    let limit = null; // default
    if (lossLimitMode === "off") limit = 0;
    else if (lossLimitMode === "custom") {
      const n = Number(lossLimitDraft);
      if (!Number.isInteger(n) || n <= 0) {
        setLossLimitMsg({ ok: false, text: "Enter a whole number of tokens above 0." });
        setLossLimitSaving(false);
        return;
      }
      limit = n;
    }
    // A preference, not a server-decided value: apply it at once and revert
    // if the write fails.
    const previous = lossLimit;
    const result = await runOptimistically({
      optimistic: () => setLossLimit(limit),
      rollback: () => setLossLimit(previous),
      request: async () => {
        const response = await fetch("/api/user/daily-loss-limit", {
          method: "PUT",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ limit }),
        });
        const data = await response.json();
        if (!(response.ok && data?.success)) {
          throw new Error(data?.error || "Failed to save.");
        }
        showToast(
          limit === null
            ? "Using the global default warning."
            : limit === 0
              ? "Warnings disabled."
              : `Warn me when I'm down ${limit.toLocaleString()} tokens in a day.`,
          "success",
        );
        return data;
      },
    });
    if (!result.ok) setLossLimitMsg({ ok: false, text: result.error });
    setLossLimitSaving(false);
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

  // One-tap opt-out from every marketing email. Mirrors the unsubscribe link
  // on the emails themselves: it turns all four preferences off at once (the
  // server records the event for compliance). Security and payment mail is
  // never affected.
  const unsubscribeAll = async () => {
    setPrefsSaving(true);
    setPrefsMsg(null);
    const allOff = { promotions: false, daily: false, summary: false, progress: false };
    // Flip every toggle off on screen immediately; restore if the server
    // rejects the opt-out.
    const previous = prefs;
    const result = await runOptimistically({
      optimistic: () => setPrefs((p) => ({ ...p, ...allOff })),
      rollback: () => setPrefs(previous),
      request: async () => {
        const res = await fetch("/api/user/notification-preferences", {
          method: "PUT",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prefs: allOff }),
        });
        const data = await res.json();
        if (!(res.ok && data.success)) {
          throw new Error(data.error || "Failed to unsubscribe.");
        }
        setPrefs({ ...data.prefs });
        showToast("Unsubscribed from all marketing emails.", "success");
        return data;
      },
    });
    if (!result.ok) setPrefsMsg({ ok: false, text: result.error });
    setPrefsSaving(false);
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
    // Branded page skeleton instead of the raw blue "Loading..." flash — the
    // same per-route skeleton the splash screen and app/loading.tsx use, so
    // the first paint already looks like the product.
    return <PageSkeleton />;
  }

  // The saved value as a readable label. `null` is the server's "no custom
  // limit", which means the global default applies — never "unlimited".
  const limitLabel =
    lossLimit === 0
      ? "Off"
      : typeof lossLimit === "number"
        ? `${lossLimit.toLocaleString()} tokens`
        : "Default (50k)";

  const languageItems = [
    { key: "en", label: "English" },
    { key: "fr", label: "Français" },
    { key: "es", label: "Español" },
  ];

  const lossLimitItems = [
    { key: "default", label: "Global default (50k)" },
    { key: "off", label: "Warnings off" },
    { key: "custom", label: "Custom" },
  ];

  return (
    <div className="relative min-h-dvh bg-[color:var(--bg-page)] text-[color:var(--text-primary)]">
      <div className="mx-auto max-w-6xl px-6 pt-6 pb-20">
        <NavigationBar currentPath="/settings" />

        <PageHeader
          title="Settings"
          description="Sound, language, responsible play, account security and the emails GRYND sends you."
        />

        {!isSignedIn ? (
          <EmptyState
            className="mx-auto max-w-md"
            icon={<IconSettings size={20} aria-hidden="true" />}
            title="Sign in to manage your GRYND settings"
            body="Preferences are stored against your account, so they follow you to every device."
            action={{ label: t("nav.sign_in"), href: "/sign-in?redirect_url=/settings" }}
          />
        ) : (
          <div className="grid gap-6 md:grid-cols-2">
            {/* ── How the app behaves ────────────────────────────────────── */}

            <Surface>
              <PageHeader
                size="section"
                title="Sound"
                icon={<IconVolume size={18} aria-hidden="true" />}
              />
              <p className="mb-4 text-sm text-[color:var(--text-secondary)]">
                Mute or restore game sound effects from every game. Applies
                across all your tabs.
              </p>
              <SoundToggle className="px-4 py-2 text-sm" />
            </Surface>

            <Surface>
              <PageHeader
                size="section"
                title="Language"
                icon={<IconGlobe size={18} aria-hidden="true" />}
              />
              <p className="mb-4 text-sm text-[color:var(--text-secondary)]">
                Choose the language of the app. Saved on this device.
              </p>
              <Tabs
                label="Language"
                items={languageItems}
                value={language}
                onChange={setLanguage}
              />
            </Surface>

            {/* ── Responsible play ───────────────────────────────────────── */}

            <Surface tone="warning">
              <PageHeader
                size="section"
                title="Responsible Play"
                icon={<IconShield size={18} aria-hidden="true" />}
              />
              <p className="mb-4 text-sm text-[color:var(--text-secondary)]">
                Set your own daily loss limit. When you're down more than this
                in one day, the lobby warns you before you keep playing — it
                never blocks you.
              </p>

              <StatTile
                className="mb-4"
                label="Current limit"
                value={limitLabel}
                hint="A warning threshold, never a block."
                tone="gold"
              />

              <Tabs
                label="Daily loss limit"
                items={lossLimitItems}
                value={lossLimitMode}
                onChange={setLossLimitMode}
              />

              {lossLimitMode === "custom" && (
                <div className="mt-3 flex flex-wrap items-end gap-2">
                  <label className="flex flex-col gap-1 text-xs font-semibold text-[color:var(--text-secondary)]">
                    Daily loss limit (tokens)
                    <input
                      type="number"
                      min={1}
                      value={lossLimitDraft}
                      onChange={(e) => setLossLimitDraft(e.target.value)}
                      className="w-44 rounded-lg border border-[color:var(--border-strong)] bg-[color:var(--bg-page)] px-2 py-1.5 text-sm text-[color:var(--text-primary)] outline-hidden focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--focus-ring)]"
                      aria-label="Custom daily loss limit in tokens"
                    />
                  </label>
                  <div className="flex flex-wrap gap-1.5">
                    {[5000, 10000, 25000, 50000].map((v) => (
                      <Button
                        key={v}
                        variant="secondary"
                        size="sm"
                        onClick={() => setLossLimitDraft(String(v))}
                      >
                        {v.toLocaleString()}
                      </Button>
                    ))}
                  </div>
                </div>
              )}

              <div className="mt-4 flex flex-wrap items-center gap-3">
                <Button onClick={saveLossLimit} disabled={lossLimitSaving}>
                  {lossLimitSaving ? "Saving…" : "Save limit"}
                </Button>
                {lossLimitMsg && (
                  <span
                    className={`text-sm ${
                      lossLimitMsg.ok
                        ? "text-[color:var(--state-win)]"
                        : "text-[color:var(--state-loss)]"
                    }`}
                  >
                    {lossLimitMsg.text}
                  </span>
                )}
              </div>
            </Surface>

            {/* ── Account security ───────────────────────────────────────── */}

            <Surface tone="success">
              <PageHeader
                size="section"
                title="Account Security"
                icon={<IconShield size={18} aria-hidden="true" />}
              />
              <p className="mb-4 text-sm text-[color:var(--text-secondary)]">
                Two-factor authentication (email code). When enabled, a one-time
                code is required on each new session window (24h) — even for
                pages that don't otherwise require sign-in.
              </p>

              {mfaEnabled ? (
                <div>
                  <div className="mb-3 flex items-center gap-2 rounded-lg border border-[color:var(--border-success)] bg-[color:var(--accent-fill)] px-3 py-2 text-sm text-[color:var(--state-win)]">
                    <span className="h-2 w-2 rounded-full bg-[color:var(--state-win)]" />
                    Enabled — codes go to {mfaEmail || "your email"}.
                  </div>
                  <Button variant="danger" onClick={disableMfa} disabled={mfaBusy}>
                    {mfaBusy ? "Working…" : "Turn off"}
                  </Button>
                </div>
              ) : (
                <div className="space-y-3">
                  {!mfaOtpSent ? (
                    <Button onClick={sendMfaOtp} disabled={mfaBusy}>
                      {mfaBusy ? "Sending…" : "Turn on — send me a code"}
                    </Button>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      <input
                        type="text"
                        inputMode="numeric"
                        maxLength={6}
                        autoComplete="one-time-code"
                        placeholder="6-digit code"
                        value={mfaCode}
                        onChange={(e) => setMfaCode(e.target.value.replace(/\D/g, ""))}
                        className="w-40 rounded-lg border border-[color:var(--border-strong)] bg-[color:var(--bg-page)] px-3 py-2 text-center text-lg tracking-[0.4em] text-[color:var(--text-primary)] outline-hidden focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--focus-ring)]"
                      />
                      <Button onClick={verifyMfa} disabled={mfaBusy}>
                        {mfaBusy ? "Verifying…" : "Verify & enable"}
                      </Button>
                      <Button variant="secondary" onClick={sendMfaOtp} disabled={mfaBusy}>
                        Resend
                      </Button>
                    </div>
                  )}
                </div>
              )}
              {mfaMsg && (
                <p
                  className={`mt-3 text-sm ${
                    mfaMsg.ok
                      ? "text-[color:var(--state-win)]"
                      : "text-[color:var(--state-loss)]"
                  }`}
                >
                  {mfaMsg.text}
                </p>
              )}
            </Surface>

            {/* ── Email ──────────────────────────────────────────────────── */}

            <Surface>
              <PageHeader
                size="section"
                title="Email Notifications"
                icon={<IconBell size={18} aria-hidden="true" />}
              />
              <p className="mb-4 text-sm text-[color:var(--text-secondary)]">
                Choose which GRYND emails you receive. Security alerts and
                payment receipts are always sent.
              </p>
              <div className="space-y-3">
                {[
                  { key: "promotions", label: "Offers & promos", desc: "New games, bonuses, comeback offers." },
                  { key: "daily", label: "Daily reward reminders", desc: "Nudge when your daily bonus is ready." },
                  { key: "summary", label: "Weekly summaries", desc: "Your wins, losses and net for the week." },
                  { key: "progress", label: "Progress updates", desc: "Level-ups and streak encouragement." },
                ].map((opt) => (
                  <label
                    key={opt.key}
                    className="flex cursor-pointer items-center justify-between gap-3 rounded-lg border border-[color:var(--border-hairline)] bg-[color:var(--bg-panel)] px-3 py-2.5"
                  >
                    <span>
                      <span className="block text-sm font-medium text-[color:var(--text-primary)]">
                        {opt.label}
                      </span>
                      <span className="block text-xs text-[color:var(--text-muted)]">
                        {opt.desc}
                      </span>
                    </span>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={Boolean(prefs[opt.key])}
                      aria-label={opt.label}
                      onClick={() => setPrefs((p) => ({ ...p, [opt.key]: !p[opt.key] }))}
                      className={`relative h-6 w-11 shrink-0 rounded-full border transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--focus-ring)] ${
                        prefs[opt.key]
                          ? "border-[color:var(--accent)] bg-[color:var(--accent)]"
                          : "border-[color:var(--border-strong)] bg-[color:var(--bg-panel)]"
                      }`}
                    >
                      <span
                        className={`absolute top-0.5 h-5 w-5 rounded-full transition-all ${
                          prefs[opt.key]
                            ? "left-[22px] bg-[color:var(--on-accent)]"
                            : "left-0.5 bg-[color:var(--text-muted)]"
                        }`}
                      />
                    </button>
                  </label>
                ))}
              </div>
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <Button onClick={savePrefs} disabled={prefsSaving}>
                  {prefsSaving ? "Saving…" : "Save preferences"}
                </Button>
                <Button variant="secondary" onClick={unsubscribeAll} disabled={prefsSaving}>
                  Unsubscribe from all emails
                </Button>
                {prefsMsg && (
                  <span
                    className={`text-sm ${
                      prefsMsg.ok
                        ? "text-[color:var(--state-win)]"
                        : "text-[color:var(--state-loss)]"
                    }`}
                  >
                    {prefsMsg.text}
                  </span>
                )}
              </div>
            </Surface>

            {/* ── Account ────────────────────────────────────────────────── */}

            <Surface>
              <PageHeader
                size="section"
                title="Account"
                icon={<IconUser size={18} aria-hidden="true" />}
              />
              <ul className="space-y-2 text-sm">
                <li>
                  <Link
                    href="/profil"
                    className="inline-flex items-center gap-1.5 font-semibold text-[color:var(--accent-strong)] hover:text-[color:var(--text-primary)]"
                  >
                    My Profile →
                  </Link>
                </li>
                <li className="pt-1">
                  {/* GRYND PRO replaced the Shop entry point. The button reads
                      the caller's entitlement from the server, so it shows
                      "Manage Subscription" to members and the upgrade CTA to
                      everyone else. */}
                  <UpgradeProButton variant="compact" />
                </li>
              </ul>
            </Surface>

            {/* ── Your GRYND Preferences ───────────────────────────────────
                View + edit the onboarding questionnaire answers. This is THE
                preference surface: the lobby's "Make GRYND yours" card points
                here for players who chose "Maybe Later", and the questionnaire
                reopens in edit mode (?from=settings) and returns here. */}

            {gamePreferences === null && (
              <Surface className="md:col-span-2">
                <PageHeader
                  size="section"
                  title={t("onboarding.preferences.title")}
                  icon={<IconWand size={18} aria-hidden="true" />}
                />
                <p className="text-sm text-[color:var(--text-secondary)]" role="status">
                  {t("ui.loading")}
                </p>
              </Surface>
            )}

            {gamePreferences !== null && gamePreferences.completed && preferenceRows.length > 0 && (
              <Surface className="md:col-span-2">
                <PageHeader
                  size="section"
                  title={t("onboarding.preferences.title")}
                  icon={<IconWand size={18} aria-hidden="true" />}
                />
                <p className="mb-4 text-sm text-[color:var(--text-secondary)]">
                  {t("onboarding.preferences.note")}
                </p>
                <dl className="mb-4 grid gap-3 sm:grid-cols-2">
                  {preferenceRows.map((row) => (
                    <div
                      key={row.key}
                      className="rounded-lg border border-[color:var(--border-hairline)] bg-[color:var(--bg-panel)] px-3 py-2.5"
                    >
                      <dt className="text-[11px] font-bold uppercase tracking-widest text-[color:var(--text-muted)]">
                        {row.title}
                      </dt>
                      <dd className="mt-1.5 flex flex-wrap gap-1.5">
                        {row.labels.map((label) => (
                          <span
                            key={label}
                            className="rounded-full border border-[color:var(--accent)] bg-[color:var(--accent-fill)] px-2.5 py-1 text-xs font-semibold text-[color:var(--accent-strong)]"
                          >
                            {label}
                          </span>
                        ))}
                      </dd>
                    </div>
                  ))}
                </dl>
                <Button
                  variant="secondary"
                  href="/welcome/questionnaire?from=settings"
                >
                  <IconWand size={15} aria-hidden="true" /> {t("onboarding.preferences.update")}
                </Button>
              </Surface>
            )}

            {gamePreferences !== null && !(gamePreferences.completed && preferenceRows.length > 0) && (
              <EmptyState
                className="md:col-span-2"
                icon={<IconWand size={20} aria-hidden="true" />}
                title={
                  gamePreferences.ok
                    ? t("onboarding.preferences.empty")
                    : t("onboarding.preferences.error")
                }
                body={t("onboarding.preferences.emptyHint")}
                action={{
                  label: t("onboarding.preferences.cta"),
                  href: "/welcome/questionnaire?from=settings",
                }}
              />
            )}

            {/* ── Help & support ─────────────────────────────────────────── */}

            <Surface>
              <PageHeader
                size="section"
                title="Help & Support"
                icon={<IconHelp size={18} aria-hidden="true" />}
              />
              <ul className="space-y-2 text-sm">
                <li>
                  <Link
                    href="/welcome?replay=1"
                    className="inline-flex items-center gap-1.5 font-semibold text-[color:var(--accent-strong)] hover:text-[color:var(--text-primary)]"
                  >
                    <IconRotateClockwise size={15} aria-hidden="true" /> {t("onboarding.replay")} →
                  </Link>
                </li>
                <li>
                  <Link
                    href="/faq"
                    className="inline-flex items-center gap-1.5 font-semibold text-[color:var(--accent-strong)] hover:text-[color:var(--text-primary)]"
                  >
                    FAQ →
                  </Link>
                </li>
                <li>
                  <Link
                    href="/contact"
                    className="inline-flex items-center gap-1.5 font-semibold text-[color:var(--accent-strong)] hover:text-[color:var(--text-primary)]"
                  >
                    <IconMail size={15} aria-hidden="true" /> Contact →
                  </Link>
                </li>
              </ul>
            </Surface>

            {/* Admin — visible only to real admins (same DB-backed check as
                the nav bar / admin dashboard gate). */}
            {isAdmin && (
              <Surface tone="warning" className="md:col-span-2">
                <PageHeader
                  size="section"
                  title="Admin"
                  icon={<IconSettings size={18} aria-hidden="true" />}
                />
                <p className="mb-4 text-sm text-[color:var(--text-secondary)]">
                  Admin-only tools. This section is hidden from regular
                  players.
                </p>
                <Button variant="secondary" href="/admin">
                  Open Admin Dashboard →
                </Button>
              </Surface>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
