// src/db/schema.ts
import { pgTable, serial, varchar, integer, numeric, timestamp, jsonb, text, json, boolean, date, pgEnum, index} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";

// USERS TABLE
export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  clerkId: varchar('clerk_id', { length: 255 }).notNull().unique(),
  name: varchar('name', { length: 255 }).notNull(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  password: varchar('password', { length: 255 }).notNull(),
  age: integer('age'),
  balance: numeric('balance', { precision: 10, scale: 2 }).default('1000.00').notNull(),
  gamesWon: integer('games_won').default(0),
  gamesLost: integer('games_lost').default(0),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const userLoginRewards = pgTable("user_login_rewards", {
  userId: integer("user_id").primaryKey().references(() => users.id), // INT to match users.id
  currentDay: integer("current_day").default(1),
  lastClaimedDate: date("last_claimed_date").default(null),
});

// GAMES TABLES
export const rouletteGames = pgTable('roulette_games', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').notNull(),
  betAmount: numeric('bet_amount', { precision: 10, scale: 2 }).notNull(),
  result: varchar('result', { length: 10 }).notNull(),
  payout: numeric('payout', { precision: 10, scale: 2 }).notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const crashGames = pgTable('crash_games', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').notNull(),
  betAmount: numeric('bet_amount', { precision: 10, scale: 2 }).notNull(),
  cashedOutAt: numeric('cashed_out_at', { precision: 10, scale: 2 }),
  payout: numeric('payout', { precision: 10, scale: 2 }).notNull(),
  result: varchar('result', { length: 10 }).default('pending').notNull(),
  status: varchar('status', { length: 20 }).default('active').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const slotGames = pgTable("slot_games", {
  id: serial("id").primaryKey(),
  userId: varchar("user_id", { length: 255 }).notNull(),
  betAmount: numeric("bet_amount", { precision: 10, scale: 2 }).notNull(),
  payout: numeric("payout", { precision: 10, scale: 2 }).notNull(),
  result: varchar("result", { length: 10 }).default("pending").notNull(), // won / lost / draw
  reels: varchar("reels", { length: 255 }).notNull(), // serialized emojis or symbols
  status: varchar("status", { length: 20 }).default("completed").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const pokerGames = pgTable("poker_games", {
  id: serial("id").primaryKey(),
  // Game info
  gameCode: varchar("game_code", { length: 10 })
    .notNull()
    .unique()
    .default(sql`substr(md5((random())::text), 1, 10)`),
  maxPlayers: integer("max_players").notNull().default(6),
  isPrivate: boolean("is_private").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  // ✅ NEW: Players array (max 6 seats)
  /**
   * Structure:
   * [
   *   { seat: 0, clerkId: "user_123" },
   *   { seat: 1, clerkId: null },
   *   ...
   * ]
   */
  players: jsonb("players")
    .notNull()
    .default(sql`
      '[
        {"seat":0,"clerkId":null},
        {"seat":1,"clerkId":null},
        {"seat":2,"clerkId":null},
        {"seat":3,"clerkId":null},
        {"seat":4,"clerkId":null},
        {"seat":5,"clerkId":null}
      ]'::jsonb
    `),
  // Game state
  currentTurn: integer("current_turn"),
  pot: text("pot"),
  communityCards: jsonb("community_cards"),
  deck: jsonb("deck"),
  discardPile: jsonb("discard_pile"),
  // Betting & rounds
  round: text("round"),
  currentBet: text("current_bet"),
  minRaise: text("min_raise"),
  // Player-specific info
  dealerPosition: integer("dealer_position"),
  smallBlind: text("small_blind"),
  bigBlind: text("big_blind"),
  playerPositions: jsonb("player_positions"),
  // Result
  status: text("status").default("waiting"),
  winner: text("winner"),
  winnings: jsonb("winnings"),
  // Variant
  variant: text("variant"),
  // Existing fields
  playerHand: jsonb("player_hand").default(sql`'[]'::jsonb`),
  aiHand: jsonb("ai_hand").default(sql`'[]'::jsonb`)
});

export const pokerPlayerPositions = pgTable("poker_player_positions", {
  id: serial("id").primaryKey(),
  gameId: integer("game_id").notNull(),    // FK to poker_games.id (add constraint in SQL migration if desired)
  playerId: integer("player_id").default(null), // clerk id or NULL for AI
  position: integer("position").notNull(), // seat index
  stack: integer("stack").notNull().default(0),
  currentBet: integer("current_bet").notNull().default(0),
  hasFolded: boolean("has_folded").notNull().default(false),
  isAi: boolean("is_ai").notNull().default(false),
  hand: json("hand").notNull().default(sql`'[]'::json`),
  lastAction: text("last_action").default(null),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const blackjackGames = pgTable('blackjack_games', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').notNull(),
  betAmount: numeric('bet_amount', { precision: 10, scale: 2 }).notNull(),
  result: varchar('result', { length: 10 }).notNull(),
  payout: numeric('payout', { precision: 10, scale: 2 }).notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const minesGames = pgTable('mines_games', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').notNull(),
  betAmount: numeric('bet_amount', { precision: 10, scale: 2 }).notNull(),
  tilesRevealed: integer('tiles_revealed').default(0),
  payout: numeric('payout', { precision: 10, scale: 2 }).notNull(),
  result: varchar('result', { length: 10 }).default('pending').notNull(),
  status: varchar('status', { length: 20 }).default('active').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const plinkoGames = pgTable('plinko_games', {
  id: serial('id').primaryKey(),
  userId: varchar('user_id', { length: 255 }).notNull(),
  betAmount: numeric('bet_amount', { precision: 10, scale: 2 }).notNull(),
  resultMultiplier: varchar('result_multiplier', { length: 255 }).notNull(), // 👈 changed from numeric to varchar
  payout: numeric('payout', { precision: 10, scale: 2 }).notNull(),
  result: varchar('result', { length: 10 }).default('pending').notNull(),
  status: varchar('status', { length: 20 }).default('active').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const chessGames = pgTable('chess_games', {
  id: serial('id').primaryKey(),
  // Clerk IDs for players
  playerWhiteId: varchar('player_white_id', { length: 255 }).notNull(),
  playerBlackId: varchar('player_black_id', { length: 255 }), // can be null if AI
  betAmount: numeric('bet_amount', { precision: 10, scale: 2 }).notNull(),
  winnerId: varchar('winner_id', { length: 255 }), // Clerk ID or null if no result yet
  result: varchar('result', { length: 20 }),       // win, loss, draw
  payout: numeric('payout', { precision: 10, scale: 2 }),
  status: text("status").notNull().default("waiting"),
  isAiGame: boolean('is_ai_game').default(false).notNull(), // ✅ new column
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const chessMoves = pgTable("chess_moves", {
  id: serial("id").primaryKey(),
  gameId: integer("game_id")
    .notNull()
    .references(() => chessGames.id, { onDelete: "cascade" }),
  playedBy: varchar("played_by", { length: 255 }).notNull(),
  moveUci: varchar("move_uci", { length: 10 }).notNull(),
  moveSan: varchar("move_san", { length: 20 }).notNull(),
  fenAfter: text("fen_after").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => ({
  gameIdx: index("chess_moves_game_idx").on(table.gameId),
}));

export const tankStats = pgTable("tank_stats", {
  id: serial("id").primaryKey(),
  matchId: varchar("match_id", { length: 255 }).notNull(),
  clerkId: varchar("clerk_id", { length: 255 }).notNull(),
  username: varchar("username", { length: 255 }),
  bounty: numeric("bounty", { precision: 12, scale: 2 }).notNull().default("1.00"),
  kills: integer("kills").notNull().default(0),
  amountCashedOut: numeric("amount_cashed_out", { precision: 12, scale: 2 }).default("0.00"),
  result: varchar("result", { length: 20 }), 
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const tankMatches = pgTable("tank_matches", {
  id: serial("id").primaryKey(),
  matchId: varchar("match_id", { length: 255 }).notNull(),
  hostClerkId: varchar("host_clerk_id", { length: 255 }).notNull(),
  maxPlayers: integer("max_players").notNull().default(2),
  // NEW COLUMN
  currentPlayers: integer("current_players")
    .notNull()
    .default(1), // since the host counts as the first player
  isOpen: boolean("is_open").notNull().default(true),
  settings: jsonb("settings").default({}),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  players: jsonb("players").$type<string[]>().notNull().default([]),
  gameStarted: boolean("game_started").notNull().default(false),
});

export const coinFlipStatusEnum = pgEnum("coin_flip_status", [
  "active",
  "matched",
  "finished",
  "cancelled",
]);

export const coinFlipGames = pgTable(
  "coin_flip_games",
  {
id: serial("id").primaryKey(),
player1Id: varchar("player1_id", { length: 255 }).notNull(),
player2Id: varchar("player2_id", { length: 255 }),
betAmount: numeric("bet_amount", {
      precision: 10,
      scale: 2,
    }).notNull(),
player1Choice: varchar("player1_choice", { length: 10 }),
player2Choice: varchar("player2_choice", { length: 10 }),
choiceDeadline: timestamp("choice_deadline"),
outcome: varchar("outcome", { length: 10 }),
winnerId: varchar("winner_id", { length: 255 }),
result: varchar("result", { length: 10 })
      .default("pending")
      .notNull(),
status: coinFlipStatusEnum("status")
      .default("active")
      .notNull(),
createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    openGamesIdx: index("coin_flip_open_games_idx").on(
      table.player2Id
    ),
    statusIdx: index("coin_flip_status_idx").on(
      table.status
    ),
  })
);

export const unoGames = pgTable("uno_games", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  player2Id: integer("player2_id"),
  betAmount: text("bet_amount").notNull(), // stored as string to match other tables
  pot: text("pot").notNull(), // total pot
  result: text("result").notNull(), // 'win' | 'lose' | 'draw' | 'pending'
  payout: text("payout").notNull(), // string format of number

  // ✅ existing AI game fields
  playerHand: json("player_hand").default("[]").notNull(),
aiHand: json("ai_hand").default("[]").notNull(),

  // ✅ new online multiplayer fields
  player1Hand: json("player1_hand").default("[]").notNull(),
  player2Hand: json("player2_hand").default("[]").notNull(),

  deck: json("deck").notNull(),
  discardPile: json("discard_pile").notNull(),
  turn: text("turn").notNull(), // 'player' / 'ai' OR 'player1' / 'player2'
  currentColor: text("current_color"),
  topCard: json("top_card"),
  status: text("status").default("waiting").notNull(), // 'waiting' | 'active' | 'finished'

  createdAt: timestamp("created_at").defaultNow().notNull(),
  winner: text("winner").default("pending").notNull(), // 'player' / 'ai' OR 'player1' / 'player2'
});


export const rpsGames = pgTable("rps_games", {
  id: serial("id").primaryKey(),
  userId: varchar("user_id", { length: 255 }).notNull(),
  betAmount: numeric("bet_amount").notNull(),
  choice: varchar("choice", { length: 20 }).notNull(), // rock, paper, scissors
  aiChoice: varchar("ai_choice", { length: 20 }).notNull(),
  result: varchar("result", { length: 20 }).notNull(), // win, lose, draw
  payout: numeric("payout").default("0"),
  createdAt: timestamp("created_at").defaultNow(),
});


export const rpsPvpStatusEnum = pgEnum("rps_pvp_status", [
  "active",
  "matched",
  "finished",
  "cancelled",
]);

export const rpsPvpGames = pgTable(
  "rps_pvp_games",
  {
    id: serial("id").primaryKey(),
    player1Id: varchar("player1_id", { length: 255 }).notNull(),
    player2Id: varchar("player2_id", { length: 255 }),
    betAmount: numeric("bet_amount", { precision: 10, scale: 2 }).notNull(),
    player1Choice: varchar("player1_choice", { length: 20 }),
    player2Choice: varchar("player2_choice", { length: 20 }),
    outcome: varchar("outcome", { length: 20 }),
    winnerId: varchar("winner_id", { length: 255 }),
    result: varchar("result", { length: 20 }).default("pending").notNull(),
    status: rpsPvpStatusEnum("status").default("active").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    openGamesIdx: index("rps_pvp_open_games_idx").on(table.player2Id),
    statusIdx: index("rps_pvp_status_idx").on(table.status),
  })
);

export const keno_games = pgTable("keno_games", {
  id: serial("id").primaryKey(),
  user_id: integer("user_id").notNull(),
  bet_amount: numeric("bet_amount", { precision: 10, scale: 2 }).notNull(),
  numbers_picked: jsonb("numbers_picked").notNull(), // store array of numbers as JSON
  numbers_drawn: jsonb("numbers_drawn").notNull(),
  hits: integer("hits").notNull(),
  payout: numeric("payout", { precision: 10, scale: 2 }).notNull(),
  multiplier: numeric("multiplier", { precision: 5, scale: 2 }).notNull(),
  status: varchar("status", { length: 20 }).notNull(),
  created_at: timestamp("created_at").defaultNow().notNull(),
});

//
// RELATIONS
//

export const usersRelations = relations(users, ({ many }) => ({
  rouletteGames: many(rouletteGames),
  crashGames: many(crashGames),
  pokerGames: many(pokerGames),
  blackjackGames: many(blackjackGames),
  minesGames: many(minesGames),
  plinkoGames: many(plinkoGames),
}));

export const rouletteGamesRelations = relations(rouletteGames, ({ one }) => ({
  user: one(users, {
    fields: [rouletteGames.userId],
    references: [users.id],
  }),
}));

export const crashGamesRelations = relations(crashGames, ({ one }) => ({
  user: one(users, {
    fields: [crashGames.userId],
    references: [users.id],
  }),
}));

export const blackjackGamesRelations = relations(blackjackGames, ({ one }) => ({
  user: one(users, {
    fields: [blackjackGames.userId],
    references: [users.id],
  }),
}));

export const minesGamesRelations = relations(minesGames, ({ one }) => ({
  user: one(users, {
    fields: [minesGames.userId],
    references: [users.id],
  }),
}));

export const plinkoGamesRelations = relations(plinkoGames, ({ one }) => ({
  user: one(users, {
    fields: [plinkoGames.userId],
    references: [users.id],
  }),
}));

export const chessGamesRelations = relations(chessGames, ({ one }) => ({
  playerWhite: one(users, {
    fields: [chessGames.playerWhiteId],
    references: [users.id],
    relationName: "playerWhite",
  }),
  playerBlack: one(users, {
    fields: [chessGames.playerBlackId],
    references: [users.id],
    relationName: "playerBlack",
  }),
  winner: one(users, {
    fields: [chessGames.winnerId],
    references: [users.id],
  }),
}));


// SPORTS (football, basketball, etc.)
export const sports = pgTable('sports', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 100 }).notNull(),
});

// EVENTS (matches)
export const events = pgTable('events', {
  id: serial('id').primaryKey(),
  sportId: integer('sport_id').notNull(),
  teamA: varchar('team_a', { length: 100 }).notNull(),
  teamB: varchar('team_b', { length: 100 }).notNull(),
  startTime: timestamp('start_time').notNull(),
  oddsA: numeric('odds_a', { precision: 5, scale: 2 }).notNull(),
  oddsB: numeric('odds_b', { precision: 5, scale: 2 }).notNull(),
  oddsDraw: numeric('odds_draw', { precision: 5, scale: 2 }), // optional
  status: varchar('status', { length: 20 }).default('upcoming'), // upcoming, closed, finished
});

// BETS (user's bets on events)
export const sportsBets = pgTable('sports_bets', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').notNull(),
  eventId: integer('event_id').notNull(),
  betAmount: numeric('bet_amount', { precision: 10, scale: 2 }).notNull(),
  choice: varchar('choice', { length: 100 }).notNull(), // "teamA", "teamB", "draw"
  odds: numeric('odds', { precision: 5, scale: 2 }).notNull(),
  payout: numeric('payout', { precision: 10, scale: 2 }),
  result: varchar('result', { length: 20 }), // "win", "loss", "pending"
  placedAt: timestamp('placed_at').defaultNow(),
});
