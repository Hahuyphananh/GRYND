"use client";
import { useParams, useRouter } from "next/navigation";
import { useUser } from "@clerk/nextjs";
import { useEffect, useState } from "react";

export default function MatchPage() {
  const { matchId } = useParams();
  const router = useRouter();
  const { isSignedIn, user } = useUser();

  const [userTokens, setUserTokens] = useState(null);
  const [selected, setSelected] = useState(null);
  const [betAmount, setBetAmount] = useState("");
  const [countdown, setCountdown] = useState(300);
  const [message, setMessage] = useState("");

  const teams = matchId.replace(/-/g, " ").split(" vs ");
  const [teamA, teamB] = teams;

  const odds = {
    [teamA]: "1.85",
    draw: "3.60",
    [teamB]: "3.20",
  };

  // Replace this with actual event lookup later
  const eventId = 1;

  useEffect(() => {
    if (!user) return;

    const fetchTokens = async () => {
      const res = await fetch("/api/getUserTokens", { method: "POST" });
      const data = await res.json();
      if (data.success) setUserTokens(data.data.balance);
    };

    fetchTokens();
  }, [user]);

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

    if (!selected) {
      setMessage("Veuillez sélectionner une équipe.");
      return;
    }
    if (!betAmount || isNaN(betAmount) || Number(betAmount) <= 0) {
      setMessage("Montant de pari invalide.");
      return;
    }

    try {
      const res = await fetch("/api/place-sports-bet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          eventId,
          betAmount: Number(betAmount),
          choice: selected,
          odds: parseFloat(odds[selected]),
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Une erreur est survenue");

      setUserTokens(data.newBalance);
      setMessage(`✅ Pari placé sur "${selected}" à ${odds[selected]}x`);
      setSelected(null);
      setBetAmount("");
    } catch (err) {
      console.error(err);
      setMessage(`❌ ${err.message}`);
    }
  };

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
            {teamA} vs {teamB}
          </h1>
          <p className="text-gray-300">Débute dans {formatTime(countdown)}</p>
        </div>

        <div className="flex justify-center gap-6 mt-8">
          {Object.entries(odds).map(([team, odd]) => (
            <button
              key={team}
              onClick={() => setSelected(team)}
              className={`px-6 py-3 rounded-lg text-lg font-semibold transition ${
                selected === team
                  ? "bg-yellow-500 text-[#003366]"
                  : "bg-gray-700 text-white hover:bg-gray-600"
              }`}
            >
              {team.toUpperCase()} ({odd})
            </button>
          ))}
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
          <div className="text-center text-yellow-400 mt-4 font-medium">{message}</div>
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
