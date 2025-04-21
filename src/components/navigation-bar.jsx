"use client";
import React, { useEffect, useState } from "react";
import { useUser, SignOutButton } from '@clerk/nextjs';
import Link from 'next/link';

function NavigationBar({ currentPath }) {
  const { isLoaded, isSignedIn, user } = useUser();
  const [balance, setBalance] = useState(null);
  const [error, setError] = useState(null);

  const fetchBalance = async () => {
    try {
      const response = await fetch("/api/get-user-tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
      });
      const data = await response.json();

      if (data.success) {
        setBalance(data.data.balance);
      } else if (data.error === "Tokens non initialisés") {
        await fetch("/api/tokens/initialize", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
        });
        fetchBalance(); // Retry after initialization
      }
    } catch (error) {
      setError("Erreur de chargement");
    }
  };

  useEffect(() => {
    if (isSignedIn) {
      fetchBalance();
    }
  }, [isSignedIn]);

  const isCasinoPath = currentPath.startsWith("/casino");

  return (
    <nav className="fixed top-0 left-0 right-0 z-50 bg-[#002347]">
      <div className="mx-auto max-w-7xl px-4">
        <div className="flex h-16 items-center justify-between">
          <div className="flex items-center">
            <Link href="/" className="text-xl font-bold text-[#FFD700]">
              BetSim
            </Link>
          </div>
          
          {/* Center Navigation Links */}
          <div className="hidden md:flex items-center space-x-4">
            <Link
              href="/"
              className={`px-3 py-2 text-sm font-medium ${
                currentPath === "/" ? "text-[#FFD700]" : "text-white hover:text-[#FFD700]"
              }`}
            >
              Accueil
            </Link>
            <Link
              href="/sport"
              className={`px-3 py-2 text-sm font-medium ${
                currentPath === "/sport" ? "text-[#FFD700]" : "text-white hover:text-[#FFD700]"
              }`}
            >
              Sport
            </Link>
            <Link
              href="/casino"
              className={`px-3 py-2 text-sm font-medium ${
                isCasinoPath ? "text-[#FFD700]" : "text-white hover:text-[#FFD700]"
              }`}
            >
              Casino
            </Link>
            <Link
              href="/rankings"
              className={`px-3 py-2 text-sm font-medium ${
                currentPath === "/rankings" ? "text-[#FFD700]" : "text-white hover:text-[#FFD700]"
              }`}
            >
              Classement
            </Link>
          </div>

          {/* Right-side Auth Section */}
          <div className="flex items-center space-x-4">
            {isLoaded && isSignedIn ? (
              <>
                <div className="hidden sm:flex items-center space-x-4">
                  <span className="text-[#FFD700]">
                    {error
                      ? "Erreur"
                      : balance !== null
                      ? `${balance} tokens`
                      : "Chargement..."}
                  </span>
                  <Link
                    href="/profil"
                    className={`px-3 py-2 text-sm font-medium ${
                      currentPath === "/profil" ? "text-[#FFD700]" : "text-white hover:text-[#FFD700]"
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