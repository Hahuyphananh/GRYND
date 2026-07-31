"use client";
import React, { useState, useEffect } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useRouter } from "next/navigation"; // add this at the top
import Link from "next/link";
import NavigationBar from "../components/navigation-bar";
import Footer from "../components/Footer";
import AnimatedBgSvgs from "../components/AnimatedBgSvgs";
import InteractiveCasinoBg from "../components/InteractiveCasinoBg";
import { useUser, useAuth } from "@clerk/nextjs";
import Image from "next/image";
import Img1 from "../images/roulette.png";
import Img2 from "../images/blackjack.jpg";
import Img3 from "../images/poker.jpg";
import Img4 from "../images/plinko.svg";
import HeroBg from "../images/casino-bg.png";
import SportCard from "../components/sport-card";
import {
  fadeIn,
  fadeUp,
  hoverScale,
  modalMotion,
  stagger,
  withReducedMotion,
} from "../lib/animations";
import {
  UIPro06PrimaryButton,
  UIPro07SecondaryButton,
  UIPro16ToastShell,
  UIPro17ModalBackdrop,
  UIPro18ModalPanel,
} from "../components/uipro";
import { useTranslation } from "../hooks/useTranslation";

const MAIN_SPORT_GROUPS = [
  "American Football",
  "Basketball",
  "Ice Hockey",
  "Soccer",
];

