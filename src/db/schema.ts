// src/db/schema.ts
import { pgTable, serial, varchar, integer, numeric, timestamp } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

// USERS TABLE
export const users = pgTable('users', {
  id: serial('id').primaryKey(),
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
  userId: integer('user_id').notNull(),
  betAmount: numeric('bet_amount', { precision: 10, scale: 2 }).notNull(),
  result: varchar('result', { length: 10 }).notNull(),
  payout: numeric('payout', { precision: 10, scale: 2 }).notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
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