"use client";
import React, { useEffect, useState } from "react";
import { useUser, useAuth } from "@clerk/nextjs";
import { SignOutButton } from "./SignOutButton";
import { motion, useReducedMotion } from "framer-motion";
import AddFundsModal from "./AddFundsModal";
import Link from "next/link";
import { useLanguage } from "../context/LanguageContext";
import { useTheme } from "../context/ThemeContext";
import { useTranslation } from "../hooks/useTranslation";
import { fadeUp, hoverScale, withReducedMotion, stagger } from "../lib/animations";
import { UIPro01NavShell, UIPro02NavItem } from "./uipro";
import useInstallPWA from "../hooks/useInstallPWA";
import AdminBadge from "./AdminBadge";
import SoundToggle from "./SoundToggle";
import { IconCoins, IconDeviceMobile, IconFlame, IconGlobe, IconHelp, IconMail, IconMenu, IconSettings, IconShoppingBag, IconStar, IconX } from "@tabler/icons-react";
import { isSafeProfilePictureUrl } from "../lib/security/media";

// M1: sessionStorage TTL for the nav's level + equipped-title meta. Level
// and titles are slow-changing (and the server-side /api/user-stats is
// already Redis-cached for 3 min), so short-circuiting these lookups for a
// few minutes after each successful fetch cuts the heaviest nav invocation
// (/api/user-stats scans every game-history table) without changing any
// displayed value — the same pattern the is-admin cache already uses.
const NAV_META_TTL_MS = 5 * 60 * 1000;




const NAV_TRANSLATION_KEYS = {
  "/": "nav.home",
  "/games": "nav.casino",
  "/classement": "nav.leaderboard",
};

