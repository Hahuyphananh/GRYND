"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useUser, useClerk } from "@clerk/nextjs";
import NavigationBar from "../../components/navigation-bar";
import Footer from "../../components/Footer";
import ContactMessageHistory from "../../components/ContactMessageHistory";
import AvatarFrame from "../../components/AvatarFrame";
import {
  DEFAULT_PROFILE_ACCENT,
  HEX_COLOR_REGEX,
  ACCENT_COLORS,
  AVATAR_FRAME_OPTIONS,
} from "../../lib/profileCosmetics";
import IconAvatar from "../../components/IconAvatar";
import ChooseIconModal from "../../components/ChooseIconModal";
import ChooseBannerModal from "../../components/ChooseBannerModal";
import ChooseEmotesModal from "../../components/ChooseEmotesModal";
import EmoteLoadoutStrip from "../../components/EmoteLoadoutStrip";
import ProfileBanner from "../../components/ProfileBanner";
import UserStatsTabs from "../../components/UserStatsTabs";
import { clearSessionArtifacts } from "../../lib/security/sessionCleanup";

// Grynd+ chat color palette (matches the neon casino aesthetic).
const CHAT_COLORS = [
  "#00e5ff",
  "#f5ff3b",
  "#f0abfc",
  "#34d399",
  "#fb923c",
  "#a78bfa",
  "#f43f5e",
  "#22d3ee",
  "#facc15",
  "#e2e8f0",
];

