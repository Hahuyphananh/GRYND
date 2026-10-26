"use client";
import React, { useEffect, useRef, useState } from "react";
import { useUser } from "@clerk/nextjs";
import { SignOutButton } from "./SignOutButton";
import { motion, useReducedMotion } from "framer-motion";
import Link from "next/link";
import ThemeToggle from "./ThemeToggle";
import { useTranslation } from "../hooks/useTranslation";
import { fadeUp, hoverScale, withReducedMotion, stagger } from "../lib/animations";
import { UIPro01NavShell, UIPro02NavItem } from "./uipro";
import useInstallPWA from "../hooks/useInstallPWA";
import AdminBadge from "./AdminBadge";
import QuestNavBadge from "./QuestNavBadge";
import { IconCoins, IconDeviceMobile, IconFlame, IconGift, IconMenu, IconSettings, IconStar, IconTrophy, IconX } from "@tabler/icons-react";
import FrameAvatar from "./FrameAvatar";
import { cosmeticEffectClass } from "../lib/profileCosmetics";
import useDailyLoss from "../lib/useDailyLoss";
import { DAILY_LOSS_CHIP_THRESHOLD } from "../lib/games/economy";
import { COIN_BALANCE_EVENT } from "../hooks/useCoinBalance";
import { fetchDeduped } from "../lib/dedupeFetch";

// M1: sessionStorage TTL for the nav's equipped-title meta. Titles are
// slow-changing, so short-circuiting the /api/titles lookup for a few minutes
// after each successful fetch saves a network round-trip on every navigation
// without changing any displayed value — the same pattern the is-admin cache
// already uses.
const NAV_META_TTL_MS = 5 * 60 * 1000;




const NAV_TRANSLATION_KEYS = {
  "/": "nav.home",
  "/games": "nav.casino",
  "/classement": "nav.leaderboard",
  "/contact": "nav.contact",
  "/faq": "nav.faq",
  "/rewards": "nav.rewards",
};

// The one primary nav link that carries a glyph, keyed by its path. Rewards is
// drawn with a gift icon from the project's existing Tabler set so it reads as
// the rewards surface; every other primary link stays text-only, exactly as
// before. The map is empty for those paths, so nothing about them changes.
const NAV_ICONS = { "/rewards": <IconGift size={15} className="shrink-0" /> };