function MainComponent() {
  const router = useRouter();
  const { isLoaded, isSignedIn, getToken, signOut } = useAuth();
  const { user } = useUser();
  const [openGroup, setOpenGroup] = useState(null);
  const [sportsLoaded, setSportsLoaded] = useState(false);
  const [selectedBet, setSelectedBet] = useState(null);
  const [selectedOdds, setSelectedOdds] = useState(null);
  const [sports, setSports] = useState({});
  const [events, setEvents] = useState([]);
  const [loadingSports, setLoadingSports] = useState(true);
  const [loadingEvents, setLoadingEvents] = useState(true);
  const [errorSports, setErrorSports] = useState(null);
  const [errorEvents, setErrorEvents] = useState(null);
  const [userTokens, setUserTokens] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [betInProgress, setBetInProgress] = useState(false);
  const [notification, setNotification] = useState(null);
  const [jwt, setJwt] = useState(null);
  const [dailyRewardCooldown, setDailyRewardCooldown] = useState(false);
  const [nextRewardTime, setNextRewardTime] = useState(null); // timestamp for cooldown
  const [cooldownTimeLeft, setCooldownTimeLeft] = useState("");
  const [rewardPopupVisible, setRewardPopupVisible] = useState(false);
  const [streakData, setStreakData] = useState({
    currentDay: 0,
    claimedDays: [], // array of ISO dates strings
    currentStreak: 0,
    lastClaimDate: null,
    maxDay: 14,
    dailyStreakCurrent: 0,
    dailyStreakBest: 0,
    weeklyStreakCurrent: 0,
    weeklyStreakBest: 0,
    streakTitle: null,
    nextMilestone: null, // { days: number, title: string }
  });

  const [milestoneBonus, setMilestoneBonus] = useState(0);
  const [milestoneTitle, setMilestoneTitle] = useState(null);
  const [showExpandedBadge, setShowExpandedBadge] = useState(false);
  const [claimedDay, setClaimedDay] = useState(null);
  const [friendPresenceByGame, setFriendPresenceByGame] = useState({});
  const [showTermsModal, setShowTermsModal] = useState(false);
  const [termsLoading, setTermsLoading] = useState(true);
  const [liveStats, setLiveStats] = useState({ playersOnline: 0, gamesPlayedToday: 0 });
  const { t } = useTranslation();
  const shouldReduceMotion = useReducedMotion();
  const fadeUpVariant = withReducedMotion(shouldReduceMotion, fadeUp);
  const fadeInVariant = withReducedMotion(shouldReduceMotion, fadeIn);
  const modalBackdropVariant = withReducedMotion(
    shouldReduceMotion,
    modalMotion.backdrop,
  );
  const modalPanelVariant = withReducedMotion(
    shouldReduceMotion,
    modalMotion.panel,
  );

  const fetchFriendPresence = async () => {
    try {
      const response = await fetch("/api/friends/game-presence", {
        credentials: "include",
      });
      const data = await response.json();
      if (response.ok && data.success)
        setFriendPresenceByGame(data.byGame || {});
    } catch (err) {
      console.error("[FRIEND_PRESENCE_ERROR]", err);
    }
  };

  const renderFriendWidget = (gameKey) => {
    const friends = Array.isArray(friendPresenceByGame[gameKey])
      ? friendPresenceByGame[gameKey]
      : [];
    if (!friends.length) return null;

    return (
      <div
        className="absolute bottom-2 left-2 flex items-center gap-1 rounded-full bg-black/60 px-2 py-1"
        title={friends.map((f) => f.name).join(", ")}
      >
        {friends.slice(0, 4).map((friend) =>
          friend.profilePicture ? (
            <img
              key={`${friend.id}-${friend.name}`}
              src={friend.profilePicture}
              alt={friend.name}
              className="h-6 w-6 rounded-full border border-white/30 object-cover"
              title={friend.name}
            />
          ) : (
            <div
              key={`${friend.id}-${friend.name}`}
              className="h-6 w-6 rounded-full bg-[#FFD700] text-[#003366] text-xs font-bold flex items-center justify-center"
              title={friend.name}
            >
              {friend.name?.charAt(0)?.toUpperCase() || "U"}
            </div>
          ),
        )}
      </div>
    );
  };

  const handleLoadSports = async () => {
    try {
      setLoadingSports(true);

      const res = await fetch("/api/sports/list");
      const data = await res.json();

      const sportsArray = Array.isArray(data?.sports) ? data.sports : [];

      const grouped = {};

      sportsArray.forEach((sport) => {
        console.log("SPORT FROM API:", {
          key: sport.key,
          group: sport.group,
          title: sport.title,
          active: sport.active,
          has_outrights: sport.has_outrights,
        });

        // Only main sports
        if (!MAIN_SPORT_GROUPS.includes(sport.group)) return;

        // Only active leagues
        if (!sport.active) return;

        // Hide championship / winner markets
        if (sport.has_outrights) return;

        if (!grouped[sport.group]) {
          grouped[sport.group] = [];
        }

        grouped[sport.group].push(sport);
      });

      setSports(grouped);
      setSportsLoaded(true);
    } catch (err) {
      console.error(err);
      setErrorSports(t("home.errors.load_sports"));
    } finally {
      setLoadingSports(false);
    }
  };

  const fetchRewardStatus = async () => {
    if (!user || !isSignedIn) return;

    try {
      const res = await fetch("/api/get-login-reward-status");
      const data = await res.json();
      if (!data.success) return;

      setStreakData({
        currentDay: data.currentDay,
        claimedDays: data.claimedDays || [],
        lastClaimDate: data.lastClaimedDate,
        maxDay: data.maxDay || 14,
        dailyStreakCurrent: data.dailyStreakCurrent ?? 0,
        dailyStreakBest: data.dailyStreakBest ?? 0,
        weeklyStreakCurrent: data.weeklyStreakCurrent ?? 0,
        weeklyStreakBest: data.weeklyStreakBest ?? 0,
        streakTitle: data.streakTitle || null,
        nextMilestone: data.nextMilestone || null,
      });

      // Reset one-shot milestone bonus/title (these only come from claim response)
      setMilestoneBonus(0);
      setMilestoneTitle(null);

      if (data.lastClaimedDate) {
        const lastClaimed = new Date(data.lastClaimedDate);
        const now = new Date();

        const toUtcDayKey = (d) =>
          Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());

        if (toUtcDayKey(lastClaimed) === toUtcDayKey(now)) {
          setDailyRewardCooldown(true);

          const nextTime = new Date(lastClaimed);
          nextTime.setHours(nextTime.getHours() + 24);
          setNextRewardTime(nextTime);
        }
      }
    } catch (err) {
      console.error("Failed to fetch reward status:", err);
    }
  };

  // ── Check Terms & Conditions acceptance ──
  useEffect(() => {
    if (!isSignedIn || !isLoaded) return;

    const checkTerms = async () => {
      try {
        setTermsLoading(true);
        const res = await fetch("/api/user/terms-status");
        const data = await res.json();
        if (data.success && !data.termsAccepted) {
          setShowTermsModal(true);
        }
      } catch (err) {
        console.error("Failed to check terms status:", err);
      } finally {
        setTermsLoading(false);
      }
    };

    checkTerms();
  }, [isSignedIn, isLoaded]);

  const handleAcceptTerms = async () => {
    try {
      const res = await fetch("/api/user/accept-terms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const data = await res.json();
      if (data.success) {
        setShowTermsModal(false);
      }
    } catch (err) {
      console.error("Failed to accept terms:", err);
    }
  };

  const handleRejectTerms = async () => {
    // Sign the user out if they reject the terms
    if (signOut) {
      await signOut();
    }
    router.push("/");
  };

  useEffect(() => {
    fetchRewardStatus();
  }, [user, isSignedIn]);

  const claimDailyReward = async () => {
    if (!user || !isSignedIn) {
      showNotification(t("home.rewards.must_sign_in"), "error");
      return;
    }

    try {
      const res = await fetch("/api/claim-login-reward", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}), // 👈 REQUIRED
        credentials: "include",
      });
      const data = await res.json();

      if (!res.ok || !data.success) {
        showNotification(data.error || t("home.rewards.claim_error"), "error");
        return;
      }

      setUserTokens((prev) => prev + data.reward + (data.milestoneBonus || 0));

      setClaimedDay(data.claimedDay);

      // Update streak display with real leaderboard values & next reward day
      setStreakData((prev) => ({
        ...prev,
        currentDay: data.nextDay ?? prev.currentDay,
        dailyStreakCurrent: data.dailyStreakCurrent ?? 0,
        dailyStreakBest: data.dailyStreakBest ?? 0,
        weeklyStreakCurrent: data.weeklyStreakCurrent ?? 0,
        weeklyStreakBest: data.weeklyStreakBest ?? 0,
        streakTitle: data.streakTitle || null,
        nextMilestone: data.nextMilestone || null,
      }));

      // Capture milestone bonus info for popup display
      setMilestoneBonus(data.milestoneBonus || 0);
      setMilestoneTitle(data.milestoneTitle || null);

      setRewardPopupVisible(true);

      // 4) Set 24h cooldown
      const nextTime = new Date();
      nextTime.setHours(nextTime.getHours() + 24);
      setNextRewardTime(nextTime);
      setDailyRewardCooldown(true);
    } catch (err) {
      console.error(err);
      showNotification(err.message || t("home.rewards.claim_error"), "error");
    }
  };

  useEffect(() => {
    if (!nextRewardTime) return;

    const interval = setInterval(() => {
      const now = new Date();
      const diff = nextRewardTime - now;

      if (diff <= 0) {
        setDailyRewardCooldown(false);
        setNextRewardTime(null);
        setCooldownTimeLeft("");
        clearInterval(interval);
        return;
      }

      const hours = Math.floor(diff / (1000 * 60 * 60));
      const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
      const seconds = Math.floor((diff % (1000 * 60)) / 1000);

      setCooldownTimeLeft(
        `${hours.toString().padStart(2, "0")}:${minutes
          .toString()
          .padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`,
      );
    }, 1000);

    return () => clearInterval(interval);
  }, [nextRewardTime]);

  const fetchEventsByLeague = async (leagueKey) => {
    console.log("FETCHING EVENTS FOR LEAGUE:", leagueKey);

    if (!leagueKey) return;

    try {
      setLoadingEvents(true);

      const res = await fetch(`/api/sports/${leagueKey}`);
      const data = await res.json();

      console.log("API RESPONSE:", data);

      if (data.success && Array.isArray(data.events)) {
        setEvents(data.events);
      } else {
        setEvents([]);
      }
    } catch (err) {
      setErrorEvents(t("home.errors.load_events"));
      console.error(err);
    } finally {
      setLoadingEvents(false);
    }
  };

  useEffect(() => {
    handleLoadSports();
  }, []);

  // ── Live stats ticker fetch ──
  const fetchLiveStats = async () => {
    try {
      const res = await fetch("/api/stats/live");
      const data = await res.json();
      if (data.success) {
        setLiveStats({ playersOnline: data.playersOnline, gamesPlayedToday: data.gamesPlayedToday });
      }
    } catch {
      // Silently fail — ticker is non-critical
    }
  };

  useEffect(() => {
    fetchLiveStats();
    const id = setInterval(fetchLiveStats, 30000);
    return () => clearInterval(id);
  }, []);

  // Default expand first sport group when sports load
  useEffect(() => {
    if (sportsLoaded && sports && Object.keys(sports).length > 0 && openGroup === null) {
      setOpenGroup(Object.keys(sports)[0]);
    }
  }, [sports, sportsLoaded, openGroup]);

  useEffect(() => {
    if (!user) return;
    fetchFriendPresence();
    const id = setInterval(fetchFriendPresence, 30000);
    return () => clearInterval(id);
  }, [user]);

  const handleLoadEvents = async () => {
    try {
      setLoadingEvents(true);
      const res = await fetch("/api/get-events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) throw new Error(`Error fetching events: ${res.status}`);
      const data = await res.json();
      setEvents(data);
    } catch (error) {
      setErrorEvents(t("home.errors.load_events"));
      console.error(error);
    } finally {
      setLoadingEvents(false);
    }
  };

  const fetchUserTokens = async () => {
    if (!user || !jwt) return;

    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/get-user-tokens", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${jwt}`,
        },
        credentials: "include",
      });

      if (!res.ok) throw new Error(`HTTP error: ${res.status}`);
      const data = await res.json();

      if (!data.success || !data.data) {
        const initRes = await fetch("/api/initialize-user-tokens", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${jwt}`,
          },
          credentials: "include",
        });
        if (!initRes.ok) throw new Error(`Init failed: ${initRes.status}`);

        const finalRes = await fetch("/api/get-user-tokens", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${jwt}`,
          },
          credentials: "include",
        });

        const finalData = await finalRes.json();
        if (finalData.success) {
          setUserTokens(finalData.data.balance);
        }
      } else {
        setUserTokens(data.data.balance);
      }
    } catch (err) {
      console.error("Token fetch error:", err);
      setError(t("home.errors.manage_tokens"));
      setUserTokens(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (user && jwt) fetchUserTokens();
  }, [user, jwt]);

  const useRevealOnScroll = (deps = []) => {
    useEffect(() => {
      const elements = document.querySelectorAll(".reveal, .reveal-stagger");

      const observer = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            if (entry.isIntersecting) {
              entry.target.classList.add("visible");
            }
          });
        },
        {
          threshold: 0.1,
          rootMargin: "0px 0px -50px 0px", // 👈 triggers earlier
        },
      );

      elements.forEach((el) => observer.observe(el));

      return () => observer.disconnect();
    }, deps);
  };

  useRevealOnScroll([sports]);

  const showNotification = (message, type = "info") => {
    setNotification({ message, type });
  };

  return (
    <div className="relative min-h-screen cyberpunk-grid">
      <NavigationBar currentPath="/" />

      <motion.section
        initial={fadeInVariant.initial}
        animate={fadeInVariant.animate}
        transition={fadeInVariant.transition}
        className="relative mt-8 px-6 sm:px-4 min-h-[55vh] sm:min-h-[65vh] md:min-h-[70vh] flex items-center overflow-hidden"
      >
        {/* Interactive SVG casino background — replaces the old static MP4.
            Layered depth field with cursor parallax, press ripples, and a
            magnetic orb. Includes its own mobile static fallback. */}
        <InteractiveCasinoBg />

        {/* Animated SVG overlays (chips, cards, dice, sparkles, …) */}
        <AnimatedBgSvgs />

        {/* Dark overlay for readability — pointer-events-none so the cursor
            orb in InteractiveCasinoBg (z-0 underneath) still receives
            pointermove events. */}
        <div className="absolute inset-0 bg-black/70 z-10 pointer-events-none" />
        <div className="absolute inset-0 z-10 pointer-events-none bg-[radial-gradient(circle_at_30%_20%,rgba(0,229,255,0.15),transparent_60%)] mix-blend-screen" />

        <div className="relative z-20 mx-auto max-w-7xl text-center reveal">
          <motion.h1
            initial={fadeUpVariant.initial}
            animate={fadeUpVariant.animate}
            transition={fadeUpVariant.transition}
            className="mb-4 text-3xl sm:text-5xl md:text-6xl font-black sm:font-extrabold text-transparent bg-clip-text
bg-gradient-to-r from-[#ff4fd8] via-[#9be8ff] to-[#ff4fd8]
tracking-widest uppercase drop-shadow-[0_0_12px_rgba(255,79,216,0.18)]"
            style={{
              backgroundSize: "200% auto",
              textShadow:
                "0 0 5px rgba(0,0,0,0.45), 0 0 1px rgba(255,255,255,0.5)",
            }}
          >
            {t("home.landing.title")}
          </motion.h1>

          <motion.p
            initial={fadeUpVariant.initial}
            animate={fadeUpVariant.animate}
            transition={{
              ...fadeUpVariant.transition,
              delay: shouldReduceMotion ? 0 : 0.05,
            }}
            className="mb-8 text-xl text-[#d8fbff] drop-shadow-[0_0_8px_rgba(0,0,0,0.7)]"
          >
            {t("home.landing.subtitle")}
          </motion.p>
          <motion.div
            variants={stagger}
            initial="initial"
            animate="animate"
            className="flex flex-col items-center space-y-5"
          >
            <motion.div
              whileHover={
                shouldReduceMotion ? undefined : hoverScale.whileHover
              }
              whileTap={shouldReduceMotion ? undefined : hoverScale.whileTap}
              transition={hoverScale.transition}
              className="w-full sm:w-auto"
            >
              <UIPro06PrimaryButton
                href="/sign-up"
                className="inline-block w-full sm:w-auto rounded-lg border border-[#f5ff3b]/40 bg-gradient-to-r from-[#00ffff] via-[#00e5ff] to-[#00ff88] px-10 py-5 text-xl font-bold text-[#041125] transition-all shadow-[0_0_35px_rgba(0,255,166,0.55)] hover:shadow-[0_0_55px_rgba(0,255,166,0.75)] hover:scale-105 animate-primary-cta-pulse focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff] focus-visible:ring-offset-2 focus-visible:ring-offset-[#030817]"
                aria-label={t("home.landing.start_betting")}
              >
                {t("home.landing.start_betting")}
              </UIPro06PrimaryButton>
              <p className="mt-3 text-sm text-[#7dd3fc]/70">{t("home.push_intro")}</p>
            </motion.div>
            <motion.div
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.15, duration: 0.3, ease: "easeOut" }}
              whileHover={
                shouldReduceMotion ? undefined : hoverScale.whileHover
              }
              whileTap={shouldReduceMotion ? undefined : hoverScale.whileTap}
            >
              <UIPro07SecondaryButton
                href="/casino"
                className="inline-block rounded-lg border border-[#ff4fd8]/40 bg-gradient-to-r from-[#a855f7] to-[#ff4fd8] px-6 py-3 text-base font-semibold text-[#041125] transition-all shadow-[0_0_35px_rgba(255,79,216,0.5)] hover:shadow-[0_0_55px_rgba(255,79,216,0.75)] hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#ff4fd8] focus-visible:ring-offset-2 focus-visible:ring-offset-[#030817]"
                aria-label={t("home.landing.discover_casino")}
              >
                {t("home.landing.discover_casino")}
              </UIPro07SecondaryButton>
            </motion.div>
          </motion.div>
        </div>
      </motion.section>

      {/* Value Proposition Strip */}
      <div className="mx-auto max-w-7xl px-4 py-6 reveal">          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div className="rounded-xl border border-[#00e5ff]/20 bg-[#040d24]/60 p-6 text-center backdrop-blur-sm transition-all hover:border-[#00e5ff]/35 hover:shadow-[0_0_20px_rgba(0,229,255,0.1)]">
            <svg className="w-10 h-10 mx-auto mb-3 text-[#00e5ff]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2a4 4 0 00-4 4c0 1.5.8 2.8 2 3.5V9a2 2 0 012-2h4a2 2 0 012 2v.5c1.2-.7 2-2 2-3.5a4 4 0 00-4-4z"/><path d="M9 22h6M12 18v4"/><circle cx="12" cy="12" r="3"/></svg>
            <h3 className="text-lg font-bold text-[#00e5ff] mb-1">{t("home.value_props.skill_based_title")}</h3>
            <p className="text-sm text-[#7dd3fc]">{t("home.value_props.skill_based_desc")}</p>
          </div>
          <div className="rounded-xl border border-[#f5ff3b]/20 bg-[#040d24]/60 p-6 text-center backdrop-blur-sm transition-all hover:border-[#f5ff3b]/35 hover:shadow-[0_0_20px_rgba(245,255,59,0.1)]">
            <svg className="w-10 h-10 mx-auto mb-3 text-[#f5ff3b]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="6" x2="12" y2="12"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg>
            <h3 className="text-lg font-bold text-[#f5ff3b] mb-1">{t("home.value_props.free_tokens_title")}</h3>
            <p className="text-sm text-[#7dd3fc]">{t("home.value_props.free_tokens_desc")}</p>
          </div>
          <div className="rounded-xl border border-[#ff4fd8]/20 bg-[#040d24]/60 p-6 text-center backdrop-blur-sm transition-all hover:border-[#ff4fd8]/35 hover:shadow-[0_0_20px_rgba(255,79,216,0.1)]">
            <svg className="w-10 h-10 mx-auto mb-3 text-[#ff4fd8]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4-4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/></svg>
            <h3 className="text-lg font-bold text-[#ff4fd8] mb-1">{t("home.value_props.multiplayer_title")}</h3>
            <p className="text-sm text-[#7dd3fc]">{t("home.value_props.multiplayer_desc")}</p>
          </div>
        </div>
      </div>

      {/* Live Stats Ticker */}
      {(liveStats.playersOnline > 0 || liveStats.gamesPlayedToday > 0) && (
        <div className="mx-auto max-w-7xl px-4 pb-4 reveal">
          <div className="flex flex-wrap items-center justify-center gap-4 sm:gap-8 rounded-xl border border-[#00e5ff]/20 bg-[#040d24]/50 px-6 py-3 backdrop-blur-sm">
            <div className="flex items-center gap-2 text-sm text-[#9dd8ff]">
              <span className="relative flex h-2.5 w-2.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-75"></span>
                <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-green-500"></span>
              </span>
              <span className="font-semibold text-[#d8fbff]">{liveStats.playersOnline.toLocaleString()}</span>
              {t("home.live_stats.players_online")}
            </div>
            <span className="hidden sm:inline text-[#00e5ff]/30">|</span>
            <div className="flex items-center gap-2 text-sm text-[#9dd8ff]">
              <svg className="w-4 h-4 text-[#f5ff3b]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 20V10"/><path d="M12 20V4"/><path d="M6 20v-6"/></svg>
              <span className="font-semibold text-[#d8fbff]">{liveStats.gamesPlayedToday.toLocaleString()}</span>
              {t("home.live_stats.games_played_today")}
            </div>
          </div>
        </div>
      )}

      {/* How It Works */}
      <div className="mx-auto max-w-7xl px-4 pb-8 reveal">
        <h2 className="text-2xl font-bold text-center text-[#f5ff3b] mb-8">{t("home.how_it_works_title")}</h2>          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div className="flex flex-col items-center text-center p-4">
            <div className="flex items-center justify-center w-12 h-12 rounded-full bg-[#00e5ff]/15 border border-[#00e5ff]/30 text-[#00e5ff] text-xl font-bold mb-3">1</div>
            <h3 className="text-base font-semibold text-[#d8fbff] mb-1">{t("home.how_it_works_steps.create_account_title")}</h3>
            <p className="text-sm text-[#7dd3fc]">{t("home.how_it_works_steps.create_account_desc")}</p>
          </div>
          <div className="flex flex-col items-center text-center p-4">
            <div className="flex items-center justify-center w-12 h-12 rounded-full bg-[#f5ff3b]/15 border border-[#f5ff3b]/30 text-[#f5ff3b] text-xl font-bold mb-3">2</div>
            <h3 className="text-base font-semibold text-[#d8fbff] mb-1">{t("home.how_it_works_steps.claim_tokens_title")}</h3>
            <p className="text-sm text-[#7dd3fc]">{t("home.how_it_works_steps.claim_tokens_desc")}</p>
          </div>
          <div className="flex flex-col items-center text-center p-4">
            <div className="flex items-center justify-center w-12 h-12 rounded-full bg-[#ff4fd8]/15 border border-[#ff4fd8]/30 text-[#ff4fd8] text-xl font-bold mb-3">3</div>
            <h3 className="text-base font-semibold text-[#d8fbff] mb-1">{t("home.how_it_works_steps.play_win_title")}</h3>
            <p className="text-sm text-[#7dd3fc]">{t("home.how_it_works_steps.play_win_desc")}</p>
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-7xl px-4 py-8" id="main-content">
        <section className="mb-16 reveal">
          <div className="mb-3">
            <h2 className="text-2xl font-bold text-[#f5ff3b]">
              {t("home.title")} — Pick Your Game
            </h2>              <p className="mt-1 text-sm text-[#7dd3fc]">{t("home.pick_your_game_subtitle")}</p>
          </div>

          <div className="grid grid-cols-1 gap-8 sm:grid-cols-2 lg:grid-cols-4 reveal-stagger">
            <motion.a
              initial={{ opacity: 0, y: 8 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, amount: 0.25 }}
              whileHover={{ scale: shouldReduceMotion ? 1 : 1.02 }}
              transition={{ duration: 0.25 }}
              href="/casino/roulette"
              aria-label="Play Roulette"
              className="group relative cursor-pointer overflow-hidden rounded-xl border border-[#00e5ff]/35 bg-[#040d24] p-4 transition-all duration-300 hover:-translate-y-1 hover:shadow-[0_0_20px_rgba(0,229,255,0.35)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff] focus-visible:ring-offset-2 focus-visible:ring-offset-[#040d24]"
            >
              <div className="mb-4 h-48 overflow-hidden rounded-lg relative">
                <Image
                  src={Img1}
                  alt={t("home.game_cards.roulette_alt")}
                  className="h-full w-full object-cover transition-transform group-hover:scale-110"
                />
                {/* Quick-play overlay */}
                <div className="absolute inset-0 flex items-center justify-center bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity duration-300">
                  <span className="flex items-center gap-2 rounded-lg bg-[#00e5ff]/90 px-4 py-2 text-sm font-bold text-[#030817]">
                    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
                    {t("home.play_now_overlay")}
                  </span>
                </div>
              </div>
              <h3 className="mb-2 text-xl font-bold text-[#f5ff3b]">
                {t("games.roulette_name")}
              </h3>
              <p className="text-[#9dd8ff]">{t("games.roulette_desc")}</p>
              {renderFriendWidget("roulette")}
            </motion.a>

            <motion.a
              initial={{ opacity: 0, y: 8 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, amount: 0.25 }}
              whileHover={{ scale: shouldReduceMotion ? 1 : 1.02 }}
              transition={{ duration: 0.25 }}
              href="/casino/blackjack"
              aria-label="Play Blackjack"
              className="group relative cursor-pointer overflow-hidden rounded-xl border border-[#00e5ff]/35 bg-[#040d24] p-4 transition-all duration-300 hover:-translate-y-1 hover:shadow-[0_0_20px_rgba(0,229,255,0.35)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff] focus-visible:ring-offset-2 focus-visible:ring-offset-[#040d24]"
            >
              <div className="mb-4 h-48 overflow-hidden rounded-lg relative">
                <Image
                  src={Img2}
                  alt={t("home.game_cards.blackjack_alt")}
                  className="h-full w-full object-cover transition-transform group-hover:scale-110"
                />
                <div className="absolute inset-0 flex items-center justify-center bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity duration-300">
                  <span className="flex items-center gap-2 rounded-lg bg-[#00e5ff]/90 px-4 py-2 text-sm font-bold text-[#030817]">
                    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
                    {t("home.play_now_overlay")}
                  </span>
                </div>
              </div>
              <h3 className="mb-2 text-xl font-bold text-[#f5ff3b]">
                {t("games.blackjack_name")}
              </h3>
              <p className="text-[#9dd8ff]">
                {t("home.game_cards.blackjack_desc")}
              </p>
              {renderFriendWidget("blackjack")}
            </motion.a>

            <motion.a
              initial={{ opacity: 0, y: 8 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, amount: 0.25 }}
              whileHover={{ scale: shouldReduceMotion ? 1 : 1.02 }}
              transition={{ duration: 0.25 }}
              href="/casino/poker"
              aria-label="Play Poker"
              className="group relative cursor-pointer overflow-hidden rounded-xl border border-[#00e5ff]/35 bg-[#040d24] p-4 transition-all duration-300 hover:-translate-y-1 hover:shadow-[0_0_20px_rgba(0,229,255,0.35)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff] focus-visible:ring-offset-2 focus-visible:ring-offset-[#040d24]"
            >
              <div className="mb-4 h-48 overflow-hidden rounded-lg relative">
                <Image
                  src={Img3}
                  alt={t("home.game_cards.poker_alt")}
                  className="h-full w-full object-cover transition-transform group-hover:scale-110"
                />
                <div className="absolute inset-0 flex items-center justify-center bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity duration-300">
                  <span className="flex items-center gap-2 rounded-lg bg-[#00e5ff]/90 px-4 py-2 text-sm font-bold text-[#030817]">
                    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
                    {t("home.play_now_overlay")}
                  </span>
                </div>
              </div>
              <h3 className="mb-2 text-xl font-bold text-[#f5ff3b]">{t("games.poker_name")}</h3>
              <p className="text-[#9dd8ff]">
                {t("home.game_cards.poker_desc")}
              </p>
              {renderFriendWidget("poker")}
            </motion.a>

            <motion.a
              initial={{ opacity: 0, y: 8 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, amount: 0.25 }}
              whileHover={{ scale: shouldReduceMotion ? 1 : 1.02 }}
              transition={{ duration: 0.25 }}
              href="/casino/plinko"
              aria-label="Play Plinko"
              className="group relative cursor-pointer overflow-hidden rounded-xl border border-[#00e5ff]/35 bg-[#040d24] p-4 transition-all duration-300 hover:-translate-y-1 hover:shadow-[0_0_20px_rgba(0,229,255,0.35)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff] focus-visible:ring-offset-2 focus-visible:ring-offset-[#040d24]"
            >
              <div className="mb-4 h-48 overflow-hidden rounded-lg relative">
                <Image
                  src={Img4}
                  alt={t("home.game_cards.plinko_alt")}
                  className="h-full w-full object-cover transition-transform group-hover:scale-110"
                />
                <div className="absolute inset-0 flex items-center justify-center bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity duration-300">
                  <span className="flex items-center gap-2 rounded-lg bg-[#00e5ff]/90 px-4 py-2 text-sm font-bold text-[#030817]">
                    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
                    {t("home.play_now_overlay")}
                  </span>
                </div>
              </div>
              <h3 className="mb-2 text-xl font-bold text-[#f5ff3b]">{t("games.plinko_name")}</h3>
              <p className="text-[#9dd8ff]">
                {t("home.game_cards.plinko_desc")}
              </p>
              {renderFriendWidget("plinko")}
            </motion.a>
          </div>

          {/* Bouton More centré sous la grille */}
          <div
            className="flex justify-center mt-8 reveal"
            style={{ animationDelay: "0.2s" }}
          >
            <a
              href="/casino"
              className="inline-block rounded-lg border border-[#f5ff3b]/40 bg-[#f5ff3b] px-6 py-3 text-base font-semibold text-[#031026] transition-all glow-pulse more-hover cyber-glow-button shadow-[0_0_16px_rgba(245,255,59,0.3)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f5ff3b] focus-visible:ring-offset-2 focus-visible:ring-offset-[#030817]"
            >
              {t("home.more_games")}
            </a>
          </div>
        </section>

        <section className="mb-16 reveal">
          <div className="mb-3">
            <h2 className="text-2xl font-bold text-[#00e5ff]">
              {t("home.live_sports_title")}
            </h2>
            <p className="mt-1 text-sm text-[#7dd3fc]">{t("home.live_sports_subtitle")}</p>
          </div>

          {loadingSports ? (
            <div className="space-y-4">
              {[1, 2, 3].map((i) => (
                <div
                  key={`sport-skeleton-${i}`}
                  className="rounded-lg border border-[#00e5ff]/15 bg-[#040d24]/40 px-4 py-4"
                >
                  <div className="h-5 w-40 animate-pulse rounded bg-[#06142f]/60" />
                </div>
              ))}
            </div>
          ) : (
            <div className="space-y-4">
              {Object.keys(sports).map((groupKey) => (
                <div
                  key={groupKey}
                  className="rounded-lg overflow-hidden border border-[#00e5ff]/30 reveal"
                >
                  <motion.button
                    whileHover={
                      shouldReduceMotion ? undefined : hoverScale.whileHover
                    }
                    transition={hoverScale.transition}
                    onClick={() =>
                      setOpenGroup(openGroup === groupKey ? null : groupKey)
                    }
                    aria-expanded={openGroup === groupKey}
                    aria-controls={`sport-group-${groupKey}`}
                    className="w-full flex justify-between items-center px-4 py-3
                   bg-[#06142f] text-[#00e5ff] font-bold hover:bg-[#0b224f] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff] focus-visible:ring-offset-2 focus-visible:ring-offset-[#050f24]"
                  >
                    <span>{groupKey}</span>
                    <span>{openGroup === groupKey ? "▲" : "▼"}</span>
                  </motion.button>

                  {openGroup === groupKey && (
                    <div id={`sport-group-${groupKey}`} className="grid grid-cols-2 gap-4 bg-[#050f24] p-4 md:grid-cols-3 lg:grid-cols-5 reveal-stagger">
                      {Array.isArray(sports[groupKey]) &&
                        sports[groupKey].map((league) => (
                          <SportCard
                            key={league.key}
                            icon="fa-trophy"
                            name={league.title}
                            onClick={() => {
                              // Navigate to /sport and pass league key
                              router.push(`/sport?league=${league.key}`);
                            }}
                          />
                        ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
          {/* Bouton {t("home.more_sports")} centré sous la grille */}
          <div className="flex justify-center mt-8">
            <a
              href="/sport"
              className="inline-block rounded-lg border border-[#00e5ff]/40 bg-[#00e5ff] px-6 py-3 text-base font-semibold text-[#041125] transition-all glow-pulse more-hover cyber-glow-button shadow-[0_0_16px_rgba(0,229,255,0.35)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff] focus-visible:ring-offset-2 focus-visible:ring-offset-[#030817]"
            >
              {t("home.more_sports")}
            </a>
          </div>
        </section>
      </div>

      <AnimatePresence>
        {notification && (
          <motion.div
            initial={fadeUpVariant.initial}
            animate={fadeUpVariant.animate}
            exit={fadeUpVariant.exit}
            transition={fadeUpVariant.transition}
          >
            <UIPro16ToastShell
              className={`fixed bottom-4 right-4 p-4 rounded-lg text-white ${
                notification.type === "success" ? "bg-green-600" : "bg-red-600"
              }`}
            >
              {notification.message}
            </UIPro16ToastShell>
          </motion.div>
        )}
      </AnimatePresence>
      {isSignedIn && (
        <div className="fixed left-4 top-20 z-50">
          <button
            onClick={() => setShowExpandedBadge(!showExpandedBadge)}
            className="group relative flex items-center gap-2 rounded-full bg-black/70 border border-amber-400/40 px-3 py-2 text-sm text-amber-300 backdrop-blur-sm hover:border-amber-400 hover:bg-black/85 transition-all shadow-[0_0_12px_rgba(251,191,36,0.15)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 focus-visible:ring-offset-2 focus-visible:ring-offset-[#030817]"
          >
            <span className="text-lg text-amber-400">
              <svg className="w-5 h-5 inline" viewBox="0 0 24 24" fill="currentColor"><path d="M12 23c-1.4 0-2.5-1.1-2.5-2.5 0-.5.1-.9.4-1.3-1.9-1-4.1-2.3-4.1-4.7 0-2.2 1.5-4 3.5-5.5C10 8.4 10.5 7.5 12 2c1.5 5.5 2 6.4 2.7 7 2 1.5 3.5 3.3 3.5 5.5 0 2.4-2.2 3.7-4.1 4.7.3.4.4.8.4 1.3 0 1.4-1.1 2.5-2.5 2.5z"/></svg>
            </span>
            <span className="font-bold">{streakData.dailyStreakCurrent || 0}</span>
            <span className="hidden sm:inline text-xs text-amber-200/70">
              {streakData.streakTitle || "days"}
            </span>
            <span className="text-[10px] text-amber-400/50">
              {showExpandedBadge ? "▲" : "▼"}
            </span>
          </button>
          {showExpandedBadge && (
            <div className="mt-1 rounded-xl border border-amber-400/30 bg-black/85 backdrop-blur-md p-3 text-xs text-amber-200 shadow-[0_0_20px_rgba(251,191,36,0.2)] w-52">
              <div className="flex justify-between mb-1">
                <span>{t("home.streak.daily_streak")}</span>
                <span className="font-bold text-amber-400">{streakData.dailyStreakCurrent || 0} {t("home.rewards.days")}</span>
              </div>
              <div className="flex justify-between mb-1">
                <span>{t("home.streak.best")}</span>
                <span className="text-amber-300">{streakData.dailyStreakBest || 0} {t("home.rewards.days")}</span>
              </div>
              {streakData.streakTitle && (
                <div className="flex justify-between mb-1">
                  <span>{t("home.streak.title")}</span>
                  <span className="text-amber-400 font-semibold">{streakData.streakTitle}</span>
                </div>
              )}
              {streakData.nextMilestone && (
                <div className="mt-2 pt-2 border-t border-amber-400/20">
                  <p className="text-[10px] text-amber-300/60 uppercase tracking-wider">{t("home.streak.next_milestone")}</p>
                  <div className="flex justify-between items-center">
                    <span className="font-semibold text-amber-400">{streakData.nextMilestone.title}</span>
                    <span className="text-amber-300">{streakData.nextMilestone.days} {t("home.rewards.days")}</span>
                  </div>
                  <div className="mt-1 h-1.5 w-full rounded-full bg-white/10 overflow-hidden">
                    <div
                      className="h-full rounded-full bg-gradient-to-r from-amber-400 to-amber-600 transition-all duration-500"
                      style={{
                        width: `${Math.min(100, ((streakData.dailyStreakCurrent || 0) / streakData.nextMilestone.days) * 100)}%`,
                      }}
                    />
                  </div>
                </div>
              )}
              {!streakData.nextMilestone && (streakData.dailyStreakCurrent || 0) >= 365 && (
                <p className="mt-2 text-center text-amber-400 font-bold">
                  <svg className="w-5 h-5 inline" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M2 4l3 12h14l3-12-6 7-4-7-4 7-6-7z"/><path d="M3 19h18"/></svg>
                  {t("home.streak.all_complete")}</p>
              )}
            </div>
          )}
        </div>
      )}
      {isSignedIn && !dailyRewardCooldown && (
        <button
          onClick={claimDailyReward}
          className="fixed right-4 bottom-16 z-50 rounded-lg px-4 py-2 text-sm font-semibold text-[#031026] transition-all shadow-lg bg-[#FFD700] hover:scale-110 animate-pulse border border-amber-400/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 focus-visible:ring-offset-2 focus-visible:ring-offset-[#030817]"
          title={t("home.rewards.claim_daily_title")}
        >
          {t("home.rewards.claim_button")}
        </button>
      )}

      {isSignedIn && dailyRewardCooldown && (
        <div className="fixed right-4 bottom-16 z-50 text-sm text-[#FFD700] bg-black/60 px-3 py-2 rounded-lg">
          <svg className="w-4 h-4 inline mr-1" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
          {t("home.rewards.next_reward_in")} {cooldownTimeLeft}
        </div>
      )}
      {/* reward modal */}
      <AnimatePresence>
        {rewardPopupVisible && (
          <UIPro17ModalBackdrop className="fixed inset-0 flex items-center justify-center bg-black/80 z-50">
            <motion.div
              initial={modalBackdropVariant.initial}
              animate={modalBackdropVariant.animate}
              exit={modalBackdropVariant.exit}
              transition={modalBackdropVariant.transition}
              className="absolute inset-0"
            />
            <motion.div
              initial={modalPanelVariant.initial}
              animate={modalPanelVariant.animate}
              exit={modalPanelVariant.exit}
              transition={modalPanelVariant.transition}
              className="relative z-10"
            >
              <UIPro18ModalPanel
                className="bg-gradient-to-b from-[#003366] to-[#001a33] 
                border-2 border-[#FFD700]
                p-6 rounded-2xl text-white 
                max-w-4xl w-[95%] text-center shadow-2xl
                max-h-[90vh] overflow-y-auto"
              >
                <h2 className="text-3xl font-extrabold text-[#FFD700] mb-2 flex items-center justify-center gap-2">
                  <svg className="w-8 h-8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M12 2l2.4 7.2h7.6l-6 4.8 2.4 7.2-6.4-4.8-6.4 4.8 2.4-7.2-6-4.8h7.6z"/></svg>
                  {t("home.rewards.modal_title")}
                </h2>

                <p className="mb-6 text-lg">
                  {t("home.rewards.day")}{" "}
                  <span className="text-[#FFD700] font-bold">{claimedDay}</span>{" "}
                  {t("home.rewards.claimed")}!
                </p>

                {/* 14 DAY GRID */}
                <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-7 gap-3 mb-6">
                  {Array.from({ length: streakData.maxDay || 14 }).map(
                    (_, i) => {
                      const day = i + 1;
                      const reward = 100 * 2 ** (day - 1);

                      const claimed = day < claimedDay;
                      const isToday = day === claimedDay;

                      return (
                        <div
                          key={day}
                          className={`relative flex flex-col items-center justify-center
  rounded-xl p-3 border font-bold transition-all overflow-hidden

  ${
    claimed
      ? "bg-green-500/20 border-green-400"
      : isToday
        ? "bg-[#FFD700]/20 border-[#FFD700] scale-105"
        : "bg-white/5 border-white/10"
  }
  `}
                        >
                          {/* DARK OVERLAY */}
                          {claimed && (
                            <div className="absolute inset-0 bg-black/60 backdrop-blur-[2px] flex items-center justify-center z-10">
                              <svg className="w-8 h-8 text-green-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M20 6L9 17l-5-5"/></svg>
                            </div>
                          )}

                          <div className="text-sm">
                            {t("home.rewards.day")} {day}
                          </div>

                          <div className="text-lg flex justify-center gap-0.5 flex-wrap">
                            {Array.from({ length: Math.min(day, 5) }).map((_, j) => (
                              <svg key={j} className="w-5 h-5 text-[#FFD700]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="12" cy="12" r="10" fill="currentColor" fillOpacity="0.15"/><circle cx="12" cy="12" r="6" fill="currentColor" fillOpacity="0.3"/></svg>
                            ))}
                          </div>

                          <div className="text-xs text-[#FFD700]">
                            {reward.toLocaleString()}
                          </div>
                        </div>
                      );
                    },
                  )}
                </div>

                {/* Streak message */}
                <div className="mb-4 text-lg">
                  <svg className="w-5 h-5 inline text-amber-400" viewBox="0 0 24 24" fill="currentColor"><path d="M12 23c-1.4 0-2.5-1.1-2.5-2.5 0-.5.1-.9.4-1.3-1.9-1-4.1-2.3-4.1-4.7 0-2.2 1.5-4 3.5-5.5C10 8.4 10.5 7.5 12 2c1.5 5.5 2 6.4 2.7 7 2 1.5 3.5 3.3 3.5 5.5 0 2.4-2.2 3.7-4.1 4.7.3.4.4.8.4 1.3 0 1.4-1.1 2.5-2.5 2.5z"/></svg>
                  {t("home.rewards.current_streak")}:
                  <span className="text-[#FFD700] font-bold">
                    {" "}
                    {streakData.dailyStreakCurrent || streakData.currentDay} {t("home.rewards.days")}
                  </span>
                  {streakData.dailyStreakBest > 0 && (
                    <span className="text-sm text-white/50">
                      {" "}(Best: {streakData.dailyStreakBest})
                    </span>
                  )}
                </div>

                {/* Milestone bonus celebration */}
                {milestoneBonus > 0 && (
                  <div className="mb-4 rounded-xl border-2 border-amber-400 bg-gradient-to-r from-amber-500/20 to-amber-600/20 p-4 animate-pulse">
                    <p className="text-lg font-bold text-amber-300">
                      <svg className="w-6 h-6 inline text-amber-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M6 9H4.5a2.5 2.5 0 010-5H6"/><path d="M18 9h1.5a2.5 2.5 0 000-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0012 0V2Z"/></svg>
                      Streak Milestone Reached!
                    </p>
                    <p className="text-2xl font-extrabold text-amber-400 mt-1">
                      {milestoneTitle}
                    </p>
                    <p className="text-lg mt-1">
                      <span className="text-amber-300 font-bold">+{milestoneBonus.toLocaleString()} bonus tokens!</span>
                    </p>
                  </div>
                )}

                <button
                  onClick={async () => {
                    setRewardPopupVisible(false);
                    await fetchRewardStatus(); // refresh AFTER closing
                  }}
                  className="mt-2 px-6 py-3 
                   bg-[#FFD700] text-[#003366] 
                   font-bold rounded-lg border border-amber-400/30
                   hover:scale-105 transition-all shadow-[0_0_16px_rgba(255,215,0,0.3)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 focus-visible:ring-offset-2 focus-visible:ring-offset-[#001a33]"
                >
                  {t("ui.confirm")}
                </button>
              </UIPro18ModalPanel>
            </motion.div>
          </UIPro17ModalBackdrop>
        )}
      </AnimatePresence>

      {/* ── Terms & Conditions Modal ── */}
      <AnimatePresence>
        {showTermsModal && (
          <UIPro17ModalBackdrop className="fixed inset-0 z-[100] flex items-center justify-center bg-black/85 backdrop-blur-sm">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0"
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 10 }}
              transition={{ duration: 0.3 }}
            >
              <div
                role="dialog"
                aria-modal="true"
                aria-labelledby="terms-modal-title"
                className="relative mx-4 max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-[#00e5ff]/30 bg-gradient-to-b from-[#030817] to-[#0a1a3d] p-6 shadow-[0_0_40px_rgba(0,229,255,0.15)] md:p-8"
              >
                {/* Header */}
                <div className="mb-6 text-center">
                  <h2 id="terms-modal-title" className="mb-2 text-3xl font-extrabold text-transparent bg-clip-text bg-gradient-to-r from-[#00e5ff] to-[#f5ff3b]">
                    {t("home.terms.title")}
                  </h2>
                  <p className="text-sm text-[#9dd8ff]">
                    {t("home.terms.subtitle")}
                  </p>
                </div>

                {/* Terms Content */}
                <div className="mb-6 space-y-4 rounded-lg border border-[#00e5ff]/10 bg-[#040d24]/60 p-4 text-sm leading-relaxed text-[#c9f7ff]/90 md:p-6">
                  <p>
                    <strong className="text-[#00e5ff]">{t("home.terms.welcome")}</strong> {t("home.terms.intro_lead")}
                  </p>

                  <div className="space-y-3">
                    <div>
                      <strong className="text-[#f5ff3b]">{t("home.terms.eligibility_label")}</strong> {t("home.terms.eligibility_body")}
                    </div>
                    <div>
                      <strong className="text-[#f5ff3b]">{t("home.terms.account_label")}</strong> {t("home.terms.account_body")}
                    </div>
                    <div>
                      <strong className="text-[#f5ff3b]">{t("home.terms.virtual_tokens_label")}</strong> {t("home.terms.virtual_tokens_body")}
                    </div>
                    <div>
                      <strong className="text-[#f5ff3b]">{t("home.terms.fair_play_label")}</strong> {t("home.terms.fair_play_body")}
                    </div>
                    <div>
                      <strong className="text-[#f5ff3b]">{t("home.terms.prohibited_label")}</strong> {t("home.terms.prohibited_body")}
                    </div>
                    <div>
                      <strong className="text-[#f5ff3b]">{t("home.terms.privacy_label")}</strong> {t("home.terms.privacy_body")}
                    </div>
                    <div>
                      <strong className="text-[#f5ff3b]">{t("home.terms.termination_label")}</strong> {t("home.terms.termination_body")}
                    </div>
                  </div>

                  <p className="pt-2 text-xs text-[#6b91b3]">
                    {t("home.terms.by_clicking_lead", { action: t("home.terms.i_agree") })}{" "}
                    <Link href="/terms" className="text-[#00e5ff] underline hover:text-[#f5ff3b]">
                      {t("home.terms.full_tos")}
                    </Link>
                    ,{" "}
                    <Link href="/privacy-policy" className="text-[#00e5ff] underline hover:text-[#f5ff3b]">
                      {t("home.terms.privacy_policy")}
                    </Link>
                    , and{" "}
                    <Link href="/fair-play" className="text-[#00e5ff] underline hover:text-[#f5ff3b]">
                      {t("home.terms.fair_play_policy")}
                    </Link>
                    , and{" "}
                    <Link href="/accessibility" className="text-[#00e5ff] underline hover:text-[#f5ff3b]">
                      {t("home.terms.accessibility_policy")}
                    </Link>
                    .
                  </p>
                </div>

                {/* Buttons */}
                <div className="flex flex-col gap-3 sm:flex-row sm:justify-center">
                  <button
                    onClick={handleAcceptTerms}
                    className="rounded-lg border border-[#00e5ff]/40 bg-gradient-to-r from-[#00e5ff] to-[#00ffa6] px-6 py-3 text-base font-bold text-[#041125] transition-all hover:shadow-[0_0_30px_rgba(0,229,255,0.5)] hover:scale-105 shadow-[0_0_16px_rgba(0,255,166,0.3)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff] focus-visible:ring-offset-2 focus-visible:ring-offset-[#030817]"
                  >
                    {t("home.terms.i_agree")}
                  </button>
                  <button
                    onClick={handleRejectTerms}
                    className="rounded-lg border border-red-500/40 bg-red-500/10 px-6 py-3 text-base font-bold text-red-400 transition-all hover:bg-red-500/20 hover:shadow-[0_0_20px_rgba(239,68,68,0.3)] hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400 focus-visible:ring-offset-2 focus-visible:ring-offset-[#030817]"
                  >
                    {t("home.terms.i_disagree")}
                  </button>
                </div>

                <p className="mt-4 text-center text-xs text-[#6b91b3]">
                  {t("home.terms.must_accept")}
                </p>
              </div>
            </motion.div>
          </UIPro17ModalBackdrop>
        )}
      </AnimatePresence>
      <Footer />
    </div>
  );
}

export default MainComponent;
