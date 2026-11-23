"use client";

// src/components/profil/BetHistoryPanel.jsx
//
// Extracted from src/app/profil/PageClient.jsx. One card, one table, no
// fetch of its own: the page owns the data and passes `bets`, so this file
// can never become a second source of truth for a player's history.
//
// Copy resolves through `profile.betHistory.*` and every surface reads the
// semantic layer. The suites read the page and its extracted modules as one
// source (tests/helpers/profile-source.mjs), so moving it here changes no
// contract.

import { useTranslation } from "../../hooks/useTranslation";

export default function BetHistoryPanel({ bets = [] }) {
  const { t } = useTranslation();

  return (
    <div
      className="mt-12 bg-[color:var(--bg-surface)] border border-white/10 
rounded-xl p-6 
shadow-[var(--shadow-raise)]"
    >
      <h2 className="text-xl text-cyan-200/80 mb-4">
        {t("profile.betHistory.title", "Bet history")}
      </h2>
      <div className="overflow-x-auto">
        <table className="w-full text-sm text-left">
          <thead className="border-b border-[color:var(--state-gold)] text-cyan-200/80">
            <tr>
              <th className="px-4 py-2">
                {t("profile.betHistory.date", "Date")}
              </th>
              <th className="px-4 py-2">
                {t("profile.betHistory.game", "Game / event")}
              </th>
              <th className="px-4 py-2">
                {t("profile.betHistory.result", "Result")}
              </th>
            </tr>
          </thead>
          <tbody>
            {bets.length > 0 ? (
              bets.map((bet, idx) => (
                <tr key={idx} className="border-b border-[color:var(--border-hairline)]">
                  <td className="px-4 py-2">{new Date(bet.date).toLocaleDateString()}</td>
                  <td className="px-4 py-2">
                    {bet.type ||
                      bet.event ||
                      bet.game_type ||
                      t("profile.betHistory.unknown", "Unknown")}
                  </td>
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
                          ? t("profile.betHistory.won", "Won")
                          : bet.result === "lost"
                            ? t("profile.betHistory.lost", "Lost")
                            : t("profile.betHistory.draw", "Draw")}
                      </span>

                    </div>
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan="3" className="text-center py-4 text-gray-400">
                  {t("profile.betHistory.empty", "No bets found")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
