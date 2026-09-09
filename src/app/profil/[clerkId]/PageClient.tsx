"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useUser } from "@clerk/nextjs";
import { motion } from "framer-motion";
import NavigationBar from "../../../components/navigation-bar";
import Footer from "../../../components/Footer";
import ReportModal from "../../../components/ReportModal";
import AvatarFrame from "../../../components/AvatarFrame";
import IconAvatar from "../../../components/IconAvatar";
import { IconFlag } from "@tabler/icons-react";
import UserStatsTabs from "../../../components/UserStatsTabs";
import InteractiveCasinoBg from "../../../components/InteractiveCasinoBg";
import ProfileBanner from "../../../components/ProfileBanner";

type PublicUser = {
  clerkId: string;
  name: string;
  selectedIcon: string | null;
  profileAccent: string | null;
  selectedBanner: string | null;
  avatarFrame: string | null;
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
  prestigeBadge: string | null;
  dailyStreakCurrent: number;
  dailyStreakBest: number;
  // Leaderboard-style record (same shape the /classement boards read).
  record: {
    wins: number;
    losses: number;
    games: number;
    winRate: number;
    bestStreak: number;
    currentStreak: number;
    biggestWin: number;
    favoriteGame: string;
    pvpWins: number;
    weeklyWins: number;
    weeklyLosses: number;
    weeklyWinRate: number;
    weeklyBestStreak: number;
    weeklyCurrentStreak: number;
    weeklyBiggestWin: number;
    dailyStreakCurrent: number;
    dailyStreakBest: number;
    weeklyStreakCurrent: number;
    weeklyStreakBest: number;
  };
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


  if (loading) {
    return (
      <div className="relative min-h-screen flex items-center justify-center">
        <InteractiveCasinoBg variant="subtle" />
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-[#00e5ff] border-t-transparent" />
      </div>
    );
  }

  if (error || !profile) {
    return (
      <div className="relative min-h-screen text-white">
        <InteractiveCasinoBg variant="subtle" />
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
    <div className="relative min-h-screen text-white">
      <InteractiveCasinoBg variant="subtle" />
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
              <span className="inline-flex items-center gap-1"><IconFlag size={14} /> Report Player</span>
            </button>
          )}
        </div>

        {/* ── PROFILE HEADER ── */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
          className={`relative overflow-hidden bg-[#0b224f]/85 border border-[#00e5ff]/30 rounded-xl p-6 shadow-[0_0_24px_rgba(0,229,255,0.15)] mb-8 ${
            profile.selectedBanner ? "pt-28" : ""
          }`}
          style={
            profile.profileAccent
              ? {
                  borderColor: profile.profileAccent,
                  boxShadow: `0 0 24px ${profile.profileAccent}33`,
                }
              : undefined
          }
        >
          <ProfileBanner
            bannerKey={profile.selectedBanner}
            className="absolute inset-x-0 top-0"
            heightClass="h-20"
          />
          <div className="flex items-center gap-4">
            <AvatarFrame frame={profile.avatarFrame}>
              <IconAvatar
                iconKey={profile.selectedIcon}
                name={profile.name}
                size="h-20 w-20"
                className="border-2 border-[#FFD700]"
              />
            </AvatarFrame>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-2xl font-bold">{profile.name}</h1>
                {(profile.prestigeBadge ||
                  profile.selectedSpecialTitle ||
                  profile.selectedTitle) && (
                  <span
                    className={`rounded-full border px-2 py-0.5 text-xs ${
                      profile.prestigeBadge
                        ? "border-violet-400/70 bg-violet-500/15 text-violet-300"
                        : "border-[#f5ff3b]/60 bg-[#f5ff3b]/10 text-[#f5ff3b]"
                    }`}
                  >
                    {profile.prestigeBadge ||
                      profile.selectedSpecialTitle ||
                      profile.selectedTitle}
                  </span>
                )}
              </div>
              <p className="text-sm text-gray-400 mt-1">
                Level {profile.level} · {Number(profile.xp).toLocaleString()} XP
              </p>
              {/* Competitive identity strip — every number is real
                  leaderboard-record data (same source as /classement). */}
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs font-semibold">
                <span className="text-green-300">
                  {Number(profile.record?.wins || 0)}W
                </span>
                <span className="text-red-300/90">
                  {Number(profile.record?.losses || 0)}L
                </span>
                <span className="text-white/60">
                  {Number(profile.record?.winRate || 0).toFixed(1)}% win rate
                </span>
                {(Number(profile.record?.currentStreak || 0)) > 0 && (
                  <span className="inline-flex items-center gap-1 text-[#f5ff3b]">
                    <svg className="h-3 w-3" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                      <path d="M12 23c-1.4 0-2.5-1.1-2.5-2.5 0-.5.1-.9.4-1.3-1.9-1-4.1-2.3-4.1-4.7 0-2.2 1.5-4 3.5-5.5C10 8.4 10.5 7.5 12 2c1.5 5.5 2 6.4 2.7 7 2 1.5 3.5 3.3 3.5 5.5 0 2.4-2.2 3.7-4.1 4.7.3.4.4.8.4 1.3 0 1.4-1.1 2.5-2.5 2.5z" />
                    </svg>
                    {Number(profile.record.currentStreak)} win streak
                  </span>
                )}
              </div>
              <p className="text-xs text-gray-500 mt-1">
                Member since {new Date(profile.createdAt).toLocaleDateString()}
              </p>
            </div>
          </div>
        </motion.div>

        {/* ── STATS ── */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.1 }}
          className="bg-[#0b224f]/85 border border-[#00e5ff]/30 rounded-xl p-6 shadow-[0_0_24px_rgba(0,229,255,0.15)] mb-8"
        >
          <h2 className="text-xl text-[#00e5ff] mb-4">Stats</h2>
          {/* Tabbed stat panel — mirrors the /classement leaderboard
              (record / weekly / streaks) instead of a flat grid. */}
          <UserStatsTabs record={profile.record} />
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
