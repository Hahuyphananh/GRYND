"use client";
import React, { useEffect, useState } from "react";
import { useUser, useAuth, SignOutButton } from '@clerk/nextjs';
import AddFundsModal from './AddFundsModal';
import LogoSmiley from "../images/logo1.png"; // Adjust the path if needed
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

function NavigationBar({ currentPath }) {
  const { isLoaded, isSignedIn } = useUser();
  const { getToken } = useAuth();
  const { language, setLanguage } = useLanguage();
  const { theme, toggleTheme } = useTheme();
  const { t } = useTranslation();
  const [balance, setBalance] = useState(null);
  const [error, setError] = useState(null);
  const [showAddFunds, setShowAddFunds] = useState(false);

  const fetchBalance = async () => {
    try {
      const token = await getToken({ template: 'app_token' });

      if (!token) {
        console.error("Token JWT manquant.");
        setError("Token manquant");
        return;
      }

      const response = await fetch("/api/get-user-tokens", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`,
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
      } else if (data.shouldInitialize) {
        const initResponse = await fetch("/api/tokens/initialize", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${token}`,
          },
        });

        if (initResponse.ok) {
          fetchBalance(); // Retry
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

  const isCasinoPath = currentPath.startsWith("/casino");

  return (
    <>
      <nav data-no-translate="true" className="fixed top-0 left-0 right-0 z-40 border-b border-[#00e5ff]/40 bg-[#050b1e]/95 backdrop-blur-md shadow-[0_0_22px_rgba(0,229,255,0.25)]">
        <div className="mx-auto max-w-7xl px-4">
          <div className="flex h-16 items-center justify-between">
          <Link href="/" className="flex items-center space-x-2">
 <Image
  src={LogoSmiley}
  alt="GoonBet Logo"
  width={150}
  height={60}
  className="rounded-lg object-contain drop-shadow-[0_0_10px_rgba(57,255,20,0.45)]"
/>
    </Link>

            <div className="hidden md:flex items-center space-x-4">
              {["/", "/sport", "/casino", "/classement"].map((path) => (
                <Link
                  key={path}
                  href={path}
                  className={`px-3 py-2 text-sm font-medium ${
                    currentPath === path || (path === "/casino" && isCasinoPath)
                      ? "text-[#f5ff3b] drop-shadow-[0_0_8px_rgba(245,255,59,0.6)]"
                      : "text-[#9dd8ff] hover:text-[#00e5ff]"
                  }`}
                >
                  {t(NAV_TRANSLATION_KEYS[path])}
                </Link>
              ))}
            </div>

            <div className="flex items-center space-x-4">
              <select
                aria-label="Language selector"
                value={language}
                onChange={(event) => setLanguage(event.target.value)}
                className="rounded-lg border border-[#00e5ff]/50 bg-[#091737] px-2 py-1 text-sm text-[#c9f7ff] focus:outline-none"
              >
                <option value="en">EN 🇺🇸</option>
                <option value="fr">FR 🇫🇷</option>
                <option value="es">ES 🇪🇸</option>
              </select>

              <button
                type="button"
                onClick={toggleTheme}
                className="rounded-lg border border-[#39ff14]/40 bg-[#39ff14]/20 px-2 py-1 text-sm font-medium text-[#d9ffe2] hover:bg-[#39ff14]/35"
                aria-label="Theme toggle"
                title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
              >
                {theme === "dark" ? "☀️" : "🌙"}
              </button>

              {isLoaded && isSignedIn ? (
                <>
                  <div className="hidden sm:flex items-center space-x-4">
                    <span className="text-[#00e5ff]">
                      {error
                        ? `${t("navError")}: ${error}`
                        : balance !== null
                        ? `$${balance}`
                        : t("navLoading")}
                    </span>
                    <Link
                      href="/profil"
                      className={`px-3 py-2 text-sm font-medium ${
                        currentPath === "/profil"
                          ? "text-[#f5ff3b]"
                          : "text-[#c9f7ff] hover:text-[#00e5ff]"
                      }`}
                    >
                      {t("navProfile")}
                    </Link>
                  </div>
                  <SignOutButton>
                    <button className="rounded-lg border border-[#00e5ff]/40 bg-[#00e5ff]/20 px-4 py-2 text-sm font-medium text-[#d8fbff] hover:bg-[#00e5ff]/35">
                      {t("navSignOut")}
                    </button>
                  </SignOutButton>
                </>
              ) : (
                <><Link
                    href="/sign-up"
                    className="rounded-lg border border-[#39ff14]/40 bg-[#39ff14]/20 px-4 py-2 text-sm font-medium text-[#e6ffef] hover:bg-[#39ff14]/35"
                  >
                    {t("navCreateAccount")}
                  </Link><Link
                    href="/sign-in"
                    className="rounded-lg border border-[#00e5ff]/40 bg-[#00e5ff]/20 px-4 py-2 text-sm font-medium text-[#d8fbff] hover:bg-[#00e5ff]/35"
                  >
                      {t("navSignIn")}
                    </Link></>
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
