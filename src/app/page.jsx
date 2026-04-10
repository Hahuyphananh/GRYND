"use client";
import React, { useState, useEffect } from "react";
import { useRouter } from "next/navigation"; // add this at the top
import NavigationBar from "../components/navigation-bar";
import { useUser, useAuth } from "@clerk/nextjs";
import Image from "next/image";
import Img1 from "../images/roulette.jpg";
import Img2 from "../images/blackjack.jpg";
import Img3 from "../images/poker.jpg";
import Img4 from "../images/plinko.jpg";
import HeroBg from "../images/casino-bg.png";
import SportCard from "../components/sport-card";
import EventCard from "../components/event-card";

const MAIN_SPORT_GROUPS = [
  "American Football",
  "Basketball",
  "Ice Hockey",
  "Soccer",
];

function MainComponent() {
    const router = useRouter();
  const { isLoaded, isSignedIn, getToken } = useAuth();
  const { user } = useUser();
const [openGroup, setOpenGroup] = useState(null);
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
  claimedDays: [], // array of ISO dates strings
  currentStreak: 0,
  lastClaimDate: null
});

const [claimedDay, setClaimedDay] = useState(null);

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
  } catch (err) {
    console.error(err);
    setErrorSports("Failed to load sports");
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
      maxDay: data.maxDay || 14
    });

    if (data.lastClaimedDate) {
      const lastClaimed = new Date(data.lastClaimedDate);
      const now = new Date();

      if (lastClaimed.toDateString() === now.toDateString()) {
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

useEffect(() => {
  fetchRewardStatus();
}, [user, isSignedIn]);


const claimDailyReward = async () => {
  if (!user || !isSignedIn) {
    showNotification("Vous devez être connecté pour réclamer la récompense", "error");
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
      showNotification(data.error || "Erreur lors de la réclamation", "error");
      return;
    }

   setUserTokens(prev => prev + data.reward);

setClaimedDay(data.claimedDay);

setRewardPopupVisible(true);


    // 4) Set 24h cooldown
    const nextTime = new Date();
    nextTime.setHours(nextTime.getHours() + 24);
    setNextRewardTime(nextTime);
    setDailyRewardCooldown(true);

  } catch (err) {
    console.error(err);
    showNotification(err.message || "Erreur lors de la réclamation", "error");
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
        .padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`
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
    setErrorEvents("Failed to load events");
    console.error(err);
  } finally {
    setLoadingEvents(false);
  }
};

useEffect(() => {
  handleLoadSports();
}, []);


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
      setErrorEvents("Failed to load events");
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
      setError("Impossible de gérer vos tokens");
      setUserTokens(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (user && jwt) fetchUserTokens();
  }, [user, jwt]);

  const handleBetSelect = (team, odds) => {
    setSelectedBet(team);
    setSelectedOdds(odds);
  };

  const handleBetSubmit = async (betData) => {
    if (!user) {
      window.location.href = "/account/signin?callbackUrl=/";
      return;
    }

    if (!userTokens || userTokens < betData.amount) {
      showNotification("Solde insuffisant pour placer ce pari", "error");
      return;
    }

    setBetInProgress(true);
    setError(null);

    try {
      const res = await fetch("/api/bets/place", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${jwt}`,
        },
        body: JSON.stringify(betData),
        credentials: "include",
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || "Erreur lors du placement du pari");
      }

      setSelectedBet(null);
      setSelectedOdds(null);
      setUserTokens(data.data.newBalance);
      showNotification("Pari placé avec succès!", "success");
    } catch (err) {
      console.error("Bet error:", err);
      showNotification(err.message || "Erreur lors du placement du pari", "error");
    } finally {
      setBetInProgress(false);
    }
  };

  const showNotification = (message, type = "info") => {
    setNotification({ message, type });
  };

  return (
   <div className="min-h-screen bg-gradient-to-b from-[#030817] via-[#081a3d] to-[#003b8e] cyberpunk-grid">
      <NavigationBar currentPath="/" />

     <section className="relative mt-8 px-4 min-h-[70vh] flex items-center overflow-hidden">
  
  {/* Background Image */}
  <Image
    src={HeroBg}
    alt="Casino background"
    fill
    priority
    quality={100}
    className="object-cover object-center z-0"
  />

  {/* Dark overlay for readability */}
  <div className="absolute inset-0 bg-[#010612]/70 z-10" />

        <div className="relative z-20 mx-auto max-w-7xl text-center">
      <h1
  className="mb-4 text-4xl md:text-6xl font-extrabold text-transparent bg-clip-text 
bg-gradient-to-r from-[#ff4fd8] via-[#00e5ff] to-[#ff4fd8]
drop-shadow-[0_0_50px_rgba(255,79,216,0.5)] tracking-widest uppercase 
animate-[shimmerGradient_8s_ease-in-out_infinite]"
  style={{ backgroundSize: "200% auto" }}
>
  Pariez sur vos Sports Préférés et Jouez au Casino
</h1>

          <p className="mb-8 text-xl text-[#d8fbff]">
            Des cotes compétitives, des paris en direct, des jeux de casino et
            des récompenses exclusives
          </p>
   <div className="flex flex-col space-y-4 sm:flex-row sm:justify-center sm:space-x-4 sm:space-y-0">
  <a
    href="/sign-up"
    className="inline-block rounded-lg border border-[#f5ff3b]/40 bg-gradient-to-r from-[#00e5ff] to-[#00ffa6] px-8 py-4 text-lg font-medium text-[#041125] transition-all shadow-[0_0_16px_#00ffa6] hover:shadow-[0_0_25px_rgba(0, 255, 166,0.65)] hover:scale-105"
  >
    Commencer à Parier
  </a>
  <a
    href="/casino"
    className="inline-block rounded-lg border border-[#ff4fd8]/40 bg-gradient-to-r from-[#a855f7] to-[#ff4fd8] px-8 py-4 text-lg font-medium text-[#041125] transition-all shadow-[0_0_16px_rgba(168,85,247,0.5)] hover:shadow-[0_0_25px_rgba(255,79,216,0.65)] hover:scale-105"
  >
    Découvrir le Casino
  </a>
</div>

        </div>
      </section>

      <div className="mx-auto max-w-7xl px-4 py-8">
        <section className="mb-16">
          <div className="flex items-center justify-between mb-8">
            <h2 className="text-2xl font-bold text-[#f5ff3b]">Casino en Ligne</h2>
          </div>

          <div className="grid grid-cols-1 gap-8 md:grid-cols-2 lg:grid-cols-4">
            <a
              href="/casino/roulette"
              className="group relative cursor-pointer overflow-hidden rounded-lg border border-[#00e5ff]/35 bg-[#040d24] p-4 transition-all hover:shadow-[0_0_20px_rgba(0,229,255,0.35)]"
            >
              <div className="mb-4 h-48 overflow-hidden rounded-lg">
                <Image
                  src={Img1}
                  alt="Table de roulette avec jetons"
                  className="h-full w-full object-cover transition-transform group-hover:scale-110"
                />
              </div>
              <h3 className="mb-2 text-xl font-bold text-[#f5ff3b]">Roulette</h3>
              <p className="text-[#9dd8ff]">
                Placez vos paris sur les numéros, couleurs ou sections
              </p>
            </a>

            <a
              href="/casino/blackjack"
              className="group relative cursor-pointer overflow-hidden rounded-lg border border-[#00e5ff]/35 bg-[#040d24] p-4 transition-all hover:shadow-[0_0_20px_rgba(0,229,255,0.35)]"
            >
              <div className="mb-4 h-48 overflow-hidden rounded-lg">
                <Image
                  src={Img2}
                  alt="Table de blackjack avec cartes"
                  className="h-full w-full object-cover transition-transform group-hover:scale-110"
                />
              </div>
              <h3 className="mb-2 text-xl font-bold text-[#f5ff3b]">Blackjack</h3>
              <p className="text-[#9dd8ff]">
                Affrontez le croupier dans ce jeu de cartes classique
              </p>
            </a>

            <a
              href="/casino/poker"
              className="group relative cursor-pointer overflow-hidden rounded-lg border border-[#00e5ff]/35 bg-[#040d24] p-4 transition-all hover:shadow-[0_0_20px_rgba(0,229,255,0.35)]"
            >
              <div className="mb-4 h-48 overflow-hidden rounded-lg">
                <Image
                  src={Img3}
                  alt="Table de poker avec cartes et jetons"
                  className="h-full w-full object-cover transition-transform group-hover:scale-110"
                />
              </div>
              <h3 className="mb-2 text-xl font-bold text-[#f5ff3b]">Poker</h3>
              <p className="text-[#9dd8ff]">
                Affrontez l'IA ou d'autres joueurs dans des parties intenses de poker
              </p>
            </a>

            <a
              href="/casino/plinko"
              className="group relative cursor-pointer overflow-hidden rounded-lg border border-[#00e5ff]/35 bg-[#040d24] p-4 transition-all hover:shadow-[0_0_20px_rgba(0,229,255,0.35)]"
            >
              <div className="mb-4 h-48 overflow-hidden rounded-lg">
                <Image
                  src={Img4}
                  alt="Jeu Plinko avec des jetons qui tombent"
                  className="h-full w-full object-cover transition-transform group-hover:scale-110"
                />
              </div>
              <h3 className="mb-2 text-xl font-bold text-[#f5ff3b]">Plinko</h3>
              <p className="text-[#9dd8ff]">
                Regardez tomber les balles et multipliez vos gains!
              </p>
            </a>
          </div>

          {/* Bouton More centré sous la grille */}
          <div className="flex justify-center mt-8">
  <a
    href="/casino"
    className="inline-block rounded-lg border border-[#f5ff3b]/40 bg-[#f5ff3b] px-6 py-3 text-lg font-semibold text-[#031026] transition-all glow-pulse more-hover cyber-glow-button"
  >
    Plus de jeux
  </a>
</div>

        </section>

        <section className="mb-16">
  <div className="mb-8 flex justify-between items-center">
    <h2 className="text-2xl font-bold text-[#00e5ff]">
      Sports Populaires
    </h2>
  </div>

  {loadingSports ? (
    <div className="text-center text-[#00e5ff]">Chargement...</div>
  ) : (
    <div className="space-y-4">
     {Object.keys(sports).map((groupKey) => (
    <div
      key={groupKey}
      className="rounded-lg overflow-hidden border border-[#00e5ff]/30"
    >
      <button
        onClick={() =>
          setOpenGroup(openGroup === groupKey ? null : groupKey)
        }
        className="w-full flex justify-between items-center px-4 py-3
                   bg-[#06142f] text-[#00e5ff] font-bold hover:bg-[#0b224f]"
      >
        <span>{groupKey}</span>
        <span>{openGroup === groupKey ? "▲" : "▼"}</span>
      </button>

      {openGroup === groupKey && (
        <div className="grid grid-cols-2 gap-4 bg-[#050f24] p-4 md:grid-cols-3 lg:grid-cols-5">
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
  {/* Bouton Plus de Sports centré sous la grille */}
<div className="flex justify-center mt-8">
  <a
    href="/sport"
    className="inline-block rounded-lg border border-[#00e5ff]/40 bg-[#00e5ff] px-6 py-3 text-lg font-semibold text-[#041125] transition-all glow-pulse more-hover cyber-glow-button"
  >
    Plus de Sports
  </a>
</div>

</section>
      </div>

      {notification && (
        <div
          className={`fixed bottom-4 right-4 p-4 rounded-lg text-white ${
            notification.type === "success" ? "bg-green-600" : "bg-red-600"
          }`}
        >
          {notification.message}
        </div>
      )}
{isSignedIn && (
  <button
    onClick={claimDailyReward}
    disabled={dailyRewardCooldown}
    className={`fixed right-4 bottom-16 z-50 rounded-lg px-4 py-3 text-lg font-semibold text-white transition-all shadow-lg
      ${dailyRewardCooldown ? "bg-gray-400 cursor-not-allowed" : "bg-[#FFD700] hover:scale-110 animate-pulse"}`}
    title={
      dailyRewardCooldown
        ? `Récompense déjà réclamée. Disponible dans ${cooldownTimeLeft}`
        : "Réclamer Récompense Quotidienne"
    }
  >
    {dailyRewardCooldown
      ? `Cooldown: ${cooldownTimeLeft}`
      : "Réclamer Récompense"}
  </button>
)}
{rewardPopupVisible && (
  <div className="fixed inset-0 flex items-center justify-center bg-black/80 z-50">
    
    <div className="bg-gradient-to-b from-[#003366] to-[#001a33] 
                border-2 border-[#FFD700]
                p-6 rounded-2xl text-white 
                max-w-4xl w-[95%] text-center shadow-2xl
                max-h-[90vh] overflow-y-auto">

      <h2 className="text-3xl font-extrabold text-[#FFD700] mb-2">
        🎉 Récompense Quotidienne !
      </h2>

      <p className="mb-6 text-lg">
  Jour <span className="text-[#FFD700] font-bold">
    {claimedDay}
  </span> réclamé !
</p>


      {/* 14 DAY GRID */}
      <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-7 gap-3 mb-6">

        {Array.from({ length: streakData.maxDay || 14 }).map((_, i) => {

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
      <span className="text-3xl">✅</span>
    </div>
  )}

  <div className="text-sm">Jour {day}</div>

  <div className="text-2xl">
    {"💰".repeat(Math.min(day, 5))}
  </div>

  <div className="text-xs text-[#FFD700]">
    {reward.toLocaleString()}
  </div>

</div>
          );
        })}
      </div>


      {/* Streak message */}
      <div className="mb-4 text-lg">
        🔥 Streak actuel : 
        <span className="text-[#FFD700] font-bold">
          {" "}
          {streakData.currentDay} jours
        </span>
      </div>


      <button
  onClick={async () => {
    setRewardPopupVisible(false);
    await fetchRewardStatus(); // refresh AFTER closing
  }}
        className="mt-2 px-6 py-3 
                   bg-[#FFD700] text-[#003366] 
                   font-bold rounded-lg
                   hover:scale-105 transition-all"
      >
        Continuer
      </button>

    </div>
  </div>
)}


    </div>
    
  );
}

export default MainComponent;
