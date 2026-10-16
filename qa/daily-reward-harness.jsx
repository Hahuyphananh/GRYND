// qa/daily-reward-harness.jsx
//
// Mounts the REAL NavigationBar, DailyRewardCard and CsrfFetchGuard with Clerk
// stubbed as signed-in and a SCRIPTED backend, so the browser check
// (qa/daily-reward-claim-check.mjs) can drive a real claim and watch the coin
// number the navbar and the /rewards balance card actually paint.
//
// CsrfFetchGuard is mounted on purpose: it wraps window.fetch in the shipping
// app (src/app/layout.tsx), so any request-shape or caching interaction it
// introduces is part of the behaviour under test, not an artefact of the
// harness.
//
// The scripted world lives on `window.__dailyWorld`, set by addInitScript before
// this bundle runs:
//   { balance, streakDay, cycle, claimable, playGateSatisfied, credited }
//
// `cycle` defaults to the SHIPPED 14-day curve, so the board under test is the
// board the app renders.
//
// The backend mirrors the real route contract:
//   GET  /api/rewards/daily → the status payload (+ balance)
//   POST /api/rewards/daily → credits `credited` and returns the new balance
//   POST /api/get-user-tokens → { success, data: { balance, ... } }
//
// Run through qa/daily-reward-claim-check.mjs.

import React from "react";
import { createRoot } from "react-dom/client";
import { LanguageProvider } from "../src/context/LanguageContext";
import { ThemeProvider } from "../src/context/ThemeContext";
import NavigationBar from "../src/components/navigation-bar";
import DailyRewardCard from "../src/components/DailyRewardCard";
import CsrfFetchGuard from "../src/components/CsrfFetchGuard";
import { useCoinBalance } from "../src/hooks/useCoinBalance";

const world = (window.__dailyWorld = window.__dailyWorld || {});
world.balance = Number.isFinite(world.balance) ? world.balance : 1000;
world.streakDay = Number.isFinite(world.streakDay) ? world.streakDay : 3;
world.cycle = world.cycle || [
  30, 35, 45, 50, 60, 70, 80, 90, 105, 120, 135, 155, 175, 200,
];
world.claimable = world.claimable !== false;
world.playGateSatisfied = world.playGateSatisfied !== false;
// The amount the SERVER actually credits, which the reported status may or may
// not agree with — that disagreement is one of the things under test.
world.credited = Number.isFinite(world.credited)
  ? world.credited
  : world.cycle[world.streakDay - 1];
world.requests = [];
world.claims = 0;

function dailyStatus() {
  return {
    success: true,
    claimable: world.claimable,
    playGateSatisfied: world.playGateSatisfied,
    streakDay: world.streakDay,
    cycleDay: ((world.streakDay - 1) % world.cycle.length) + 1,
    cycleDays: world.cycle.length,
    reward: world.cycle[((world.streakDay - 1) % world.cycle.length)],
    today: "2026-10-16",
    cycle: world.cycle,
    balance: world.balance,
  };
}

function bodyFor(path, method) {
  if (path === "/api/rewards/daily") {
    if (method === "POST") {
      world.claims += 1;
      if (!world.claimable) {
        return { status: 409, body: { success: false, error: "Already claimed today" } };
      }
      if (!world.playGateSatisfied) {
        return {
          status: 403,
          body: {
            success: false,
            error: "Play a game to unlock today's reward",
            playGateSatisfied: false,
          },
        };
      }
      world.balance += world.credited;
      world.claimable = false;
      return {
        status: 200,
        body: {
          success: true,
          ...dailyStatus(),
          reward: world.credited,
          balance: world.balance,
          claimedDay: world.streakDay,
        },
      };
    }
    return { status: 200, body: dailyStatus() };
  }

  if (path === "/api/get-user-tokens") {
    return {
      status: 200,
      body: {
        success: true,
        data: {
          balance: world.balance,
          name: "Reward Tester",
          selectedIcon: "icon-1",
          glowColor: null,
          nameColor: null,
          equippedCosmetics: {},
          totalTrophies: 12,
        },
      },
    };
  }

  if (path === "/api/user/is-admin") return { status: 200, body: { isAdmin: false } };
  if (path === "/api/user/daily-loss") {
    return { status: 200, body: { success: true, loss: 0 } };
  }
  if (path === "/api/titles") {
    return { status: 200, body: { success: true, selectedTitle: "" } };
  }
  return { status: 200, body: { success: true } };
}

window.fetch = async (url, init = {}) => {
  const path = String(url).replace(/^https?:\/\/[^/]+/, "").split("?")[0];
  const method = String(init?.method || "GET").toUpperCase();
  world.requests.push(`${method} ${path}`);
  const { status, body } = bodyFor(path, method);
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
};

// The exact hook the /rewards page uses for its balance card
// (src/app/rewards/PageClient.tsx → SignedInCoinBalance). Rendering it here,
// beside the card that claims, is what lets the check answer "does the rewards
// page's own balance move after a claim?" rather than only the navbar's.
function BalanceProbe() {
  const balance = useCoinBalance();
  return (
    <p data-testid="probe-balance">
      {balance === null ? "unknown" : String(balance)}
    </p>
  );
}

createRoot(document.getElementById("root")).render(
  <LanguageProvider>
    <ThemeProvider>
      <CsrfFetchGuard />
      <NavigationBar currentPath="/rewards" />
      <div style={{ paddingTop: 120 }}>
        <BalanceProbe />
        {/* The card is mounted inside a TRANSFORMED wrapper on purpose. That is
            what /rewards does (framer-motion animates the card's entrance with
            translateY), and a transformed ancestor becomes the containing
            block for `position: fixed` and opens a stacking context — so an
            overlay rendered in place would be sized to this box and could be
            painted under the fixed navbar. The board must therefore be
            portalled, and the check proves it by measuring the overlay. */}
        <div style={{ transform: "translateY(0px)" }} data-testid="animated-host">
          <DailyRewardCard />
        </div>
      </div>
    </ThemeProvider>
  </LanguageProvider>,
);