function NavigationBar({ currentPath }) {
  const { isLoaded, isSignedIn, user } = useUser();
  const { getToken } = useAuth();
  const { language, setLanguage } = useLanguage();
  const { theme, toggleTheme } = useTheme();
  const { t } = useTranslation();
  const shouldReduceMotion = useReducedMotion();
  const [balance, setBalance] = useState(null);
  const [profile, setProfile] = useState({
    name: "",
    profilePicture: "",
    selectedTitle: "",
    streakTitle: null,
  });
  const [error, setError] = useState(null);
  const [showAddFunds, setShowAddFunds] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [langOpen, setLangOpen] = useState(false);
  const [langClosing, setLangClosing] = useState(false);
  const [level, setLevel] = useState(null);
  const [isAdmin, setIsAdmin] = useState(false);

  // Fetch admin status from DB-backed API on mount
  // Uses sessionStorage to cache across page navigations within a session
  useEffect(() => {
    if (!user?.id) return;

    const cacheKey = `admin:${user.id}`;

    // Check sessionStorage cache first
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
        const isAdminVal = data.isAdmin === true;
        setIsAdmin(isAdminVal);
        try {
          sessionStorage.setItem(cacheKey, String(isAdminVal));
        } catch {
          // ignore
        }
      })
      .catch(() => setIsAdmin(false));
  }, [user?.id]);

  const navVariant = withReducedMotion(shouldReduceMotion, fadeUp);
  const itemVariant = withReducedMotion(shouldReduceMotion, fadeUp);
  const { canInstall, install } = useInstallPWA();

  const closeLang = () => {
    setLangClosing(true);
    setLangOpen(false);
    setTimeout(() => setLangClosing(false), 400);
  };

  const isIOS = typeof window !== "undefined" && /iPad|iPhone|iPod/.test(navigator.userAgent);

  useEffect(() => {
    const handler = () => fetchBalance({ includeMeta: false });
    const balanceHandler = (event) => {
      const nextBalance = Number(event?.detail?.balance);
      if (Number.isFinite(nextBalance)) {
        setBalance(nextBalance.toFixed(2));
      }
    };

    window.addEventListener("profileUpdated", handler);
    window.addEventListener("titleUpdated", handler);
    window.addEventListener("balanceUpdated", balanceHandler);
    return () => {
      window.removeEventListener("profileUpdated", handler);
      window.removeEventListener("titleUpdated", handler);
      window.removeEventListener("balanceUpdated", balanceHandler);
    };
  }, []);

  // Server-validated profile pictures only — a legacy/stale stored
  // value (e.g. data:image/svg+xml) falls back to the default avatar.
  const avatarSrc = isSafeProfilePictureUrl(profile?.profilePicture)
    ? profile.profilePicture
    : isSafeProfilePictureUrl(user?.imageUrl)
      ? user.imageUrl
      : "/default-avatar.png";

  const fetchBalance = async ({ includeMeta = true } = {}) => {
    try {
      const token = await getToken({ template: "app_token" });
      if (!token) return setError(t("nav.token_missing"));

      const response = await fetch("/api/get-user-tokens", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        credentials: "include",
      });

      const data = await response.json();
      if (response.status === 403) return setError(t("nav.invalid_token"));

      if (data.success) {
        setBalance(data.data.balance);          setProfile((prev) => ({
            ...prev,
            name: data.data.name || "",
            profilePicture: data.data.profilePicture || "",
            streakTitle: data.data.streakTitle || null,
          }));
        if (includeMeta) {
          // Cache level + equipped title in sessionStorage (short TTL) so a
          // hard reload does not re-fire the two heaviest nav meta calls
          // (/api/user-stats scans every game-history table for the level,
          // /api/titles reads the equipped title). These values are
          // slow-changing; the same few-minutes staleness already applies to
          // the Redis-cached user-stats (3 min) and the is-admin cache held
          // in sessionStorage. On a stale/missing cache we fetch fresh and
          // re-store.
          const metaKey = `navmeta:${user?.id ?? ""}`;
          let cachedAt = 0;
          try {
            cachedAt = Number(sessionStorage.getItem(`${metaKey}:t`) || 0);
          } catch {}
          const freshEnough = Date.now() - cachedAt < NAV_META_TTL_MS;
          if (freshEnough) {
            try {
              const cached = sessionStorage.getItem(metaKey);
              if (cached) {
                const meta = JSON.parse(cached);
                if (meta && typeof meta.level === "number")
                  setLevel(meta.level);
                if (meta && typeof meta.selectedTitle === "string")
                  setProfile((prev) => ({
                    ...prev,
                    selectedTitle: meta.selectedTitle,
                    streakTitle: meta.streakTitle || prev.streakTitle,
                  }));
              }
            } catch {}
          } else {
            let nextLevel = null;
            let nextTitle = "";
            let nextStreak = null;
            try {
              const statsRes = await fetch("/api/user-stats");
              const statsData = await statsRes.json();
              if (statsData.success) nextLevel = statsData.stats.currentLevel;
            } catch {}

            try {
              const titlesRes = await fetch("/api/titles", {
                credentials: "include",
              });
              const titlesData = await titlesRes.json();
              if (titlesData.success) {
                nextTitle =
                  titlesData.selectedSpecialTitle ||
                  titlesData.selectedTitle ||
                  "";
                nextStreak = titlesData.streakTitle || null;
              }
            } catch {}

            if (nextLevel !== null) setLevel(nextLevel);
            setProfile((prev) => ({
              ...prev,
              selectedTitle: nextTitle || prev.selectedTitle,
              streakTitle: nextStreak || prev.streakTitle,
            }));

            // Store the cache regardless of partial failures; next reload
            // before TTL expiry will skip the network.
            try {
              sessionStorage.setItem(
                `${metaKey}:t`,
                String(Date.now()),
              );
              sessionStorage.setItem(
                metaKey,
                JSON.stringify({
                  level: nextLevel,
                  selectedTitle: nextTitle,
                  streakTitle: nextStreak,
                }),
              );
            } catch {}
          }
        }
      } else if (data.shouldInitialize) {
        const initResponse = await fetch("/api/tokens/initialize", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
        });
        if (initResponse.ok) fetchBalance();
        else setError(t("nav.init_failed"));
      } else {
        setError(data.error || t("nav.unknown_error"));
      }
    } catch {
      setError(t("nav.network_error"));
    }
  };

  useEffect(() => {
    if (isSignedIn) fetchBalance({ includeMeta: true });
  }, [isSignedIn]);

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (!e.target.closest(".relative")) setLangOpen(false);
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Close language dropdown on Escape — per accessibility policy promise
  useEffect(() => {
    if (!langOpen) return;
    const handleKeyDown = (e) => {
      if (e.key === "Escape") closeLang();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [langOpen, closeLang]);

  // Close mobile menu on Escape — per accessibility policy promise
  useEffect(() => {
    if (!mobileMenuOpen) return;
    const handleKeyDown = (e) => {
      if (e.key === "Escape") setMobileMenuOpen(false);
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [mobileMenuOpen]);

  useEffect(() => {
    const interval = setInterval(
      async () => {
        try {
          const response = await fetch(window.location.href, {
            method: "HEAD",
            cache: "no-store",
          });

          const newVersion = response.headers.get("etag");

          if (window.__APP_ETAG && newVersion && window.__APP_ETAG !== newVersion) {
            const shouldRefresh = confirm("A new version of GRYND is available. Refresh now?");

            if (shouldRefresh) {
              window.location.reload();
            }
          }

          window.__APP_ETAG = newVersion;
        } catch {}
      },
      1000 * 60 * 5
    );

    return () => clearInterval(interval);
  }, []);

  const isCasinoPath =
    currentPath.startsWith("/casino") || currentPath.startsWith("/games");

  return (
    <>
      <motion.nav
        initial={navVariant.initial}
        animate={navVariant.animate}
        transition={navVariant.transition}
        data-no-translate="true"
        className="fixed top-0 left-0 right-0 z-40 border-b border-[#00e5ff]/40 bg-[#050b1e]/75 shadow-[0_0_22px_rgba(0,229,255,0.25)]"
      >
        <UIPro01NavShell className="mx-auto max-w-7xl px-3 sm:px-4">
          <div className="flex h-24 items-center justify-between gap-2">
            <Link href="/" className="flex items-center">
              {/* Plain <img> with the public URL (not the webpack import).
                  An imported .png resolves to a structured object at runtime,
                  which a plain <img> cannot render (src becomes "[object
                  Object]" and the browser shows only the alt text). The
                  public path is a plain string served from /public, so it
                  always loads on first paint.

                  Uses /images/navbar-logo.png — a copy of smalllogo.png
                  cropped to its visible glyph. The source file has ~35%
                  transparent padding on each side, so the old logo box was
                  140px wide while the actual mark rendered at ~42px. The
                  cropped asset is ~1:1, so the same box now shows the logo
                  at full size. */}
              {/* eslint-disable-next-line @next/next/no-img-element -- static asset, avoids next/image first-paint blanking */}
              <img
                src="/images/navbar-logo.png"
                alt="GRYND Logo"
                width={84}
                height={87}
                className="h-[72px] w-auto object-contain drop-shadow-[0_0_14px_rgba(245,255,59,0.5)] sm:h-[84px]"
              />
            </Link>

            <motion.div
              variants={stagger}
              initial="initial"
              animate="animate"
              className="hidden items-center space-x-4 md:flex"
            >
              {["/", "/games", "/classement"].map((path) => (
                <motion.div
                  key={path}
                  initial={itemVariant.initial}
                  animate={itemVariant.animate}
                  transition={itemVariant.transition}
                  whileHover={shouldReduceMotion ? undefined : hoverScale.whileHover}
                >
                  <Link
                    href={path}
                    className={`px-3 py-2 text-sm font-medium rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff] focus-visible:ring-offset-2 focus-visible:ring-offset-[#050b1e] ${currentPath === path || (path === "/games" && isCasinoPath) ? "text-[#f5ff3b] drop-shadow-[0_0_8px_rgba(245,255,59,0.6)]" : "text-[#9dd8ff] hover:text-[#00e5ff]"}`}
                  >
                    {t(NAV_TRANSLATION_KEYS[path])}
                  </Link>
                </motion.div>
              ))}
              <motion.div
                key="/contact"
                initial={itemVariant.initial}
                animate={itemVariant.animate}
                transition={itemVariant.transition}
                whileHover={shouldReduceMotion ? undefined : hoverScale.whileHover}
              >
                <Link
                  href="/contact"
                  className={`px-3 py-2 text-sm font-medium rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff] focus-visible:ring-offset-2 focus-visible:ring-offset-[#050b1e] ${currentPath === "/contact" ? "text-[#f5ff3b] drop-shadow-[0_0_8px_rgba(245,255,59,0.6)]" : "text-[#9dd8ff] hover:text-[#00e5ff]"}`}
                >
                  <span className="inline-flex items-center gap-1.5">
                    <IconMail size={15} className="shrink-0" /> Contact
                  </span>
                </Link>
              </motion.div>
              <motion.div
                key="/shop"
                initial={itemVariant.initial}
                animate={itemVariant.animate}
                transition={itemVariant.transition}
                whileHover={shouldReduceMotion ? undefined : hoverScale.whileHover}
              >
                <Link
                  href="/shop"
                  className={`px-3 py-2 text-sm font-medium rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff] focus-visible:ring-offset-2 focus-visible:ring-offset-[#050b1e] ${currentPath === "/shop" ? "text-[#f5ff3b] drop-shadow-[0_0_8px_rgba(245,255,59,0.6)]" : "text-[#9dd8ff] hover:text-[#00e5ff]"}`}
                >
                  <span className="inline-flex items-center gap-1.5">
                    <IconShoppingBag size={15} className="shrink-0" /> Shop
                  </span>
                </Link>
              </motion.div>
              <motion.div
                key="/faq"
                initial={itemVariant.initial}
                animate={itemVariant.animate}
                transition={itemVariant.transition}
                whileHover={shouldReduceMotion ? undefined : hoverScale.whileHover}
              >
                <Link
                  href="/faq"
                  className={`px-3 py-2 text-sm font-medium rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff] focus-visible:ring-offset-2 focus-visible:ring-offset-[#050b1e] ${currentPath === "/faq" ? "text-[#f5ff3b] drop-shadow-[0_0_8px_rgba(245,255,59,0.6)]" : "text-[#9dd8ff] hover:text-[#00e5ff]"}`}
                >
                  <span className="inline-flex items-center gap-1.5">
                    <IconHelp size={15} className="shrink-0" /> FAQ
                  </span>
                </Link>
              </motion.div>
              {isAdmin && isSignedIn && (
                <motion.div
                  key="/admin"
                  initial={itemVariant.initial}
                  animate={itemVariant.animate}
                  transition={itemVariant.transition}
                  whileHover={shouldReduceMotion ? undefined : hoverScale.whileHover}
                >
                  <Link
                    href="/admin"
                    className={`px-3 py-2 text-sm font-medium rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#ff8c42] focus-visible:ring-offset-2 focus-visible:ring-offset-[#050b1e] ${currentPath === "/admin" ? "text-[#f5ff3b] drop-shadow-[0_0_8px_rgba(245,255,59,0.6)]" : "text-[#ff8c42] hover:text-[#ffb347]"}`}
                  >
                    <span className="inline-flex items-center gap-1.5">
                      <IconSettings size={15} className="shrink-0" /> Admin
                    </span>
                  </Link>
                </motion.div>
              )}
            </motion.div>

            <div className="flex items-center gap-2 sm:gap-4">
              {canInstall && (
                <button
                  onClick={install}
                  className="hidden sm:inline-flex items-center rounded-lg border border-[#f5ff3b]/40 bg-[#f5ff3b]/10 px-3 py-1 text-xs font-medium text-[#f5ff3b] hover:bg-[#f5ff3b]/20"
                >
                  <IconDeviceMobile size={16} className="mr-1" /> Install App
                </button>
              )}
              <SoundToggle />
              <div className="relative">
                <button
                  onClick={() => (langOpen ? closeLang() : setLangOpen(true))}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      langOpen ? closeLang() : setLangOpen(true);
                    }
                  }}
                  aria-expanded={langOpen}
                  aria-label={`Select language, currently ${language === "en" ? "English" : language === "fr" ? "French" : "Spanish"}`}
                  className="cursor-pointer rounded-lg border border-[#00e5ff]/50 bg-[#091737] px-2 py-1 text-xs text-[#c9f7ff] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff] focus-visible:ring-offset-2 focus-visible:ring-offset-[#050b1e] sm:text-sm"
                >
                  {language === "en" && (
                    <span className="inline-flex items-center gap-1">
                      EN <IconGlobe size={14} />
                    </span>
                  )}
                  {language === "fr" && (
                    <span className="inline-flex items-center gap-1">
                      FR <IconGlobe size={14} />
                    </span>
                  )}
                  {language === "es" && (
                    <span className="inline-flex items-center gap-1">
                      ES <IconGlobe size={14} />
                    </span>
                  )}
                </button>

                {(langOpen || langClosing) && (
                  <div
                    className={`absolute right-0 mt-2 w-full ${langOpen ? "animate-parchment" : "animate-parchment-close"}`}
                  >
                    <div role="menu" className="overflow-hidden rounded-lg border border-[#00e5ff]/50 bg-[#091737] shadow-lg">
                      {[
                        { value: "en", label: "EN" },
                        { value: "fr", label: "FR" },
                        { value: "es", label: "ES" },
                      ].map((lang) => (
                        <button
                          key={lang.value}
                          onClick={() => {
                            setLanguage(lang.value);
                            closeLang();
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              setLanguage(lang.value);
                              closeLang();
                            }
                          }}
                          role="menuitem"
                          className="w-full text-left cursor-pointer px-2 py-1 text-sm text-[#c9f7ff] hover:bg-[#00e5ff]/20 focus-visible:outline-none focus-visible:bg-[#00e5ff]/20"
                        >
                          {lang.label}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {isLoaded && isSignedIn ? (
                <>
                  <div className="hidden items-center space-x-4 lg:flex">
                    <Link href="/profil" className="group flex items-center space-x-2">
                      {avatarSrc ? (
                        <img
                          src={avatarSrc}
                          alt="profile"
                          className="h-8 w-8 rounded-full border border-[#00e5ff]/50 object-cover transition group-hover:scale-105"
                        />
                      ) : (
                        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-[#00e5ff] text-xs font-bold text-black">
                          {user?.firstName?.[0] || "U"}
                        </div>
                      )}
                      <div className="flex flex-col leading-tight">
                        <span className="text-xs text-[#c9f7ff] flex items-center gap-1.5">
                          {profile?.name ||
                            user?.username ||
                            user?.firstName ||
                            t("nav.user_fallback")}
                          {isAdmin && <AdminBadge />}
                        </span>
                        <span className="text-[10px] text-[#f5ff3b]">
                          {profile?.selectedTitle || "No title equipped"}
                        </span>
                        {profile?.streakTitle && (
                          <span className="text-[10px] text-amber-400">
                            <IconFlame size={12} className="mb-0.5 mr-0.5 inline" /> {profile.streakTitle}
                          </span>
                        )}
                        <span className="text-[10px] text-[#7dd3fc]">
                          {t("nav.level_short")} {level ?? "..."}
                        </span>
                      </div>
                    </Link>
                    <div className="rounded-md border border-[#00e5ff]/50 bg-gradient-to-r from-[#091737] to-[#0e1f4d] px-3 py-1 shadow-[0_0_12px_rgba(0,229,255,0.35)]">
                      <span className="mr-1 text-[10px] uppercase tracking-[0.2em] text-[#7dd3fc]">
                        Tokens
                      </span>
                      <span className="font-mono text-sm font-semibold text-[#67f9ff] drop-shadow-[0_0_8px_rgba(0,229,255,0.65)]">
                        {error
                          ? `${t("nav.error")}: ${error}`
                          : balance !== null
                            ? Number(balance).toLocaleString(undefined, {
                                minimumFractionDigits: 2,
                                maximumFractionDigits: 2,
                              })
                            : t("nav.loading")}
                      </span>
                    </div>
                  </div>
                  <button
                    onClick={() => setMobileMenuOpen((v) => !v)}
                    className="inline-flex h-10 w-10 items-center justify-center rounded-lg border border-[#00e5ff]/40 bg-[#00e5ff]/10 text-[#d8fbff] lg:hidden"
                    aria-label="Toggle menu"
                  >
                    <IconMenu size={20} />
                  </button>
                  <SignOutButton>
                    <UIPro02NavItem className="rounded-lg border border-[#00e5ff]/40 bg-[#00e5ff]/20 px-4 py-2 text-sm font-medium text-[#d8fbff] hover:bg-[#00e5ff]/35">
                      {t("nav.sign_out")}
                    </UIPro02NavItem>
                  </SignOutButton>
                </>
              ) : (
                <>
                  <button
                    onClick={() => setMobileMenuOpen((v) => !v)}
                    className="inline-flex h-10 w-10 items-center justify-center rounded-lg border border-[#00e5ff]/40 bg-[#00e5ff]/10 text-[#d8fbff] md:hidden"
                    aria-label="Toggle menu"
                  >
                    <IconMenu size={20} />
                  </button>
                  <UIPro02NavItem
                    href="/sign-up"
                    className="hidden rounded-lg border border-[#FFFF33]/40 bg-[#FFFF33]/20 px-4 py-2 text-sm font-medium text-[#d8fbff] hover:bg-[#FFFF33]/35 md:inline-flex"
                  >
                    {t("nav.create_account")}
                  </UIPro02NavItem>
                  <UIPro02NavItem
                    href="/sign-in"
                    className="hidden rounded-lg border border-[#00e5ff]/40 bg-[#00e5ff]/20 px-4 py-2 text-sm font-medium text-[#d8fbff] hover:bg-[#00e5ff]/35 md:inline-flex"
                  >
                    {t("nav.sign_in")}
                  </UIPro02NavItem>
                </>
              )}
            </div>
          </div>
        </UIPro01NavShell>
        {mobileMenuOpen && (
          <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm">
            {/* SIDEBAR */}
            <div className="absolute left-0 top-0 h-full w-72 bg-[#08142f] border-r border-[#00e5ff]/30 p-4 space-y-4">
              {/* CLOSE */}
              <button onClick={() => setMobileMenuOpen(false)} className="text-[#f5ff3b] text-sm">
                <IconX size={16} className="mb-0.5 mr-1 inline" /> Close
              </button>

              {/* PROFILE */}
              {isSignedIn && (
                <Link
                  href="/profil"
                  onClick={() => setMobileMenuOpen(false)}
                  className="flex items-center gap-3"
                >
                  <img src={avatarSrc} className="h-10 w-10 rounded-full" alt="User avatar" />
                  <div>
                    <div className="text-[#c9f7ff] text-sm flex items-center gap-1.5">{profile?.name || "User"}{isAdmin && <AdminBadge />}</div>
                    <div className="text-xs text-[#f5ff3b]">{profile?.selectedTitle}</div>
                    {profile?.streakTitle && (
                      <div className="text-xs text-amber-400">
                        <IconFlame size={12} className="mb-0.5 mr-0.5 inline" /> {profile.streakTitle}
                      </div>
                    )}
                  </div>
                </Link>
              )}

              {/* TOKENS */}
              {isSignedIn && (
                <div className="rounded-lg border border-[#00e5ff]/30 bg-[#091737] p-3 text-sm text-[#67f9ff]">
                  <IconCoins size={16} className="mb-0.5 mr-1 inline" /> Tokens: {balance !== null ? Number(balance).toFixed(2) : "Loading..."}
                </div>
              )}

              {/* NAV LINKS */}
              <div className="space-y-2">
                {["/", "/games", "/classement"].map((path) => (
                  <Link
                    key={path}
                    href={path}
                    onClick={() => setMobileMenuOpen(false)}
                    className="block rounded-lg bg-[#091737] px-3 py-2 text-[#9dd8ff]"
                  >
                    {t(NAV_TRANSLATION_KEYS[path])}
                  </Link>
                ))}
                  <Link
                    href="/contact"
                    onClick={() => setMobileMenuOpen(false)}
                    className="block rounded-lg bg-[#091737] px-3 py-2 text-[#9dd8ff]"
                  >
                    <span className="inline-flex items-center gap-1.5">
                      <IconMail size={15} className="shrink-0" /> Contact
                    </span>
                  </Link>
                  <Link
                    href="/shop"
                    onClick={() => setMobileMenuOpen(false)}
                    className="block rounded-lg bg-[#091737] px-3 py-2 text-[#9dd8ff]"
                  >
                    <span className="inline-flex items-center gap-1.5">
                      <IconShoppingBag size={15} className="shrink-0" /> Shop
                    </span>
                  </Link>
                  <Link
                    href="/faq"
                    onClick={() => setMobileMenuOpen(false)}
                    className="block rounded-lg bg-[#091737] px-3 py-2 text-[#9dd8ff]"
                  >
                    <span className="inline-flex items-center gap-1.5">
                      <IconHelp size={15} className="shrink-0" /> FAQ
                    </span>
                  </Link>
                {isAdmin && isSignedIn && (
                <Link
                  href="/admin"
                  onClick={() => setMobileMenuOpen(false)}
                  className="block rounded-lg bg-[#091737] px-3 py-2 text-[#ff8c42]"
                >
                  <span className="inline-flex items-center gap-1.5">
                    <IconSettings size={15} className="shrink-0" /> Admin
                  </span>
                </Link>
              )}
            </div>
              {!isSignedIn && (
                <div className="grid grid-cols-2 gap-2">
                  <Link
                    href="/sign-up"
                    onClick={() => setMobileMenuOpen(false)}
                    className="rounded-lg border border-[#FFFF33]/40 bg-[#FFFF33]/20 px-3 py-2 text-center text-sm font-medium text-[#d8fbff]"
                  >
                    {t("nav.create_account")}
                  </Link>

                  <Link
                    href="/sign-in"
                    onClick={() => setMobileMenuOpen(false)}
                    className="rounded-lg border border-[#00e5ff]/40 bg-[#00e5ff]/20 px-3 py-2 text-center text-sm font-medium text-[#d8fbff]"
                  >
                    {t("nav.sign_in")}
                  </Link>
                </div>
              )}

              {/* INSTALL BUTTON */}
              {(canInstall || isIOS) && (
                <button
                  onClick={install}
                  className="w-full rounded-lg bg-[#f5ff3b]/10 px-3 py-2 text-[#f5ff3b]"
                >
                  <IconDeviceMobile size={16} className="mr-1" /> Install App
                </button>
              )}
            </div>

            {/* CLICK OUTSIDE TO CLOSE */}
            <div className="w-full h-full" onClick={() => setMobileMenuOpen(false)} />
          </div>
        )}
      </motion.nav>

      <AddFundsModal
        isOpen={showAddFunds}
        onClose={() => setShowAddFunds(false)}
        onSuccess={setBalance}
      />
    </>
  );
}

export default NavigationBar;
