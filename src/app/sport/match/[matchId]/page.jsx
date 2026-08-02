"use client";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useUser } from "@clerk/nextjs";
import { useEffect, useState } from "react";

export default function MatchPage() {
  const { matchId } = useParams();
  const searchParams = useSearchParams();
  const router = useRouter();
  const { isSignedIn, user } = useUser();

  const [event, setEvent] = useState(null);
  const [userTokens, setUserTokens] = useState(null);
  const [selected, setSelected] = useState(null);
  const [betAmount, setBetAmount] = useState("");
  const [countdown, setCountdown] = useState(300);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);

  // Fetch event + odds
  const fetchMatch = async () => {
    setLoading(true);
    try {
      const sportKey = searchParams.get("sport") || null;
      const res = await fetch("/api/sports/get-match", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug: matchId, sportKey }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Match introuvable.");

      setEvent(data.event);
    } catch (err) {
      console.error(err);
      setMessage(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchMatch();
  }, [matchId]);

  // Fetch user tokens
  useEffect(() => {
    if (!user) return;
    const fetchTokens = async () => {
      const res = await fetch("/api/get-user-tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
      });
      const data = await res.json();
      if (data.success) setUserTokens(data.data.balance);
    };
    fetchTokens();
  }, [user]);

  // Countdown timer
  useEffect(() => {
    const interval = setInterval(() => {
      setCountdown((prev) => (prev > 0 ? prev - 1 : 0));
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  const formatTime = (s) => {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m}:${sec.toString().padStart(2, "0")}`;
  };

  const handleBet = async () => {
    setMessage("");
    if (!selected) return setMessage("Sélectionnez une option.");
    if (!betAmount || isNaN(Number(betAmount)) || Number(betAmount) <= 0)
      return setMessage("Montant invalide.");

    try {
      const res = await fetch("/api/place-sports-bet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          eventId: event.id,
          betAmount: Number(betAmount),
          choice: `h2h:${selected}`,
          odds: parseFloat(event.odds_map[selected]),
          marketType: "h2h",
          lineValue: null,
          sportKey: event.sport_key || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Erreur");

      setUserTokens(data.newBalance);
      setMessage(
        `✅ Pari placé sur ${selected} à ${event.odds_map[selected]}x`,
      );
      setSelected(null);
      setBetAmount("");
    } catch (err) {
      setMessage(`❌ ${err.message}`);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-[#003366] text-white p-6 flex justify-center items-center">
        <p className="text-yellow-400 text-lg">{message || "Chargement..."}</p>
      </div>
    );
  }

  if (!event) {
    return (
      <div className="min-h-screen bg-[#003366] text-white p-6 flex justify-center items-center">
        <p className="text-yellow-400 text-lg">
          {message || "Match introuvable."}
        </p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#003366] text-white px-6 py-16">
      <div className="max-w-4xl mx-auto space-y-10">
        <button
          onClick={() => router.push("/sport")}
          className="text-[#FFD700] hover:underline"
        >
          ← Retour aux matchs
        </button>

        <div className="text-center">
          <h1 className="text-4xl font-bold text-[#FFD700] mb-2">
            {event.team_a} vs {event.team_b}
          </h1>
          <p className="text-gray-300">
            Débute dans {formatTime(countdown)} —{" "}
            {new Date(event.start_time).toLocaleString("fr-FR")}
          </p>

          {/* Live Score (manual refresh) */}
          <button
            onClick={fetchMatch}
            className="mt-3 rounded-lg border border-[#FFD700] px-3 py-1 text-sm text-[#FFD700] hover:bg-[#FFD700]/10"
          >
            Refresh match
          </button>
          <div className="mt-2">
            {event.live_score ? (
              <p className="text-lg text-white">
                🔴 Score: {event.team_a} {event.live_score.team_a_score} —{" "}
                {event.live_score.team_b_score} {event.team_b} (
                {event.live_score.status})
              </p>
            ) : (
              <p className="text-gray-400 text-sm">Score non disponible</p>
            )}
          </div>
        </div>

        <div className="flex justify-center gap-6 mt-8">
          {Object.entries(event.odds_map).map(([key, value]) =>
            value ? (
              <button
                key={key}
                onClick={() => setSelected(key)}
                className={`px-6 py-3 rounded-lg text-lg font-semibold transition ${
                  selected === key
                    ? "bg-yellow-500 text-[#003366]"
                    : "bg-gray-700 text-white hover:bg-gray-600"
                }`}
              >
                {key.toUpperCase()} ({value})
              </button>
            ) : null,
          )}
        </div>

        <div className="flex justify-center mt-6">
          <input
            type="number"
            value={betAmount}
            onChange={(e) => setBetAmount(e.target.value)}
            placeholder="Montant à parier"
            className="px-4 py-2 rounded-l-lg bg-gray-800 text-white border border-yellow-500 w-48"
          />
          <button
            onClick={handleBet}
            className="bg-green-500 hover:bg-green-600 px-6 py-2 rounded-r-lg font-bold text-white"
          >
            Placer le Pari
          </button>
        </div>

        {message && (
          <div className="text-center text-yellow-400 mt-4 font-medium">
            {message}
          </div>
        )}

        {isSignedIn && (
          <div className="text-center text-[#FFD700] mt-8">
            Solde actuel :{" "}
            <span className="font-bold">{userTokens ?? "..."}</span> tokens
          </div>
        )}
      </div>
    </div>
  );
}
