// qa/design-shots-harness.tsx
//
// Mounts the four SCREENS prompt 7 changed, fully loaded, for the design
// screenshots:
//
//   • /casino/solitaire-duel          — the real lobby (PvpLobby chrome)
//   • /casino/solitaire-duel/1        — the real match page + the scripted deal
//   • /casino/keno                    — the real Keno lobby (Keno Survival Duel)
//   • /casino/keno-pvp/1              — the real match page + a live snapshot
//
// Everything is REAL except the noisy environment (Clerk, socket, router,
// fetch payloads, audio) which `qa/design-shots.mjs` stubs. The navigation bar,
// footer, lobby chrome and match HUD are the shipped ones, so the screenshots
// show the product's actual design, not a mock-up.

import React from "react";
import { createRoot } from "react-dom/client";

import SolitaireDuelLobbyPage from "../src/app/casino/solitaire-duel/PageClient";
import SolitaireDuelMatchPage from "../src/app/casino/solitaire-duel/[matchId]/PageClient";
import KenoLobbyPage from "../src/app/casino/keno/PageClient";
import KenoPvpMatchPage from "../src/app/casino/keno-pvp/[matchId]/PageClient";
import MinesPvpLobbyPage from "../src/app/casino/mines-pvp/PageClient";
import MinesPvpMatchPage from "../src/app/casino/mines-pvp/[matchId]/PageClient";
import MemoryGridLobbyPage from "../src/app/casino/memory-grid/PageClient";
import MemoryGridMatchPage from "../src/app/casino/memory-grid/[matchId]/PageClient";

const iso = (ms: number) => new Date(ms).toISOString();
const T0 = Date.now();

const card = (suit: string, rank: number) => ({ suit, rank });
const up = (suit: string, rank: number) => ({ faceUp: true as const, card: card(suit, rank) });
const down = () => ({ faceUp: false as const, card: null });

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

const SOLITAIIRE_MATCH = () => ({
  matchId: "1",
  variant: "klondike",
  variantVersion: 1,
  status: "active",
  result: null,
  resolutionReason: null,
  winnerId: null,
  seat: "player1",
  isParticipant: true,
  isAi: false,
  aiDifficulty: null,
  goAtMs: T0 - 30_000,
  inactivityAlarmAtMs: T0 + 10 * 60_000,
  inactivityForfeitAtMs: T0 + 15 * 60_000,
  opponentInactivityAlarmAtMs: T0 + 10 * 60_000,
  opponentInactivityForfeitAtMs: T0 + 15 * 60_000,
  startedAtMs: T0 - 60_000,
  endedAtMs: null,
  createdAtMs: T0 - 90_000,
  serverNow: T0,
  view: SOLITAIRE_VIEW,
  progress: { foundationCards: 3, revealedTableau: 9, progressPercent: 30 },
  opponent: {
    seatKey: "player2",
    foundationCards: 2,
    revealedTableau: 7,
    progressPercent: 24,
    completed: false,
  },
  players: {
    player1: { name: "Tester", iconKey: "cat", nameColor: null, profileFrame: null, isGuest: false },
    player2: { name: "Rival", iconKey: "ghost", nameColor: null, profileFrame: null, isGuest: false },
  },
});

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
    p1: { id: "user_1", displayName: "Tester", iconKey: "cat", profileFrame: null, nameColor: null },
    p2: { id: "user_2", displayName: "Rival", iconKey: "ghost", profileFrame: null, nameColor: null },
  },
  viewerUserId: "user_1",
  viewerIsParticipant: true,
  viewerSeat: "player1",
  viewerIsPlayer1: true,
  viewerCanClaim: true,
  viewerCanCancel: false,
});

const LOBBY_ROWS = [
  { id: 9001, player1Id: "user_9", stakeAmount: 25, createdAt: iso(T0 - 20_000) },
  { id: 9002, player1Id: "user_8", stakeAmount: 50, createdAt: iso(T0 - 40_000) },
  { id: 9003, player1Id: "user_7", stakeAmount: 100, createdAt: iso(T0 - 55_000) },
];

