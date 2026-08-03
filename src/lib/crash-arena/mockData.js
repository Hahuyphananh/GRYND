/**
 * Crash Arena — shared mock table data.
 * Used by both the lobby and the table room pages.
 * Each table's minBuyIn = 5 × wager (arena rule).
 */

const MOCK_TABLES = [
  {
    id: "table-1",
    name: "$1 Crash Arena",
    wager: 1,
    minBuyIn: 5,        // 5 × wager
    maxBuyIn: 50,
    maxPlayers: 6,
    status: "waiting",
    roundNumber: 4,
    pot: 24,
    nextRoundSeconds: 30,
    players: [
      { name: "Alice", balance: 40, status: "waiting", isYou: false },
      { name: "Bob",   balance: 60, status: "waiting", isYou: false },
    ],
  },
  {
    id: "table-5",
    name: "$5 Crash Arena",
    wager: 5,
    minBuyIn: 25,       // 5 × wager
    maxBuyIn: 250,
    maxPlayers: 6,
    status: "flying",
    roundNumber: 12,
    pot: 625,
    crashedAt: null,
    nextRoundSeconds: 0,
    players: [
      { name: "Charlie", balance: 100, status: "waiting", isYou: false },
      { name: "Diana",   balance: 175, status: "cashed_out", isYou: false },
      { name: "Eve",     balance: 75,  status: "waiting", isYou: false },
      { name: "Frank",   balance: 250, status: "crashed", isYou: false },
    ],
  },
  {
    id: "table-10",
    name: "$10 Crash Arena",
    wager: 10,
    minBuyIn: 50,       // 5 × wager
    maxBuyIn: 500,
    maxPlayers: 6,
    status: "waiting",
    roundNumber: 8,
    pot: 400,
    nextRoundSeconds: 30,
    players: [
      { name: "Grace", balance: 200, status: "waiting", isYou: false },
      { name: "Hank",  balance: 300, status: "waiting", isYou: false },
      { name: "Ivy",   balance: 125, status: "waiting", isYou: false },
    ],
  },
  {
    id: "table-25",
    name: "$25 Crash Arena",
    wager: 25,
    minBuyIn: 125,      // 5 × wager
    maxBuyIn: 1250,
    maxPlayers: 6,
    status: "waiting",
    roundNumber: 3,
    pot: 750,
    nextRoundSeconds: 30,
    players: [
      { name: "Jack", balance: 500, status: "waiting", isYou: false },
    ],
  },
  {
    id: "table-100",
    name: "$100 Crash Arena",
    wager: 100,
    minBuyIn: 500,      // 5 × wager
    maxBuyIn: 5000,
    maxPlayers: 6,
    status: "waiting",
    roundNumber: 15,
    pot: 4250,
    nextRoundSeconds: 30,
    players: [
      { name: "King",  balance: 2500, status: "waiting", isYou: false },
      { name: "Queen", balance: 1750, status: "waiting", isYou: false },
      { name: "Ace",   balance: 3000, status: "cashed_out", isYou: false },
      { name: "Joker", balance: 1000, status: "crashed", isYou: false },
      { name: "Duke",  balance: 2250, status: "waiting", isYou: false },
    ],
  },
  {
    id: "table-full",
    name: "$50 Crash Arena",
    wager: 50,
    minBuyIn: 250,      // 5 × wager
    maxBuyIn: 2500,
    maxPlayers: 6,
    status: "waiting",
    roundNumber: 1,
    pot: 1500,
    nextRoundSeconds: 30,
    players: Array.from({ length: 6 }, (_, i) => ({
      name: `Player${i + 1}`,
      balance: 250 + i * 50,
      status: "waiting",
      isYou: false,
    })),
  },
];

/** Look up a table by ID. Returns a shallow clone so mutations are local. */
export function getTable(tableId) {
  const t = MOCK_TABLES.find((t) => t.id === tableId);
  return t ? { ...t, players: [...t.players] } : null;
}

/** List all tables (shallow clones). */
export function getTables() {
  return MOCK_TABLES.map((t) => ({ ...t, players: [...t.players] }));
}
