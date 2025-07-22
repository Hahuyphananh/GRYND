// src/db/schema.ts
import { pgTable, serial, varchar, integer, numeric, timestamp, jsonb, text, json } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

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
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const pokerGames = pgTable('poker_games', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').notNull(), // Player user ID
  betAmount: numeric('bet_amount', { precision: 10, scale: 2 }).notNull(),
  result: varchar('result', { length: 10 }).notNull(), // "win", "lose", "pending"
  payout: numeric('payout', { precision: 10, scale: 2 }).notNull(),

  // Gameplay-specific columns
  status: varchar('status', { length: 20 }).notNull().default('active'), // active, showdown, completed
  pot: numeric('pot', { precision: 10, scale: 2 }).notNull().default('0.00'),
  minBet: numeric('min_bet', { precision: 10, scale: 2 }).notNull().default('0.00'),
  playerHand: jsonb('player_hand').notNull().default([]),
  aiHand: jsonb('ai_hand').notNull().default([]),
  deck: jsonb('deck').notNull().default([]),
  currentPlayerPosition: integer('current_player_position').notNull().default(0),
  dealerPosition: integer('dealer_position').notNull().default(0),
  currentRound: varchar('current_round', { length: 10 }).notNull().default('preflop'), // preflop, flop, turn, river

  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const pokerPlayerPositions = pgTable('poker_player_positions', {
  id: serial('id').primaryKey(),
  gameId: integer('game_id').notNull().references(() => pokerGames.id),
  playerId: integer('player_id'), // NULL for AI
  position: integer('position').notNull(), // 0 = dealer, 1 = big blind, etc.
  stack: numeric('stack', { precision: 10, scale: 2 }).notNull().default('0.00'),
  currentBet: numeric('current_bet', { precision: 10, scale: 2 }).notNull().default('0.00'),
  hasFolded: varchar('has_folded', { length: 5 }).notNull().default('false'),
  isAllIn: varchar('is_all_in', { length: 5 }).notNull().default('false'),
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
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const plinkoGames = pgTable('plinko_games', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').notNull(),
  betAmount: numeric('bet_amount', { precision: 10, scale: 2 }).notNull(),
  resultMultiplier: numeric('result_multiplier', { precision: 10, scale: 2 }).notNull(),
  payout: numeric('payout', { precision: 10, scale: 2 }).notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const chessGames = pgTable('chess_games', {
  id: serial('id').primaryKey(),
  playerWhiteId: integer('player_white_id').notNull(),
  playerBlackId: integer('player_black_id'),
  betAmount: numeric('bet_amount', { precision: 10, scale: 2 }).notNull(),
  winnerId: integer('winner_id'),
  result: varchar('result', { length: 20 }), // win, loss, draw
  payout: numeric('payout', { precision: 10, scale: 2 }),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const coinFlipGames = pgTable("coin_flip_games", {
  id: serial("id").primaryKey(),
  player1Id: varchar("player1_id", { length: 255 }).notNull(),
  player2Id: varchar("player2_id", { length: 255 }),
  betAmount: numeric("bet_amount", { precision: 10, scale: 2 }).notNull(),
  player1Choice: varchar("player1_choice", { length: 10 }).notNull(), // "heads" or "tails"
  outcome: varchar("outcome", { length: 10 }),
  winnerId: varchar("winner_id", { length: 255 }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const unoGames = pgTable("uno_games", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  betAmount: text("bet_amount").notNull(), // stored as string to match other tables
  pot: text("pot").notNull(), // total pot
  result: text("result").notNull(), // 'win' | 'lose' | 'draw' | 'pending'
  payout: text("payout").notNull(), // string format of number
  playerHand: json("player_hand").notNull(),
  aiHand: json("ai_hand").notNull(),
  deck: json("deck").notNull(),
  discardPile: json("discard_pile").notNull(),
  turn: text("turn").notNull(), // 'player' or 'ai'
  createdAt: timestamp("created_at").defaultNow().notNull(),
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

export const pokerGamesRelations = relations(pokerGames, ({ one }) => ({
  user: one(users, {
    fields: [pokerGames.userId],
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