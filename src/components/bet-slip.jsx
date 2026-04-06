"use client";
import React, { useMemo, useState } from "react";

const marketTitle = {
  h2h: "Moneyline",
  spreads: "Point Spread",
  totals: "Over / Under",
  props: "Prop Bet",
};

export default function BetSlip({ selectedBet, marketType, onSubmit }) {
  const [amount, setAmount] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState("");

  const odds = selectedBet?.odds;
  const potentialWinnings = useMemo(() => {
    if (!amount || !odds) return "0.00";
    return (parseFloat(amount) * parseFloat(odds)).toFixed(2);
  }, [amount, odds]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    setSuccess("");

    if (!selectedBet) {
      setError("Select a market outcome first.");
      return;
    }

    if (!amount || isNaN(amount) || parseFloat(amount) <= 0) {
      setError("Enter a valid stake amount.");
      return;
    }

    setLoading(true);
    try {
      await onSubmit({
        amount: parseFloat(amount),
        selection: selectedBet,
        odds: parseFloat(odds),
        marketType: selectedBet.marketType || marketType,
        line: selectedBet.line,
      });

      setAmount("");
      setSuccess("Bet submitted successfully.");
    } catch (err) {
      setError(err.message || "Failed to place bet.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="rounded-lg border border-[#FFD700] bg-[#004080] p-4">
      <h2 className="mb-4 text-xl font-bold text-white">Fiche de Pari</h2>

      {!selectedBet && <p className="text-sm text-white/90">Choisissez un résultat parmi les cartes Événement pour construire votre fiche.</p>}

      {selectedBet && (
        <>
          <div className="mb-4 rounded-lg bg-[#003366] p-3 text-white">
            <p className="text-xs uppercase tracking-wide text-[#FFD700]">Événement</p>
            <p className="font-semibold">{selectedBet.eventLabel}</p>
            <p className="mt-2 text-xs uppercase tracking-wide text-[#FFD700]">Marché</p>
            <p>{marketTitle[selectedBet.marketType || marketType] || "Moneyline"}</p>
            <p className="mt-2 text-xs uppercase tracking-wide text-[#FFD700]">Sélection</p>
            <p>{selectedBet.label}</p>
            {selectedBet.line !== null && selectedBet.line !== undefined && (
              <p className="text-sm text-white/80">Line: {selectedBet.line}</p>
            )}
            <p className="mt-2 text-lg font-bold text-[#FFD700]">Cotes: {odds}</p>
          </div>

          <form onSubmit={handleSubmit}>
            <label className="mb-1 block text-sm text-white">Mise</label>
            <input
              type="number"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="mb-4 w-full rounded-lg border border-[#FFD700] bg-[#003366] px-3 py-2 text-white"
              min="0"
              step="0.01"
              placeholder="0.00"
            />

            <div className="mb-4 rounded-lg bg-[#003366] p-3">
              <p className="text-sm text-white">Gains Potentiels</p>
              <p className="text-2xl font-bold text-[#FFD700]">{potentialWinnings}</p>
            </div>

            {error && <p className="mb-3 text-sm text-red-300">{error}</p>}
            {success && <p className="mb-3 text-sm text-green-300">{success}</p>}

            <button
              type="submit"
              disabled={loading}
              className="w-full rounded-lg bg-[#FFD700] px-4 py-2 font-bold text-[#003366] hover:bg-[#FFD700]/90"
            >
              {loading ? "Submitting..." : "Place Bet"}
            </button>
          </form>
        </>
      )}
    </div>
  );
}
