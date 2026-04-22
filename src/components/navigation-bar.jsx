"use client";

import React, { useEffect, useState } from "react";
import { useUser, useAuth, SignOutButton } from "@clerk/nextjs";
import { AnimatePresence, motion } from "framer-motion";
import AddFundsModal from "./AddFundsModal";
import LogoSmiley from "../images/logo1.png";
import Image from "next/image";
import Link from "next/link";
import { useLanguage } from "../context/LanguageContext";
import { useTheme } from "../context/ThemeContext";
import { useTranslation } from "../hooks/useTranslation";

const NAV_TRANSLATION_KEYS = {
  "/": "navHome",
  "/sport": "navSport",
  "/casino": "navCasino",
  "/classement": "navClassement",
};

const navListVariants = {
  hidden: {},
  visible: {
    transition: {
      staggerChildren: 0.06,
    },
  },
};

const navItemVariants = {
  hidden: { opacity: 0, y: 4 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.2, ease: "easeOut" } },
};

function NavigationBar({ currentPath }) {
  const { isLoaded, isSignedIn, user } = useUser();
  const { getToken } = useAuth();
  const { language, setLanguage } = useLanguage();
  const { theme, toggleTheme } = useTheme();
  const { t } = useTranslation();
  const [balance, setBalance] = useState(null);
  const [profile, setProfile] = useState({
    name: "",
    profilePicture: "",
    level: 1,
  });

  const [error, setError] = useState(null);
  const [showAddFunds, setShowAddFunds] = useState(false);
  const [langOpen, setLangOpen] = useState(false);
  const [langClosing, setLangClosing] = useState(false);
  const [level, setLevel] = useState(null);

  const closeLang = () => {
    setLangClosing(true);
    setLangOpen(false);

    setTimeout(() => {
      setLangClosing(false);
    }, 400);
  };

  const avatarSrc =
    profile?.profilePicture?.startsWith("data:image")
      ? profile.profilePicture
      : profile?.profilePicture || user?.imageUrl || "/default-avatar.png";

  const fetchBalance = async () => {
    try {
      const token = await getToken({ template: "app_token" });

      if (!token) {
        setError("Token manquant");
        return;
      }

      const response = await fetch("/api/get-user-tokens", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        credentials: "include",
      });

      const data = await response.json();

      if (response.status === 403) {
        setError("Jeton invalide ou expiré.");
        return;
      }

      if (data.success) {
        setBalance(data.data.balance);

        setProfile((prev) => ({
          ...prev,
          profilePicture: data.data.profilePicture || "",
        }));

        try {
          const statsRes = await fetch("/api/user-stats");
          const statsData = await statsRes.json();

          if (statsData.success) {
            setLevel(statsData.stats.currentLevel);
          }
        } catch (e) {
          console.error("Failed to fetch level", e);
        }
      } else if (data.shouldInitialize) {
        const initResponse = await fetch("/api/tokens/initialize", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
        });

        if (initResponse.ok) {
          fetchBalance();
        } else {
          setError("Échec de l'initialisation");
        }
      } else {
        setError(data.error || "Erreur inconnue");
      }
    } catch (err) {
      console.error("Erreur dans fetchBalance:", err);
      setError("Erreur réseau");
    }
  };

  const handleAddFundsSuccess = (newBalance) => {
    setBalance(newBalance);
  };

  useEffect(() => {
    if (isSignedIn) {
      fetchBalance();
    }
  }, [isSignedIn]);

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (!e.target.closest(".relative")) {
        setLangOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const isCasinoPath = currentPath.startsWith("/casino");

  return (
    <>
      <nav
        data-no-translate="true"
        className="fixed left-0 right-0 top-0 z-40 border-b border-[#00e5ff]/40 bg-[#050b1e]/95 backdrop-blur-md shadow-[0_0_22px_rgba(0,229,255,0.25)]"
      >
        <div className="mx-auto max-w-7xl px-4">
          <div className="flex h-16 items-center justify-between">
            <Link href="/" className="flex items-center space-x-2">
              <Image
                src={LogoSmiley}
                alt="GoonBet Logo"
                width={150}
                height={60}
                className="rounded-lg object-contain drop-shadow-[0_0_10px_rgba(245,255,59,0.45)]"
              />
            </Link>

            <motion.div
              variants={navListVariants}
              initial="hidden"
              animate="visible"
              className="hidden items-center space-x-4 md:flex"
            >
              {["/", "/sport", "/casino", "/classement"].map((path) => (
                <motion.div key={path} variants={navItemVariants}>
                  <motion.div whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }}>
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
                </motion.div>
              ))}
            </motion.div>

            <div className="flex items-center space-x-4">
              <div className="relative">
                <motion.div
                  onClick={() => {
                    if (langOpen) {
                      closeLang();
                    } else {
                      setLangOpen(true);
                    }
                  }}
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                  className="cursor-pointer rounded-lg border border-[#00e5ff]/50 bg-[#091737] px-2 py-1 text-sm text-[#c9f7ff] focus:outline-none"
                >
                  {language === "en" && "EN 🇺🇸 🌐"}
                  {language === "fr" && "FR 🇫🇷 🌐"}
                  {language === "es" && "ES 🇪🇸 🌐"}
                </motion.div>

                <AnimatePresence>
                  {(langOpen || langClosing) && (
                    <motion.div
                      initial={{ opacity: 0, y: -6, scale: 0.98 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={{ opacity: 0, y: -6, scale: 0.98 }}
                      transition={{ duration: 0.18, ease: "easeOut" }}
                      className="absolute right-0 mt-2 w-full"
                    >
                      <div className="overflow-hidden rounded-lg border border-[#00e5ff]/50 bg-[#091737] shadow-lg">
                        {[
                          { value: "en", label: "EN 🇺🇸 🌐" },
                          { value: "fr", label: "FR 🇫🇷 🌐" },
                          { value: "es", label: "ES 🇪🇸 🌐" },
                        ].map((lang) => (
                          <motion.div
                            key={lang.value}
                            onClick={() => {
                              setLanguage(lang.value);
                              closeLang();
                            }}
                            whileHover={{ scale: 1.02 }}
                            whileTap={{ scale: 0.98 }}
                            className="cursor-pointer px-2 py-1 text-sm text-[#c9f7ff] hover:bg-[#00e5ff]/20"
                          >
                            {lang.label}
                          </motion.div>
                        ))}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>

              {isLoaded && isSignedIn ? (
                <>
                  <div className="hidden items-center space-x-4 sm:flex">
                    <motion.div whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }}>
                      <Link href="/profil" className="group flex items-center space-x-2">
                        {avatarSrc ? (
                          <img
                            src={avatarSrc}
                            alt="profile"
                            className="h-8 w-8 rounded-full border border-[#00e5ff]/50 object-cover group-hover:scale-105 transition"
                          />
                        ) : (
                          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-[#00e5ff] text-xs font-bold text-black">
                            {user?.firstName?.[0] || "U"}
                          </div>
                        )}
                        <div className="flex flex-col leading-tight">
                          <span className="text-xs text-[#c9f7ff]">{user?.username || user?.firstName || "User"}</span>
                          <span className="text-[10px] text-[#f5ff3b]">LVL {level ?? "..."}</span>
                        </div>
                      </Link>
                    </motion.div>

                    <span className="text-[#00e5ff]">
                      {error ? `${t("navError")}: ${error}` : balance !== null ? `$${balance}` : t("navLoading")}
                    </span>
                  </div>
                  <SignOutButton>
                    <motion.button
                      whileHover={{ scale: 1.02 }}
                      whileTap={{ scale: 0.98 }}
                      className="rounded-lg border border-[#00e5ff]/40 bg-[#00e5ff]/20 px-4 py-2 text-sm font-medium text-[#d8fbff] hover:bg-[#00e5ff]/35"
                    >
                      {t("navSignOut")}
                    </motion.button>
                  </SignOutButton>
                </>
              ) : (
                <>
                  <motion.div whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }}>
                    <Link
                      href="/sign-up"
                      className="rounded-lg border border-[#FFFF33]/40 bg-[#FFFF33]/20 px-4 py-2 text-sm font-medium text-[#d8fbff] hover:bg-[#FFFF33]/35"
                    >
                      {t("navCreateAccount")}
                    </Link>
                  </motion.div>
                  <motion.div whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }}>
                    <Link
                      href="/sign-in"
                      className="rounded-lg border border-[#00e5ff]/40 bg-[#00e5ff]/20 px-4 py-2 text-sm font-medium text-[#d8fbff] hover:bg-[#00e5ff]/35"
                    >
                      {t("navSignIn")}
                    </Link>
                  </motion.div>
                </>
              )}
            </div>
          </div>
        </div>
      </nav>

      <AddFundsModal
        isOpen={showAddFunds}
        onClose={() => setShowAddFunds(false)}
        onSuccess={handleAddFundsSuccess}
      />
    </>
  );
}

export default NavigationBar;
