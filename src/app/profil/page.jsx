"use client";
import React, { useState, useEffect } from "react";
import { useUser, useAuth } from "@clerk/nextjs";

export default function ProfilePage() {
  const { isSignedIn, isLoaded, user } = useUser();
  const { getToken } = useAuth();

  const [userTokens, setUserTokens] = useState<number | null>(null);
  const [bets, setBets] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isResetting, setIsResetting] = useState(false);

  useEffect(() => {
    if (!isSignedIn || !user) return;

    const fetchData = async () => {
      try {
        // ✅ Get token balance
        const tokensResponse = await fetch("/api/get-user-tokens", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
        });
        const tokensData = await tokensResponse.json();
        if (tokensResponse.ok && tokensData.success && tokensData.data) {
          setUserTokens(tokensData.data.balance);
        } else {
          throw new Error(tokensData.error || "Échec du chargement du solde");
        }

        // ✅ Get bets
        const betsResponse = await fetch("/api/bets", {
          credentials: "include",
        });
        const betsData = await betsResponse.json();
        if (betsResponse.ok) {
          setBets(betsData || []);
        } else {
          throw new Error("Échec du chargement des paris");
        }
      } catch (err) {
        console.error("Erreur fetchData:", err);
        setError("Erreur lors du chargement des données");
      }
    };

    fetchData();
  }, [isSignedIn, user]);

  const handleResetTokens = async () => {
    const confirmed = window.confirm("Réinitialiser vos tokens à 1000 ?");
    if (!confirmed) return;

    setIsResetting(true);
    setError(null);

    try {
      const response = await fetch("/api/reset-user-tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
      });

      const text = await response.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error("Réponse invalide du serveur");
      }

      if (!response.ok || !data.balance) {
        throw new Error(data.error || `Erreur ${response.status}`);
      }

      setUserTokens(data.balance);
    } catch (err) {
      console.error("[RESET_TOKENS_ERROR]", err);
      setError(err.message || "Erreur inconnue");
    } finally {
      setIsResetting(false);
    }
  };

  if (!isLoaded) {
    return (
      <div className="flex h-screen items-center justify-center bg-[#003366]">
        <div className="text-2xl text-[#FFD700]">Chargement...</div>
      </div>
    );
  }

  if (!isSignedIn) {
    return (
      <div className="flex h-screen items-center justify-center bg-[#003366]">
        <div className="text-center">
          <p className="mb-4 text-xl text-gray-300">Connectez-vous pour voir votre profil</p>
          <a
            href="/sign-in?redirect_url=/profil"
            className="rounded-lg bg-[#FFD700] px-6 py-3 text-[#003366] hover:bg-[#FFD700]/80"
          >
            Connexion
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#003366] text-white">
      <div className="container mx-auto px-4 pt-24">
        <div className="mb-6 flex justify-between items-center">
          <a
            href="/casino"
            className="flex items-center rounded-lg bg-[#FFD700] px-4 py-2 text-[#003366] hover:bg-[#FFD700]/80"
          >
            <i className="fas fa-arrow-left mr-2"></i>
            Retour au Casino
          </a>
        </div>

        <h1 className="text-3xl font-bold text-[#FFD700] mb-6">Profil</h1>

        <div className="grid gap-8 md:grid-cols-2">
          {/* ✅ Infos personnelles */}
          <div className="border border-[#FFD700] rounded-lg p-6">
            <h2 className="text-xl text-[#FFD700] mb-2">Infos Personnelles</h2>
            <p>Email : {user.emailAddresses?.[0]?.emailAddress}</p>
            <p>Membre depuis : {new Date(user.createdAt).toLocaleDateString()}</p>
          </div>

          {/* ✅ Solde de tokens */}
          <div className="border border-[#FFD700] rounded-lg p-6 text-center">
            <h2 className="text-xl text-[#FFD700] mb-2">Solde de Tokens</h2>
            <p className="text-3xl font-bold">{userTokens ?? 0} tokens</p>
            <button
              onClick={handleResetTokens}
              disabled={isResetting}
              className="mt-4 rounded bg-red-500 px-4 py-2 hover:bg-red-600 disabled:opacity-50"
            >
              {isResetting ? "Réinitialisation..." : "Réinitialiser les tokens"}
            </button>
            {error && <p className="mt-2 text-red-500">{error}</p>}
          </div>
        </div>

        {/* ✅ Historique des paris */}
        <div className="mt-12 border border-[#FFD700] rounded-lg p-6">
          <h2 className="text-xl text-[#FFD700] mb-4">Historique des Paris</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left">
              <thead className="border-b border-[#FFD700] text-[#FFD700]">
                <tr>
                  <th className="px-4 py-2">Date</th>
                  <th className="px-4 py-2">Événement</th>
                  <th className="px-4 py-2">Mise</th>
                  <th className="px-4 py-2">Résultat</th>
                </tr>
              </thead>
              <tbody>
                {bets.length > 0 ? (
                  bets.map((bet, idx) => (
                    <tr key={idx} className="border-b border-[#FFD700]/20">
                      <td className="px-4 py-2">{new Date(bet.date).toLocaleDateString()}</td>
                      <td className="px-4 py-2">{bet.event}</td>
                      <td className="px-4 py-2">{bet.amount}€</td>
                      <td className="px-4 py-2">
                        <span
                          className={`px-2 py-1 rounded-full text-xs ${
                            bet.status === "won"
                              ? "bg-green-600/20 text-green-400"
                              : bet.status === "lost"
                              ? "bg-red-600/20 text-red-400"
                              : "bg-gray-500/20 text-gray-300"
                          }`}
                        >
                          {bet.status === "won"
                            ? "Gagné"
                            : bet.status === "lost"
                            ? "Perdu"
                            : "En cours"}
                        </span>
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={4} className="px-4 py-4 text-center text-gray-300">
                      Aucun pari pour le moment.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
