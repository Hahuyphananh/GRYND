// qa/tap-audit-harness.jsx
//
// Mounts the REAL shared, always-on UI (app chrome, the shared lobby, the shared
// modals) so qa/tap-audit-check.mjs can measure ACTUAL rendered tap targets.
//
// WHY A HARNESS AND NOT THE LIVE SITE: this must never touch the network. The
// repo's pages are force-dynamic and the game screens poll, so driving a real
// origin to take a measurement would generate Vercel function invocations and
// Neon reads. Everything here is offline by construction:
//
//   * esbuild stubs next/navigation, Clerk, posthog, the socket and audio, the
//     same way qa/board-fit-check.mjs does;
//   * `fetch`, `XMLHttpRequest`, `navigator.sendBeacon` and `WebSocket` are
//     replaced by RECORDERS that never leave the page — a click that "fires a
//     network request" is captured as a recorded call, never as traffic;
//   * the document is loaded from file://, so there is no origin to reach, and
//     the check script additionally aborts every outbound route.
//
// Each component sits in its own error boundary, so a component that needs a
// provider we did not stub is skipped and reported rather than blanking the page.

import React from "react";
import { createRoot } from "react-dom/client";

// ── Network recorders (installed before any component can capture them) ────
const rec = { calls: [] };
window.__tap = rec;
// Proof for the check script that these really are our stubs and not the
// browser's own — a recorder that silently failed to install would make the
// "no network" claim meaningless.
rec.installed = { fetch: true, xhr: true, sendBeacon: Boolean(navigator.sendBeacon), websocket: true };

const record = (kind, url, method) => {
  rec.calls.push({
    kind,
    url: String(url).slice(0, 200),
    method: String(method || "GET").toUpperCase(),
  });
};

// A recorder, not a backend. Answers are shaped like the real ones (see the
// sibling harnesses' RESPONSES maps) so a handler that reads
// `data.data.name` completes instead of throwing INSIDE a state updater — an
// error there escapes the caller's try/catch and blanks the whole mount.
const RESPONSES = {
  "/api/get-user-tokens": {
    success: true,
    data: { balance: 1234, name: "Tap Tester", selectedIcon: "icon-1", equippedCosmetics: {} },
  },
  "/api/user-stats": {
    success: true,
    stats: { currentLevel: 3, levelProgress: { progressPercent: 10, maxLevel: 100 }, record: {} },
  },
  "/api/titles": { success: true, streakTitle: "Ignited", allStreakTitles: [] },
  "/api/user/is-admin": { success: true, isAdmin: false },
  "/api/version": { success: true, version: "0.0.0" },
  "/api/leaderboard/my-rank": { success: true, rank: 7 },
  "/api/leaderboard/weekly": { success: true, rank: 7, total: 120 },
  "/api/user/stats": { success: true, stats: {} },
  "/api/quick-queue/status": {
    success: true,
    ready: true,
    assignment: { status: "ready", gameKey: "tic-tac-toe", destinationMatchId: "abc123" },
  },
  "/api/user/daily-loss-limit": { success: true, limit: null, used: 0 },
  "/api/chat/messages": { success: true, messages: [] },
};

const answerFor = (url) => {
  const path = String(url).replace(/^https?:\/\/[^/]+/, "").split("?")[0];
  return RESPONSES[path] ?? { success: true, data: {} };
};

