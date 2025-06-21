"use client";
import React, { useState } from "react";

export default function BetSlip({ selectedBet, odds, onSubmit }) {
  const [amount, setAmount] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const potentialWinnings = amount
    ? (parseFloat(amount) * parseFloat(odds || 0)).toFixed(2)
    : "0.00";

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");

    if (!amount || isNaN(amount) || parseFloat(amount) <= 0) {
      setError("Veuillez entrer un montant valide");
      return;
    }

    setLoading(true);
    try {
      await onSubmit({
        amount: parseFloat(amount),
        potentialWinnings: parseFloat(potentialWinnings),
      });
      setAmount(""); // Reset on successful bet
    } catch (err) {
      setError("Erreur lors du placement du pari");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="rounded-lg border border-[#FFD700] bg-[#004080] p-6">
      <h2 className="mb-6 text-xl font-bold text-white">Placer un pari</h2>

      {selectedBet ? (
        <>
          <div className="mb-6 rounded-lg bg-[#004080]/50 p-4">
            <div className="mb-2 text-sm text-[#FFD700]">Sélection</div>
            <div className="text-lg text-white">{selectedBet}</div>
            <div className="mt-2 text-xl font-bold text-[#FFD700]">
              Cote: {odds}
            </div>
          </div>

          <form onSubmit={handleSubmit}>
            <div className="mb-6">
              <label className="mb-2 block text-sm text-white">
                Montant du pari (€)
              </label>
              <input
                type="number"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="w-full rounded-lg border border-[#FFD700] bg-[#004080]/50 px-4 py-2 text-white"
                placeholder="0.00"
                min="0"
                step="0.01"
              />
            </div>

            <div className="mb-6 rounded-lg bg-[#004080]/50 p-4">
              <div className="text-sm text-white">Gains potentiels</div>
              <div className="text-2xl font-bold text-[#FFD700]">
                {potentialWinnings}€
              </div>
            </div>

            {error && (
              <div className="mb-4 text-sm text-red-500">{error}</div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full rounded-lg bg-[#FFD700] px-6 py-3 text-center font-medium text-[#003366] transition-colors hover:bg-[#FFD700]/80"
            >
              {loading ? "Chargement..." : "Placer le pari"}
            </button>
          </form>
        </>
      ) : (
        <p className="text-center text-white">Aucune sélection pour le moment</p>
      )}
    </div>
  );
}
