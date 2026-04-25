"use client";
import React, { useMemo, useState } from "react";
import { useTranslation } from "../hooks/useTranslation";

const marketTitleKeys = {
  h2h: "sports.moneyline",
  spreads: "sports.point_spread",
  totals: "sports.over_under",
  props: "sports.prop_bets",
};

export default function BetSlip({ selectedBet, marketType, onSubmit }) {
  const [amount, setAmount] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState("");
  const { t } = useTranslation();

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
      setError(t("sports.select_outcome_first"));
      return;
    }

    if (!amount || isNaN(amount) || parseFloat(amount) <= 0) {
      setError(t("sports.enter_valid_stake"));
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
      setSuccess(t("sports.bet_success"));
    } catch (err) {
      setError(err.message || t("sports.bet_failed"));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="rounded-lg border border-[#00e5ff]/45 bg-[#09204b]/95 p-4 shadow-[0_0_16px_rgba(0,229,255,0.2)]">
      <h2 className="mb-4 text-xl font-bold text-[#ecf8ff]">{t("sports.bet_slip")}</h2>

      {!selectedBet && <p className="text-sm text-[#95e4ff]">{t("sports.choose_outcome")}</p>}

      {selectedBet && (
        <>
          <div className="mb-4 rounded-lg bg-[#061633] p-3 text-[#ecf8ff]">
            <p className="text-xs uppercase tracking-wide text-[#f5ff3b]">{t("sports.event")}</p>
            <p className="font-semibold">{selectedBet.eventLabel}</p>
            <p className="mt-2 text-xs uppercase tracking-wide text-[#00e5ff]">{t("sports.market")}</p>
            <p>{t(marketTitleKeys[selectedBet.marketType || marketType] || "sports.moneyline")}</p>
            <p className="mt-2 text-xs uppercase tracking-wide text-[#00e5ff]">{t("sports.selection")}</p>
            <p>{selectedBet.label}</p>
            {selectedBet.line !== null && selectedBet.line !== undefined && (
              <p className="text-sm text-[#95e4ff]">{t("sports.line")}: {selectedBet.line}</p>
            )}
            <p className="mt-2 text-lg font-bold text-[#f5ff3b]">{t("sports.odds")}: {odds}</p>
          </div>

          <form onSubmit={handleSubmit}>
            <label className="mb-1 block text-sm text-[#ecf8ff]">{t("sports.stake")}</label>
            <input
              type="number"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="mb-4 w-full rounded-lg border border-[#00e5ff]/55 bg-[#061633] px-3 py-2 text-[#ecf8ff]"
              min="0"
              step="0.01"
              placeholder="0.00"
            />

            <div className="mb-4 rounded-lg bg-[#061633] p-3">
              <p className="text-sm text-[#95e4ff]">{t("sports.potential_payout")}</p>
              <p className="text-2xl font-bold text-[#f5ff3b]">{potentialWinnings}</p>
            </div>

            {error && <p className="mb-3 text-sm text-red-300">{error}</p>}
            {success && <p className="mb-3 text-sm text-green-300">{success}</p>}

            <button
              type="submit"
              disabled={loading}
              className="w-full rounded-lg border border-[#f5ff3b]/50 bg-[#f5ff3b] px-4 py-2 font-bold text-[#031026] shadow-[0_0_16px_rgba(245,255,59,0.4)] hover:brightness-95"
            >
              {loading ? t("sports.submitting") : t("sports.place_bet")}
            </button>
          </form>
        </>
      )}
    </div>
  );
}