window.fetch = function (input, init) {
  const url = typeof input === "string" ? input : input?.url;
  record("fetch", url, init?.method || (typeof input === "object" ? input?.method : "GET"));
  return Promise.resolve(
    new Response(JSON.stringify(answerFor(url)), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
};

const RealXHR = window.XMLHttpRequest;
window.XMLHttpRequest = function () {
  const xhr = new RealXHR();
  const open = xhr.open.bind(xhr);
  xhr.open = (method, url, ...rest) => {
    record("xhr", url, method);
    return open("GET", "data:application/json,{}", ...rest); // reroute to a no-op
  };
  return xhr;
};

if (navigator.sendBeacon) {
  navigator.sendBeacon = (url) => {
    record("beacon", url, "POST");
    return true;
  };
}

window.WebSocket = function (url) {
  record("websocket", url, "WS");
  const noop = () => {};
  return {
    addEventListener: noop,
    removeEventListener: noop,
    send: noop,
    close: noop,
    readyState: 3,
    url,
  };
};

// ── Component registry ────────────────────────────────────────────────────
import NavigationBar from "../src/components/navigation-bar";
import Footer from "../src/components/Footer";
import { PvpLobby } from "../src/components/lobby/PvpLobby";
import MatchWaiting from "../src/components/lobby/MatchWaiting";
import PvpResultScreen from "../src/components/result/PvpResultScreen";
import ReportModal from "../src/components/ReportModal";
import CookieConsentBanner from "../src/components/CookieConsentBanner";
import SessionGuard from "../src/components/SessionGuard";
import DailyLossGuard from "../src/components/DailyLossGuard";
import ChatWidget from "../src/components/ChatWidget";
import AiDifficultyPicker from "../src/components/lobby/AiDifficultyPicker";
import { QuickQueueStatus } from "../src/components/lobby/QuickQueueStatus";
import EmotePicker from "../src/components/game/EmotePicker";
import ChooseIconModal from "../src/components/ChooseIconModal";

const lobbyRules = {
  title: "How to Play",
  sections: [{ heading: "Basics", body: "Tap to play." }],
};

const MOUNTS = [
  {
    id: "app-chrome",
    label: "App chrome (navbar + footer)",
    node: (
      <>
        <NavigationBar currentPath="/casino" />
        <Footer />
      </>
    ),
  },
  {
    id: "pvp-lobby",
    label: "Shared PvP lobby",
    node: (
      <PvpLobby
        title="Tic-Tac-Toe"
        subtitle="A free 1v1 duel."
        rules={lobbyRules}
        rulesKey="tap-audit"
        waitingSubtitle="Pairing you…"
        onPlay={() => {}}
        playLabel="Find a Match"
        canPlay
        extraActions={
          <button
            type="button"
            onClick={() => window.fetch("/api/tic-tac-toe/create-ai", { method: "POST" })}
            className="inline-flex w-full items-center justify-center gap-2 rounded-xl border py-2 text-sm font-bold"
          >
            Play Free vs AI
          </button>
        }
        lobbies={[
          { matchId: "abcdef1234", player1Id: "user_1", status: "waiting" },
          { matchId: "abcdef5678", player1Id: "user_2", status: "waiting" },
        ]}
        lobbyKey={(row) => row.matchId}
        lobbyTitle={(row) => <>Table #{String(row.matchId).slice(0, 6)}</>}
        lobbyMeta={() => <span>Free ranked</span>}
        onJoin={() => window.fetch("/api/tic-tac-toe/create-or-join", { method: "POST" })}
        onCancel={() => {}}
        onResume={() => {}}
        onRefresh={() => {}}
        myOpenId="abcdef5678"
      />
    ),
  },
  {
    id: "match-waiting",
    label: "Match waiting takeover",
    node: <MatchWaiting state="searching" gameName="Tic-Tac-Toe" subtitle="Pairing you…" />,
  },
  {
    id: "pvp-result",
    label: "PvP result screen",
    node: (
      <PvpResultScreen
        open
        outcome="win"
        headline="You won"
        subline="Well played."
        gameName="Tic-Tac-Toe"
        gameKey="tic-tac-toe"
        durationSeconds={92}
        opponent={{ name: "Opponent", iconKey: null, profileFrame: null, isAi: false }}
        sides={[
          { name: "You", score: 3, highlight: true },
          { name: "Opponent", score: 1, highlight: false },
        ]}
        summary={[{ label: "Accuracy", value: "100%" }]}
        details={[{ label: "Match ID", value: "abcdef" }]}
        playAgain={{ label: "PLAY AGAIN", onClick: () => {} }}
        onReturnToLobby={() => {}}
      />
    ),
  },
  {
    id: "report-modal",
    label: "Report modal",
    node: <ReportModal open onClose={() => {}} onSubmit={() => {}} />,
  },
  {
    id: "lobby-widgets",
    label: "AI difficulty picker + quick queue status",
    node: (
      <>
        <AiDifficultyPicker gameKey="tic-tac-toe" />
        <QuickQueueStatus refreshKey={0} />
      </>
    ),
  },
  {
    id: "emote-picker",
    label: "Emote picker",
    node: (
      <EmotePicker
        onSend={() => {}}
        incomingEmote={{ key: "gg", label: "GG", imageUrl: null }}
        myEmote={{ key: "gg", label: "GG", imageUrl: null }}
      />
    ),
  },
  {
    id: "choose-icon",
    label: "Choose icon modal",
    node: <ChooseIconModal open onClose={() => {}} currentIconKey="icon-1" onEquipped={() => {}} />,
  },
  {
    id: "chrome-globals",
    label: "Cookie banner + guards + chat widget",
    node: (
      <>
        <CookieConsentBanner />
        <SessionGuard />
        <DailyLossGuard>
          <div />
        </DailyLossGuard>
        <ChatWidget />
      </>
    ),
  },
];

class Boundary extends React.Component {
  constructor(p) {
    super(p);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error: String(error?.message || error) };
  }
  componentDidCatch(error) {
    // The stack matters for a skipped mount: it names the real culprit instead
    // of the component we happened to wrap the boundary around.
    const top = String(error?.stack || "")
      .split("\n")
      .slice(0, 4)
      .map((l) => l.trim())
      .join(" ← ");
    window.__tap.failed = (window.__tap.failed || []).concat([
      { id: this.props.id, error: String(error?.message || error).slice(0, 200), stack: top.slice(0, 400) },
    ]);
  }
  render() {
    return this.state.error ? null : this.props.children;
  }
}

function App() {
  return (
    <div id="tap-root">
      {MOUNTS.map((m) => (
        <div data-screen={m.id} key={m.id}>
          <Boundary id={m.id}>{m.node}</Boundary>
        </div>
      ))}
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);

// The audit waits for this. A short settle lets entrance motion finish so the
// measured rects are the resting ones.
requestAnimationFrame(() =>
  requestAnimationFrame(() => {
    setTimeout(() => {
      window.__tapReady = true;
    }, 400);
  }),
);
