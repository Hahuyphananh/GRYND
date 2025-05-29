"use client";

import React, { useEffect, useState } from "react";
import { useUser, SignOutButton } from "@clerk/nextjs";
import Link from "next/link";

function NavigationBar({ currentPath }) {
  const { isLoaded, isSignedIn } = useUser();
  const [balance, setBalance] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  const fetchBalance = async () => {
    try {
      setLoading(true);
      const response = await fetch("/api/get-user-tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
      });

      const data = await response.json();

      if (data.success) {
        setBalance(data.data.balance);
        setError(null);
      } else if (data.shouldInitialize) {
        // Initialiser les tokens s'ils n'existent pas encore
        await fetch("/api/tokens/initialize", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
        });
        fetchBalance(); // Relancer après initialisation
      } else {
        setError("Erreur : " + data.error);
      }
    } catch (err) {
      console.error("Erreur lors de la récupération des tokens :", err);
      setError("Erreur réseau");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isSignedIn) {
      fetchBalance();
    }
  }, [isSignedIn]);

  const isCasinoPath = currentPath?.startsWith("/casino");

  return (
    <nav className="fixed top-0 left-0 right-0 z-50 bg-[#002347]">
      <div className="mx-auto max-w-7xl px-4">
        <div className="flex h-16 items-center justify-between">
          <div className="flex items-center">
            <Link href="/" className="text-xl font-bold text-[#FFD700]">
              BetSim
            </Link>
          </div>

          {/* Center Navigation */}
          <div className="hidden md:flex items-center space-x-4">
            {[
              { href: "/", label: "Accueil" },
              { href: "/sport", label: "Sport" },
              { href: "/casino", label: "Casino", check: isCasinoPath },
              { href: "/rankings", label: "Classement" },
            ].map(({ href, label, check }) => (
              <Link
                key={href}
                href={href}
                className={`px-3 py-2 text-sm font-medium ${
                  (check ?? currentPath === href)
                    ? "text-[#FFD700]"
                    : "text-white hover:text-[#FFD700]"
                }`}
              >
                {label}
              </Link>
            ))}
          </div>

          {/* Right Side */}
          <div className="flex items-center space-x-4">
            {isLoaded && isSignedIn ? (
              <>
                <div className="hidden sm:flex items-center space-x-4">
                  <span className="text-[#FFD700] text-sm">
                    {loading
                      ? "Chargement..."
                      : error
                      ? error
                      : `${balance ?? 0} tokens`}
                  </span>
                  <Link
                    href="/profil"
                    className={`px-3 py-2 text-sm font-medium ${
                      currentPath === "/profil"
                        ? "text-[#FFD700]"
                        : "text-white hover:text-[#FFD700]"
                    }`}
                  >
                    Profil
                  </Link>
                </div>
                <SignOutButton>
                  <button className="rounded-lg bg-[#FFD700] px-4 py-2 text-sm font-medium text-[#003366] hover:bg-[#FFD700]/80">
                    Déconnexion
                  </button>
                </SignOutButton>
              </>
            ) : (
              <Link
                href="/sign-up"
                className="rounded-lg bg-[#FFD700] px-4 py-2 text-sm font-medium text-[#003366] hover:bg-[#FFD700]/80"
              >
                Connexion
              </Link>
            )}
          </div>
        </div>
      </div>
    </nav>
  );
}

export default NavigationBar;
