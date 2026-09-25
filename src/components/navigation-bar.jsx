"use client";
import React, { useEffect, useState } from "react";
import { useUser } from "@clerk/nextjs";
import { usePathname } from "next/navigation";
import { SignOutButton } from "./SignOutButton";
import { motion, useReducedMotion } from "framer-motion";
import Link from "next/link";
import { useTheme } from "../context/ThemeContext";
import { useTranslation } from "../hooks/useTranslation";
import { fadeUp, hoverScale, withReducedMotion, stagger } from "../lib/animations";
import { UIPro01NavShell, UIPro02NavItem } from "./uipro";
import useInstallPWA from "../hooks/useInstallPWA";
import AdminBadge from "./AdminBadge";
import BattlepassClaimBadge from "./BattlepassClaimBadge";
import { IconDeviceMobile, IconFlame, IconMenu, IconSettings, IconStar, IconX } from "@tabler/icons-react";
import FrameAvatar from "./FrameAvatar";
import { cosmeticEffectClass } from "../lib/profileCosmetics";
import useDailyLoss from "../lib/useDailyLoss";
import { DAILY_LOSS_CHIP_THRESHOLD } from "../lib/games/economy";

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
  "/battlepass": "nav.battlepass",
};

function NavigationBar({ currentPath = "" }) {
  const { isLoaded, isSignedIn, user } = useUser();
  const { theme, toggleTheme } = useTheme();
  const { t } = useTranslation();
  const pathname = usePathname();
  const shouldReduceMotion = useReducedMotion();
  // Today's net (responsible-play) chip — rendered on the home page (mobile
  // menu) only, so it never duplicates the fixed lobby chip (DailyLossGuard).
  const { loss: dailyLoss, loaded: dailyLossLoaded } = useDailyLoss();
  const [profile, setProfile] = useState({
    name: "",
    selectedIcon: "",
    // Equipped profile frame (token-shop `profile_frame`), or null.
    profileFrame: null,
    usernameEffect: null,
    // Equipped NAME GLOW (a Battle Pass reward) — the catalog hex this display
    // name is coloured + haloed with, or null for none. Comes from the
    // `glowColor` field of /api/get-user-tokens (the glow row joined on
    // `users.selectedGlow`), not from `nameColor`.
    glowColor: null,
    selectedTitle: "",
    streakTitle: null,
    // Server-resolved prestige badge (null unless equipped + earned) plus
    // the raw prestige tier for the global unlock notice.
    prestigeBadge: null,
    prestige: 0,
    prestigeUnlocked: false,
  });
  const [, setError] = useState(null);
  // Prestige tier being celebrated by the global in-app notice (null = none).
  const [prestigeNotice, setPrestigeNotice] = useState(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
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

  const isIOS = typeof window !== "undefined" && /iPad|iPhone|iPod/.test(navigator.userAgent);

  // Re-read the equipped title from the server. Fired when the profile
  // page equips/unequips a title so the navbar chip updates instantly.
  // Also bumps the nav-meta cache timestamp so the short TTL cache can't
  // serve the stale (previous) title afterwards.
  const refreshTitleMeta = async () => {
    try {
      const titlesRes = await fetch("/api/titles", {
        credentials: "include",
      });
      const titlesData = await titlesRes.json();
      if (!titlesData.success) return;
      setProfile((prev) => ({
        ...prev,
        // The equipped-title chip shows the Prestige badge first —
        // always the server-resolved string, never client text.
        selectedTitle:
          titlesData.prestigeBadge ||
          titlesData.selectedSpecialTitle ||
          titlesData.selectedTitle ||
          "",
        streakTitle: titlesData.streakTitle || null,
        prestigeBadge: titlesData.prestigeBadge || null,
        prestige: Number(titlesData.prestige) || 0,
        prestigeUnlocked: Boolean(titlesData.prestigeUnlocked),
      }));
      // Invalidate the cached meta so the next mount/refresh fetches
      // fresh values instead of the pre-change title.
      try {
        sessionStorage.setItem(`navmeta:${user?.id ?? ""}:t`, "0");
      } catch {}
    } catch {}
  };

  useEffect(() => {
    const handler = () => fetchBalance({ includeMeta: false });
    const titleHandler = () => refreshTitleMeta();

    window.addEventListener("profileUpdated", handler);
    window.addEventListener("titleUpdated", titleHandler);
    return () => {
      window.removeEventListener("profileUpdated", handler);
      window.removeEventListener("titleUpdated", titleHandler);
    };
  }, []);

  // Official Grynd icon only. The avatar comes from the selected icon key in
  // get-user-tokens; <IconAvatar> resolves it through the official catalog and
  // falls back to the default icon (Clerk's imageUrl is never used as a Grynd
  // avatar).

  const fetchBalance = async ({ includeMeta = true } = {}) => {
    try {
      // Same-origin request. /api/get-user-tokens authenticates with Clerk's
      // normal session cookie via auth(), so no Authorization header is
      // needed. Sending a custom `app_token` JWT there was actively harmful:
      // clerkMiddleware authenticates FROM the Authorization header whenever
      // it is present (preferring it over the session cookie), and a custom
      // JWT-template token is not a Clerk session token — so the whole
      // request was resolved as signed-out and the route returned 401.
      const response = await fetch("/api/get-user-tokens", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        credentials: "include",
      });

      const data = await response.json();
      if (response.status === 403) return setError(t("nav.invalid_token"));

      if (data.success) {
        setProfile((prev) => ({
            ...prev,
            name: data.data.name || "",
            selectedIcon: data.data.selectedIcon || "",
            // Embed the equipped avatar effect on the frame payload so the
            // shared <FrameAvatar> renders it (see src/lib/profileCosmetics).
            profileFrame: (() => {
              const frame = data.data.equippedCosmetics?.profile_frame || null;
              const avatarEffect =
                data.data.equippedCosmetics?.avatar_effect || null;
              if (!frame && !avatarEffect) return null;
              return {
                key: frame?.key ?? null,
                name: frame?.name ?? null,
                visual: frame?.visual ?? null,
                avatarEffect,
              };
            })(),
            usernameEffect: data.data.equippedCosmetics?.username_effect || null,
            // Equipped NAME GLOW hex, resolved server-side in this same payload
            // (the glow's catalog `color`, left-joined on `selectedGlow`). It
            // is deliberately NOT `nameColor`: that one falls back to the
            // GRYND PRO chat colour, which must not paint the display name.
            glowColor: data.data.glowColor || null,
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
                    streakTitle: meta.streakTitle ?? prev.streakTitle,
                    prestigeBadge: meta.prestigeBadge ?? prev.prestigeBadge,
                    prestige:
                      typeof meta.prestige === "number"
                        ? meta.prestige
                        : prev.prestige,
                    prestigeUnlocked:
                      typeof meta.prestigeUnlocked === "boolean"
                        ? meta.prestigeUnlocked
                        : prev.prestigeUnlocked,
                  }));
              }
            } catch {}
          } else {
            let nextLevel = null;
            let nextTitle = "";
            let nextStreak = null;
            let nextPrestige = 0;
            let nextPrestigeUnlocked = false;
            let nextPrestigeBadge = null;
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
                // The equipped-title chip shows the Prestige badge first —
                // always the server-resolved string, never client text.
                nextTitle =
                  titlesData.prestigeBadge ||
                  titlesData.selectedSpecialTitle ||
                  titlesData.selectedTitle ||
                  "";
                nextStreak = titlesData.streakTitle || null;
                nextPrestige = Number(titlesData.prestige) || 0;
                nextPrestigeUnlocked = Boolean(titlesData.prestigeUnlocked);
                nextPrestigeBadge = titlesData.prestigeBadge || null;
              }
            } catch {}

            if (nextLevel !== null) setLevel(nextLevel);
            setProfile((prev) => ({
              ...prev,
              // Empty string means "no title equipped" — never fall back
              // to the previous title, or unequipping would never clear.
              selectedTitle: nextTitle,
              streakTitle: nextStreak,
              prestigeBadge: nextPrestigeBadge,
              prestige: nextPrestige,
              prestigeUnlocked: nextPrestigeUnlocked,
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
                  prestige: nextPrestige,
                  prestigeUnlocked: nextPrestigeUnlocked,
                  prestigeBadge: nextPrestigeBadge,
                }),
              );
            } catch {}
          }
        }
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
    // Deploy check: one HEAD request per 5 minutes, skipped entirely while
    // the tab is hidden (no need to poll for a new version in the
    // background — the check resumes when the tab is visible again).
    const interval = setInterval(
      async () => {
        if (document.visibilityState !== "visible") return;
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

  // In-app "Prestige unlocked" notice — an app-wide notification surface
  // alongside the Battle Pass page modal. Fires once per tier-up on any page
  // except /battlepass (that page shows its own larger modal). The tier
  // always comes from the server (/api/titles via fetchBalance); the shared
  // localStorage watermark means an advancement is celebrated exactly once
  // app-wide, and the client can never fabricate the tier.
  useEffect(() => {
    if (!profile.prestigeUnlocked || profile.prestige < 1) return;
    if (pathname && pathname.startsWith("/battlepass")) return;
    const STORAGE_KEY = "grynd.prestige.celebrated.v1";
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      const seen = raw ? Math.max(0, Number(JSON.parse(raw)) || 0) : 0;
      if (profile.prestige > seen) {
        setPrestigeNotice(profile.prestige);
        window.localStorage.setItem(
          STORAGE_KEY,
          JSON.stringify(profile.prestige),
        );
      }
    } catch {
      // Storage unavailable — skip the notice; never crash the page.
    }
  }, [pathname, profile.prestige, profile.prestigeUnlocked]);

  // The equipped name glow: the same treatment the profile card gives the
  // display name — the catalog hex as the text colour plus its halo.
  // `undefined` (no glow equipped) leaves the stylesheet colour in place.
  const nameGlowStyle = profile.glowColor
    ? {
        color: profile.glowColor,
        textShadow: `0 0 12px ${profile.glowColor}66`,
      }
    : undefined;

  return (
    <>
      {/* The navbar renders fully visible on mount (initial={false}) — no
          fade-up entrance. It lives inside every page's client component,
          so an opacity-0 start made the whole bar (logo included) vanish
          for ~300ms on each navigation and after the splash screen on a
          hard refresh. Skipping the entrance keeps the logo on screen
          from the first paint, every time. */}
      <motion.nav
        initial={false}
        animate={navVariant.animate}
        transition={navVariant.transition}
        data-no-translate="true"
        className="fixed top-0 left-0 right-0 z-40 border-b border-[#00e5ff]/40 bg-[#050b1e]/75 shadow-[0_0_22px_rgba(0,229,255,0.25)]"
      >
        {/* max-w-[1440px] gives the fully-loaded navbar (logo + 7 links +
            install + avatar + tokens + sign-out ≈1390px) room to breathe on
            wide screens; the old max-w-7xl (1280px) capped it and forced
            the logo/right side to be squeezed. */}
        <UIPro01NavShell className="mx-auto max-w-[1440px] px-3 sm:px-4">
          <div className="flex h-16 items-center justify-between gap-2 sm:h-20 md:h-24">
            {/* shrink-0: the navbar flex row must never squeeze the logo —
                at laptop widths (≈768–1100px) it collapsed to 0px wide and
                the logo vanished entirely. */}
            <Link href="/" className="flex shrink-0 items-center">
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
                width={92}
                height={95}
                className="h-[52px] w-auto object-contain drop-shadow-[0_0_14px_rgba(245,255,59,0.5)] sm:h-[68px] md:h-[82px]"
              />
            </Link>

            <motion.div
              variants={stagger}
              initial="initial"
              animate="animate"
              className="hidden items-center space-x-4 md:flex"
            >
              {["/", "/games", "/classement", "/battlepass"].map((path) => (
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
                    {/* Unclaimed-reward nudge — count pill + one-time toast */}
                    {path === "/battlepass" && <BattlepassClaimBadge />}
                  </Link>
                </motion.div>
              ))}
              <motion.div
                key="/settings"
                initial={itemVariant.initial}
                animate={itemVariant.animate}
                transition={itemVariant.transition}
                whileHover={shouldReduceMotion ? undefined : hoverScale.whileHover}
              >
                <Link
                  href="/settings"
                  className={`px-3 py-2 text-sm font-medium rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff] focus-visible:ring-offset-2 focus-visible:ring-offset-[#050b1e] ${currentPath === "/settings" ? "text-[#f5ff3b] drop-shadow-[0_0_8px_rgba(245,255,59,0.6)]" : "text-[#9dd8ff] hover:text-[#00e5ff]"}`}
                >
                  <span className="inline-flex items-center gap-1.5">
                    <IconSettings size={15} className="shrink-0" /> {t("nav.settings")}
                  </span>
                </Link>
              </motion.div>
              {/* GRYND PRO — replaced the old token Shop link. This is a link
                  (not the UpgradeProButton) so the navbar stays a pure
                  navigation surface; the upgrade CTA lives on the pages. */}
              <motion.div
                key="/upgrade-pro"
                className="hidden 2xl:flex"
                initial={itemVariant.initial}
                animate={itemVariant.animate}
                transition={itemVariant.transition}
                whileHover={shouldReduceMotion ? undefined : hoverScale.whileHover}
              >
                <Link
                  href="/upgrade-pro"
                  className={`px-3 py-2 text-sm font-medium rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff] focus-visible:ring-offset-2 focus-visible:ring-offset-[#050b1e] ${currentPath === "/upgrade-pro" ? "text-[#f5ff3b] drop-shadow-[0_0_8px_rgba(245,255,59,0.6)]" : "text-[#9dd8ff] hover:text-[#00e5ff]"}`}
                >
                  <span className="inline-flex items-center gap-1.5">
                    <IconStar size={15} className="shrink-0" /> GRYND PRO
                  </span>
                </Link>
              </motion.div>
            </motion.div>

            {/* shrink-0: the right-side cluster must never be squeezed off
                the viewport edge (the sign-out button was getting clipped
                on laptop widths when signed in). */}
            <div className="flex shrink-0 items-center gap-2 sm:gap-4">
              {canInstall && (
                <button
                  onClick={install}
                  className="hidden 2xl:inline-flex items-center rounded-lg border border-[#f5ff3b]/40 bg-[#f5ff3b]/10 px-3 py-1 text-xs font-medium text-[#f5ff3b] hover:bg-[#f5ff3b]/20"
                >
                  <IconDeviceMobile size={16} className="mr-1" /> Install App
                </button>
              )}
              {isLoaded && isSignedIn ? (
                <>
                  <div className="hidden items-center space-x-4 lg:flex">
                    <Link href="/profil" className="group flex items-center space-x-2">
                      <FrameAvatar
                        frame={profile?.profileFrame}
                        iconKey={profile?.selectedIcon}
                        name={profile?.name || user?.firstName}
                        size="h-8 w-8"
                        className="border border-[#00e5ff]/50 transition group-hover:scale-105"
                      />
                      <div className="flex flex-col leading-tight">
                        <span
                          data-testid="nav-user-name"
                          className={`text-xs text-[#c9f7ff] flex items-center gap-1.5 ${cosmeticEffectClass(profile?.usernameEffect?.visual) || ""}`}
                          style={nameGlowStyle}
                        >
                          {profile?.name ||
                            user?.username ||
                            user?.firstName ||
                            t("nav.user_fallback")}
                          {isAdmin && <AdminBadge />}
                        </span>
                        <span
                          className={`text-[10px] ${
                            profile?.prestigeBadge
                              ? "text-violet-300"
                              : "text-[#f5ff3b]"
                          }`}
                        >
                          {profile?.prestigeBadge ||
                            profile?.selectedTitle ||
                            "No title equipped"}
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
                  </div>
                  <button
                    onClick={() => setMobileMenuOpen((v) => !v)}
                    className="inline-flex h-10 w-10 items-center justify-center rounded-lg border border-[#00e5ff]/40 bg-[#00e5ff]/10 text-[#d8fbff] 2xl:hidden"
                    aria-label="Toggle menu"
                    aria-expanded={mobileMenuOpen}
                    aria-controls="mobile-nav-menu"
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
          <div id="mobile-nav-menu" className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm">
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
                  <FrameAvatar
                    frame={profile?.profileFrame}
                    iconKey={profile?.selectedIcon}
                    name={profile?.name || user?.firstName}
                    size="h-10 w-10"
                  />
                  <div>
                    <div
                      data-testid="nav-user-name"
                      className={`text-[#c9f7ff] text-sm flex items-center gap-1.5 ${cosmeticEffectClass(profile?.usernameEffect?.visual) || ""}`}
                      style={nameGlowStyle}
                    >
                      {profile?.name || "User"}
                      {isAdmin && <AdminBadge />}
                    </div>
                    <div
                      className={`text-xs ${
                        profile?.prestigeBadge
                          ? "text-violet-300"
                          : "text-[#f5ff3b]"
                      }`}
                    >
                      {profile?.prestigeBadge || profile?.selectedTitle}
                    </div>
                    {profile?.streakTitle && (
                      <div className="text-xs text-amber-400">
                        <IconFlame size={12} className="mb-0.5 mr-0.5 inline" /> {profile.streakTitle}
                      </div>
                    )}
                  </div>
                </Link>
              )}

              {/* Responsible-play daily net chip (home only) */}
              {isSignedIn &&
                currentPath === "/" &&
                dailyLossLoaded &&
                dailyLoss > DAILY_LOSS_CHIP_THRESHOLD && (
                  <div
                    className="rounded-lg border border-amber-400/40 bg-black/60 px-3 py-2 text-sm font-bold text-amber-300"
                    title="Your net loss today — take it easy"
                  >
                    ▼ {dailyLoss.toLocaleString()} today
                  </div>
                )}

              {/* NAV LINKS */}
              <div className="space-y-2">
                {["/", "/games", "/classement", "/battlepass"].map((path) => (
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
                    href="/settings"
                    onClick={() => setMobileMenuOpen(false)}
                    className="block rounded-lg bg-[#091737] px-3 py-2 text-[#9dd8ff]"
                  >
                    <span className="inline-flex items-center gap-1.5">
                      <IconSettings size={15} className="shrink-0" /> {t("nav.settings")}
                    </span>
                  </Link>
                  <Link
                    href="/upgrade-pro"
                    onClick={() => setMobileMenuOpen(false)}
                    className="block rounded-lg bg-[#091737] px-3 py-2 text-[#9dd8ff]"
                  >
                    <span className="inline-flex items-center gap-1.5">
                      <IconStar size={15} className="shrink-0" /> GRYND PRO
                    </span>
                  </Link>
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

      {/* Global "Prestige unlocked" notice — dismissed once per tier-up. */}
      {prestigeNotice !== null && (
        <div
          role="status"
          aria-live="polite"
          className="fixed right-4 top-24 z-[95] w-[330px] max-w-[calc(100vw-2rem)] rounded-xl border border-violet-400/50 bg-[#0b224f]/95 p-4 shadow-[0_0_40px_rgba(139,92,246,0.45)] backdrop-blur"
        >
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-violet-300/60 bg-violet-500/20 text-lg">
              👑
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-xs uppercase tracking-[0.25em] text-violet-300">
                Prestige {prestigeNotice} unlocked
              </p>
              <p className="mt-0.5 text-sm text-[#9dd8ff]">
                You reached a new permanent Prestige tier. It never resets
                and can never be lost.
              </p>
              <Link
                href="/battlepass"
                onClick={() => setPrestigeNotice(null)}
                className="mt-2 inline-flex rounded-lg border border-[#00e5ff]/50 bg-[#00e5ff]/15 px-3 py-1.5 text-xs font-semibold text-[#00e5ff] transition hover:bg-[#00e5ff]/25"
              >
                View Battlepass
              </Link>
            </div>
            <button
              type="button"
              aria-label="Dismiss"
              onClick={() => setPrestigeNotice(null)}
              className="text-white/50 transition hover:text-white"
            >
              <IconX size={16} />
            </button>
          </div>
        </div>
      )}
    </>
  );
}

export default NavigationBar;
