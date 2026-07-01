// src/db/schema.ts
import {
  pgTable,
  serial,
  varchar,
  integer,
  numeric,
  timestamp,
  jsonb,
  text,
  json,
  boolean,
  date,
  pgEnum,
  index,
  uuid,
  bigint,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";

// USERS TABLE
export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  clerkId: varchar("clerk_id", { length: 255 }).notNull().unique(),
  name: varchar("name", { length: 255 }).notNull(),
  email: varchar("email", { length: 255 }).notNull().unique(),
  profilePicture: text("profile_picture"),
  password: varchar("password", { length: 255 }).notNull(),
  age: integer("age"),
  balance: numeric("balance", { precision: 30, scale: 2 })
    .default("1000.00")
    .notNull(),
  gamesWon: integer("games_won").default(0),
  gamesLost: integer("games_lost").default(0),
  referralCode: varchar("referral_code", { length: 30 }).unique(),
  referredById: integer("referred_by_id"),
  referralCount: integer("referral_count").default(0).notNull(),
  referralEarnings: numeric("referral_earnings", { precision: 10, scale: 2 })
    .default("0.00")
    .notNull(),
  totalWagered: bigint("total_wagered", { mode: "number" })
    .default(0)
    .notNull(),
  totalWon: bigint("total_won", { mode: "number" }).default(0).notNull(),
  level: integer("level").default(1).notNull(),
  xp: integer("xp").default(0).notNull(),
  biggestWin: integer("biggest_win").default(0).notNull(),
  bestMultiplier: numeric("best_multiplier", { precision: 10, scale: 4 })
    .default("0")
    .notNull(),
  currentStreak: integer("current_streak").default(0).notNull(),
  bestStreak: integer("best_streak").default(0).notNull(),
  dailyStreakCurrent: integer("daily_streak_current").default(0).notNull(),
  dailyStreakBest: integer("daily_streak_best").default(0).notNull(),
  weeklyStreakCurrent: integer("weekly_streak_current").default(0).notNull(),
  weeklyStreakBest: integer("weekly_streak_best").default(0).notNull(),
  weekKey: varchar("week_key", { length: 8 }),
  lastLoginDate: date("last_login_date"),
  pvpWins: integer("pvp_wins").default(0).notNull(),
  weeklyWagered: bigint("weekly_wagered", { mode: "number" })
    .default(0)
    .notNull(),
  weeklyWon: bigint("weekly_won", { mode: "number" }).default(0).notNull(),
  weeklyProfit: bigint("weekly_profit", { mode: "number" })
    .default(0)
    .notNull(),
  weeklyWins: integer("weekly_wins").default(0).notNull(),
  selectedTitle: text("selected_title").default(null),
  highestTitle: text("highest_title").default(null),
  selectedSpecialTitle: text("selected_special_title").default(null),
  selectedStreakType: varchar("selected_streak_type", { length: 10 }).default(null),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  searchName: varchar("search_name", { length: 255 }),
  termsAccepted: boolean("terms_accepted").notNull().default(false),
  isAdmin: boolean("is_admin").notNull().default(false),
  isBanned: boolean("is_banned").notNull().default(false),
});

export const friendRelations = pgTable(
  "friend_relations",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    friendId: integer("friend_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    uniqueFriendship: index("friend_relations_user_friend_idx").on(
      table.userId,
      table.friendId,
    ),
  }),
);

export const userGamePresence = pgTable(
  "user_game_presence",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    gameKey: varchar("game_key", { length: 80 }).notNull(),
    gameId: integer("game_id"),
    lastSeenAt: timestamp("last_seen_at").notNull().defaultNow(),
  },
  (table) => ({
    userGameIdx: index("user_game_presence_user_game_idx").on(
      table.userId,
      table.gameKey,
    ),
  }),
);

export const presenceStatusEnum = pgEnum("presence_status", [
  "online",
  "in_game",
  "offline",
]);

export const userPresence = pgTable(
  "user_presence",
  {
    clerkId: varchar("clerk_id", { length: 255 }).primaryKey(),
    lastSeen: timestamp("last_seen").notNull().defaultNow(),
    status: presenceStatusEnum("status").notNull().default("offline"),
    currentGameId: varchar("current_game_id", { length: 255 }),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    statusSeenIdx: index("user_presence_status_seen_idx").on(
      table.status,
      table.lastSeen,
    ),
  }),
);

export const userLoginRewards = pgTable("user_login_rewards", {
  userId: integer("user_id")
    .primaryKey()
    .references(() => users.id), // INT to match users.id
  currentDay: integer("current_day").default(1),
  lastClaimedDate: date("last_claimed_date").default(null),
});

