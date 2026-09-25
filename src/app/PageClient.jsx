"use client";
import React, { useState, useEffect } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useRouter } from "next/navigation"; // add this at the top
import Link from "next/link";
import NavigationBar from "../components/navigation-bar";
import Footer from "../components/Footer";
import SocialLinks from "../components/SocialLinks";
import ReviewWall from "../components/reviews/ReviewWall";
import InteractiveCasinoBg from "../components/InteractiveCasinoBg";
import IconAvatar from "../components/IconAvatar";
import { clearSessionArtifacts } from "../lib/security/sessionCleanup";
import { useUser, useAuth } from "@clerk/nextjs";
import Image from "next/image";
import Img1 from "../images/roulette.webp";
import Img2 from "../images/blackjack-div.webp";
import Img3 from "../images/poker.jpg";
import Img4 from "../images/plinko-div.webp";
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
  UIPro17ModalBackdrop,
  UIPro18ModalPanel,
} from "../components/uipro";
import { useToast } from "../components/toast/ToastProvider";
import { useTranslation } from "../hooks/useTranslation";
import StickyMobileCta from "../components/StickyMobileCta";
import UpgradeProButton from "../components/UpgradeProButton";
import {
  REWARD_RARITIES,
  REWARD_TYPES,
} from "../lib/battlepassRewards";

