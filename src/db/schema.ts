// src/db/schema.ts
import { pgTable, serial, varchar, integer, numeric, timestamp, jsonb, text, json, boolean, date, pgEnum, index, uuid, bigint} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";

// USERS TABLE
export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  clerkId: varchar('clerk_id', { length: 255 }).notNull().unique(),
  name: varchar('name', { length: 255 }).notNull(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  profilePicture: text('profile_picture'),
  password: varchar('password', { length: 255 }).notNull(),
  age: integer('age'),
  balance: numeric('balance', { precision: 30, scale: 2 }).default('1000.00').notNull(),
  gamesWon: integer('games_won').default(0),
  gamesLost: integer('games_lost').default(0),
  referralCode: varchar('referral_code', { length: 30 }).unique(),
  referredById: integer('referred_by_id'),
  referralCount: integer('referral_count').default(0).notNull(),
  referralEarnings: numeric('referral_earnings', { precision: 10, scale: 2 }).default('0.00').notNull(),
  totalWagered: numeric('total_wagered', { precision: 14, scale: 2 }).default('0.00').notNull(),
  level: integer('level').default(1).notNull(),
  selectedTitle: text('selected_title').default(null),
  highestTitle: text('highest_title').default(null),
  selectedSpecialTitle: text('selected_special_title').default(null),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  searchName: varchar('search_name', { length: 255 }),
});

export const friendRelations = pgTable('friend_relations', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  friendId: integer('friend_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (table) => ({
  uniqueFriendship: index('friend_relations_user_friend_idx').on(table.userId, table.friendId),
}));

export const userGamePresence = pgTable('user_game_presence', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  gameKey: varchar('game_key', { length: 80 }).notNull(),
  gameId: integer('game_id'),
  lastSeenAt: timestamp('last_seen_at').notNull().defaultNow(),
}, (table) => ({
  userGameIdx: index('user_game_presence_user_game_idx').on(table.userId, table.gameKey),
}));


export const presenceStatusEnum = pgEnum('presence_status', ['online', 'in_game', 'offline']);

