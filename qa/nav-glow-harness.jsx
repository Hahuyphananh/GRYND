// qa/nav-glow-harness.jsx
//
// Mounts the REAL NavigationBar (src/components/navigation-bar.jsx) with Clerk
// stubbed as signed-in and a stubbed `fetch`, so the glow assertions run against
// the component that actually ships.
//
// The equipped name glow is served by /api/get-user-tokens as `glowColor`
// (the left-joined catalog colour of `users.selectedGlow`). The check sets
// `window.__navGlow` via addInitScript BEFORE this bundle runs:
//   "#7dd3fc" → that glow is equipped
//   null      → no glow equipped (and a chat colour present, which must NOT
//               paint the name)
//
// Run through qa/nav-glow-check.mjs.

import React from "react";
import { createRoot } from "react-dom/client";
import { LanguageProvider } from "../src/context/LanguageContext";
import { ThemeProvider } from "../src/context/ThemeContext";
import NavigationBar from "../src/components/navigation-bar";

const glow = window.__navGlow ?? null;
const state = (window.__ng = { requests: [] });

const RESPONSES = {
  "/api/get-user-tokens": {
    success: true,
    data: {
      balance: 1234.5,
      name: "Glow Tester",
      selectedIcon: "icon-1",
      // The glow and the Grynd+ chat colour are DIFFERENT things: `nameColor`
      // falls back to the chat colour, `glowColor` is the glow alone. Serving
      // both here is what proves the navbar uses the right one.
      glowColor: glow,
      nameColor: glow ?? "#ff00ff",
      equippedCosmetics: {},
    },
  },
  "/api/user/is-admin": { isAdmin: false },
  "/api/user/daily-loss": { success: true, loss: 0 },
};

function bodyFor(path) {
  return RESPONSES[path] ?? { success: true };
}

window.fetch = async (url) => {
  const path = String(url).replace(/^https?:\/\/[^/]+/, "").split("?")[0];
  state.requests.push(path);
  return new Response(JSON.stringify(bodyFor(path)), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};

createRoot(document.getElementById("root")).render(
  <LanguageProvider>
    <ThemeProvider>
      <NavigationBar currentPath="/" />
    </ThemeProvider>
  </LanguageProvider>,
);
