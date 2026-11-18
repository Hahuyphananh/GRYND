"use client";

import ShareProBadgeButton from "../../components/share/ShareProBadgeButton";

import React, { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useUser, useClerk } from "@clerk/nextjs";
import NavigationBar from "../../components/navigation-bar";
import Footer from "../../components/Footer";
import SolitaireModesPanel from "../../components/solitaire-duel/SolitaireModesPanel";
import ContactMessageHistory from "../../components/ContactMessageHistory";
import {
  DEFAULT_PROFILE_ACCENT,
  HEX_COLOR_REGEX,
  ACCENT_COLORS,
  cosmeticFrameRing,
  cosmeticEffectClass,
} from "../../lib/profileCosmetics";
import IconAvatar from "../../components/IconAvatar";
import ProfilePickerModals from "../../components/profil/ProfilePickerModals";
import ProfileEmotesPanel from "../../components/profil/ProfileEmotesPanel";
import BetHistoryPanel from "../../components/profil/BetHistoryPanel";
import EmoteLoadoutStrip from "../../components/EmoteLoadoutStrip";
import UserStatsTabs from "../../components/UserStatsTabs";
import GuestProgressPanel from "../../components/guest/GuestProgressPanel";
import GuestClaimPanel from "../../components/guest/GuestClaimPanel";
import RoomsPanel from "../../components/rooms/RoomsPanel";
import { clearSessionArtifacts } from "../../lib/security/sessionCleanup";
import { fetchDeduped } from "../../lib/dedupeFetch";
import { runOptimistically } from "../../lib/optimistic";
import { useTranslation } from "../../hooks/useTranslation";
import PlayerLevelBadge from "../../components/player-level/PlayerLevelBadge";
import PlayerLevelProgressCard from "../../components/player-level/PlayerLevelProgressCard";

