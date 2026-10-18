// qa/card-number-visual-harness.tsx
//
// Two preselected boards from prompt 7's batch, mounted with fixed payloads:
//   • Solitaire Duel — the REAL `SolitaireBoard`, with a scripted seven-column
//     deal (no page chrome, no auth, no server).
//   • Keno PvP       — the REAL match page, with a scripted survival snapshot
//     through a stubbed `fetch` (the same shape the GET route returns).
//
// The check (`qa/card-number-visual-check.mjs`) bundles this file, stubs the
// noisy siblings, and measures what actually PAINTS at 320 / 360 / 390 / 1280:
// card and tile size, numeral font size, the shared outline/focus wiring, and
// the selected / legal-target / ownership cues. Nothing here decides a game
// rule; the payloads are static.

import React from "react";
import { createRoot } from "react-dom/client";

import SolitaireBoard from "../src/components/solitaire-duel/SolitaireBoard";
import KenoPvpMatchPage from "../src/app/casino/keno-pvp/[matchId]/PageClient";

const iso = (ms: number) => new Date(ms).toISOString();
const T0 = Date.now();

const card = (suit: string, rank: number) => ({ suit, rank });
const up = (suit: string, rank: number) => ({ faceUp: true as const, card: card(suit, rank) });
const down = () => ({ faceUp: false as const, card: null });

// A real-looking deal: hidden cards under face-up runs, a playable black 5
// (column 1) that can land on the red 6 (column 3), a partly built foundation,
// a two-card waste and a non-empty stock.
const SOLITAIRE_VIEW = {
  tableau: [
    [down(), up("spades", 7)],
    [down(), down(), up("hearts", 6), up("spades", 5)],
    [up("diamonds", 12)],
    [up("diamonds", 6)],
    [up("hearts", 9)],
    [up("clubs", 8)],
    [up("spades", 13)],
  ],
  stockCount: 18,
  waste: [card("hearts", 11), card("clubs", 4)],
  foundations: {
    spades: [card("spades", 1), card("spades", 2)],
    hearts: [card("hearts", 1)],
    diamonds: [],
    clubs: [],
  },
  ply: 12,
  resetCount: 0,
  progress: { foundationCards: 3, revealedTableau: 9, progressPercent: 30 },
  completed: false,
  canRedeal: false,
};

// One survival snapshot: tile 17 is live; the public log already resolved
// 3 (mine), 4 (theirs), 5 (both) and 6 (missed by me).
const KENO_MATCH = () => ({
  id: 5150,
  player1Id: "user_1",
  player2Id: "user_2",
  isAi: false,
  stakeAmount: 25,
  status: "round_1",
  p1Lives: 3,
  p2Lives: 2,
  p1Tiles: 2,
  p2Tiles: 3,
  claimedTotal: 4,
  liveTile: 17,
  liveTileIndex: 4,
  liveStartedAt: iso(T0 - 300),
  liveDeadline: iso(T0 + 1200),
  windowMs: 1500,
  tapGraceMs: 120,
  usedCount: 4,
  boardSize: 40,
  myClaimed: [3, 5],
  opponentClaimed: [4, 5],
  tileLog: [
    { tile: 3, index: 0, p1Claimed: true, p2Claimed: false, p1Lives: 3, p2Lives: 2 },
    { tile: 4, index: 1, p1Claimed: false, p2Claimed: true, p1Lives: 3, p2Lives: 2 },
    { tile: 5, index: 2, p1Claimed: true, p2Claimed: true, p1Lives: 2, p2Lives: 2 },
    { tile: 6, index: 3, p1Claimed: false, p2Claimed: false, p1Lives: 1, p2Lives: 2 },
  ],
  winnerId: null,
  result: null,
  prizePaid: 0,
  houseFee: 0,
  startedAt: iso(T0 - 60_000),
  endedAt: null,
  createdAt: iso(T0 - 70_000),
  players: {
    p1: { id: "user_1", displayName: "Tester", iconKey: null, profileFrame: null, nameColor: null },
    p2: { id: "user_2", displayName: "Rival", iconKey: null, profileFrame: null, nameColor: null },
  },
  viewerUserId: "user_1",
  viewerIsParticipant: true,
  viewerSeat: "player1",
  viewerIsPlayer1: true,
  viewerCanClaim: true,
  viewerCanCancel: false,
});

// ── Fake socket (the real broadcast → listener → refetch path) ─────────────
function makeSocket() {
  const listeners = new Map<string, Set<() => void>>();
  const socket: any = {
    id: "socket-1",
    emit() {
      return true;
    },
    on(event: string, handler: () => void) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(handler);
    },
    off(event: string, handler: () => void) {
      listeners.get(event)?.delete(handler);
    },
    timeout() {
      return socket;
    },
  };
  socket.push = (event: string) => {
    for (const handler of listeners.get(event) || []) handler();
  };
  return socket;
}

const state: any = { current: null, fetched: 0, posts: [] };
state.socket = makeSocket();
state.current = KENO_MATCH();

const realFetch = window.fetch?.bind(window);
window.fetch = async (input: any, init: any) => {
  const url = typeof input === "string" ? input : input?.url ?? "";
  const method = (init?.method || "GET").toUpperCase();
  const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
  if (method === "POST") {
    state.posts.push({ url, body: init?.body ?? null });
    return json({ success: true, data: { ok: true } });
  }
  if (url.includes("/api/keno-pvp/")) {
    state.fetched += 1;
    return json({
      success: true,
      data: {
        match: { ...JSON.parse(JSON.stringify(state.current)), serverTime: iso(Date.now()) },
        roundHistory: [],
      },
    });
  }
  if (url.includes("/api/solitaire-duel/")) {
    return json({ success: true, data: {} });
  }
  if (realFetch) return realFetch(input, init);
  return json({ success: true });
};

let root: any = null;

(window as any).__cv = {
  socket: state.socket,
  state,
  mount(game: "solitaire" | "keno") {
    const host = document.getElementById("root");
    if (!root) root = createRoot(host);
    root.render(
      game === "solitaire" ? (
        <div className="min-h-screen bg-[#030817] p-2 text-white">
          <SolitaireBoard view={SOLITAIRE_VIEW as any} interactive onMove={() => {}} />
        </div>
      ) : (
        <KenoPvpMatchPage params={Promise.resolve({ matchId: "5150" })} />
      ),
    );
  },
  unmount() {
    if (root) root.unmount();
    root = null;
  },
};
