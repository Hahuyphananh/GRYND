// src/lib/defaultWagers.js
//
// Catalog of stake-based games and their built-in default wager (tokens).
// The Settings page lists these so players can set a per-game default; the
// /api/user/default-wagers route validates against the same key set; and
// each game page's wager state initializes through src/hooks/useDefaultWager.js
// with these exact keys.

export const WAGER_GAMES = [
  { key: "blackjack", label: "Blackjack", fallback: 50 },
  { key: "roulette", label: "Roulette", fallback: 50 },
  { key: "plinko", label: "Plinko", fallback: 50 },
  { key: "mines", label: "Mines", fallback: 50 },
  { key: "memory-grid", label: "Memory Grid", fallback: 50 },
  { key: "keno", label: "Keno", fallback: 50 },
  { key: "dice-flush", label: "Dice Flush", fallback: 100 },
  { key: "tower-arena", label: "Tower Arena", fallback: 10 },
  { key: "odds", label: "Odds", fallback: 50 },
  { key: "hex-duel", label: "Hex Duel", fallback: 50 },
  { key: "four-in-a-row", label: "Four in a Row", fallback: 10 },
  { key: "dots-and-boxes", label: "Dots and Boxes", fallback: 10 },
  { key: "uno", label: "UNO", fallback: 100 },
  { key: "pool-masters", label: "Pool Masters", fallback: 10 },
  { key: "rps", label: "Rock Paper Scissors", fallback: 10 },
  { key: "lane-runner", label: "Lane Runner", fallback: 50 },
  { key: "precision", label: "Precision", fallback: 10 },
];

export const WAGER_GAME_KEYS = WAGER_GAMES.map((g) => g.key);

export const WAGER_BY_KEY = Object.fromEntries(
  WAGER_GAMES.map((g) => [g.key, g.fallback]),
);