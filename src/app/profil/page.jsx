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
  const [profileInfo, setProfileInfo] = useState({ name: "", email: "", profilePicture: "" });
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

  const [isEditOpen, setIsEditOpen] = useState(false);
  const [editForm, setEditForm] = useState({ name: "", email: "", password: "", profilePicture: "" });

  const [friendSearch, setFriendSearch] = useState("");
  const [friendSearchResults, setFriendSearchResults] = useState([]);
  const [myFriends, setMyFriends] = useState([]);
  const [friendsStatus, setFriendsStatus] = useState("");
  const [friendPresenceByFriend, setFriendPresenceByFriend] = useState({});
  const [isSearchingFriends, setIsSearchingFriends] = useState(false);
  const [isSavingEdit, setIsSavingEdit] = useState(false);
  const [editStatus, setEditStatus] = useState("");

  const [levelUpModal, setLevelUpModal] = useState(null);
  const previousLevelRef = useRef(null);

  const loadStats = async () => {
    const res = await fetch("/api/user-stats", { credentials: "include" });
    const data = await res.json();
    if (!res.ok || !data.success) {
      throw new Error(data.error || "Failed to load stats");
    }
    setStats(data.stats);
  };

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
      const profilePicture = tokensData.data.profilePicture || "";
      setProfileInfo({ name, email, profilePicture });
      setEditForm((prev) => ({ ...prev, name, email, profilePicture }));
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
      const response = await fetch("/api/friends/list", { credentials: "include" });
      const data = await response.json();
      if (!response.ok || !data.success) {
        setMyFriends([]);
        return;
      }

      const friendRows = Array.isArray(data.friends) ? data.friends : Array.isArray(data.data) ? data.data : [];
      setMyFriends(friendRows);
    } catch (err) {
      console.error("[LOAD_FRIENDS_ERROR]", err);
      setMyFriends([]);
    }
  };

  const loadFriendPresence = async () => {
    try {
      const response = await fetch("/api/friends/game-presence", { credentials: "include" });
      const data = await response.json();
      if (response.ok && data.success) {
        setFriendPresenceByFriend(data.byFriend || {});
      }
    } catch (err) {
      console.error("[LOAD_FRIEND_PRESENCE_ERROR]", err);
    }
  };

  const handleSearchFriends = async (searchValue = friendSearch) => {
    setFriendsStatus("");
    const normalized = String(searchValue || "").trim();

    console.log("🟦 FRONT INPUT:", searchValue);
  console.log("🟦 FRONT NORMALIZED:", normalized);

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

console.log("🔥 FRIEND SEARCH FULL RESPONSE:", data);
      if (!response.ok || !data.success) {
        setFriendSearchResults([]);
        return;
      }

      const users = Array.isArray(data.users) ? data.users : Array.isArray(data.data) ? data.data : [];
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

const getFriendStatus = (friendId) => {
  const presence = friendPresenceByFriend?.[friendId];

  // ❌ No presence at all → OFFLINE
  if (!presence) {
    return {
      state: "offline",
      label: "Offline",
      color: "text-gray-400",
    };
  }

  // 🎮 Playing a game → PLAYING
  if (presence.gameKey) {
    return {
      state: "playing",
      label: `Playing ${presence.gameKey}`,
      color: "text-yellow-400",
    };
  }

  // 🟢 Connected but not playing → ONLINE
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
      setFriendsStatus(data.message || "Friend added.");
      await loadFriends();
    } catch (err) {
      console.error("[INVITE_FRIEND_ERROR]", err);
      setFriendsStatus(err.message || "Could not send invite.");
    }
  };

  const profileAvatar = (person) => person?.profile_picture || person?.profilePicture || "";

  const spectateUrlForFriend = (friendId) => {
    const presence = friendPresenceByFriend?.[friendId];
    if (!presence?.gameId || !presence?.gameKey) return null;

    if (presence.gameKey === "chess") return `/casino/chess-game/${presence.gameId}?spectator=1&focus=white`;
    if (presence.gameKey === "connect-four") return `/casino/connect-four/game/${presence.gameId}?spectator=1&focus=host`;
    if (presence.gameKey === "uno") return null;
    if (presence.gameKey === "tanks") return null;
    return null;
  };

  const initializeReferral = async () => {
    const generateRes = await fetch("/api/referral/generate", { method: "POST", credentials: "include" });
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
    await Promise.all([loadProfileData(), loadStats(), loadFriends(), loadFriendPresence()]);

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

  useEffect(() => {
    if (!isSignedIn) return;

    const timeout = setTimeout(() => {
      handleSearchFriends(friendSearch);
    }, 220);

    return () => clearTimeout(timeout);
  }, [friendSearch, isSignedIn]);

  useEffect(() => {
    if (!isSignedIn) return;
    loadFriendPresence();
    const intervalId = setInterval(loadFriendPresence, 15000);
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
      setIsSavingEdit(true);
      const response = await fetch("/api/profile/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(editForm),
      });

      const data = await response.json();
      if (!response.ok || !data.success) {
        throw new Error(data.error || "Failed to update profile");
      }

      setProfileInfo({
        name: data.profile.name,
        email: data.profile.email,
        profilePicture: data.profile.profilePicture || "",
      });
      setEditForm((prev) => ({ ...prev, password: "" }));
      setEditStatus("Profile updated successfully.");
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
            className="rounded-lg bg-[#FFD700] px-6 py-3 text-[#003366] hover:bg-[#FFD700]/80"
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
        <div className="mb-6 flex justify-between items-center">
          <a
            href="/casino"
            className="flex items-center rounded-lg bg-[#FFD700] px-4 py-2 text-[#003366] hover:bg-[#FFD700]/80"
          >
            <i className="fas fa-arrow-left mr-2"></i>
            Retour au Casino
          </a>
        </div>

        <h1 className="text-4xl font-extrabold text-center mb-8 
  bg-gradient-to-r from-purple-400 to-pink-500 
  bg-clip-text text-transparent">
  👤 Profile
</h1>

        <div className="grid gap-8 md:grid-cols-2">
          <div className="bg-[#0b224f]/85 border border-[#00e5ff]/30 
rounded-xl p-6 
shadow-[0_0_24px_rgba(0,229,255,0.15)]">
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-xl text-[#00e5ff]">Infos Personnelles</h2>
              <button
                onClick={() => {
                  setEditStatus("");
                  setIsEditOpen(true);
                }}
                className="rounded bg-[#FFD700] px-3 py-1 text-sm font-semibold text-[#003366] hover:bg-[#FFD700]/80"
              >
                Edit Profile
              </button>
            </div>
            <div className="mb-3 flex items-center gap-3">
              {profileInfo.profilePicture ? (
                <img src={profileInfo.profilePicture} alt="Profile" className="h-14 w-14 rounded-full object-cover border border-[#FFD700]" />
              ) : (
                <div className="h-14 w-14 rounded-full bg-[#00e5ff] text-[#001933] 
shadow-[0_0_10px_rgba(0,229,255,0.4)] flex items-center justify-center text-lg font-bold">
                  {(profileInfo.name || user.fullName || "U").charAt(0).toUpperCase()}
                </div>
              )}
              <div>
                <p>Name : {profileInfo.name || user.fullName || "Unknown user"}</p>
                <p>Email : {profileInfo.email || user.emailAddresses?.[0]?.emailAddress}</p>
              </div>
            </div>
            <p>Membre depuis : {new Date(user.createdAt).toLocaleDateString()}</p>
          </div>

          <div className="bg-[#0b224f]/85 border border-[#00e5ff]/30 
rounded-xl p-6 
shadow-[0_0_24px_rgba(0,229,255,0.15)] text-center">
            <h2 className="text-xl text-[#00e5ff] mb-2">Solde de Tokens</h2>
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

        <div className="mt-8 bg-[#0b224f]/85 border border-[#00e5ff]/30 
rounded-xl p-6 
shadow-[0_0_24px_rgba(0,229,255,0.15)]">
          <div className="flex items-center justify-between gap-4 mb-4">
            <h2 className="text-xl text-[#00e5ff]">VIP Level</h2>
            <div className="rounded-full px-3 py-1 bg-[#00e5ff] text-[#001933] 
shadow-[0_0_10px_rgba(0,229,255,0.4)] font-bold">
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

        <div className="mt-8 bg-[#0b224f]/85 border border-[#00e5ff]/30 
rounded-xl p-6 
shadow-[0_0_24px_rgba(0,229,255,0.15)]">
          <h2 className="text-xl text-[#00e5ff] mb-4">Referral System</h2>

          <div className="grid gap-4 md:grid-cols-3 mb-4">
            <div className="rounded-lg border border-[#FFD700]/40 p-4">
              <p className="text-sm text-gray-300">Your Referral Code</p>
              <p className="text-2xl font-bold text-[#00e5ff]">{stats?.referralCode ? stats.referralCode : "No code yet"}</p>
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
              className="rounded bg-[#FFD700] px-4 py-2 text-[#003366] font-semibold hover:bg-[#ffd700]/80"
            >
              Copy Code
            </button>
            <button
              onClick={handleShareReferralCode}
              className="rounded border border-[#FFD700] px-4 py-2 text-[#00e5ff] hover:bg-[#FFD700]/10"
            >
              Share Code
            </button>
          </div>

          <div className="flex flex-col md:flex-row gap-3">
            <input
              value={referralCodeInput}
              onChange={(e) => setReferralCodeInput(e.target.value)}
              placeholder="Enter referral code"
              className="flex-1 rounded bg-[#08142f] border border-[#00e5ff]/30 
focus:ring-2 focus:ring-[#00e5ff] px-4 py-2 outline-none focus:ring-2 focus:ring-[#FFD700]"
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

        <div className="mt-8 bg-[#0b224f]/85 border border-[#00e5ff]/30 
rounded-xl p-6 
shadow-[0_0_24px_rgba(0,229,255,0.15)]">
          <h2 className="text-xl text-[#00e5ff] mb-4">Add Friends</h2>
          <div className="flex gap-2 mb-4">
            <input
              value={friendSearch}
              onChange={(e) => setFriendSearch(e.target.value)}
              placeholder="Type letters to search users (like Ctrl+F)"
              className="flex-1 rounded bg-[#08142f] border border-[#00e5ff]/30 
focus:ring-2 focus:ring-[#00e5ff] px-4 py-2"
            />
            <button
              onClick={handleSearchFriends}
              disabled={isSearchingFriends}
              className="rounded bg-[#FFD700] px-4 py-2 text-[#003366] font-semibold disabled:opacity-50"
            >
              {isSearchingFriends ? "Searching..." : "Refresh"}
            </button>
          </div>

          <div className="space-y-2">
            {friendSearchResults.map((person) => (
              <div key={person.id} className="flex items-center justify-between rounded border border-[#FFD700]/40 p-3">
                <div className="flex items-center gap-3">
                  {profileAvatar(person) ? (
                    <img src={profileAvatar(person)} alt={person.name} className="h-10 w-10 rounded-full object-cover" />
                  ) : (
                    <div className="h-10 w-10 rounded-full bg-[#00e5ff] text-[#001933] 
shadow-[0_0_10px_rgba(0,229,255,0.4)] flex items-center justify-center font-bold">
                      {person.name?.charAt(0)?.toUpperCase() || "U"}
                    </div>
                  )}
                  <span>{person.name}</span>
                </div>
                <button
                  onClick={() => handleInviteFriend(person.id)}
                  className="rounded bg-green-500 px-3 py-1 text-sm font-semibold hover:bg-green-600"
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

        <div className="mt-8 bg-[#0b224f]/85 border border-[#00e5ff]/30 rounded-xl p-6 
shadow-[0_0_24px_rgba(0,229,255,0.15)]">
  
  <div className="flex items-center justify-between mb-4">
    <h2 className="text-xl text-[#00e5ff]">My Friends</h2>

    <button
      onClick={async () => {
        await loadFriends();
        await loadFriendPresence(); // optional but keeps status updated
      }}
      className="rounded bg-[#FFD700] px-3 py-1 text-sm font-semibold text-[#003366] hover:bg-[#ffd700]/80"
    >
      Refresh
    </button>
  </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {myFriends.length > 0 ? myFriends.map((friend) => (
              <div key={`${friend.id}-${friend.name}`} className="rounded border border-[#FFD700]/30 bg-white/5 p-3 flex items-center gap-3">
                {profileAvatar(friend) ? (
                  <img src={profileAvatar(friend)} alt={friend.name} className="h-10 w-10 rounded-full object-cover" />
                ) : (
                  <div className="h-10 w-10 rounded-full bg-[#00e5ff] text-[#001933] 
shadow-[0_0_10px_rgba(0,229,255,0.4)] flex items-center justify-center font-bold">
                    {friend.name?.charAt(0)?.toUpperCase() || "U"}
                  </div>
                )}
                <div className="flex-1">
                  <span>{friend.name}</span>
                 {(() => {
  const status = getFriendStatus(friend.id);
  return (
    <p className={`text-xs flex items-center gap-2 ${status.color}`}>
  <span
    className={`h-2 w-2 rounded-full ${
      status.state === "online"
        ? "bg-green-400"
        : status.state === "playing"
        ? "bg-yellow-400"
        : "bg-gray-400"
    }`}
  />
  {status.label}
</p>
  );
})()}
                </div>
               <div className="flex flex-col gap-1 items-end">
  {(() => {
    const status = getFriendStatus(friend.id);
    const spectateUrl = spectateUrlForFriend(friend.id);

    if (status.state === "offline" || !spectateUrl) return null;

    return (
      <a
        href={spectateUrl}
        className="rounded bg-[#00e5ff] px-2 py-1 text-xs font-semibold text-[#003366] animate-pulse"
      >
        Watch Live
      </a>
    );
  })()}

  <button
    onClick={() => handleRemoveFriend(friend.id)}
    className="rounded bg-red-500 px-2 py-1 text-xs font-semibold hover:bg-red-600"
  >
    Remove
  </button>
</div>
              </div>
            )) : <p className="text-sm text-gray-300">No friends yet.</p>}
          </div>
        </div>


        <div className="mt-8 bg-[#0b224f]/85 border border-[#00e5ff]/30 
rounded-xl p-6 
shadow-[0_0_24px_rgba(0,229,255,0.15)]">
          <h2 className="text-xl text-[#00e5ff] mb-4">User Statistics</h2>
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

        <div className="mt-12 bg-[#0b224f]/85 border border-[#00e5ff]/30 
rounded-xl p-6 
shadow-[0_0_24px_rgba(0,229,255,0.15)]">
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

        <div className="mt-8 border border-red-500 bg-red-950/40 border border-red-500/40 
shadow-[0_0_20px_rgba(255,0,0,0.15)] rounded-lg p-6">
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
            {isDeleting ? "Deleting..." : delayDone ? "Confirm permanent deletion" : `Confirm in ${countdown}s`}
          </button>

          {deleteError && <p className="mt-3 text-sm text-red-300">{deleteError}</p>}
          {deleteStatus && <p className="mt-3 text-sm text-green-300">{deleteStatus}</p>}
        </div>
      </div>

      {isEditOpen && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
          <div className="max-w-md w-full rounded-xl border border-[#FFD700] bg-[#0b224f] border border-[#00e5ff]/30 
shadow-[0_0_30px_rgba(0,229,255,0.25)] p-6">
            <h3 className="text-xl font-bold text-[#00e5ff] mb-4">Edit Profile</h3>
            <div className="space-y-3">
              <input
                value={editForm.name}
                onChange={(e) => setEditForm((prev) => ({ ...prev, name: e.target.value }))}
                placeholder="Name"
                className="w-full rounded bg-[#08142f] border border-[#00e5ff]/30 
focus:ring-2 focus:ring-[#00e5ff] px-4 py-2"
              />
              <input
                value={editForm.email}
                onChange={(e) => setEditForm((prev) => ({ ...prev, email: e.target.value }))}
                placeholder="Email"
                className="w-full rounded bg-[#08142f] border border-[#00e5ff]/30 
focus:ring-2 focus:ring-[#00e5ff] px-4 py-2"
              />
              <input
                value={editForm.profilePicture}
                onChange={(e) => setEditForm((prev) => ({ ...prev, profilePicture: e.target.value }))}
                placeholder="Profile picture URL"
                className="w-full rounded bg-[#08142f] border border-[#00e5ff]/30 
focus:ring-2 focus:ring-[#00e5ff] px-4 py-2"
              />
              <input
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
                className="rounded border border-white/30 px-4 py-2"
              >
                Close
              </button>
              <button
                disabled={isSavingEdit}
                onClick={handleSaveEditProfile}
                className="rounded bg-[#FFD700] px-4 py-2 text-[#003366] font-semibold disabled:opacity-50"
              >
                {isSavingEdit ? "Saving..." : "Save changes"}
              </button>
            </div>
          </div>
        </div>
      )}

      {levelUpModal && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
          <div className="max-w-md w-full rounded-xl border border-[#FFD700] bg-[#0b224f] border border-[#00e5ff]/30 
shadow-[0_0_30px_rgba(0,229,255,0.25)] p-6 text-center">
            <p className="text-2xl font-bold text-[#00e5ff]">🎉 Level Up! You reached Level {levelUpModal.level}</p>
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