// `adSlot` is a server-rendered <AdSlot /> handed down by app/page.jsx. It is
// rendered above the footer and carries its OWN server-side entitlement check —
// nothing about membership is passed from here.
function MainComponent({ adSlot = null }) {
  const router = useRouter();
  const { isLoaded, isSignedIn, signOut } = useAuth();
  const { user } = useUser();
  // Note: the balance lives in the navbar (single source of truth). The
  // home page deliberately does NOT fetch /api/get-user-tokens itself — the
  // navbar already does that on every page, and a duplicate fetch here was
  // pure waste (its state was never read by any UI).
  const [dailyRewardCooldown, setDailyRewardCooldown] = useState(false);
  const [nextRewardTime, setNextRewardTime] = useState(null); // timestamp for cooldown
  const [cooldownTimeLeft, setCooldownTimeLeft] = useState("");
  const [rewardPopupVisible, setRewardPopupVisible] = useState(false);
  // GRYND PRO membership state for the daily-claim surfaces
  // from the last claim.
  const [membership, setMembership] = useState(null);
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
  // Daily / weekly challenges widget.
  const [showChallenges, setShowChallenges] = useState(false);
  const [challengeTab, setChallengeTab] = useState("daily");
  const [quests, setQuests] = useState({ daily: [], weekly: [] });
  const [questsLoading, setQuestsLoading] = useState(false);
  const [claimingQuestId, setClaimingQuestId] = useState(null);
  const [rerollingQuestId, setRerollingQuestId] = useState(null);
  const [questError, setQuestError] = useState(null);
  const [claimedDay, setClaimedDay] = useState(null);
  // Battlepass widget — level, next reward and progress toward it.
  const [showBattlepass, setShowBattlepass] = useState(false);
  const [battlepass, setBattlepass] = useState(null);
  const [battlepassLoading, setBattlepassLoading] = useState(false);
  const [battlepassError, setBattlepassError] = useState(null);
  const [friendPresenceByGame, setFriendPresenceByGame] = useState({});
  const [showTermsModal, setShowTermsModal] = useState(false);
  const [termsLoading, setTermsLoading] = useState(true);
  const [liveStats, setLiveStats] = useState({ playersOnline: 0, gamesPlayedToday: 0 });
  // Weekly leaderboard (top 5) — REAL data from /api/leaderboard/weekly.
  // The section renders nothing but a link if the fetch fails: we never
  // fabricate ranks, wins, or player counts.
  const [leaderboard, setLeaderboard] = useState({
    items: [],
    loading: true,
    error: null,
  });
  // First-match recovery nudge — shown to signed-in accounts that never
  // finished onboarding (abandoned the /welcome flow mid-way). Real signal
  // from /api/onboarding/status; dismissible per session.
  const [firstMatchNudge, setFirstMatchNudge] = useState(false);
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
        {friends.slice(0, 4).map((friend) => (
          <IconAvatar
            key={`${friend.id}-${friend.name}`}
            iconKey={friend.iconKey}
            name={friend.name}
            size="h-6 w-6"
            className="border border-white/30"
          />
        ))}
      </div>
    );
  };

  const loadQuests = async () => {
    if (!user || !isSignedIn) return;
    setQuestsLoading(true);
    setQuestError(null);
    try {
      const res = await fetch("/api/quests", { credentials: "include" });
      const data = await res.json();
      if (!data.success) {
        setQuestError(data.error || "Failed to load quests");
        return;
      }
      setQuests({
        daily: Array.isArray(data.daily) ? data.daily : [],
        weekly: Array.isArray(data.weekly) ? data.weekly : [],
      });
    } catch (err) {
      console.error("[QUESTS_LOAD_ERROR]", err);
      setQuestError("Failed to load quests");
    } finally {
      setQuestsLoading(false);
    }
  };

  const claimQuest = async (questId) => {
    if (claimingQuestId) return;
    setClaimingQuestId(questId);
    setQuestError(null);
    try {
      const res = await fetch("/api/quests/claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ questId }),
      });
      const data = await res.json();
      if (!data.success) {
        setQuestError(data.error || "Failed to claim quest");
        return;
      }
      // Mark the quest claimed locally + credit the balance display.
      setQuests((prev) => ({
        daily: prev.daily.map((q) =>
          q.id === questId ? { ...q, claimed: true } : q
        ),
        weekly: prev.weekly.map((q) =>
          q.id === questId ? { ...q, claimed: true } : q
        ),
      }));
    } catch (err) {
      console.error("[QUESTS_CLAIM_ERROR]", err);
      setQuestError("Failed to claim quest");
    } finally {
      setClaimingQuestId(null);
    }
  };

  const rerollQuest = async (questId) => {
    if (rerollingQuestId || claimingQuestId) return;
    setRerollingQuestId(questId);
    setQuestError(null);
    try {
      const res = await fetch("/api/quests/reroll", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ questId }),
      });
      const data = await res.json();
      if (!data.success) {
        setQuestError(data.error || "Failed to reroll quest");
        return;
      }
      // Swap the rerolled quest in place (daily only — the server keeps
      // the same slot, refreshed content, reset progress).
      setQuests((prev) => ({
        daily: prev.daily.map((q) =>
          q.id === questId
            ? { ...q, ...data.quest, id: data.quest.questId, claimed: !!data.quest.claimed }
            : q
        ),
        weekly: prev.weekly,
      }));
    } catch (err) {
      console.error("[QUESTS_REROLL_ERROR]", err);
      setQuestError("Failed to reroll quest");
    } finally {
      setRerollingQuestId(null);
    }
  };

  const loadBattlepass = async () => {
    if (!user || !isSignedIn) return;
    setBattlepassLoading(true);
    setBattlepassError(null);
    try {
      const res = await fetch("/api/battlepass", {
        credentials: "include",
      });
      const data = await res.json();
      if (!data.success) {
        setBattlepassError(data.error || "Failed to load battlepass");
        return;
      }
      setBattlepass(data.pass);
    } catch (err) {
      console.error("[BATTLEPASS_LOAD_ERROR]", err);
      setBattlepassError("Failed to load battlepass");
    } finally {
      setBattlepassLoading(false);
    }
  };

  const questTitle = (q) => {
    const game = q.gameKey
      ? t(`home.challenges.game_${q.gameKey}`)
      : null;
    const count = Number(q.target).toLocaleString();
    const amount = Number(q.target).toLocaleString();
    const x = Number(q.target);
    switch (q.questType) {
      case "play":
        return game
          ? t("home.challenges.play_game", { count, game })
          : t("home.challenges.play_any", { count });
      case "win":
        return game
          ? t("home.challenges.win_game", { count, game })
          : t("home.challenges.win_any", { count });
      case "wager":
        return t("home.challenges.wager", { amount });
      case "multiplier":
        return t("home.challenges.multiplier", { x });
      case "streak":
        return t("home.challenges.streak", { count });
      case "diversify":
        return t("home.challenges.diversify", { count });
      case "pvp":
        return t("home.challenges.pvp", { count });
      default:
        return q.questType;
    }
  };

  const questProgressPct = (q) => {
    const target = Number(q.target);
    if (!target) return 0;
    return Math.min(100, Math.round((Number(q.progress) / target) * 100));
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

  // Load today's daily + weekly quests once signed in.
  useEffect(() => {
    if (isLoaded && isSignedIn) loadQuests();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoaded, isSignedIn]);

  // Load the battlepass widget data once signed in.
  useEffect(() => {
    if (isLoaded && isSignedIn) loadBattlepass();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoaded, isSignedIn]);

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
      clearSessionArtifacts();
      await signOut();
    }
    router.push("/");
  };

  useEffect(() => {
    fetchRewardStatus();
  }, [user, isSignedIn]);

  // Fetch GRYND PRO membership status for the daily-claim surfaces
  // login bonus state.
  useEffect(() => {
    if (!isSignedIn) {
      setMembership(null);
      return;
    }
    let cancelled = false;
    fetch("/api/membership/status", { credentials: "include" })
      .then((res) => res.json().catch(() => ({})))
      .then((data) => {
        if (!cancelled && data?.success) {
          setMembership(data.active ? data : null);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [isSignedIn, user]);

  const claimDailyReward = async () => {
    if (!user || !isSignedIn) {
      showToast(t("home.rewards.must_sign_in"), "error");
      return;
    }

    try {
      const res = await fetch("/api/claim-login-reward", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}), // REQUIRED
        credentials: "include",
      });
      const data = await res.json();

      if (!res.ok || !data.success) {
        showToast(data.error || t("home.rewards.claim_error"), "error");
        return;
      }

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
      showToast(err.message || t("home.rewards.claim_error"), "error");
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

  // Live-stats ticker: only poll while the tab is actually visible — a
  // backgrounded tab (the norm on mobile) doesn't need fresh numbers and
  // shouldn't burn the network/battery on them.
  useEffect(() => {
    let id = null;
    const start = () => {
      fetchLiveStats();
      id = setInterval(fetchLiveStats, 30000);
    };
    const stop = () => {
      if (id) {
        clearInterval(id);
        id = null;
      }
    };
    const onVisibility = () =>
      document.visibilityState === "visible" ? start() : stop();
    start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  // First-time recovery: a brand-new account that bailed out of the
  // /welcome flow lands on the home page with no path back into their first
  // match. If the server says onboarding isn't complete, surface a nudge
  // that jumps straight into the free first match (that page re-checks the
  // flag itself, so no false starts). Never shown to returning players.
  useEffect(() => {
    if (!isLoaded || !isSignedIn) {
      setFirstMatchNudge(false);
      return;
    }
    let cancelled = false;
    const dismissKey = "grynd:first-match:nudge:dismissed";
    try {
      if (sessionStorage.getItem(dismissKey) === "1") {
        setFirstMatchNudge(false);
        return;
      }
    } catch {
      // sessionStorage unavailable — still allow the nudge
    }
    fetch("/api/onboarding/status", { credentials: "include" })
      .then((res) => res.json().catch(() => null))
      .then((data) => {
        if (cancelled) return;
        setFirstMatchNudge(
          Boolean(data?.success && data.onboardingCompleted === false),
        );
      })
      .catch(() => {
        if (!cancelled) setFirstMatchNudge(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isLoaded, isSignedIn]);

  const dismissFirstMatchNudge = () => {
    setFirstMatchNudge(false);
    try {
      sessionStorage.setItem("grynd:first-match:nudge:dismissed", "1");
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(
          "/api/leaderboard/weekly?limit=5&category=wins",
          { cache: "no-store" },
        );
        const data = await res.json();
        if (cancelled) return;
        if (res.ok && Array.isArray(data.items)) {
          setLeaderboard({ items: data.items, loading: false, error: null });
        } else {
          setLeaderboard({ items: [], loading: false, error: "load_failed" });
        }
      } catch {
        if (!cancelled) {
          setLeaderboard({ items: [], loading: false, error: "load_failed" });
        }
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!user) return;
    // Friend presence is social chrome, not game state. Throttled from 30s
    // to 60s (and the endpoint now caches per user) to cut idle read load.
    // Only poll while the tab is visible — background tabs don't need it.
    let id = null;
    const start = () => {
      fetchFriendPresence();
      id = setInterval(fetchFriendPresence, 60000);
    };
    const stop = () => {
      if (id) {
        clearInterval(id);
        id = null;
      }
    };
    const onVisibility = () =>
      document.visibilityState === "visible" ? start() : stop();
    start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [user]);

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
          rootMargin: "0px 0px -50px 0px", // triggers earlier
        },
      );

      elements.forEach((el) => observer.observe(el));

      return () => observer.disconnect();
    }, deps);
  };

  useRevealOnScroll([]);

  // Global branded toasts (UX plan P0-1) — replaces the old local toast.
  const { showToast } = useToast();

  // Derived battlepass widget values — the next reward is the first reward
  // of the upcoming level (reserved-empty levels show "soon").
  const battlepassLevel = battlepass?.level ?? 1;
  const battlepassMaxed = battlepass
    ? battlepass.level >= battlepass.maxLevel
    : false;
  const nextBattlepassLevel =
    battlepass?.levels?.find((l) => l.level === battlepassLevel + 1) || null;
  const nextBattlepassReward = nextBattlepassLevel?.rewards?.[0] || null;
  const nextRewardColor = nextBattlepassReward
    ? nextBattlepassReward.type === "color" && nextBattlepassReward.value
      ? nextBattlepassReward.value
      : REWARD_RARITIES[nextBattlepassReward.rarity] ||
        REWARD_TYPES[nextBattlepassReward.type]?.color ||
        "#9ca3af"
    : "#9ca3af";

  return (
    <div className="relative min-h-screen cyberpunk-grid pb-32 md:pb-0">
      <NavigationBar currentPath="/" />

      <motion.section
        initial={fadeInVariant.initial}
        animate={fadeInVariant.animate}
        transition={fadeInVariant.transition}
        className="relative mt-4 px-4 sm:mt-8 sm:px-4 min-h-[52vh] sm:min-h-[65vh] md:min-h-[70vh] flex items-center overflow-hidden"
      >
        {/* Interactive SVG casino background — replaces the old static MP4.
            Layered depth field with cursor parallax, press ripples, and a
            magnetic orb. Includes its own mobile static fallback. */}
        <InteractiveCasinoBg />

        {/* Dark overlay for readability — pointer-events-none so the cursor
            orb in InteractiveCasinoBg (z-0 underneath) still receives
            pointermove events. The chips/cards/dice depth layer that used
            to live here (AnimatedBgSvgs, 10 infinite framer-motion loops)
            was removed: InteractiveCasinoBg already draws the same motif,
            and this layer sat beneath the dark overlay so it was never
            visible on top of it. */}
        <div className="absolute inset-0 bg-black/70 z-10 pointer-events-none" />
        <div className="absolute inset-0 z-10 pointer-events-none bg-[radial-gradient(circle_at_30%_20%,rgba(0,229,255,0.15),transparent_60%)] mix-blend-screen" />

        <div className="relative z-20 mx-auto max-w-7xl text-center reveal">
          <motion.h1
            initial={fadeUpVariant.initial}
            animate={fadeUpVariant.animate}
            transition={fadeUpVariant.transition}
            className="mb-4 text-[1.75rem] leading-[1.15] sm:text-5xl md:text-6xl font-black sm:font-extrabold tracking-[0.08em] sm:tracking-widest uppercase"
          >
            <span
              className="block text-[#f5ff3b]"
              style={{ textShadow: "0 0 14px rgba(255,215,0,0.45)" }}
            >
              {t("home.landing.title_line1")}
            </span>
            <span
              className="mt-1 block text-transparent bg-clip-text bg-gradient-to-r from-[#00e5ff] via-[#7cefff] to-[#ff4fd8]"
              style={{ filter: "drop-shadow(0 0 14px rgba(0,229,255,0.5))" }}
            >
              {t("home.landing.title_line2")}
            </span>
          </motion.h1>

          <motion.p
            initial={fadeUpVariant.initial}
            animate={fadeUpVariant.animate}
            transition={{
              ...fadeUpVariant.transition,
              delay: shouldReduceMotion ? 0 : 0.05,
            }}
            className="mb-7 mx-auto max-w-2xl text-base sm:text-xl text-[#d8fbff] drop-shadow-[0_0_8px_rgba(0,0,0,0.7)]"
          >
            {t("home.landing.subtitle")}
          </motion.p>
          <motion.div
            variants={stagger}
            initial="initial"
            animate="animate"
            className="flex flex-col items-center gap-4"
          >
            <div className="flex flex-col items-center gap-3 sm:flex-row sm:gap-4">
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
                className="inline-block w-full sm:w-auto rounded-lg border border-[#f5ff3b]/60 bg-gradient-to-r from-[#ffd700] via-[#f5ff3b] to-[#ffb800] px-6 py-3.5 text-lg font-bold text-[#1f1700] transition-all shadow-[0_0_35px_rgba(245,255,59,0.5)] hover:shadow-[0_0_55px_rgba(245,255,59,0.8)] hover:scale-105 animate-primary-cta-pulse focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f5ff3b] focus-visible:ring-offset-2 focus-visible:ring-offset-[#030817]"
                aria-label={t("home.landing.start_betting")}
              >
                {t("home.landing.start_betting")}
              </UIPro06PrimaryButton>
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
                href="/games"
                className="inline-block w-full sm:w-auto rounded-lg border border-[#ff4fd8]/40 bg-gradient-to-r from-[#a855f7] to-[#ff4fd8] px-6 py-3.5 text-base font-semibold text-[#041125] transition-all shadow-[0_0_35px_rgba(255,79,216,0.5)] hover:shadow-[0_0_55px_rgba(255,79,216,0.75)] hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#ff4fd8] focus-visible:ring-offset-2 focus-visible:ring-offset-[#030817]"
                aria-label={t("home.landing.discover_casino")}
              >
                {t("home.landing.discover_casino")}
              </UIPro07SecondaryButton>
            </motion.div>
          </div>
          {/* Trust / value signals — every claim maps to a real capability:
              PvP duels, matchmaking + leaderboards, weekly ranks, free start. */}
          <div className="mt-5 flex flex-wrap items-center justify-center gap-2 sm:gap-3">
            {[
              { key: "home.landing.trust_real_pvp", cls: "text-[#00e5ff] border-[#00e5ff]/40" },
              { key: "home.landing.trust_compete", cls: "text-[#f5ff3b] border-[#f5ff3b]/40" },
              { key: "home.landing.trust_climb", cls: "text-[#00ffa6] border-[#00ffa6]/40" },
              { key: "home.landing.trust_free_start", cls: "text-[#ff4fd8] border-[#ff4fd8]/40" },
            ].map((item) => (
              <span
                key={item.key}
                className={`rounded-full border bg-black/40 px-3 py-1 text-[10px] sm:text-xs font-black uppercase tracking-[0.18em] backdrop-blur-sm ${item.cls}`}
              >
                {t(item.key)}
              </span>
            ))}
          </div>

          {/* Product Hunt featured badge — kept in the hero, under the CTAs,
              so visitors actually see it (plain <a>/<img> embed; not routed
              through next/image since it's a third-party badge image). */}
          <div className="mt-6 flex justify-center">
            <a
              href="https://www.producthunt.com/products/grynd?embed=true&utm_source=badge-featured&utm_medium=badge&utm_campaign=badge-grynd"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="GRYND on Product Hunt"
            >
              <img
                alt="GRYND - Competitive multiplayer games, built to outplay. | Product Hunt"
                width={250}
                height={54}
                src="https://api.producthunt.com/widgets/embed-image/v1/featured.svg?post_id=1251858&theme=dark&t=1789866264006"
                className="h-[54px] w-[250px]"
              />
            </a>
          </div>
          </motion.div>
        </div>
      </motion.section>

      {/* GRYND PRO — the only paid membership, and the only place on the home
          page that talks about it. Replaces the old Shop entry point; the CTA
          is a reusable UpgradeProButton, so the price and the entitlement come
          from the server, never from this markup. */}
      <div className="mx-auto max-w-7xl px-4 pt-8 reveal">
        <div className="relative overflow-hidden rounded-2xl border border-[#f5ff3b]/40 bg-gradient-to-r from-[#0a214d]/90 to-[#08142f]/90 px-5 py-5 shadow-[0_0_30px_rgba(245,255,59,0.12)]">
          <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <p className="text-[11px] font-bold uppercase tracking-[0.25em] text-[#00e5ff]">
                ✦ Membership
              </p>
              <h2 className="mt-1 text-2xl font-black tracking-tight text-[#f5ff3b] sm:text-3xl">
                GRYND PRO
              </h2>
              <p className="mt-1 max-w-2xl text-sm text-[#d8fbff]">
                Compete without distractions: ad-free, with advanced statistics,
                advanced performance analytics and detailed match history. Every
                game, rank and reward stays free — PRO never changes your odds,
                Elo or matchmaking.
              </p>
            </div>
            <div className="w-full shrink-0 sm:w-auto">
              <UpgradeProButton />
            </div>
          </div>
        </div>
      </div>

      {/* First-match recovery — only for accounts that abandoned onboarding */}
      {firstMatchNudge && (
        <div className="mx-auto max-w-7xl px-4 py-4 reveal">
          <div className="relative overflow-hidden rounded-2xl border border-[#f5ff3b]/40 bg-gradient-to-r from-[#0a214d]/90 to-[#08142f]/90 px-5 py-5 shadow-[0_0_30px_rgba(245,255,59,0.12)]">
            <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-[11px] font-bold uppercase tracking-[0.25em] text-[#00e5ff]">
                  ✦ {t("onboarding.welcome.kicker")}
                </p>
                <h2 className="mt-1 text-2xl font-black tracking-tight text-[#f5ff3b] sm:text-3xl">
                  {t("onboarding.welcome.title")}
                </h2>
                <p className="mt-1 max-w-2xl text-sm text-[#d8fbff]">
                  {t("onboarding.welcome.subtitle")}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Link
                  href="/casino/rps/play-ai?onboarding=1"
                  className="rounded-lg border border-[#f5ff3b]/60 bg-[#f5ff3b] px-5 py-2.5 text-sm font-bold text-[#041125] transition-all hover:bg-[#f5ff3b]/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f5ff3b] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0a214d]"
                >
                  {t("onboarding.firstMatch.homeCta")}
                </Link>
                <button
                  type="button"
                  onClick={dismissFirstMatchNudge}
                  aria-label={t("onboarding.firstMatch.dismiss")}
                  className="flex h-9 w-9 items-center justify-center rounded-full border border-[#00e5ff]/40 text-[#9dd8ff] transition hover:bg-[#00e5ff]/10 hover:text-[#d8fbff] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff]"
                >
                  ✕
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Value Proposition Strip */}
      <div className="mx-auto max-w-7xl px-4 py-6 reveal">          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div className="rounded-xl border border-[#00e5ff]/20 bg-[#040d24]/60 p-6 text-center backdrop-blur-sm transition-all hover:border-[#00e5ff]/35 hover:shadow-[0_0_20px_rgba(0,229,255,0.1)]">
            <svg className="w-10 h-10 mx-auto mb-3 text-[#00e5ff]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg>
            <h2 className="text-lg font-bold text-[#00e5ff] mb-1">{t("home.value_props.prove_skill_title")}</h2>
            <p className="text-sm text-[#7dd3fc]">{t("home.value_props.prove_skill_desc")}</p>
          </div>
          <div className="rounded-xl border border-[#f5ff3b]/20 bg-[#040d24]/60 p-6 text-center backdrop-blur-sm transition-all hover:border-[#f5ff3b]/35 hover:shadow-[0_0_20px_rgba(245,255,59,0.1)]">
            <svg className="w-10 h-10 mx-auto mb-3 text-[#f5ff3b]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4-4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/></svg>
            <h2 className="text-lg font-bold text-[#f5ff3b] mb-1">{t("home.value_props.real_opponents_title")}</h2>
            <p className="text-sm text-[#7dd3fc]">{t("home.value_props.real_opponents_desc")}</p>
          </div>
          <div className="rounded-xl border border-[#ff4fd8]/20 bg-[#040d24]/60 p-6 text-center backdrop-blur-sm transition-all hover:border-[#ff4fd8]/35 hover:shadow-[0_0_20px_rgba(255,79,216,0.1)]">
            <svg className="w-10 h-10 mx-auto mb-3 text-[#ff4fd8]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M8 21h8"/><path d="M12 17v4"/><path d="M7 4h10v5a5 5 0 01-10 0V4z"/><path d="M7 3H4a2 2 0 00-2 2v0a4 4 0 005 3"/><path d="M17 3h3a2 2 0 012 2v0a4 4 0 01-5 3"/><path d="M12 4v5"/></svg>
            <h2 className="text-lg font-bold text-[#ff4fd8] mb-1">{t("home.value_props.build_rep_title")}</h2>
            <p className="text-sm text-[#7dd3fc]">{t("home.value_props.build_rep_desc")}</p>
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
        <h2 className="text-2xl font-bold text-center text-[#f5ff3b] mb-8">{t("home.how_it_works_title")}</h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
          {[
            { num: "01", titleKey: "home.how_it_works_steps.pick_game_title", descKey: "home.how_it_works_steps.pick_game_desc", color: "#00e5ff" },
            { num: "02", titleKey: "home.how_it_works_steps.find_opponent_title", descKey: "home.how_it_works_steps.find_opponent_desc", color: "#f5ff3b" },
            { num: "03", titleKey: "home.how_it_works_steps.make_move_title", descKey: "home.how_it_works_steps.make_move_desc", color: "#ff4fd8" },
            { num: "04", titleKey: "home.how_it_works_steps.win_progress_title", descKey: "home.how_it_works_steps.win_progress_desc", color: "#00ffa6" },
            { num: "05", titleKey: "home.how_it_works_steps.run_it_back_title", descKey: "home.how_it_works_steps.run_it_back_desc", color: "#a855f7" },
          ].map((step) => (
            <div key={step.num} className="flex flex-col items-center text-center p-4">
              <div
                className="flex items-center justify-center w-12 h-12 rounded-full text-xl font-bold mb-3"
                style={{
                  color: step.color,
                  backgroundColor: `${step.color}1a`,
                  border: `1px solid ${step.color}55`,
                }}
              >
                {step.num}
              </div>
              <h3 className="text-base font-semibold text-[#d8fbff] mb-1">{t(step.titleKey)}</h3>
              <p className="text-sm text-[#7dd3fc]">{t(step.descKey)}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="mx-auto max-w-7xl px-4 py-8">
        <section className="mb-16 reveal">
          <div className="mb-3">
            <h2 className="text-2xl font-bold text-[#f5ff3b]">
              {t("home.pick_your_battle")}
            </h2>
            <p className="mt-1 text-sm text-[#7dd3fc]">{t("home.pick_your_game_subtitle")}</p>
          </div>

          <div className="grid grid-cols-1 gap-8 sm:grid-cols-2 lg:grid-cols-4 reveal-stagger">
            <motion.a
              initial={{ opacity: 0, y: 8 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, amount: 0.25 }}
              whileHover={{ scale: shouldReduceMotion ? 1 : 1.02 }}
              transition={{ duration: 0.25 }}
              href="/games/roulette"
              aria-label="Play Roulette"
              className="group relative cursor-pointer overflow-hidden rounded-xl border border-[#00e5ff]/35 bg-[#040d24] p-4 transition-all duration-300 hover:-translate-y-1 hover:shadow-[0_0_20px_rgba(0,229,255,0.35)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff] focus-visible:ring-offset-2 focus-visible:ring-offset-[#040d24]"
            >
              <div className="mb-4 h-48 overflow-hidden rounded-lg relative">
                <Image
                  src={Img1}
                  alt={t("home.game_cards.roulette_alt")}
                  loading="lazy"
                  sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 25vw"
                  className="h-full w-full object-cover transition-transform group-hover:scale-110"
                />
                {/* PvP badge — this game is a real 1v1 duel */}
                <span className="absolute left-2 top-2 rounded-full border border-[#00e5ff]/60 bg-[#0b1b3f]/85 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-[#00e5ff] shadow-[0_0_10px_rgba(0,229,255,0.45)] backdrop-blur-sm">
                  {t("home.pvp_badge")}
                </span>
              </div>
              <h3 className="mb-2 text-xl font-bold text-[#f5ff3b]">
                {t("games.roulette_name")}
              </h3>
              <p className="text-[#9dd8ff]">{t("home.game_cards.roulette_desc")}</p>
              <div className="mt-4 flex items-center gap-1.5 text-sm font-bold text-[#00e5ff]">
                <span>{t("home.play_pvp")}</span>
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
              </div>
              {renderFriendWidget("roulette")}
            </motion.a>

            <motion.a
              initial={{ opacity: 0, y: 8 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, amount: 0.25 }}
              whileHover={{ scale: shouldReduceMotion ? 1 : 1.02 }}
              transition={{ duration: 0.25 }}
              href="/games/blackjack"
              aria-label="Play Blackjack"
              className="group relative cursor-pointer overflow-hidden rounded-xl border border-[#00e5ff]/35 bg-[#040d24] p-4 transition-all duration-300 hover:-translate-y-1 hover:shadow-[0_0_20px_rgba(0,229,255,0.35)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff] focus-visible:ring-offset-2 focus-visible:ring-offset-[#040d24]"
            >
              <div className="mb-4 h-48 overflow-hidden rounded-lg relative">
                <Image
                  src={Img2}
                  alt={t("home.game_cards.blackjack_alt")}
                  loading="lazy"
                  sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 25vw"
                  className="h-full w-full object-cover transition-transform group-hover:scale-110"
                />
                {/* PvP badge — this game is a real 1v1 duel */}
                <span className="absolute left-2 top-2 rounded-full border border-[#00e5ff]/60 bg-[#0b1b3f]/85 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-[#00e5ff] shadow-[0_0_10px_rgba(0,229,255,0.45)] backdrop-blur-sm">
                  {t("home.pvp_badge")}
                </span>
              </div>
              <h3 className="mb-2 text-xl font-bold text-[#f5ff3b]">
                {t("games.blackjack_name")}
              </h3>
              <p className="text-[#9dd8ff]">
                {t("home.game_cards.blackjack_desc")}
              </p>
              <div className="mt-4 flex items-center gap-1.5 text-sm font-bold text-[#00e5ff]">
                <span>{t("home.play_pvp")}</span>
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
              </div>
              {renderFriendWidget("blackjack")}
            </motion.a>

            <motion.a
              initial={{ opacity: 0, y: 8 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, amount: 0.25 }}
              whileHover={{ scale: shouldReduceMotion ? 1 : 1.02 }}
              transition={{ duration: 0.25 }}
              href="/games/poker/multi"
              aria-label="Play Poker"
              className="group relative cursor-pointer overflow-hidden rounded-xl border border-[#00e5ff]/35 bg-[#040d24] p-4 transition-all duration-300 hover:-translate-y-1 hover:shadow-[0_0_20px_rgba(0,229,255,0.35)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff] focus-visible:ring-offset-2 focus-visible:ring-offset-[#040d24]"
            >
              <div className="mb-4 h-48 overflow-hidden rounded-lg relative">
                <Image
                  src={Img3}
                  alt={t("home.game_cards.poker_alt")}
                  loading="lazy"
                  sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 25vw"
                  className="h-full w-full object-cover transition-transform group-hover:scale-110"
                />
                {/* PvP badge — this game is a real 1v1 duel */}
                <span className="absolute left-2 top-2 rounded-full border border-[#00e5ff]/60 bg-[#0b1b3f]/85 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-[#00e5ff] shadow-[0_0_10px_rgba(0,229,255,0.45)] backdrop-blur-sm">
                  {t("home.pvp_badge")}
                </span>
              </div>
              <h3 className="mb-2 text-xl font-bold text-[#f5ff3b]">{t("games.poker_name")}</h3>
              <p className="text-[#9dd8ff]">
                {t("home.game_cards.poker_desc")}
              </p>
              <div className="mt-4 flex items-center gap-1.5 text-sm font-bold text-[#00e5ff]">
                <span>{t("home.play_pvp")}</span>
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
              </div>
              {renderFriendWidget("poker")}
            </motion.a>

            <motion.a
              initial={{ opacity: 0, y: 8 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, amount: 0.25 }}
              whileHover={{ scale: shouldReduceMotion ? 1 : 1.02 }}
              transition={{ duration: 0.25 }}
              href="/games/plinko"
              aria-label="Play Plinko"
              className="group relative cursor-pointer overflow-hidden rounded-xl border border-[#00e5ff]/35 bg-[#040d24] p-4 transition-all duration-300 hover:-translate-y-1 hover:shadow-[0_0_20px_rgba(0,229,255,0.35)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff] focus-visible:ring-offset-2 focus-visible:ring-offset-[#040d24]"
            >
              <div className="mb-4 h-48 overflow-hidden rounded-lg relative">
                <Image
                  src={Img4}
                  alt={t("home.game_cards.plinko_alt")}
                  loading="lazy"
                  sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 25vw"
                  className="h-full w-full object-cover transition-transform group-hover:scale-110"
                />
                {/* PvP badge — this game is a real 1v1 duel */}
                <span className="absolute left-2 top-2 rounded-full border border-[#00e5ff]/60 bg-[#0b1b3f]/85 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-[#00e5ff] shadow-[0_0_10px_rgba(0,229,255,0.45)] backdrop-blur-sm">
                  {t("home.pvp_badge")}
                </span>
              </div>
              <h3 className="mb-2 text-xl font-bold text-[#f5ff3b]">{t("games.plinko_name")}</h3>
              <p className="text-[#9dd8ff]">
                {t("home.game_cards.plinko_desc")}
              </p>
              <div className="mt-4 flex items-center gap-1.5 text-sm font-bold text-[#00e5ff]">
                <span>{t("home.play_pvp")}</span>
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
              </div>
              {renderFriendWidget("plinko")}
            </motion.a>
          </div>

          {/* Bouton More centré sous la grille */}
          <div
            className="flex justify-center mt-8 reveal"
            style={{ animationDelay: "0.2s" }}
          >
            <a
              href="/games"
              className="inline-block rounded-lg border border-[#f5ff3b]/40 bg-[#f5ff3b] px-6 py-3 text-base font-semibold text-[#031026] transition-all glow-pulse more-hover cyber-glow-button shadow-[0_0_16px_rgba(245,255,59,0.3)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f5ff3b] focus-visible:ring-offset-2 focus-visible:ring-offset-[#030817]"
            >
              {t("home.more_games")}
            </a>
          </div>
        </section>

        {/* Leaderboard — real weekly data, never fabricated */}
        <section className="mb-16 reveal">
          <div className="mb-6 flex items-end justify-between gap-4">
            <div>
              <h2 className="text-2xl font-bold text-[#f5ff3b]">
                {t("home.best_of.title")}
              </h2>
              <p className="mt-1 text-sm text-[#7dd3fc]">
                {t("home.best_of.subtitle")}
              </p>
            </div>
            <Link
              href="/classement"
              className="hidden shrink-0 rounded-lg border border-[#00e5ff]/40 px-4 py-2 text-sm font-semibold text-[#00e5ff] transition-all hover:bg-[#00e5ff]/10 sm:inline-block"
            >
              {t("home.best_of.view_all")}
            </Link>
          </div>

          <div className="overflow-hidden rounded-xl border border-[#00e5ff]/25 bg-[#040d24]/60 backdrop-blur-sm">
            {leaderboard.loading ? (
              <div className="space-y-3 p-6">
                {[1, 2, 3, 4, 5].map((i) => (
                  <div
                    key={i}
                    className="flex animate-pulse items-center gap-4"
                  >
                    <div className="h-8 w-8 rounded-full bg-white/10" />
                    <div className="h-4 flex-1 rounded bg-white/10" />
                    <div className="h-4 w-16 rounded bg-white/10" />
                  </div>
                ))}
              </div>
            ) : leaderboard.error || leaderboard.items.length === 0 ? (
              <div className="flex flex-col items-center gap-3 p-8 text-center">
                <p className="text-sm text-[#7dd3fc]/70">
                  {t("home.best_of.error")}
                </p>
                <Link
                  href="/classement"
                  className="rounded-lg border border-[#00e5ff]/40 px-4 py-2 text-sm font-semibold text-[#00e5ff] transition-all hover:bg-[#00e5ff]/10"
                >
                  {t("home.best_of.view_all")}
                </Link>
              </div>
            ) : (
              <ul className="divide-y divide-[#00e5ff]/10">
                {leaderboard.items.map((item, i) => (
                  <li key={item.clerk_id || `${item.rank}-${i}`}>
                    <Link
                      href={`/profil/${encodeURIComponent(item.clerk_id)}`}
                      className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-[#00e5ff]/5 sm:px-6"
                    >
                      <span
                        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-black ${
                          i === 0
                            ? "border border-[#f5ff3b]/50 bg-[#f5ff3b]/20 text-[#f5ff3b]"
                            : i === 1
                              ? "border border-slate-300/40 bg-slate-300/10 text-slate-200"
                              : i === 2
                                ? "border border-amber-600/50 bg-amber-700/20 text-amber-400"
                                : "border border-[#00e5ff]/30 bg-[#00e5ff]/10 text-[#00e5ff]"
                        }`}
                      >
                        {item.rank}
                      </span>
                      <IconAvatar
                        iconKey={item.icon_key || null}
                        name={item.user?.name || item.name}
                        size="h-9 w-9"
                        showFrame={false}
                        className="border border-white/20"
                      />
                      <span className="min-w-0 flex-1 truncate text-sm font-semibold text-[#c9f7ff]">
                        {item.user?.name || item.name}
                        {item.prestigeBadge && (
                          <span className="ml-2 rounded-full border border-violet-400/70 bg-violet-500/15 px-1.5 py-0.5 align-middle text-[10px] font-semibold text-violet-300">
                            {item.prestigeBadge}
                          </span>
                        )}
                      </span>
                      <span className="shrink-0 text-sm font-bold text-green-300">
                        {Number(item.weekly_wins || 0).toLocaleString()}{" "}
                        {t("home.best_of.wins_label")}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="mt-4 flex justify-center sm:hidden">
            <Link
              href="/classement"
              className="rounded-lg border border-[#00e5ff]/40 px-4 py-2 text-sm font-semibold text-[#00e5ff] transition-all hover:bg-[#00e5ff]/10"
            >
              {t("home.best_of.view_all")}
            </Link>
          </div>
        </section>

        {/* Player reviews — social proof */}
        <section className="mb-16 reveal">
          <div className="mb-6 flex items-end justify-between gap-4">
            <div>
              <h2 className="text-2xl font-bold text-[#f5ff3b]">
                Player Reviews
              </h2>
              <p className="mt-1 text-sm text-[#7dd3fc]">
                What our community says about GRYND
              </p>
            </div>
            <Link
              href="/reviews"
              className="hidden shrink-0 rounded-lg border border-[#00e5ff]/40 px-4 py-2 text-sm font-semibold text-[#00e5ff] transition-all hover:bg-[#00e5ff]/10 sm:inline-block"
            >
              See all reviews
            </Link>
          </div>
          <ReviewWall limit={6} />
        </section>
      </div>

      {/* Social follow strip — placed after the reviews so the reader has just
          seen other players talking about us, and closes the loop on "where do
          I keep up with this?". Icons/labels come from the shared
          SocialLinks component, never from a second list of URLs. */}
      <section className="mx-auto max-w-7xl px-4 pb-4 reveal">
        <div className="flex flex-col items-center gap-5 rounded-2xl border border-[#00e5ff]/20 bg-[#040d24]/60 px-6 py-8 text-center backdrop-blur-sm sm:flex-row sm:justify-between sm:text-left">
          <div>
            <h2 className="text-xl font-bold text-[#f5ff3b] sm:text-2xl">
              {t("home.social.title")}
            </h2>
            <p className="mt-1 text-sm text-[#7dd3fc]">
              {t("home.social.subtitle")}
            </p>
          </div>
          <SocialLinks
            size="lg"
            testId="home-social"
            className="shrink-0 justify-center"
          />
        </div>
      </section>

      {/* Final CTA — your GRYND starts now */}
      <section className="mx-auto max-w-7xl px-4 py-16 reveal">
        <div className="relative overflow-hidden rounded-2xl border border-[#00e5ff]/30 bg-gradient-to-br from-[#041125] to-[#0b1f45] px-6 py-14 text-center shadow-[0_0_50px_rgba(0,229,255,0.15)] sm:px-12">
          <div className="pointer-events-none absolute -top-24 left-1/2 h-48 w-96 -translate-x-1/2 rounded-full bg-[#00e5ff]/15 blur-3xl" />
          <div className="pointer-events-none absolute -bottom-24 right-1/4 h-40 w-72 rounded-full bg-[#ff4fd8]/10 blur-3xl" />
          <h2 className="relative text-2xl font-black uppercase tracking-widest text-[#f5ff3b] drop-shadow-[0_0_18px_rgba(245,255,59,0.5)] sm:text-4xl">
            {t("home.final_cta.title")}
          </h2>
          <p className="relative mx-auto mt-3 max-w-xl text-sm text-[#9dd8ff] sm:text-base">
            {t("home.final_cta.subtitle")}
          </p>
          <div className="relative mt-8 flex justify-center">
            <UIPro06PrimaryButton
              href="/sign-up"
              className="inline-block rounded-lg border border-[#f5ff3b]/60 bg-gradient-to-r from-[#ffd700] via-[#f5ff3b] to-[#ffb800] px-10 py-4 text-lg font-bold text-[#1f1700] transition-all shadow-[0_0_35px_rgba(245,255,59,0.5)] hover:shadow-[0_0_55px_rgba(245,255,59,0.8)] hover:scale-105 animate-primary-cta-pulse focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f5ff3b] focus-visible:ring-offset-2 focus-visible:ring-offset-[#030817]"
              aria-label={t("home.final_cta.play")}
            >
              {t("home.final_cta.play")}
            </UIPro06PrimaryButton>
          </div>
        </div>
      </section>

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
      {isSignedIn && (
        <div className="fixed left-4 top-44 z-50">
          <button
            onClick={() => setShowChallenges(!showChallenges)}
            className="group relative flex items-center gap-2 rounded-full bg-black/70 border border-[#00e5ff]/40 px-3 py-2 text-sm text-[#00e5ff] backdrop-blur-sm hover:border-[#00e5ff] hover:bg-black/85 transition-all shadow-[0_0_12px_rgba(0,229,255,0.15)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff] focus-visible:ring-offset-2 focus-visible:ring-offset-[#030817]"
          >
            <span className="text-lg">
              <svg className="w-5 h-5 inline" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M8 21h8"/><path d="M12 17v4"/><path d="M7 4h10v5a5 5 0 01-10 0V4z"/><path d="M7 3H4a2 2 0 00-2 2v0a4 4 0 005 3"/><path d="M17 3h3a2 2 0 012 2v0a4 4 0 01-5 3"/><path d="M12 4v5"/></svg>
            </span>
            <span className="font-bold">{t("home.challenges.title")}</span>
            <span className="text-[10px] text-[#00e5ff]/50">
              {showChallenges ? "▲" : "▼"}
            </span>
          </button>
          {showChallenges && (
            <div className="mt-1 w-64 rounded-xl border border-[#00e5ff]/30 bg-black/85 backdrop-blur-md p-3 text-xs text-cyan-100 shadow-[0_0_20px_rgba(0,229,255,0.2)]">
              <div className="mb-2 flex items-center justify-between">
                <span className="font-bold text-[#00e5ff]">{t("home.challenges.title")}</span>
              </div>
              {/* Daily / Weekly tab switcher */}
              <div className="mb-2 grid grid-cols-2 gap-1 rounded-lg border border-white/10 bg-white/5 p-1">
                {["daily", "weekly"].map((tab) => (
                  <button
                    key={tab}
                    onClick={() => setChallengeTab(tab)}
                    className={`rounded-md px-2 py-1.5 text-xs font-semibold transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff] ${
                      challengeTab === tab
                        ? "bg-[#00e5ff] text-[#041125]"
                        : "text-[#00e5ff]/70 hover:text-[#00e5ff]"
                    }`}
                  >
                    {tab === "daily"
                      ? t("home.challenges.daily")
                      : t("home.challenges.weekly")}
                  </button>
                ))}
              </div>
              {/* Quest list */}
              {questError && (
                <p className="mb-2 text-center text-[11px] text-red-300">{questError}</p>
              )}
              {questsLoading ? (
                <div className="py-4 text-center text-[11px] text-[#00e5ff]/70">
                  {t("ui.loading")}
                </div>
              ) : (
                <div className="space-y-2">
                  {(challengeTab === "daily" ? quests.daily : quests.weekly)
                    .length === 0 ? (
                    <div className="flex flex-col items-center gap-1 rounded-lg border border-dashed border-white/15 bg-white/5 px-3 py-5 text-center">
                      <svg className="w-6 h-6 text-[#00e5ff]/50" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
                      <p className="text-[11px] text-cyan-200/70">
                        {challengeTab === "daily"
                          ? t("home.challenges.empty_daily")
                          : t("home.challenges.empty_weekly")}
                      </p>
                    </div>
                  ) : (
                    (challengeTab === "daily" ? quests.daily : quests.weekly).map(
                      (q) => {
                        const pct = questProgressPct(q);
                        const done = Number(q.progress) >= Number(q.target);
                        return (
                          <div
                            key={q.id}
                            className={`rounded-lg border px-3 py-2 ${
                              q.claimed
                                ? "border-green-400/40 bg-green-900/20"
                                : done
                                  ? "border-[#f5ff3b]/50 bg-[#f5ff3b]/10"
                                  : "border-white/10 bg-white/5"
                            }`}
                          >
                            <div className="flex items-center justify-between gap-2">
                              <p className="text-[11px] font-semibold text-cyan-100 leading-snug">
                                {questTitle(q)}
                              </p>
                              <span className="shrink-0 text-[11px] font-bold text-[#f5ff3b]">
                                {Number(q.reward).toLocaleString()}
                              </span>
                            </div>
                            {!q.claimed && (
                              <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-white/10">
                                <div
                                  className={`h-full rounded-full transition-all duration-500 ${
                                    done
                                      ? "bg-gradient-to-r from-[#f5ff3b] to-amber-400"
                                      : "bg-gradient-to-r from-[#00e5ff] to-[#00ffa6]"
                                  }`}
                                  style={{ width: `${pct}%` }}
                                />
                              </div>
                            )}
                            <div className="mt-1.5 flex items-center justify-between gap-2">
                              <span className="text-[10px] text-cyan-200/60">
                                {q.questType === "multiplier"
                                  ? `${Number(q.progress).toFixed(1)}x / ${Number(q.target)}x`
                                  : q.questType === "wager"
                                    ? `${Number(q.progress).toLocaleString()} / ${Number(q.target).toLocaleString()}`
                                    : `${Number(q.progress)} / ${Number(q.target)}`}
                              </span>
                              <div className="flex items-center gap-1.5">
                                {challengeTab === "daily" && !q.claimed && (
                                  <button
                                    onClick={() => rerollQuest(q.id)}
                                    disabled={!!rerollingQuestId || !!claimingQuestId}
                                    title={t("home.challenges.reroll") || "Swap for a fresh quest (uses a Quest Reroll)"}
                                    className="rounded-md border border-[#00e5ff]/40 bg-[#00e5ff]/10 px-1.5 py-1 text-[10px] font-bold text-[#00e5ff] transition-all hover:bg-[#00e5ff]/25 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff]"
                                  >
                                    {rerollingQuestId === q.id ? "…" : "⟳"}
                                  </button>
                                )}
                                {done && !q.claimed ? (
                                <button
                                  onClick={() => claimQuest(q.id)}
                                  disabled={!!claimingQuestId}
                                  className="rounded-md bg-[#f5ff3b] px-2.5 py-1 text-[10px] font-bold text-[#041125] transition-all hover:bg-[#e8ff00] hover:scale-105 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f5ff3b]"
                                >
                                  {claimingQuestId === q.id
                                    ? "..."
                                    : t("home.challenges.claim")}
                                </button>
                              ) : q.claimed ? (
                                <span className="text-[10px] font-bold text-green-300">
                                  ✓ {t("home.challenges.claimed")}
                                </span>
                              ) : (
                                <span className="text-[10px] text-cyan-200/40">
                                  {pct}%
                                </span>
                              )}
                              </div>
                            </div>
                          </div>
                        );
                      },
                    )
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}
      {/* Battlepass widget — same pill pattern as the daily streak and
          quests widgets, but anchored on the right side and tooltip-style:
          it opens on hover (and on tap for touch devices). Shows the
          player's level, progress toward the next one, the next reward,
          and a link to the full battlepass page. */}
      {isSignedIn && (
        <div
          className="fixed right-4 top-20 z-50"
          onMouseEnter={() => setShowBattlepass(true)}
          onMouseLeave={() => setShowBattlepass(false)}
        >
          <div className="relative">
            <button
              onClick={() => setShowBattlepass(!showBattlepass)}
              aria-expanded={showBattlepass}
              className="group relative flex items-center gap-2 rounded-full bg-black/70 border border-[#f5ff3b]/40 px-3 py-2 text-sm text-[#f5ff3b] backdrop-blur-sm hover:border-[#f5ff3b] hover:bg-black/85 transition-all shadow-[0_0_12px_rgba(245,255,59,0.15)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f5ff3b] focus-visible:ring-offset-2 focus-visible:ring-offset-[#030817]"
            >
              <span className="text-lg">
                <svg className="w-5 h-5 inline" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M12 2l2.4 7.2h7.6l-6 4.8 2.4 7.2-6.4-4.8-6.4 4.8 2.4-7.2-6-4.8h7.6z"/></svg>
              </span>
              <span className="font-bold">{t("nav.battlepass")}</span>
              {battlepass && (
                <span className="hidden sm:inline text-xs text-[#f5ff3b]/70">
                  Lv {battlepass.level}
                </span>
              )}
              <span className="text-[10px] text-[#f5ff3b]/50">
                {showBattlepass ? "▲" : "▼"}
              </span>
            </button>
            {/* pt-2 (not mt-2) keeps the gap between the pill and the
                panel inside the hoverable area, so moving the cursor
                down into the panel doesn't close it. */}
            {showBattlepass && (
              <div className="absolute right-0 w-64 pt-2">
                <div className="rounded-xl border border-[#f5ff3b]/30 bg-black/85 backdrop-blur-md p-3 text-xs text-amber-100 shadow-[0_0_20px_rgba(245,255,59,0.2)]">
                {battlepassLoading ? (
                  <div className="py-4 text-center text-[11px] text-[#f5ff3b]/70">
                    {t("ui.loading")}
                  </div>
                ) : battlepassError ? (
                  <p className="py-4 text-center text-[11px] text-red-300">
                    {battlepassError}
                  </p>
                ) : battlepass ? (
                  <>
                    {/* Level + total XP */}
                    <div className="mb-2 flex items-center justify-between">
                      <span className="font-bold text-[#f5ff3b]">
                        {t("nav.battlepass")}
                      </span>
                      <span className="font-bold text-[#f5ff3b]">
                        Level {battlepass.level}
                      </span>
                    </div>

                    {/* Progress toward the next level */}
                    <div className="mb-1 flex justify-between text-[10px] text-amber-200/70">
                      <span>
                        {battlepassMaxed
                          ? "Max level reached"
                          : `Progress to level ${Math.min(
                              battlepass.maxLevel,
                              battlepass.level + 1,
                            )}`}
                      </span>
                      <span>
                        {battlepassMaxed
                          ? "100%"
                          : `${battlepass.progressPercent}%`}
                      </span>
                    </div>
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
                      <div
                        className="h-full rounded-full bg-gradient-to-r from-[#f5ff3b] to-amber-400 transition-all duration-500"
                        style={{
                          width: `${
                            battlepassMaxed ? 100 : battlepass.progressPercent
                          }%`,
                        }}
                      />
                    </div>

                    {/* Total XP + XP needed for the next level */}
                    <div className="mt-1.5 flex justify-between text-[10px] text-amber-200/60">
                      <span>{Number(battlepass.xp).toLocaleString()} XP total</span>
                      <span>
                        {battlepassMaxed
                          ? "Max level"
                          : `${Number(battlepass.remainingToNext).toLocaleString()} XP to level ${
                              battlepass.level + 1
                            }`}
                      </span>
                    </div>

                    {/* Next reward */}
                    <div className="mt-2 rounded-lg border border-[#f5ff3b]/20 bg-white/5 px-3 py-2">
                      <p className="text-[10px] uppercase tracking-wider text-amber-200/60">
                        Next reward
                      </p>
                      {battlepassMaxed ? (
                        <p className="mt-0.5 font-semibold text-[#f5ff3b]">
                          Max level reached — all rewards unlocked!
                        </p>
                      ) : nextBattlepassReward ? (
                        <div className="mt-1 flex items-center gap-2">
                          <span
                            className="h-2.5 w-2.5 shrink-0 rounded-full"
                            style={{
                              background: nextRewardColor,
                              boxShadow: `0 0 6px ${nextRewardColor}`,
                            }}
                          />
                          <div className="min-w-0">
                            <p className="truncate text-[11px] font-semibold text-white">
                              {nextBattlepassReward.name}
                            </p>
                            <p className="truncate text-[10px] text-amber-200/60">
                              {nextBattlepassReward.desc}
                            </p>
                          </div>
                        </div>
                      ) : (
                        <p className="mt-0.5 text-[11px] text-amber-200/70">
                          Icons & cosmetics soon
                        </p>
                      )}
                    </div>

                    {/* Link to the full battlepass page */}
                    <Link
                      href="/battlepass"
                      onClick={() => setShowBattlepass(false)}
                      className="mt-2 block rounded-lg border border-[#f5ff3b]/30 bg-[#f5ff3b]/15 px-3 py-2 text-center text-[11px] font-bold text-[#f5ff3b] transition-all hover:bg-[#f5ff3b]/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f5ff3b]"
                    >
                      Open Battlepass →
                    </Link>
                  </>
                ) : null}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
      {isSignedIn && !dailyRewardCooldown && (
        <div className="fixed right-4 bottom-16 z-50 flex flex-col items-end gap-1.5">
          {membership?.active && (
            <span className="rounded-full border border-emerald-400/60 bg-emerald-500/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-emerald-300 shadow-[0_0_10px_rgba(52,211,153,0.35)]">
              {t("home.rewards.premium_badge")}
            </span>
          )}
          <button
            onClick={claimDailyReward}
            className="rounded-lg px-4 py-2 text-sm font-semibold text-[#031026] transition-all shadow-lg bg-[#FFD700] hover:scale-110 animate-pulse border border-amber-400/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 focus-visible:ring-offset-2 focus-visible:ring-offset-[#030817]"
            title={t("home.rewards.claim_daily_title")}
          >
            {t("home.rewards.claim_button")}
          </button>
        </div>
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
                      // Must mirror /api/claim-login-reward (25 XP per
                      // streak day — linear escalation).
                      const baseReward = 25 * day; // must match LOGIN_REWARD_PER_DAY in claim-login-reward
                      // Membership grants no login bonus (see the API route).
                      const reward = Math.round(
                        baseReward * (membership?.active ? 1.5 : 1),
                      );

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
                            {reward.toLocaleString()} XP
                          </div>

                          {isToday && membership?.active && (
                            <span className="mt-0.5 rounded-full bg-emerald-500/20 px-1.5 text-[9px] font-bold text-emerald-300">
                              +50%
                            </span>
                          )}
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
                      <span className="text-amber-300 font-bold">+{milestoneBonus.toLocaleString()} bonus XP!</span>
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
      {/* Advertising for free accounts — last block before the footer, clear of
          the hero, navigation and every control. */}
      {adSlot}
      <Footer />
      <StickyMobileCta />
    </div>
  );
}

export default MainComponent;