export const userPresence = pgTable('user_presence', {
  clerkId: varchar('clerk_id', { length: 255 }).primaryKey(),
  lastSeen: timestamp('last_seen').notNull().defaultNow(),
  status: presenceStatusEnum('status').notNull().default('offline'),
  currentGameId: varchar('current_game_id', { length: 255 }),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => ({
  statusSeenIdx: index('user_presence_status_seen_idx').on(table.status, table.lastSeen),
}));

export const userLoginRewards = pgTable("user_login_rewards", {
  userId: integer("user_id").primaryKey().references(() => users.id), // INT to match users.id
  currentDay: integer("current_day").default(1),
  lastClaimedDate: date("last_claimed_date").default(null),
});



export const specialTitles = pgTable('special_titles', {
  id: serial('id').primaryKey(),
  key: varchar('key', { length: 120 }).notNull().unique(),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description').notNull(),
  rarity: varchar('rarity', { length: 40 }).notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const userSpecialTitles = pgTable('user_special_titles', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  titleKey: varchar('title_key', { length: 120 }).notNull(),
  unlockedAt: timestamp('unlocked_at').notNull().defaultNow(),
}, (table) => ({
  uniqUserTitle: index('user_special_titles_user_title_idx').on(table.userId, table.titleKey),
}));

export const userSecretStats = pgTable('user_secret_stats', {
  userId: integer('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  chatMessagesCount: integer('chat_messages_count').notNull().default(0),
  goonbetMentions: integer('goonbet_mentions').notNull().default(0),
  allInPhraseMentions: integer('all_in_phrase_mentions').notNull().default(0),
  gamesPlayed: integer('games_played').notNull().default(0),
  winStreak: integer('win_streak').notNull().default(0),
  lossStreak: integer('loss_streak').notNull().default(0),
  allInCount: integer('all_in_count').notNull().default(0),
  allInLossStreak: integer('all_in_loss_streak').notNull().default(0),
  jackpotsWon: integer('jackpots_won').notNull().default(0),
  lastKnownBalance: numeric('last_known_balance', { precision: 14, scale: 2 }).notNull().default('0.00'),
  dayStartBalance: numeric('day_start_balance', { precision: 14, scale: 2 }).notNull().default('0.00'),
  dayKey: varchar('day_key', { length: 10 }),
  loginDays: integer('login_days').notNull().default(0),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});


export const chatRoomTypeEnum = pgEnum('chat_room_type', ['global', 'game']);

export const chatMessages = pgTable('chat_messages', {
  id: serial('id').primaryKey(),
  roomType: chatRoomTypeEnum('room_type').notNull().default('global'),
  roomId: varchar('room_id', { length: 255 }).notNull(),
  clerkId: varchar('clerk_id', { length: 255 }).notNull(),
  displayName: varchar('display_name', { length: 255 }).notNull(),
  profileImageUrl: text('profile_image_url'),
  content: text('content').notNull(),
  isDeleted: boolean('is_deleted').notNull().default(false),
  deletedAt: timestamp('deleted_at'),
  deletedByClerkId: varchar('deleted_by_clerk_id', { length: 255 }),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (table) => ({
  roomIdx: index('chat_messages_room_idx').on(table.roomType, table.roomId, table.createdAt),
  moderationIdx: index('chat_messages_moderation_idx').on(table.isDeleted, table.createdAt),
}));

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


export const laneRunnerGames = pgTable('lane_runner_games', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').notNull(),
  betAmount: numeric('bet_amount', { precision: 10, scale: 2 }).notNull(),
  payout: numeric('payout', { precision: 10, scale: 2 }).notNull().default('0.00'),
  result: varchar('result', { length: 20 }).notNull().default('pending'),
  difficulty: varchar('difficulty', { length: 20 }).notNull(),
  currentLane: integer('current_lane').notNull().default(0),
  multiplier: numeric('multiplier', { precision: 12, scale: 4 }).notNull().default('1.0000'),
  clientSeed: varchar('client_seed', { length: 255 }).notNull(),
  serverSeedHash: varchar('server_seed_hash', { length: 255 }).notNull(),
  serverSeed: varchar('server_seed', { length: 255 }),
  nonce: varchar('nonce', { length: 255 }).notNull(),
  outcomeSequence: jsonb('outcome_sequence').notNull(),
  status: varchar('status', { length: 20 }).notNull().default('completed'),
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
  timerMode: varchar('timer_mode', { length: 20 }).notNull().default('blitz'),
  initialTimeSeconds: integer('initial_time_seconds').notNull().default(300),
  winnerId: varchar('winner_id', { length: 255 }), // Clerk ID or null if no result yet
  result: varchar('result', { length: 20 }),       // win, loss, draw
  payout: numeric('payout', { precision: 10, scale: 2 }),
  status: text("status").notNull().default("waiting"),
  isAiGame: boolean('is_ai_game').default(false).notNull(), // ✅ new column
  startedAt: timestamp('started_at'),
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
  lobbyId: uuid("lobby_id").references(() => diceLobbies.id, { onDelete: "cascade" }),
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
  matchId: uuid("match_id").notNull().references(() => diceMatches.id, { onDelete: "cascade" }),
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
  totalWagered: bigint("total_wagered", { mode: "number" }).notNull().default(0),
  totalWon: bigint("total_won", { mode: "number" }).notNull().default(0),
  highestWin: integer("highest_win").notNull().default(0),
  currentStreak: integer("current_streak").notNull().default(0),
  bestStreak: integer("best_streak").notNull().default(0),
});


// Legacy exports kept to prevent build/runtime import failures while Tanks routes are deprecated.
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
  currentPlayers: integer("current_players").notNull().default(1),
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


export const connectFourGames = pgTable("connect_four_games", {
  id: serial("id").primaryKey(),
  hostClerkId: varchar("host_clerk_id", { length: 255 }).notNull(),
  guestClerkId: varchar("guest_clerk_id", { length: 255 }),
  betAmount: numeric("bet_amount", { precision: 10, scale: 2 }).notNull(),
  status: varchar("status", { length: 30 }).notNull().default("waiting"),
  board: jsonb("board").notNull().default(sql`'[[0,0,0,0,0,0,0],[0,0,0,0,0,0,0],[0,0,0,0,0,0,0],[0,0,0,0,0,0,0],[0,0,0,0,0,0,0],[0,0,0,0,0,0,0]]'::jsonb`),
  hostDiscsUsed: integer("host_discs_used").notNull().default(0),
  guestDiscsUsed: integer("guest_discs_used").notNull().default(0),
  currentTurn: varchar("current_turn", { length: 10 }).notNull().default("host"),
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
}, (table) => ({
  connectFourStatusIdx: index("connect_four_status_idx").on(table.status, table.createdAt),
  connectFourHostIdx: index("connect_four_host_idx").on(table.hostClerkId),
  connectFourGuestIdx: index("connect_four_guest_idx").on(table.guestClerkId),
}));

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


export const laneRunnerGamesRelations = relations(laneRunnerGames, ({ one }) => ({
  user: one(users, {
    fields: [laneRunnerGames.userId],
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
  eventId: integer('event_id'),
  eventExternalId: varchar('event_external_id', { length: 255 }),
  betAmount: numeric('bet_amount', { precision: 10, scale: 2 }).notNull(),
  choice: varchar('choice', { length: 100 }).notNull(),
  odds: numeric('odds', { precision: 5, scale: 2 }).notNull(),
  marketType: varchar('market_type', { length: 40 }),
  lineValue: numeric('line_value', { precision: 8, scale: 2 }),
  selectionMetadata: jsonb('selection_metadata').default(sql`'{}'::jsonb`),
  payout: numeric('payout', { precision: 10, scale: 2 }),
  result: varchar('result', { length: 20 }),
  placedAt: timestamp('placed_at').defaultNow(),
});

export const emailEvents = pgTable('email_events', {
  id: serial('id').primaryKey(),
  clerkId: varchar('clerk_id', { length: 255 }),
  userEmail: varchar('user_email', { length: 255 }).notNull(),
  type: varchar('type', { length: 80 }).notNull(),
  category: varchar('category', { length: 30 }).notNull().default('marketing'),
  dedupeKey: varchar('dedupe_key', { length: 255 }),
  status: varchar('status', { length: 20 }).notNull().default('sent'),
  meta: jsonb('meta'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const userAutomationState = pgTable('user_automation_state', {
  clerkId: varchar('clerk_id', { length: 255 }).primaryKey(),
  lastLoginAt: timestamp('last_login_at').notNull().defaultNow(),
  lastInactivityEmailSentAt: timestamp('last_inactivity_email_sent_at'),
  inactivityCycleStartAt: timestamp('inactivity_cycle_start_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});