const MINES_LOBBY_ROWS = [
  { id: 9101, player1Id: "user_9", stakeAmount: 25, minesCount: 5, createdAt: iso(T0 - 25_000) },
  { id: 9102, player1Id: "user_8", stakeAmount: 50, minesCount: 5, createdAt: iso(T0 - 45_000) },
  { id: 9103, player1Id: "user_7", stakeAmount: 100, minesCount: 5, createdAt: iso(T0 - 60_000) },
];

const MEMORY_LOBBY_ROWS = [
  {
    id: 9201,
    player1Id: "user_9",
    stakeAmount: 25,
    createdAt: iso(T0 - 25_000),
    hostName: "Rival",
    hostIconKey: "ghost",
    hostProfileFrame: null,
  },
  {
    id: 9202,
    player1Id: "user_8",
    stakeAmount: 50,
    createdAt: iso(T0 - 45_000),
    hostName: "Nova",
    hostIconKey: "cat",
    hostProfileFrame: null,
  },
  {
    id: 9203,
    player1Id: "user_7",
    stakeAmount: 100,
    createdAt: iso(T0 - 60_000),
    hostName: "Echo",
    hostIconKey: "ghost",
    hostProfileFrame: null,
  },
];

const MINE_PICKS = [
  { userId: "user_1", seat: "player1", cell: 7, isMine: false, hint: 2, autoPicked: false, pickedAt: iso(T0 - 40_000) },
  { userId: "user_2", seat: "player2", cell: 12, isMine: false, hint: 1, autoPicked: false, pickedAt: iso(T0 - 30_000) },
  { userId: "user_1", seat: "player1", cell: 8, isMine: false, hint: 1, autoPicked: false, pickedAt: iso(T0 - 20_000) },
];

const MINES_MATCH = () => ({
  id: 4242,
  player1Id: "user_1",
  player2Id: "user_2",
  isAi: false,
  stakeAmount: "25",
  status: "active",
  minesCount: 5,
  safeTilesRemaining: 14,
  board: null,
  firstPlayerId: "user_1",
  currentTurnUserId: "user_1",
  picks: MINE_PICKS.map((p) => ({ ...p })),
  pickCount: MINE_PICKS.length,
  p1Pick: 8,
  p2Pick: 12,
  p1PickIsMine: false,
  p2PickIsMine: false,
  p1AutoPicked: false,
  p2AutoPicked: false,
  p1PickedAt: iso(T0 - 20_000),
  p2PickedAt: iso(T0 - 30_000),
  roundDeadline: iso(T0 + 14_000),
  roundTimerSeconds: 20,
  winnerId: null,
  result: null,
  houseFee: "0",
  prizePaid: "0",
  startedAt: iso(T0 - 60_000),
  endedAt: null,
  createdAt: iso(T0 - 80_000),
  players: {
    p1: { id: "user_1", displayName: "Tester", iconKey: "cat", profileFrame: null, nameColor: null },
    p2: { id: "user_2", displayName: "Rival", iconKey: "ghost", profileFrame: null, nameColor: null },
  },
});

const MEMORY_MATCH = () => ({
  id: 5150,
  player1Id: "user_1",
  player2Id: "user_2",
  isAi: false,
  stakeAmount: 25,
  status: "active",
  phase: "reconstruct",
  roundNumber: 2,
  roundsPerMatch: 5,
  roundConfig: { gridSize: 5, activeCount: 7, memorizeMs: 5000 },
  viewerIsPlayer1: true,
  p1Submitted: false,
  p2Submitted: false,
  phaseStartedAt: iso(T0 - 5_000),
  phaseDeadline: iso(T0 + 20_000),
  serverNow: iso(T0),
  p1Score: 1,
  p2Score: 0,
  p1Total: 180,
  p2Total: 140,
  p1RoundScore: 0,
  p2RoundScore: 0,
  players: {
    p1: { id: "user_1", displayName: "Tester", iconKey: "cat", profileFrame: null },
    p2: { id: "user_2", displayName: "Rival", iconKey: "ghost", profileFrame: null },
  },
  pattern: { size: 5, total: 25, active: [0, 3, 6, 11, 14, 19, 22] },
  result: null,
  winnerId: null,
  prizePaid: 0,
  houseFee: 0,
  refundEach: null,
  startedAt: iso(T0 - 120_000),
  endedAt: null,
  createdAt: iso(T0 - 140_000),
});

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

