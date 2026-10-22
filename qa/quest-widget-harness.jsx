// qa/quest-widget-harness.jsx
//
// Mounts the REAL corner quest widget (src/components/QuestWidget) and its popup
// (src/components/QuestPopup) with Clerk stubbed as signed-in and a SCRIPTED
// quest backend, so the browser check (qa/quest-widget-check.mjs) can drive the
// thing a player actually does: read the corner, open the board, claim a quest,
// and watch the progress the SERVER reports.
//
// The widget is mounted inside a transformed wrapper on purpose — the home page
// hero and the games hub both animate transforms, and a transformed ancestor
// becomes the containing block for `position: fixed` and opens a stacking
// context. The popup must therefore be portalled; the check proves the dialog is
// not clipped to that wrapper.
//
// The scripted world lives on `window.__questWorld`, set by addInitScript before
// this bundle runs:
//   { signedIn, balance, daily, weekly }
//
// The backend mirrors the real route contract:
//   GET  /api/quests        → { success, daily, weekly, balance, periodKeys, resets }
//   POST /api/quests/claim  → credits the stored reward once, returns the board
//
// Run through qa/quest-widget-check.mjs.

import React from "react";
import { createRoot } from "react-dom/client";
import { LanguageProvider } from "../src/context/LanguageContext";
import QuestWidget from "../src/components/QuestWidget";
import QuestNavBadge from "../src/components/QuestNavBadge";

const world = (window.__questWorld = window.__questWorld || {});
world.signedIn = world.signedIn !== false;
world.balance = Number.isFinite(world.balance) ? world.balance : 1000;
world.daily = world.daily || [
  {
    id: 11,
    periodType: "daily",
    periodKey: "2026-10-22",
    slot: 1,
    definitionId: "daily-first-match",
    objective: "pvp_matches",
    gameKey: null,
    title: "First match",
    description: "Play 1 match against a real player.",
    target: 1,
    progress: 1,
    reward: 50,
    completed: true,
    claimed: false,
    claimable: true,
  },
  {
    id: 12,
    periodType: "daily",
    periodKey: "2026-10-22",
    slot: 2,
    definitionId: "daily-three-matches",
    objective: "pvp_matches",
    gameKey: null,
    title: "Warmed up",
    description: "Play 3 matches against real players.",
    target: 3,
    progress: 1,
    reward: 80,
    completed: false,
    claimed: false,
    claimable: false,
  },
];
world.weekly = world.weekly || [
  {
    id: 21,
    periodType: "weekly",
    periodKey: "2026-W43",
    slot: 1,
    definitionId: "weekly-fifteen-matches",
    objective: "pvp_matches",
    gameKey: null,
    title: "Weekly regular",
    description: "Play 15 matches against real players this week.",
    target: 15,
    progress: 4,
    reward: 400,
    completed: false,
    claimed: false,
    claimable: false,
  },
  {
    id: 22,
    periodType: "weekly",
    periodKey: "2026-W43",
    slot: 2,
    definitionId: "weekly-eight-wins",
    objective: "pvp_wins",
    gameKey: null,
    title: "Weekly champion",
    description: "Win 8 matches against real players this week.",
    target: 8,
    progress: 2,
    reward: 300,
    completed: false,
    claimed: false,
    claimable: false,
  },
];
world.requests = [];

function board() {
  return {
    success: true,
    daily: world.daily,
    weekly: world.weekly,
    balance: world.balance,
    periodKeys: { daily: "2026-10-22", weekly: "2026-W43" },
    resets: {
      dailyStart: "2026-10-22T00:00:00.000Z",
      dailyEnd: "2026-10-23T00:00:00.000Z",
      weeklyStart: "2026-10-19T00:00:00.000Z",
      weeklyEnd: "2026-10-26T00:00:00.000Z",
    },
  };
}

window.fetch = async (url, init = {}) => {
  const path = String(url).replace(/^https?:\/\/[^/]+/, "").split("?")[0];
  const method = String(init?.method || "GET").toUpperCase();
  world.requests.push({ method, path, body: init?.body ?? null });

  if (path === "/api/quests" && method === "GET") {
    return new Response(JSON.stringify(board()), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (path === "/api/quests/claim" && method === "POST") {
    let questId = null;
    try {
      questId = JSON.parse(String(init?.body ?? "{}"))?.questId ?? null;
    } catch {
      questId = null;
    }
    const all = [...world.daily, ...world.weekly];
    const quest = all.find((entry) => Number(entry.id) === Number(questId));
    if (!quest) {
      return new Response(JSON.stringify({ success: false, error: "Unknown quest" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (!quest.claimable) {
      return new Response(
        JSON.stringify({ success: false, error: "That quest is not claimable" }),
        { status: 409, headers: { "Content-Type": "application/json" } },
      );
    }
    quest.claimable = false;
    quest.claimed = true;
    world.balance += Number(quest.reward) || 0;
    return new Response(
      JSON.stringify({ ...board(), credited: Number(quest.reward) || 0 }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }

  return new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};

createRoot(document.getElementById("root")).render(
  <LanguageProvider>
    <div style={{ paddingTop: 120 }} data-testid="page-host">
      {/* A transformed host, exactly like the home hero and the games grid. */}
      <div style={{ transform: "translateY(0px)" }} data-testid="animated-host">
        <QuestWidget />
      </div>
      {/* The Games hub nav badge, mounted the way the navbar mounts it. */}
      <div className="mt-4 px-4" data-testid="nav-badge-host">
        <QuestNavBadge />
      </div>
    </div>
  </LanguageProvider>,
);
