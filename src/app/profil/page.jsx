"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { useUser, useClerk } from "@clerk/nextjs";

const statsCards = [
  { key: "totalBets", label: "Total Bets" },
  { key: "totalWins", label: "Total Wins" },
  { key: "totalLosses", label: "Total Losses" },
  { key: "winRate", label: "Win Rate", suffix: "%" },
  { key: "biggestWin", label: "Biggest Win", suffix: " tokens" },
  { key: "favoriteGame", label: "Favorite Game" },
];

export default function ProfilePage() {
  const { isSignedIn, isLoaded, user } = useUser();
  const { signOut } = useClerk();

  const [userTokens, setUserTokens] = useState(null);
  const [bets, setBets] = useState([]);
  const [error, setError] = useState(null);
  const [isResetting, setIsResetting] = useState(false);

  const [stats, setStats] = useState(null);
  const [statsError, setStatsError] = useState(null);

  const [referralCodeInput, setReferralCodeInput] = useState("");
  const [referralStatus, setReferralStatus] = useState("");

  const [password, setPassword] = useState("");
  const [deleteError, setDeleteError] = useState("");
  const [deleteStatus, setDeleteStatus] = useState("");
  const [countdown, setCountdown] = useState(5);
  const [delayDone, setDelayDone] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const [levelUpModal, setLevelUpModal] = useState(null);
  const previousLevelRef = useRef(null);

  useEffect(() => {
    if (!isSignedIn || !user) return;

    const fetchData = async () => {
      try {
        const tokensResponse = await fetch("/api/get-user-tokens", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
        });
        const tokensData = await tokensResponse.json();
        if (tokensData.success && tokensData.data) {
          setUserTokens(Number(tokensData.data.balance || 0));
        }

        const historyResponse = await fetch("/api/get-bet-history", {
          method: "GET",
          credentials: "include",
        });
        const historyData = await historyResponse.json();

        if (historyData.success && Array.isArray(historyData.bets)) {
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

    const fetchStats = async () => {
      try {
        const res = await fetch("/api/user-stats", { credentials: "include" });
        const data = await res.json();
        if (!res.ok || !data.success) {
          throw new Error(data.error || "Failed to load stats");
        }
        setStats(data.stats);
      } catch (err) {
        console.error("[PROFILE_STATS_ERROR]", err);
        setStatsError("Unable to load profile stats");
      }
    };

    const initReferralCode = async () => {
      try {
        await fetch("/api/referral/generate", { method: "POST", credentials: "include" });
      } catch (err) {
        console.error("[REFERRAL_INIT_ERROR]", err);
      }
    };

    fetchData();
    fetchStats();
    initReferralCode();
  }, [isSignedIn, user]);

  useEffect(() => {
    if (!isSignedIn) return undefined;

    setCountdown(5);
    setDelayDone(false);

    const timer = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          clearInterval(timer);
          setDelayDone(true);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [isSignedIn]);

  useEffect(() => {
    if (!stats) return;

    const previousLevel = previousLevelRef.current;
    if (previousLevel !== null && stats.currentLevel > previousLevel) {
      setLevelUpModal({
        level: stats.currentLevel,
        bonus: stats.currentLevel * 100,
      });
    }

    previousLevelRef.current = stats.currentLevel;
  }, [stats]);

  const levelProgressPercent = useMemo(() => {
    if (!stats?.levelProgress) return 0;
    return Number(stats.levelProgress.progressPercent || 0);
  }, [stats]);

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
      setUserTokens(Number(data.balance || 0));
    } catch (err) {
      console.error("[RESET_TOKENS_ERROR]", err);
      setError(err.message || "Erreur inconnue");
    } finally {
      setIsResetting(false);
    }
  };

  const handleCopyReferralCode = async () => {
    if (!stats?.referralCode) return;
    try {
      await navigator.clipboard.writeText(stats.referralCode);
      setReferralStatus("Referral code copied!");
    } catch (err) {
      console.error("[COPY_REFERRAL_CODE_ERROR]", err);
      setReferralStatus("Could not copy code");
    }
  };

  const handleShareReferralCode = async () => {
    if (!stats?.referralCode) return;
    const message = `Join me on this casino app with my referral code: ${stats.referralCode}`;

    try {
      if (navigator.share) {
        await navigator.share({
          title: "Casino Referral",
          text: message,
        });
        setReferralStatus("Referral code shared successfully!");
        return;
      }

      await navigator.clipboard.writeText(message);
      setReferralStatus("Share not available. Message copied to clipboard.");
    } catch (err) {
      console.error("[SHARE_REFERRAL_CODE_ERROR]", err);
      setReferralStatus("Share cancelled");
    }
  };

  const handleRedeemCode = async () => {
    setReferralStatus("");

    try {
      const response = await fetch("/api/referral/redeem", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ code: referralCodeInput }),
      });

      const data = await response.json();
      if (!response.ok || !data.success) {
        throw new Error(data.error || "Failed to redeem code");
      }

      setReferralStatus(`Code redeemed! You got ${data.reward} bonus tokens.`);
      setReferralCodeInput("");

      const statsRes = await fetch("/api/user-stats", { credentials: "include" });
      const statsData = await statsRes.json();
      if (statsData.success) setStats(statsData.stats);
    } catch (err) {
      console.error("[REDEEM_REFERRAL_ERROR]", err);
      setReferralStatus(err.message || "Unable to redeem code");
    }
  };

  const handleDeleteAccount = async () => {
    setDeleteError("");
    setDeleteStatus("");

    try {
      setIsDeleting(true);
      const response = await fetch("/api/delete-account", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ password }),
      });

      const data = await response.json();
      if (!response.ok || !data.success) {
        throw new Error(data.error || "Delete account failed");
      }

      setDeleteStatus("Account deleted. Signing out...");
      await signOut({ redirectUrl: "/" });
    } catch (err) {
      console.error("[DELETE_ACCOUNT_ERROR]", err);
      setDeleteError(err.message || "Could not delete account");
    } finally {
      setIsDeleting(false);
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
      <div className="container mx-auto px-4 pt-24 pb-20">
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

        <div className="mt-8 border border-[#FFD700] rounded-lg p-6">
          <div className="flex items-center justify-between gap-4 mb-4">
            <h2 className="text-xl text-[#FFD700]">VIP Level</h2>
            <div className="rounded-full px-3 py-1 bg-[#FFD700] text-[#003366] font-bold">
              Level {stats?.currentLevel ?? 1}
            </div>
          </div>

          <div className="h-3 w-full rounded-full bg-white/10 overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-yellow-400 via-orange-400 to-pink-500 transition-all duration-500"
              style={{ width: `${levelProgressPercent}%` }}
            />
          </div>
          <div className="mt-2 flex justify-between text-sm text-gray-300">
            <span>{Number(stats?.levelProgress?.prevLevelRequired ?? 0).toLocaleString()} wagered</span>
            <span>{levelProgressPercent.toFixed(2)}%</span>
            <span>{Number(stats?.levelProgress?.nextLevelRequired ?? 0).toLocaleString()} next level</span>
          </div>
        </div>

        <div className="mt-8 border border-[#FFD700] rounded-lg p-6">
          <h2 className="text-xl text-[#FFD700] mb-4">Referral System</h2>

          <div className="grid gap-4 md:grid-cols-3 mb-4">
            <div className="rounded-lg border border-[#FFD700]/40 p-4">
              <p className="text-sm text-gray-300">Your Referral Code</p>
              <p className="text-2xl font-bold text-[#FFD700]">{stats?.referralCode || "N/A"}</p>
            </div>
            <div className="rounded-lg border border-[#FFD700]/40 p-4">
              <p className="text-sm text-gray-300">Total Referrals</p>
              <p className="text-2xl font-bold">{stats?.referrals ?? 0}</p>
            </div>
            <div className="rounded-lg border border-[#FFD700]/40 p-4">
              <p className="text-sm text-gray-300">Referral Earnings</p>
              <p className="text-2xl font-bold">{stats?.referralEarnings ?? 0} tokens</p>
            </div>
          </div>

          <div className="flex flex-wrap gap-3 mb-4">
            <button
              onClick={handleCopyReferralCode}
              className="rounded bg-[#FFD700] px-4 py-2 text-[#003366] font-semibold hover:bg-[#ffd700]/80"
            >
              Copy Code
            </button>
            <button
              onClick={handleShareReferralCode}
              className="rounded border border-[#FFD700] px-4 py-2 text-[#FFD700] hover:bg-[#FFD700]/10"
            >
              Share Code
            </button>
          </div>

          <div className="flex flex-col md:flex-row gap-3">
            <input
              value={referralCodeInput}
              onChange={(e) => setReferralCodeInput(e.target.value)}
              placeholder="Enter referral code"
              className="flex-1 rounded bg-white/10 border border-white/20 px-4 py-2 outline-none focus:ring-2 focus:ring-[#FFD700]"
            />
            <button
              onClick={handleRedeemCode}
              className="rounded bg-green-500 px-4 py-2 font-semibold hover:bg-green-600"
            >
              Redeem
            </button>
          </div>

          {referralStatus && <p className="mt-3 text-sm text-gray-200">{referralStatus}</p>}
        </div>

        <div className="mt-8 border border-[#FFD700] rounded-lg p-6">
          <h2 className="text-xl text-[#FFD700] mb-4">User Statistics</h2>

          {statsError && <p className="text-red-400 mb-4">{statsError}</p>}

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {statsCards.map((card) => (
              <div key={card.key} className="rounded-lg border border-[#FFD700]/30 bg-white/5 p-4">
                <p className="text-sm text-gray-300">{card.label}</p>
                <p className="text-2xl font-bold text-white mt-1">
                  {stats?.[card.key] ?? 0}
                  {card.suffix || ""}
                </p>
              </div>
            ))}
          </div>
        </div>

        <div className="mt-8 border border-red-500 bg-red-950/30 rounded-lg p-6">
          <h2 className="text-xl text-red-400 mb-2">Danger Zone — Delete Account</h2>
          <p className="text-red-200 mb-4">
            Warning: This action is permanent. Your account and data will be removed forever.
          </p>

          <label className="text-sm text-red-200">Confirm password</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-2 w-full rounded border border-red-400/40 bg-red-900/20 px-4 py-2 outline-none focus:ring-2 focus:ring-red-500"
            placeholder="Enter your password"
          />

          <button
            onClick={handleDeleteAccount}
            disabled={!delayDone || !password || isDeleting}
            className="mt-4 rounded bg-red-600 px-4 py-2 font-semibold hover:bg-red-700 disabled:opacity-50"
          >
            {isDeleting
              ? "Deleting..."
              : delayDone
              ? "Confirm permanent deletion"
              : `Confirm in ${countdown}s`}
          </button>

          {deleteError && <p className="mt-3 text-sm text-red-300">{deleteError}</p>}
          {deleteStatus && <p className="mt-3 text-sm text-green-300">{deleteStatus}</p>}
        </div>

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
                      <td className="px-4 py-2">{new Date(bet.date).toLocaleDateString()}</td>
                      <td className="px-4 py-2">{bet.type || bet.event || bet.game_type || "Inconnu"}</td>
                      <td className="px-4 py-2">{bet.amount} tokens</td>
                      <td className="px-4 py-2">
                        <div className="flex items-center gap-2">
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
                              : "Égalité"}
                          </span>

                          {bet.result !== "pending" && (
                            <span
                              className={`text-sm ${
                                bet.tokenDiff > 0
                                  ? "text-green-400"
                                  : bet.tokenDiff < 0
                                  ? "text-red-400"
                                  : "text-gray-300"
                              }`}
                            >
                              {bet.tokenDiff > 0
                                ? `+${Number(bet.tokenDiff).toFixed(2)} tokens`
                                : bet.tokenDiff < 0
                                ? `${Number(bet.tokenDiff).toFixed(2)} tokens`
                                : "±0.00 tokens"}
                            </span>
                          )}
                        </div>
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

      {levelUpModal && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
          <div className="max-w-md w-full rounded-xl border border-[#FFD700] bg-[#0B2D55] p-6 text-center">
            <p className="text-2xl font-bold text-[#FFD700]">🎉 Level Up! You reached Level {levelUpModal.level}</p>
            <p className="mt-2 text-gray-200">Bonus received: {levelUpModal.bonus} tokens</p>
            <button
              onClick={() => setLevelUpModal(null)}
              className="mt-4 rounded bg-[#FFD700] px-4 py-2 text-[#003366] font-semibold"
            >
              Awesome!
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
