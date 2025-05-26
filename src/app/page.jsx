"use client";
import React, { useState, useEffect } from "react";
import NavigationBar from "../components/navigation-bar";
import BetSlip from "../components/bet-slip";
import { useUser } from "@clerk/nextjs";
import Image from "next/image";
import Img1 from "../images/roulette.jpg";
import Img2 from "../images/blackjack.jpg";
import Img3 from "../images/poker.jpg";
import Img4 from "../images/plinko.jpg";
import SportCard from "../components/sport-card"; // assumed
import EventCard from "../components/event-card"; // assumed

function MainComponent() {
  const { data: user } = useUser();
  const [selectedBet, setSelectedBet] = useState(null);
  const [selectedOdds, setSelectedOdds] = useState(null);
  const [sports, setSports] = useState([]);
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

  useEffect(() => {
    const syncData = async () => {
      try {
        const response = await fetch("/api/sync-sports-data", { method: "POST" });
        if (!response.ok) throw new Error(`Error syncing data: ${response.status}`);
      } catch (error) {
        console.error("Failed to sync sports data:", error);
      }
    };
    syncData();
    const interval = setInterval(syncData, 300000);
    return () => clearInterval(interval);
  }, []);

  const fetchSports = async () => {
    try {
      setLoadingSports(true);
      const response = await fetch("/api/list-sports", {
        method: "POST",
        body: JSON.stringify({}),
      });
      if (!response.ok) throw new Error(`Error fetching sports: ${response.status}`);
      const data = await response.json();
      setSports(data.sports);
    } catch (error) {
      setErrorSports("Failed to load sports");
    } finally {
      setLoadingSports(false);
    }
  };

  const fetchEvents = async (sportId = null) => {
    try {
      setLoadingEvents(true);
      const response = await fetch("/api/get-events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sportId }),
      });
      if (!response.ok) throw new Error(`Error fetching events: ${response.status}`);
      const data = await response.json();
      setEvents(data);
    } catch (error) {
      setErrorEvents("Failed to load events");
    } finally {
      setLoadingEvents(false);
    }
  };

  useEffect(() => {
    fetchSports();
    fetchEvents();
  }, []);

  const fetchUserTokens = async () => {
    if (!user) return;
    setLoading(true);
    setError(null);

    try {
      let response = await fetch("/api/get-user-tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
      });

      let data = await response.json();

      if (!response.ok || !data.success || !data.data) {
        await fetch("/api/initialize-user-tokens", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
        });

        response = await fetch("/api/get-user-tokens", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
        });
        data = await response.json();
      }

      if (data.success) {
        setUserTokens(data.data.balance);
      } else {
        throw new Error("Failed to retrieve balance.");
      }
    } catch (error) {
      console.error("Error managing tokens:", error);
      setError("Impossible de gérer vos tokens");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (user) fetchUserTokens();
  }, [user]);

  useEffect(() => {
    const syncUser = async () => {
      try {
        await fetch("/api/sync-user", { method: "POST" });
      } catch (err) {
        console.error("Failed to sync user:", err);
      }
    };
    if (user) syncUser();
  }, [user]);

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
      const response = await fetch("/api/bets/place", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(betData),
      });
      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data.error || "Erreur lors du placement du pari");
      }

      setSelectedBet(null);
      setSelectedOdds(null);
      setUserTokens(data.data.newBalance);
      showNotification("Pari placé avec succès!", "success");
    } catch (error) {
      console.error("Error placing bet:", error);
      showNotification(error.message || "Erreur lors du placement du pari", "error");
    } finally {
      setBetInProgress(false);
    }
  };

  const handleSportClick = (sportId) => {
    fetchEvents(sportId);
  };

  const showNotification = (message, type = "info") => {
    setNotification({ message, type });
    setTimeout(() => setNotification(null), 5000);
  };

  return (
    <div className="min-h-screen bg-[#003366]">
      <NavigationBar currentPath="/" />
      {/* Existing hero section, casino, sports, matches & BetSlip UI */}
      {/* You already wrote this part very well. No major changes needed. */}
      {/* You can reuse everything from the JSX in your original return() block below this. */}
      {/* Just be sure to include <SportCard /> and <EventCard /> components in your imports. */}
    </div>
  );
}

export default MainComponent;
