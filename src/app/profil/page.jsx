"use client";
import React, { useState, useEffect } from "react";
import { useUser } from "@clerk/nextjs";

export default function ProfilePage() {
  const { isSignedIn, isLoaded, user } = useUser();
  const [userTokens, setUserTokens] = useState(null);
  const [bets, setBets] = useState([]);
  const [error, setError] = useState(null);
  const [isResetting, setIsResetting] = useState(false);

  useEffect(() => {
    if (!isSignedIn || !user) return;

    const fetchTokensAndBets = async () => {
      try {
        const tokensResponse = await fetch("/api/get-user-tokens", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
        });

        const tokensData = await tokensResponse.json();

        if (tokensData.success && tokensData.data) {
          setUserTokens(tokensData.data.balance);
        }

        const betsResponse = await fetch("/api/bets", {
          credentials: "include",
        });

        const betsData = await betsResponse.json();
        setBets(betsData || []);
      } catch (err) {
        console.error("Erreur:", err);
        setError("Erreur lors du chargement des données");
      }
    };

    fetchTokensAndBets();
  }, [isSignedIn, user]);

  const handleResetTokens = async () => {
    const confirmed = confirm("Êtes-vous sûr de vouloir réinitialiser vos tokens à 1000 ?");
    if (!confirmed) return;
  
    setIsResetting(true);
    setError(null);
  
    try {
      const response = await fetch("/api/reset-user-tokens", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        credentials: "include", // ✅ OBLIGATOIRE pour envoyer les cookies Clerk
      });
  
      const text = await response.text();
  
      let data;
      try {
        data = JSON.parse(text); // 🧪 sécurise la lecture JSON
      } catch (e) {
        console.error("Réponse non JSON :", text);
        throw new Error("Réponse invalide du serveur");
      }
  
      if (!response.ok) {
        throw new Error(data.error || "Erreur serveur");
      }
  
      setUserTokens(data.balance); // ✅ update tokens
    } catch (err) {
      console.error("Erreur reset:", err);
      setError(err.message);
    } finally {
      setIsResetting(false);
    }
  };
  

  if (!isLoaded) {
    return (
      <div className="flex h-screen items-center justify-center bg-[#003366]">
        <div className="text-2xl text-[#FFD700]">
          <i className="fas fa-spinner fa-spin mr-2"></i> Chargement...
        </div>
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
    <div className="min-h-screen bg-[#003366]">
      <div className="container mx-auto px-4 pt-24">
        <div className="mb-6 flex justify-between items-center">
          <a
            href="/"
            className="flex items-center rounded-lg bg-[#FFD700] px-4 py-2 text-[#003366] hover:bg-[#FFD700]/80"
          >
            <i className="fas fa-arrow-left mr-2"></i> Retour à l'accueil
          </a>
        </div>

        <div className="mx-auto max-w-7xl space-y-8 py-8">
          {/* Informations personnelles */}
          <div className="grid gap-8 md:grid-cols-2">
            <div className="rounded-lg border border-[#FFD700] bg-[#003366] p-6">
              <h2 className="mb-4 text-xl font-bold text-[#FFD700]">Informations Personnelles</h2>
              <div className="space-y-4 text-gray-300">
                <p><span className="text-[#FFD700]">Email:</span> {user.emailAddresses?.[0]?.emailAddress}</p>
                <p><span className="text-[#FFD700]">Membre depuis:</span> {new Date(user.createdAt).toLocaleDateString()}</p>
              </div>
            </div>

            <div className="rounded-lg border border-[#FFD700] bg-[#003366] p-6">
              <h2 className="mb-4 text-xl font-bold text-[#FFD700]">État du Portefeuille</h2>
              <div className="text-center">
                <p className="text-sm text-gray-300">Solde actuel</p>
                <p className="text-4xl font-bold text-[#FFD700]">{userTokens ?? 0}€</p>
              </div>
            </div>
          </div>

          {/* Statistiques */}
          <div className="rounded-lg border border-[#FFD700] bg-[#003366] p-6">
            <h2 className="mb-6 text-xl font-bold text-[#FFD700]">Statistiques des Paris</h2>
            <div className="grid gap-4 md:grid-cols-3">
              <div className="rounded-lg bg-[#003366] p-4 text-center">
                <p className="text-sm text-gray-300">Paris Gagnés</p>
                <p className="text-3xl font-bold text-[#FFD700]">
                  {bets.filter((b) => b.status === "won").length}
                </p>
              </div>
              <div className="rounded-lg bg-[#003366] p-4 text-center">
                <p className="text-sm text-gray-300">Paris Perdus</p>
                <p className="text-3xl font-bold text-[#FFD700]">
                  {bets.filter((b) => b.status === "lost").length}
                </p>
              </div>
              <div className="rounded-lg bg-[#003366] p-4 text-center">
                <p className="text-sm text-gray-300">Gains Totaux</p>
                <p className="text-3xl font-bold text-[#FFD700]">
                  {bets.reduce((acc, b) => acc + (b.status === "won" ? b.winnings : 0), 0)}€
                </p>
              </div>
            </div>
          </div>

          {/* Historique des paris */}
          <div className="rounded-lg border border-[#FFD700] bg-[#003366] p-6">
            <h2 className="mb-6 text-xl font-bold text-[#FFD700]">Historique des Paris</h2>
            <div className="overflow-x-auto">
              <table className="w-full text-gray-300">
                <thead className="border-b border-[#FFD700]">
                  <tr>
                    <th className="px-4 py-2 text-left text-[#FFD700]">Date</th>
                    <th className="px-4 py-2 text-left text-[#FFD700]">Événement</th>
                    <th className="px-4 py-2 text-left text-[#FFD700]">Mise</th>
                    <th className="px-4 py-2 text-left text-[#FFD700]">Résultat</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#FFD700]/20">
                  {bets.map((bet, index) => (
                    <tr key={index} className="hover:bg-[#003366]/80">
                      <td className="px-4 py-2">{new Date(bet.date).toLocaleDateString()}</td>
                      <td className="px-4 py-2">{bet.event}</td>
                      <td className="px-4 py-2">{bet.amount}€</td>
                      <td className="px-4 py-2">
                        <span className={`rounded-full px-2 py-1 text-xs ${
                          bet.status === "won"
                            ? "bg-green-500/20 text-green-500"
                            : bet.status === "lost"
                            ? "bg-red-500/20 text-red-500"
                            : "bg-[#FFD700]/20 text-[#FFD700]"
                        }`}>
                          {bet.status === "won" ? "Gagné" : bet.status === "lost" ? "Perdu" : "En cours"}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Reset Tokens */}
          <div className="bg-[#003366] p-6">
            <div className="rounded-lg border border-[#FFD700] bg-[#003366] p-6 text-center">
              <h2 className="mb-4 text-xl font-bold text-[#FFD700]">Tokens</h2>
              <p className="text-sm text-gray-300 mb-2">Solde actuel en tokens</p>
              <p className="text-4xl font-bold text-[#FFD700] mb-4">
                {userTokens ?? 0} tokens
              </p>
              <button
                onClick={handleResetTokens}
                disabled={isResetting}
                className="rounded bg-red-500 px-4 py-2 text-white hover:bg-red-600 disabled:opacity-50"
              >
                {isResetting ? (
                  <>
                    <i className="fas fa-spinner fa-spin mr-2"></i>
                    Réinitialisation...
                  </>
                ) : (
                  "Réinitialiser les tokens"
                )}
              </button>
              {error && <p className="mt-2 text-red-500">{error}</p>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
