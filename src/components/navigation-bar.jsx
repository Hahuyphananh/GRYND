"use client";
import React, { useEffect, useState } from "react";
import { useUser, useAuth, SignOutButton } from "@clerk/nextjs";
import { motion, useReducedMotion } from "framer-motion";
import AddFundsModal from "./AddFundsModal";
import LogoSmiley from "../images/logo1.png";
import Image from "next/image";
import Link from "next/link";
import { useLanguage } from "../context/LanguageContext";
import { useTheme } from "../context/ThemeContext";
import { useTranslation } from "../hooks/useTranslation";
import { fadeUp, hoverScale, withReducedMotion, stagger } from "../lib/animations";
import { UIPro01NavShell, UIPro02NavItem } from "./uipro";
import useInstallPWA from "../hooks/useInstallPWA";

const NAV_TRANSLATION_KEYS = {
  "/": "nav.home",
  "/sport": "nav.sport",
  "/casino": "nav.casino",
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
  });
  const [error, setError] = useState(null);
  const [showAddFunds, setShowAddFunds] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  useEffect(() => {
    if (mobileMenuOpen) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }

    return () => {
      document.body.style.overflow = "";
    };
  }, [mobileMenuOpen]);
  const [langOpen, setLangOpen] = useState(false);
  const [langClosing, setLangClosing] = useState(false);
  const [level, setLevel] = useState(null);

  const navVariant = withReducedMotion(shouldReduceMotion, fadeUp);
  const itemVariant = withReducedMotion(shouldReduceMotion, fadeUp);
  const { canInstall, install } = useInstallPWA();

  const closeLang = () => {
    setLangClosing(true);
    setLangOpen(false);
    setTimeout(() => setLangClosing(false), 400);
  };

  const isValidDataUrl = (url) => {
    return typeof url === "string" && url.startsWith("data:image/");
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

  const avatarSrc = isValidDataUrl(profile?.profilePicture)
    ? profile.profilePicture
    : typeof profile?.profilePicture === "string" && profile.profilePicture.startsWith("http")
      ? profile.profilePicture
      : typeof user?.imageUrl === "string" && user.imageUrl.startsWith("http")
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
        setBalance(data.data.balance);
        setProfile((prev) => ({
          ...prev,
          name: data.data.name || "", // ✅ ADD THIS LINE
          profilePicture: data.data.profilePicture || "",
        }));
        if (includeMeta) {
          try {
            const statsRes = await fetch("/api/user-stats");
            const statsData = await statsRes.json();
            if (statsData.success) setLevel(statsData.stats.currentLevel);
          } catch {}

          try {
            const titlesRes = await fetch("/api/titles", {
              credentials: "include",
            });
            const titlesData = await titlesRes.json();
            if (titlesData.success) {
              setProfile((prev) => ({
                ...prev,
                selectedTitle: titlesData.selectedSpecialTitle || titlesData.selectedTitle || "",
              }));
            }
          } catch {}
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
            const shouldRefresh = confirm("A new version of GoonBet is available. Refresh now?");

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

  const isCasinoPath = currentPath.startsWith("/casino");

return (
  <>
    <div className="fixed top-0 left-0 right-0 z-[2147483647]">
      <motion.nav
        initial={navVariant.initial}
        animate={navVariant.animate}
        transition={navVariant.transition}
        className="
          border-b border-[#00e5ff]/40
          bg-[#050b1e]/95
          backdrop-blur-md
          shadow-[0_0_22px_rgba(0,229,255,0.25)]
          supports-[padding:max(0px)]:pt-[env(safe-area-inset-top)]
        "
      >
        <UIPro01NavShell className="mx-auto max-w-7xl px-3 sm:px-4 pt-[env(safe-area-inset-top)]">
          <div className="flex h-[68px] sm:h-16 items-center justify-between gap-2">

            <Link href="/" className="flex items-center space-x-2">
              <Image
                src={LogoSmiley}
                alt="GoonBet Logo"
                width={150}
                height={60}
                className="h-auto w-[120px] rounded-lg object-contain drop-shadow-[0_0_10px_rgba(245,255,59,0.45)] sm:w-[150px]"
              />
            </Link>

            <motion.div
              variants={stagger}
              initial="initial"
              animate="animate"
              className="hidden items-center space-x-4 md:flex"
            >
              {["/", "/sport", "/casino", "/classement"].map((path) => (
                <motion.div
                  key={path}
                  initial={itemVariant.initial}
                  animate={itemVariant.animate}
                  transition={itemVariant.transition}
                  whileHover={shouldReduceMotion ? undefined : hoverScale.whileHover}
                >
                  <Link
                    href={path}
                    className={`px-3 py-2 text-sm font-medium ${
                      currentPath === path || (path === "/casino" && isCasinoPath)
                        ? "text-[#f5ff3b] drop-shadow-[0_0_8px_rgba(245,255,59,0.6)]"
                        : "text-[#9dd8ff] hover:text-[#00e5ff]"
                    }`}
                  >
                    {t(NAV_TRANSLATION_KEYS[path])}
                  </Link>
                </motion.div>
              ))}
            </motion.div>

            <div className="flex items-center gap-2 sm:gap-4">

              {canInstall && (
                <button
                  onClick={install}
                  className="hidden sm:inline-flex items-center rounded-lg border border-[#f5ff3b]/40 bg-[#f5ff3b]/10 px-3 py-1 text-xs font-medium text-[#f5ff3b] hover:bg-[#f5ff3b]/20"
                >
                  📲 Install App
                </button>
              )}

              {/* LANGUAGE */}
              <div className="relative">
                <div
                  onClick={() => (langOpen ? closeLang() : setLangOpen(true))}
                  className="cursor-pointer rounded-lg border border-[#00e5ff]/50 bg-[#091737] px-2 py-1 text-xs text-[#c9f7ff] sm:text-sm"
                >
                  {language === "en" && "EN 🇺🇸 🌐"}
                  {language === "fr" && "FR 🇫🇷 🌐"}
                  {language === "es" && "ES 🇪🇸 🌐"}
                </div>

                {(langOpen || langClosing) && (
                  <div
                    className={`absolute right-0 mt-2 w-full ${
                      langOpen ? "animate-parchment" : "animate-parchment-close"
                    }`}
                  >
                    <div className="overflow-hidden rounded-lg border border-[#00e5ff]/50 bg-[#091737] shadow-lg">
                      {[
                        { value: "en", label: "EN 🇺🇸 🌐" },
                        { value: "fr", label: "FR 🇫🇷 🌐" },
                        { value: "es", label: "ES 🇪🇸 🌐" },
                      ].map((lang) => (
                        <div
                          key={lang.value}
                          onClick={() => {
                            setLanguage(lang.value);
                            closeLang();
                          }}
                          className="cursor-pointer px-2 py-1 text-sm text-[#c9f7ff] hover:bg-[#00e5ff]/20"
                        >
                          {lang.label}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* AUTH SECTION */}
              {isLoaded && isSignedIn ? (
                <>
                  <div className="hidden items-center space-x-4 lg:flex">
                    <Link href="/profil" className="group flex items-center space-x-2">
                      <img
                        src={avatarSrc}
                        alt="profile"
                        className="h-8 w-8 rounded-full border border-[#00e5ff]/50 object-cover"
                      />
                    </Link>
                  </div>

                  <button
                    onClick={() => setMobileMenuOpen((v) => !v)}
                    className="inline-flex h-10 w-10 items-center justify-center rounded-lg border border-[#00e5ff]/40 bg-[#00e5ff]/10 text-[#d8fbff] lg:hidden"
                  >
                    ☰
                  </button>

                  <SignOutButton>
                    <UIPro02NavItem className="rounded-lg border border-[#00e5ff]/40 bg-[#00e5ff]/20 px-4 py-2 text-sm text-[#d8fbff]">
                      {t("nav.sign_out")}
                    </UIPro02NavItem>
                  </SignOutButton>
                </>
              ) : (
                <>
                  <button
                    onClick={() => setMobileMenuOpen((v) => !v)}
                    className="inline-flex h-10 w-10 items-center justify-center rounded-lg border border-[#00e5ff]/40 bg-[#00e5ff]/10 text-[#d8fbff] md:hidden"
                  >
                    ☰
                  </button>
                </>
              )}

            </div>
          </div>
        </UIPro01NavShell>

        {/* MOBILE MENU */}
        {mobileMenuOpen && (
          <div className="fixed top-0 left-0 z-[2147483647] h-full w-full pointer-events-none">
            <div className="absolute left-0 top-0 h-full w-[82vw] max-w-72 bg-[#08142f] p-4 pointer-events-auto">
              <button onClick={() => setMobileMenuOpen(false)} className="text-[#f5ff3b]">
                ✕ Close
              </button>
            </div>
            <div className="absolute inset-0" onClick={() => setMobileMenuOpen(false)} />
          </div>
        )}
      </motion.nav>

      <AddFundsModal
        isOpen={showAddFunds}
        onClose={() => setShowAddFunds(false)}
        onSuccess={setBalance}
      />
    </div>
  </>
);
}

export default NavigationBar;