const socket = makeSocket();

const realFetch = window.fetch?.bind(window);
window.fetch = async (input: any, init: any) => {
  const url = typeof input === "string" ? input : input?.url ?? "";
  const method = (init?.method || "GET").toUpperCase();
  const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

  if (method === "POST" && url.includes("/api/get-user-tokens")) {
    return json({
      success: true,
      data: {
        balance: 2400,
        iconKey: "cat",
        selectedTitle: "",
        title: null,
        totalTrophies: 12,
        streak: 3,
        glowColor: null,
      },
    });
  }
  if (url.includes("/api/titles")) return json({ success: true, data: { titles: [], selected: null } });
  if (url.includes("/api/user/daily-loss")) return json({ success: true, data: { limit: null, loss: 0 } });
  if (url.includes("/api/quick-queue/readiness")) return json({ success: true, data: { ready: true, games: [] } });
  if (url.includes("/api/solitaire-duel/match/")) return json({ success: true, data: SOLITAIIRE_MATCH() });
  if (url.includes("/api/solitaire-duel/")) return json({ success: true, data: { ok: true } });
  if (url.includes("/api/keno-pvp/available")) return json({ success: true, data: { matches: LOBBY_ROWS } });
  if (url.includes("/api/keno-pvp/match/")) {
    return json({ success: true, data: { match: { ...KENO_MATCH(), serverTime: iso(Date.now()) }, roundHistory: [] } });
  }
  if (url.includes("/api/mines-pvp/available")) return json({ success: true, data: { matches: MINES_LOBBY_ROWS } });
  if (url.includes("/api/mines-pvp/match/")) {
    return json({ success: true, data: { match: { ...MINES_MATCH(), serverNow: iso(Date.now()) }, roundHistory: [] } });
  }
  if (url.includes("/api/mines-pvp/")) return json({ success: true, data: { ok: true } });
  if (url.includes("/api/memory-grid/available")) return json({ success: true, data: { matches: MEMORY_LOBBY_ROWS } });
  if (url.includes("/api/memory-grid/match/")) {
    return json({ success: true, data: { match: { ...MEMORY_MATCH(), serverNow: iso(Date.now()) }, roundHistory: [] } });
  }
  if (url.includes("/api/memory-grid/")) return json({ success: true, data: { ok: true } });
  if (url.includes("/api/keno-pvp/")) return json({ success: true, data: { ok: true } });
  if (method === "POST") return json({ success: true, data: { ok: true } });
  if (url.startsWith("/api/")) return json({ success: true, data: {} });
  if (realFetch) return realFetch(input, init);
  return json({ success: true, data: {} });
};

let root: any = null;

(window as any).__shots = {
  socket,
  mount(
    screen:
      | "solitaire-lobby"
      | "solitaire-match"
      | "keno-lobby"
      | "keno-match"
      | "mines-lobby"
      | "mines-match"
      | "memory-lobby"
      | "memory-match",
  ) {
    const host = document.getElementById("root");
    if (!root) root = createRoot(host);
    if (screen === "solitaire-lobby") root.render(<SolitaireDuelLobbyPage />);
    if (screen === "solitaire-match") root.render(<SolitaireDuelMatchPage />);
    if (screen === "keno-lobby") root.render(<KenoLobbyPage />);
    if (screen === "keno-match")
      root.render(<KenoPvpMatchPage params={Promise.resolve({ matchId: "5150" })} />);
    if (screen === "mines-lobby") root.render(<MinesPvpLobbyPage />);
    if (screen === "mines-match")
      root.render(<MinesPvpMatchPage params={Promise.resolve({ matchId: "4242" })} />);
    if (screen === "memory-lobby") root.render(<MemoryGridLobbyPage />);
    if (screen === "memory-match")
      root.render(<MemoryGridMatchPage params={Promise.resolve({ matchId: "5150" })} />);
  },
};
