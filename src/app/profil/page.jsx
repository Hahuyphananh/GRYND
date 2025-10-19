"use client";
import React, { useState, useEffect } from "react";
import { useUser, useAuth } from "@clerk/nextjs";

export default function ProfilePage() {
  const { isSignedIn, isLoaded, user } = useUser();
  const { getToken } = useAuth();

  const [userTokens, setUserTokens] = useState(null);
  const [bets, setBets] = useState([]);
  const [error, setError] = useState(null);
  const [isResetting, setIsResetting] = useState(false);

  useEffect(() => {
    if (!isSignedIn || !user) return;

    const fetchData = async () => {
      try {
        // 🔹 Fetch user token balance
        const tokensResponse = await fetch("/api/get-user-tokens", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
        });
        const tokensData = await tokensResponse.json();
        if (tokensData.success && tokensData.data) {
          setUserTokens(tokensData.data.balance);
        }

        // 🔹 Fetch unified betting history
        const historyResponse = await fetch("/api/get-bet-history", {
          method: "GET",
          credentials: "include",
        });
        const historyData = await historyResponse.json();

        if (historyData.success && Array.isArray(historyData.bets)) {
          // Sort by most recent
          const sorted = historyData.bets.sort(
            (a, b) => new Date(b.date) - new Date(a.date)
          );
          setBets(sorted.slice(0, 10));
        } else {
          setBets([]);
        }
      } catch (err) {
        console.error("[FETCH_ERROR]", err);
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

      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `Erreur ${response.status}`);
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
          <p className="mb-4 text-xl text-gray-300">
            Connectez-vous pour voir votre profil
          </p>
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
        {/* 🔙 Retour au casino */}
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

        {/* 🔹 Informations utilisateur */}
        <div className="grid gap-8 md:grid-cols-2">
          <div className="border border-[#FFD700] rounded-lg p-6">
            <h2 className="text-xl text-[#FFD700] mb-2">Infos Personnelles</h2>
            <p>Email : {user.emailAddresses?.[0]?.emailAddress}</p>
            <p>Membre depuis : {new Date(user.createdAt).toLocaleDateString()}</p>
          </div>

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

        {/* 🔹 Historique des paris */}
        <div className="mt-12 border border-[#FFD700] rounded-lg p-6">
          <h2 className="text-xl text-[#FFD700] mb-4">Historique des Paris</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left">
              <thead className="border-b border-[#FFD700] text-[#FFD700]">
                <tr>
                  <th className="px-4 py-2">Date</th>
                  <th className="px-4 py-2">Jeu / Événement</th>
                  <th className="px-4 py-2">Mise</th>
                  <th className="px-4 py-2">Résultat</th>
                </tr>
              </thead>
              <tbody>
                {bets.length > 0 ? (
                  bets.map((bet, idx) => (
                    <tr key={idx} className="border-b border-[#FFD700]/20">
                      <td className="px-4 py-2">
                        {new Date(bet.date).toLocaleDateString()}
                      </td>
                      <td className="px-4 py-2">
  {bet.type || bet.event || bet.game_type || "Inconnu"}
</td>
<td className="px-4 py-2">{bet.amount} tokens</td>
<td className="px-4 py-2">
  <span
    className={`px-2 py-1 rounded-full text-xs ${
      bet.result === "won"
        ? "bg-green-600/20 text-green-400"
        : bet.result === "lost"
        ? "bg-red-600/20 text-red-400"
        : "bg-gray-500/20 text-gray-300"
    }`}
  >
    {bet.result === "won"
      ? "Gagné"
      : bet.result === "lost"
      ? "Perdu"
      : "En cours"}
  </span>
</td>

                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan="4" className="text-center py-4 text-gray-400">
                      Aucun pari trouvé
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