// GRYND PRO chat color palette (matches the neon casino aesthetic).
// `adSlot` is the server-rendered <AdSlot placement="profile" /> from
// app/profil/page.jsx — above the footer, never over a control.
export default function ProfilePage({ adSlot = null, hilltopSlot = null }) {
  const { isSignedIn, isLoaded, user } = useUser();
  const { signOut } = useClerk();
  // Both history panels resolve their copy through the app-wide bundle
  // (src/lib/appTextTranslations.js → `profile.*`) so EN / FR / ES render -
  // the French headings and table labels used to be hardcoded here.
  const { t } = useTranslation();

  const [profileInfo, setProfileInfo] = useState({
    name: "",
    email: "",
    selectedIcon: "",
    profileAccent: null,
  });
  // Unsaved profile customization (accent) — saved via
  // /api/user/profile-customization (GRYND PRO perk).
  const [cosmetics, setCosmetics] = useState({
    accent: DEFAULT_PROFILE_ACCENT,
  });
  const [cosmeticsMsg, setCosmeticsMsg] = useState(null);
  const [bets, setBets] = useState([]);
  const [, setError] = useState(null);

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

  const [titlesView, setTitlesView] = useState("special");
  const [titlesOpen, setTitlesOpen] = useState(false); // collapsed by default so the profile stays compact
  const [vipTitles, setVipTitles] = useState(null);
  const loadVipTitles = async () => {
    const { response, data } = await fetchDeduped("/api/titles", {
      credentials: "include",
    });

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
  // Catalog-granted name glow: currently equipped glow's catalog hex
  // (null = no glow) — rendered on the profile name + used for the preview.
  const [isGlowPickerOpen, setIsGlowPickerOpen] = useState(false);
  const [selectedGlowColor, setSelectedGlowColor] = useState(null);
  const [selectedGlowName, setSelectedGlowName] = useState(null);
  // Owned profile-frame picker (token-shop `profile_frame` cosmetics).
  const [isFramePickerOpen, setIsFramePickerOpen] = useState(false);
  // Equipped cosmetics (category → { key, name, visual }) from the official
  // cosmetics catalog — profile frame / badge / effects. Server-written only.
  const [equippedCosmetics, setEquippedCosmetics] = useState({});
  // Everything the user owns (all categories). The unified profile picker
  // (ChooseFrameModal) loads its own copy; this drives the edit popup's
  // "you own nothing yet" hint.
  const [ownedCosmetics, setOwnedCosmetics] = useState([]);
  // Whether the owned-cosmetics fetch finished, so the edit popup can tell
  // "still loading" apart from "you own nothing yet".
  const [ownedCosmeticsLoaded, setOwnedCosmeticsLoaded] = useState(false);
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

  useEffect(() => {
    if (!spectateOverlayUrl || spectateIsLoaded || spectateLoadError) return;
    const timeoutId = setTimeout(() => {
      setSpectateLoadError(
        t(
          "profile.friends.spectateTimeout",
          "Spectate view timed out. Please retry or ask your friend to reopen the game.",
        ),
      );
    }, 10000);
    return () => clearTimeout(timeoutId);
  }, [spectateOverlayUrl, spectateIsLoaded, spectateLoadError]);

  const loadOwnedCosmetics = async () => {
    try {
      const response = await fetch("/api/cosmetics", { credentials: "include" });
      const data = await response.json();
      if (response.ok && data?.success && Array.isArray(data.owned)) {
        setOwnedCosmetics(data.owned);
        setOwnedCosmeticsLoaded(true);
      }
    } catch (err) {
      console.error("[LOAD_OWNED_COSMETICS_ERROR]", err);
    }
  };

  // Reflect a cosmetic equipped (or cleared) from the unified profile picker
  // immediately, without a full profile reload. Frames and every effect
  // category route through here — the picker is the one place they are all
  // equipped — and the picker stays open so several slots can be changed in a
  // row. The next /api/get-user-tokens load re-syncs the server-authoritative
  // equippedCosmetics map.
  const handleEquipCosmetic = (category, item) => {
    if (!category) return;
    setEquippedCosmetics((prev) => {
      const next = { ...prev };
      if (item) {
        next[category] = { key: item.key, name: item.name, visual: item.visual };
      } else {
        delete next[category];
      }
      return next;
    });
  };

  const loadStats = async () => {
    const res = await fetch("/api/user-stats", { credentials: "include" });
    const data = await res.json();
    if (!res.ok || !data.success) {
      throw new Error(
        data.error || t("profile.errors.statsFailed", "Failed to load stats"),
      );
    }
    setStats(data.stats);
    // Returned so a caller can act on THIS load's stats: the `stats` state
    // variable is not readable in the same tick (see the bootstrap effect).
    return data.stats;
  };

  const loadTitles = async () => {
    const { response, data } = await fetchDeduped("/api/titles", {
      credentials: "include",
    });
    if (response.ok && data.success) {
      setTitleMeta({
        selectedTitle: data.selectedTitle || "",
        highestTitle: data.highestTitle || "",
      });
    }
  };

  const loadGlow = async () => {
    try {
      const response = await fetch("/api/user/glows", {
        credentials: "include",
      });
      const data = await response.json();
      if (response.ok && data?.success && Array.isArray(data.ownedGlows)) {
        const equipped = data.ownedGlows.find((g) => g.equipped) || null;
        setSelectedGlowColor(equipped?.color || null);
        setSelectedGlowName(equipped?.name || null);
      }
    } catch (err) {
      console.error("[LOAD_GLOW_ERROR]", err);
    }
  };

  const handleEquipGlow = (glow) => {
    setSelectedGlowColor(glow?.color || null);
    setSelectedGlowName(glow?.name || null);
    setIsGlowPickerOpen(false);
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
    // Equipping a title is cosmetic and fully reversible, so move the ring
    // immediately and let the server refetch reconcile it. Previously the
    // button did nothing on screen until the round trip finished.
    const previous = specialTitles;
    const picked = (previous.titles || []).find((title) => title.key === titleKey);
    await runOptimistically({
      optimistic: () =>
        setSpecialTitles((current) => ({
          ...current,
          selectedSpecialTitle: titleKey,
          selectedSpecialTitleName: titleKey
            ? picked?.name || current.selectedSpecialTitleName
            : "",
        })),
      rollback: () => setSpecialTitles(previous),
      request: async () => {
        const response = await fetch("/api/titles/equip-special", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ titleKey }),
        });
        const data = await response.json();
        if (!response.ok || !data.success) {
          throw new Error(data.error || "Could not equip that title.");
        }
        await Promise.all([loadSpecialTitles(), loadTitles(), loadProfileData()]);
        window.dispatchEvent(new Event("titleUpdated"));
        window.dispatchEvent(new Event("profileUpdated"));
        return data;
      },
    });
  };

  const handleEquipStreakTitle = async (streakType) => {
    // Same reasoning as the special titles above: flip the highlight now,
    // roll back only if the server rejects the change.
    const previous = streakState;
    await runOptimistically({
      optimistic: () =>
        setStreakState((current) => ({
          ...current,
          selectedStreakType: streakType ? streakType : null,
        })),
      rollback: () => setStreakState(previous),
      request: async () => {
        const response = await fetch("/api/titles/equip-streak", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ streakType }),
        });
        const data = await response.json();
        if (!response.ok || !data.success) {
          throw new Error(data.error || "Could not equip that title.");
        }
        await loadTitles();
        window.dispatchEvent(new Event("titleUpdated"));
        window.dispatchEvent(new Event("profileUpdated"));
        return data;
      },
    });
  };

  const cyberButton =
    "relative overflow-hidden rounded-lg px-4 py-2 font-semibold text-white " +
    "bg-linear-to-r from-[color:var(--accent)] via-[color:var(--accent)] to-[color:var(--accent-strong)] " +
    "shadow-[0_8px_24px_rgba(0,0,0,0.3)] " +
    "hover:shadow-[0_10px_28px_rgba(0,0,0,0.4)] " +
    "hover:scale-[1.02] active:scale-95 transition-all duration-300";

  const loadProfileData = async () => {
    // The nav bar reads this same endpoint when it mounts, so a cold page
    // load shares ONE request between the two (same url + identical init;
    // fetchDeduped keys on both, including key order).
    const { data: tokensData } = await fetchDeduped("/api/get-user-tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
    });

    if (tokensData.success && tokensData.data) {
      const name =
        tokensData.data.name ||
        user?.fullName ||
        t("profile.info.unknownUser", "Unknown user");
      const email = tokensData.data.email || user?.emailAddresses?.[0]?.emailAddress || "";
      const selectedIcon = tokensData.data.selectedIcon || "";
      const profileAccent = tokensData.data.profileAccent || null;
      setProfileInfo({ name, email, selectedIcon, profileAccent });
      setEquippedCosmetics(tokensData.data.equippedCosmetics || {});
      setEditForm((prev) => ({ ...prev, name, email }));
      // Sync the customization picker with the saved value.
      setCosmetics({
        accent: profileAccent || DEFAULT_PROFILE_ACCENT,
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

      // Surface a failure instead of rendering the same empty state as "no
      // user matches this name" — a broken search used to look like a search
      // that found nothing.
      if (!response.ok || !data.success) {
        setFriendSearchResults([]);
        setFriendsStatus(
          data?.error ||
            data?.debug?.error ||
            t(
              "profile.friends.searchFailed",
              "Could not search users. Please try again.",
            ),
        );
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
      setFriendsStatus(
        err.message ||
          t("profile.friends.searchFailed", "Could not search users. Please try again."),
      );
    } finally {
      setIsSearchingFriends(false);
    }
  };

  const handleRemoveFriend = async (friendId) => {
    const confirmed = window.confirm(
      t("profile.friends.confirmRemove", "Remove this friend?"),
    );
    if (!confirmed) return;

    // Drop the row from the grid right away; put it back if the server
    // refuses. The previous version left the card clickable but unchanged
    // until the refetch landed.
    const previous = myFriends;
    setFriendsStatus("");
    const result = await runOptimistically({
      optimistic: () =>
        setMyFriends((current) => current.filter((f) => f.id !== friendId)),
      rollback: () => setMyFriends(previous),
      request: async () => {
        const response = await fetch("/api/friends/remove", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ friendId }),
        });

        const data = await response.json();

        if (!response.ok || !data.success) {
          throw new Error(
            data.error ||
              t("profile.friends.removeFailed", "Could not remove friend."),
          );
        }

        return data;
      },
    });

    if (!result.ok) {
      console.error("[REMOVE_FRIEND_ERROR]", result.error);
      setFriendsStatus(result.error);
      return;
    }

    setFriendsStatus(t("profile.friends.removed", "Friend removed."));
    await loadFriends();
    await loadFriendPresence(); // keep UI in sync
  };

  // NOTE: this page used to run its OWN /api/presence/heartbeat writer on a
  // 5-minute interval, on top of the app-wide <PresenceHeartbeat /> mounted in
  // providers.tsx. That second writer kept the same `user_presence` row alive
  // with no extra benefit. It is gone: the global heartbeat (now browser-wide
  // and deduped across tabs) is the single owner of online/offline freshness,
  // and the profile's friend feed reads the row it maintains.

  const getFriendStatus = (friendId) => {
    const presence = friendPresenceByFriend?.[friendId];
    const normalizedGameKey = String(presence?.gameKey || "")
      .toLowerCase()
      .trim();

    if (presence?.presenceState === "offline" || !presence?.lastSeenAt) {
      return {
        state: "offline",
        label: t("profile.friends.offline", "Offline"),
        color: "text-gray-400",
      };
    }

    if (
      presence?.presenceState === "in_game" ||
      (normalizedGameKey && presence?.gameId !== null && presence?.gameId !== undefined)
    ) {
      return {
        state: "in_game",
        label: t("profile.friends.inGame", { game: normalizedGameKey }),
        color: "text-yellow-400",
      };
    }

    return {
      state: "online",
      label: t("profile.friends.online", "Online"),
      color: "text-green-400",
    };
  };

  const handleInviteFriend = async (friendId) => {
    // No local list to optimistically mutate (the server decides whether this
    // is a pending request or an instant add), so give the click immediate
    // feedback instead of a silent pause.
    setFriendsStatus(t("profile.friends.sendingInvite", "Sending invite…"));
    try {
      const response = await fetch("/api/friends/invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ friendId }),
      });
      const data = await response.json();
      if (!response.ok || !data.success)
        throw new Error(
          data.error || t("profile.friends.inviteFailed", "Could not add friend."),
        );
      setFriendsStatus(
        data.message || t("profile.friends.inviteSent", "Friend invite sent."),
      );
      await loadFriendInvites();
    } catch (err) {
      console.error("[INVITE_FRIEND_ERROR]", err);
      setFriendsStatus(
        err.message || t("profile.friends.inviteFailed", "Could not add friend."),
      );
    }
  };

  const isAllowedSpectateUrl = (url) => {
    if (!url || typeof url !== "string") return false;
    if (!url.startsWith("/")) return false;

    const allowedPrefixes = ["/casino/solitaire-duel/"];

    return allowedPrefixes.some((prefix) => url.startsWith(prefix));
  };

  const spectateUrlForFriend = (friendId) => {
    const presence = friendPresenceByFriend?.[friendId];
    const gameKey = String(presence?.gameKey || "")
      .toLowerCase()
      .trim();
    if (!presence?.gameId || !gameKey) return null;

    if (gameKey === "solitaire-duel")
      return `/casino/solitaire-duel/${presence.gameId}?spectator=1&focusTarget=${encodeURIComponent(friendId)}`;
    return null;
  };

  const handleRespondToInvite = async (inviteId, action) => {
    setFriendsStatus(t("profile.friends.updatingInvite", "Updating invite…"));
    try {
      const response = await fetch("/api/friends/invites/respond", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ inviteId, action }),
      });
      const data = await response.json();
      if (!response.ok || !data.success)
        throw new Error(
          data.error ||
            t("profile.friends.respondFailed", "Could not update invite."),
        );
      setFriendsStatus(
        data.message || t("profile.friends.inviteUpdated", "Invite updated."),
      );
      await Promise.all([loadFriends(), loadFriendInvites(), loadFriendPresence()]);
    } catch (err) {
      console.error("[RESPOND_FRIEND_INVITE_ERROR]", err);
      setFriendsStatus(
        err.message || t("profile.friends.respondFailed", "Could not update invite."),
      );
    }
  };

  const initializeReferral = async () => {
    const generateRes = await fetch("/api/referral/generate", {
      method: "POST",
      credentials: "include",
    });
    const generateData = await generateRes.json();

    if (!generateRes.ok || !generateData.success) {
      throw new Error(
        generateData.error ||
          t("profile.referral.generateFailed", "Could not generate referral code"),
      );
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
        // Named here, awaited with the rest of the batch below. The referral
        // check must read the stats THIS load fetched — not the `stats` state,
        // which the effect closure resolved at mount (still null), so the check
        // was always truthy and fired the two referral requests on every load.
        const statsPromise = loadStats();

        await Promise.all([
          loadProfileData(),
          statsPromise,
          loadTitles(),
          loadSpecialTitles(),
          loadVipTitles(),
          loadStreakTitles(),
          loadMembership(),
          loadGlow(),
          loadOwnedCosmetics(),
          loadFriends(),
          loadFriendPresence(),
          loadFriendInvites(),
        ]);

        // Only a player with no code yet needs one — the first profile load
        // after sign-up. initializeReferral() persists it server-side and
        // merges it into `stats` locally, and /api/referral/generate clears the
        // (3-minute) user-stats cache entry, so the next load sees the code.
        // The old code refetched stats here instead: /api/user-stats was then
        // served from that same cache — still without the code — and its
        // setStats overwrote the code that had just been set, so the profile
        // kept asking for one.
        if (!(await statsPromise)?.referralCode) {
          await initializeReferral();
        }
      } catch (err) {
        console.error("[PROFILE_BOOTSTRAP_ERROR]", err);
        setError(
          err.message || t("profile.errors.loadFailed", "Could not load your profile."),
        );
      }
    };

    bootstrap();
  }, [isSignedIn, user]);

  // Keep the owned-cosmetics list (and equipped map) in sync whenever a picker
  // equips/unequips, or the user buys in another tab — dispatched as
  // "profileUpdated". Makes newly bought items appear in the edit popup
  // without a full page reload.
  useEffect(() => {
    if (!isSignedIn) return;
    const refreshCosmetics = () => {
      loadOwnedCosmetics();
      loadProfileData();
    };
    window.addEventListener("profileUpdated", refreshCosmetics);
    return () => window.removeEventListener("profileUpdated", refreshCosmetics);
  }, [isSignedIn]);

  const loadStreakTitles = async () => {
    try {
      const { response, data } = await fetchDeduped("/api/titles", {
        credentials: "include",
      });
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
      setChatColorMsg(
        t("profile.membership.invalidHex", "Enter a valid hex color like #00e5ff."),
      );
      return;
    }
    // Purely cosmetic: mark it saved immediately and roll the membership
    // back if the write is rejected.
    const previous = membership;
    const result = await runOptimistically({
      optimistic: () => setMembership((m) => (m ? { ...m, chatColor } : m)),
      rollback: () => setMembership(previous),
      request: async () => {
        const response = await fetch("/api/user/chat-color", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ color: chatColor }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(
            data.error || t("profile.membership.saveFailed", "Could not save color."),
          );
        }
        return data;
      },
    });
    setChatColorMsg(
      result.ok
        ? t("profile.membership.saved", "Chat color saved!")
        : result.error,
    );
  };

  const handleSaveCosmetics = async () => {
    setCosmeticsMsg(null);
    if (!HEX_COLOR_REGEX.test(cosmetics.accent)) {
      setCosmeticsMsg(
        t(
          "profile.customization.invalidHex",
          "Enter a valid hex accent color like #00e5ff.",
        ),
      );
      return;
    }
    const previous = profileInfo;
    const result = await runOptimistically({
      optimistic: () =>
        setProfileInfo((current) => ({
          ...current,
          profileAccent: cosmetics.accent,
        })),
      rollback: () => setProfileInfo(previous),
      request: async () => {
        const response = await fetch("/api/user/profile-customization", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            profileAccent: cosmetics.accent,
          }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(
            data.error ||
              t("profile.customization.saveFailed", "Could not save customization."),
          );
        }
        await loadProfileData();
        return data;
      },
    });
    setCosmeticsMsg(
      result.ok
        ? t("profile.customization.saved", "Profile customization saved!")
        : result.error,
    );
  };

  const handleResetChatColor = async () => {
    setChatColorMsg(null);
    const previous = membership;
    const previousColor = chatColor;
    const result = await runOptimistically({
      optimistic: () => {
        setChatColor("#00e5ff");
        setMembership((m) => (m ? { ...m, chatColor: null } : m));
      },
      rollback: () => {
        setChatColor(previousColor);
        setMembership(previous);
      },
      request: async () => {
        const response = await fetch("/api/user/chat-color", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ color: null }),
        });
        if (!response.ok) throw new Error("Could not reset color.");
        return true;
      },
    });
    setChatColorMsg(
      result.ok
        ? t("profile.membership.resetDone", "Chat color reset to default.")
        : t("profile.membership.resetFailed", "Could not reset color."),
    );
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
      setReferralStatus(
        t(
          "profile.referral.missingCode",
          "No referral code found yet. Please wait a second and try again.",
        ),
      );
      return;
    }

    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(stats.referralCode);
      } else {
        fallbackCopy(stats.referralCode);
      }
      setReferralStatus(
        t("profile.referral.copied", { code: stats.referralCode }),
      );
    } catch (err) {
      console.error("[COPY_REFERRAL_CODE_ERROR]", err);
      try {
        fallbackCopy(stats.referralCode);
        setReferralStatus(
          t("profile.referral.copiedFallback", { code: stats.referralCode }),
        );
      } catch (fallbackError) {
        setReferralStatus(
          t(
            "profile.referral.copyFailed",
            "Could not copy code. Please copy manually.",
          ),
        );
      }
    }
  };

  const handleShareReferralCode = async () => {
    if (!stats?.referralCode) return;
    const message = t("profile.referral.shareMessage", {
      code: stats.referralCode,
    });

    try {
      if (navigator.share) {
        await navigator.share({
          title: t("profile.referral.shareTitle", "GRYND Referral"),
          text: message,
        });
        setReferralStatus(
          t("profile.referral.shared", "Referral code shared successfully!"),
        );
        return;
      }

      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(message);
      } else {
        fallbackCopy(message);
      }
      setReferralStatus(
        t(
          "profile.referral.shareUnavailable",
          "Share not available. Message copied to clipboard.",
        ),
      );
    } catch (err) {
      console.error("[SHARE_REFERRAL_CODE_ERROR]", err);
      setReferralStatus(t("profile.referral.shareCancelled", "Share cancelled"));
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
        throw new Error(
          data.error || t("profile.referral.redeemFailed", "Unable to redeem code"),
        );
      }

      setReferralStatus(
        t("profile.referral.redeemed", { amount: data.reward }),
      );
      setReferralCodeInput("");
      await Promise.all([loadStats(), loadProfileData()]);
    } catch (err) {
      console.error("[REDEEM_REFERRAL_ERROR]", err);
      setReferralStatus(
        err.message || t("profile.referral.redeemFailed", "Unable to redeem code"),
      );
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
        setEditStatus(t("profile.edit.noChanges", "No changes to save."));
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
        throw new Error(
          data.error || t("profile.edit.updateFailed", "Failed to update profile"),
        );
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
      setEditStatus(
        t("profile.edit.saved", "Profile updated successfully."),
      );
      window.dispatchEvent(new Event("profileUpdated")); // ADD THIS
    } catch (err) {
      console.error("[EDIT_PROFILE_ERROR]", err);
      setEditStatus(
        err.message || t("profile.edit.saveFailed", "Could not save changes."),
      );
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
        throw new Error(
          data.error ||
            t("profile.danger.requestFailed", "Delete account failed"),
        );
      }

      setDeleteStatus(
        t("profile.danger.done", "Account deleted. Signing out..."),
      );
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
      setDeleteError(
        err.message || t("profile.danger.failed", "Could not delete account"),
      );
    } finally {
      setIsDeleting(false);
    }
  };

  if (!isLoaded) {
    return (
      <div className="flex h-screen items-center justify-center bg-[color:var(--bg-page)]">
        <div className="text-2xl text-cyan-200/80">
          {t("profile.loading", "Loading…")}
        </div>
      </div>
    );
  }

  if (!isSignedIn) {
    // Signed-out visitors get the SAME page chrome and their own guest
    // practice record, resolved from the HMAC-signed guest cookie by
    // /api/guest/progress. This replaces the old sign-in dead end only; the
    // account profile below is untouched (Phase 2F).
    return (
      <div
        className="relative min-h-screen bg-[color:var(--bg-page)] text-[color:var(--text-primary)]"
      >
        <div className="mx-auto max-w-6xl px-4 pb-20 pt-24 sm:px-6">
          <NavigationBar currentPath="/profil" />
          <header className="mb-6">
            <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-cyan-200/80">
              {t("guestProgress.eyebrow", "Guest profile")}
            </p>
            <h1 className="mt-1 text-3xl font-black text-white sm:text-4xl">
              {t("guestProgress.title", "Your guest progress")}
            </h1>
            <p className="mt-2 max-w-2xl text-sm text-slate-300/80">
              {t(
                "guestProgress.subtitle",
                "Your free practice record. No account needed, and nothing here is ranked.",
              )}
            </p>
          </header>
          <GuestProgressPanel />
        </div>
        <Footer />
      </div>
    );
  }

  const equippedFrame = cosmeticFrameRing(equippedCosmetics?.profile_frame?.visual);
  // Equipped non-frame effects (cssClass is shipped in globals.css).
  const profileGlowClass = cosmeticEffectClass(equippedCosmetics?.profile_glow?.visual);
  const avatarEffectClass = cosmeticEffectClass(equippedCosmetics?.avatar_effect?.visual);
  const usernameEffectClass = cosmeticEffectClass(equippedCosmetics?.username_effect?.visual);

  return (
    <div
      className="relative min-h-screen bg-[color:var(--bg-page)] text-[color:var(--text-primary)]"
    >
      <div className="max-w-6xl mx-auto px-6 pt-24 pb-20">
        <NavigationBar currentPath="/profil" />
        <h1 className="mb-8 text-4xl font-black tracking-tight text-white sm:text-5xl">
          {t("profile.title", "Your Profile")}
        </h1>
        <div className="grid gap-8">
          <div
            className={`relative overflow-hidden bg-[color:var(--bg-surface)] border border-white/10 rounded-xl p-6 shadow-[var(--shadow-raise)] ${profileGlowClass || ""}`}
            style={
              profileInfo.profileAccent
                ? {
                    borderColor: profileInfo.profileAccent,
                    boxShadow: `0 0 24px ${profileInfo.profileAccent}33`,
                  }
                : undefined
            }
          >
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-xl text-cyan-200/80">
                {t("profile.info.title", "Personal info")}
              </h2>
              <div className="flex items-center gap-3">
                <Link
                  href="/settings"
                  className="inline-flex items-center gap-1.5 rounded-lg border border-white/15 bg-cyan-500/10 px-3 py-1 text-sm font-medium text-slate-300 hover:bg-cyan-500/25 hover:text-cyan-200/80"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
                  {t("profile.info.settings", "Settings")}
                </Link>
                <button
                  onClick={() => {
                    setEditStatus("");
                    setIsEditOpen(true);
                  }}
                className={
                  cyberButton +
                  " text-sm px-3 py-1 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[color:var(--focus-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[color:var(--bg-page)]"
                }
              >
                {t("profile.info.edit", "Edit Profile")}
              </button>
              </div>
            </div>
            <div className="mb-3 flex items-center gap-3">
              {/* Clicking your own avatar opens the official icon picker.
                  No upload / URL avatar path — only owned Grynd icons. */}
              <button
                type="button"
                onClick={() => setIsIconPickerOpen(true)}
                aria-label={t("profile.info.changeIcon", "Change your Grynd icon")}
                title={t("profile.info.changeIcon", "Change your Grynd icon")}
                style={equippedFrame.style}
                className={`group relative rounded-full ${equippedFrame.cssClass || ""} ${avatarEffectClass || ""} focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[color:var(--focus-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[color:var(--bg-page)]`}
              >
                <IconAvatar
                  iconKey={profileInfo.selectedIcon}
                  name={profileInfo.name || user.fullName}
                  size="h-14 w-14"
                  className="border border-[color:var(--state-gold)] transition group-hover:scale-105"
                />
                {/* Subtle "change" affordance so players know it's clickable */}
                <span className="absolute -bottom-1 -right-1 flex h-6 w-6 items-center justify-center rounded-full border border-white/20 bg-[color:var(--bg-page)] text-cyan-200/80 shadow-[var(--shadow-raise)] transition group-hover:scale-110">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
                </span>
              </button>
              <div>
                <div className="flex items-center gap-2">
                  <p
                    style={
                      selectedGlowColor
                        ? { color: selectedGlowColor, textShadow: `0 0 12px ${selectedGlowColor}66` }
                        : undefined
                    }
                  >
                    {t("profile.info.name", "Name")}:{" "}
                    <span className={usernameEffectClass || undefined}>
                      {profileInfo.name ||
                        user.fullName ||
                        t("profile.info.unknownUser", "Unknown user")}
                    </span>
                  </p>
                  {stats?.playerLevel && (
                    <PlayerLevelBadge
                      level={stats.playerLevel.level}
                      rankKey={stats.playerLevel.rankKey}
                      size="compact"
                      showLabel
                    />
                  )}
                  {membership?.active && (
                    <span className="rounded-full border border-emerald-400/60 bg-emerald-500/10 px-2 py-0.5 text-xs font-semibold text-emerald-300">
                      {membership.title ||
                        t("profile.info.membershipFallback", "GRYND PRO")}
                    </span>
                  )}
                  {equippedCosmetics?.badge && (
                    <span
                      className="rounded-full border px-2 py-0.5 text-xs font-semibold"
                      style={{
                        borderColor: `${equippedCosmetics.badge.visual?.color ?? "#f5c542"}99`,
                        backgroundColor: `${equippedCosmetics.badge.visual?.color ?? "#f5c542"}1a`,
                        color: equippedCosmetics.badge.visual?.color ?? "#f5c542",
                      }}
                    >
                      {equippedCosmetics.badge.name}
                    </span>
                  )}
                  {(specialTitles.selectedSpecialTitleName ||
                    titleMeta.selectedTitle) && (
                    <span className="rounded-full border border-[color:var(--state-gold)] bg-[color:var(--bg-panel)] px-2 py-0.5 text-xs text-[color:var(--state-gold)]">
                      {specialTitles.selectedSpecialTitleName ||
                        titleMeta.selectedTitle}
                    </span>
                  )}
                  {/* Overall Elo badge — the server-computed cross-game
                      aggregate, shown only once the player qualifies (an
                      established rating in enough different games). */}
                  {Number(stats?.overallElo) > 0 && (
                    <span
                      className="rounded-full border border-[color:var(--state-gold)] bg-[color:var(--bg-panel)] px-2 py-0.5 text-xs font-semibold text-[color:var(--state-gold)]"
                      title={`Overall Elo across ${Number(stats?.overallEligibleGames || 0)} games`}
                    >
                      Overall {Number(stats.overallElo).toLocaleString()} Elo
                    </span>
                  )}
                </div>
                <p>
                  {t("profile.info.email", "Email")}:{" "}
                  {profileInfo.email || user.emailAddresses?.[0]?.emailAddress}
                </p>
                {/* Streak info line */}
                <p className="text-xs text-amber-300 mt-1">
                  <svg
                    className="w-3.5 h-3.5 inline text-amber-400"
                    viewBox="0 0 24 24"
                    fill="currentColor"
                  >
                    <path d="M12 23c-1.4 0-2.5-1.1-2.5-2.5 0-.5.1-.9.4-1.3-1.9-1-4.1-2.3-4.1-4.7 0-2.2 1.5-4 3.5-5.5C10 8.4 10.5 7.5 12 2c1.5 5.5 2 6.4 2.7 7 2 1.5 3.5 3.3 3.5 5.5 0 2.4-2.2 3.7-4.1 4.7.3.4.4.8.4 1.3 0 1.4-1.1 2.5-2.5 2.5z" />
                  </svg>{" "}
                  {t("profile.info.dailyStreak", {
                    count: streakState.dailyStreakCurrent,
                    unit:
                      (streakState.dailyStreakCurrent || 0) === 1
                        ? t("profile.info.unitDay", "day")
                        : t("profile.info.unitDays", "days"),
                    best: streakState.dailyStreakBest,
                  })}
                </p>
                {/* Competitive identity strip — real leaderboard record data
                    (same source as /classement). Only rows with data render. */}
                {stats?.record && (
                  <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs font-semibold">
                    <span className="text-green-300">
                      {Number(stats.record.wins || 0)}
                      {t("profile.info.wins", "W")}
                    </span>
                    <span className="text-red-300/90">
                      {Number(stats.record.losses || 0)}
                      {t("profile.info.losses", "L")}
                    </span>
                    <span className="text-white/60">
                      {t("profile.info.winRate", {
                        percent: Number(stats.record.winRate || 0).toFixed(1),
                      })}
                    </span>
                    {Number(stats.record.currentStreak || 0) > 0 && (
                      <span className="inline-flex items-center gap-1 text-[color:var(--state-gold)]">
                        <svg className="h-3 w-3" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                          <path d="M12 23c-1.4 0-2.5-1.1-2.5-2.5 0-.5.1-.9.4-1.3-1.9-1-4.1-2.3-4.1-4.7 0-2.2 1.5-4 3.5-5.5C10 8.4 10.5 7.5 12 2c1.5 5.5 2 6.4 2.7 7 2 1.5 3.5 3.3 3.5 5.5 0 2.4-2.2 3.7-4.1 4.7.3.4.4.8.4 1.3 0 1.4-1.1 2.5-2.5 2.5z" />
                        </svg>
                        {t("profile.info.winStreak", {
                          count: Number(stats.record.currentStreak),
                        })}
                      </span>
                    )}
                  </div>
                )}
              </div>
            </div>
            <p>
              {t("profile.info.memberSince", {
                date: new Date(user.createdAt).toLocaleDateString(),
              })}
            </p>
          </div>

        </div>

        <SolitaireModesPanel />

        {/* Permanent trophy-derived level + rank. Every number is the server's
            `/api/user-stats` progression payload (peak-protected). */}
        {stats?.playerLevel && (
          <PlayerLevelProgressCard
            progression={stats.playerLevel}
            className="mt-8 mb-8"
          />
        )}

        <div
          className="mt-8 bg-[color:var(--bg-surface)] border border-white/10 
rounded-xl p-6 
shadow-[var(--shadow-raise)]"
        >
          <h2 className="text-xl text-cyan-200/80 mb-4">
            {t("profile.stats.title", "User Statistics")}
          </h2>
          {statsError && <p className="text-red-400 mb-4">{statsError}</p>}
          {/* Tabbed stat panel — mirrors the /classement leaderboard
              (record / weekly / streaks) instead of a flat grid. */}
          {/* Per-game Elo ratings come from /api/user-stats (read fresh on
              every request, outside its stats cache) and render as the
              "Game Ratings" tab. */}
          <UserStatsTabs
            record={stats?.record}
            ratings={stats?.ratings}
            overall={stats}
          />

          {/* Pointer to the GRYND PRO performance dashboard. It is a LINK, not
              an embedded dashboard: the advanced analytics are gated on the
              server (/api/stats/performance), so a free player sees the upsell
              there rather than a second empty panel here. */}
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-white/10 bg-white/[0.02] px-4 py-3">
            <div>
              <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-cyan-200/80">
                {t("profile.stats.advanced_badge", "GRYND PRO")}
              </p>
              <p className="mt-0.5 text-sm text-white/50">
                {t(
                  "profile.stats.advanced",
                  "Performance dashboard — win rates, Elo and trophy graphs, and your overall ranking over time.",
                )}
              </p>
            </div>
            <Link
              href="/stats"
              className="shrink-0 text-sm font-semibold text-cyan-300 underline-offset-4 transition hover:text-cyan-200 hover:underline"
            >
              {t("profile.stats.advanced_open", "Open dashboard")}
            </Link>
          </div>
        </div>

        {/* Guest→account conversion (Phase 4): renders only while this
            browser has an unclaimed guest practice record, or to confirm a
            claim already made. Nothing changes for accounts without one. */}
        <GuestClaimPanel />

        {/* Members can show the mark. Fetches the badge from the server and
            renders nothing at all for a free account or a guest. */}
        <ShareProBadgeButton />

        <ProfileChatColorPanel
          chatColor={chatColor}
          onChatColorChange={setChatColor}
          onSave={handleSaveChatColor}
          onReset={handleResetChatColor}
          message={chatColorMsg}
          isMember={Boolean(membership?.active)}
          previewName={
            profileInfo.name ||
            user.fullName ||
            t("profile.membership.yourName", "Your name")
          }
        />

        {/* Advertising — a SECONDARY area between profile sections, not the
            identity card. It is a card of its own: nothing under it is a
            control, a statistic or an account setting, and the footer slot is
            a long way below so the two providers never stack. */}
        {hilltopSlot}

        <ProfileAccentPanel
          accent={cosmetics.accent}
          onAccentChange={(accent) => setCosmetics((c) => ({ ...c, accent }))}
          onSave={handleSaveCosmetics}
          message={cosmeticsMsg}
        />

        <ProfileEmotesPanel onManage={setIsEmotesManagerOpen} />

        <div className="mt-8 rounded-xl border border-white/10 bg-[color:var(--bg-surface)] p-6 shadow-[var(--shadow-raise)]">
          <button
            type="button"
            onClick={() => setTitlesOpen((o) => !o)}
            className="flex w-full items-center justify-between text-left focus-visible:outline-hidden"
            aria-expanded={titlesOpen}
            aria-controls="titles-section-body"
          >
            <h2 className="text-xl text-slate-200">
              {t("profile.titles.title", "Titles")}
            </h2>
            <svg
              className={`w-5 h-5 text-slate-200 transition-transform duration-200 ${titlesOpen ? "rotate-180" : ""}`}
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
                  className={`rounded-sm px-3 py-1 text-sm transition focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-cyan-500/60 focus-visible:ring-offset-2 focus-visible:ring-offset-[color:var(--bg-page)] ${
                    titlesView === "special"
                      ? "bg-cyan-600/70 text-white"
                      : "bg-white/10 text-gray-300"
                  }`}
                >
                  {t("profile.titles.tabSpecial", "Special Titles")}
                </button>

                <button
                  onClick={() => setTitlesView("vip")}
                  className={`rounded-sm px-3 py-1 text-sm transition focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:ring-offset-2 focus-visible:ring-offset-[color:var(--bg-page)] ${
                    titlesView === "vip" ? "bg-cyan-500 text-white" : "bg-white/10 text-gray-300"
                  }`}
                >
                  {t("profile.titles.tabVip", "VIP Titles")}
                </button>
                <button
                  onClick={() => setTitlesView("streak")}
                  className={`rounded-sm px-3 py-1 text-sm transition focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-amber-400 focus-visible:ring-offset-2 focus-visible:ring-offset-[color:var(--bg-page)] ${
                    titlesView === "streak"
                      ? "bg-amber-500 text-black"
                      : "bg-white/10 text-gray-300"
                  }`}
                >
                  {t("profile.titles.tabStreak", "Streak Titles")}{" "}
                  <svg
                    className="w-4 h-4 inline text-amber-400"
                    viewBox="0 0 24 24"
                    fill="currentColor"
                  >
                    <path d="M12 23c-1.4 0-2.5-1.1-2.5-2.5 0-.5.1-.9.4-1.3-1.9-1-4.1-2.3-4.1-4.7 0-2.2 1.5-4 3.5-5.5C10 8.4 10.5 7.5 12 2c1.5 5.5 2 6.4 2.7 7 2 1.5 3.5 3.3 3.5 5.5 0 2.4-2.2 3.7-4.1 4.7.3.4.4.8.4 1.3 0 1.4-1.1 2.5-2.5 2.5z" />
                  </svg>
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
                            ? "border-white/15 bg-cyan-600/70/10 hover:bg-cyan-600/70/20"
                            : "cursor-not-allowed border-slate-700 bg-page/60 opacity-50",
                          isEquipped ? "ring-2 ring-yellow-300" : "",
                        ].join(" ")}
                      >
                        <p className="text-xs uppercase tracking-widest text-slate-300">
                          {title.rarity}
                        </p>

                        <p className="font-semibold text-white">
                          {isUnlocked
                            ? title.name
                            : t("profile.titles.hidden", "?????")}
                        </p>

                        <p className="text-xs text-slate-300">
                          {isUnlocked
                            ? title.description
                            : t(
                                "profile.titles.lockedSecret",
                                "Locked secret title",
                              )}
                        </p>

                        {isEquipped && (
                          <p className="mt-2 text-yellow-300 text-xs">
                            {t(
                              "profile.titles.clickToUnequip",
                              "Click again to unequip",
                            )}
                          </p>
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
                      {t("profile.titles.currentStreak", "Current Streak")}
                    </p>
                    <p className="text-2xl font-bold text-white">
                      <svg
                        className="w-6 h-6 inline text-amber-400"
                        viewBox="0 0 24 24"
                        fill="currentColor"
                      >
                        <path d="M12 23c-1.4 0-2.5-1.1-2.5-2.5 0-.5.1-.9.4-1.3-1.9-1-4.1-2.3-4.1-4.7 0-2.2 1.5-4 3.5-5.5C10 8.4 10.5 7.5 12 2c1.5 5.5 2 6.4 2.7 7 2 1.5 3.5 3.3 3.5 5.5 0 2.4-2.2 3.7-4.1 4.7.3.4.4.8.4 1.3 0 1.4-1.1 2.5-2.5 2.5z" />
                      </svg>{" "}
                      {streakState.dailyStreakCurrent}{" "}
                      {(streakState.dailyStreakCurrent || 0) === 1
                        ? t("profile.info.unitDay", "day")
                        : t("profile.info.unitDays", "days")}
                    </p>
                    <p className="text-sm text-amber-200 mt-1">
                      {t("profile.titles.bestStreak", {
                        count: streakState.dailyStreakBest,
                        unit:
                          (streakState.dailyStreakBest || 0) === 1
                            ? t("profile.info.unitDay", "day")
                            : t("profile.info.unitDays", "days"),
                      })}
                    </p>
                  </div>

                  <div className="rounded-lg border border-amber-300/30 bg-amber-500/5 p-4">
                    <p className="text-xs uppercase tracking-wider text-amber-300 mb-3">
                      {t("profile.titles.equipStreak", "Equip Streak Title")}
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
                        {streakState.streakTitleCurrent ||
                          t("profile.titles.noTitle", "No title")}
                        {streakState.selectedStreakType === "current"
                          ? t("profile.titles.equippedSuffix", " (equipped)")
                          : ""}
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
                        {streakState.streakTitleBest ||
                          t("profile.titles.noTitle", "No title")}
                        {streakState.selectedStreakType === "best"
                          ? t("profile.titles.equippedSuffix", " (equipped)")
                          : ""}
                      </button>
                    </div>
                    {streakState.selectedStreakType && (
                      <button
                        onClick={() => handleEquipStreakTitle("")}
                        className="text-xs text-amber-400 hover:text-amber-300 underline"
                      >
                        {t(
                          "profile.titles.unequipStreak",
                          "Unequip streak title",
                        )}
                      </button>
                    )}
                  </div>

                  <div>
                    <p className="text-xs uppercase tracking-wider text-amber-300 mb-2">
                      {t("profile.titles.milestones", "All Streak Milestones")}
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
                                : "border-slate-700 bg-page/60 opacity-50"
                            }`}
                          >
                            <span className="text-slate-400">
                              {t("profile.titles.daysCount", {
                                count: milestone.days,
                              })}
                            </span>
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
                            : "cursor-not-allowed border-slate-700 bg-page/60 opacity-50",
                          equipped ? "ring-2 ring-yellow-300" : "",
                        ].join(" ")}
                      >
                        <p className="text-xs uppercase tracking-widest text-slate-300">
                          {title.rarity}
                        </p>

                        <p className="font-semibold text-white">
                          {unlocked
                            ? title.title
                            : t("profile.titles.locked", "Locked")}
                        </p>

                        {equipped && (
                          <p className="mt-2 text-yellow-300 text-xs">
                            {t(
                              "profile.titles.clickToUnequip",
                              "Click again to unequip",
                            )}
                          </p>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}

            </div>
          )}
        </div>

        <div
          className="mt-8 bg-[color:var(--bg-surface)] border border-white/10 
rounded-xl p-6 
shadow-[var(--shadow-raise)]"
        >
          <h2 className="text-xl text-cyan-200/80 mb-4">
            {t("profile.referral.title", "Referral System")}
          </h2>

          <div className="grid gap-4 md:grid-cols-3 mb-4">
            <div className="rounded-lg border border-[color:var(--state-gold)] p-4">
              <p className="text-sm text-gray-300">
                {t("profile.referral.code", "Your Referral Code")}
              </p>
              <p className="text-2xl font-bold text-cyan-200/80">
                {stats?.referralCode
                  ? stats.referralCode
                  : t("profile.referral.noCode", "No code yet")}
              </p>
            </div>
            <div className="rounded-lg border border-[color:var(--state-gold)] p-4">
              <p className="text-sm text-gray-300">
                {t("profile.referral.total", "Total Referrals")}
              </p>
              <p className="text-2xl font-bold">{stats?.referrals ?? 0}</p>
            </div>
            <div className="rounded-lg border border-[color:var(--state-gold)] p-4">
              <p className="text-sm text-gray-300">
                {t("profile.referral.earnings", "Referral Earnings")}
              </p>
              <p className="text-2xl font-bold">
                {stats?.referralEarnings ?? 0} {t("profile.tokens", "tokens")}
              </p>
            </div>
          </div>

          <input
            readOnly
            value={stats?.referralCode || ""}
            className="w-full mb-4 rounded-sm bg-[color:var(--bg-panel)] border border-white/10 
focus:ring-2 focus:ring-[color:var(--focus-ring)] px-4 py-2 text-cyan-200/80"
          />

          <div className="flex flex-wrap gap-3 mb-4">
            <button
              onClick={handleCopyReferralCode}
              className={
                cyberButton +
                " focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[color:var(--focus-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[color:var(--bg-page)]"
              }
            >
              {t("profile.referral.copy", "Copy Code")}
            </button>

            <button
              onClick={handleShareReferralCode}
              className="rounded-lg px-4 py-2 font-semibold text-white 
  border border-white/20 
  hover:bg-cyan-500/10 
  focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[color:var(--focus-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[color:var(--bg-page)]"
            >
              {t("profile.referral.share", "Share Code")}
            </button>
          </div>

          <div className="flex flex-col md:flex-row gap-3">
            <label htmlFor="profil-redeem-code" className="sr-only">
              {t("profile.referral.enterCode", "Enter referral code")}
            </label>
            <input
              id="profil-redeem-code"
              value={referralCodeInput}
              onChange={(e) => setReferralCodeInput(e.target.value)}
              placeholder={t("profile.referral.enterCode", "Enter referral code")}
              className="flex-1 rounded-sm bg-[color:var(--bg-panel)] border border-white/10 
focus:ring-2 focus:ring-[color:var(--focus-ring)] px-4 py-2 outline-hidden focus:ring-2 focus:ring-[color:var(--state-gold)]"
            />
            <button
              onClick={handleRedeemCode}
              className="rounded-sm bg-green-500 px-4 py-2 font-semibold hover:bg-green-600 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-green-400 focus-visible:ring-offset-2 focus-visible:ring-offset-[color:var(--bg-page)]"
            >
              {t("profile.referral.redeem", "Redeem")}
            </button>
          </div>

          {referralStatus && <p className="mt-3 text-sm text-gray-200">{referralStatus}</p>}
        </div>

        <div
          className="mt-8 bg-[color:var(--bg-surface)] border border-white/10 
rounded-xl p-6 
shadow-[var(--shadow-raise)]"
        >
          <h2 className="text-xl text-cyan-200/80 mb-4">
            {t("profile.friends.addTitle", "Add Friends")}
          </h2>
          <div className="flex gap-2 mb-4">
            <label htmlFor="profil-friend-search" className="sr-only">
              {t("profile.friends.searchLabel", "Search users by name")}
            </label>
            <input
              id="profil-friend-search"
              value={friendSearch}
              onChange={(e) => setFriendSearch(e.target.value)}
              placeholder={t(
                "profile.friends.searchPlaceholder",
                "Type letters to search users (like Ctrl+F)",
              )}
              className="flex-1 rounded-sm bg-[color:var(--bg-panel)] border border-white/10 
focus:ring-2 focus:ring-[color:var(--focus-ring)] px-4 py-2"
            />
            <button
              onClick={() => handleSearchFriends()}
              disabled={isSearchingFriends}
              className="rounded-sm bg-[color:var(--state-gold)] px-4 py-2 text-[color:var(--on-accent)] font-semibold disabled:opacity-50 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-amber-400 focus-visible:ring-offset-2 focus-visible:ring-offset-[color:var(--bg-page)]"
            >
              {isSearchingFriends
                ? t("profile.friends.searching", "Searching...")
                : t("profile.friends.search", "Search")}
            </button>
          </div>

          <div className="space-y-2">
            {friendSearchResults.map((person) => (
              <div
                key={person.id}
                className="flex items-center justify-between rounded-sm border border-[color:var(--state-gold)] p-3"
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
bg-linear-to-r from-cyan-700 to-cyan-800 
shadow-[0_0_10px_rgba(0,255,200,0.6)] 
hover:scale-105 transition-all focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[color:var(--focus-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[color:var(--bg-page)]"
                >
                  {t("profile.friends.add", "Add Friend")}
                </button>
              </div>
            ))}
            {friendSearch && friendSearchResults.length === 0 && !isSearchingFriends && (
              <p className="text-sm text-gray-300">
                {t("profile.friends.noResults", "No users found for this name.")}
              </p>
            )}
          </div>

          {friendsStatus && <p className="mt-3 text-sm text-gray-200">{friendsStatus}</p>}
        </div>

        <div
          className="mt-8 bg-[color:var(--bg-surface)] border border-white/10 rounded-xl p-6 
shadow-[var(--shadow-raise)]"
        >
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl text-cyan-200/80">
              {t("profile.friends.title", "My Friends")}
            </h2>

            <button
              onClick={async () => {
                await loadFriends();
                await loadFriendPresence();
                await loadFriendInvites();
              }}
              className="rounded-sm bg-[color:var(--state-gold)] px-3 py-1 text-sm font-semibold text-[color:var(--on-accent)] hover:bg-[color:var(--state-gold)] focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-amber-400 focus-visible:ring-offset-2 focus-visible:ring-offset-[color:var(--bg-page)]"
            >
              {t("profile.friends.refresh", "Refresh")}
            </button>
          </div>
          <div className="mb-4 flex gap-2">
            <button
              onClick={() => setActiveFriendsTab("friends")}
              className={`rounded-sm px-3 py-1 text-sm font-semibold focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[color:var(--focus-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[color:var(--bg-page)] ${activeFriendsTab === "friends" ? "bg-cyan-500/80 text-[color:var(--on-accent)]" : "bg-white/10 text-white"}`}
            >
              {t("profile.friends.tabFriends", "Friends")}
            </button>
            <button
              onClick={() => setActiveFriendsTab("invites")}
              className={`rounded-sm px-3 py-1 text-sm font-semibold focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[color:var(--focus-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[color:var(--bg-page)] ${activeFriendsTab === "invites" ? "bg-cyan-500/80 text-[color:var(--on-accent)]" : "bg-white/10 text-white"}`}
            >
              {t("profile.friends.tabInvites", "Invites")} (
              {receivedInvites.length})
            </button>
          </div>
          {activeFriendsTab === "friends" && (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {myFriends.length > 0 ? (
                myFriends.map((friend) => (
                  <a
                    key={`${friend.id}-${friend.name}`}
                    href={`/profil/${encodeURIComponent(friend.clerk_id)}`}
                    className="rounded-sm border border-[color:var(--state-gold)] bg-white/5 p-3 flex items-center gap-3 hover:bg-white/10 transition-colors cursor-pointer"
                  >
                    <IconAvatar
                      iconKey={friend.icon_key}
                      name={friend.name}
                      size="h-10 w-10"
                    />
                    <div className="flex-1">
                      <span className="flex flex-wrap items-center gap-x-1.5">
                        {friend.name}
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

                        const allowedSpectateGames = new Set(["chess", "four-in-a-row"]);
                        if (!allowedSpectateGames.has(gameKey)) return null;

                        return (
                          <button
                            onClick={() => {
                              if (!isAllowedSpectateUrl(spectateUrl)) {
                                setFriendsStatus(
                                  t(
                                    "profile.friends.spectateInvalidLink",
                                    "This spectate link is invalid.",
                                  ),
                                );
                                return;
                              }
                              setSpectateLoadError("");
                              setSpectateIsLoaded(false);
                              setSpectateOverlayUrl(spectateUrl);
                            }}
                            aria-label={t("profile.friends.spectateLabel", {
                              name: friend.name,
                            })}
                            className="rounded-sm bg-cyan-500/80 px-2 py-1 text-xs font-semibold text-[color:var(--on-accent)] animate-pulse focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[color:var(--focus-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[color:var(--bg-page)]"
                          >
                            {t("profile.friends.spectate", "Spectate")}
                          </button>
                        );
                      })()}

                      <button
                        onClick={(e) => {
                          e.preventDefault();
                          handleRemoveFriend(friend.id);
                        }}
                        aria-label={t("profile.friends.removeLabel", {
                          name: friend.name,
                        })}
                        className="rounded-lg px-2 py-1 text-xs font-semibold text-white 
bg-linear-to-r from-red-500 to-red-700 
shadow-[0_0_10px_rgba(255,0,0,0.6)] 
hover:scale-105 transition-all focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-red-400 focus-visible:ring-offset-2 focus-visible:ring-offset-[color:var(--bg-page)]"
                      >
                        {t("profile.friends.remove", "Remove")}
                      </button>
                    </div>
                  </a>
                ))
              ) : (
                <p className="text-sm text-gray-300">
                  {t("profile.friends.none", "No friends yet.")}
                </p>
              )}
            </div>
          )}
          {activeFriendsTab === "invites" && (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {receivedInvites.length > 0 ? (
                receivedInvites.map((invite) => (
                  <div
                    key={invite.id}
                    className="rounded-sm border border-[color:var(--state-gold)] bg-white/5 p-3 flex items-center gap-3"
                  >
                    <IconAvatar
                      iconKey={invite.sender_icon_key}
                      name={invite.sender_name}
                      size="h-10 w-10"
                    />
                    <div className="flex-1">
                      <p className="text-sm font-semibold">{invite.sender_name}</p>
                      <p className="text-xs text-gray-300">
                        {t("profile.friends.sentAt", {
                          date: new Date(invite.created_at).toLocaleString(),
                        })}
                      </p>
                    </div>
                    <div className="flex flex-col gap-1">
                      <button
                        onClick={() => handleRespondToInvite(invite.id, "accept")}
                        aria-label={t("profile.friends.acceptLabel", {
                          name: invite.sender_name,
                        })}
                        className="rounded-sm bg-green-500 px-2 py-1 text-xs font-semibold text-white focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-green-400 focus-visible:ring-offset-2 focus-visible:ring-offset-[color:var(--bg-page)]"
                      >
                        {t("profile.friends.accept", "Accept")}
                      </button>
                      <button
                        onClick={() => handleRespondToInvite(invite.id, "decline")}
                        aria-label={t("profile.friends.declineLabel", {
                          name: invite.sender_name,
                        })}
                        className="rounded-sm bg-red-500 px-2 py-1 text-xs font-semibold text-white focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-red-400 focus-visible:ring-offset-2 focus-visible:ring-offset-[color:var(--bg-page)]"
                      >
                        {t("profile.friends.decline", "Decline")}
                      </button>
                    </div>
                  </div>
                ))
              ) : (
                <p className="text-sm text-gray-300">
                  {t("profile.friends.noInvites", "No pending invites.")}
                </p>
              )}
            </div>
          )}
        </div>

        {/* Private rooms — the same panel the shared room page renders, driven
            by /api/rooms and refreshed by the verified per-user realtime signal
            with a poll as the backstop. Friend challenges live in the ranked
            lobby's search tab now. */}
        <RoomsPanel friends={myFriends} />

        {spectateOverlayUrl && (
          <div className="fixed inset-0 z-[100] bg-black/90 flex items-center justify-center p-4">
            <div className="relative h-[90vh] w-[95vw] rounded-xl border border-white/15 bg-black overflow-hidden">
              <button
                onClick={() => {
                  setSpectateOverlayUrl("");
                  setSpectateLoadError("");
                  setSpectateIsLoaded(false);
                }}
                className="absolute right-3 top-3 z-10 rounded-sm bg-red-600 px-3 py-1 text-sm font-semibold text-white focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-black"
              >
                {t("profile.friends.spectateClose", "Close Spectate")}
              </button>
              {!spectateIsLoaded && !spectateLoadError && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/80 text-sm text-gray-200">
                  {t(
                    "profile.friends.spectateLoading",
                    "Loading spectate view...",
                  )}
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
                    className="rounded-sm bg-cyan-500/80 px-3 py-1 text-xs font-semibold text-[color:var(--on-accent)] focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-black"
                  >
                    {t("profile.friends.spectateRetry", "Retry")}
                  </button>
                </div>
              )}
              {isAllowedSpectateUrl(spectateOverlayUrl) ? (
                <iframe
                  src={spectateOverlayUrl}
                  className="h-full w-full border-0"
                  title={t(
                    "profile.friends.spectateTitle",
                    "Friend spectate view",
                  )}
                  onLoad={() => setSpectateIsLoaded(true)}
                  onError={() =>
                    setSpectateLoadError(
                      t(
                        "profile.friends.spectateFailed",
                        "Unable to render spectate page. The game may have ended or embedding is blocked.",
                      ),
                    )
                  }
                />
              ) : (
                <div className="absolute inset-0 flex items-center justify-center bg-black/90 p-6 text-center text-red-300">
                  {t(
                    "profile.friends.spectateInvalid",
                    "Invalid spectate destination.",
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        <BetHistoryPanel bets={bets} />

        <div
          className="mt-12 bg-[color:var(--bg-surface)] border border-white/10 
rounded-xl p-6 
shadow-[var(--shadow-raise)]"
        >
        </div>

        <div className="mt-12">
          <ContactMessageHistory />
        </div>

        <div
          className="mt-8 border border-red-500 bg-red-950/40 border border-red-500/40 
shadow-[0_0_20px_rgba(255,0,0,0.15)] rounded-lg p-6"
        >
          <h2 className="text-xl text-red-400 mb-2">
            {t("profile.danger.title", "Danger Zone: Delete Account")}
          </h2>
          <p className="text-red-200 mb-4">
            {t(
              "profile.danger.warning",
              "Warning: This action is permanent. Your account and data will be removed forever.",
            )}
          </p>

          <label className="text-sm text-red-200" htmlFor="profil-delete-password">
            {t("profile.danger.confirmPassword", "Confirm password")}
          </label>
          <input
            id="profil-delete-password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-2 w-full rounded-sm border border-red-400/40 bg-red-900/20 px-4 py-2 outline-hidden focus:ring-2 focus:ring-red-500"
            placeholder={t(
              "profile.danger.passwordPlaceholder",
              "Enter your password",
            )}
          />

          <button
            onClick={handleDeleteAccount}
            disabled={!delayDone || !password || isDeleting}
            className="mt-4 rounded-sm bg-red-600 px-4 py-2 font-semibold hover:bg-red-700 disabled:opacity-50 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-red-400 focus-visible:ring-offset-2 focus-visible:ring-offset-[color:var(--bg-page)]"
          >
            {isDeleting
              ? t("profile.danger.deleting", "Deleting...")
              : delayDone
                ? t(
                    "profile.danger.confirm",
                    "Confirm permanent deletion",
                  )
                : t("profile.danger.confirmIn", { seconds: countdown })}
          </button>

          {deleteError && <p className="mt-3 text-sm text-red-300">{deleteError}</p>}
          {deleteStatus && <p className="mt-3 text-sm text-green-300">{deleteStatus}</p>}
        </div>
      </div>

      {isEditOpen && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
          <div
            className="max-w-md w-full rounded-xl border border-[color:var(--state-gold)] bg-[color:var(--bg-surface)] border border-white/10 
shadow-[0_0_30px_rgba(0,229,255,0.25)] p-6"
          >
            <h3 className="text-xl font-bold text-cyan-200/80 mb-4">
              {t("profile.edit.title", "Edit Profile")}
            </h3>
            <div className="space-y-3">
              <label htmlFor="profil-edit-name" className="sr-only">
                {t("profile.edit.name", "Name")}
              </label>
              <input
                id="profil-edit-name"
                value={editForm.name}
                onChange={(e) => setEditForm((prev) => ({ ...prev, name: e.target.value }))}
                placeholder={t("profile.edit.name", "Name")}
                className="w-full rounded-sm bg-[color:var(--bg-panel)] border border-white/10 
focus:ring-2 focus:ring-[color:var(--focus-ring)] px-4 py-2"
              />
              <label htmlFor="profil-edit-email" className="sr-only">
                {t("profile.edit.email", "Email")}
              </label>
              <input
                id="profil-edit-email"
                value={editForm.email}
                onChange={(e) => setEditForm((prev) => ({ ...prev, email: e.target.value }))}
                placeholder={t("profile.edit.email", "Email")}
                className="w-full rounded-sm bg-[color:var(--bg-panel)] border border-white/10 
focus:ring-2 focus:ring-[color:var(--focus-ring)] px-4 py-2"
              />
              <div className="rounded-sm bg-[color:var(--bg-panel)] border border-white/10 p-3">
                <p className="mb-2 block text-sm text-gray-200">
                  {t("profile.edit.icon", "My Grynd Icon")}
                </p>
                <button
                  type="button"
                  onClick={() => {
                    setIsEditOpen(false);
                    setIsIconPickerOpen(true);
                  }}
                  className="flex w-full items-center gap-3 rounded-lg border border-white/15 bg-cyan-500/10 px-3 py-2.5 transition hover:bg-cyan-500/20 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[color:var(--focus-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[color:var(--bg-page)]"
                >
                  <IconAvatar
                    iconKey={profileInfo.selectedIcon}
                    name={profileInfo.name || user.fullName}
                    size="h-10 w-10"
                    showFrame={false}
                  />
                  <span className="flex-1 text-left text-sm text-gray-200">
                    {t("profile.edit.chooseIcon", "Choose Your Icon")}
                  </span>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4 text-cyan-200/80"><path d="M9 18l6-6-6-6"/></svg>
                </button>
              </div>
              <div className="rounded-sm bg-[color:var(--bg-panel)] border border-white/10 p-3">
                <p className="mb-2 block text-sm text-gray-200">
                  {t("profile.edit.glow", "My Name Glow")}
                </p>
                <button
                  type="button"
                  onClick={() => {
                    setIsEditOpen(false);
                    setIsGlowPickerOpen(true);
                  }}
                  className="flex w-full items-center gap-3 rounded-lg border border-white/15 bg-cyan-500/10 px-3 py-2.5 transition hover:bg-cyan-500/20 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[color:var(--focus-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[color:var(--bg-page)]"
                >
                  <span
                    className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-white/15 bg-black/30 text-sm font-bold text-white/70"
                    style={
                      selectedGlowColor
                        ? {
                            color: selectedGlowColor,
                            borderColor: `${selectedGlowColor}66`,
                            textShadow: `0 0 10px ${selectedGlowColor}66`,
                          }
                        : undefined
                    }
                  >
                    Aa
                  </span>
                  <span className="flex-1 text-left text-sm text-gray-200">
                    {selectedGlowName ||
                      t("profile.edit.chooseGlow", "Choose Your Name Glow")}
                  </span>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4 text-cyan-200/80"><path d="M9 18l6-6-6-6"/></svg>
                </button>
              </div>
              <div className="rounded-sm bg-[color:var(--bg-panel)] border border-white/10 p-3">
                <p className="mb-2 block text-sm text-gray-200">
                  {t("profile.edit.frame", "My Profile Frame")}
                </p>
                <button
                  type="button"
                  onClick={() => {
                    setIsEditOpen(false);
                    setIsFramePickerOpen(true);
                  }}
                  className="flex w-full items-center gap-3 rounded-lg border border-white/15 bg-cyan-500/10 px-3 py-2.5 transition hover:bg-cyan-500/20 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[color:var(--focus-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[color:var(--bg-page)]"
                >
                  <span
                    aria-hidden="true"
                    className={`h-10 w-10 shrink-0 rounded-full border-2 border-white/10 ${
                      equippedFrame.cssClass || ""
                    }`}
                    style={equippedFrame.style}
                  />
                  <span className="flex-1 text-left text-sm text-gray-200">
                    {equippedCosmetics?.profile_frame?.name ||
                      t(
                        "profile.edit.chooseFrame",
                        "Choose Your Profile Frame",
                      )}
                  </span>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4 text-cyan-200/80"><path d="M9 18l6-6-6-6"/></svg>
                </button>
                {/* Every profile cosmetic lives behind this ONE picker: the
                    frame plus the badge / avatar / username / chat effects and
                    the profile + elite glows. The old per-category rows are
                    gone so nothing has to be equipped in several places. */}
                <p className="mt-2 text-xs text-gray-400">
                  {t(
                    "profile.edit.frameHint",
                    "Frames, badges, avatar / username / chat effects and profile glows are all equipped here.",
                  )}
                </p>
              </div>
              <label htmlFor="profil-edit-password" className="sr-only">
                {t("profile.edit.password", "New password (optional)")}
              </label>
              <input
                id="profil-edit-password"
                type="password"
                value={editForm.password}
                onChange={(e) => setEditForm((prev) => ({ ...prev, password: e.target.value }))}
                placeholder={t(
                  "profile.edit.password",
                  "New password (optional)",
                )}
                className="w-full rounded-sm bg-[color:var(--bg-panel)] border border-white/10 
focus:ring-2 focus:ring-[color:var(--focus-ring)] px-4 py-2"
              />
            </div>

            {editStatus && <p className="mt-3 text-sm text-gray-200">{editStatus}</p>}

            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => setIsEditOpen(false)}
                className="rounded-sm border border-white/30 px-4 py-2 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[color:var(--focus-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[color:var(--bg-page)]"
              >
                {t("profile.edit.close", "Close")}
              </button>
              <button
                disabled={isSavingEdit}
                onClick={handleSaveEditProfile}
                className={
                  cyberButton +
                  " focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[color:var(--focus-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[color:var(--bg-page)]"
                }
              >
                {isSavingEdit
                  ? t("profile.edit.saving", "Saving...")
                  : t("profile.edit.save", "Save changes")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* The four cosmetics pickers. State, ownership and the equip handlers
          stay on this page; the component only opens and reports. */}
      <ProfilePickerModals
        isIconPickerOpen={isIconPickerOpen}
        onCloseIconPicker={() => setIsIconPickerOpen(false)}
        currentIconKey={profileInfo.selectedIcon}
        onEquipIcon={(iconKey) =>
          setProfileInfo((prev) => ({ ...prev, selectedIcon: iconKey }))
        }
        isGlowPickerOpen={isGlowPickerOpen}
        onCloseGlowPicker={() => setIsGlowPickerOpen(false)}
        onEquipGlow={handleEquipGlow}
        isFramePickerOpen={isFramePickerOpen}
        onCloseFramePicker={() => setIsFramePickerOpen(false)}
        onEquipCosmetic={(category, item) => handleEquipCosmetic(category, item)}
        isEmotesManagerOpen={isEmotesManagerOpen}
        onCloseEmotesManager={() => setIsEmotesManagerOpen(false)}
      />
      {adSlot}
      <Footer />
    </div>
  );
}