export default function ProfilePage() {
  const { isSignedIn, isLoaded, user } = useUser();
  const { signOut } = useClerk();

  const [userTokens, setUserTokens] = useState(null);
  const [profileInfo, setProfileInfo] = useState({
    name: "",
    email: "",
    selectedIcon: "",
    profileAccent: null,
    selectedBanner: null,
    avatarFrame: null,
  });
  // Unsaved profile customization (accent / frame) — saved via
  // /api/user/profile-customization (Grynd+ perk).
  const [cosmetics, setCosmetics] = useState({
    accent: DEFAULT_PROFILE_ACCENT,
    frame: null,
  });
  const [cosmeticsMsg, setCosmeticsMsg] = useState(null);
  const [bets, setBets] = useState([]);
  const [purchases, setPurchases] = useState([]);
  const [error, setError] = useState(null);

  const [stats, setStats] = useState(null);
  const [statsError, setStatsError] = useState(null);
  const [titleMeta, setTitleMeta] = useState({
    selectedTitle: "",
    highestTitle: "",
  });
  const [specialTitles, setSpecialTitles] = useState({
    selectedSpecialTitle: "",
    selectedSpecialTitleName: "",
    titles: [],
  });
  const [streakState, setStreakState] = useState({
    selectedStreakType: null, // null | "current" | "best"
    streakTitle: null,
    streakTitleCurrent: null,
    streakTitleBest: null,
    dailyStreakCurrent: 0,
    dailyStreakBest: 0,
    allStreakTitles: [],
  });

  // Prestige badge equip state — resolved server-side by
  // /api/user/prestige-badge. `display` is null unless the badge is both
  // equipped AND genuinely earned (Level 100 + prestige >= 1), so an
  // unearned badge can never be rendered.
  const [prestigeBadge, setPrestigeBadge] = useState({
    loading: true,
    enabled: false,
    display: null,
    prestige: 0,
    prestigeUnlocked: false,
    error: null,
  });

  const [membership, setMembership] = useState(null);
  const [chatColor, setChatColor] = useState("#00e5ff");
  const [chatColorMsg, setChatColorMsg] = useState(null);
  const loadMembership = async () => {
    try {
      const response = await fetch("/api/membership/status", {
        credentials: "include",
      });
      const data = await response.json();
      if (response.ok && data?.success) {
        setMembership(data.active ? data : null);
      }
    } catch (err) {
      console.error("[LOAD_MEMBERSHIP_ERROR]", err);
    }
  };

  // Responsible play — per-player daily loss limit (null = global default,
  // 0 = off, number = custom threshold in tokens).
  const [lossLimit, setLossLimit] = useState(null);
  const [lossLimitMode, setLossLimitMode] = useState("default");
  const [lossLimitDraft, setLossLimitDraft] = useState("");
  const [lossLimitSaving, setLossLimitSaving] = useState(false);
  const [lossLimitMsg, setLossLimitMsg] = useState(null);
  const loadLossLimit = async () => {
    try {
      const response = await fetch("/api/user/daily-loss-limit", {
        credentials: "include",
      });
      const data = await response.json();
      if (response.ok && data?.success) {
        setLossLimit(data.limit ?? null);
        if (data.limit === 0) setLossLimitMode("off");
        else if (typeof data.limit === "number" && data.limit > 0) {
          setLossLimitMode("custom");
          setLossLimitDraft(String(data.limit));
        } else setLossLimitMode("default");
      }
    } catch (err) {
      console.error("[LOAD_LOSS_LIMIT_ERROR]", err);
    }
  };
  const saveLossLimit = async () => {
    setLossLimitSaving(true);
    setLossLimitMsg(null);
    try {
      let limit = null; // default
      if (lossLimitMode === "off") limit = 0;
      else if (lossLimitMode === "custom") {
        const n = Number(lossLimitDraft);
        if (!Number.isInteger(n) || n <= 0) {
          setLossLimitMsg({ ok: false, text: "Enter a whole number of tokens above 0." });
          return;
        }
        limit = n;
      }
      const response = await fetch("/api/user/daily-loss-limit", {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ limit }),
      });
      const data = await response.json();
      if (response.ok && data?.success) {
        setLossLimit(limit);
        setLossLimitMsg({
          ok: true,
          text:
            limit === null
              ? "Using the global default warning."
              : limit === 0
                ? "Warnings disabled."
                : `Warn me when I'm down ${limit.toLocaleString()} tokens in a day.`,
        });
      } else {
        setLossLimitMsg({ ok: false, text: data?.error || "Failed to save." });
      }
    } catch {
      setLossLimitMsg({ ok: false, text: "Failed to save — try again." });
    } finally {
      setLossLimitSaving(false);
    }
  };

  const [titlesView, setTitlesView] = useState("special");
  const [titlesOpen, setTitlesOpen] = useState(false); // collapsed by default so the profile stays compact
  const [vipTitles, setVipTitles] = useState(null);
  const loadVipTitles = async () => {
    const response = await fetch("/api/titles", { credentials: "include" });
    const data = await response.json();

    if (response.ok && data.success) {
      setVipTitles(data);
    }
  };

  const [referralCodeInput, setReferralCodeInput] = useState("");
  const [referralStatus, setReferralStatus] = useState("");

  const [password, setPassword] = useState("");
  const [deleteError, setDeleteError] = useState("");
  const [deleteStatus, setDeleteStatus] = useState("");
  const [countdown, setCountdown] = useState(5);
  const [delayDone, setDelayDone] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const [isEditOpen, setIsEditOpen] = useState(false);
  const [editForm, setEditForm] = useState({
    name: "",
    email: "",
    password: "",
  });
  // Official icon picker modal (owned Grynd icons only).
  const [isIconPickerOpen, setIsIconPickerOpen] = useState(false);
  const [isBannerPickerOpen, setIsBannerPickerOpen] = useState(false);
  // In-game emote loadout manager (owned animated emotes, max 9).
  const [isEmotesManagerOpen, setIsEmotesManagerOpen] = useState(false);

  const [friendSearch, setFriendSearch] = useState("");
  const [friendSearchResults, setFriendSearchResults] = useState([]);
  const [myFriends, setMyFriends] = useState([]);
  const [receivedInvites, setReceivedInvites] = useState([]);
  const [activeFriendsTab, setActiveFriendsTab] = useState("friends");
  const [friendsStatus, setFriendsStatus] = useState("");
  const [friendPresenceByFriend, setFriendPresenceByFriend] = useState({});
  const [spectateOverlayUrl, setSpectateOverlayUrl] = useState("");
  const [spectateLoadError, setSpectateLoadError] = useState("");
  const [spectateIsLoaded, setSpectateIsLoaded] = useState(false);
  const [isSearchingFriends, setIsSearchingFriends] = useState(false);
  const [isSavingEdit, setIsSavingEdit] = useState(false);
  const [editStatus, setEditStatus] = useState("");

  const [levelUpModal, setLevelUpModal] = useState(null);
  const previousLevelRef = useRef(null);

  useEffect(() => {
    if (!spectateOverlayUrl || spectateIsLoaded || spectateLoadError) return;
    const timeoutId = setTimeout(() => {
      setSpectateLoadError(
        "Spectate view timed out. Please retry or ask your friend to reopen the game."
      );
    }, 10000);
    return () => clearTimeout(timeoutId);
  }, [spectateOverlayUrl, spectateIsLoaded, spectateLoadError]);

  const loadStats = async () => {
    const res = await fetch("/api/user-stats", { credentials: "include" });
    const data = await res.json();
    if (!res.ok || !data.success) {
      throw new Error(data.error || "Failed to load stats");
    }
    setStats(data.stats);
  };

  const loadTitles = async () => {
    const response = await fetch("/api/titles", { credentials: "include" });
    const data = await response.json();
    if (response.ok && data.success) {
      setTitleMeta({
        selectedTitle: data.selectedTitle || "",
        highestTitle: data.highestTitle || "",
      });
    }
  };

  const loadSpecialTitles = async () => {
    const response = await fetch("/api/titles/special", {
      credentials: "include",
    });
    const data = await response.json();
    if (response.ok && data.success) {
      setSpecialTitles({
        selectedSpecialTitle: data.selectedSpecialTitle || "",
        selectedSpecialTitleName: data.selectedSpecialTitleName || "",
        titles: Array.isArray(data.titles) ? data.titles : [],
      });
    }
  };

  const handleEquipSpecialTitle = async (titleKey) => {
    const response = await fetch("/api/titles/equip-special", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ titleKey }),
    });
    const data = await response.json();
    if (response.ok && data.success) {
      await Promise.all([loadSpecialTitles(), loadTitles(), loadProfileData()]);
      window.dispatchEvent(new Event("titleUpdated"));
      window.dispatchEvent(new Event("profileUpdated"));
    }
  };

  const handleEquipStreakTitle = async (streakType) => {
    const response = await fetch("/api/titles/equip-streak", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ streakType }),
    });
    const data = await response.json();
    if (response.ok && data.success) {
      await loadTitles();
      window.dispatchEvent(new Event("titleUpdated"));
      window.dispatchEvent(new Event("profileUpdated"));
    }
  };

  const loadPrestigeBadge = async () => {
    try {
      const response = await fetch("/api/user/prestige-badge", {
        credentials: "include",
      });
      const data = await response.json();
      if (response.ok && data.success) {
        setPrestigeBadge({
          loading: false,
          enabled: Boolean(data.badge?.enabled),
          display: data.badge?.display || null,
          prestige: data.badge?.prestige || 0,
          prestigeUnlocked: Boolean(data.badge?.prestigeUnlocked),
          error: null,
        });
      } else {
        setPrestigeBadge((prev) => ({ ...prev, loading: false }));
      }
    } catch (err) {
      console.error("[LOAD_PRESTIGE_BADGE_ERROR]", err);
      setPrestigeBadge((prev) => ({ ...prev, loading: false }));
    }
  };

  // Equip / unequip the Prestige badge. The server only stores a boolean
  // preference and re-derives the display text from the real prestige
  // level — this page never sends or renders a client-claimed tier.
  const handleEquipPrestigeBadge = async (enabled) => {
    const response = await fetch("/api/user/prestige-badge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ enabled }),
    });
    const data = await response.json();
    if (response.ok && data.success) {
      setPrestigeBadge({
        loading: false,
        enabled: Boolean(data.badge?.enabled),
        display: data.badge?.display || null,
        prestige: data.badge?.prestige || 0,
        prestigeUnlocked: Boolean(data.badge?.prestigeUnlocked),
        error: null,
      });
      window.dispatchEvent(new Event("titleUpdated"));
      window.dispatchEvent(new Event("profileUpdated"));
    } else {
      setPrestigeBadge((prev) => ({
        ...prev,
        error: data?.error || "Could not update your badge",
      }));
    }
  };

  const cyberButton =
    "relative overflow-hidden rounded-lg px-4 py-2 font-semibold text-white " +
    "bg-gradient-to-r from-[#00e5ff] via-[#00ffcc] to-[#8a2be2] " +
    "shadow-[0_0_10px_rgba(0,229,255,0.6)] " +
    "hover:shadow-[0_0_20px_rgba(138,43,226,0.9)] " +
    "hover:scale-105 active:scale-95 transition-all duration-300";

  const loadProfileData = async () => {
    const tokensResponse = await fetch("/api/get-user-tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
    });
    const tokensData = await tokensResponse.json();

    if (tokensData.success && tokensData.data) {
      setUserTokens(Number(tokensData.data.balance || 0));
      const name = tokensData.data.name || user?.fullName || "Unknown user";
      const email = tokensData.data.email || user?.emailAddresses?.[0]?.emailAddress || "";
      const selectedIcon = tokensData.data.selectedIcon || "";
      const profileAccent = tokensData.data.profileAccent || null;
      const selectedBanner = tokensData.data.selectedBanner || null;
      const avatarFrame = tokensData.data.avatarFrame || null;
      setProfileInfo({ name, email, selectedIcon, profileAccent, selectedBanner, avatarFrame });
      setEditForm((prev) => ({ ...prev, name, email }));
      // Sync the customization pickers with the saved values.
      setCosmetics({
        accent: profileAccent || DEFAULT_PROFILE_ACCENT,
        frame: avatarFrame || null,
      });
    }

    const historyResponse = await fetch("/api/get-bet-history", {
      method: "GET",
      credentials: "include",
    });
    const historyData = await historyResponse.json();

    if (historyData.success && Array.isArray(historyData.bets)) {
      const sorted = historyData.bets.sort((a, b) => new Date(b.date) - new Date(a.date));
      setBets(sorted.slice(0, 10));
    } else {
      setBets([]);
    }

    const purchaseResponse = await fetch("/api/get-purchase-history", {
      method: "GET",
      credentials: "include",
    });
    const purchaseData = await purchaseResponse.json();
    if (purchaseData.success && Array.isArray(purchaseData.purchases)) {
      setPurchases(purchaseData.purchases);
    } else {
      setPurchases([]);
    }
  };

  const loadFriends = async () => {
    try {
      const response = await fetch("/api/friends/list", {
        credentials: "include",
      });
      const data = await response.json();
      if (!response.ok || !data.success) {
        setMyFriends([]);
        return;
      }

      const friendRows = Array.isArray(data.friends)
        ? data.friends
        : Array.isArray(data.data)
          ? data.data
          : [];
      setMyFriends(friendRows);
    } catch (err) {
      console.error("[LOAD_FRIENDS_ERROR]", err);
      setMyFriends([]);
    }
  };

  const loadFriendPresence = async () => {
    try {
      const response = await fetch("/api/friends/game-presence", {
        credentials: "include",
      });
      const data = await response.json();
      if (response.ok && data.success) {
        setFriendPresenceByFriend(data.byFriend || {});
      }
    } catch (err) {
      console.error("[LOAD_FRIEND_PRESENCE_ERROR]", err);
    }
  };

  const loadFriendInvites = async () => {
    try {
      const response = await fetch("/api/friends/invites", {
        credentials: "include",
      });
      const data = await response.json();
      if (!response.ok || !data.success) {
        setReceivedInvites([]);
        return;
      }

      setReceivedInvites(Array.isArray(data.invites) ? data.invites : []);
    } catch (err) {
      console.error("[LOAD_FRIEND_INVITES_ERROR]", err);
      setReceivedInvites([]);
    }
  };

  const handleSearchFriends = async (searchValue = friendSearch) => {
    setFriendsStatus("");
    const normalized = String(searchValue || "").trim();

    console.log(" FRONT INPUT:", searchValue);
    console.log(" FRONT NORMALIZED:", normalized);

    console.log("FRONTEND SEARCH INPUT:", `"${searchValue}"`);
    console.log("FRONTEND NORMALIZED:", `"${normalized}"`);

    if (!normalized) {
      setFriendSearchResults([]);
      return;
    }

    try {
      setIsSearchingFriends(true);
      const response = await fetch("/api/friends/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ name: normalized }),
      });
      const data = await response.json();

      console.log(" FRIEND SEARCH FULL RESPONSE:", data);
      if (!response.ok || !data.success) {
        setFriendSearchResults([]);
        return;
      }

      const users = Array.isArray(data.users)
        ? data.users
        : Array.isArray(data.data)
          ? data.data
          : [];
      setFriendSearchResults(users);
    } catch (err) {
      console.error("[SEARCH_FRIENDS_ERROR]", err);
      setFriendsStatus(err.message || "Could not search users.");
    } finally {
      setIsSearchingFriends(false);
    }
  };

  const handleRemoveFriend = async (friendId) => {
    const confirmed = window.confirm("Remove this friend?");
    if (!confirmed) return;

    setFriendsStatus("");

    try {
      const response = await fetch("/api/friends/remove", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ friendId }),
      });

      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data.error || "Failed to remove friend");
      }

      setFriendsStatus("Friend removed.");
      await loadFriends();
      await loadFriendPresence(); // keep UI in sync
    } catch (err) {
      console.error("[REMOVE_FRIEND_ERROR]", err);
      setFriendsStatus(err.message || "Could not remove friend.");
    }
  };

  useEffect(() => {
    if (!isSignedIn) return;

    let interval;

    const sendHeartbeat = async () => {
      try {
        await fetch("/api/presence/heartbeat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({}),
        });
      } catch (err) {
        console.error("[HEARTBEAT_ERROR]", err);
      }
    };

    // send immediately
    sendHeartbeat();

    // The global PresenceHeartbeat already beats every 5 min; this
    // page used to fire an extra heartbeat every 25s, doubling writes
    // on the profile page. Align to the same 5-min cadence so the
    // duplicate writer doesn't amplify Neon presence writes.
    interval = setInterval(sendHeartbeat, 300000);

    return () => clearInterval(interval);
  }, [isSignedIn]);

  const getFriendStatus = (friendId) => {
    const presence = friendPresenceByFriend?.[friendId];
    const normalizedGameKey = String(presence?.gameKey || "")
      .toLowerCase()
      .trim();

    if (presence?.presenceState === "offline" || !presence?.lastSeenAt) {
      return {
        state: "offline",
        label: "Offline",
        color: "text-gray-400",
      };
    }

    if (
      presence?.presenceState === "in_game" ||
      (normalizedGameKey && presence?.gameId !== null && presence?.gameId !== undefined)
    ) {
      return {
        state: "in_game",
        label: `In game: ${normalizedGameKey}`,
        color: "text-yellow-400",
      };
    }

    return {
      state: "online",
      label: "Online",
      color: "text-green-400",
    };
  };

  const handleInviteFriend = async (friendId) => {
    setFriendsStatus("");
    try {
      const response = await fetch("/api/friends/invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ friendId }),
      });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error || "Failed to add friend");
      setFriendsStatus(data.message || "Friend invite sent.");
      await loadFriendInvites();
    } catch (err) {
      console.error("[INVITE_FRIEND_ERROR]", err);
      setFriendsStatus(err.message || "Could not send invite.");
    }
  };

  const isAllowedSpectateUrl = (url) => {
    if (!url || typeof url !== "string") return false;
    if (!url.startsWith("/")) return false;

    const allowedPrefixes = [
      "/casino/chess-game/",
      "/casino/four-in-a-row/game/",
      "/casino/poker/multi",
    ];

    return allowedPrefixes.some((prefix) => url.startsWith(prefix));
  };

  const spectateUrlForFriend = (friendId) => {
    const presence = friendPresenceByFriend?.[friendId];
    const gameKey = String(presence?.gameKey || "")
      .toLowerCase()
      .trim();
    if (!presence?.gameId || !gameKey) return null;

    if (gameKey === "chess")
      return `/casino/chess-game/${presence.gameId}?spectator=1&focusTarget=${encodeURIComponent(friendId)}`;
    if (gameKey === "four-in-a-row")
      return `/casino/four-in-a-row/game/${presence.gameId}?spectator=1&focusTarget=${encodeURIComponent(friendId)}`;
    if (gameKey === "poker") return `/casino/poker/multi?spectator=1&gameId=${presence.gameId}`;
    return null;
  };

  const handleRespondToInvite = async (inviteId, action) => {
    setFriendsStatus("");
    try {
      const response = await fetch("/api/friends/invites/respond", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ inviteId, action }),
      });
      const data = await response.json();
      if (!response.ok || !data.success)
        throw new Error(data.error || "Failed to respond to invite");
      setFriendsStatus(data.message || "Invite updated.");
      await Promise.all([loadFriends(), loadFriendInvites(), loadFriendPresence()]);
    } catch (err) {
      console.error("[RESPOND_FRIEND_INVITE_ERROR]", err);
      setFriendsStatus(err.message || "Could not update invite.");
    }
  };

  const initializeReferral = async () => {
    const generateRes = await fetch("/api/referral/generate", {
      method: "POST",
      credentials: "include",
    });
    const generateData = await generateRes.json();

    if (!generateRes.ok || !generateData.success) {
      throw new Error(generateData.error || "Could not generate referral code");
    }

    setStats((prev) => {
      if (!prev) return { referralCode: generateData.referralCode };
      return {
        ...prev,
        referralCode: generateData.referralCode,
      };
    });

    return generateData.referralCode;
  };

  useEffect(() => {
    if (!isSignedIn || !user) return;

    const bootstrap = async () => {
      try {
        await Promise.all([
          loadProfileData(),
          loadStats(),
          loadTitles(),
          loadSpecialTitles(),
          loadVipTitles(),
          loadStreakTitles(),
          loadMembership(),
          loadLossLimit(),
          loadPrestigeBadge(),
          loadFriends(),
          loadFriendPresence(),
          loadFriendInvites(),
        ]);

        if (!stats?.referralCode) {
          await initializeReferral();
          await loadStats();
        }
      } catch (err) {
        console.error("[PROFILE_BOOTSTRAP_ERROR]", err);
        setError(err.message || "Erreur lors du chargement des données");
      }
    };

    bootstrap();
  }, [isSignedIn, user]);

  const loadStreakTitles = async () => {
    try {
      const response = await fetch("/api/titles", { credentials: "include" });
      const data = await response.json();
      if (response.ok && data.success) {
        setStreakState({
          selectedStreakType: data.selectedStreakType || null,
          streakTitle: data.streakTitle || null,
          streakTitleCurrent: data.streakTitleCurrent || null,
          streakTitleBest: data.streakTitleBest || null,
          dailyStreakCurrent: data.dailyStreakCurrent || 0,
          dailyStreakBest: data.dailyStreakBest || 0,
          allStreakTitles: Array.isArray(data.allStreakTitles) ? data.allStreakTitles : [],
        });
      }
    } catch (err) {
      console.error("[LOAD_STREAK_TITLES_ERROR]", err);
    }
  };

  useEffect(() => {
    const refreshTitles = () => {
      loadTitles();
      loadSpecialTitles();
      loadVipTitles();
      loadStreakTitles();
      loadPrestigeBadge();
    };

    window.addEventListener("titleUpdated", refreshTitles);
    return () => window.removeEventListener("titleUpdated", refreshTitles);
  }, []);

  // Initialize the chat color picker from the saved membership color once
  // the membership status loads.
  useEffect(() => {
    if (membership?.chatColor && /^#[0-9a-fA-F]{6}$/.test(membership.chatColor)) {
      setChatColor(membership.chatColor);
    }
  }, [membership]);

  const handleSaveChatColor = async () => {
    setChatColorMsg(null);
    if (!/^#[0-9a-fA-F]{6}$/.test(chatColor)) {
      setChatColorMsg("Enter a valid hex color like #00e5ff.");
      return;
    }
    try {
      const response = await fetch("/api/user/chat-color", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ color: chatColor }),
      });
      const data = await response.json().catch(() => ({}));
      if (response.ok) {
        setChatColorMsg("Chat color saved!");
        setMembership((m) => (m ? { ...m, chatColor } : m));
      } else {
        setChatColorMsg(data.error || "Could not save color.");
      }
    } catch (err) {
      setChatColorMsg("Could not save color.");
    }
  };

  const handleSaveCosmetics = async () => {
    setCosmeticsMsg(null);
    if (!HEX_COLOR_REGEX.test(cosmetics.accent)) {
      setCosmeticsMsg("Enter a valid hex accent color like #00e5ff.");
      return;
    }
    try {
      const response = await fetch("/api/user/profile-customization", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          profileAccent: cosmetics.accent,
          avatarFrame: cosmetics.frame,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (response.ok) {
        setCosmeticsMsg("Profile customization saved!");
        await loadProfileData();
      } else {
        setCosmeticsMsg(data.error || "Could not save customization.");
      }
    } catch (err) {
      setCosmeticsMsg("Could not save customization.");
    }
  };

  const handleResetChatColor = async () => {
    setChatColorMsg(null);
    try {
      const response = await fetch("/api/user/chat-color", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ color: null }),
      });
      if (response.ok) {
        setChatColor("#00e5ff");
        setChatColorMsg("Chat color reset to default.");
        setMembership((m) => (m ? { ...m, chatColor: null } : m));
      } else {
        setChatColorMsg("Could not reset color.");
      }
    } catch (err) {
      setChatColorMsg("Could not reset color.");
    }
  };

  useEffect(() => {
    if (!isSignedIn) return;

    const timeout = setTimeout(() => {
      handleSearchFriends(friendSearch);
    }, 220);

    return () => clearTimeout(timeout);
  }, [friendSearch, isSignedIn]);

  useEffect(() => {
    if (!isSignedIn) return;
    loadFriends();
    loadFriendPresence();
    loadFriendInvites();
    const intervalId = setInterval(() => {
      loadFriends();
      loadFriendPresence();
      loadFriendInvites();
    }, 15000);
    return () => clearInterval(intervalId);
  }, [isSignedIn]);

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
        bonus: Math.floor(500 * Math.pow(1.2, stats.currentLevel)),
      });
    }

    previousLevelRef.current = stats.currentLevel;
  }, [stats]);

  const levelProgressPercent = useMemo(() => {
    if (!stats?.levelProgress) return 0;
    return Number(stats.levelProgress.progressPercent || 0);
  }, [stats]);

  const fallbackCopy = (text) => {
    const tempInput = document.createElement("textarea");
    tempInput.value = text;
    document.body.appendChild(tempInput);
    tempInput.select();
    document.execCommand("copy");
    document.body.removeChild(tempInput);
  };

  const handleCopyReferralCode = async () => {
    if (!stats?.referralCode) {
      setReferralStatus("No referral code found yet. Please wait a second and try again.");
      return;
    }

    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(stats.referralCode);
      } else {
        fallbackCopy(stats.referralCode);
      }
      setReferralStatus(`Copied: ${stats.referralCode}`);
    } catch (err) {
      console.error("[COPY_REFERRAL_CODE_ERROR]", err);
      try {
        fallbackCopy(stats.referralCode);
        setReferralStatus(`Copied with fallback: ${stats.referralCode}`);
      } catch (fallbackError) {
        setReferralStatus("Could not copy code. Please copy manually.");
      }
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

      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(message);
      } else {
        fallbackCopy(message);
      }
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
      await Promise.all([loadStats(), loadProfileData()]);
    } catch (err) {
      console.error("[REDEEM_REFERRAL_ERROR]", err);
      setReferralStatus(err.message || "Unable to redeem code");
    }
  };

  const handleSaveEditProfile = async () => {
    setEditStatus("");

    try {
      const payload = {};
      const normalizedName = String(editForm.name || "").trim();
      const normalizedEmail = String(editForm.email || "").trim();
      const normalizedPassword = String(editForm.password || "").trim();
      const normalizedCurrentName = String(profileInfo.name || "").trim();
      const normalizedCurrentEmail = String(profileInfo.email || "").trim();

      if (normalizedName && normalizedName !== normalizedCurrentName) payload.name = normalizedName;
      if (normalizedEmail && normalizedEmail !== normalizedCurrentEmail)
        payload.email = normalizedEmail;
      if (normalizedPassword) payload.password = normalizedPassword;

      if (!Object.keys(payload).length) {
        setEditStatus("No changes to save.");
        return;
      }

      setIsSavingEdit(true);
      const response = await fetch("/api/profile/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(payload),
      });

      const data = await response.json();
      if (!response.ok || !data.success) {
        throw new Error(data.error || "Failed to update profile");
      }

      setProfileInfo((prev) => ({
        ...prev,
        name: data.profile.name,
        email: data.profile.email,
      }));
      setEditForm((prev) => ({
        ...prev,
        name: data.profile.name,
        email: data.profile.email,
        password: "",
      }));
      setEditStatus("Profile updated successfully.");
      window.dispatchEvent(new Event("profileUpdated")); // ADD THIS
    } catch (err) {
      console.error("[EDIT_PROFILE_ERROR]", err);
      setEditStatus(err.message || "Could not save changes.");
    } finally {
      setIsSavingEdit(false);
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
      // Sweep device session artifacts (admin_mfa cookie, per-user caches,
      // game-session tokens) before revoking. The keepalive server call
      // survives both branches below, including the hard redirect when
      // signOut fails.
      clearSessionArtifacts();
      try {
        await signOut({ redirectUrl: "/" });
      } catch (signOutErr) {
        // The Clerk user was already erased server-side, so the
        // session is invalid and signOut may fail — still leave the
        // app either way.
        console.warn("[DELETE_ACCOUNT_SIGNOUT]", signOutErr);
        window.location.href = "/";
      }
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
        <div className="text-2xl text-[#00e5ff]">Chargement...</div>
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
            className="rounded-lg bg-[#FFD700] px-6 py-3 text-[#003366] hover:bg-[#FFD700]/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 focus-visible:ring-offset-2 focus-visible:ring-offset-[#003366]"
          >
            Connexion
          </a>
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
      <div className="max-w-6xl mx-auto px-6 pt-24 pb-20">
        <NavigationBar currentPath="/profil" />
        <h1
          className="text-4xl font-extrabold text-center mb-8 
  bg-gradient-to-r from-purple-400 to-pink-500 
  bg-clip-text text-transparent"
        >
          Your Profile
        </h1>

        <div className="grid gap-8 md:grid-cols-2">
          <div
            className={`relative overflow-hidden bg-[#0b224f]/85 border border-[#00e5ff]/30 rounded-xl p-6 shadow-[0_0_24px_rgba(0,229,255,0.15)] ${
              profileInfo.selectedBanner ? "pt-24" : ""
            }`}
            style={
              profileInfo.profileAccent
                ? {
                    borderColor: profileInfo.profileAccent,
                    boxShadow: `0 0 24px ${profileInfo.profileAccent}33`,
                  }
                : undefined
            }
          >
            <ProfileBanner
              bannerKey={profileInfo.selectedBanner}
              className="absolute inset-x-0 top-0"
              heightClass="h-16"
            />
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-xl text-[#00e5ff]">Infos Personnelles</h2>
              <button
                onClick={() => {
                  setEditStatus("");
                  setIsEditOpen(true);
                }}
                className={
                  cyberButton +
                  " text-sm px-3 py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0b224f]"
                }
              >
                Edit Profile
              </button>
            </div>
            <div className="mb-3 flex items-center gap-3">
              {/* Clicking your own avatar opens the official icon picker.
                  No upload / URL avatar path — only owned Grynd icons. */}
              <button
                type="button"
                onClick={() => setIsIconPickerOpen(true)}
                aria-label="Change your Grynd icon"
                title="Change your Grynd icon"
                className="group relative rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0b224f]"
              >
                <AvatarFrame frame={profileInfo.avatarFrame}>
                  <IconAvatar
                    iconKey={profileInfo.selectedIcon}
                    name={profileInfo.name || user.fullName}
                    size="h-14 w-14"
                    className="border border-[#FFD700] transition group-hover:scale-105"
                  />
                </AvatarFrame>
                {/* Subtle "change" affordance so players know it's clickable */}
                <span className="absolute -bottom-1 -right-1 flex h-6 w-6 items-center justify-center rounded-full border border-[#00e5ff]/50 bg-[#001933] text-[#00e5ff] shadow-[0_0_10px_rgba(0,229,255,0.5)] transition group-hover:scale-110">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
                </span>
              </button>
              <div>
                <div className="flex items-center gap-2">
                  <p>Name : {profileInfo.name || user.fullName || "Unknown user"}</p>
                  {membership?.active && (
                    <span className="rounded-full border border-emerald-400/60 bg-emerald-500/10 px-2 py-0.5 text-xs font-semibold text-emerald-300">
                      {membership.title || "GRYND+ Elite"}
                    </span>
                  )}
                  {(prestigeBadge.display ||
                    specialTitles.selectedSpecialTitleName ||
                    titleMeta.selectedTitle) && (
                    <span
                      className={`rounded-full border px-2 py-0.5 text-xs ${
                        prestigeBadge.display
                          ? "border-violet-400/70 bg-violet-500/15 text-violet-300"
                          : "border-[#f5ff3b]/60 bg-[#f5ff3b]/10 text-[#f5ff3b]"
                      }`}
                    >
                      {prestigeBadge.display ||
                        specialTitles.selectedSpecialTitleName ||
                        titleMeta.selectedTitle}
                    </span>
                  )}
                </div>
                <p>Email : {profileInfo.email || user.emailAddresses?.[0]?.emailAddress}</p>
                {/* Streak info line */}
                <p className="text-xs text-amber-300 mt-1">
                  <svg
                    className="w-3.5 h-3.5 inline text-amber-400"
                    viewBox="0 0 24 24"
                    fill="currentColor"
                  >
                    <path d="M12 23c-1.4 0-2.5-1.1-2.5-2.5 0-.5.1-.9.4-1.3-1.9-1-4.1-2.3-4.1-4.7 0-2.2 1.5-4 3.5-5.5C10 8.4 10.5 7.5 12 2c1.5 5.5 2 6.4 2.7 7 2 1.5 3.5 3.3 3.5 5.5 0 2.4-2.2 3.7-4.1 4.7.3.4.4.8.4 1.3 0 1.4-1.1 2.5-2.5 2.5z" />
                  </svg>{" "}
                  Daily Streak: {streakState.dailyStreakCurrent} day
                  {(streakState.dailyStreakCurrent || 0) !== 1 ? "s" : ""} (Best:{" "}
                  {streakState.dailyStreakBest})
                </p>
              </div>
            </div>
            <p>Membre depuis : {new Date(user.createdAt).toLocaleDateString()}</p>
          </div>

          <div
            className="bg-[#0b224f]/85 border border-[#00e5ff]/30 
rounded-xl p-6 
shadow-[0_0_24px_rgba(0,229,255,0.15)] text-center"
          >
            <h2 className="text-xl text-[#00e5ff] mb-2">Solde de Tokens</h2>
            <p className="text-3xl font-bold">{userTokens ?? 0} tokens</p>
            {error && <p className="mt-2 text-red-500">{error}</p>}
          </div>
        </div>

        <div
          className="mt-8 bg-[#0b224f]/85 border border-[#00e5ff]/30 
rounded-xl p-6 
shadow-[0_0_24px_rgba(0,229,255,0.15)]"
        >
          <div className="flex items-center justify-between gap-4 mb-4">
            <h2 className="text-xl text-[#00e5ff]">Battlepass Level</h2>
            <div
              className="rounded-full px-3 py-1 bg-[#00e5ff] text-[#001933] 
shadow-[0_0_10px_rgba(0,229,255,0.4)] font-bold"
            >
              Level {stats?.currentLevel ?? 1}
              {stats?.levelProgress?.maxLevel
                ? ` / ${stats.levelProgress.maxLevel}`
                : ""}
            </div>
          </div>

          <div className="h-3 w-full rounded-full bg-white/10 overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-yellow-400 via-orange-400 to-pink-500 transition-all duration-500"
              style={{ width: `${levelProgressPercent}%` }}
            />
          </div>
          <div className="mt-2 flex justify-between text-sm text-gray-300">
            <span>
              {Number(stats?.levelProgress?.prevLevelRequired ?? 0).toLocaleString()} XP
            </span>
            <span>{levelProgressPercent.toFixed(2)}%</span>
            <span>
              {Number(stats?.levelProgress?.nextLevelRequired ?? 0).toLocaleString()} XP next level
            </span>
          </div>
          <div className="mt-3 text-xs text-[#7dd3fc]">
            Earn XP by wagering tokens and completing quests.
          </div>
          <Link
            href="/battlepass"
            className="mt-2 inline-flex items-center gap-1.5 text-sm font-medium text-[#f5ff3b] hover:text-yellow-300"
          >
            View Battlepass →
          </Link>
        </div>

        <div className="mt-8 rounded-xl border border-emerald-400/35 bg-[#052e1f]/85 p-6 shadow-[0_0_24px_rgba(52,211,153,0.15)]">
          <div className="flex items-center justify-between gap-4 mb-4">
            <h2 className="text-xl text-emerald-300">Grynd+ Membership</h2>
            {membership?.active ? (
              <span className="rounded-full border border-emerald-400/60 bg-emerald-500/10 px-3 py-1 text-sm font-semibold text-emerald-300">
                Active
              </span>
            ) : (
              <span className="rounded-full border border-white/20 bg-white/5 px-3 py-1 text-sm text-gray-400">
                Not subscribed
              </span>
            )}
          </div>

          {membership?.active ? (
            <>
              <p className="mb-3 text-sm text-gray-300">
                Custom chat name color — Grynd+ perk.
              </p>

              <div className="mb-3 flex flex-wrap gap-2">
                {CHAT_COLORS.map((color) => (
                  <button
                    key={color}
                    type="button"
                    onClick={() => setChatColor(color)}
                    aria-label={`Set chat color ${color}`}
                    title={color}
                    className={`h-8 w-8 rounded-full border-2 transition ${
                      chatColor.toLowerCase() === color.toLowerCase()
                        ? "scale-110 border-white"
                        : "border-white/20 hover:border-white/60"
                    }`}
                    style={{ backgroundColor: color }}
                  />
                ))}
              </div>

              <div className="mb-3 flex items-center gap-2">
                <input
                  type="color"
                  value={chatColor}
                  onChange={(e) => setChatColor(e.target.value)}
                  aria-label="Custom chat color"
                  className="h-8 w-10 cursor-pointer rounded border border-white/20 bg-transparent"
                />
                <input
                  type="text"
                  value={chatColor}
                  onChange={(e) => setChatColor(e.target.value.trim())}
                  maxLength={7}
                  aria-label="Custom chat color hex value"
                  className="w-28 rounded border border-white/20 bg-[#0b224f]/60 px-2 py-1 text-sm text-white focus:border-emerald-400 focus:outline-none"
                />
              </div>

              <div className="mb-4 flex items-center gap-2 rounded bg-black/30 px-3 py-2 text-sm">
                <span className="text-gray-400">Preview:</span>
                <span className="font-bold" style={{ color: chatColor }}>
                  {profileInfo.name || user.fullName || "YourName"}
                </span>
              </div>

              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={handleSaveChatColor}
                  className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-[#001a0e] transition hover:bg-emerald-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300 focus-visible:ring-offset-2 focus-visible:ring-offset-[#052e1f]"
                >
                  Save color
                </button>
                <button
                  type="button"
                  onClick={handleResetChatColor}
                  className="rounded-lg border border-white/20 px-4 py-2 text-sm text-gray-300 transition hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300 focus-visible:ring-offset-2 focus-visible:ring-offset-[#052e1f]"
                >
                  Reset
                </button>
              </div>

              {chatColorMsg && (
                <p className="mt-3 text-sm text-emerald-300">{chatColorMsg}</p>
              )}
            </>
          ) : (
            <p className="text-sm text-gray-400">
              Unlock custom chat colors with a Grynd+ membership.{" "}
              <a href="/shop" className="text-emerald-300 underline">
                See the shop
              </a>
              .
            </p>
          )}
        </div>

        {/* Grynd+ Profile Customization */}
        <div className="mt-8 rounded-xl border border-sky-400/35 bg-[#03203a]/85 p-6 shadow-[0_0_24px_rgba(56,189,248,0.15)]">
          <div className="mb-4 flex items-center justify-between gap-4">
            <h2 className="text-xl text-sky-300">Profile Customization</h2>
            {membership?.active && (
              <span className="rounded-full border border-emerald-400/60 bg-emerald-500/10 px-3 py-1 text-sm font-semibold text-emerald-300">
                Grynd+
              </span>
            )}
          </div>

          {membership?.active ? (
            <>
              <p className="mb-4 text-sm text-gray-300">
                Accent color and avatar frame — Grynd+ perks. Shown on your profile card.
              </p>

              <p className="mb-2 text-sm font-semibold text-sky-300">Accent color</p>
              <div className="mb-2 flex flex-wrap gap-2">
                {ACCENT_COLORS.map((color) => (
                  <button
                    key={color}
                    type="button"
                    onClick={() => setCosmetics((c) => ({ ...c, accent: color }))}
                    aria-label={`Set accent color ${color}`}
                    title={color}
                    className={`h-8 w-8 rounded-full border-2 transition ${
                      cosmetics.accent.toLowerCase() === color.toLowerCase()
                        ? "scale-110 border-white"
                        : "border-white/20 hover:border-white/60"
                    }`}
                    style={{ backgroundColor: color }}
                  />
                ))}
              </div>
              <div className="mb-4 flex items-center gap-2">
                <input
                  type="color"
                  value={cosmetics.accent}
                  onChange={(e) => setCosmetics((c) => ({ ...c, accent: e.target.value }))}
                  aria-label="Custom accent color"
                  className="h-8 w-10 cursor-pointer rounded border border-white/20 bg-transparent"
                />
                <input
                  type="text"
                  value={cosmetics.accent}
                  onChange={(e) => setCosmetics((c) => ({ ...c, accent: e.target.value.trim() }))}
                  maxLength={7}
                  aria-label="Custom accent hex value"
                  className="w-28 rounded border border-white/20 bg-[#0b224f]/60 px-2 py-1 text-sm text-white focus:border-sky-400 focus:outline-none"
                />
              </div>

              <p className="mb-2 text-sm font-semibold text-sky-300">Avatar frame</p>
              <div className="mb-4 flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={() => setCosmetics((c) => ({ ...c, frame: null }))}
                  className={`h-10 w-10 rounded-full border-2 bg-white/10 text-[9px] font-bold text-white/60 transition ${
                    cosmetics.frame === null
                      ? "scale-110 border-white"
                      : "border-white/20 hover:border-white/60"
                  }`}
                >
                  None
                </button>
                {Object.entries(AVATAR_FRAME_OPTIONS).map(([key, def]) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setCosmetics((c) => ({ ...c, frame: key }))}
                    title={def.label}
                    aria-label={`Avatar frame ${def.label}`}
                    className={`h-10 w-10 rounded-full border-2 transition ${
                      cosmetics.frame === key
                        ? "scale-110 border-white"
                        : "border-white/20 hover:border-white/60"
                    }`}
                    style={{ background: def.background }}
                  />
                ))}
              </div>

              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={handleSaveCosmetics}
                  className="rounded-lg bg-sky-500 px-4 py-2 text-sm font-semibold text-[#001a2e] transition hover:bg-sky-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300 focus-visible:ring-offset-2 focus-visible:ring-offset-[#03203a]"
                >
                  Save customization
                </button>
              </div>

              {cosmeticsMsg && <p className="mt-3 text-sm text-sky-300">{cosmeticsMsg}</p>}
            </>
          ) : (
            <p className="text-sm text-gray-400">
              Customize your profile with a Grynd+ membership.{" "}
              <a href="/shop" className="text-sky-300 underline">
                See the shop
              </a>
              .
            </p>
          )}
        </div>

        <div className="mt-8 rounded-xl border border-cyan-400/35 bg-[#03203a]/85 p-6 shadow-[0_0_24px_rgba(34,211,238,0.12)]">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-xl text-cyan-300">Profile Banner</h2>
              <p className="mt-1 text-sm text-gray-300">
                Equip an official banner unlocked through the Battlepass.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setIsBannerPickerOpen(true)}
              className="rounded-lg bg-cyan-400 px-4 py-2 text-sm font-semibold text-[#001a2e] transition hover:bg-cyan-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-200 focus-visible:ring-offset-2 focus-visible:ring-offset-[#03203a]"
            >
              Choose banner
            </button>
          </div>
          <div className="mt-4 overflow-hidden rounded-lg border border-white/10 bg-[#08142f]">
            {profileInfo.selectedBanner ? (
              <ProfileBanner bannerKey={profileInfo.selectedBanner} heightClass="h-16 sm:h-20" />
            ) : (
              <div className="flex h-16 items-center justify-center text-sm text-white/45 sm:h-20">
                No banner equipped
              </div>
            )}
          </div>
        </div>

        {/* Emotes — in-game animated emote loadout (up to 9 equipped).
            GG + NICE MOVE stay permanently available in games and are never
            part of this loadout. Managed through ChooseEmotesModal. */}
        <div className="mt-8 rounded-xl border border-fuchsia-400/35 bg-[#18071f]/85 p-6 shadow-[0_0_24px_rgba(217,70,239,0.12)]">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-xl text-fuchsia-300">Emotes</h2>
              <p className="mt-1 text-sm text-gray-300">
                Choose up to 9 animated emotes to use in games. GG and NICE MOVE are always available.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setIsEmotesManagerOpen(true)}
              className="rounded-lg bg-fuchsia-400 px-4 py-2 text-sm font-semibold text-[#001a2e] transition hover:bg-fuchsia-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fuchsia-200 focus-visible:ring-offset-2 focus-visible:ring-offset-[#18071f]"
            >
              Manage emotes
            </button>
          </div>
          <EmoteLoadoutStrip onChange={setIsEmotesManagerOpen} />
        </div>

        {/* Responsible Play — per-player daily loss limit */}
        <div className="mt-8 rounded-xl border border-amber-400/35 bg-[#1d1605]/85 p-6 shadow-[0_0_24px_rgba(245,255,59,0.12)]">
          <h2 className="text-xl text-amber-300">Responsible Play</h2>
          <p className="mb-4 mt-1 text-sm text-gray-300">
            Set your own daily loss limit. When you're down more than this in
            one day, the casino lobby will warn you before you keep playing —
            it never blocks you.
          </p>

          <div className="flex flex-wrap gap-2">
            {[
              { key: "default", label: "Global default (50k)" },
              { key: "off", label: "Warnings off" },
              { key: "custom", label: "Custom" },
            ].map((opt) => (
              <button
                key={opt.key}
                type="button"
                onClick={() => setLossLimitMode(opt.key)}
                className={`rounded-full border px-4 py-1.5 text-sm font-semibold transition ${
                  lossLimitMode === opt.key
                    ? "border-amber-400 bg-amber-500/20 text-amber-200"
                    : "border-gray-600 bg-gray-800/40 text-gray-400 hover:border-amber-500/50 hover:text-amber-200"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          {lossLimitMode === "custom" && (
            <div className="mt-3 flex flex-wrap items-end gap-2">
              <label className="flex flex-col gap-1 text-xs font-semibold text-amber-200">
                Daily loss limit (tokens)
                <input
                  type="number"
                  min={1}
                  value={lossLimitDraft}
                  onChange={(e) => setLossLimitDraft(e.target.value)}
                  className="w-44 rounded-md border border-amber-600/50 bg-[#020617] px-2 py-1.5 text-sm text-white outline-none focus:border-amber-400"
                  aria-label="Custom daily loss limit in tokens"
                />
              </label>
              <div className="flex flex-wrap gap-1.5">
                {[5000, 10000, 25000, 50000].map((v) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setLossLimitDraft(String(v))}
                    className="rounded-full border border-gray-600 bg-gray-800/40 px-2.5 py-1 text-[11px] font-bold text-gray-300 transition hover:border-amber-500/50 hover:text-amber-200"
                  >
                    {v.toLocaleString()}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="mt-4 flex items-center gap-3">
            <button
              type="button"
              onClick={saveLossLimit}
              disabled={lossLimitSaving}
              className="rounded-xl border-b-4 border-amber-700 bg-amber-500 px-5 py-2 text-sm font-extrabold text-black transition hover:brightness-110 disabled:opacity-60"
            >
              {lossLimitSaving ? "Saving…" : "Save limit"}
            </button>
            {lossLimitMsg && (
              <span
                className={`text-sm ${
                  lossLimitMsg.ok ? "text-emerald-300" : "text-red-300"
                }`}
              >
                {lossLimitMsg.text}
              </span>
            )}
          </div>
        </div>

        <div className="mt-8 rounded-xl border border-fuchsia-400/35 bg-[#0d0a28]/85 p-6 shadow-[0_0_24px_rgba(217,70,239,0.2)]">
          <button
            type="button"
            onClick={() => setTitlesOpen((o) => !o)}
            className="flex w-full items-center justify-between text-left focus-visible:outline-none"
            aria-expanded={titlesOpen}
            aria-controls="titles-section-body"
          >
            <h2 className="text-xl text-fuchsia-300">Titles</h2>
            <svg
              className={`w-5 h-5 text-fuchsia-300 transition-transform duration-200 ${titlesOpen ? "rotate-180" : ""}`}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
            >
              <path d="M6 9l6 6 6-6" />
            </svg>
          </button>

          {titlesOpen && (
            <div id="titles-section-body" className="mt-4">
              <div className="flex gap-2 mb-4">
                <button
                  onClick={() => setTitlesView("special")}
                  className={`rounded px-3 py-1 text-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fuchsia-400 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0d0a28] ${
                    titlesView === "special"
                      ? "bg-fuchsia-500 text-white"
                      : "bg-white/10 text-gray-300"
                  }`}
                >
                  Special Titles
                </button>

                <button
                  onClick={() => setTitlesView("vip")}
                  className={`rounded px-3 py-1 text-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0d0a28] ${
                    titlesView === "vip" ? "bg-cyan-500 text-white" : "bg-white/10 text-gray-300"
                  }`}
                >
                  VIP Titles
                </button>
                <button
                  onClick={() => setTitlesView("streak")}
                  className={`rounded px-3 py-1 text-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0d0a28] ${
                    titlesView === "streak"
                      ? "bg-amber-500 text-black"
                      : "bg-white/10 text-gray-300"
                  }`}
                >
                  Streak Titles{" "}
                  <svg
                    className="w-4 h-4 inline text-amber-400"
                    viewBox="0 0 24 24"
                    fill="currentColor"
                  >
                    <path d="M12 23c-1.4 0-2.5-1.1-2.5-2.5 0-.5.1-.9.4-1.3-1.9-1-4.1-2.3-4.1-4.7 0-2.2 1.5-4 3.5-5.5C10 8.4 10.5 7.5 12 2c1.5 5.5 2 6.4 2.7 7 2 1.5 3.5 3.3 3.5 5.5 0 2.4-2.2 3.7-4.1 4.7.3.4.4.8.4 1.3 0 1.4-1.1 2.5-2.5 2.5z" />
                  </svg>
                </button>
                <button
                  onClick={() => setTitlesView("prestige")}
                  className={`rounded px-3 py-1 text-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0d0a28] ${
                    titlesView === "prestige"
                      ? "bg-violet-500 text-white"
                      : "bg-white/10 text-gray-300"
                  }`}
                >
                  👑 Prestige
                </button>
              </div>

              {titlesView === "special" && (
                <div className="grid gap-3 md:grid-cols-2">
                  {(specialTitles.titles || []).map((title) => {
                    const isUnlocked = !!title.unlocked;
                    const isEquipped = specialTitles.selectedSpecialTitle === title.key;

                    return (
                      <button
                        key={title.key}
                        disabled={!isUnlocked}
                        onClick={() => handleEquipSpecialTitle(isEquipped ? "" : title.key)}
                        className={[
                          "rounded-lg border p-3 text-left transition",
                          isUnlocked
                            ? "border-fuchsia-300/45 bg-fuchsia-500/10 hover:bg-fuchsia-500/20"
                            : "cursor-not-allowed border-slate-700 bg-slate-900/60 opacity-50",
                          isEquipped ? "ring-2 ring-yellow-300" : "",
                        ].join(" ")}
                      >
                        <p className="text-xs uppercase tracking-widest text-slate-300">
                          {title.rarity}
                        </p>

                        <p className="font-semibold text-white">
                          {isUnlocked ? title.name : "?????"}
                        </p>

                        <p className="text-xs text-slate-300">
                          {isUnlocked ? title.description : "Locked secret title"}
                        </p>

                        {isEquipped && (
                          <p className="mt-2 text-yellow-300 text-xs">Click again to unequip</p>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}

              {titlesView === "streak" && (
                <div className="space-y-4">
                  <div className="rounded-lg border border-amber-300/40 bg-amber-500/10 p-4">
                    <p className="text-xs uppercase tracking-wider text-amber-300 mb-2">
                      Current Streak
                    </p>
                    <p className="text-2xl font-bold text-white">
                      <svg
                        className="w-6 h-6 inline text-amber-400"
                        viewBox="0 0 24 24"
                        fill="currentColor"
                      >
                        <path d="M12 23c-1.4 0-2.5-1.1-2.5-2.5 0-.5.1-.9.4-1.3-1.9-1-4.1-2.3-4.1-4.7 0-2.2 1.5-4 3.5-5.5C10 8.4 10.5 7.5 12 2c1.5 5.5 2 6.4 2.7 7 2 1.5 3.5 3.3 3.5 5.5 0 2.4-2.2 3.7-4.1 4.7.3.4.4.8.4 1.3 0 1.4-1.1 2.5-2.5 2.5z" />
                      </svg>{" "}
                      {streakState.dailyStreakCurrent} day
                      {(streakState.dailyStreakCurrent || 0) !== 1 ? "s" : ""}
                    </p>
                    <p className="text-sm text-amber-200 mt-1">
                      Best: {streakState.dailyStreakBest} day
                      {(streakState.dailyStreakBest || 0) !== 1 ? "s" : ""}
                    </p>
                  </div>

                  <div className="rounded-lg border border-amber-300/30 bg-amber-500/5 p-4">
                    <p className="text-xs uppercase tracking-wider text-amber-300 mb-3">
                      Equip Streak Title
                    </p>
                    <div className="flex flex-wrap gap-2 mb-3">
                      <button
                        onClick={() =>
                          handleEquipStreakTitle(
                            streakState.selectedStreakType === "current" ? "" : "current"
                          )
                        }
                        className={`rounded-lg px-4 py-2 text-sm font-semibold transition ${
                          streakState.selectedStreakType === "current"
                            ? "bg-amber-500 text-black ring-2 ring-yellow-300"
                            : "border border-amber-400/40 text-amber-200 hover:bg-amber-500/20"
                        }`}
                      >
                        {streakState.streakTitleCurrent || "No title"}
                        {streakState.selectedStreakType === "current" ? " (equipped)" : ""}
                      </button>
                      <button
                        onClick={() =>
                          handleEquipStreakTitle(
                            streakState.selectedStreakType === "best" ? "" : "best"
                          )
                        }
                        className={`rounded-lg px-4 py-2 text-sm font-semibold transition ${
                          streakState.selectedStreakType === "best"
                            ? "bg-amber-500 text-black ring-2 ring-yellow-300"
                            : "border border-amber-400/40 text-amber-200 hover:bg-amber-500/20"
                        }`}
                      >
                        {streakState.streakTitleBest || "No title"}
                        {streakState.selectedStreakType === "best" ? " (equipped)" : ""}
                      </button>
                    </div>
                    {streakState.selectedStreakType && (
                      <button
                        onClick={() => handleEquipStreakTitle("")}
                        className="text-xs text-amber-400 hover:text-amber-300 underline"
                      >
                        Unequip streak title
                      </button>
                    )}
                  </div>

                  <div>
                    <p className="text-xs uppercase tracking-wider text-amber-300 mb-2">
                      All Streak Milestones
                    </p>
                    <div className="grid gap-2 sm:grid-cols-2">
                      {streakState.allStreakTitles.map((milestone) => {
                        const isCurrentReached =
                          (streakState.dailyStreakCurrent || 0) >= milestone.days;
                        const isBestReached = (streakState.dailyStreakBest || 0) >= milestone.days;
                        const reached = isCurrentReached || isBestReached;
                        return (
                          <div
                            key={milestone.days}
                            className={`rounded-lg border p-2 text-sm ${
                              reached
                                ? "border-amber-400/40 bg-amber-500/10"
                                : "border-slate-700 bg-slate-900/60 opacity-50"
                            }`}
                          >
                            <span className="text-slate-400">{milestone.days} days</span>
                            <span className="ml-2 font-semibold text-white">{milestone.title}</span>
                            {reached && (
                              <svg
                                className="ml-1 w-3.5 h-3.5 inline text-green-400"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2.5"
                              >
                                <path d="M20 6L9 17l-5-5" />
                              </svg>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              )}

              {titlesView === "vip" && (
                <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
                  {(vipTitles?.allTitles || []).map((title) => {
                    const unlocked = (vipTitles?.unlockedTitles || []).some(
                      (x) => x.title === title.title
                    );

                    const equipped = vipTitles?.selectedTitle === title.title;

                    return (
                      <button
                        key={title.title}
                        disabled={!unlocked}
                        onClick={async () => {
                          const response = await fetch("/api/titles/select", {
                            method: "POST",
                            headers: {
                              "Content-Type": "application/json",
                            },
                            credentials: "include",
                            body: JSON.stringify({
                              title: equipped ? "" : title.title,
                            }),
                          });

                          const data = await response.json();

                          if (response.ok && data.success) {
                            await loadVipTitles();
                            await loadTitles();
                            await loadProfileData();

                            window.dispatchEvent(new Event("titleUpdated"));
                          }
                        }}
                        className={[
                          "rounded-lg border p-3 text-left transition",
                          unlocked
                            ? "border-cyan-300/45 bg-cyan-500/10 hover:bg-cyan-500/20"
                            : "cursor-not-allowed border-slate-700 bg-slate-900/60 opacity-50",
                          equipped ? "ring-2 ring-yellow-300" : "",
                        ].join(" ")}
                      >
                        <p className="text-xs uppercase tracking-widest text-slate-300">
                          {title.rarity}
                        </p>

                        <p className="font-semibold text-white">
                          {unlocked ? title.title : "Locked"}
                        </p>

                        <p className="text-xs text-slate-300">Unlock at Level {title.level}</p>

                        {equipped && (
                          <p className="mt-2 text-yellow-300 text-xs">Click again to unequip</p>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}

              {titlesView === "prestige" && (
                <div className="rounded-lg border border-violet-400/35 bg-violet-500/5 p-4">
                  <div className="flex items-center gap-3">
                    <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-violet-300/50 bg-violet-500/15 text-2xl">
                      👑
                    </div>
                    <div>
                      <p className="text-xs uppercase tracking-widest text-violet-300">
                        Prestige badge
                      </p>
                      <p className="text-lg font-bold text-white">
                        {prestigeBadge.display ||
                          `Prestige ${prestigeBadge.prestige}`}
                      </p>
                    </div>
                  </div>
                  <p className="mt-3 text-sm text-slate-300">
                    Show your permanent Prestige tier next to your name
                    instead of a normal title. The tier always comes from
                    your real server progress — you can only ever display
                    the Prestige you actually earned, and your existing
                    titles stay available whenever you switch back.
                  </p>
                  {prestigeBadge.prestigeUnlocked ? (
                    <div className="mt-4 flex flex-wrap items-center gap-3">
                      <button
                        type="button"
                        disabled={prestigeBadge.loading}
                        onClick={() =>
                          handleEquipPrestigeBadge(!prestigeBadge.enabled)
                        }
                        className="rounded-lg border border-violet-300/60 bg-violet-500/20 px-4 py-2 text-sm font-semibold text-violet-100 transition hover:bg-violet-500/35 disabled:opacity-50"
                      >
                        {prestigeBadge.enabled
                          ? "Click to hide the Prestige badge"
                          : "Display Prestige badge"}
                      </button>
                      {prestigeBadge.enabled && (
                        <span className="rounded-full border border-yellow-300/70 bg-yellow-300/10 px-2.5 py-0.5 text-xs font-semibold text-yellow-200">
                          Equipped
                        </span>
                      )}
                    </div>
                  ) : (
                    <p className="mt-3 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs text-slate-300">
                      🔒 Prestige unlocks at Level 100 — keep climbing the
                      Battle Pass to earn your first Prestige tier.
                    </p>
                  )}
                  {prestigeBadge.error && (
                    <p className="mt-2 text-xs text-red-400">
                      {prestigeBadge.error}
                    </p>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        <div
          className="mt-8 bg-[#0b224f]/85 border border-[#00e5ff]/30 
rounded-xl p-6 
shadow-[0_0_24px_rgba(0,229,255,0.15)]"
        >
          <h2 className="text-xl text-[#00e5ff] mb-4">Referral System</h2>

          <div className="grid gap-4 md:grid-cols-3 mb-4">
            <div className="rounded-lg border border-[#FFD700]/40 p-4">
              <p className="text-sm text-gray-300">Your Referral Code</p>
              <p className="text-2xl font-bold text-[#00e5ff]">
                {stats?.referralCode ? stats.referralCode : "No code yet"}
              </p>
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

          <input
            readOnly
            value={stats?.referralCode || ""}
            className="w-full mb-4 rounded bg-[#08142f] border border-[#00e5ff]/30 
focus:ring-2 focus:ring-[#00e5ff] px-4 py-2 text-[#00e5ff]"
          />

          <div className="flex flex-wrap gap-3 mb-4">
            <button
              onClick={handleCopyReferralCode}
              className={
                cyberButton +
                " focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0b224f]"
              }
            >
              Copy Code
            </button>

            <button
              onClick={handleShareReferralCode}
              className="rounded-lg px-4 py-2 font-semibold text-white 
  border border-[#00e5ff] 
  hover:bg-[#00e5ff]/10 
  shadow-[0_0_10px_rgba(0,229,255,0.4)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0b224f]"
            >
              Share Code
            </button>
          </div>

          <div className="flex flex-col md:flex-row gap-3">
            <label htmlFor="profil-redeem-code" className="sr-only">
              Enter referral code
            </label>
            <input
              id="profil-redeem-code"
              value={referralCodeInput}
              onChange={(e) => setReferralCodeInput(e.target.value)}
              placeholder="Enter referral code"
              className="flex-1 rounded bg-[#08142f] border border-[#00e5ff]/30 
focus:ring-2 focus:ring-[#00e5ff] px-4 py-2 outline-none focus:ring-2 focus:ring-[#FFD700]"
            />
            <button
              onClick={handleRedeemCode}
              className="rounded bg-green-500 px-4 py-2 font-semibold hover:bg-green-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-400 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0b224f]"
            >
              Redeem
            </button>
          </div>

          {referralStatus && <p className="mt-3 text-sm text-gray-200">{referralStatus}</p>}
        </div>

        <div
          className="mt-8 bg-[#0b224f]/85 border border-[#00e5ff]/30 
rounded-xl p-6 
shadow-[0_0_24px_rgba(0,229,255,0.15)]"
        >
          <h2 className="text-xl text-[#00e5ff] mb-4">Add Friends</h2>
          <div className="flex gap-2 mb-4">
            <label htmlFor="profil-friend-search" className="sr-only">
              Search users by name
            </label>
            <input
              id="profil-friend-search"
              value={friendSearch}
              onChange={(e) => setFriendSearch(e.target.value)}
              placeholder="Type letters to search users (like Ctrl+F)"
              className="flex-1 rounded bg-[#08142f] border border-[#00e5ff]/30 
focus:ring-2 focus:ring-[#00e5ff] px-4 py-2"
            />
            <button
              onClick={handleSearchFriends}
              disabled={isSearchingFriends}
              className="rounded bg-[#FFD700] px-4 py-2 text-[#003366] font-semibold disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0b224f]"
            >
              {isSearchingFriends ? "Searching..." : "Refresh"}
            </button>
          </div>

          <div className="space-y-2">
            {friendSearchResults.map((person) => (
              <div
                key={person.id}
                className="flex items-center justify-between rounded border border-[#FFD700]/40 p-3"
              >
                <div className="flex items-center gap-3">
                  <IconAvatar
                    iconKey={person.icon_key}
                    name={person.name}
                    size="h-10 w-10"
                  />
                  <span>{person.name}</span>
                </div>
                <button
                  onClick={() => handleInviteFriend(person.id)}
                  className="rounded-lg px-3 py-1 text-sm font-semibold text-white 
bg-gradient-to-r from-[#00ffcc] to-[#00e5ff] 
shadow-[0_0_10px_rgba(0,255,200,0.6)] 
hover:scale-105 transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0b224f]"
                >
                  Add Friend
                </button>
              </div>
            ))}
            {friendSearch && friendSearchResults.length === 0 && !isSearchingFriends && (
              <p className="text-sm text-gray-300">No users found for this name.</p>
            )}
          </div>

          {friendsStatus && <p className="mt-3 text-sm text-gray-200">{friendsStatus}</p>}
        </div>

        <div
          className="mt-8 bg-[#0b224f]/85 border border-[#00e5ff]/30 rounded-xl p-6 
shadow-[0_0_24px_rgba(0,229,255,0.15)]"
        >
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl text-[#00e5ff]">My Friends</h2>

            <button
              onClick={async () => {
                await loadFriends();
                await loadFriendPresence();
                await loadFriendInvites();
              }}
              className="rounded bg-[#FFD700] px-3 py-1 text-sm font-semibold text-[#003366] hover:bg-[#ffd700]/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0b224f]"
            >
              Refresh
            </button>
          </div>
          <div className="mb-4 flex gap-2">
            <button
              onClick={() => setActiveFriendsTab("friends")}
              className={`rounded px-3 py-1 text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0b224f] ${activeFriendsTab === "friends" ? "bg-[#00e5ff] text-[#003366]" : "bg-white/10 text-white"}`}
            >
              Friends
            </button>
            <button
              onClick={() => setActiveFriendsTab("invites")}
              className={`rounded px-3 py-1 text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0b224f] ${activeFriendsTab === "invites" ? "bg-[#00e5ff] text-[#003366]" : "bg-white/10 text-white"}`}
            >
              Invites ({receivedInvites.length})
            </button>
          </div>
          {activeFriendsTab === "friends" && (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {myFriends.length > 0 ? (
                myFriends.map((friend) => (
                  <a
                    key={`${friend.id}-${friend.name}`}
                    href={`/profil/${encodeURIComponent(friend.clerk_id)}`}
                    className="rounded border border-[#FFD700]/30 bg-white/5 p-3 flex items-center gap-3 hover:bg-white/10 transition-colors cursor-pointer"
                  >
                    <IconAvatar
                      iconKey={friend.icon_key}
                      name={friend.name}
                      size="h-10 w-10"
                    />
                    <div className="flex-1">
                      <span className="flex flex-wrap items-center gap-x-1.5">
                        {friend.name}
                        {friend.prestigeBadge && (
                          <span className="rounded-full border border-violet-400/70 bg-violet-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-violet-300">
                            {friend.prestigeBadge}
                          </span>
                        )}
                      </span>
                      {friend.streakTitle && (
                        <span className="ml-2 rounded-full border border-amber-400/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-300">
                          <svg
                            className="w-3 h-3 inline text-amber-400"
                            viewBox="0 0 24 24"
                            fill="currentColor"
                          >
                            <path d="M12 23c-1.4 0-2.5-1.1-2.5-2.5 0-.5.1-.9.4-1.3-1.9-1-4.1-2.3-4.1-4.7 0-2.2 1.5-4 3.5-5.5C10 8.4 10.5 7.5 12 2c1.5 5.5 2 6.4 2.7 7 2 1.5 3.5 3.3 3.5 5.5 0 2.4-2.2 3.7-4.1 4.7.3.4.4.8.4 1.3 0 1.4-1.1 2.5-2.5 2.5z" />
                          </svg>{" "}
                          {friend.streakTitle}
                        </span>
                      )}
                      {(() => {
                        const status = getFriendStatus(friend.id);
                        return (
                          <p className={`text-xs flex items-center gap-2 ${status.color}`}>
                            <span
                              className={`h-2 w-2 rounded-full ${
                                status.state === "online"
                                  ? "bg-green-400"
                                  : status.state === "in_game"
                                    ? "bg-yellow-400"
                                    : "bg-gray-400"
                              }`}
                            />
                            {status.label}
                          </p>
                        );
                      })()}
                    </div>
                    <div className="flex items-center gap-2">
                      {(() => {
                        const status = getFriendStatus(friend.id);
                        const spectateUrl = spectateUrlForFriend(friend.id);
                        const gameKey = String(friendPresenceByFriend?.[friend.id]?.gameKey || "")
                          .toLowerCase()
                          .trim();

                        if (status.state !== "in_game" || !spectateUrl) return null;

                        const allowedSpectateGames = new Set(["chess", "four-in-a-row", "poker"]);
                        if (!allowedSpectateGames.has(gameKey)) return null;

                        return (
                          <button
                            onClick={() => {
                              if (!isAllowedSpectateUrl(spectateUrl)) {
                                setFriendsStatus("This spectate link is invalid.");
                                return;
                              }
                              setSpectateLoadError("");
                              setSpectateIsLoaded(false);
                              setSpectateOverlayUrl(spectateUrl);
                            }}
                            aria-label={`Spectate ${friend.name}`}
                            className="rounded bg-[#00e5ff] px-2 py-1 text-xs font-semibold text-[#003366] animate-pulse focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0b224f]"
                          >
                            Spectate
                          </button>
                        );
                      })()}

                      <button
                        onClick={(e) => {
                          e.preventDefault();
                          handleRemoveFriend(friend.id);
                        }}
                        aria-label={`Remove ${friend.name}`}
                        className="rounded-lg px-2 py-1 text-xs font-semibold text-white 
bg-gradient-to-r from-red-500 to-red-700 
shadow-[0_0_10px_rgba(255,0,0,0.6)] 
hover:scale-105 transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0b224f]"
                      >
                        Remove
                      </button>
                    </div>
                  </a>
                ))
              ) : (
                <p className="text-sm text-gray-300">No friends yet.</p>
              )}
            </div>
          )}
          {activeFriendsTab === "invites" && (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {receivedInvites.length > 0 ? (
                receivedInvites.map((invite) => (
                  <div
                    key={invite.id}
                    className="rounded border border-[#FFD700]/30 bg-white/5 p-3 flex items-center gap-3"
                  >
                    <IconAvatar
                      iconKey={invite.sender_icon_key}
                      name={invite.sender_name}
                      size="h-10 w-10"
                    />
                    <div className="flex-1">
                      <p className="text-sm font-semibold">{invite.sender_name}</p>
                      <p className="text-xs text-gray-300">
                        Sent {new Date(invite.created_at).toLocaleString()}
                      </p>
                    </div>
                    <div className="flex flex-col gap-1">
                      <button
                        onClick={() => handleRespondToInvite(invite.id, "accept")}
                        aria-label={`Accept invite from ${invite.sender_name}`}
                        className="rounded bg-green-500 px-2 py-1 text-xs font-semibold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-400 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0b224f]"
                      >
                        Accept
                      </button>
                      <button
                        onClick={() => handleRespondToInvite(invite.id, "decline")}
                        aria-label={`Decline invite from ${invite.sender_name}`}
                        className="rounded bg-red-500 px-2 py-1 text-xs font-semibold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0b224f]"
                      >
                        Decline
                      </button>
                    </div>
                  </div>
                ))
              ) : (
                <p className="text-sm text-gray-300">No pending invites.</p>
              )}
            </div>
          )}
        </div>
        {spectateOverlayUrl && (
          <div className="fixed inset-0 z-[100] bg-black/90 flex items-center justify-center p-4">
            <div className="relative h-[90vh] w-[95vw] rounded-xl border border-[#00e5ff]/40 bg-black overflow-hidden">
              <button
                onClick={() => {
                  setSpectateOverlayUrl("");
                  setSpectateLoadError("");
                  setSpectateIsLoaded(false);
                }}
                className="absolute right-3 top-3 z-10 rounded bg-red-600 px-3 py-1 text-sm font-semibold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-black"
              >
                Close Spectate
              </button>
              {!spectateIsLoaded && !spectateLoadError && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/80 text-sm text-gray-200">
                  Loading spectate view...
                </div>
              )}
              {spectateLoadError && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/90 p-6 text-center">
                  <p className="text-red-300">{spectateLoadError}</p>
                  <button
                    onClick={() => {
                      setSpectateLoadError("");
                      setSpectateIsLoaded(false);
                      setSpectateOverlayUrl((prev) => `${prev.split("#")[0]}#retry-${Date.now()}`);
                    }}
                    className="rounded bg-[#00e5ff] px-3 py-1 text-xs font-semibold text-[#003366] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-black"
                  >
                    Retry
                  </button>
                </div>
              )}
              {isAllowedSpectateUrl(spectateOverlayUrl) ? (
                <iframe
                  src={spectateOverlayUrl}
                  className="h-full w-full border-0"
                  title="Friend spectate view"
                  onLoad={() => setSpectateIsLoaded(true)}
                  onError={() =>
                    setSpectateLoadError(
                      "Unable to render spectate page. The game may have ended or embedding is blocked."
                    )
                  }
                />
              ) : (
                <div className="absolute inset-0 flex items-center justify-center bg-black/90 p-6 text-center text-red-300">
                  Invalid spectate destination.
                </div>
              )}
            </div>
          </div>
        )}

        <div
          className="mt-8 bg-[#0b224f]/85 border border-[#00e5ff]/30 
