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

const handleLoadSports = async () => {
  try {
    setLoadingSports(true);

    const res = await fetch("/api/sports/list");
    const data = await res.json();

    const grouped = {};

    data.sports.forEach((sport) => {
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

useEffect(() => {
  const fetchRewardStatus = async () => {
    if (!user || !isSignedIn) return;

    try {
      const res = await fetch("/api/get-login-reward-status", {
        method: "GET",
        credentials: "include",
      });
      const data = await res.json();
      if (!data.success) return;

      if (data.lastClaimedDate) {
        const lastClaimed = new Date(data.lastClaimedDate);
        const now = new Date();

        // If last claim was today, disable button
        if (lastClaimed.toDateString() === now.toDateString()) {
          setDailyRewardCooldown(true);
          const nextTime = new Date();
          nextTime.setDate(now.getDate() + 1);
          setNextRewardTime(nextTime);
        }
      }
    } catch (err) {
      console.error("Failed to fetch reward status:", err);
    }
  };

  fetchRewardStatus();
}, [user, isSignedIn]);


const claimDailyReward = async () => {
  if (!user || !isSignedIn) {
    showNotification("Vous devez être connecté pour réclamer la récompense", "error");
    return;
  }

  try {
    const res = await fetch("/api/claim-login-reward", {
      method: "GET",
      credentials: "include",
    });
    const data = await res.json();

    if (!res.ok || !data.success) {
      showNotification(data.error || "Erreur lors de la réclamation", "error");
      return;
    }

    // 1️⃣ Update user's tokens
    setUserTokens(prev => prev + data.reward);

    // 2️⃣ Update streak state for popup
    setStreakData({
      currentDay: data.nextDay - 1, // last claimed day
      claimedDays: Array.from({ length: data.nextDay - 1 }, (_, i) => i + 1),
      lastClaimDate: data.lastClaimedDate,
      maxDay: data.maxDay
    });

    // 3️⃣ Show popup
    setRewardPopupVisible(true);

    // 4️⃣ Set 24h cooldown
    const nextTime = new Date();
    nextTime.setHours(nextTime.getHours() + 24);
    setNextRewardTime(nextTime);
    setDailyRewardCooldown(true);
    localStorage.setItem("nextRewardTime", nextTime.toISOString());

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
      localStorage.removeItem("nextRewardTime");
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
console.log("API RESPONSE:", data);

  if (!leagueKey) return;

  try {
    setLoadingEvents(true);
    const res = await fetch(`/api/sports/${leagueKey}`);
    const data = await res.json();

    if (data.success) {
      setEvents(data.events);
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
   <div className="animated-bg">
      <NavigationBar currentPath="/" />

      <section className="bg [#003366] px-4 py-20 mt-8">
        <div className="mx-auto max-w-7xl text-center">
      <h1
  className="mb-4 text-4xl md:text-6xl font-extrabold text-transparent bg-clip-text 
  bg-gradient-to-r from-yellow-300 via-yellow-400 to-yellow-300
  drop-shadow-[0_0_8px_rgba(255,215,0,0.6)] tracking-widest uppercase 
  animate-[shimmerGradient_8s_ease-in-out_infinite]"
  style={{ backgroundSize: "200% auto" }}
>
  Pariez sur vos Sports Préférés et Jouez au Casino
</h1>

          <p className="mb-8 text-xl text-white">
            Des cotes compétitives, des paris en direct, des jeux de casino et
            des récompenses exclusives
          </p>
   <div className="flex flex-col space-y-4 sm:flex-row sm:justify-center sm:space-x-4 sm:space-y-0">
  <a
    href="/sign-up"
    className="inline-block rounded-lg bg-[#FFD700] px-8 py-4 text-lg font-medium text-[#003366] transition-all glow-pulse commencer-hover"
  >
    Commencer à Parier
  </a>
  <a
    href="/casino"
    className="inline-block rounded-lg border-2 border-[#FFD700] px-8 py-4 text-lg font-medium text-[#FFD700] transition-all glow-pulse decouvrir-hover"
  >
    Découvrir le Casino
  </a>
</div>

        </div>
      </section>

      <div className="mx-auto max-w-7xl px-4 py-8">
        <section className="mb-16">
          <div className="flex items-center justify-between mb-8">
            <h2 className="text-2xl font-bold text-[#FFD700]">Casino en Ligne</h2>
          </div>

          <div className="grid grid-cols-1 gap-8 md:grid-cols-2 lg:grid-cols-4">
            <a
              href="/casino/roulette"
              className="group relative cursor-pointer overflow-hidden rounded-lg bg-black p-4 transition-all hover:shadow-lg hover:shadow-[#FFD700]/20"
            >
              <div className="mb-4 h-48 overflow-hidden rounded-lg">
                <Image
                  src={Img1}
                  alt="Table de roulette avec jetons"
                  className="h-full w-full object-cover transition-transform group-hover:scale-110"
                />
              </div>
              <h3 className="mb-2 text-xl font-bold text-[#FFD700]">Roulette</h3>
              <p className="text-gray-300">
                Placez vos paris sur les numéros, couleurs ou sections
              </p>
            </a>

            <a
              href="/casino/blackjack"
              className="group relative cursor-pointer overflow-hidden rounded-lg bg-black p-4 transition-all hover:shadow-lg hover:shadow-[#FFD700]/20"
            >
              <div className="mb-4 h-48 overflow-hidden rounded-lg">
                <Image
                  src={Img2}
                  alt="Table de blackjack avec cartes"
                  className="h-full w-full object-cover transition-transform group-hover:scale-110"
                />
              </div>
              <h3 className="mb-2 text-xl font-bold text-[#FFD700]">Blackjack</h3>
              <p className="text-gray-300">
                Affrontez le croupier dans ce jeu de cartes classique
              </p>
            </a>

            <a
              href="/casino/poker"
              className="group relative cursor-pointer overflow-hidden rounded-lg bg-black p-4 transition-all hover:shadow-lg hover:shadow-[#FFD700]/20"
            >
              <div className="mb-4 h-48 overflow-hidden rounded-lg">
                <Image
                  src={Img3}
                  alt="Table de poker avec cartes et jetons"
                  className="h-full w-full object-cover transition-transform group-hover:scale-110"
                />
              </div>
              <h3 className="mb-2 text-xl font-bold text-[#FFD700]">Poker</h3>
              <p className="text-gray-300">
                Affrontez l'IA ou d'autres joueurs dans des parties passionnantes
              </p>
            </a>

            <a
              href="/casino/plinko"
              className="group relative cursor-pointer overflow-hidden rounded-lg bg-black p-4 transition-all hover:shadow-lg hover:shadow-[#FFD700]/20"
            >
              <div className="mb-4 h-48 overflow-hidden rounded-lg">
                <Image
                  src={Img4}
                  alt="Jeu Plinko avec des jetons qui tombent"
                  className="h-full w-full object-cover transition-transform group-hover:scale-110"
                />
              </div>
              <h3 className="mb-2 text-xl font-bold text-[#FFD700]">Plinko</h3>
              <p className="text-gray-300">
                Regardez tomber votre jeton et multipliez vos gains
              </p>
            </a>
          </div>

          {/* Bouton More centré sous la grille */}
          <div className="flex justify-center mt-8">
  <a
    href="/casino"
    className="inline-block rounded-lg bg-[#FFD700] px-6 py-3 text-lg font-semibold text-[#003366] transition-all glow-pulse more-hover"
  >
    Plus de jeux
  </a>
</div>

        </section>

        <section className="mb-16">
  <div className="mb-8 flex justify-between items-center">
    <h2 className="text-2xl font-bold text-[#FFD700]">
      Sports Populaires
    </h2>
  </div>

  {loadingSports ? (
    <div className="text-center text-[#FFD700]">Chargement...</div>
  ) : (
    <div className="space-y-4">
     {Object.keys(sports).map((groupKey) => (
    <div
      key={groupKey}
      className="border border-[#FFD700]/30 rounded-lg overflow-hidden"
    >
      <button
        onClick={() =>
          setOpenGroup(openGroup === groupKey ? null : groupKey)
        }
        className="w-full flex justify-between items-center px-4 py-3
                   bg-[#002347] text-[#FFD700] font-bold hover:bg-[#003366]"
      >
        <span>{groupKey}</span>
        <span>{openGroup === groupKey ? "▲" : "▼"}</span>
      </button>

      {openGroup === groupKey && (
        <div className="p-4 bg-[#001a33] grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
          {sports[groupKey].map((league) => (
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
    className="inline-block rounded-lg bg-[#FFD700] px-6 py-3 text-lg font-semibold text-[#003366] transition-all glow-pulse more-hover"
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
      ${dailyRewardCooldown ? "bg-gray-400 cursor-not-allowed" : "bg-[#FFD700] hover:scale-105 glow-pulse"}`}
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
  <div className="fixed inset-0 flex items-center justify-center bg-black bg-opacity-70 z-50">
    <div className="bg-[#003366] p-8 rounded-lg text-white max-w-sm text-center">
      <h2 className="text-2xl font-bold mb-4">Récompense Réclamée !</h2>
      <p>Vous avez reçu <strong>{100 * 2 ** (streakData.currentDay - 1)} tokens</strong> !</p>
      <p>Streak actuel : <strong>{streakData.currentDay} jour(s)</strong></p>

      <div className="flex justify-center mt-4">
        {Array.from({ length: streakData.maxDay }).map((_, i) => (
          <div
            key={i}
            className={`w-5 h-5 m-1 rounded-full border-2 ${
              i < streakData.currentDay
                ? "bg-yellow-400 border-yellow-300"
                : "border-gray-500"
            }`}
          />
        ))}
      </div>

      <button
        onClick={() => setRewardPopupVisible(false)}
        className="mt-6 px-4 py-2 bg-[#FFD700] text-[#003366] font-bold rounded hover:scale-105 transition"
      >
        Fermer
      </button>
    </div>
  </div>
)}

    </div>
    
  );
}

export default MainComponent;
