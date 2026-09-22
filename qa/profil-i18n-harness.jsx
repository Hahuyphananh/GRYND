// qa/profil-i18n-harness.jsx
//
// Mounts the REAL /profil page component (src/app/profil/PageClient.jsx) under
// the REAL LanguageProvider, with Clerk + a stubbed `fetch` standing in for the
// backend. The point is to prove the page's copy actually renders in the
// selected language — that every `t("profile.*")` key resolves at render time,
// not just that the key exists in the bundle.
//
// The page's child display components (nav, footer, the four cosmetic pickers,
// the emote strip, the stats tabs, the contact history) are stubbed: none of
// them are part of this change, and leaving them live would add their own
// un-translated copy and their own fetches to the assertions.
//
// Run through qa/profil-i18n-check.mjs — it compiles this file, serves it over
// a real http origin (so `localStorage` works) and drives it per language.

import React from "react";
import { createRoot } from "react-dom/client";
import { LanguageProvider } from "../src/context/LanguageContext";
import ProfilePage from "../src/app/profil/PageClient";

const now = new Date("2026-01-02T03:04:05.000Z").toISOString();

const RESPONSES = {
  "/api/get-user-tokens": {
    success: true,
    data: {
      balance: 1234,
      name: "Profil Tester",
      email: "tester@example.com",
      selectedIcon: "icon-1",
      profileAccent: "#00e5ff",
      equippedCosmetics: {
        profile_frame: { key: "frame-1", name: "Neon Frame", visual: {} },
        badge: { key: "badge-1", name: "Founder", visual: { color: "#f5c542" } },
      },
    },
  },
  "/api/get-bet-history": {
    success: true,
    bets: [
      { date: now, type: "Crash", amount: 10, result: "won", tokenDiff: 20 },
      { date: now, type: "Keno", amount: 5, result: "lost", tokenDiff: -5 },
    ],
  },
  "/api/get-purchase-history": {
    success: true,
    purchases: [{ id: 1, createdAt: now, note: "Starter pack", amount: 500 }],
  },
  "/api/user-stats": {
    success: true,
    stats: {
      currentLevel: 12,
      levelProgress: {
        progressPercent: 42.5,
        maxLevel: 100,
        prevLevelRequired: 1000,
        nextLevelRequired: 2500,
      },
      referralCode: "TESTER123",
      referrals: 2,
      referralEarnings: 50,
      record: { wins: 12, losses: 4, winRate: 75, currentStreak: 3 },
    },
  },
  "/api/titles": {
    success: true,
    selectedStreakType: "current",
    streakTitle: "Ignited",
    streakTitleCurrent: "Ignited",
    streakTitleBest: "Blazing",
    dailyStreakCurrent: 3,
    dailyStreakBest: 9,
    allStreakTitles: [{ days: 3, title: "Ignited" }],
  },
  "/api/titles/special": { success: true, titles: [], selectedSpecialTitle: null },
  "/api/user/prestige-badge": {
    success: true,
    badge: { enabled: false, display: null, prestige: 0, prestigeUnlocked: false },
  },
  "/api/membership/status": {
    success: true,
    membership: { active: true, title: "GRYND+ Elite", chatColor: "#00e5ff" },
  },
  "/api/friends/list": { success: true, friends: [] },
  "/api/friends/game-presence": { success: true, byFriend: {} },
  "/api/friends/invites": { success: true, invites: [] },
  "/api/friends/search": { success: true, users: [] },
  "/api/referral/generate": { success: true, referralCode: "TESTER123" },
};

function bodyFor(url) {
  const path = url.replace(/^https?:\/\/[^/]+/, "").split("?")[0];
  return RESPONSES[path] ?? { success: true };
}

const state = (window.__pp = { requests: [], langs: [] });

window.fetch = async (url) => {
  state.requests.push(String(url));
  return new Response(JSON.stringify(bodyFor(String(url))), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};

createRoot(document.getElementById("root")).render(
  <LanguageProvider>
    <ProfilePage />
  </LanguageProvider>,
);