rounded-xl p-6 
shadow-[0_0_24px_rgba(0,229,255,0.15)]"
        >
          <h2 className="text-xl text-[#00e5ff] mb-4">User Statistics</h2>
          {statsError && <p className="text-red-400 mb-4">{statsError}</p>}
          {/* Tabbed stat panel — mirrors the /classement leaderboard
              (record / weekly / streaks) instead of a flat grid. */}
          <UserStatsTabs record={stats?.record} />
        </div>

        <div
          className="mt-12 bg-[#0b224f]/85 border border-[#00e5ff]/30 
rounded-xl p-6 
shadow-[0_0_24px_rgba(0,229,255,0.15)]"
        >
          <h2 className="text-xl text-[#00e5ff] mb-4">Historique des Paris</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left">
              <thead className="border-b border-[#FFD700] text-[#00e5ff]">
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
                      <td className="px-4 py-2">
                        {bet.type || bet.event || bet.game_type || "Inconnu"}
                      </td>
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

        <div
          className="mt-12 bg-[#0b224f]/85 border border-[#00e5ff]/30 
rounded-xl p-6 
shadow-[0_0_24px_rgba(0,229,255,0.15)]"
        >
          <h2 className="text-xl text-[#00e5ff] mb-4">Historique des Achats de Jetons</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left">
              <thead className="border-b border-[#FFD700] text-[#00e5ff]">
                <tr>
                  <th className="px-4 py-2">Date</th>
                  <th className="px-4 py-2">Forfait</th>
                  <th className="px-4 py-2">Jetons</th>
                </tr>
              </thead>
              <tbody>
                {purchases.length > 0 ? (
                  purchases.map((purchase, idx) => (
                    <tr key={purchase.id ?? idx} className="border-b border-[#FFD700]/20">
                      <td className="px-4 py-2">
                        {new Date(purchase.createdAt).toLocaleDateString()}
                      </td>
                      <td className="px-4 py-2">
                        {purchase.note || purchase.referenceId || "Achat"}
                      </td>
                      <td className="px-4 py-2 text-green-400">
                        +{Number(purchase.amount ?? 0).toLocaleString()} tokens
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan="3" className="text-center py-4 text-gray-400">
                      Aucun achat trouvé
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="mt-12">
          <ContactMessageHistory />
        </div>

        <div
          className="mt-8 border border-red-500 bg-red-950/40 border border-red-500/40 
shadow-[0_0_20px_rgba(255,0,0,0.15)] rounded-lg p-6"
        >
          <h2 className="text-xl text-red-400 mb-2">Danger Zone: Delete Account</h2>
          <p className="text-red-200 mb-4">
            Warning: This action is permanent. Your account and data will be removed forever.
          </p>

          <label className="text-sm text-red-200" htmlFor="profil-delete-password">
            Confirm password
          </label>
          <input
            id="profil-delete-password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-2 w-full rounded border border-red-400/40 bg-red-900/20 px-4 py-2 outline-none focus:ring-2 focus:ring-red-500"
            placeholder="Enter your password"
          />

          <button
            onClick={handleDeleteAccount}
            disabled={!delayDone || !password || isDeleting}
            className="mt-4 rounded bg-red-600 px-4 py-2 font-semibold hover:bg-red-700 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0b224f]"
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
      </div>

      {isEditOpen && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
          <div
            className="max-w-md w-full rounded-xl border border-[#FFD700] bg-[#0b224f] border border-[#00e5ff]/30 
shadow-[0_0_30px_rgba(0,229,255,0.25)] p-6"
          >
            <h3 className="text-xl font-bold text-[#00e5ff] mb-4">Edit Profile</h3>
            <div className="space-y-3">
              <label htmlFor="profil-edit-name" className="sr-only">
                Name
              </label>
              <input
                id="profil-edit-name"
                value={editForm.name}
                onChange={(e) => setEditForm((prev) => ({ ...prev, name: e.target.value }))}
                placeholder="Name"
                className="w-full rounded bg-[#08142f] border border-[#00e5ff]/30 
focus:ring-2 focus:ring-[#00e5ff] px-4 py-2"
              />
              <label htmlFor="profil-edit-email" className="sr-only">
                Email
              </label>
              <input
                id="profil-edit-email"
                value={editForm.email}
                onChange={(e) => setEditForm((prev) => ({ ...prev, email: e.target.value }))}
                placeholder="Email"
                className="w-full rounded bg-[#08142f] border border-[#00e5ff]/30 
focus:ring-2 focus:ring-[#00e5ff] px-4 py-2"
              />
              <div className="rounded bg-[#08142f] border border-[#00e5ff]/30 p-3">
                <p className="mb-2 block text-sm text-gray-200">My Grynd Icon</p>
                <button
                  type="button"
                  onClick={() => {
                    setIsEditOpen(false);
                    setIsIconPickerOpen(true);
                  }}
                  className="flex w-full items-center gap-3 rounded-lg border border-[#00e5ff]/40 bg-[#00e5ff]/10 px-3 py-2.5 transition hover:bg-[#00e5ff]/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0b224f]"
                >
                  <IconAvatar
                    iconKey={profileInfo.selectedIcon}
                    name={profileInfo.name || user.fullName}
                    size="h-10 w-10"
                    showFrame={false}
                  />
                  <span className="flex-1 text-left text-sm text-gray-200">
                    Choose Your Icon
                  </span>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4 text-[#00e5ff]"><path d="M9 18l6-6-6-6"/></svg>
                </button>
              </div>
              <label htmlFor="profil-edit-password" className="sr-only">
                New password (optional)
              </label>
              <input
                id="profil-edit-password"
                type="password"
                value={editForm.password}
                onChange={(e) => setEditForm((prev) => ({ ...prev, password: e.target.value }))}
                placeholder="New password (optional)"
                className="w-full rounded bg-[#08142f] border border-[#00e5ff]/30 
focus:ring-2 focus:ring-[#00e5ff] px-4 py-2"
              />
            </div>

            {editStatus && <p className="mt-3 text-sm text-gray-200">{editStatus}</p>}

            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => setIsEditOpen(false)}
                className="rounded border border-white/30 px-4 py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0b224f]"
              >
                Close
              </button>
              <button
                disabled={isSavingEdit}
                onClick={handleSaveEditProfile}
                className={
                  cyberButton +
                  " focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0b224f]"
                }
              >
                {isSavingEdit ? "Saving..." : "Save changes"}
              </button>
            </div>
          </div>
        </div>
      )}

      {levelUpModal && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
          <div
            className="max-w-md w-full rounded-xl border border-[#FFD700] bg-[#0b224f] border border-[#00e5ff]/30 
shadow-[0_0_30px_rgba(0,229,255,0.25)] p-6 text-center"
          >
            <p className="text-2xl font-bold text-[#00e5ff]">
              <svg
                className="w-7 h-7 inline text-[#00e5ff]"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              >
                <path d="M12 2l2.4 7.2h7.6l-6 4.8 2.4 7.2-6.4-4.8-6.4 4.8 2.4-7.2-6-4.8h7.6z" />
              </svg>{" "}
              Level Up! You reached Level {levelUpModal.level}
            </p>
            <p className="mt-2 text-gray-200">
              Keep wagering and completing quests — rewards unlock soon.
            </p>
            <button
              onClick={() => setLevelUpModal(null)}
              className={
                cyberButton +
                " focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0b224f]"
              }
            >
              Awesome!
            </button>
          </div>
        </div>
      )}

      <ChooseBannerModal
        open={isBannerPickerOpen}
        onClose={() => setIsBannerPickerOpen(false)}
        currentBannerKey={profileInfo.selectedBanner}
        onEquipped={(bannerKey) =>
          setProfileInfo((prev) => ({ ...prev, selectedBanner: bannerKey }))
        }
      />

      {/* Official Grynd icon picker — owned icons only, no uploads. */}
      <ChooseIconModal
        open={isIconPickerOpen}
        onClose={() => setIsIconPickerOpen(false)}
        currentIconKey={profileInfo.selectedIcon}
        onEquipped={(iconKey) =>
          setProfileInfo((prev) => ({ ...prev, selectedIcon: iconKey }))
        }
      />

      {/* In-game emote loadout manager — equipped animated emotes (max 9). */}
      <ChooseEmotesModal
        open={isEmotesManagerOpen}
        onClose={() => setIsEmotesManagerOpen(false)}
      />
      <Footer />
    </div>
  );
}