function NavigationBar({ currentPath = "" }) {
  const { isLoaded, isSignedIn, user } = useUser();
  const { t } = useTranslation();
  const shouldReduceMotion = useReducedMotion();
  // Today's net (responsible-play) chip — rendered on the home page (mobile
  // menu) only, so it never duplicates the fixed lobby chip (DailyLossGuard).
  const { loss: dailyLoss, loaded: dailyLossLoaded } = useDailyLoss();
  const [profile, setProfile] = useState(() => {
    // Seed the chip's two numbers from the last known values so a fresh mount
    // (the navbar remounts on every navigation) does NOT replay the change
    // animation when nothing actually moved. Only a real change animates, and
    // a returning player sees their own numbers immediately instead of a dash.
    let totalTrophies = 0;
    // `null` = "balance not known yet", which is deliberately NOT 0: a coin
    // total of 0 and "we haven't read the wallet" are different claims.
    let balance = null;
    try {
      const raw = sessionStorage.getItem("nav-trophies");
      if (raw) {
        const cached = JSON.parse(raw);
        const trophies = Number(cached?.totalTrophies);
        // Every player starts at 0 trophies, so 0 is a real displayable value.
        totalTrophies = Number.isFinite(trophies) && trophies >= 0 ? trophies : 0;
        const coins = Number(cached?.balance);
        balance = Number.isFinite(coins) && coins >= 0 ? coins : null;
      }
    } catch {
      // sessionStorage unavailable (SSR / private mode) — start at 0 / unknown.
    }
    return {
      name: "",
      selectedIcon: "",
      // Equipped profile frame (token-shop `profile_frame`), or null.
      profileFrame: null,
      usernameEffect: null,
      // Equipped NAME GLOW (a catalog cosmetic) — the catalog hex this
      // display name is coloured + haloed with, or null for none. Comes from
      // the `glowColor` field of /api/get-user-tokens (the glow row joined on
      // `users.selectedGlow`), not from `nameColor`.
      glowColor: null,
      selectedTitle: "",
      streakTitle: null,
      // TOTAL TROPHIES — the server-computed sum of the player's per-game
      // trophy counts (see src/lib/trophies.js / trophyStore.js). This is the
      // headline competitive number in the navbar (it replaced Overall Elo
      // there). Everyone starts at 0, so 0 is shown rather than a placeholder.
      totalTrophies,
      // COIN BALANCE — the player's spendable coins, rendered UNDER the trophy
      // total. It is the same wallet every other surface reads (the lobby
      // wager pickers via useCoinBalance, /rewards, the energy grant), never a
      // second currency: /api/get-user-tokens is the one source, and null means
      // "not read yet" rather than 0.
      balance,
    };
  });
  // Whether the chip has finished its first paint. The first render must not
  // animate (it is just the cached/initial value); only later changes do.
  const trophyFirstPaint = useRef(true);
  useEffect(() => {
    trophyFirstPaint.current = false;
  }, []);
  const [, setError] = useState(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
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
      // Shares one in-flight /api/titles response with the profile's loaders
      // (and with the includeMeta read in fetchBalance) when they land in the
      // same tick. No TTL cache here: an equip must still revalidate.
      const { data: titlesData } = await fetchDeduped("/api/titles", {
        credentials: "include",
      });
      if (!titlesData.success) return;
      setProfile((prev) => ({
        ...prev,
        selectedTitle:
          titlesData.selectedSpecialTitle ||
          titlesData.selectedTitle ||
          "",
        streakTitle: titlesData.streakTitle || null,
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
    // A credit the client already knows about — the daily reward claim, for
    // one — announces itself through this event, so the coin number under the
    // trophies re-reads instead of showing the pre-claim amount until the next
    // navigation. Shares the metadata-free read above: the wallet answer is
    // what changed, and re-fetching the title meta would be waste.
    const balanceHandler = () => fetchBalance({ includeMeta: false });

    window.addEventListener("profileUpdated", handler);
    window.addEventListener("titleUpdated", titleHandler);
    window.addEventListener(COIN_BALANCE_EVENT, balanceHandler);
    return () => {
      window.removeEventListener("profileUpdated", handler);
      window.removeEventListener("titleUpdated", titleHandler);
      window.removeEventListener(COIN_BALANCE_EVENT, balanceHandler);
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
      // The profile reads this same endpoint on mount with the SAME init, so
      // a cold page load makes one request instead of two. The init is
      // intentionally byte-identical to PageClient's loadProfileData — the
      // dedupe key is url + JSON.stringify(init), including key order.
      const { response, data } = await fetchDeduped("/api/get-user-tokens", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        credentials: "include",
      });

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
            // TOTAL TROPHIES (server-computed sum of per-game counts). A
            // missing/invalid value degrades to 0 — everyone starts at 0.
            totalTrophies: (() => {
              const n = Number(data.data.totalTrophies);
              return Number.isFinite(n) && n >= 0 ? n : 0;
            })(),
            // COIN BALANCE, from the same payload (the wallet is what this
            // endpoint exists to report). An unreadable value stays null — the
            // chip shows a dash rather than claiming the player has 0 coins.
            balance: (() => {
              const n = Number(data.data.balance);
              return Number.isFinite(n) && n >= 0 ? n : null;
            })(),
          }));
        // Remember the last known numbers so the next mount starts from them
        // and the chip only animates on a real change (see the state
        // initializer). The key keeps its historical name — it is the nav
        // chip's cache, and it now carries both displayed numbers.
        try {
          sessionStorage.setItem(
            "nav-trophies",
            JSON.stringify({
              totalTrophies: Number(data.data.totalTrophies) || 0,
              balance: (() => {
                const n = Number(data.data.balance);
                return Number.isFinite(n) && n >= 0 ? n : null;
              })(),
            }),
          );
        } catch {}
        if (includeMeta) {
          // Cache the equipped title in sessionStorage (short TTL) so a hard
          // reload does not re-fire the nav's meta call (/api/titles reads the
          // equipped title). Titles are slow-changing; the same few-minutes
          // staleness applies as with the is-admin cache held in
          // sessionStorage. On a stale/missing cache we fetch fresh and
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
                if (meta && typeof meta.selectedTitle === "string")
                  setProfile((prev) => ({
                    ...prev,
                    selectedTitle: meta.selectedTitle,
                    streakTitle: meta.streakTitle ?? prev.streakTitle,
                  }));
              }
            } catch {}
          } else {
            let nextTitle = "";
            let nextStreak = null;
            try {
              const { data: titlesData } = await fetchDeduped("/api/titles", {
                credentials: "include",
              });
              if (titlesData.success) {
                nextTitle =
                  titlesData.selectedSpecialTitle ||
                  titlesData.selectedTitle ||
                  "";
                nextStreak = titlesData.streakTitle || null;
              }
            } catch {}

            setProfile((prev) => ({
              ...prev,
              // Empty string means "no title equipped" — never fall back
              // to the previous title, or unequipping would never clear.
              selectedTitle: nextTitle,
              streakTitle: nextStreak,
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
                  selectedTitle: nextTitle,
                  streakTitle: nextStreak,
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
    // Deploy check: one HEAD request per 10 minutes, skipped entirely while
    // the tab is hidden (no need to poll for a new version in the
    // background — the check resumes when the tab is visible again). The
    // request is a full server round-trip, so the cadence is the cost knob
    // here; ten minutes still surfaces a new deploy well before a player
    // would notice anything stale.
    const interval = setInterval(
      async () => {
        if (document.visibilityState !== "visible") return;
        try {
          // HEAD the tiny STATIC /api/version payload, never the current page:
          // a HEAD to the page itself re-runs its full server render (the root
          // layout is `force-dynamic`) just to read an ETag.
          const response = await fetch("/api/version", {
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
      1000 * 60 * 10
    );

    return () => clearInterval(interval);
  }, []);

  const isCasinoPath =
    currentPath.startsWith("/casino") || currentPath.startsWith("/games");

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

            {/* Tighter gaps/padding up to `lg`, then the original ones: this row
                is visible from md, where the logo + every link + the account
                cluster have never fitted, and the /faq link must not be what
                pushes the account buttons further off a 768px screen. From lg
                the row has room again, so it is pixel-identical there. */}
            <motion.div
              variants={stagger}
              initial="initial"
              animate="animate"
              className="hidden items-center space-x-1 md:flex lg:space-x-4"
            >
              {["/", "/games", "/classement", "/rewards", "/contact", "/faq"].map((path) => (
                <motion.div
                  key={path}
                  initial={itemVariant.initial}
                  animate={itemVariant.animate}
                  transition={itemVariant.transition}
                  whileHover={shouldReduceMotion ? undefined : hoverScale.whileHover}
                >
                  <Link
                    href={path}
                    className={`px-1 py-2 text-sm font-medium rounded lg:px-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff] focus-visible:ring-offset-2 focus-visible:ring-offset-[#050b1e] ${currentPath === path || (path === "/games" && isCasinoPath) ? "text-[#f5ff3b] drop-shadow-[0_0_8px_rgba(245,255,59,0.6)]" : "text-[#9dd8ff] hover:text-[#00e5ff]"}`}
                  >
                    {/* Only Rewards carries a glyph. Links without one render
                        their label exactly as before (a bare text node) — the
                        conditional wrapper means adding the icon did not shift
                        any existing link by even a space. */}
                    {NAV_ICONS[path] ? (
                      <span className="inline-flex items-center gap-1.5">
                        {NAV_ICONS[path]} {t(NAV_TRANSLATION_KEYS[path])}
                      </span>
                    ) : path === "/games" ? (
                      // The hub link is where a player picks what to play next,
                      // so it is the one nav entry that flags claimable quests.
                      <span className="inline-flex items-center gap-1.5">
                        {t(NAV_TRANSLATION_KEYS[path])} <QuestNavBadge />
                      </span>
                    ) : (
                      t(NAV_TRANSLATION_KEYS[path])
                    )}
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
                  className={`px-1 py-2 text-sm font-medium rounded lg:px-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff] focus-visible:ring-offset-2 focus-visible:ring-offset-[#050b1e] ${currentPath === "/settings" ? "text-[#f5ff3b] drop-shadow-[0_0_8px_rgba(245,255,59,0.6)]" : "text-[#9dd8ff] hover:text-[#00e5ff]"}`}
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
              {/* Light/dark switch — one control, in both the signed-in and
                  signed-out clusters, so the theme is always reachable. */}
              <ThemeToggle />
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
                  {/* Total trophies over the coin balance — this chip is where
                      the token balance has always lived (the trophies took the
                      headline spot), so the two numbers a player checks most
                      share one card: the competitive total on top, the wallet
                      that every wager reads directly beneath it. The trophies
                      are server-computed (sum of per-game counts) and everyone
                      starts at 0; the coins come from the same
                      /api/get-user-tokens payload and show a dash until the
                      wallet has actually been read. */}
                  <Link
                    href="/profil"
                    data-testid="nav-trophies"
                    className="hidden items-center gap-2 rounded-lg border border-[#f5ff3b]/40 bg-[#f5ff3b]/10 px-3 py-1.5 transition-colors hover:bg-[#f5ff3b]/20 lg:flex"
                    title="Your total trophies, with your coin balance underneath"
                  >
                    <IconTrophy size={15} className="shrink-0 text-[#f5ff3b]" />
                    <span className="flex flex-col leading-tight">
                      <span className="flex items-baseline gap-1">
                        {/* keyed on the total so a change remounts the span and
                            replays the pop-in; the ref suppresses the very
                            first paint so cached values don't animate. */}
                        <motion.span
                          key={profile.totalTrophies}
                          initial={
                            trophyFirstPaint.current || shouldReduceMotion
                              ? false
                              : { opacity: 0, y: -4, scale: 0.9 }
                          }
                          animate={{ opacity: 1, y: 0, scale: 1 }}
                          transition={{ duration: 0.3, ease: "easeOut" }}
                          className="text-sm font-semibold text-[#f5ff3b]"
                        >
                          {Number(profile.totalTrophies || 0).toLocaleString()}
                        </motion.span>
                        <span className="text-[10px] uppercase tracking-wider text-[#f5ff3b]/70">
                          Trophies
                        </span>
                      </span>
                      <span
                        data-testid="nav-coins"
                        className="flex items-center gap-1 text-[11px] font-semibold text-[#ffd700]"
                      >
                        <IconCoins size={12} className="shrink-0" aria-hidden="true" />
                        {profile.balance === null
                          ? "—"
                          : Number(profile.balance).toLocaleString()}
                        <span className="text-[9px] uppercase tracking-wider text-[#ffd700]/70">
                          Coins
                        </span>
                      </span>
                    </span>
                  </Link>
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
                        <span className="text-[10px] text-[#f5ff3b]">
                          {profile?.selectedTitle || "No title equipped"}
                        </span>
                        {profile?.streakTitle && (
                          <span className="text-[10px] text-amber-400">
                            <IconFlame size={12} className="mb-0.5 mr-0.5 inline" /> {profile.streakTitle}
                          </span>
                        )}
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
                  {isAdmin && (
                    <Link
                      href="/admin"
                      className="rounded-lg border border-[#f5ff3b]/60 bg-[#f5ff3b]/10 px-3 py-2 text-sm font-semibold text-[#f5ff3b] transition-colors hover:bg-[#f5ff3b]/20"
                    >
                      Admin
                    </Link>
                  )}
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
                    <div className="text-xs text-[#f5ff3b]">
                      {profile?.selectedTitle}
                    </div>
                    {profile?.streakTitle && (
                      <div className="text-xs text-amber-400">
                        <IconFlame size={12} className="mb-0.5 mr-0.5 inline" /> {profile.streakTitle}
                      </div>
                    )}
                    <div className="text-xs text-[#f5ff3b]" data-testid="nav-trophies-mobile">
                      <IconTrophy size={12} className="mb-0.5 mr-0.5 inline" />{" "}
                      {`${Number(profile.totalTrophies || 0).toLocaleString()} Trophies`}
                    </div>
                    {/* The coin balance, directly under the trophies — the same
                        pair the desktop chip shows. A dash means the wallet has
                        not been read yet, never a fabricated 0. */}
                    <div className="text-xs text-[#ffd700]" data-testid="nav-coins-mobile">
                      <IconCoins size={12} className="mb-0.5 mr-0.5 inline" aria-hidden="true" />{" "}
                      {`${
                        profile.balance === null
                          ? "—"
                          : Number(profile.balance).toLocaleString()
                      } Coins`}
                    </div>
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
                {isAdmin && (
                  <Link
                    href="/admin"
                    onClick={() => setMobileMenuOpen(false)}
                    className="block rounded-lg border border-[#f5ff3b]/60 bg-[#f5ff3b]/10 px-3 py-2 font-semibold text-[#f5ff3b]"
                  >
                    Admin dashboard
                  </Link>
                )}
                {["/", "/games", "/classement", "/rewards", "/contact", "/faq"].map((path) => (
                  <Link
                    key={path}
                    href={path}
                    onClick={() => setMobileMenuOpen(false)}
                    className="block rounded-lg bg-[#091737] px-3 py-2 text-[#9dd8ff]"
                  >
                    {NAV_ICONS[path] ? (
                      <span className="inline-flex items-center gap-1.5">
                        {NAV_ICONS[path]} {t(NAV_TRANSLATION_KEYS[path])}
                      </span>
                    ) : path === "/games" ? (
                      <span className="inline-flex items-center gap-1.5">
                        {t(NAV_TRANSLATION_KEYS[path])} <QuestNavBadge />
                      </span>
                    ) : (
                      t(NAV_TRANSLATION_KEYS[path])
                    )}
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
                {/* The same switch, as a labelled row — an icon-only button
                    would be the only unlabelled control in this menu. */}
                <ThemeToggle
                  showLabel
                  className="flex w-full items-center rounded-lg bg-[#091737] px-3 py-2 text-[#9dd8ff] transition-colors hover:text-[#00e5ff] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff]"
                />
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

    </>
  );
}

export default NavigationBar;
