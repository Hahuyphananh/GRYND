"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useUser } from "@clerk/nextjs";
import { motion } from "framer-motion";
import NavigationBar from "../../../components/navigation-bar";
import Footer from "../../../components/Footer";
import ReportModal from "../../../components/ReportModal";

type PublicUser = {
  id: number;
  clerkId: string;
  name: string;
  email: string;
  profilePicture: string | null;
  level: number;
  xp: number;
  gamesWon: number;
  gamesLost: number;
  totalWagered: number;
  totalWon: number;
  biggestWin: number;
  currentStreak: number;
  bestStreak: number;
  pvpWins: number;
  referralCount: number;
  createdAt: string;
  selectedTitle: string | null;
  highestTitle: string | null;
  selectedSpecialTitle: string | null;
  dailyStreakCurrent: number;
  dailyStreakBest: number;
};

export default function PublicProfilePage() {
  const { clerkId } = useParams<{ clerkId: string }>();
  const router = useRouter();
  const { user: currentUser } = useUser();
  const [profile, setProfile] = useState<PublicUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showReportModal, setShowReportModal] = useState(false);
  const [bets, setBets] = useState<any[]>([]);
  const [betsLoading, setBetsLoading] = useState(false);
  const [betsHasMore, setBetsHasMore] = useState(false);
  const [betsOffset, setBetsOffset] = useState(0);
  const BETS_PAGE_SIZE = 20;

  const isOwnProfile = currentUser?.id === clerkId;

  useEffect(() => {
    if (!clerkId) return;
    setLoading(true);
    Promise.all([
      fetch(`/api/user/public-profile?clerkId=${encodeURIComponent(clerkId)}`).then((res) => res.json()),
      fetch(`/api/user/public-bet-history?clerkId=${encodeURIComponent(clerkId)}&limit=${BETS_PAGE_SIZE}&offset=0`).then((res) => res.json()),
    ])
      .then(([profileData, betData]) => {
        if (profileData.success) {
          setProfile(profileData.user);
        } else {
          setError(profileData.error || "User not found");
        }
        if (betData.success) {
          setBets(betData.bets || []);
          setBetsHasMore(betData.hasMore || false);
          setBetsOffset(BETS_PAGE_SIZE);
        }
      })
      .catch(() => setError("Failed to load profile"))
      .finally(() => setLoading(false));
  }, [clerkId]);

  const loadMoreBets = async () => {
    if (betsLoading || !betsHasMore) return;
    setBetsLoading(true);
    try {
      const res = await fetch(
        `/api/user/public-bet-history?clerkId=${encodeURIComponent(clerkId)}&limit=${BETS_PAGE_SIZE}&offset=${betsOffset}`
      );
      const data = await res.json();
      if (data.success) {
        setBets((prev) => [...prev, ...(data.bets || [])]);
        setBetsHasMore(data.hasMore || false);
        setBetsOffset((prev) => prev + BETS_PAGE_SIZE);
      }
    } catch {
      // silently fail
    } finally {
      setBetsLoading(false);
    }
  };

  const winRate =
    profile && profile.gamesWon + profile.gamesLost > 0
      ? ((profile.gamesWon / (profile.gamesWon + profile.gamesLost)) * 100).toFixed(1)
      : "0.0";

  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-[#030817] via-[#081a3d] to-[#003b8e] flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-[#00e5ff] border-t-transparent" />
      </div>
    );
  }

  if (error || !profile) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-[#030817] via-[#081a3d] to-[#003b8e] text-white">
        <NavigationBar currentPath="/profil" />
        <div className="max-w-2xl mx-auto px-6 pt-24 text-center">
          <h1 className="text-2xl font-bold text-red-400 mb-4">
            {error || "User not found"}
          </h1>
          <button
            onClick={() => router.back()}
            className="px-6 py-3 rounded-xl bg-[#00e5ff] text-[#001933] font-bold hover:bg-[#00e5ff]/80 transition"
          >
            Go Back
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      className="min-h-screen text-white"
      style={{
        backgroundImage: "linear-gradient(135deg, #001933 0%, #000d1a 100%)",
      }}
    >
      <div className="max-w-4xl mx-auto px-6 pt-24 pb-20">
        <NavigationBar currentPath="/profil" />

        <div className="flex items-center justify-between mb-8">
          <button
            onClick={() => router.back()}
            className="px-4 py-2 rounded-lg border border-white/20 bg-white/5 text-sm text-white/70 hover:bg-white/10 transition"
          >
            ← Back
          </button>
          {!isOwnProfile && (
            <button
              onClick={() => setShowReportModal(true)}
              className="px-4 py-2 rounded-lg border border-red-500/40 bg-red-900/30 text-sm font-semibold text-red-300 hover:bg-red-900/50 transition"
            >
              🚩 Report Player
            </button>
          )}
        </div>

        {/* ── PROFILE HEADER ── */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
          className="bg-[#0b224f]/85 border border-[#00e5ff]/30 rounded-xl p-6 shadow-[0_0_24px_rgba(0,229,255,0.15)] mb-8"
        >
          <div className="flex items-center gap-4">
            {profile.profilePicture ? (
              <img
                src={profile.profilePicture}
                alt={profile.name}
                className="h-20 w-20 rounded-full object-cover border-2 border-[#FFD700]"
              />
            ) : (
              <div className="h-20 w-20 rounded-full bg-[#00e5ff] text-[#001933] shadow-[0_0_10px_rgba(0,229,255,0.4)] flex items-center justify-center text-3xl font-bold">
                {(profile.name || "U").charAt(0).toUpperCase()}
              </div>
            )}
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-2xl font-bold">{profile.name}</h1>
                {(profile.selectedSpecialTitle || profile.selectedTitle) && (
                  <span className="rounded-full border border-[#f5ff3b]/60 bg-[#f5ff3b]/10 px-2 py-0.5 text-xs text-[#f5ff3b]">
                    {profile.selectedSpecialTitle || profile.selectedTitle}
                  </span>
                )}
              </div>
              <p className="text-sm text-gray-400 mt-1">
                Level {profile.level} · {Number(profile.xp).toLocaleString()} XP
              </p>
              <p className="text-xs text-gray-500 mt-1">
                Member since {new Date(profile.createdAt).toLocaleDateString()}
              </p>
            </div>
          </div>
        </motion.div>

        {/* ── STATS GRID ── */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.1 }}
          className="grid grid-cols-2 sm:grid-cols-3 gap-4 mb-8"
        >
          {[
            { label: "Games Won", value: profile.gamesWon },
            { label: "Games Lost", value: profile.gamesLost },
            { label: "Win Rate", value: `${winRate}%` },
            { label: "Total Wagered", value: Number(profile.totalWagered).toLocaleString() },
            { label: "Total Won", value: Number(profile.totalWon).toLocaleString() },
            { label: "Biggest Win", value: Number(profile.biggestWin).toLocaleString() },
            { label: "PvP Wins", value: profile.pvpWins },
            { label: "Best Streak", value: profile.bestStreak },
            { label: "Daily Streak", value: `${profile.dailyStreakCurrent} days` },
          ].map((stat) => (
            <div
              key={stat.label}
              className="rounded-lg border border-[#FFD700]/30 bg-white/5 p-4"
            >
              <p className="text-sm text-gray-300">{stat.label}</p>
              <p className="text-xl font-bold text-white mt-1">{stat.value}</p>
            </div>
          ))}
        </motion.div>

        {/* ── STREAK INFO ── */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.2 }}
          className="bg-[#0b224f]/85 border border-[#00e5ff]/30 rounded-xl p-6 shadow-[0_0_24px_rgba(0,229,255,0.15)]"
        >
          <h2 className="text-xl text-[#00e5ff] mb-4">Streaks</h2>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
            <div className="rounded-lg border border-amber-400/40 bg-amber-500/10 p-4">
              <p className="text-xs text-amber-300">Current Streak</p>
              <p className="text-2xl font-bold text-white mt-1">
                {profile.currentStreak}
              </p>
            </div>
            <div className="rounded-lg border border-amber-400/40 bg-amber-500/10 p-4">
              <p className="text-xs text-amber-300">Best Streak</p>
              <p className="text-2xl font-bold text-white mt-1">
                {profile.bestStreak}
              </p>
            </div>
            <div className="rounded-lg border border-amber-400/40 bg-amber-500/10 p-4">
              <p className="text-xs text-amber-300">Daily Streak</p>
              <p className="text-2xl font-bold text-white mt-1">
                {profile.dailyStreakCurrent} days
              </p>
            </div>
          </div>
        </motion.div>

        {/* ── BET HISTORY ── */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.3 }}
          className="bg-[#0b224f]/85 border border-[#00e5ff]/30 rounded-xl p-6 shadow-[0_0_24px_rgba(0,229,255,0.15)]"
        >
          <h2 className="text-xl text-[#00e5ff] mb-4">Recent Bets</h2>
          {bets.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-4">No bets found.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm text-left">
                <thead className="border-b border-[#FFD700] text-[#00e5ff]">
                  <tr>
                    <th className="px-4 py-2">Date</th>
                    <th className="px-4 py-2">Game</th>
                    <th className="px-4 py-2">Bet</th>
                    <th className="px-4 py-2">Result</th>
                  </tr>
                </thead>
                <tbody>
                  {bets.map((bet: any, idx: number) => (
                    <tr key={idx} className="border-b border-[#FFD700]/20">
                      <td className="px-4 py-2 text-gray-300 text-xs">
                        {new Date(bet.date).toLocaleDateString()}
                      </td>
                      <td className="px-4 py-2 text-gray-300 text-xs">
                        {bet.type || "Unknown"}
                      </td>
                      <td className="px-4 py-2 text-gray-300 text-xs">{bet.amount} tokens</td>
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
                            {bet.result === "won" ? "Won" : bet.result === "lost" ? "Lost" : "Tie"}
                          </span>
                          <span
                            className={`text-xs ${
                              bet.tokenDiff > 0
                                ? "text-green-400"
                                : bet.tokenDiff < 0
                                  ? "text-red-400"
                                  : "text-gray-300"
                            }`}
                          >
                            {bet.tokenDiff > 0
                              ? `+${Number(bet.tokenDiff).toFixed(0)}`
                              : bet.tokenDiff < 0
                                ? `${Number(bet.tokenDiff).toFixed(0)}`
                                : "±0"}{" "}
                            tokens
                          </span>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {betsHasMore && (
                <div className="flex justify-center mt-4">
                  <button
                    onClick={loadMoreBets}
                    disabled={betsLoading}
                    className="px-6 py-2 rounded-lg border border-[#00e5ff]/40 bg-[#00e5ff]/10 text-sm text-[#00e5ff] hover:bg-[#00e5ff]/20 transition disabled:opacity-40"
                  >
                    {betsLoading ? "Loading..." : "Load More"}
                  </button>
                </div>
              )}
            </div>
          )}
        </motion.div>
      </div>

      {/* Report Modal */}
      <ReportModal
        isOpen={showReportModal}
        onClose={() => setShowReportModal(false)}
        onSubmit={async (reason, details) => {
          const res = await fetch("/api/reports/submit", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              reportedClerkId: clerkId,
              gameType: "profile",
              reason,
              details: details || undefined,
            }),
          });
          const data = await res.json();
          if (!data.success) throw new Error(data.error || "Failed to submit report");
        }}
        reportedPlayerName={profile?.name || "Player"}
        gameType="Profile"
      />

      <Footer />
    </div>
  );
}
