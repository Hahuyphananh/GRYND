"use client";
import React, { useEffect, useState } from "react";
import { useUser, useAuth, SignOutButton } from '@clerk/nextjs';
import Link from 'next/link';

function NavigationBar({ currentPath }) {
  const { isLoaded, isSignedIn } = useUser();
  const { getToken } = useAuth();
  const [balance, setBalance] = useState(null);
  const [error, setError] = useState(null);

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
          <Link href="/" className="text-xl font-bold text-[#FFD700]">
            BetSim
          </Link>

          <div className="hidden md:flex items-center space-x-4">
            {["/", "/sport", "/casino", "/rankings"].map((path) => (
              <Link
                key={path}
                href={path}
                className={`px-3 py-2 text-sm font-medium ${
                  currentPath === path || (path === "/casino" && isCasinoPath)
                    ? "text-[#FFD700]"
                    : "text-white hover:text-[#FFD700]"
                }`}
              >
                {path === "/" ? "Accueil" : path.slice(1).charAt(0).toUpperCase() + path.slice(2)}
              </Link>
            ))}
          </div>

          <div className="flex items-center space-x-4">
            {isLoaded && isSignedIn ? (
              <>
                <div className="hidden sm:flex items-center space-x-4">
                  <span className="text-[#FFD700]">
                    {error
                      ? `Erreur: ${error}`
                      : balance !== null
                      ? `${balance} tokens`
                      : "Chargement..."}
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
