// qa/battlepass-reconnect-harness.jsx
//
// Mounts the REAL /battlepass page client (src/app/battlepass/PageClient.jsx)
// and the REAL reconnect banner (components/states/OfflineBanner.tsx) against a
// stubbed fetch, so qa/battlepass-reconnect-check.mjs can reproduce the two
// windows that produced:
//
//   TypeError: Cannot read properties of null (reading 'prestigeUnlocked')
//     at src/app/battlepass/PageClient.jsx
//
//   1. the transient window after a global `mutate(() => true, undefined,
//      { revalidate: true })` cleared every cached SWR payload, and
//   2. the reconnect path itself.
//
// Everything noisy around the page (nav, footer, background, i18n, next/link)
// is stubbed by the esbuild step; SWR, the page and the data-state components
// are the real shipped ones. The API is a controllable fetcher exposed on
// `window.__bp`.
//
// Controls (read/written by the check script):
//   window.__bp.mode       "ok" | "pending" | "error"
//   window.__bp.pass       payload returned as { success, pass }
//   window.__bp.calls      fetch count
//   window.__bp.boundaryError   message captured by the error boundary
//   window.__bp.forceWipe()     the OLD banner behaviour (cache write)
//   window.__bp.revalidate()    revalidate-only, like the fixed banner

import React from "react";
import { createRoot } from "react-dom/client";
import { SWRConfig, mutate } from "swr";
import PageClient from "../src/app/battlepass/PageClient";
import OfflineBanner from "../src/components/states/OfflineBanner";

function makePass(overrides = {}) {
  const levels = [];
  for (let lvl = 1; lvl <= 6; lvl++) {
    levels.push({
      level: lvl,
      xpRequired: lvl === 1 ? 0 : 5 * (lvl - 1) * (lvl + 28),
      xpForNext: 150 + 10 * (lvl - 1),
      title: null,
      rewards:
        lvl === 1
          ? [
              {
                type: "color",
                key: "cyan",
                name: "Cyan Glow",
                desc: "Unlock the cyan name glow",
                value: "#00e5ff",
                rarity: "Common",
                premium: false,
                locked: false,
                claimed: false,
                claimable: true,
              },
            ]
          : [],
    });
  }
  return {
    level: 1,
    xp: 0,
    currentLevelXp: 0,
    nextLevelXp: 150,
    prevLevelRequired: 0,
    nextLevelRequired: 150,
    progressPercent: 0,
    remainingToNext: 150,
    maxLevel: 100,
    prestige: 0,
    prestigeUnlocked: false,
    prestigeNetWins: 0,
    maxPrestige: 10,
    nextPrestigeRequirement: 50,
    prestigeProgressPercent: 0,
    unclaimedCount: 1,
    isPremium: false,
    levels,
    ...overrides,
  };
}

const state = {
  mode: "ok",
  pass: makePass(),
  calls: 0,
  boundaryError: null,
};
window.__bp = state;

async function fetcher(url) {
  state.calls += 1;
  if (state.mode === "error") throw new TypeError("Failed to fetch");
  if (state.mode === "pending") return new Promise(() => {});
  return { success: true, pass: state.pass };
}

// Mirrors the route-level error boundary (src/app/error.tsx): if a render
// throws, the real page would show "This screen hit a problem".
class Boundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error) {
    state.boundaryError = String((error && error.message) || error);
  }
  render() {
    if (this.state.error) {
      return React.createElement(
        "div",
        { "data-error-boundary": "true" },
        "This screen hit a problem",
      );
    }
    return this.props.children;
  }
}

state.forceWipe = () => mutate(() => true, undefined, { revalidate: true });
state.revalidate = () => mutate(() => true);

function App() {
  return (
    <SWRConfig
      value={{
        fetcher,
        revalidateOnReconnect: true,
        dedupingInterval: 0,
        shouldRetryOnError: false,
        errorRetryCount: 0,
      }}
    >
      <Boundary>
        <PageClient />
        <OfflineBanner />
      </Boundary>
    </SWRConfig>
  );
}

createRoot(document.getElementById("root")).render(<App />);
window.__bpReady = true;
