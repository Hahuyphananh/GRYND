"use client";
import React from "react";



export default function Index() {
  return function MainComponent({ selectedBet, odds, onSubmit }) {
  const [amount, setAmount] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const potentialWinnings = amount ? (parseFloat(amount) * parseFloat(odds)).toFixed(2) : "0.00";

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    
    if (!amount || isNaN(amount) || parseFloat(amount) <= 0) {
      setError("Veuillez entrer un montant valide");
      return;
    }

    setLoading(true);
    try {
      await onSubmit({ amount: parseFloat(amount), potentialWinnings: parseFloat(potentialWinnings) });
    } catch (err) {
      setError("Erreur lors du placement du pari");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="rounded-lg border border-[#FFD700] bg-[#004080] p-6">
      <h2 className="mb-6 text-xl font-bold text-white">Placer un pari</h2>
      
      {selectedBet && (
        <div className="mb-6 rounded-lg bg-[#004080]/50 p-4">
          <div className="mb-2 text-sm text-[#FFD700]">Sélection</div>
          <div className="text-lg text-white">{selectedBet}</div>
          <div className="mt-2 text-xl font-bold text-[#FFD700]">Cote: {odds}</div>
        </div>
      )}

      <form onSubmit={handleSubmit}>
        <div className="mb-6">
          <label className="mb-2 block text-sm text-white">
            Montant du pari (€)
          </label>
          <input
            type="number"
            name="betAmount"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="w-full rounded-lg border border-[#FFD700] bg-[#004080]/50 px-4 py-2 text-white placeholder-gray-400 focus:border-[#FFD700] focus:outline-none"
            placeholder="0.00"
            step="0.01"
            min="0"
          />
        </div>

        <div className="mb-6 rounded-lg bg-[#004080]/50 p-4">
          <div className="text-sm text-white">Gains potentiels</div>
          <div className="text-2xl font-bold text-[#FFD700]">{potentialWinnings}€</div>
        </div>

        {error && (
          <div className="mb-4 rounded-lg bg-red-500/10 p-3 text-sm text-red-500">
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-lg bg-[#FFD700] px-6 py-3 text-center font-medium text-[#003366] transition-colors hover:bg-[#FFD700]/80 disabled:bg-[#FFD700]/50"
        >
          {loading ? (
            <i className="fas fa-spinner fa-spin"></i>
          ) : (
            "Placer le pari"
          )}
        </button>
      </form>
    </div>
  );
}

function StoryComponent() {
  const handleSubmit = async (betData) => {
    console.log("Bet placed:", betData);
    return new Promise(resolve => setTimeout(resolve, 1000));
  };

  return (
    <div className="space-y-8 bg-[#004080] p-8">
      <div>
        <h2 className="mb-4 text-lg font-bold text-white">Pari sur un match</h2>
        <MainComponent
          selectedBet="PSG"
          odds="1.95"
          onSubmit={handleSubmit}
        />
      </div>

      <div>
        <h2 className="mb-4 text-lg font-bold text-white">Sans sélection</h2>
        <MainComponent
          onSubmit={handleSubmit}
        />
      </div>

      <style jsx global>{`
        @keyframes glowBorder {
          0% {
            box-shadow: 0 0 5px rgba(255, 215, 0, 0.1);
          }
          50% {
            box-shadow: 0 0 20px rgba(255, 215, 0, 0.2);
          }
          100% {
            box-shadow: 0 0 5px rgba(255, 215, 0, 0.1);
          }
        }

        .border-[#FFD700] {
          animation: glowBorder 2s infinite;
        }
      `}</style>
    </div>
  );
};
}