export const userStats = pgTable("user_stats", {
  userId: integer("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  totalBets: integer("total_bets").notNull().default(0),
  wins: integer("wins").notNull().default(0),
  losses: integer("losses").notNull().default(0),
  winRate: numeric("win_rate", { precision: 5, scale: 2 })
    .notNull()
    .default("0"),
  totalWagered: numeric("total_wagered", { precision: 14, scale: 2 })
    .notNull()
    .default("0"),
  totalWon: numeric("total_won", { precision: 14, scale: 2 })
    .notNull()
    .default("0"),
  biggestWin: numeric("biggest_win", { precision: 14, scale: 2 })
    .notNull()
    .default("0"),
  favoriteGame: varchar("favorite_game", { length: 100 })
    .notNull()
    .default("N/A"),
  currentStreak: integer("current_streak").notNull().default(0),
  bestStreak: integer("best_streak").notNull().default(0),
  dailyStreakCurrent: integer("daily_streak_current").notNull().default(0),
  dailyStreakBest: integer("daily_streak_best").notNull().default(0),
  weeklyStreakCurrent: integer("weekly_streak_current").notNull().default(0),
  weeklyStreakBest: integer("weekly_streak_best").notNull().default(0),
  level: integer("level").notNull().default(1),
  xp: integer("xp").notNull().default(0),
  weeklyWagered: bigint("weekly_wagered", { mode: "number" })
    .notNull()
    .default(0),
  weeklyWon: bigint("weekly_won", { mode: "number" }).notNull().default(0),
  weeklyWins: integer("weekly_wins").notNull().default(0),
  weeklyLosses: integer("weekly_losses").notNull().default(0),
  weeklyLevelGain: integer("weekly_level_gain").notNull().default(0),
  weeklyBestStreak: integer("weekly_best_streak").notNull().default(0),
  weeklyBiggestWin: bigint("weekly_biggest_win", { mode: "number" })
    .notNull()
    .default(0),
  weeklyWinRate: numeric("weekly_win_rate", { precision: 5, scale: 2 })
    .notNull()
    .default("0"),
  weeklyGameStreak: integer("weekly_game_streak").notNull().default(0),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const specialTitles = pgTable("special_titles", {
  id: serial("id").primaryKey(),
  key: varchar("key", { length: 120 }).notNull().unique(),
  name: varchar("name", { length: 255 }).notNull(),
  description: text("description").notNull(),
  rarity: varchar("rarity", { length: 40 }).notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const userSpecialTitles = pgTable(
  "user_special_titles",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    titleKey: varchar("title_key", { length: 120 }).notNull(),
    unlockedAt: timestamp("unlocked_at").notNull().defaultNow(),
  },
  (table) => ({
    uniqUserTitle: index("user_special_titles_user_title_idx").on(
      table.userId,
      table.titleKey,
    ),
  }),
);

export const streakTitles = pgTable("streak_titles", {
  id: serial("id").primaryKey(),
  days: integer("days").notNull().unique(),
  title: varchar("title", { length: 100 }).notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const userSecretStats = pgTable("user_secret_stats", {
  userId: integer("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  chatMessagesCount: integer("chat_messages_count").notNull().default(0),
  goonbetMentions: integer("goonbet_mentions").notNull().default(0),
  allInPhraseMentions: integer("all_in_phrase_mentions").notNull().default(0),
  gamesPlayed: integer("games_played").notNull().default(0),
  winStreak: integer("win_streak").notNull().default(0),
  lossStreak: integer("loss_streak").notNull().default(0),
  allInCount: integer("all_in_count").notNull().default(0),
  allInLossStreak: integer("all_in_loss_streak").notNull().default(0),
  jackpotsWon: integer("jackpots_won").notNull().default(0),
  lastKnownBalance: numeric("last_known_balance", { precision: 14, scale: 2 })
    .notNull()
    .default("0.00"),
  dayStartBalance: numeric("day_start_balance", { precision: 14, scale: 2 })
    .notNull()
    .default("0.00"),
  dayKey: varchar("day_key", { length: 10 }),
  loginDays: integer("login_days").notNull().default(0),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const chatRoomTypeEnum = pgEnum("chat_room_type", ["global", "game"]);

export const chatMessages = pgTable(
  "chat_messages",
  {
    id: serial("id").primaryKey(),
    roomType: chatRoomTypeEnum("room_type").notNull().default("global"),
    roomId: varchar("room_id", { length: 255 }).notNull(),
    clerkId: varchar("clerk_id", { length: 255 }).notNull(),
    displayName: varchar("display_name", { length: 255 }).notNull(),
    profileImageUrl: text("profile_image_url"),
    content: text("content").notNull(),
    isDeleted: boolean("is_deleted").notNull().default(false),
    deletedAt: timestamp("deleted_at"),
    deletedByClerkId: varchar("deleted_by_clerk_id", { length: 255 }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    roomIdx: index("chat_messages_room_idx").on(
      table.roomType,
      table.roomId,
      table.createdAt,
    ),
    moderationIdx: index("chat_messages_moderation_idx").on(
      table.isDeleted,
      table.createdAt,
    ),
  }),
);

// GAMES TABLES
export const rouletteGames = pgTable("roulette_games", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  betAmount: numeric("bet_amount", { precision: 10, scale: 2 }).notNull(),
  result: varchar("result", { length: 10 }).notNull(),
  payout: numeric("payout", { precision: 10, scale: 2 }).notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const crashGames = pgTable("crash_games", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  betAmount: numeric("bet_amount", { precision: 10, scale: 2 }).notNull(),
  cashedOutAt: numeric("cashed_out_at", { precision: 10, scale: 2 }),
  payout: numeric("payout", { precision: 10, scale: 2 }).notNull(),
  result: varchar("result", { length: 10 }).default("pending").notNull(),
  status: varchar("status", { length: 20 }).default("active").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
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
  // Legacy single-player stats columns kept for rankings compatibility
  userId: integer("user_id"),
  betAmount: numeric("bet_amount", { precision: 10, scale: 2 }),
  payout: numeric("payout", { precision: 10, scale: 2 }),
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
  players: jsonb("players").notNull().default(sql`
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
  aiHand: jsonb("ai_hand").default(sql`'[]'::jsonb`),
});

export const pokerPlayerPositions = pgTable("poker_player_positions", {
  id: serial("id").primaryKey(),
  gameId: integer("game_id").notNull(), // FK to poker_games.id (add constraint in SQL migration if desired)
  playerId: integer("player_id").default(null), // clerk id or NULL for AI
  position: integer("position").notNull(), // seat index
  stack: integer("stack").notNull().default(0),
  currentBet: integer("current_bet").notNull().default(0),
  hasFolded: boolean("has_folded").notNull().default(false),
  isAi: boolean("is_ai").notNull().default(false),
  hand: json("hand")
    .notNull()
    .default(sql`'[]'::json`),
  lastAction: text("last_action").default(null),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const blackjackGames = pgTable("blackjack_games", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  betAmount: numeric("bet_amount", { precision: 10, scale: 2 }).notNull(),
  result: varchar("result", { length: 10 }).notNull(),
  payout: numeric("payout", { precision: 10, scale: 2 }).notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const minesGames = pgTable("mines_games", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  betAmount: numeric("bet_amount", { precision: 10, scale: 2 }).notNull(),
  tilesRevealed: integer("tiles_revealed").default(0),
  minesCount: integer("mines_count").default(0),
  payout: numeric("payout", { precision: 10, scale: 2 }).notNull(),
  result: varchar("result", { length: 10 }).default("pending").notNull(),
  status: varchar("status", { length: 20 }).default("active").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const laneRunnerGames = pgTable("lane_runner_games", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  betAmount: numeric("bet_amount", { precision: 10, scale: 2 }).notNull(),
  payout: numeric("payout", { precision: 10, scale: 2 })
    .notNull()
    .default("0.00"),
  result: varchar("result", { length: 20 }).notNull().default("pending"),
  difficulty: varchar("difficulty", { length: 20 }).notNull(),
  currentLane: integer("current_lane").notNull().default(0),
  multiplier: numeric("multiplier", { precision: 12, scale: 4 })
    .notNull()
    .default("1.0000"),
  clientSeed: varchar("client_seed", { length: 255 }).notNull(),
  serverSeedHash: varchar("server_seed_hash", { length: 255 }).notNull(),
  serverSeed: varchar("server_seed", { length: 255 }),
  nonce: varchar("nonce", { length: 255 }).notNull(),
  outcomeSequence: jsonb("outcome_sequence").notNull(),
  status: varchar("status", { length: 20 }).notNull().default("completed"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const plinkoGames = pgTable("plinko_games", {
  id: serial("id").primaryKey(),
  userId: varchar("user_id", { length: 255 }).notNull(),
  betAmount: numeric("bet_amount", { precision: 10, scale: 2 }).notNull(),
  resultMultiplier: varchar("result_multiplier", { length: 255 }).notNull(), // 👈 changed from numeric to varchar
  payout: numeric("payout", { precision: 10, scale: 2 }).notNull(),
  result: varchar("result", { length: 10 }).default("pending").notNull(),
  status: varchar("status", { length: 20 }).default("active").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const chessGames = pgTable("chess_games", {
  id: serial("id").primaryKey(),
  // Clerk IDs for players
  playerWhiteId: varchar("player_white_id", { length: 255 }).notNull(),
  playerBlackId: varchar("player_black_id", { length: 255 }), // can be null if AI
  betAmount: numeric("bet_amount", { precision: 10, scale: 2 }).notNull(),
  timerMode: varchar("timer_mode", { length: 20 }).notNull().default("blitz"),
  initialTimeSeconds: integer("initial_time_seconds").notNull().default(300),
  winnerId: varchar("winner_id", { length: 255 }), // Clerk ID or null if no result yet
  result: varchar("result", { length: 20 }), // win, loss, draw
  payout: numeric("payout", { precision: 10, scale: 2 }),
  status: text("status").notNull().default("waiting"),
  isAiGame: boolean("is_ai_game").default(false).notNull(), // ✅ new column
  startedAt: timestamp("started_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const chessMoves = pgTable(
  "chess_moves",
  {
    id: serial("id").primaryKey(),
    gameId: integer("game_id")
      .notNull()
      .references(() => chessGames.id, { onDelete: "cascade" }),
    playedBy: varchar("played_by", { length: 255 }).notNull(),
    moveUci: varchar("move_uci", { length: 10 }).notNull(),
    moveSan: varchar("move_san", { length: 20 }).notNull(),
    fenAfter: text("fen_after").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    gameIdx: index("chess_moves_game_idx").on(table.gameId),
  }),
);

export const diceLobbies = pgTable("dice_lobbies", {
  id: uuid("id").defaultRandom().primaryKey(),
  hostUserId: varchar("host_user_id", { length: 255 }).notNull(),
  opponentUserId: varchar("opponent_user_id", { length: 255 }),
  wager: integer("wager").notNull(),
  status: varchar("status", { length: 20 }).notNull().default("waiting"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const diceMatches = pgTable("dice_matches", {
  id: uuid("id").defaultRandom().primaryKey(),
  lobbyId: uuid("lobby_id").references(() => diceLobbies.id, {
    onDelete: "cascade",
  }),
  player1Id: varchar("player1_id", { length: 255 }).notNull(),
  player2Id: varchar("player2_id", { length: 255 }).notNull(),
  winnerId: varchar("winner_id", { length: 255 }),
  wager: integer("wager").notNull(),
  prizePaid: integer("prize_paid").notNull().default(0),
  houseFee: integer("house_fee").notNull().default(0),
  hp1: integer("hp1").notNull().default(20),
  hp2: integer("hp2").notNull().default(20),
  turnUserId: varchar("turn_user_id", { length: 255 }).notNull(),
  round: integer("round").notNull().default(1),
  status: varchar("status", { length: 20 }).notNull().default("active"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  endedAt: timestamp("ended_at"),
});

export const diceTurns = pgTable("dice_turns", {
  id: uuid("id").defaultRandom().primaryKey(),
  matchId: uuid("match_id")
    .notNull()
    .references(() => diceMatches.id, { onDelete: "cascade" }),
  userId: varchar("user_id", { length: 255 }).notNull(),
  round: integer("round").notNull(),
  actionType: varchar("action_type", { length: 30 }).notNull(),
  roll1: integer("roll_1"),
  roll2: integer("roll_2"),
  damageDealt: integer("damage_dealt").notNull().default(0),
  selfDamage: integer("self_damage").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const dicePlayerStats = pgTable("dice_player_stats", {
  userId: varchar("user_id", { length: 255 }).primaryKey(),
  wins: integer("wins").notNull().default(0),
  losses: integer("losses").notNull().default(0),
  gamesPlayed: integer("games_played").notNull().default(0),
  totalWagered: bigint("total_wagered", { mode: "number" })
    .notNull()
    .default(0),
  totalWon: bigint("total_won", { mode: "number" }).notNull().default(0),
  highestWin: integer("highest_win").notNull().default(0),
  currentStreak: integer("current_streak").notNull().default(0),
  bestStreak: integer("best_streak").notNull().default(0),
});

export const poolLobbies = pgTable(
  "pool_lobbies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    hostUserId: text("host_user_id").notNull(),
    opponentUserId: text("opponent_user_id"),
    wager: integer("wager").notNull(),
    gameMode: text("game_mode").notNull(),
    status: text("status").notNull().default("waiting"),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => ({
    statusIdx: index("idx_pool_lobbies_status").on(
      table.status,
      table.createdAt,
    ),
  }),
);

export const poolMatches = pgTable(
  "pool_matches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    lobbyId: uuid("lobby_id").references(() => poolLobbies.id, {
      onDelete: "set null",
    }),
    player1Id: text("player1_id").notNull(),
    player2Id: text("player2_id"),
    winnerId: text("winner_id"),
    wager: integer("wager").notNull(),
    prizePaid: integer("prize_paid").default(0),
    houseFee: integer("house_fee").default(0),
    gameState: jsonb("game_state"),
    currentTurnUserId: text("current_turn_user_id"),
    status: text("status").default("active"),
    createdAt: timestamp("created_at").defaultNow(),
    endedAt: timestamp("ended_at"),
  },
  (table) => ({
    player1Idx: index("idx_pool_matches_player1").on(table.player1Id),
    player2Idx: index("idx_pool_matches_player2").on(table.player2Id),
    createdIdx: index("idx_pool_matches_created").on(table.createdAt),
  }),
);

export const poolShots = pgTable(
  "pool_shots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    matchId: uuid("match_id")
      .notNull()
      .references(() => poolMatches.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    angle: numeric("angle").notNull(),
    power: numeric("power").notNull(),
    result: jsonb("result"),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => ({
    matchIdx: index("idx_pool_shots_match").on(table.matchId, table.createdAt),
  }),
);

export const poolPlayerStats = pgTable("pool_player_stats", {
  userId: text("user_id").primaryKey(),
  wins: integer("wins").default(0),
  losses: integer("losses").default(0),
  gamesPlayed: integer("games_played").default(0),
  totalWagered: bigint("total_wagered", { mode: "number" }).default(0),
  totalWon: bigint("total_won", { mode: "number" }).default(0),
  biggestWin: integer("biggest_win").default(0),
  currentStreak: integer("current_streak").default(0),
  bestStreak: integer("best_streak").default(0),
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
    result: varchar("result", { length: 10 }).default("pending").notNull(),
    status: coinFlipStatusEnum("status").default("active").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    // ── Best-of-N (default best-of-3) support ──────────────────────
    // First player to reach `target_wins` round wins ends the match.
    // Per-round outcome / choices are reset between rounds (the
    // per-round state is still on the row, not a child table) so the
    // status route can stay single-row focused. See status/route.js.
    targetWins: integer("target_wins").default(2).notNull(),
    scorePlayer1: integer("score_player1").default(0).notNull(),
    scorePlayer2: integer("score_player2").default(0).notNull(),
  },
  (table) => ({
    openGamesIdx: index("coin_flip_open_games_idx").on(table.player2Id),
    statusIdx: index("coin_flip_status_idx").on(table.status),
  }),
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
  }),
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

export const connectFourGames = pgTable(
  "connect_four_games",
  {
    id: serial("id").primaryKey(),
    hostClerkId: varchar("host_clerk_id", { length: 255 }).notNull(),
    guestClerkId: varchar("guest_clerk_id", { length: 255 }),
    betAmount: numeric("bet_amount", { precision: 10, scale: 2 }).notNull(),
    status: varchar("status", { length: 30 }).notNull().default("waiting"),
    board: jsonb("board")
      .notNull()
      .default(
        sql`'[[0,0,0,0,0,0,0],[0,0,0,0,0,0,0],[0,0,0,0,0,0,0],[0,0,0,0,0,0,0],[0,0,0,0,0,0,0],[0,0,0,0,0,0,0]]'::jsonb`,
      ),
    hostDiscsUsed: integer("host_discs_used").notNull().default(0),
    guestDiscsUsed: integer("guest_discs_used").notNull().default(0),
    currentTurn: varchar("current_turn", { length: 10 })
      .notNull()
      .default("host"),
    winnerClerkId: varchar("winner_clerk_id", { length: 255 }),
    result: varchar("result", { length: 30 }),
    payout: numeric("payout", { precision: 10, scale: 2 }),
    moveDeadlineAt: timestamp("move_deadline_at"),
    timerSeconds: integer("timer_seconds").notNull().default(60),
    hostReplayDecision: varchar("host_replay_decision", { length: 10 }),
    guestReplayDecision: varchar("guest_replay_decision", { length: 10 }),
    replayDeadlineAt: timestamp("replay_deadline_at"),
    nextGameId: integer("next_game_id"),
    startedAt: timestamp("started_at"),
    endedAt: timestamp("ended_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    connectFourStatusIdx: index("connect_four_status_idx").on(
      table.status,
      table.createdAt,
    ),
    connectFourHostIdx: index("connect_four_host_idx").on(table.hostClerkId),
    connectFourGuestIdx: index("connect_four_guest_idx").on(table.guestClerkId),
  }),
);

export const diceFlushRooms = pgTable(
  "dice_flush_rooms",
  {
    id: varchar("id", { length: 120 }).primaryKey(),
    status: varchar("status", { length: 20 }).notNull(),
    wager: integer("wager").notNull(),
    pot: integer("pot").notNull(),
    gameState: jsonb("game_state").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => ({
    diceFlushRoomsStatusIdx: index("idx_dice_flush_rooms_status").on(table.status),
  }),
);

export const diceFlushPlayers = pgTable(
  "dice_flush_players",
  {
    id: serial("id").primaryKey(),
    roomId: varchar("room_id", { length: 120 }).references(() => diceFlushRooms.id),
    userId: varchar("user_id", { length: 255 }).notNull(),
    isAi: boolean("is_ai").default(false),
    score: integer("score").default(0),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => ({
    diceFlushPlayersRoomIdx: index("idx_dice_flush_players_room_id").on(table.roomId),
  }),
);

export const diceFlushActions = pgTable(
  "dice_flush_actions",
  {
    id: serial("id").primaryKey(),
    roomId: varchar("room_id", { length: 120 }),
    userId: varchar("user_id", { length: 255 }),
    actionType: varchar("action_type", { length: 40 }),
    payload: jsonb("payload"),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => ({
    diceFlushActionsRoomIdx: index("idx_dice_flush_actions_room_id").on(
      table.roomId,
      table.createdAt,
    ),
  }),
);

// FARKLE TABLES
export const farkleRooms = pgTable(
  "farkle_rooms",
  {
    id: varchar("id", { length: 120 }).primaryKey(),
    status: varchar("status", { length: 20 }).notNull(),
    wager: integer("wager").notNull(),
    pot: integer("pot").notNull(),
    gameState: jsonb("game_state").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => ({
    farkleRoomsStatusIdx: index("idx_farkle_rooms_status").on(table.status),
  }),
);

export const farklePlayers = pgTable(
  "farkle_players",
  {
    id: serial("id").primaryKey(),
    roomId: varchar("room_id", { length: 120 }).references(() => farkleRooms.id),
    userId: varchar("user_id", { length: 255 }).notNull(),
    isAi: boolean("is_ai").default(false),
    score: integer("score").default(0),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => ({
    farklePlayersRoomIdx: index("idx_farkle_players_room_id").on(table.roomId),
  }),
);

export const farkleActions = pgTable(
  "farkle_actions",
  {
    id: serial("id").primaryKey(),
    roomId: varchar("room_id", { length: 120 }),
    userId: varchar("user_id", { length: 255 }),
    actionType: varchar("action_type", { length: 40 }),
    payload: jsonb("payload"),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => ({
    farkleActionsRoomIdx: index("idx_farkle_actions_room_id").on(
      table.roomId,
      table.createdAt,
    ),
  }),
);

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
  laneRunnerGames: many(laneRunnerGames),
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

export const laneRunnerGamesRelations = relations(
  laneRunnerGames,
  ({ one }) => ({
    user: one(users, {
      fields: [laneRunnerGames.userId],
      references: [users.id],
    }),
  }),
);

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
export const sports = pgTable("sports", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 100 }).notNull(),
});

// EVENTS (matches)
export const events = pgTable("events", {
  id: serial("id").primaryKey(),
  sportId: integer("sport_id").notNull(),
  teamA: varchar("team_a", { length: 100 }).notNull(),
  teamB: varchar("team_b", { length: 100 }).notNull(),
  startTime: timestamp("start_time").notNull(),
  oddsA: numeric("odds_a", { precision: 5, scale: 2 }).notNull(),
  oddsB: numeric("odds_b", { precision: 5, scale: 2 }).notNull(),
  oddsDraw: numeric("odds_draw", { precision: 5, scale: 2 }), // optional
  status: varchar("status", { length: 20 }).default("upcoming"), // upcoming, closed, finished
});

// BETS (user's bets on events)
export const sportsBets = pgTable("sports_bets", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  eventId: integer("event_id"),
  eventExternalId: varchar("event_external_id", { length: 255 }),
  betAmount: numeric("bet_amount", { precision: 10, scale: 2 }).notNull(),
  choice: varchar("choice", { length: 100 }).notNull(),
  odds: numeric("odds", { precision: 5, scale: 2 }).notNull(),
  marketType: varchar("market_type", { length: 40 }),
  lineValue: numeric("line_value", { precision: 8, scale: 2 }),
  selectionMetadata: jsonb("selection_metadata").default(sql`'{}'::jsonb`),
  payout: numeric("payout", { precision: 10, scale: 2 }),
  result: varchar("result", { length: 20 }),
  placedAt: timestamp("placed_at").defaultNow(),
});

export const emailEvents = pgTable("email_events", {
  id: serial("id").primaryKey(),
  clerkId: varchar("clerk_id", { length: 255 }),
  userEmail: varchar("user_email", { length: 255 }).notNull(),
  type: varchar("type", { length: 80 }).notNull(),
  category: varchar("category", { length: 30 }).notNull().default("marketing"),
  dedupeKey: varchar("dedupe_key", { length: 255 }),
  status: varchar("status", { length: 20 }).notNull().default("sent"),
  meta: jsonb("meta"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const userAutomationState = pgTable("user_automation_state", {
  clerkId: varchar("clerk_id", { length: 255 }).primaryKey(),
  lastLoginAt: timestamp("last_login_at").notNull().defaultNow(),
  lastInactivityEmailSentAt: timestamp("last_inactivity_email_sent_at"),
  inactivityCycleStartAt: timestamp("inactivity_cycle_start_at")
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// BIG WINS FEED TABLE
export const hexDuelGames = pgTable(
  "hex_duel_games",
  {
    id: serial("id").primaryKey(),
    player1Id: varchar("player1_id", { length: 255 }).notNull(),
    player2Id: varchar("player2_id", { length: 255 }),
    wagerAmount: numeric("wager_amount", { precision: 10, scale: 2 }).notNull(),
    winner: varchar("winner", { length: 10 }).notNull(),
    result: varchar("result", { length: 10 }).notNull(),
    payout: numeric("payout", { precision: 10, scale: 2 }),
    isAiGame: boolean("is_ai_game").notNull().default(false),
    aiDifficulty: varchar("ai_difficulty", { length: 10 }),
    player1Moves: integer("player1_moves").notNull().default(0),
    player2Moves: integer("player2_moves").notNull().default(0),
    player1Territory: integer("player1_territory").notNull().default(1),
    player2Territory: integer("player2_territory").notNull().default(1),
    durationSeconds: integer("duration_seconds").notNull().default(0),
    status: varchar("status", { length: 20 }).notNull().default("completed"),
    isFunMode: boolean("is_fun_mode").notNull().default(false),
    startedAt: timestamp("started_at"),
    endedAt: timestamp("ended_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    player1Idx: index("hex_duel_player1_idx").on(table.player1Id, table.createdAt),
    createdIdx: index("hex_duel_created_idx").on(table.createdAt),
  }),
);

// Hex Duel action log — persisted record of every multiplayer action (like diceTurns)
export const hexDuelActions = pgTable(
  "hex_duel_actions",
  {
    id: serial("id").primaryKey(),
    gameId: integer("game_id")
      .notNull()
      .references(() => hexDuelGames.id, { onDelete: "cascade" }),
    userId: varchar("user_id", { length: 255 }).notNull(),
    actionType: varchar("action_type", { length: 20 }).notNull(),
    sourceKey: varchar("source_key", { length: 20 }),
    targetKey: varchar("target_key", { length: 20 }),
    troopCount: integer("troop_count"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    gameSeqIdx: index("hex_duel_actions_game_seq_idx").on(table.gameId, table.id),
  }),
);

// PRECISION TABLES — PvP "Precision" casino game (waiting → active → finished)
// Schema mirrors dice_matches / pool_matches / hex_duel_games conventions:
//   • clerkIds stored as varchar(255) without FK references to `users`
//     (matches every other PvP table in the project so existing scripts
//      and indexes remain compatible).
//   • `status` is varchar(20) instead of a pgEnum so it can be extended
//     without a destructive migration later.
export const precisionMatches = pgTable(
  "precision_matches",
  {
    id: serial("id").primaryKey(),
    player1Id: varchar("player1_id", { length: 255 }).notNull(),
    player2Id: varchar("player2_id", { length: 255 }),
    wager: numeric("wager", { precision: 10, scale: 2 }).notNull(),
    status: varchar("status", { length: 20 }).notNull().default("waiting"),
    winnerId: varchar("winner_id", { length: 255 }),
    currentRound: integer("current_round").notNull().default(1),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    // Per-project convention: open-lobby queries + per-player history.
    statusIdx: index("idx_precision_matches_status").on(
      table.status,
      table.createdAt,
    ),
    player1Idx: index("idx_precision_matches_player1").on(
      table.player1Id,
      table.createdAt,
    ),
    player2Idx: index("idx_precision_matches_player2").on(
      table.player2Id,
      table.createdAt,
    ),
  }),
);

// One row per round of a Precision match. Cascade deleting with the
// parent match keeps history tidy when a match is purged. Per-round
// `winnerId` is nullable so rounds in progress still persist cleanly.
export const precisionRounds = pgTable(
  "precision_rounds",
  {
    id: serial("id").primaryKey(),
    matchId: integer("match_id")
      .notNull()
      .references(() => precisionMatches.id, { onDelete: "cascade" }),
    roundNumber: integer("round_number").notNull(),
    targetMilliseconds: integer("target_milliseconds").notNull(),
    startTimestamp: timestamp("start_timestamp").notNull(),
    player1StopTimestamp: timestamp("player1_stop_timestamp"),
    player2StopTimestamp: timestamp("player2_stop_timestamp"),
    player1Difference: integer("player1_difference"),
    player2Difference: integer("player2_difference"),
    winnerId: varchar("winner_id", { length: 255 }),
  },
  (table) => ({
    // Lookup is always ("all rounds of match X in order") so a
    // composite index on (match_id, round_number) is the right shape.
    matchRoundIdx: index("idx_precision_rounds_match_round").on(
      table.matchId,
      table.roundNumber,
    ),
  }),
);

// Precision relations — declared here (after the tables) so the symbols
// are bound before `relations(...)` runs. Drizzle relations are read at
// query time, not module-load, so the position is purely about lexical
// ordering for the TS compiler.
export const precisionMatchesRelations = relations(
  precisionMatches,
  ({ many }) => ({
    rounds: many(precisionRounds),
  }),
);

export const precisionRoundsRelations = relations(precisionRounds, ({ one }) => ({
  match: one(precisionMatches, {
    fields: [precisionRounds.matchId],
    references: [precisionMatches.id],
  }),
}));

// ADMIN AUDIT LOGS — persisted record of all admin actions
export const adminAuditLogs = pgTable(
  "admin_audit_logs",
  {
    id: serial("id").primaryKey(),
    event: varchar("event", { length: 100 }).notNull(),
    clerkId: varchar("clerk_id", { length: 255 }).notNull(),
    targetClerkId: varchar("target_clerk_id", { length: 255 }),
    details: jsonb("details").default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    adminAuditEventIdx: index("idx_admin_audit_event").on(table.event, table.createdAt),
    adminAuditClerkIdx: index("idx_admin_audit_clerk").on(table.clerkId, table.createdAt),
  }),
);

// PLAYER REPORTS — user-to-user reporting system for PVP games
export const playerReports = pgTable(
  "player_reports",
  {
    id: serial("id").primaryKey(),
    reporterClerkId: varchar("reporter_clerk_id", { length: 255 }).notNull(),
    reportedClerkId: varchar("reported_clerk_id", { length: 255 }).notNull(),
    gameType: varchar("game_type", { length: 50 }).notNull(),
    gameId: varchar("game_id", { length: 100 }),
    reason: varchar("reason", { length: 50 }).notNull(),
    details: text("details"),
    status: varchar("status", { length: 20 }).notNull().default("pending"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at"),
    resolvedByClerkId: varchar("resolved_by_clerk_id", { length: 255 }),
  },
  (table) => ({
    statusIdx: index("idx_player_reports_status").on(table.status, table.createdAt),
    reportedIdx: index("idx_player_reports_reported").on(table.reportedClerkId),
  }),
);

export const bigWins = pgTable(
  "big_wins",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull(),
    username: text("username").notNull(),
    game: text("game").notNull(),
    betAmount: integer("bet_amount").notNull(),
    winAmount: integer("win_amount").notNull(),
    multiplier: numeric("multiplier", { precision: 10, scale: 4 }).notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    createdAtIdx: index("idx_big_wins_created_at").on(table.createdAt),
    multiplierIdx: index("idx_big_wins_multiplier").on(table.multiplier),
  }),
);

// ODDS GAME TABLE
export const oddsGames = pgTable(
  "odds_games",
  {
    id: serial("id").primaryKey(),
    player1Id: varchar("player1_id", { length: 255 }).notNull(),
    player2Id: varchar("player2_id", { length: 255 }),
    wager: integer("wager").notNull(),
    status: varchar("status", { length: 20 }).notNull().default("waiting"),
    winner: varchar("winner", { length: 10 }),
    result: varchar("result", { length: 15 }),
    payout: integer("payout"),
    isAi: boolean("is_ai").notNull().default(false),
    gameState: jsonb("game_state"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    endedAt: timestamp("ended_at"),
  },
  (table) => ({
    statusIdx: index("idx_odds_games_status").on(table.status, table.createdAt),
    player1Idx: index("idx_odds_games_player1").on(table.player1Id),
  }),
);

// PROGRESSIVE SLOT JACKPOT — one row per theme
// Grows with every spin (2% contribution). Resets to seed after a 5-match win.
export const slotJackpots = pgTable("slot_jackpots", {
  theme: varchar("theme", { length: 30 }).primaryKey(),
  amount: numeric("amount", { precision: 14, scale: 2 }).notNull().default("1000.00"),
  seedAmount: numeric("seed_amount", { precision: 14, scale: 2 }).notNull().default("1000.00"),
  contributionRate: numeric("contribution_rate", { precision: 5, scale: 4 }).notNull().default("0.0200"),
  totalContributed: numeric("total_contributed", { precision: 14, scale: 2 }).notNull().default("0.00"),
  timesWon: integer("times_won").notNull().default(0),
  lastWonBy: varchar("last_won_by", { length: 255 }),
  lastWonAmount: numeric("last_won_amount", { precision: 14, scale: 2 }),
  lastWonAt: timestamp("last_won_at"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// CLICKER GAME TABLE (GoonBet Clicker history)
export const clickerGames = pgTable(
  "clicker_games",
  {
    id: serial("id").primaryKey(),
    userId: varchar("user_id", { length: 255 }).notNull(),
    betAmount: integer("bet_amount").notNull(),
    payout: integer("payout").notNull(),
    multiplier: numeric("multiplier", { precision: 10, scale: 4 }).notNull(),
    busted: boolean("busted").notNull().default(false),
    clicks: integer("clicks").notNull().default(0),
    durationMs: integer("duration_ms").notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    userIdIdx: index("idx_clicker_games_user_id").on(table.userId, table.createdAt),
  }),
);

// ROULETTE PvP MATCHES — server-authoritative two-player roulette
// Match flow:
//   waiting → ready → round_1 → round_2 → round_3 → sudden_death → finished
//
// Win rule per round (single shared spin):
//   Both players start the match with `starting_points` (default 100).
//   Points PERSIST across rounds: each round's net = (payout − total_bet)
//   is debited/credited directly from/to the player's match balance.
//   Players may only bet up to their current match balance, never reset
//   to `starting_points` between rounds. The same spin result is used
//   for both players' bets. The player with the higher net wins the
//   round (DRAW on identical net result). After 3 rounds with a tied
//   round-win score, match → sudden_death; otherwise → finished.
//
// Per-round detail (bets placed, spin result, payouts, draw flag) lives
// on `roulette_pvp_rounds` so the full match history is replayable.
export const roulettePvpStatusEnum = pgEnum("roulette_pvp_status", [
  "waiting",
  "ready",
  "round_1",
  "round_2",
  "round_3",
  "sudden_death",
  "finished",
  "cancelled",
]);

export const roulettePvpMatches = pgTable(
  "roulette_pvp_matches",
  {
    id: serial("id").primaryKey(),
    player1Id: varchar("player1_id", { length: 255 }).notNull(),
    player2Id: varchar("player2_id", { length: 255 }),
    stakeAmount: numeric("stake_amount", { precision: 10, scale: 2 }).notNull(),
    status: roulettePvpStatusEnum("status").notNull().default("waiting"),
    currentRound: integer("current_round").notNull().default(1),
    // Round wins (best of 3 + sudden death). Each round contributes 0
    // (draw), +1 to player1, or +1 to player2.
    scorePlayer1: integer("score_player1").notNull().default(0),
    scorePlayer2: integer("score_player2").notNull().default(0),
    // Per-round transient state (cleared between rounds). bet_deadline
    // enforces a server-side timer so a disconnected player can be
    // auto-treated as having submitted empty bets.
    roundDeadline: timestamp("round_deadline"),
    // Latest spin primitives — exposed via /status so both clients can
    // render the same wheel animation in sync without each having to
    // roll its own random number.
    lastSpinResultIndex: integer("last_spin_result_index"),
    lastSpinResult: integer("last_spin_result"),
    // Final match bookkeeping.
    winnerId: varchar("winner_id", { length: 255 }),
    result: varchar("result", { length: 20 }), // 'player1' | 'player2' | 'draw' | null
    houseFee: numeric("house_fee", { precision: 10, scale: 2 })
      .notNull()
      .default("0.00"),
    prizePaid: numeric("prize_paid", { precision: 10, scale: 2 })
      .notNull()
      .default("0.00"),
    // ── Persistent match "points" balance ─────────────────────────
    // Each player starts the match with `starting_points` (default
    // 100) and that balance PERSISTS across rounds — bets debit it,
    // spin payouts credit it. No inter-round reset.
    startingPoints: numeric("starting_points", {
      precision: 10,
      scale: 2,
    })
      .notNull()
      .default("100.00"),
    playerOnePoints: numeric("player_one_points", {
      precision: 10,
      scale: 2,
    })
      .notNull()
      .default("100.00"),
    playerTwoPoints: numeric("player_two_points", {
      precision: 10,
      scale: 2,
    })
      .notNull()
      .default("100.00"),
    // Round-deadline countdown duration in seconds. Match-flow
    // constant: the per-round `round_deadline` timestamp is computed
    // as `now() + round_timer_seconds` whenever a new betting window
    // opens. Surfaced as a column so future admin tooling can tweak
    // a match's pacing without changing code.
    roundTimerSeconds: integer("round_timer_seconds")
      .notNull()
      .default(25),
    // Match-level sudden-death flag (mirrors the per-round
    // `is_sudden_death` on roulette_pvp_rounds so admin / status
    // queries don't have to walk child rows).
    suddenDeath: boolean("sudden_death").notNull().default(false),
    startedAt: timestamp("started_at"),
    endedAt: timestamp("ended_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    // Lobby listing — `status='waiting'` AND player2_id IS NULL.
    statusIdx: index("roulette_pvp_status_idx").on(
      table.status,
      table.createdAt,
    ),
    player1Idx: index("roulette_pvp_player1_idx").on(
      table.player1Id,
      table.createdAt,
    ),
    player2Idx: index("roulette_pvp_player2_idx").on(
      table.player2Id,
      table.createdAt,
    ),
    // Stake matchmaking — finding a waiting lobby whose stake matches
    // the joiner's request. `stake` + `status='waiting'` + player2 null
    // is the canonical query for "join any open match of this stake".
    stakeIdx: index("roulette_pvp_stake_open_idx").on(
      table.stakeAmount,
      table.status,
    ),
  }),
);

// One row per round of a Roulette PvP match. Cascade-deleted with the
// parent match so history stays tidy. Per-round winner is nullable
// because rounds that end in a draw leave it null.
export const roulettePvpRounds = pgTable(
  "roulette_pvp_rounds",
  {
    id: serial("id").primaryKey(),
    matchId: integer("match_id")
      .notNull()
      .references(() => roulettePvpMatches.id, { onDelete: "cascade" }),
    roundNumber: integer("round_number").notNull(),
    isSuddenDeath: boolean("is_sudden_death").notNull().default(false),
    spinResultIndex: integer("spin_result_index").notNull(),
    spinResult: integer("spin_result").notNull(),
    player1Bets: jsonb("player1_bets").notNull().default(sql`'{}'::jsonb`),
    player2Bets: jsonb("player2_bets").notNull().default(sql`'{}'::jsonb`),
    player1TotalBet: numeric("player1_total_bet", {
      precision: 10,
      scale: 2,
    })
      .notNull()
      .default("0.00"),
    player2TotalBet: numeric("player2_total_bet", {
      precision: 10,
      scale: 2,
    })
      .notNull()
      .default("0.00"),
    player1Payout: numeric("player1_payout", { precision: 10, scale: 2 })
      .notNull()
      .default("0.00"),
    player2Payout: numeric("player2_payout", { precision: 10, scale: 2 })
      .notNull()
      .default("0.00"),
    // net = payout − total_bet. Persisted for fast round-resolution
    // queries (the live match state is in roulette_pvp_matches but
    // history is in this table).
    player1Net: numeric("player1_net", { precision: 10, scale: 2 })
      .notNull()
      .default("0.00"),
    player2Net: numeric("player2_net", { precision: 10, scale: 2 })
      .notNull()
      .default("0.00"),
    // Round winner — null when the round ended in a draw (identical
    // net result for both players).
    roundWinner: varchar("round_winner", { length: 10 }), // 'player1' | 'player2' | null
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    matchRoundIdx: index("roulette_pvp_rounds_match_round_idx").on(
      table.matchId,
      table.roundNumber,
    ),
  }),
);

export const roulettePvpMatchesRelations = relations(
  roulettePvpMatches,
  ({ many }) => ({
    rounds: many(roulettePvpRounds),
  }),
);

export const roulettePvpRoundsRelations = relations(
  roulettePvpRounds,
  ({ one }) => ({
    match: one(roulettePvpMatches, {
      fields: [roulettePvpRounds.matchId],
      references: [roulettePvpMatches.id],
    }),
  }),
);

// DOTS & BOXES PvP GAME TABLE
export const dotsAndBoxesGames = pgTable(
  "dots_and_boxes_games",
  {
    id: serial("id").primaryKey(),
    hostClerkId: varchar("host_clerk_id", { length: 255 }).notNull(),
    guestClerkId: varchar("guest_clerk_id", { length: 255 }),
    betAmount: numeric("bet_amount", { precision: 10, scale: 2 }).notNull(),
    status: varchar("status", { length: 30 }).notNull().default("waiting"),
    gameState: jsonb("game_state").default(sql`'{}'::jsonb`),
    winnerClerkId: varchar("winner_clerk_id", { length: 255 }),
    result: varchar("result", { length: 30 }),
    payout: numeric("payout", { precision: 10, scale: 2 }),
    moveDeadlineAt: timestamp("move_deadline_at"),
    timerSeconds: integer("timer_seconds").notNull().default(20),
    startedAt: timestamp("started_at"),
    endedAt: timestamp("ended_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    dotsStatusIdx: index("dots_and_boxes_status_idx").on(
      table.status,
      table.createdAt,
    ),
    dotsHostIdx: index("dots_and_boxes_host_idx").on(table.hostClerkId),
    dotsGuestIdx: index("dots_and_boxes_guest_idx").on(table.guestClerkId),
  }),
);

// BLACKJACK PvP MATCHES — server-authoritative Best-of-3 simultaneous
// blackjack between two real players (no dealer).
//
// Match flow:
//   waiting → ready → round_1 → round_2 → round_3 → finished
//
// Per-round flow:
//   Both players are dealt 2 starting cards from `deck`.
//   The 2-card deal is also snapshotted to `player1OriginalCards` /
//   `player2OriginalCards` so the round-end reveal + post-match
//   replay can show what was dealt independent of any later SWAP
//   that corrupted the live `player1Hand` / `player2Hand`.
//   Each player independently hits / stands. A round resolves when
//   BOTH players have reached a terminal per-round state (`stood` or
//   `busted`). When `round_deadline` elapses, any player still in
//   `playing` is force-marked `stood` so the round can resolve.
//
// Round winner: closer to 21 without busting. Both bust → draw.
// Match winner: first to rounds_won_player = 2; otherwise decided by
// round_3. Tied after round_3 → match result is `draw` (full refund).
//
// Hands are kept hidden from the opponent during the round —
// `player1Hand` / `player2Hand` are stored server-side in their
// real form on the match row, but the match state API scrubs the
// opponent's hand before returning it to the requesting seat.
//
// `player1Standing` / `player2Standing` are NOT columns — they are
// computed on read by the API route as `player{N}_state !== 'playing'`.
// Storing them as a denormalized boolean would introduce split-brain
// risk with the `player_state` enum.
export const blackjackPvpStatusEnum = pgEnum("blackjack_pvp_status", [
  "waiting",
  "ready",
  "round_1",
  "round_2",
  "round_3",
  "between_rounds",
  "finished",
  "cancelled",
]);

export const blackjackPvpPlayerStateEnum = pgEnum(
  "blackjack_pvp_player_state",
  ["playing", "stood", "busted"],
);

export const blackjackPvpMatches = pgTable(
  "blackjack_pvp_matches",
  {
    id: serial("id").primaryKey(),
    player1Id: varchar("player1_id", { length: 255 }).notNull(),
    player2Id: varchar("player2_id", { length: 255 }),
    stakeAmount: numeric("stake_amount", { precision: 10, scale: 2 }).notNull(),
    status: blackjackPvpStatusEnum("status").notNull().default("waiting"),
    roundNumber: integer("round_number").notNull().default(1),
    roundsWonPlayer1: integer("rounds_won_player1").notNull().default(0),
    roundsWonPlayer2: integer("rounds_won_player2").notNull().default(0),
    // Live per-round transient state — both hands stored server-side
    // in JSONB. The match state route scrubs the OPPONENT's hand
    // before returning so cards stay hidden until the round resolves.
    player1Hand: jsonb("player1_hand").notNull().default(sql`'[]'::jsonb`),
    player2Hand: jsonb("player2_hand").notNull().default(sql`'[]'::jsonb`),
    // ── Original 2-card deal snapshot. Stamped the moment cards are
    // dealt (ready → round_1, between_rounds → round_(N+1)). NOT
    // updated by SWAP because a swap modifies the LIVE hand but the
    // originals stay fixed per spec. Mirrored onto rounds history
    // for post-match replays. ────────────────────────────────────────
    player1OriginalCards: jsonb("player1_original_cards")
      .notNull()
      .default(sql`'[]'::jsonb`),
    player2OriginalCards: jsonb("player2_original_cards")
      .notNull()
      .default(sql`'[]'::jsonb`),
    // Per-seat round action state.
    player1State: blackjackPvpPlayerStateEnum("player1_state")
      .notNull()
      .default("playing"),
    player2State: blackjackPvpPlayerStateEnum("player2_state")
      .notNull()
      .default("playing"),
    // Server-authoritative shoe. `deck[0]` is the next available card.
    deck: jsonb("deck").notNull().default(sql`'[]'::jsonb`),
    // ── Swap + Freeze (1 use per round, per seat) ──────────────────
    // The Swap action targets one of the hand's TWO ORIGINAL starting
    // cards (always at indices 0 and 1 because Hit pushes to the end).
    // The Freeze action stores the most-recently drawn card into the
    // side-slot below; Use Frozen Card resolves it to 'add' or
    // 'discard'.
    // ALL of these columns are SERVER-ONLY state — the GET match
    // route SCRUBS the opponent's columns before returning so neither
    // side ever sees the other's swaps / freezes / frozen card.
    // Column types remain integer for forward compatibility with a
    // hypothetical future cap > 1 (SWAP_LIMIT_PER_ROUND == 1 today).
    player1UsedSwap: integer("player1_used_swap").notNull().default(0),
    player2UsedSwap: integer("player2_used_swap").notNull().default(0),
    player1UsedFreeze: integer("player1_used_freeze").notNull().default(0),
    player2UsedFreeze: integer("player2_used_freeze").notNull().default(0),
    player1FrozenCard: jsonb("player1_frozen_card").default(sql`NULL`),
    player2FrozenCard: jsonb("player2_frozen_card").default(sql`NULL`),
    player1HeldResolved: varchar("player1_held_resolved", { length: 10 })
      .default(sql`NULL`),
    player2HeldResolved: varchar("player2_held_resolved", { length: 10 })
      .default(sql`NULL`),
    roundDeadline: timestamp("round_deadline"),
    // Final match bookkeeping. `winner` stores the userId of the
    // winning player (replaces the pre-refactor `winner_id`). The
    // side identifier "player1" | "player2" | "draw" continues to
    // live on `result`.
    winner: varchar("winner", { length: 255 }),
    result: varchar("result", { length: 20 }), // 'player1' | 'player2' | 'draw' | null
    houseFee: numeric("house_fee", { precision: 10, scale: 2 })
      .notNull()
      .default("0.00"),
    prizePaid: numeric("prize_paid", { precision: 10, scale: 2 })
      .notNull()
      .default("0.00"),
    // Per-round turn-window duration in seconds (mirrors
    // roulette-pvp's `round_timer_seconds`). Match-flow constant:
    // `round_deadline` is computed as `now() + round_timer_seconds`
    // whenever a new betting window opens. Surfaced as a column so
    // future admin tooling can tweak a match's pacing without code.
    roundTimerSeconds: integer("round_timer_seconds")
      .notNull()
      .default(20),
    startedAt: timestamp("started_at"),
    endedAt: timestamp("ended_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    // Lobby listing — `status='waiting'` AND player2_id IS NULL.
    statusIdx: index("blackjack_pvp_status_idx").on(
      table.status,
      table.createdAt,
    ),
    player1Idx: index("blackjack_pvp_player1_idx").on(
      table.player1Id,
      table.createdAt,
    ),
    player2Idx: index("blackjack_pvp_player2_idx").on(
      table.player2Id,
      table.createdAt,
    ),
    // Stake matchmaking — finding a waiting lobby whose stake matches
    // the joiner's request.
    stakeIdx: index("blackjack_pvp_stake_open_idx").on(
      table.stakeAmount,
      table.status,
    ),
  }),
);

// Per-round final snapshots for replay/history. Cascades from the
// parent match. round_winner is null when the round ended in a draw.
//
// Player1Standing / Player2Standing are computed from the per-round
// `player1State` / `player2State` enum columns above (they live on
// every rows so post-match replays can render them without rejoin).
// The standing boolean is intentionally NOT a column.
export const blackjackPvpRounds = pgTable(
  "blackjack_pvp_rounds",
  {
    id: serial("id").primaryKey(),
    matchId: integer("match_id")
      .notNull()
      .references(() => blackjackPvpMatches.id, { onDelete: "cascade" }),
    roundNumber: integer("round_number").notNull(),
    player1Hand: jsonb("player1_hand").notNull().default(sql`'[]'::jsonb`),
    player2Hand: jsonb("player2_hand").notNull().default(sql`'[]'::jsonb`),
    // Hand value as scored by `calcHandValue`; -1 for busted hands so a
    // busted hand always loses to a non-busted hand regardless of score.
    player1Score: integer("player1_score").notNull(),
    player2Score: integer("player2_score").notNull(),
    player1State: blackjackPvpPlayerStateEnum("player1_state").notNull(),
    player2State: blackjackPvpPlayerStateEnum("player2_state").notNull(),
    // ── Round-start deal snapshot mirrored onto history rows so
    // post-match replays can show what was dealt, even after a SWAP
    // corrupted the live hand. ──────────────────────────────────────
    player1OriginalCards: jsonb("player1_original_cards")
      .notNull()
      .default(sql`'[]'::jsonb`),
    player2OriginalCards: jsonb("player2_original_cards")
      .notNull()
      .default(sql`'[]'::jsonb`),
    // ── Snapshot of the Swap/Freeze usage + frozen-card at the
    // moment the round resolved — used for post-match history
    // replay. NOT scrubbed on join: history rows are public so
    // replays can show actions truthfully. ──────────────────────────
    player1UsedSwap: integer("player1_used_swap").notNull().default(0),
    player2UsedSwap: integer("player2_used_swap").notNull().default(0),
    player1UsedFreeze: integer("player1_used_freeze").notNull().default(0),
    player2UsedFreeze: integer("player2_used_freeze").notNull().default(0),
    player1FrozenCard: jsonb("player1_frozen_card").default(sql`NULL`),
    player2FrozenCard: jsonb("player2_frozen_card").default(sql`NULL`),
    player1HeldResolved: varchar("player1_held_resolved", { length: 10 })
      .default(sql`NULL`),
    player2HeldResolved: varchar("player2_held_resolved", { length: 10 })
      .default(sql`NULL`),
    // 'player1' | 'player2' | 'draw' | null
    roundWinner: varchar("round_winner", { length: 10 }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    matchRoundIdx: index("blackjack_pvp_rounds_match_round_idx").on(
      table.matchId,
      table.roundNumber,
    ),
  }),
);

export const blackjackPvpMatchesRelations = relations(
  blackjackPvpMatches,
  ({ many }) => ({
    rounds: many(blackjackPvpRounds),
  }),
);

export const blackjackPvpRoundsRelations = relations(
  blackjackPvpRounds,
  ({ one }) => ({
    match: one(blackjackPvpMatches, {
      fields: [blackjackPvpRounds.matchId],
      references: [blackjackPvpMatches.id],
    }),
  }),
);
