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
  const [profile, setProfile] = useState({ name: "", profilePicture: "", selectedTitle: "" });
  const [error, setError] = useState(null);
  const [showAddFunds, setShowAddFunds] = useState(false);
  const [langOpen, setLangOpen] = useState(false);
  const [langClosing, setLangClosing] = useState(false);
  const [level, setLevel] = useState(null);

  const navVariant = withReducedMotion(shouldReduceMotion, fadeUp);
  const itemVariant = withReducedMotion(shouldReduceMotion, fadeUp);

  const closeLang = () => {
    setLangClosing(true);
    setLangOpen(false);
    setTimeout(() => setLangClosing(false), 400);
  };

  const isValidDataUrl = (url) => {
    return typeof url === 'string' && url.startsWith('data:image/');
  };

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

  const avatarSrc =
    isValidDataUrl(profile?.profilePicture)
      ? profile.profilePicture
      : (typeof profile?.profilePicture === 'string' && profile.profilePicture.startsWith('http'))
      ? profile.profilePicture
      : (typeof user?.imageUrl === 'string' && user.imageUrl.startsWith('http'))
      ? user.imageUrl
      : "/default-avatar.png";

  const fetchBalance = async ({ includeMeta = true } = {}) => {
    try {
      const token = await getToken({ template: "app_token" });
      if (!token) return setError(t("nav.token_missing"));

      const response = await fetch("/api/get-user-tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
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
            const titlesRes = await fetch("/api/titles", { credentials: "include" });
            const titlesData = await titlesRes.json();
            if (titlesData.success) {
              setProfile((prev) => ({ ...prev, selectedTitle: titlesData.selectedSpecialTitle || titlesData.selectedTitle || "" }));
            }
          } catch {}
        }
      } else if (data.shouldInitialize) {
        const initResponse = await fetch("/api/tokens/initialize", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
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

  const isCasinoPath = currentPath.startsWith("/casino");

  return (
    <>
      <motion.nav initial={navVariant.initial} animate={navVariant.animate} transition={navVariant.transition} data-no-translate="true" className="fixed top-0 left-0 right-0 z-40 border-b border-[#00e5ff]/40 bg-[#050b1e]/95 backdrop-blur-md shadow-[0_0_22px_rgba(0,229,255,0.25)]">
        <UIPro01NavShell className="mx-auto max-w-7xl px-4">
          <div className="flex h-16 items-center justify-between">
            <Link href="/" className="flex items-center space-x-2">
              <Image src={LogoSmiley} alt="GoonBet Logo" width={150} height={60} className="rounded-lg object-contain drop-shadow-[0_0_10px_rgba(245,255,59,0.45)]" />
            </Link>

            <motion.div variants={stagger} initial="initial" animate="animate" className="hidden items-center space-x-4 md:flex">
              {["/", "/sport", "/casino", "/classement"].map((path) => (
                <motion.div key={path} initial={itemVariant.initial} animate={itemVariant.animate} transition={itemVariant.transition} whileHover={shouldReduceMotion ? undefined : hoverScale.whileHover}>
                  <Link
                    href={path}
                    className={`px-3 py-2 text-sm font-medium ${currentPath === path || (path === "/casino" && isCasinoPath) ? "text-[#f5ff3b] drop-shadow-[0_0_8px_rgba(245,255,59,0.6)]" : "text-[#9dd8ff] hover:text-[#00e5ff]"}`}
                  >
                    {t(NAV_TRANSLATION_KEYS[path])}
                  </Link>
                </motion.div>
              ))}
            </motion.div>

            <div className="flex items-center space-x-4">
              <div className="relative">
                <div onClick={() => (langOpen ? closeLang() : setLangOpen(true))} className="cursor-pointer rounded-lg border border-[#00e5ff]/50 bg-[#091737] px-2 py-1 text-sm text-[#c9f7ff] focus:outline-none">
                  {language === "en" && "EN 🇺🇸 🌐"}
                  {language === "fr" && "FR 🇫🇷 🌐"}
                  {language === "es" && "ES 🇪🇸 🌐"}
                </div>

                {(langOpen || langClosing) && (
                  <div className={`absolute right-0 mt-2 w-full ${langOpen ? "animate-parchment" : "animate-parchment-close"}`}>
                    <div className="overflow-hidden rounded-lg border border-[#00e5ff]/50 bg-[#091737] shadow-lg">
                      {[{ value: "en", label: "EN 🇺🇸 🌐" }, { value: "fr", label: "FR 🇫🇷 🌐" }, { value: "es", label: "ES 🇪🇸 🌐" }].map((lang) => (
                        <div key={lang.value} onClick={() => { setLanguage(lang.value); closeLang(); }} className="cursor-pointer px-2 py-1 text-sm text-[#c9f7ff] hover:bg-[#00e5ff]/20">
                          {lang.label}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {isLoaded && isSignedIn ? (
                <>
                  <div className="hidden items-center space-x-4 sm:flex">
                    <Link href="/profil" className="group flex items-center space-x-2">
                      {avatarSrc ? <img src={avatarSrc} alt="profile" className="h-8 w-8 rounded-full border border-[#00e5ff]/50 object-cover transition group-hover:scale-105" /> : <div className="flex h-8 w-8 items-center justify-center rounded-full bg-[#00e5ff] text-xs font-bold text-black">{user?.firstName?.[0] || "U"}</div>}
                      <div className="flex flex-col leading-tight">
                        <span className="text-xs text-[#c9f7ff]">
  {profile?.name || user?.username || user?.firstName || t("nav.user_fallback")}
</span>
                        <span className="text-[10px] text-[#f5ff3b]">{profile?.selectedTitle || "No title equipped"}</span>
                        <span className="text-[10px] text-[#7dd3fc]">{t("nav.level_short")} {level ?? "..."}</span>
                      </div>
                    </Link>
                    <div className="rounded-md border border-[#00e5ff]/50 bg-gradient-to-r from-[#091737] to-[#0e1f4d] px-3 py-1 shadow-[0_0_12px_rgba(0,229,255,0.35)]">
                      <span className="mr-1 text-[10px] uppercase tracking-[0.2em] text-[#7dd3fc]">Tokens</span>
                      <span className="font-mono text-sm font-semibold text-[#67f9ff] drop-shadow-[0_0_8px_rgba(0,229,255,0.65)]">
                        {error ? `${t("nav.error")}: ${error}` : balance !== null ? Number(balance).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : t("nav.loading")}
                      </span>
                    </div>
                  </div>
                  <SignOutButton>
                    <UIPro02NavItem className="rounded-lg border border-[#00e5ff]/40 bg-[#00e5ff]/20 px-4 py-2 text-sm font-medium text-[#d8fbff] hover:bg-[#00e5ff]/35">{t("nav.sign_out")}</UIPro02NavItem>
                  </SignOutButton>
                </>
              ) : (
                <>
                  <UIPro02NavItem href="/sign-up" className="rounded-lg border border-[#FFFF33]/40 bg-[#FFFF33]/20 px-4 py-2 text-sm font-medium text-[#d8fbff] hover:bg-[#FFFF33]/35">{t("nav.create_account")}</UIPro02NavItem>
                  <UIPro02NavItem href="/sign-in" className="rounded-lg border border-[#00e5ff]/40 bg-[#00e5ff]/20 px-4 py-2 text-sm font-medium text-[#d8fbff] hover:bg-[#00e5ff]/35">{t("nav.sign_in")}</UIPro02NavItem>
                </>
              )}
            </div>
          </div>
        </UIPro01NavShell>
      </motion.nav>

      <AddFundsModal isOpen={showAddFunds} onClose={() => setShowAddFunds(false)} onSuccess={setBalance} />
    </>
  );
}

export default NavigationBar;
