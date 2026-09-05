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
  primaryKey,
  unique,
} from "drizzle-orm/pg-core";
import { relations, sql, desc } from "drizzle-orm";

// CANONICAL MATCH LIFECYCLE — platform-wide queue and match state.
// This is intentionally independent from game-specific match tables so those
// flows can migrate incrementally without changing their existing schemas.
export const matchLifecycle = pgTable(
  "match_lifecycle",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    matchId: varchar("match_id", { length: 255 }).notNull().unique(),
    gameKey: varchar("game_key", { length: 80 }).notNull(),
    mode: varchar("mode", { length: 80 }).notNull(),
    status: varchar("status", { length: 20 }).notNull().default("queued"),
    queuedAt: timestamp("queued_at").notNull().defaultNow(),
    startedAt: timestamp("started_at"),
    endedAt: timestamp("ended_at"),
    cancelReason: varchar("cancel_reason", { length: 40 }),
    playerCount: integer("player_count").notNull().default(0),
    queueWaitMs: integer("queue_wait_ms"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    statusQueueIdx: index("match_lifecycle_status_queue_idx").on(table.status, table.queuedAt),
    gameModeIdx: index("match_lifecycle_game_mode_idx").on(table.gameKey, table.mode, table.status),
  })
);

// APP SETTINGS — simple key/value store for runtime-toggleable platform
// flags (e.g. maintenance_mode). Kept tiny on purpose; not for user data.
export const matchLifecycleEvents = pgTable(
  "match_lifecycle_events",
  {
    eventId: uuid("event_id").primaryKey(),
    matchId: varchar("match_id", { length: 255 }).notNull(),
    eventType: varchar("event_type", { length: 40 }).notNull(),
    payload: jsonb("payload").notNull(),
    occurredAt: timestamp("occurred_at").notNull().defaultNow(),
    publishedAt: timestamp("published_at"),
    attempts: integer("attempts").notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    unpublishedIdx: index("match_lifecycle_events_unpublished_idx").on(
      table.publishedAt,
      table.createdAt
    ),
    matchIdx: index("match_lifecycle_events_match_idx").on(table.matchId, table.createdAt),
  })
);

export const availabilityAlerts = pgTable(
  "availability_alerts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: varchar("user_id", { length: 255 }).notNull(),
    gameKey: varchar("game_key", { length: 80 }),
    mode: varchar("mode", { length: 80 }),
    region: varchar("region", { length: 80 }),
    minPlayerCount: integer("min_player_count").notNull().default(1),
    maxWaitMs: integer("max_wait_ms"),
    active: boolean("active").notNull().default(true),
    expiresAt: timestamp("expires_at"),
    lastTriggeredAt: timestamp("last_triggered_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    activeLookupIdx: index("availability_alerts_active_lookup_idx").on(
      table.active,
      table.gameKey,
      table.mode,
      table.region
    ),
  })
);

export const availabilityAlertDeliveries = pgTable(
  "availability_alert_deliveries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    alertId: uuid("alert_id")
      .notNull()
      .references(() => availabilityAlerts.id, { onDelete: "cascade" }),
    availabilityKey: varchar("availability_key", { length: 255 }).notNull(),
    deliveredAt: timestamp("delivered_at").notNull().defaultNow(),
  },
  (table) => ({
    dedupeIdx: unique("availability_alert_delivery_unique").on(
      table.alertId,
      table.availabilityKey
    ),
    alertIdx: index("availability_alert_deliveries_alert_idx").on(table.alertId, table.deliveredAt),
  })
);

export const quickQueueReadiness = pgTable(
  "quick_queue_readiness",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: varchar("user_id", { length: 255 }).notNull(),
    preferredGames: jsonb("preferred_games").notNull(),
    preferredModes: jsonb("preferred_modes")
      .notNull()
      .default(sql`'[]'::jsonb`),
    region: varchar("region", { length: 80 }),
    playerCount: integer("player_count").notNull().default(2),
    maxWaitMs: integer("max_wait_ms"),
    minesStakeAmount: numeric("mines_stake_amount", { precision: 14, scale: 2 }),
    minesCount: integer("mines_count"),
    status: varchar("status", { length: 20 }).notNull().default("ready"),
    expiresAt: timestamp("expires_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    activeLookupIdx: index("quick_queue_readiness_active_lookup_idx").on(
      table.status,
      table.expiresAt,
      table.updatedAt
    ),
  })
);

export const quickQueueRequests = pgTable(
  "quick_queue_requests",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: varchar("user_id", { length: 255 }).notNull(),
    preferredGames: jsonb("preferred_games").notNull(),
    preferredModes: jsonb("preferred_modes")
      .notNull()
      .default(sql`'[]'::jsonb`),
    region: varchar("region", { length: 80 }),
    playerCount: integer("player_count").notNull().default(2),
    maxWaitMs: integer("max_wait_ms"),
    // Grynd+ members: their queued request is paired first (priority
    // matchmaking) by the quick-queue matcher.
    premium: boolean("premium").notNull().default(false),
    minesStakeAmount: numeric("mines_stake_amount", { precision: 14, scale: 2 }),
    minesCount: integer("mines_count"),
    status: varchar("status", { length: 20 }).notNull().default("queued"),
    queuedAt: timestamp("queued_at").notNull().defaultNow(),
    cancelledAt: timestamp("cancelled_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    activeIdx: index("quick_queue_requests_active_idx").on(table.status, table.queuedAt),
    userIdx: index("quick_queue_requests_user_idx").on(table.userId, table.status, table.createdAt),
  })
);

export const quickQueueAssignments = pgTable(
  "quick_queue_assignments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    requestIds: jsonb("request_ids").notNull(),
    gameKey: varchar("game_key", { length: 80 }).notNull(),
    mode: varchar("mode", { length: 80 }).notNull(),
    destinationMatchId: varchar("destination_match_id", { length: 255 }),
    playerCount: integer("player_count").notNull(),
    status: varchar("status", { length: 20 }).notNull().default("ready"),
    assignedAt: timestamp("assigned_at").notNull().defaultNow(),
    launchedAt: timestamp("launched_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    statusIdx: index("quick_queue_assignments_status_idx").on(table.status, table.assignedAt),
  })
);

export const quickQueueAssignmentEvents = pgTable(
  "quick_queue_assignment_events",
  {
    eventId: uuid("event_id").defaultRandom().primaryKey(),
    assignmentId: uuid("assignment_id")
      .notNull()
      .references(() => quickQueueAssignments.id, { onDelete: "cascade" }),
    requestIds: jsonb("request_ids").notNull(),
    eventType: varchar("event_type", { length: 40 }).notNull().default("quick_queue:ready"),
    payload: jsonb("payload").notNull(),
    publishedAt: timestamp("published_at"),
    attempts: integer("attempts").notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    unpublishedIdx: index("quick_queue_assignment_events_unpublished_idx").on(
      table.publishedAt,
      table.createdAt
    ),
    assignmentIdx: index("quick_queue_assignment_events_assignment_idx").on(
      table.assignmentId,
      table.createdAt
    ),
  })
);

export const appSettings = pgTable(
  "app_settings",
  {
    key: varchar("key", { length: 100 }).notNull(),
    value: text("value"),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.key] })]
);

// Maintenance-mode flag key, read by middleware + admin toggle.
export const MAINTENANCE_MODE_KEY = "maintenance_mode";
export const MAINTENANCE_MODE_OFF = "false";
export const MAINTENANCE_MODE_ON = "true";

// USERS TABLE
/**
 * Email notification preferences. Only marketing-style messages are gated
 * on these — security alerts and transactional mail (payments, OTP codes)
 * are always sent. All keys default to true (opt-out model).
 */
export type NotificationPrefs = {
  /** Offers, new-game announcements, comeback promos (inactivity emails). */
  promotions: boolean;
  /** Daily reward reminders. */
  daily: boolean;
  /** Weekly win/loss summaries. */
  summary: boolean;
  /** Level-ups, big wins, streak encouragement. */
  progress: boolean;
};

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  promotions: true,
  daily: true,
  summary: true,
  progress: true,
};

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  clerkId: varchar("clerk_id", { length: 255 }).notNull().unique(),
  name: varchar("name", { length: 255 }).notNull(),
  email: varchar("email", { length: 255 }).notNull().unique(),
  profilePicture: text("profile_picture"),
  password: varchar("password", { length: 255 }).notNull(),
  age: integer("age"),
  balance: numeric("balance", { precision: 30, scale: 2 }).default("1000.00").notNull(),
  gamesWon: integer("games_won").default(0),
  gamesLost: integer("games_lost").default(0),
  referralCode: varchar("referral_code", { length: 30 }).unique(),
  referredById: integer("referred_by_id"),
  referralCount: integer("referral_count").default(0).notNull(),
  referralEarnings: numeric("referral_earnings", { precision: 10, scale: 2 })
    .default("0.00")
    .notNull(),
  totalWagered: bigint("total_wagered", { mode: "number" }).default(0).notNull(),
  totalWon: bigint("total_won", { mode: "number" }).default(0).notNull(),
  level: integer("level").default(1).notNull(),
  xp: integer("xp").default(0).notNull(),
  // Permanent Prestige progression layered on the permanent Battle Pass
  // (Level 1-100). Only server-authoritative game results write these —
  // see src/lib/prestige.js and migration 0136. `prestige_level` is
  // monotonic (losses can reduce net-win progress, never a tier);
  // `prestige_net_wins` is the current tier's progress, clamped >= 0 and
  // reset to 0 when the next tier's requirement is met. Both are gated to
  // players who have reached the permanent Level 100 cap.
  prestigeLevel: integer("prestige_level").default(0).notNull(),
  prestigeNetWins: integer("prestige_net_wins").default(0).notNull(),
  // Equip preference: show the "Prestige N" badge instead of the normal
  // title. This is only a preference — the displayed N is always derived
  // server-side from prestige_level (see resolvePrestigeBadge in
  // src/lib/prestige.js), so an unearned badge can never be shown.
  showPrestigeBadge: boolean("show_prestige_badge").notNull().default(false),
  biggestWin: integer("biggest_win").default(0).notNull(),
  bestMultiplier: numeric("best_multiplier", { precision: 10, scale: 4 }).default("0").notNull(),
  currentStreak: integer("current_streak").default(0).notNull(),
  bestStreak: integer("best_streak").default(0).notNull(),
  dailyStreakCurrent: integer("daily_streak_current").default(0).notNull(),
  dailyStreakBest: integer("daily_streak_best").default(0).notNull(),
  weeklyStreakCurrent: integer("weekly_streak_current").default(0).notNull(),
  weeklyStreakBest: integer("weekly_streak_best").default(0).notNull(),
  weekKey: varchar("week_key", { length: 8 }),
  lastLoginDate: date("last_login_date"),
  pvpWins: integer("pvp_wins").default(0).notNull(),
  weeklyWagered: bigint("weekly_wagered", { mode: "number" }).default(0).notNull(),
  weeklyWon: bigint("weekly_won", { mode: "number" }).default(0).notNull(),
  weeklyProfit: bigint("weekly_profit", { mode: "number" }).default(0).notNull(),
  weeklyWins: integer("weekly_wins").default(0).notNull(),
  selectedTitle: text("selected_title").default(null),
  highestTitle: text("highest_title").default(null),
  selectedSpecialTitle: text("selected_special_title").default(null),
  selectedStreakType: varchar("selected_streak_type", { length: 10 }).default(null),
  // Custom chat name color (Grynd+ perk). Only settable by active members —
  // enforced in /api/user/chat-color. Null = default color.
  chatColor: varchar("chat_color", { length: 7 }),
  // Grynd+ profile customization suite (accent / banner / avatar frame).
  // Only writable by active members — enforced in
  // /api/user/profile-customization. Null = default styling.
  profileAccent: varchar("profile_accent", { length: 7 }),
  // Legacy arbitrary URL field retained for compatibility only. Official
  // profile banners use selectedBanner + the banners/userBanners catalogs.
  profileBanner: text("profile_banner"),
  selectedBanner: varchar("selected_banner", { length: 120 }),
  avatarFrame: varchar("avatar_frame", { length: 40 }),
  // Official Grynd icon the user has equipped. Resolved through the
  // official icon catalog (src/lib/icons.ts) — never an arbitrary URL.
  // Defaults to the official default icon key; NULL/invalid/disabled
  // values fall back to the default at read time.
  selectedIcon: varchar("selected_icon", { length: 120 }).default("default"),
  // Persistent in-game emote loadout: an ORDERED array of equipped emote
  // keys (max 9, no duplicates, animated catalog emotes only — GG and
  // NICE MOVE are permanent system emotes and are never stored here).
  // Server-authoritative: written only through src/lib/emotes.ts after
  // validating catalog + ownership; NULL/empty falls back to the 8 free
  // emotes when a user first receives them (migration 0138 seeds legacy
  // accounts).
  equippedEmotes: jsonb("equipped_emotes")
    .$type<string[]>()
    .notNull()
    .default(sql`'[]'::jsonb`),
  // Responsible-play setting: per-player daily loss limit (tokens).
  // Null = global default, 0 = warnings disabled, > 0 = custom threshold.
  dailyLossLimit: integer("daily_loss_limit"),
  // Self-hosted email-OTP second factor for regular accounts (the same
  // mechanism the admin gate uses). When true, the middleware requires a
  // recent second-factor verification (Clerk factor or our signed
  // user_mfa cookie) on every app page. Written only through
  // /api/user/security/mfa/* after an OTP verify.
  mfaEnabled: boolean("mfa_enabled").notNull().default(false),
  // Email notification preferences (marketing-style messages only —
  // security/transactional mail is never gated). All default to true so
  // existing behavior is unchanged. Written through /api/user/notification-preferences.
  notificationPrefs: jsonb("notification_prefs")
    .$type<NotificationPrefs>()
    .notNull()
    .default(
      sql`'{"promotions":true,"daily":true,"summary":true,"progress":true}'::jsonb`,
    ),
  // Per-game default wager (tokens), keyed by game key. An empty map (or a
  // missing key) means the game's built-in default. Written through
  // /api/user/default-wagers; consumed by src/hooks/useDefaultWager.js.
  defaultWagers: jsonb("default_wagers")
    .$type<Record<string, number>>()
    .notNull()
    .default(sql`'{}'::jsonb`),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  searchName: varchar("search_name", { length: 255 }),
  termsAccepted: boolean("terms_accepted").notNull().default(false),
  // First-time-user onboarding completion. NULL = onboarding not finished
  // (brand-new accounts only); once set it persists permanently. Written
  // only through /api/onboarding/complete. Existing accounts were backfilled
  // as completed (migration 0142) so nobody already using Grynd sees the
  // welcome flow.
  onboardingCompletedAt: timestamp("onboarding_completed_at"),
  // Onboarding first free-match completion (the "first match is free" stage,
  // migration 0143). NULL = the player hasn't yet finished their onboarding
  // Free Play vs AI match; once set — only by /api/onboarding/first-game-complete
  // at a real terminal game state — the one-time FIRST_GAME_BONUS_XP was
  // granted and the tutorial match never reappears. Existing accounts were
  // backfilled as completed so nobody already using Grynd can trigger it.
  firstGameCompletedAt: timestamp("first_game_completed_at"),
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
    uniqueFriendship: index("friend_relations_user_friend_idx").on(table.userId, table.friendId),
  })
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
    userGameIdx: index("user_game_presence_user_game_idx").on(table.userId, table.gameKey),
  })
);

export const presenceStatusEnum = pgEnum("presence_status", ["online", "in_game", "offline"]);

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
    statusSeenIdx: index("user_presence_status_seen_idx").on(table.status, table.lastSeen),
  })
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
  winRate: numeric("win_rate", { precision: 5, scale: 2 }).notNull().default("0"),
  totalWagered: numeric("total_wagered", { precision: 14, scale: 2 }).notNull().default("0"),
  totalWon: numeric("total_won", { precision: 14, scale: 2 }).notNull().default("0"),
  biggestWin: numeric("biggest_win", { precision: 14, scale: 2 }).notNull().default("0"),
  favoriteGame: varchar("favorite_game", { length: 100 }).notNull().default("N/A"),
  currentStreak: integer("current_streak").notNull().default(0),
  bestStreak: integer("best_streak").notNull().default(0),
  dailyStreakCurrent: integer("daily_streak_current").notNull().default(0),
  dailyStreakBest: integer("daily_streak_best").notNull().default(0),
  weeklyStreakCurrent: integer("weekly_streak_current").notNull().default(0),
  weeklyStreakBest: integer("weekly_streak_best").notNull().default(0),
  level: integer("level").notNull().default(1),
  xp: integer("xp").notNull().default(0),
  weeklyWagered: bigint("weekly_wagered", { mode: "number" }).notNull().default(0),
  weeklyWon: bigint("weekly_won", { mode: "number" }).notNull().default(0),
  weeklyWins: integer("weekly_wins").notNull().default(0),
  weeklyLosses: integer("weekly_losses").notNull().default(0),
  weeklyLevelGain: integer("weekly_level_gain").notNull().default(0),
  weeklyBestStreak: integer("weekly_best_streak").notNull().default(0),
  weeklyBiggestWin: bigint("weekly_biggest_win", { mode: "number" }).notNull().default(0),
  weeklyWinRate: numeric("weekly_win_rate", { precision: 5, scale: 2 }).notNull().default("0"),
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
    uniqUserTitle: index("user_special_titles_user_title_idx").on(table.userId, table.titleKey),
  })
);

// OFFICIAL GRYND ICON CATALOG + OWNERSHIP
// ==============================================================================
// Mirrors the specialTitles ownership pattern: a catalog table, a
// per-user ownership join table, and an equipped-item column on `users`.
// Avatars are ALWAYS official icons resolved through this catalog — never
// arbitrary user-provided URLs. `price_tokens` is reserved for a future
// token-priced shop (purchases not implemented yet; NULL = not for sale).
export const icons = pgTable("icons", {
  id: serial("id").primaryKey(),
  // Stable slug used to resolve the icon's official asset and to equip it.
  key: varchar("key", { length: 120 }).notNull().unique(),
  name: varchar("name", { length: 255 }).notNull(),
  description: text("description").notNull().default(""),
  // Official asset path (e.g. "/icons/default.webp"). Resolved only from
  // this trusted catalog row — never from user input.
  assetPath: text("asset_path").notNull(),
  rarity: varchar("rarity", { length: 40 }).notNull().default("Common"),
  // Reserved for the future token shop; not used for charging yet.
  priceTokens: integer("price_tokens"),
  enabled: boolean("enabled").notNull().default(true),
  // Exactly the icon every user receives by default (the "official default").
  isDefault: boolean("is_default").notNull().default(false),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const userIcons = pgTable(
  "user_icons",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    iconKey: varchar("icon_key", { length: 120 }).notNull(),
    unlockedAt: timestamp("unlocked_at").notNull().defaultNow(),
  },
  (table) => ({
    uniqUserIcon: index("user_icons_user_icon_idx").on(table.userId, table.iconKey),
  })
);

// OFFICIAL GRYND PROFILE BANNER CATALOG + OWNERSHIP
// Banner keys are stable public cosmetic identifiers. Asset paths are trusted
// catalog data and are never accepted from clients.
export const banners = pgTable("banners", {
  id: serial("id").primaryKey(),
  key: varchar("key", { length: 120 }).notNull().unique(),
  name: varchar("name", { length: 255 }).notNull(),
  description: text("description").notNull().default(""),
  assetPath: text("asset_path").notNull(),
  rarity: varchar("rarity", { length: 40 }).notNull().default("Common"),
  enabled: boolean("enabled").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const userBanners = pgTable(
  "user_banners",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    bannerKey: varchar("banner_key", { length: 120 }).notNull(),
    unlockedAt: timestamp("unlocked_at").notNull().defaultNow(),
  },
  (table) => ({
    uniqUserBanner: unique("user_banners_user_banner_unique").on(
      table.userId,
      table.bannerKey,
    ),
    userBannerIdx: index("user_banners_user_idx").on(table.userId, table.bannerKey),
  }),
);

// OFFICIAL GRYND ANIMATED EMOTE CATALOG + OWNERSHIP + LOADOUT
// ==============================================================================
// Same architecture as the official banners: a catalog table, a per-user
// ownership join table, and an ordered loadout column on `users`. Emote keys
// are stable public cosmetic identifiers; asset paths are trusted catalog
// data and are never accepted from clients. GG / NICE MOVE are permanent
// text system emotes (not in this catalog) and stay out of the 9-slot
// loadout.
export const emotes = pgTable("emotes", {
  id: serial("id").primaryKey(),
  // Stable slug used to resolve the emote's official asset and to equip it.
  key: varchar("key", { length: 120 }).notNull().unique(),
  name: varchar("name", { length: 255 }).notNull(),
  description: text("description").notNull().default(""),
  // Official asset path (e.g. "/emotes/laugh.webp"). Resolved only from
  // this trusted catalog row — never from user input.
  assetPath: text("asset_path").notNull(),
  rarity: varchar("rarity", { length: 40 }).notNull().default("Common"),
  enabled: boolean("enabled").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const userEmotes = pgTable(
  "user_emotes",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    emoteKey: varchar("emote_key", { length: 120 }).notNull(),
    unlockedAt: timestamp("unlocked_at").notNull().defaultNow(),
  },
  (table) => ({
    uniqUserEmote: unique("user_emotes_user_emote_unique").on(
      table.userId,
      table.emoteKey,
    ),
    userEmoteIdx: index("user_emotes_user_idx").on(table.userId, table.emoteKey),
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

// PERMANENT PRESTIGE — IDEMPOTENCY JOURNAL
// ==============================================================================
// Server-side journal of authoritative match results that flowed through the
// Prestige hook (src/lib/prestige.js). (user_id, source, source_id) is unique
// so a duplicate / replayed / concurrent settlement of the same match can
// never apply Prestige progress twice. Written only from server settlement
// code; the client can never insert rows here.
export const prestigeResults = pgTable("prestige_results", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  // Game key that produced the result, e.g. "mines-pvp".
  source: varchar("source", { length: 64 }).notNull(),
  // Authoritative match/game id in that game's own table.
  sourceId: varchar("source_id", { length: 128 }).notNull(),
  // Authoritative outcome: "win" | "loss" | "draw".
  outcome: varchar("outcome", { length: 8 }).notNull(),
  // Applied net-win delta for this event (+1 / -1 / 0 when ineligible, draw,
  // or maxed). Stored for auditability of the journal row.
  delta: integer("delta").default(0).notNull(),
  prestigeLevelAfter: integer("prestige_level_after").default(0).notNull(),
  prestigeNetWinsAfter: integer("prestige_net_wins_after").default(0).notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => ({
  uniqPrestigeEvent: unique("prestige_results_unique_event").on(
    table.userId,
    table.source,
    table.sourceId,
  ),
  userPrestigeIdx: index("prestige_results_user_idx").on(table.userId, table.createdAt),
}));

export const chatRoomTypeEnum = pgEnum("chat_room_type", ["global", "game"]);

export const chatMessages = pgTable(
  "chat_messages",
  {
    id: serial("id").primaryKey(),
    roomType: chatRoomTypeEnum("room_type").notNull().default("global"),
    roomId: varchar("room_id", { length: 255 }).notNull(),
    clerkId: varchar("clerk_id", { length: 255 }).notNull(),
    displayName: varchar("display_name", { length: 255 }).notNull(),
    // Official Grynd icon key for this sender's avatar. Null on legacy
    // rows (before this column existed) — the client renders the default
    // icon for those. The legacy `profile_image_url` snapshot is never
    // used as a live avatar in the official icon system.
    iconKey: text("icon_key"),
    profileImageUrl: text("profile_image_url"),
    content: text("content").notNull(),
    isDeleted: boolean("is_deleted").notNull().default(false),
    deletedAt: timestamp("deleted_at"),
    deletedByClerkId: varchar("deleted_by_clerk_id", { length: 255 }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    roomIdx: index("chat_messages_room_idx").on(table.roomType, table.roomId, table.createdAt),
    moderationIdx: index("chat_messages_moderation_idx").on(table.isDeleted, table.createdAt),
  })
);

// GAMES TABLES
export const rouletteGames = pgTable(
  "roulette_games",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").notNull(),
    betAmount: numeric("bet_amount", { precision: 10, scale: 2 }).notNull(),
    result: varchar("result", { length: 10 }).notNull(),
    payout: numeric("payout", { precision: 10, scale: 2 }).notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    // Per-user history lookups (bet history / daily-loss guard).
    userIdx: index("roulette_games_user_idx").on(table.userId, desc(table.createdAt)),
  })
);

export const crashGames = pgTable(
  "crash_games",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").notNull(),
    betAmount: numeric("bet_amount", { precision: 10, scale: 2 }).notNull(),
    cashedOutAt: numeric("cashed_out_at", { precision: 10, scale: 2 }),
    payout: numeric("payout", { precision: 10, scale: 2 }).notNull(),
    result: varchar("result", { length: 10 }).default("pending").notNull(),
    status: varchar("status", { length: 20 }).default("active").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    // Per-user history lookups (bet history / daily-loss guard).
    userIdx: index("crash_games_user_idx").on(table.userId, desc(table.createdAt)),
  })
);

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
  //  NEW: Players array (max 6 seats)
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

export const blackjackGames = pgTable(
  "blackjack_games",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").notNull(),
    betAmount: numeric("bet_amount", { precision: 10, scale: 2 }).notNull(),
    result: varchar("result", { length: 10 }).notNull(),
    payout: numeric("payout", { precision: 10, scale: 2 }).notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    // Per-user history lookups (bet history / daily-loss guard).
    userIdx: index("blackjack_games_user_idx").on(table.userId, desc(table.createdAt)),
  })
);

export const minesGames = pgTable(
  "mines_games",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").notNull(),
    betAmount: numeric("bet_amount", { precision: 10, scale: 2 }).notNull(),
    tilesRevealed: integer("tiles_revealed").default(0),
    minesCount: integer("mines_count").default(0),
    payout: numeric("payout", { precision: 10, scale: 2 }).notNull(),
    result: varchar("result", { length: 10 }).default("pending").notNull(),
    status: varchar("status", { length: 20 }).default("active").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    // Per-user history lookups (bet history / daily-loss guard).
    userIdx: index("mines_games_user_idx").on(table.userId, desc(table.createdAt)),
  })
);

export const laneRunnerGames = pgTable("lane_runner_games", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  betAmount: numeric("bet_amount", { precision: 10, scale: 2 }).notNull(),
  payout: numeric("payout", { precision: 10, scale: 2 }).notNull().default("0.00"),
  result: varchar("result", { length: 20 }).notNull().default("pending"),
  difficulty: varchar("difficulty", { length: 20 }).notNull(),
  currentLane: integer("current_lane").notNull().default(0),
  multiplier: numeric("multiplier", { precision: 12, scale: 4 }).notNull().default("1.0000"),
  clientSeed: varchar("client_seed", { length: 255 }).notNull(),
  serverSeedHash: varchar("server_seed_hash", { length: 255 }).notNull(),
  serverSeed: varchar("server_seed", { length: 255 }),
  nonce: varchar("nonce", { length: 255 }).notNull(),
  outcomeSequence: jsonb("outcome_sequence").notNull(),
  status: varchar("status", { length: 20 }).notNull().default("completed"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const plinkoGames = pgTable(
  "plinko_games",
  {
    id: serial("id").primaryKey(),
    userId: varchar("user_id", { length: 255 }).notNull(),
    betAmount: numeric("bet_amount", { precision: 10, scale: 2 }).notNull(),
    resultMultiplier: varchar("result_multiplier", { length: 255 }).notNull(), // changed from numeric to varchar
    payout: numeric("payout", { precision: 10, scale: 2 }).notNull(),
    result: varchar("result", { length: 10 }).default("pending").notNull(),
    status: varchar("status", { length: 20 }).default("active").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    // Per-user history lookups (bet history / daily-loss guard).
    userIdx: index("plinko_games_user_idx").on(table.userId, desc(table.createdAt)),
  })
);

export const chessGames = pgTable("chess_games", {
  id: uuid("id").defaultRandom().primaryKey(),
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
  isAiGame: boolean("is_ai_game").default(false).notNull(), // new column
  startedAt: timestamp("started_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const chessMoves = pgTable(
  "chess_moves",
  {
    id: serial("id").primaryKey(),
    gameId: uuid("game_id")
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
  })
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
  totalWagered: bigint("total_wagered", { mode: "number" }).notNull().default(0),
  totalWon: bigint("total_won", { mode: "number" }).notNull().default(0),
  highestWin: integer("highest_win").notNull().default(0),
  currentStreak: integer("current_streak").notNull().default(0),
  bestStreak: integer("best_streak").notNull().default(0),
});

// ── Tower Arena ──────────────────────────────────────────────────────
//
// 2–6 player shared-tower stacking game. The server is fully
// authoritative: every match/tower/resource/placement value is owned
// by the server and stored here; clients only submit intent (block
// shape + x + rotation) and render back the state the server persists.
// No fixed player seats — seats live in `tower_arena_players`.
//
// `status` lifecycle: waiting (lobby open) → active (play began) →
// finished | cancelled.
// `phase` during an active match: reserve (resource-selection window)
// → placement (turn play) → finished.
export const towerArenaMatches = pgTable(
  "tower_arena_matches",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    status: varchar("status", { length: 20 }).notNull().default("waiting"),
    wager: integer("wager").notNull(),
    maxPlayers: integer("max_players").notNull(),
    hostUserId: varchar("host_user_id", { length: 255 }).notNull(),
    // Free-play human-vs-AI matches move zero tokens.
    isAi: boolean("is_ai").notNull().default(false),
    phase: varchar("phase", { length: 20 }).notNull().default("waiting"),
    resourceCycle: integer("resource_cycle").notNull().default(0),
    turnNumber: integer("turn_number").notNull().default(0),
    currentTurnPlayerId: varchar("current_turn_player_id", { length: 255 }),
    turnDeadline: timestamp("turn_deadline"),
    resourcePool: jsonb("resource_pool").notNull().default(sql`'[]'::jsonb`),
    towerState: jsonb("tower_state").notNull().default(sql`'[]'::jsonb`),
    // Server-owned per-player reserve bookkeeping — NEVER sent to other
    // players (each viewer only sees their own reservedBlock).
    reserveState: jsonb("reserve_state").notNull().default(sql`'{}'::jsonb`),
    placements: jsonb("placements").notNull().default(sql`'[]'::jsonb`),
    finalRankings: jsonb("final_rankings").notNull().default(sql`'[]'::jsonb`),
    winnerId: varchar("winner_id", { length: 255 }),
    prizePool: integer("prize_pool").notNull().default(0),
    houseFee: integer("house_fee").notNull().default(0),
    pot: integer("pot").notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    startedAt: timestamp("started_at"),
    endedAt: timestamp("ended_at"),
  },
  (table) => [
    index("tower_arena_matches_status_idx").on(table.status, table.createdAt),
    index("tower_arena_matches_user_idx").on(table.hostUserId),
  ],
);

// One row per participant (seat). Seats are 1..maxPlayers and double
// as turn order (deterministic seat order around the table).
export const towerArenaPlayers = pgTable(
  "tower_arena_players",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    matchId: uuid("match_id")
      .notNull()
      .references(() => towerArenaMatches.id, { onDelete: "cascade" }),
    userId: varchar("user_id", { length: 255 }).notNull(),
    seat: integer("seat").notNull(),
    status: varchar("status", { length: 20 }).notNull().default("active"),
    placement: integer("placement"),
    isAi: boolean("is_ai").notNull().default(false),
    // Pre-game ready gate: every player must click READY (bots are always
    // ready) before the 10s start countdown begins.
    ready: boolean("ready").notNull().default(false),
    reserveUsesRemaining: integer("reserve_uses_remaining").notNull().default(2),
    reservedBlock: jsonb("reserved_block"),
    joinedAt: timestamp("joined_at").notNull().defaultNow(),
    eliminatedAt: timestamp("eliminated_at"),
  },
  (table) => [
    index("tower_arena_players_match_idx").on(table.matchId),
    unique("tower_arena_players_match_seat_unique").on(table.matchId, table.seat),
  ],
);

// Placement / reserve audit log (replay + history). Every server-side
// state transition is appended here. towerDelta captures what the tower
// sim removed/added for that action.
export const towerArenaTurns = pgTable(
  "tower_arena_turns",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    matchId: uuid("match_id")
      .notNull()
      .references(() => towerArenaMatches.id, { onDelete: "cascade" }),
    userId: varchar("user_id", { length: 255 }).notNull(),
    seat: integer("seat").notNull(),
    turnNumber: integer("turn_number").notNull(),
    resourceCycle: integer("resource_cycle").notNull(),
    phase: varchar("phase", { length: 20 }).notNull(),
    actionType: varchar("action_type", { length: 20 }).notNull(),
    blockShape: varchar("block_shape", { length: 30 }),
    positionX: integer("position_x"),
    rotation: integer("rotation"),
    blockId: varchar("block_id", { length: 40 }),
    collapsed: boolean("collapsed").notNull().default(false),
    towerDelta: jsonb("tower_delta").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("tower_arena_turns_match_idx").on(table.matchId),
  ],
);

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
    statusIdx: index("idx_pool_lobbies_status").on(table.status, table.createdAt),
  })
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
  })
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
  })
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

export const unoGames = pgTable(
  "uno_games",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").notNull(),
    player2Id: integer("player2_id"),
    betAmount: text("bet_amount").notNull(), // stored as string to match other tables
    pot: text("pot").notNull(), // total pot
    result: text("result").notNull(), // 'win' | 'lose' | 'draw' | 'pending'
    payout: text("payout").notNull(), // string format of number

    //  existing AI game fields
    playerHand: json("player_hand").default("[]").notNull(),
    aiHand: json("ai_hand").default("[]").notNull(),

    //  new online multiplayer fields
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
  },
  (table) => ({
    // Per-user history lookups (bet history / daily-loss guard).
    userIdx: index("uno_games_user_idx").on(table.userId, desc(table.createdAt)),
  })
);

export const rpsGames = pgTable(
  "rps_games",
  {
    id: serial("id").primaryKey(),
    userId: varchar("user_id", { length: 255 }).notNull(),
    betAmount: numeric("bet_amount").notNull(),
    choice: varchar("choice", { length: 20 }).notNull(), // rock, paper, scissors
    aiChoice: varchar("ai_choice", { length: 20 }).notNull(),
    result: varchar("result", { length: 20 }).notNull(), // win, lose, draw
    payout: numeric("payout").default("0"),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => ({
    // Per-user history lookups (bet history / daily-loss guard).
    userIdx: index("rps_games_user_idx").on(table.userId, desc(table.createdAt)),
  })
);

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
    // ── Best-of-7 match state ────────────────────────────────────────────
    // Rounds won per player (first to 4 takes the match), the current
    // round number (1-based), and the per-round history used to render
    // the rounds sidebar: [{ round, player1Choice, player2Choice, winner }]
    // where winner is 'player1' | 'player2' | 'tie'. Ties do NOT advance
    // the round — the same round is replayed until someone wins it.
    roundsWon1: integer("rounds_won_1").default(0).notNull(),
    roundsWon2: integer("rounds_won_2").default(0).notNull(),
    currentRound: integer("current_round").default(1).notNull(),
    roundHistory: jsonb("round_history")
      .default(sql`'[]'::jsonb`)
      .notNull(),
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

export const keno_games = pgTable(
  "keno_games",
  {
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
  },
  (table) => ({
    // Per-user history lookups (bet history / daily-loss guard).
    userIdx: index("keno_games_user_idx").on(table.user_id, desc(table.created_at)),
  })
);

export const fourInARowGames = pgTable(
  "four_in_a_row_games",
  {
    id: serial("id").primaryKey(),
    hostClerkId: varchar("host_clerk_id", { length: 255 }).notNull(),
    guestClerkId: varchar("guest_clerk_id", { length: 255 }),
    betAmount: numeric("bet_amount", { precision: 10, scale: 2 }).notNull(),
    status: varchar("status", { length: 30 }).notNull().default("waiting"),
    board: jsonb("board")
      .notNull()
      .default(
        sql`'[[0,0,0,0,0,0,0],[0,0,0,0,0,0,0],[0,0,0,0,0,0,0],[0,0,0,0,0,0,0],[0,0,0,0,0,0,0],[0,0,0,0,0,0,0]]'::jsonb`
      ),
    hostDiscsUsed: integer("host_discs_used").notNull().default(0),
    guestDiscsUsed: integer("guest_discs_used").notNull().default(0),
    currentTurn: varchar("current_turn", { length: 10 }).notNull().default("host"),
    winnerClerkId: varchar("winner_clerk_id", { length: 255 }),
    result: varchar("result", { length: 30 }),
    payout: numeric("payout", { precision: 10, scale: 2 }),
    moveDeadlineAt: timestamp("move_deadline_at"),
    readyDeadlineAt: timestamp("ready_deadline_at"),
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
    fourInARowStatusIdx: index("four_in_a_row_status_idx").on(table.status, table.createdAt),
    fourInARowHostIdx: index("four_in_a_row_host_idx").on(table.hostClerkId),
    fourInARowGuestIdx: index("four_in_a_row_guest_idx").on(table.guestClerkId),
  })
);

export const diceFlushRooms = pgTable(
  "dice_flush_rooms",
  {
    id: varchar("id", { length: 120 }).primaryKey(),
    status: varchar("status", { length: 20 }).notNull(),
    wager: integer("wager").notNull(),
    pot: integer("pot").notNull(),
    gameState: jsonb("game_state")
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => ({
    diceFlushRoomsStatusIdx: index("idx_dice_flush_rooms_status").on(table.status),
  })
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
  })
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
      table.createdAt
    ),
  })
);

// CRASH ARENA TABLES
// ==========================================================================

export const crashArenaStatusEnum = pgEnum("crash_arena_status", ["waiting", "active", "closed"]);

export const crashArenaTransactionTypeEnum = pgEnum("crash_arena_transaction_type", [
  "BUY_IN",
  "WIN",
  "LEAVE",
  "RAKE",
  "RETURN",
]);

// ── Table (lobby) ──────────────────────────────────────────────────────────

export const crashArenaTables = pgTable(
  "crash_arena_tables",
  {
    id: serial("id").primaryKey(),
    name: varchar("name", { length: 255 }).notNull(),
    wagerAmount: numeric("wager_amount", { precision: 10, scale: 2 }).notNull(),
    minimumBuyin: numeric("minimum_buyin", { precision: 10, scale: 2 }).notNull(),
    maxPlayers: integer("max_players").notNull().default(6),
    // Creator of the table (null for system-seeded default tables).
    hostId: integer("host_id").references(() => users.id, {
      onDelete: "set null",
    }),
    status: crashArenaStatusEnum("status").notNull().default("waiting"),
    // Free practice tables (human vs GRYND AI) — no real money moves.
    isAi: boolean("is_ai").notNull().default(false),
    // Practice difficulty chosen in the lobby (easy/medium/hard). NULL on
    // real tables; defaults to "medium" for AI tables created before the
    // column existed.
    aiDifficulty: varchar("ai_difficulty", { length: 20 }),
    // Crash Poker: pot carried over from a hand that ended with no winner
    // (crash with 2+ players still active). Server-authoritative; feeds the
    // next hand's pot and is paid out to a fold-out winner or carried again.
    carryOver: numeric("carry_over", { precision: 14, scale: 2 }).notNull().default("0.00"),
    // Configurable Small Blind for this table. NULL (the default) means
    // the standard ratio applies: round(wager / 2) — the value is resolved
    // once at table creation and can be overridden per table without code
    // changes.
    smallBlind: numeric("small_blind", { precision: 10, scale: 2 }),
    // Host-created private table: hidden from the public lobby grid; only
    // the host may add AI seats (AIs are private-only, like the poker
    // tables). Joining still works via the table URL.
    isPrivate: boolean("is_private").notNull().default(false),
    // Server-authoritative wall-clock deadline for the next round start,
    // written when a hand settles. Every client counts down to the SAME
    // moment and start-round rejects early starts, so a round can never
    // fire before a client's countdown ends.
    nextRoundAt: timestamp("next_round_at"),
    // Invite code for PRIVATE tables (NULL on public / AI-practice tables):
    // joining requires it, so the table URL alone no longer grants access.
    // Returned only to the host for sharing.
    joinCode: varchar("join_code", { length: 12 }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    statusIdx: index("idx_crash_arena_tables_status").on(table.status, table.createdAt),
    hostIdx: index("idx_crash_arena_tables_host").on(table.hostId, table.status, table.createdAt),
  })
);

// ── Players at a table ─────────────────────────────────────────────────────

export const crashArenaPlayers = pgTable(
  "crash_arena_players",
  {
    id: serial("id").primaryKey(),
    tableId: integer("table_id")
      .notNull()
      .references(() => crashArenaTables.id, { onDelete: "cascade" }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    balance: numeric("balance", { precision: 14, scale: 2 }).notNull().default("0.00"),
    status: varchar("status", { length: 20 }).notNull().default("seated"),
    // Per-bot difficulty (easy/medium/hard) chosen in the Add-AI dialog.
    // NULL for human seats; the practice-table bot uses the table-level
    // ai_difficulty instead.
    aiDifficulty: varchar("ai_difficulty", { length: 20 }),
    // Optional per-seat display-name override — the host's custom name for
    // an AI bot (the shared users row is never touched). NULL = the bot's
    // default name from the users table.
    nickname: varchar("nickname", { length: 40 }),
    joinedAt: timestamp("joined_at").notNull().defaultNow(),
  },
  (table) => ({
    tablePlayerIdx: index("idx_crash_arena_players_table_user").on(table.tableId, table.userId),
  })
);

// ── Rounds ─────────────────────────────────────────────────────────────────

export const crashArenaRounds = pgTable(
  "crash_arena_rounds",
  {
    id: serial("id").primaryKey(),
    tableId: integer("table_id")
      .notNull()
      .references(() => crashArenaTables.id, { onDelete: "cascade" }),
    seed: varchar("seed", { length: 255 }),
    seedHash: varchar("seed_hash", { length: 255 }),
    crashPoint: numeric("crash_point", { precision: 6, scale: 2 }),
    // ── Crash Poker hand state ──────────────────────────────────────────
    // Blinds posted at the start of the hand. big_blind = table wager;
    // small_blind = round(wager / 2).
    smallBlind: numeric("small_blind", { precision: 10, scale: 2 }),
    bigBlind: numeric("big_blind", { precision: 10, scale: 2 }),
    // Seat index of the dealer button; SB = dealer + 1, BB = dealer + 2
    // (wrapping). Rotates every hand: (round_number - 1) % seated_count.
    dealerPosition: integer("dealer_position"),
    // Currently open betting checkpoint: 0 = 1.25x, 1 = 1.50x, ...
    // -1 before the first checkpoint opens. Server-authoritative.
    checkpointIndex: integer("checkpoint_index").notNull().default(-1),
    // Total contribution an active player must have committed to stay in
    // (call = top up to this). Starts at big_blind; raises raise it.
    requiredBet: numeric("required_bet", { precision: 14, scale: 2 }).notNull().default("0"),
    // Whether the current checkpoint window accepts fold/call/raise actions.
    bettingOpen: boolean("betting_open").notNull().default(false),
    // Compact hand snapshot: roles, acted flags, action log. The per-player
    // money truth lives in crash_arena_entries; this is the transient
    // betting-window state + audit trail.
    handState: jsonb("hand_state"),
    status: varchar("status", { length: 20 }).notNull().default("waiting"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    tableRoundIdx: index("idx_crash_arena_rounds_table").on(table.tableId, table.createdAt),
  })
);

// ── Round entries — one per player per round ──────────────────────────────

export const crashArenaEntries = pgTable(
  "crash_arena_entries",
  {
    id: serial("id").primaryKey(),
    roundId: integer("round_id")
      .notNull()
      .references(() => crashArenaRounds.id, { onDelete: "cascade" }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // Legacy solo-crash field — unused by Crash Poker hands (kept for
    // compatibility with cleanup/refund code and older rows).
    cashoutMultiplier: numeric("cashout_multiplier", { precision: 6, scale: 2 }),
    cashoutTimestamp: timestamp("cashout_timestamp"),
    // ── Crash Poker hand state ──────────────────────────────────────────
    // Total committed to the pot this hand (blinds/ante + calls/raises).
    contributed: numeric("contributed", { precision: 14, scale: 2 }).notNull().default("0"),
    // Checkpoint multiplier where the player folded (null until folded).
    foldedAtMultiplier: numeric("folded_at_multiplier", { precision: 6, scale: 2 }),
    // Last betting action: ante/sb/bb/call/check/raise/fold.
    lastAction: varchar("last_action", { length: 20 }),
    // Still in the hand (false after fold or when the hand settles).
    isActive: boolean("is_active").notNull().default(true),
    // Committed their whole remaining stack to the pot — can no longer act
    // (fold/call/raise) at later checkpoints and is treated as matched.
    allIn: boolean("all_in").notNull().default(false),
    // pending | won | lost | folded
    result: varchar("result", { length: 20 }).notNull().default("pending"),
  },
  (table) => ({
    roundEntryIdx: index("idx_crash_arena_entries_round_user").on(table.roundId, table.userId),
  })
);

// ── Transactions (buy-in, win, leave, rake) ───────────────────────────────

export const crashArenaTransactions = pgTable(
  "crash_arena_transactions",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tableId: integer("table_id")
      .notNull()
      .references(() => crashArenaTables.id, { onDelete: "cascade" }),
    amount: numeric("amount", { precision: 14, scale: 2 }).notNull(),
    type: crashArenaTransactionTypeEnum("type").notNull(),
    reason: text("reason"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    userTxIdx: index("idx_crash_arena_tx_user").on(table.userId, table.createdAt),
    tableTxIdx: index("idx_crash_arena_tx_table").on(table.tableId, table.createdAt),
  })
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
  crashArenaPlayers: many(crashArenaPlayers),
  crashArenaEntries: many(crashArenaEntries),
  crashArenaTransactions: many(crashArenaTransactions),
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

// ── Crash Arena relations ──────────────────────────────────────────────────

export const crashArenaTablesRelations = relations(crashArenaTables, ({ many }) => ({
  players: many(crashArenaPlayers),
  rounds: many(crashArenaRounds),
  transactions: many(crashArenaTransactions),
}));

export const crashArenaPlayersRelations = relations(crashArenaPlayers, ({ one, many }) => ({
  table: one(crashArenaTables, {
    fields: [crashArenaPlayers.tableId],
    references: [crashArenaTables.id],
  }),
  user: one(users, {
    fields: [crashArenaPlayers.userId],
    references: [users.id],
  }),
}));

export const crashArenaRoundsRelations = relations(crashArenaRounds, ({ one, many }) => ({
  table: one(crashArenaTables, {
    fields: [crashArenaRounds.tableId],
    references: [crashArenaTables.id],
  }),
  entries: many(crashArenaEntries),
}));

export const crashArenaEntriesRelations = relations(crashArenaEntries, ({ one }) => ({
  round: one(crashArenaRounds, {
    fields: [crashArenaEntries.roundId],
    references: [crashArenaRounds.id],
  }),
  user: one(users, {
    fields: [crashArenaEntries.userId],
    references: [users.id],
  }),
}));

export const crashArenaTransactionsRelations = relations(crashArenaTransactions, ({ one }) => ({
  table: one(crashArenaTables, {
    fields: [crashArenaTransactions.tableId],
    references: [crashArenaTables.id],
  }),
  user: one(users, {
    fields: [crashArenaTransactions.userId],
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
  inactivityCycleStartAt: timestamp("inactivity_cycle_start_at").notNull().defaultNow(),
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
    // Server-authoritative current turn (added in migration 0054).
    // Nullable so historical / completed rows remain valid. New
    // multiplayer joins populate this with 'player1' or 'player2'.
    // The legacy `status` column ('turn_player1' / 'turn_player2' /
    // 'in_progress') is kept for backwards compatibility with the
    // existing lobby / spectate filters; `currentTurn` is the new
    // source of truth for "whose turn is it".
    currentTurn: varchar("current_turn", { length: 10 }),
    // Highest `hex_duel_actions.id` that has been written by the
    // server for this game. Used by the polling endpoint to cheaply
    // detect missed actions after a reconnect without a COUNT(*),
    // and by the page.tsx client as a fast cursor.
    lastActionSeq: integer("last_action_seq"),
    startedAt: timestamp("started_at"),
    endedAt: timestamp("ended_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    player1Idx: index("hex_duel_player1_idx").on(table.player1Id, table.createdAt),
    createdIdx: index("hex_duel_created_idx").on(table.createdAt),
  })
);

// Hex Duel action log — persisted record of every multiplayer action (like diceTurns)
//
// Column widths mirror migration 0054. Widened to `varchar(50)` so
// future action-type prefixes (e.g. `reinforce_v2`, `pass_p1`,
// `displace_north`) fit without another migration. The legacy `20`
// length from `schema.ts` predated the migration table creation and
// would silently truncate longer values that any future feature might
// introduce; the migration was the place to widen once for everyone.
export const hexDuelActions = pgTable(
  "hex_duel_actions",
  {
    id: serial("id").primaryKey(),
    gameId: integer("game_id")
      .notNull()
      .references(() => hexDuelGames.id, { onDelete: "cascade" }),
    userId: varchar("user_id", { length: 255 }).notNull(),
    actionType: varchar("action_type", { length: 50 }).notNull(),
    sourceKey: varchar("source_key", { length: 50 }),
    targetKey: varchar("target_key", { length: 50 }),
    troopCount: integer("troop_count"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    gameSeqIdx: index("hex_duel_actions_game_seq_idx").on(table.gameId, table.id),
  })
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
    statusIdx: index("idx_precision_matches_status").on(table.status, table.createdAt),
    player1Idx: index("idx_precision_matches_player1").on(table.player1Id, table.createdAt),
    player2Idx: index("idx_precision_matches_player2").on(table.player2Id, table.createdAt),
  })
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
    matchRoundIdx: index("idx_precision_rounds_match_round").on(table.matchId, table.roundNumber),
  })
);

// Precision relations — declared here (after the tables) so the symbols
// are bound before `relations(...)` runs. Drizzle relations are read at
// query time, not module-load, so the position is purely about lexical
// ordering for the TS compiler.
export const precisionMatchesRelations = relations(precisionMatches, ({ many }) => ({
  rounds: many(precisionRounds),
}));

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
  })
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
  })
);

// CONTACT MESSAGES — user-submitted contact form messages (admin inbox).
// Filled by POST /api/contact; surfaced to admins in the admin dashboard's
// Messages tab (GET /api/admin/contact-messages). No email is sent.
export const contactMessages = pgTable(
  "contact_messages",
  {
    id: serial("id").primaryKey(),
    name: varchar("name", { length: 255 }),
    email: varchar("email", { length: 255 }).notNull(),
    message: text("message").notNull(),
    status: varchar("status", { length: 20 }).notNull().default("new"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at"),
  },
  (table) => ({
    statusIdx: index("idx_contact_messages_status").on(table.status, table.createdAt),
  })
);

// PRODUCT REVIEWS — authenticated user reviews of the platform.
// Public wall shows only `approved` rows (marketing social proof);
// pending/rejected stay internal. One review per user (unique userId).
export const productReviews = pgTable(
  "product_reviews",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    rating: integer("rating").notNull(),
    title: varchar("title", { length: 120 }),
    body: text("body"),
    game: varchar("game", { length: 50 }),
    status: varchar("status", { length: 20 }).notNull().default("pending"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    moderatedAt: timestamp("moderated_at"),
    moderatedByClerkId: varchar("moderated_by_clerk_id", { length: 255 }),
  },
  (table) => ({
    reviewUserIdx: index("idx_product_reviews_user").on(table.userId),
    reviewStatusIdx: index("idx_product_reviews_status").on(table.status, table.createdAt),
    reviewUserUnique: unique("product_reviews_user_id_unique").on(table.userId),
  })
);

// CONTACT MESSAGE REPLIES — admin replies to contact form messages.
// Filled by POST /api/admin/contact-messages; surfaced to the user in their
// message history (GET /api/contact/messages) and to admins in the dashboard.
export const contactMessageReplies = pgTable(
  "contact_message_replies",
  {
    id: serial("id").primaryKey(),
    messageId: integer("message_id")
      .notNull()
      .references(() => contactMessages.id, { onDelete: "cascade" }),
    adminClerkId: varchar("admin_clerk_id", { length: 255 }).notNull(),
    adminName: varchar("admin_name", { length: 255 }).notNull(),
    reply: text("reply").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    messageIdx: index("idx_contact_message_replies_message").on(table.messageId),
  })
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
  })
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
  })
);

// LANE RUNNER PvP MATCHES — "Lane Rush Duel"
// Server-authoritative two-player race up ONE shared provably-fair
// tower (bad tile per lane per risk path, lane width by difficulty).
// Alternate turns picking a tile in your current lane; safe
// advances, bad busts. DEFERRED REVEAL: picks park until the
// opponent answers the same row, then both reveal together — nobody
// can mirror the other's current-row pick. HOLD freezes your score
// (flag-to-win) and forces the opponent to climb past it or bust.
// 20s pick clock, AFK auto-pick (may bust).
// Status flow: waiting → ready → p1_turn → p2_turn → … → finished
export const laneRunnerPvpStatusEnum = pgEnum("lane_runner_pvp_status", [
  "waiting",
  "ready",
  "p1_turn",
  "p2_turn",
  "finished",
  "cancelled",
]);

export const laneRunnerPvpMatches = pgTable(
  "lane_runner_pvp_matches",
  {
    id: serial("id").primaryKey(),
    player1Id: varchar("player1_id", { length: 255 }).notNull(),
    player2Id: varchar("player2_id", { length: 255 }),
    stakeAmount: numeric("stake_amount", { precision: 10, scale: 2 }).notNull(),
    status: laneRunnerPvpStatusEnum("status").notNull().default("waiting"),
    // Host-picked difficulty at lobby creation (easy/medium/hard).
    // Determines lane width for BOTH towers (4/3/2 tiles) and the
    // per-lane multipliers.
    difficulty: varchar("difficulty", { length: 20 }).notNull(),
    // Server-only towers — one per seat. Shape per tower:
    //   { "lanes": [ { "badTile": 2, "safeTiles": [0,1,3] }, … ] }
    // plus the provably-fair seed bookkeeping. Scrubbed from /status
    // responses until the match finishes.
    p1Tower: jsonb("p1_tower")
      .notNull()
      .default(sql`'{"lanes":[]}'::jsonb`),
    p2Tower: jsonb("p2_tower")
      .notNull()
      .default(sql`'{"lanes":[]}'::jsonb`),
    // Server-decided at match creation (when player2 joins).
    firstPlayerId: varchar("first_player_id", { length: 255 }),
    currentTurnUserId: varchar("current_turn_user_id", { length: 255 }),
    // Each player's current lane index (0-7). Advances on safe pick.
    p1Lane: integer("p1_lane").notNull().default(0),
    p2Lane: integer("p2_lane").notNull().default(0),
    // True once the player chooses HOLD — their lane is frozen and
    // the opponent must climb past it or bust.
    p1Held: boolean("p1_held").notNull().default(false),
    p2Held: boolean("p2_held").notNull().default(false),
    p1Busted: boolean("p1_busted").notNull().default(false),
    p2Busted: boolean("p2_busted").notNull().default(false),
    // Chronological JSONB array of every action. Entry shape:
    //   { userId, seat, action: "pick"|"hold", lane, tileIndex|null,
    //     badTile|null, isBust, autoPicked, at: ISO ts }
    actions: jsonb("actions")
      .notNull()
      .default(sql`'[]'::jsonb`),
    roundDeadline: timestamp("round_deadline"),
    roundTimerSeconds: integer("round_timer_seconds").notNull().default(20),
    winnerId: varchar("winner_id", { length: 255 }),
    result: varchar("result", { length: 20 }), // 'player1' | 'player2' | 'draw' | null
    houseFee: numeric("house_fee", { precision: 10, scale: 2 }).notNull().default("0.00"),
    prizePaid: numeric("prize_paid", { precision: 10, scale: 2 }).notNull().default("0.00"),
    startedAt: timestamp("started_at"),
    endedAt: timestamp("ended_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    statusIdx: index("lane_runner_pvp_status_idx").on(table.status, table.createdAt),
    player1Idx: index("lane_runner_pvp_player1_idx").on(table.player1Id, table.createdAt),
    player2Idx: index("lane_runner_pvp_player2_idx").on(table.player2Id, table.createdAt),
    stakeIdx: index("lane_runner_pvp_stake_open_idx").on(table.stakeAmount, table.status),
  })
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
    // True for free human-vs-server matches. The AI occupies player 2,
    // but never participates in user-balance or payout accounting.
    isAi: boolean("is_ai").notNull().default(false),
    currentRound: integer("current_round").notNull().default(1),
    // Round wins (best of 3 + sudden death). Each round contributes 0
    // (draw), +1 to player1, or +1 to player2.
    scorePlayer1: integer("score_player1").notNull().default(0),
    scorePlayer2: integer("score_player2").notNull().default(0),
    // Live transient state per round (stored on the match row so
    // intermediate submissions survive across the second player's
    // /bet call). The server's `submitBets` writes both seats in
    // place; `resolveRound` clears them at round end. Treat
    // `IS NOT NULL` as "this player has locked in for the current
    // round". Stored on the match row (not the round-history row)
    // because the in-flight round's bets are live state, not
    // history.
    player1Bets: jsonb("player1_bets"),
    player2Bets: jsonb("player2_bets"),
    // ── Skill layer (elimination market + opponent call) ──────────
    // Numbers the server killed for the CURRENT round before betting
    // opened (round 2: 13–24, round 3: 13–36; [] for round 1 and
    // sudden death). Cleared/re-set each round transition.
    serverEliminated: jsonb("server_eliminated"),
    // Player-bought removals for the CURRENT round: { "17": "player1" }
    // (number key → remover side). Shared and visible to both players
    // immediately; cleared at round end.
    eliminations: jsonb("eliminations"),
    // Current round's "call their bet" guesses: { player1: "red",
    // player2: null }. Each player's call is stored when they lock in
    // their bets; resolved (and cleared) when the round resolves.
    calls: jsonb("calls"),
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
    houseFee: numeric("house_fee", { precision: 10, scale: 2 }).notNull().default("0.00"),
    prizePaid: numeric("prize_paid", { precision: 10, scale: 2 }).notNull().default("0.00"),
    // ── Persistent match "points" balance
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
    roundTimerSeconds: integer("round_timer_seconds").notNull().default(25),
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
    statusIdx: index("roulette_pvp_status_idx").on(table.status, table.createdAt),
    player1Idx: index("roulette_pvp_player1_idx").on(table.player1Id, table.createdAt),
    player2Idx: index("roulette_pvp_player2_idx").on(table.player2Id, table.createdAt),
    // Stake matchmaking — finding a waiting lobby whose stake matches
    // the joiner's request. `stake` + `status='waiting'` + player2 null
    // is the canonical query for "join any open match of this stake".
    stakeIdx: index("roulette_pvp_stake_open_idx").on(table.stakeAmount, table.status),
  })
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
    player1Bets: jsonb("player1_bets")
      .notNull()
      .default(sql`'{}'::jsonb`),
    player2Bets: jsonb("player2_bets")
      .notNull()
      .default(sql`'{}'::jsonb`),
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
    player1Payout: numeric("player1_payout", { precision: 10, scale: 2 }).notNull().default("0.00"),
    player2Payout: numeric("player2_payout", { precision: 10, scale: 2 }).notNull().default("0.00"),
    // net = payout − total_bet. Persisted for fast round-resolution
    // queries (the live match state is in roulette_pvp_matches but
    // history is in this table).
    player1Net: numeric("player1_net", { precision: 10, scale: 2 }).notNull().default("0.00"),
    player2Net: numeric("player2_net", { precision: 10, scale: 2 }).notNull().default("0.00"),
    // Round winner — null when the round ended in a draw (identical
    // net result for both players).
    roundWinner: varchar("round_winner", { length: 10 }), // 'player1' | 'player2' | null
    // ── Skill-layer snapshots (what this round looked like) ────────
    serverEliminated: jsonb("server_eliminated"),
    eliminations: jsonb("eliminations"),
    calls: jsonb("calls"),
    callResults: jsonb("call_results"), // { player1: {correct, transfer}, ... }
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    matchRoundIdx: index("roulette_pvp_rounds_match_round_idx").on(
      table.matchId,
      table.roundNumber
    ),
  })
);

export const roulettePvpMatchesRelations = relations(roulettePvpMatches, ({ many }) => ({
  rounds: many(roulettePvpRounds),
}));

export const roulettePvpRoundsRelations = relations(roulettePvpRounds, ({ one }) => ({
  match: one(roulettePvpMatches, {
    fields: [roulettePvpRounds.matchId],
    references: [roulettePvpMatches.id],
  }),
}));

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
    readyDeadlineAt: timestamp("ready_deadline_at"),
    timerSeconds: integer("timer_seconds").notNull().default(20),
    isAiGame: boolean("is_ai_game").notNull().default(false),
    startedAt: timestamp("started_at"),
    endedAt: timestamp("ended_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    dotsStatusIdx: index("dots_and_boxes_status_idx").on(table.status, table.createdAt),
    dotsHostIdx: index("dots_and_boxes_host_idx").on(table.hostClerkId),
    dotsGuestIdx: index("dots_and_boxes_guest_idx").on(table.guestClerkId),
  })
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
  // TIEBREAK round — dealt only when the best-of-3 ends with tied
  // round-wins (migration 0075). Whoever wins it takes the match; a
  // tie on it is a draw refunding 95% per player.
  "round_4",
  "between_rounds",
  "finished",
  "cancelled",
]);

export const blackjackPvpPlayerStateEnum = pgEnum("blackjack_pvp_player_state", [
  "playing",
  "stood",
  "busted",
]);

export const blackjackPvpMatches = pgTable(
  "blackjack_pvp_matches",
  {
    id: serial("id").primaryKey(),
    player1Id: varchar("player1_id", { length: 255 }).notNull(),
    player2Id: varchar("player2_id", { length: 255 }),
    stakeAmount: numeric("stake_amount", { precision: 10, scale: 2 }).notNull(),
    status: blackjackPvpStatusEnum("status").notNull().default("waiting"),
    // True for free human-vs-server matches. The bot occupies seat 2
    // but never participates in user-balance or payout accounting.
    isAi: boolean("is_ai").notNull().default(false),
    roundNumber: integer("round_number").notNull().default(1),
    roundsWonPlayer1: integer("rounds_won_player1").notNull().default(0),
    roundsWonPlayer2: integer("rounds_won_player2").notNull().default(0),
    // Live per-round transient state — both hands stored server-side
    // in JSONB. The match state route scrubs the OPPONENT's hand
    // before returning so cards stay hidden until the round resolves.
    player1Hand: jsonb("player1_hand")
      .notNull()
      .default(sql`'[]'::jsonb`),
    player2Hand: jsonb("player2_hand")
      .notNull()
      .default(sql`'[]'::jsonb`),
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
    player1State: blackjackPvpPlayerStateEnum("player1_state").notNull().default("playing"),
    player2State: blackjackPvpPlayerStateEnum("player2_state").notNull().default("playing"),
    // Server-authoritative shoe. `deck[0]` is the next available card.
    deck: jsonb("deck")
      .notNull()
      .default(sql`'[]'::jsonb`),
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
    player1UsedPeek: integer("player1_used_peek").notNull().default(0),
    player2UsedPeek: integer("player2_used_peek").notNull().default(0),
    player1FrozenCard: jsonb("player1_frozen_card").default(sql`NULL`),
    player2FrozenCard: jsonb("player2_frozen_card").default(sql`NULL`),
    player1HeldResolved: varchar("player1_held_resolved", { length: 10 }).default(sql`NULL`),
    player2HeldResolved: varchar("player2_held_resolved", { length: 10 }).default(sql`NULL`),
    roundDeadline: timestamp("round_deadline"),
    // Final match bookkeeping. `winner` stores the userId of the
    // winning player (replaces the pre-refactor `winner_id`). The
    // side identifier "player1" | "player2" | "draw" continues to
    // live on `result`.
    winner: varchar("winner", { length: 255 }),
    result: varchar("result", { length: 20 }), // 'player1' | 'player2' | 'draw' | null
    houseFee: numeric("house_fee", { precision: 10, scale: 2 }).notNull().default("0.00"),
    prizePaid: numeric("prize_paid", { precision: 10, scale: 2 }).notNull().default("0.00"),
    // Per-round turn-window duration in seconds (mirrors
    // roulette-pvp's `round_timer_seconds`). Match-flow constant:
    // `round_deadline` is computed as `now() + round_timer_seconds`
    // whenever a new betting window opens. Surfaced as a column so
    // future admin tooling can tweak a match's pacing without code.
    roundTimerSeconds: integer("round_timer_seconds").notNull().default(20),
    startedAt: timestamp("started_at"),
    endedAt: timestamp("ended_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    // Lobby listing — `status='waiting'` AND player2_id IS NULL.
    statusIdx: index("blackjack_pvp_status_idx").on(table.status, table.createdAt),
    player1Idx: index("blackjack_pvp_player1_idx").on(table.player1Id, table.createdAt),
    player2Idx: index("blackjack_pvp_player2_idx").on(table.player2Id, table.createdAt),
    // Stake matchmaking — finding a waiting lobby whose stake matches
    // the joiner's request.
    stakeIdx: index("blackjack_pvp_stake_open_idx").on(table.stakeAmount, table.status),
  })
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
    player1Hand: jsonb("player1_hand")
      .notNull()
      .default(sql`'[]'::jsonb`),
    player2Hand: jsonb("player2_hand")
      .notNull()
      .default(sql`'[]'::jsonb`),
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
    player1UsedPeek: integer("player1_used_peek").notNull().default(0),
    player2UsedPeek: integer("player2_used_peek").notNull().default(0),
    player1FrozenCard: jsonb("player1_frozen_card").default(sql`NULL`),
    player2FrozenCard: jsonb("player2_frozen_card").default(sql`NULL`),
    player1HeldResolved: varchar("player1_held_resolved", { length: 10 }).default(sql`NULL`),
    player2HeldResolved: varchar("player2_held_resolved", { length: 10 }).default(sql`NULL`),
    // 'player1' | 'player2' | 'draw' | null
    roundWinner: varchar("round_winner", { length: 10 }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    matchRoundIdx: index("blackjack_pvp_rounds_match_round_idx").on(
      table.matchId,
      table.roundNumber
    ),
  })
);

export const blackjackPvpMatchesRelations = relations(blackjackPvpMatches, ({ many }) => ({
  rounds: many(blackjackPvpRounds),
}));

export const blackjackPvpRoundsRelations = relations(blackjackPvpRounds, ({ one }) => ({
  match: one(blackjackPvpMatches, {
    fields: [blackjackPvpRounds.matchId],
    references: [blackjackPvpMatches.id],
  }),
}));

// MINES PvP MATCHES — server-authoritative two-player "Mines Duel".
// Both players on the same 5×5 board; the HOST picks the mine count
// at lobby creation. The server randomizes turn order at match
// creation (when player2 joins), then each player gets a 20s window
// to pick a single cell. The match resolves after both picks.
//
// Match flow:
//   waiting → ready → p1_turn → p2_turn → finished
//
// Resolution rules (per user spec):
//   P1 mine + P2 mine → P2 loses (P1 mined first)
//   P1 mine + P2 safe → P1 loses
//   P1 safe + P2 mine → P2 loses
//   P1 safe + P2 safe → DRAW (full refund, no house fee)
//
// Payout:
//   Winner: own stake back + 90% of loser's stake
//   Loser:   loses entire stake
//   House:   10% rake on loser's stake only
//   Draw:    both refunded, no rake
//
// Schema conventions match roulette_pvp_matches / blackjack_pvp_matches:
//   * clerkIds stored as varchar(255), no FK to `users`
//   * stake/financials as numeric(10, 2)
//   * pgEnum for `status` keeps the 6 match states strongly typed
//   * `mines_pvp_rounds` cascades from `mines_pvp_matches`
//
// The `board` jsonb column is SERVER-ONLY state. The match-state API
// route scrubs it from /status responses while the match is in
// {waiting, ready, p1_turn, p2_turn} so neither player can inspect
// the mine positions during the match. Once the match reaches
// `finished` the board is exposed to both clients for replay.
export const minesPvpStatusEnum = pgEnum("mines_pvp_status", [
  "waiting",
  "ready",
  "p1_turn",
  "p2_turn",
  "finished",
  "cancelled",
]);

export const memoryGridStatusEnum = pgEnum("memory_grid_status", [
  "waiting",
  "ready",
  "active",
  "finished",
  "cancelled",
]);

export const laneRushDuelStatusEnum = pgEnum("lane_rush_duel_status", [
  "waiting",
  "ready",
  "active",
  "p1_turn",
  "p2_turn",
  "finished",
  "cancelled",
]);

export const minesPvpMatches = pgTable(
  "mines_pvp_matches",
  {
    id: serial("id").primaryKey(),
    player1Id: varchar("player1_id", { length: 255 }).notNull(),
    player2Id: varchar("player2_id", { length: 255 }),
    stakeAmount: numeric("stake_amount", { precision: 10, scale: 2 }).notNull(),
    status: minesPvpStatusEnum("status").notNull().default("waiting"),
    // Host-chosen mine count at lobby creation (1-24, since 25 would
    // be 100% mines and an instant loss for every pick).
    minesCount: integer("mines_count").notNull(),
    // 5×5 board — server-only state. Shape:
    //   { "size": 5, "mines": [3, 7, 12] }
    // where `mines.length === mines_count` and each entry is a unique
    // 0-24 row-major cell index. Scrubbed from /status responses
    // while the match is in {waiting, ready, p1_turn, p2_turn}.
    board: jsonb("board")
      .notNull()
      .default(sql`'{"size":5,"mines":[]}'::jsonb`),
    // Server-decided at match creation (when player2 joins). Either
    // equals `player1Id` or `player2Id`. Null until both players
    // have joined.
    firstPlayerId: varchar("first_player_id", { length: 255 }),
    // clerkId of the player currently being asked to pick. Null
    // when status is in {waiting, ready, finished, cancelled}.
    currentTurnUserId: varchar("current_turn_user_id", { length: 255 }),
    // 0-24 row-major cell index the player picked. Null until the
    // player picks (or gets auto-picked at deadline). In the odds-turn
    // flow each player can have many picks; these scalars hold the
    // MOST RECENT pick from each seat (kept for legacy replays /
    // history views) — the authoritative per-pick history lives on
    // `picks` (see below).
    p1Pick: integer("p1_pick"),
    p2Pick: integer("p2_pick"),
    // Whether the player's pick landed on a mine. Computed at pick
    // time and persisted so post-match replays don't have to walk
    // `board` to render the result. In the odds-turn flow these
    // scalars mirror the most-recent pick's isMine flag (each player
    // can have many picks; full history lives on `picks`).
    p1PickIsMine: boolean("p1_pick_is_mine"),
    p2PickIsMine: boolean("p2_pick_is_mine"),
    // True when the server auto-picked because round_deadline
    // elapsed before the player acted. Persisted for history /
    // replay so spectators can see when a player went AFK.
    p1AutoPicked: boolean("p1_auto_picked").notNull().default(false),
    p2AutoPicked: boolean("p2_auto_picked").notNull().default(false),
    p1PickedAt: timestamp("p1_picked_at"),
    p2PickedAt: timestamp("p2_picked_at"),
    // ── Odds turn system ────────────────────────────────────────
    // Chronologically-ordered JSONB array of every pick made in the
    // match. Each entry shape:
    //   { userId, seat: "player1"|"player2", cell: <0..24>,
    //     isMine: boolean, autoPicked: boolean, pickedAt: ISO ts }
    // Authoritative state — `picks.length` is the turn counter; the
    // server computes the next picker's seat/turn via the closed-
    // form "odds" formula in src/lib/mines-pvp/constants.js
    // (`activePickerForMatch`). Mirrored onto `mines_pvp_rounds.
    // picks` at match resolution for post-match replays. See
    // src/db/migrations/0050_mines_pvp_odds_turns.sql.
    picks: jsonb("picks")
      .notNull()
      .default(sql`'[]'::jsonb`),
    // Pick-window deadline. 20s per spec. The server's
    // `fetchMatchWithAutoResolve` mirrors blackjack-pvp /
    // roulette-pvp: when this timestamp elapses and the active
    // player hasn't picked, auto-pick a random cell.
    roundDeadline: timestamp("round_deadline"),
    // 20 seconds default per spec. Stored on the row for parity
    // with roulette-pvp.round_timer_seconds and admin-tweakable
    // without code changes.
    roundTimerSeconds: integer("round_timer_seconds").notNull().default(20),
    // Final match bookkeeping.
    winnerId: varchar("winner_id", { length: 255 }),
    result: varchar("result", { length: 20 }), // 'player1' | 'player2' | 'draw' | null
    houseFee: numeric("house_fee", { precision: 10, scale: 2 }).notNull().default("0.00"),
    prizePaid: numeric("prize_paid", { precision: 10, scale: 2 }).notNull().default("0.00"),
    isAi: boolean("is_ai").notNull().default(false),
    startedAt: timestamp("started_at"),
    endedAt: timestamp("ended_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    // Lobby listing — `status='waiting'` AND player2_id IS NULL.
    statusIdx: index("mines_pvp_status_idx").on(table.status, table.createdAt),
    player1Idx: index("mines_pvp_player1_idx").on(table.player1Id, table.createdAt),
    player2Idx: index("mines_pvp_player2_idx").on(table.player2Id, table.createdAt),
    // Stake matchmaking — finding a waiting lobby whose stake
    // matches the joiner's request. `stake + status='waiting' +
    // player2 IS NULL` is the canonical "join any open match of
    // this stake" query.
    stakeIdx: index("mines_pvp_stake_open_idx").on(table.stakeAmount, table.status),
  })
);

// Per-match final snapshot. Cascade-deleted with the parent match so
// history stays tidy when a match is purged. `round_winner` mirrors
// the match's `result` column for parity with the other PvP systems
// (e.g., coin_flip best-of-3 also persists `round_winner` even
// though it only ever has one row per match).
export const minesPvpRounds = pgTable(
  "mines_pvp_rounds",
  {
    id: serial("id").primaryKey(),
    matchId: integer("match_id")
      .notNull()
      .references(() => minesPvpMatches.id, { onDelete: "cascade" }),
    roundNumber: integer("round_number").notNull().default(1),
    p1Pick: integer("p1_pick"),
    p2Pick: integer("p2_pick"),
    p1PickIsMine: boolean("p1_pick_is_mine"),
    p2PickIsMine: boolean("p2_pick_is_mine"),
    p1AutoPicked: boolean("p1_auto_picked").notNull().default(false),
    p2AutoPicked: boolean("p2_auto_picked").notNull().default(false),
    // Final board state snapshotted at resolution so post-match
    // replays can render the full mine layout without having to
    // walk the live match row.
    boardSnapshot: jsonb("board_snapshot")
      .notNull()
      .default(sql`'{"size":5,"mines":[]}'::jsonb`),
    // Odds-turn history: full chronological pick list from this
    // match, mirrored at resolution time so post-match replay
    // views can render every tile-pick (every player's every pick)
    // without re-walking the live match row. Shape of each entry
    // matches the `mines_pvp_matches.picks` element shape —
    // see that column for the contract.
    picks: jsonb("picks")
      .notNull()
      .default(sql`'[]'::jsonb`),
    // 'player1' | 'player2' | 'draw' | null
    roundWinner: varchar("round_winner", { length: 10 }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    // Lookup is always "all rounds of match X in order" so a
    // composite index on (match_id, round_number) is the right
    // shape (mirrors roulette_pvp_rounds_match_round_idx).
    matchRoundIdx: index("mines_pvp_rounds_match_round_idx").on(table.matchId, table.roundNumber),
  })
);

export const minesPvpMatchesRelations = relations(minesPvpMatches, ({ many }) => ({
  rounds: many(minesPvpRounds),
}));

export const minesPvpRoundsRelations = relations(minesPvpRounds, ({ one }) => ({
  match: one(minesPvpMatches, {
    fields: [minesPvpRounds.matchId],
    references: [minesPvpMatches.id],
  }),
}));

// ── MEMORY GRID ────────────────────────────────────────────────────────
// Server-authoritative two-player "Memory Grid" — pure pattern
// recall, best-of-5 rounds. Each round deals an N×N grid (3×3 → 5×5
// across the 5 rounds) with a fixed number of active (lit) tiles.
// Every round has exactly two phases, played by each player in turn
// on the SAME server-generated pattern:
//   PHASE 1 — MEMORIZE: the active tiles are revealed to the player
//   whose turn it is for the round's memorize duration (2.5–4s).
//   PHASE 2 — RECONSTRUCT: the pattern hides; the player taps the
//   tiles they remember — ANY number, up to the full grid (there is
//   no pick cap; over-selection is penalised by the full-grid
//   scoring in src/lib/memory-grid/constants.js). Selection locks at
//   submission (or the 15s deadline) and the server scores the
//   player's ENTIRE reconstruction against the pattern.
// After BOTH players complete their reconstruction the round is
// resolved (higher round score wins the round), then the next round
// is dealt. After 5 rounds the player with the higher TOTAL
// cumulative round score wins the match; exactly equal totals →
// DRAW (full refund — the existing PvP tie pattern).
//
// Match flow (mirrors mines_pvp_matches):
//   waiting → ready → active (memorize → reconstruct → result, per
//   round 1..5 — the result phase shows both players the round
//   snapshot for RESULT_WINDOW_MS before the next round opens) →
//   finished
//   (waiting/ready/active → cancelled)
//
// Skill mechanic: the active-tile pattern is server-generated and
// hidden from every client except its own memorize phase (per-viewer
// reveal in the /status route). Payout mirrors Mines Duel: winner
// takes 1.9× their stake (stake back + 90% of the loser's), house
// keeps 0.1×; DRAW refunds both.
export const memoryGridMatches = pgTable(
  "memory_grid_matches",
  {
    id: serial("id").primaryKey(),
    player1Id: varchar("player1_id", { length: 255 }).notNull(),
    player2Id: varchar("player2_id", { length: 255 }),
    stakeAmount: numeric("stake_amount", { precision: 10, scale: 2 }).notNull(),
    status: memoryGridStatusEnum("status").notNull().default("waiting"),
    // True for free human-vs-AI matches. The bot occupies player2Id
    // but is not a real user and must never receive token/stat updates.
    isAi: boolean("is_ai").notNull().default(false),
    // Which phase of the CURRENT round is live. Combined with
    // `status` (p1_turn/p2_turn = whose turn) it fully describes the
    // game: 'memorize' (pattern revealed to the active player) or
    // 'reconstruct' (pattern hidden, active player taps tiles). Null
    // outside active play ({waiting, ready, finished, cancelled}).
    phase: varchar("phase", { length: 20 }),
    // ── Provably-fair seeds (mirrors lane_rush_duel_matches) ─────
    // Shared SERVER seed (32 random hex bytes, crypto-generated at
    // creation) + its committed SHA-256 hash. Every round's pattern
    // derives deterministically from a SHA-256 digest of
    // `${serverSeed}:${matchId}:round:${roundNumber}` → 32-bit seed
    // (see src/lib/memory-grid/seeds.js), so BOTH players get the
    // exact same grid per round and every pattern is independently
    // verifiable. The hash is exposed pre-match and the raw seed is
    // revealed post-match (lane-rush-duel convention).
    serverSeed: varchar("server_seed", { length: 128 }).notNull(),
    serverSeedHash: varchar("server_seed_hash", { length: 64 }).notNull(),
    // The current round's server-authoritative pattern — server-only
    // state. Shape:
    //   { "size": 4, "total": 16, "active": [0, 5, 12, ...] }
    // where `size` is the N×N grid dimension, `total` = size², and
    // `active` holds `roundConfig(roundNumber).activeCount` distinct
    // row-major tile indices (the lit tiles). Generated fresh each
    // round (grid grows 3×3 → 5×5 across the 5 rounds). /status
    // reveals `active` to BOTH players simultaneously during the
    // round's memorize phase, and to both clients once finished.
    board: jsonb("board")
      .notNull()
      .default(sql`'{"size":3,"total":9,"active":[]}'::jsonb`),
    // Whether each seat has submitted (or been AFK auto-locked) for
    // the CURRENT round. Mirrors plinko-pvp's p1_ready/p2_ready
    // synchronized-commit pattern: the round resolves once BOTH are
    // true. Reset to false each round.
    p1Submitted: boolean("p1_submitted").notNull().default(false),
    p2Submitted: boolean("p2_submitted").notNull().default(false),
    // Reconstruction scores for the CURRENT round (correct active
    // tiles picked by each player; null until that player submits).
    // The round winner is decided by comparing these two, then the
    // round is snapshotted into memory_grid_rounds and the next
    // round's pattern is dealt.
    p1RoundScore: integer("p1_round_score").notNull().default(0),
    p2RoundScore: integer("p2_round_score").notNull().default(0),
    // Rounds WON across the match (best-of-5) — a display tally +
    // tiebreak indicator, kept in the scoreboard. A round win +1s
    // the winner's counter; tied rounds award nobody. The MATCH
    // winner is decided on TOTAL cumulative round scores
    // (p1_total/p2_total); equal totals → draw refund.
    p1Score: integer("p1_score").notNull().default(0),
    p2Score: integer("p2_score").notNull().default(0),
    // CUMULATIVE round-score points across the match (each round
    // scores /100, so a 5-round match totals up to 500). Accumulated
    // server-side in completeRound (p1_total += p1_round_score) and
    // served to the compact in-match scoreboard so both players see
    // the running totals (e.g. YOU 247 — OPPONENT 231) alongside
    // rounds-won, matching the points-based PvP scoreboards
    // (lane-rush-duel, keno-pvp).
    p1Total: integer("p1_total").notNull().default(0),
    p2Total: integer("p2_total").notNull().default(0),
    // Current round number (1..ROUNDS_PER_MATCH). Starts at 1 when
    // player2 joins; incremented by the server when a round
    // completes (both players have submitted).
    roundNumber: integer("round_number").notNull().default(1),
    // Chronologically-ordered JSONB array of the CURRENT round's
    // reconstruction submissions (one per player). Each entry shape:
    //   { kind: "reconstruct", userId, seat: "player1"|"player2",
    //     picks: [tileIdx, ...], score: int, autoLocked: bool,
    //     submittedAt: ISO ts }
    // Reset each round; completed rounds are snapshotted into
    // memory_grid_rounds.
    flips: jsonb("flips")
      .notNull()
      .default(sql`'[]'::jsonb`),
    // Phase deadline (absolute). During 'memorize' it's the moment
    // the pattern hides (now + memorizeMs); during 'reconstruct' it's
    // the moment the player's selection locks (now +
    // RECONSTRUCT_DEADLINE_MS). When it elapses and the active player
    // hasn't acted, the server auto-advances via
    // fetchMatchWithAutoResolve (reconstruct → auto-lock with score
    // 0).
    roundDeadline: timestamp("round_deadline"),
    // Reconstruct-window length in seconds (15s default). Stored on
    // the row for parity with mines_pvp_matches.round_timer_seconds
    // and admin-tweakable without code changes. Memorize durations
    // come from ROUND_CONFIGS (they vary per round).
    roundTimerSeconds: integer("round_timer_seconds").notNull().default(15),
    // Final match bookkeeping.
    winnerId: varchar("winner_id", { length: 255 }),
    result: varchar("result", { length: 20 }), // 'player1' | 'player2' | 'draw' | null
    houseFee: numeric("house_fee", { precision: 10, scale: 2 }).notNull().default("0.00"),
    prizePaid: numeric("prize_paid", { precision: 10, scale: 2 }).notNull().default("0.00"),
    startedAt: timestamp("started_at"),
    endedAt: timestamp("ended_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    // Lobby listing — `status='waiting'` AND player2_id IS NULL.
    statusIdx: index("memory_grid_status_idx").on(table.status, table.createdAt),
    player1Idx: index("memory_grid_player1_idx").on(table.player1Id, table.createdAt),
    player2Idx: index("memory_grid_player2_idx").on(table.player2Id, table.createdAt),
    // Stake matchmaking — finding a waiting lobby whose stake
    // matches the joiner's request.
    stakeIdx: index("memory_grid_stake_open_idx").on(table.stakeAmount, table.status),
  })
);

// Per-round final snapshot. Cascade-deleted with the parent match so
// history stays tidy when a match is purged. `round_winner` mirrors
// the round's winner (player1 | player2 | draw) and `board_snapshot`
// + `flips` let post-match replays render every completed round
// without re-walking the live match row (mirrors mines_pvp_rounds).
export const memoryGridRounds = pgTable(
  "memory_grid_rounds",
  {
    id: serial("id").primaryKey(),
    matchId: integer("match_id")
      .notNull()
      .references(() => memoryGridMatches.id, { onDelete: "cascade" }),
    roundNumber: integer("round_number").notNull().default(1),
    // The round's pattern (grid size + active tile indices)
    // snapshotted at completion so post-match replays can render the
    // full layout.
    boardSnapshot: jsonb("board_snapshot")
      .notNull()
      .default(sql`'{"size":3,"total":9,"active":[]}'::jsonb`),
    // Full chronological reconstruction-submission list of the round
    // (one entry per player), mirrored at completion for replay views.
    flips: jsonb("flips")
      .notNull()
      .default(sql`'[]'::jsonb`),
    p1RoundScore: integer("p1_round_score").notNull().default(0),
    p2RoundScore: integer("p2_round_score").notNull().default(0),
    // 'player1' | 'player2' | 'draw' | null
    roundWinner: varchar("round_winner", { length: 10 }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    // Lookup is always "all rounds of match X in order" so a
    // composite index on (match_id, round_number) is the right
    // shape.
    matchRoundIdx: index("memory_grid_rounds_match_round_idx").on(table.matchId, table.roundNumber),
  })
);

export const memoryGridMatchesRelations = relations(memoryGridMatches, ({ many }) => ({
  rounds: many(memoryGridRounds),
}));

export const memoryGridRoundsRelations = relations(memoryGridRounds, ({ one }) => ({
  match: one(memoryGridMatches, {
    fields: [memoryGridRounds.matchId],
    references: [memoryGridMatches.id],
  }),
}));

// LANE RUSH DUEL — server-authoritative two-player "Lane Rush Duel".
// Both players race the SAME shared provably-fair tower (bad tile
// per lane per risk path), alternating turns. On your turn you pick
// one tile in your current lane (safe → advance, bad → bust and
// lose) or you BANK (HOLD) — locks your accumulated points as your
// SAFE score and you KEEP climbing; every pick after your Nth bank
// pays × 0.5^N, and only banked points survive a bust. Picks park
// as pending and reveal together once both players have acted on
// the row (deferred reveal), so neither side can copy the other's
// current-row pick. Each player also gets 2 private PEEKS per match
// (learn if a tile on your current lane is safe or bad, without
// spending your turn) and 2 FLAGS (correct flag claims the row,
// wrong flag busts you) — all budget counts are derived from the
// action history, so no extra columns are needed.
//
// Match flow:
//   waiting → ready → p1_turn / p2_turn → finished
//   (waiting/ready/active → cancelled for AFK cancels)
//
// Resolution (the 1,000-banked race):
//   * WIN: first player to BANK WIN_BANKED_SCORE (1,000) points wins
//     instantly — banking never settles the match, so the race
//     continues at reduced rates until someone locks 1,000
//   * Bust → climb ends; keeps only the banked total (0 if never
//     banked) — unbanked points are lost
//   * Completed all 8 lanes               → completer wins
//   * Fallback when both climbs are over (nobody banked 1,000) →
//     higher final wins; equal → DRAW
//
// Payout (90/10 split, mirrors mines-pvp / roulette-pvp):
//   Winner: own stake back + 90% of loser's stake (1.9× net)
//   Loser:   loses entire stake
//   House:   10% rake on loser's stake only
//   Draw:    both refunded, no rake
//
// Provably fair: the ONE shared tower (the bad tile per lane) is
// derived via SHA-256 from a SHARED server seed + the host's client
// seed + the match id as nonce, and copied to both seats. The
// server seed hash is shown pre-match and the seed revealed
// post-match.
export const laneRushDuelMatches = pgTable(
  "lane_rush_duel_matches",
  {
    id: serial("id").primaryKey(),
    player1Id: varchar("player1_id", { length: 255 }).notNull(),
    player2Id: varchar("player2_id", { length: 255 }),
    stakeAmount: numeric("stake_amount", { precision: 10, scale: 2 }).notNull(),
    status: laneRushDuelStatusEnum("status").notNull().default("waiting"),
    // Host-chosen difficulty at lobby creation; the joiner consumes
    // whatever the host picked (mirrors mines-pvp minesCount).
    difficulty: varchar("difficulty", { length: 20 }).notNull().default("easy"),
    // Tiles per lane = width of the tower at this difficulty.
    tilesPerLane: integer("tiles_per_lane").notNull().default(4),
    // Server-decided at match creation (when player2 joins). Either
    // equals `player1Id` or `player2Id`. Null until both players
    // have joined.
    firstPlayerId: varchar("first_player_id", { length: 255 }),
    // clerkId of the player currently being asked to pick. Null
    // when status is in {waiting, ready, finished, cancelled}.
    currentTurnUserId: varchar("current_turn_user_id", { length: 255 }),
    // ── Provably-fair seeds ─────────────────────────────────────
    // Shared server seed (revealed post-match), per-player client
    // seeds, and the match id as nonce. Each player's tower (bad
    // tile per lane) is re-derivable from these — persisted so
    // post-match reveals can show the full layout without
    // re-derivation.
    serverSeed: varchar("server_seed", { length: 128 }).notNull(),
    serverSeedHash: varchar("server_seed_hash", { length: 64 }).notNull(),
    p1ClientSeed: varchar("p1_client_seed", { length: 128 }).notNull(),
    p2ClientSeed: varchar("p2_client_seed", { length: 128 }),
    // Bad tile per lane for each player (server-only mid-match).
    p1Tower: jsonb("p1_tower")
      .notNull()
      .default(sql`'[]'::jsonb`),
    p2Tower: jsonb("p2_tower")
      .notNull()
      .default(sql`'[]'::jsonb`),
    // Current lane (0..8) + hold flag per seat. lane === 8 means
    // the tower is complete (auto-banked at the top).
    p1Lane: integer("p1_lane").notNull().default(0),
    p2Lane: integer("p2_lane").notNull().default(0),
    p1Held: boolean("p1_held").notNull().default(false),
    p2Held: boolean("p2_held").notNull().default(false),
    // Final score in POINTS per seat (sum of safe-pick points),
    // stamped at resolution so history doesn't re-walk `actions`.
    p1Points: integer("p1_points").notNull().default(0),
    p2Points: integer("p2_points").notNull().default(0),
    // True when the server auto-picked because round_deadline
    // elapsed before the player acted (persisted for history).
    p1AutoPicked: boolean("p1_auto_picked").notNull().default(false),
    p2AutoPicked: boolean("p2_auto_picked").notNull().default(false),
    // Chronological action history: [{ userId, seat, action:
    // "pick"|"hold", tile, safe, lane, multiplier, autoPicked, at }]
    actions: jsonb("actions")
      .notNull()
      .default(sql`'[]'::jsonb`),
    // Pick-window deadline (20s per turn).
    roundDeadline: timestamp("round_deadline"),
    roundTimerSeconds: integer("round_timer_seconds").notNull().default(20),
    // Final match bookkeeping.
    winnerId: varchar("winner_id", { length: 255 }),
    result: varchar("result", { length: 20 }), // 'player1' | 'player2' | 'draw' | null
    houseFee: numeric("house_fee", { precision: 10, scale: 2 }).notNull().default("0.00"),
    prizePaid: numeric("prize_paid", { precision: 10, scale: 2 }).notNull().default("0.00"),
    startedAt: timestamp("started_at"),
    endedAt: timestamp("ended_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    // Lobby listing — `status='waiting'` AND player2_id IS NULL.
    statusIdx: index("lane_rush_duel_status_idx").on(table.status, table.createdAt),
    player1Idx: index("lane_rush_duel_player1_idx").on(table.player1Id, table.createdAt),
    player2Idx: index("lane_rush_duel_player2_idx").on(table.player2Id, table.createdAt),
    // Stake matchmaking — finding a waiting lobby whose stake
    // matches the joiner's request.
    stakeIdx: index("lane_rush_duel_stake_open_idx").on(table.stakeAmount, table.status),
  })
);

// PLINKO PvP MATCHES — server-authoritative two-player "Plinko Duel".
// Both players launch 3 balls on the SAME shared board. The player
// with the higher cumulative base-points across all 3 balls wins
// the match. Per ball, each player commits (start_x, power, angle)
// inputs; the server-side physics engine simulates both balls and
// decides the per-ball outcome (bucket resolution + fall-out
// detection).
//
// Match flow:
//   waiting → ready → ball_1 → ball_2 → ball_3 → finished
//   (waiting/ready/active → cancelled for AFK cancels)
//
// Per-ball scoring (bucket table from `lib/plinko-pvp/constants.js`):
//   Far left safe  (x ∈ [0,100))   → 100 points
//   Left precision (x ∈ [100,200)) → 140 points
//   Center trap    (x ∈ [200,300)) →  40 points
//   Right precision(x ∈ [300,400)) → 140 points
//   Far right safe (x ∈ [400,500)) → 100 points
//   FELL OUT (x < 0 || x > 500 before y reaches bucket row) → 0 points
//
// Payout (90/10 split, mirrors mines-pvp / roulette-pvp):
//   Winner: own stake back + 90% of loser's stake (1.9× net)
//   Loser:   loses entire stake
//   House:   10% rake on loser's stake only
//   Tied:    both refunded, no rake
//
// Schema conventions identical to other PvP tables:
//   * clerkIds stored as varchar(255), no FK to `users`
//   * stake/financials as numeric(10, 2)
//   * pgEnum for `status` keeps the 7 match states strongly typed
//   * `plinko_pvp_rounds` cascades from `plinko_pvp_matches`
//
// Live transient state per ball (p1_current_inputs / p2_current_inputs)
// lives server-side on the match row so turn-mutations are atomic.
// The match state API scrubs the OPPONENT's current_inputs from the
// /status response until status='finished'. Treat
// `p1_current_inputs IS NOT NULL` as "this player has submitted for
// the current ball"; reset to NULL whenever status advances to the
// next ball.
//
// `plinko_pvp_rounds` is a strict HISTORY snapshot — written only
// after a ball resolves. ballNumber ∈ {1, 2, 3}. The per-ball
// `ball_winner` is 'player1' | 'player2' | 'draw'.
export const plinkoPvpStatusEnum = pgEnum("plinko_pvp_status", [
  "waiting",
  "ready",
  "ball_1",
  "ball_2",
  "ball_3",
  "ball_4",
  "finished",
  "cancelled",
]);

// Per-ball outcome (who scored more points for this ball, or tie).
// Distinct from the match-level `winner_id` (which is a clerkId).
// Stored on each `plinko_pvp_rounds` row at resolution time.
export const plinkoPvpBallOutcomeEnum = pgEnum("plinko_pvp_ball_outcome", ["p1", "p2", "tie"]);

export const plinkoPvpMatches = pgTable(
  "plinko_pvp_matches",
  {
    id: serial("id").primaryKey(),
    player1Id: varchar("player1_id", { length: 255 }).notNull(),
    player2Id: varchar("player2_id", { length: 255 }),
    stakeAmount: numeric("stake_amount", { precision: 10, scale: 2 }).notNull(),
    // Free practice match against the reserved AI seat. AI matches never
    // escrow tokens, pay out, or update PvP statistics.
    isAi: boolean("is_ai").notNull().default(false),
    status: plinkoPvpStatusEnum("status").notNull().default("waiting"),
    // 1 / 2 / 3 — which ball the match is collecting inputs for
    // right now. Stamped at match creation and advance+stamp at
    // each ball resolution.
    currentBall: integer("current_ball").notNull().default(1),
    // 3-ball cumulative base-points sums. Live, advanced at each
    // ball resolution. Compared at match end to decide winner.
    p1Score: integer("p1_score").notNull().default(0),
    p2Score: integer("p2_score").notNull().default(0),
    // Live per-ball launch inputs — server-only state. Treat
    // `IS NOT NULL` as "this player has submitted for the current
    // ball". Reset to NULL when status advances to the next ball
    // so the column doubles as a "submitted" boolean.
    p1CurrentInputs: jsonb("p1_current_inputs").default(sql`NULL`),
    p2CurrentInputs: jsonb("p2_current_inputs").default(sql`NULL`),
    // Per-seat "Ready" booleans. Each player clicks Ready in the
    // commit panel; when both are true the ball resolves immediately
    // (server runs `simulateDualBalls` so balls can ball-collide).
    // Reset to false when the match advances to the next ball. The
    // AFK auto-launch path also flips both flags true so resolve
    // fires on the next /status tick — the 20-second timer still
    // acts as a back-stop for players who never click Ready.
    p1Ready: boolean("p1_ready").notNull().default(false),
    p2Ready: boolean("p2_ready").notNull().default(false),
    // Per-ball decision-window deadline. The match-flow constant:
    // `round_deadline` is computed as `now() + round_timer_seconds`
    // whenever a new ball window opens. Surfaced as a column so
    // future admin tooling can tweak per-match pacing without
    // code changes (mirrors mines-pvp / roulette-pvp /
    // blackjack-pvp).
    roundDeadline: timestamp("round_deadline"),
    roundTimerSeconds: integer("round_timer_seconds").notNull().default(20),
    // Final match bookkeeping.
    winnerId: varchar("winner_id", { length: 255 }),
    result: varchar("result", { length: 20 }), // 'player1' | 'player2' | 'draw' | null
    houseFee: numeric("house_fee", { precision: 10, scale: 2 }).notNull().default("0.00"),
    prizePaid: numeric("prize_paid", { precision: 10, scale: 2 }).notNull().default("0.00"),
    startedAt: timestamp("started_at"),
    endedAt: timestamp("ended_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    // Lobby listing — `status='waiting'` AND player2_id IS NULL.
    statusIdx: index("plinko_pvp_status_idx").on(table.status, table.createdAt),
    // Per-player history (matches the mines-pvp / blackjack-pvp
    // / roulette-pvp convention).
    player1Idx: index("plinko_pvp_player1_idx").on(table.player1Id, table.createdAt),
    player2Idx: index("plinko_pvp_player2_idx").on(table.player2Id, table.createdAt),
    // Stake matchmaking — finding a waiting lobby whose stake
    // matches the joiner's request. Same shape as the other PvP
    // stake_open_idx columns.
    stakeIdx: index("plinko_pvp_stake_open_idx").on(table.stakeAmount, table.status),
  })
);

// One row per ball of a Plinko Duel match (3 rows per match).
// Cascade-deleted with the parent match so history stays tidy.
// Inputs/result jsonb shapes (kept in sync with the physics
// engine contract in `lib/plinko-pvp/physics.js`):
//   inputs:  { start_x, power, angle, autoLaunched }
//   result:  { bucket: 0..4|null, points: 0|40|100|140,
//              fellOut, finalX, finalY, path: [{ x, y }, ...] }
export const plinkoPvpRounds = pgTable(
  "plinko_pvp_rounds",
  {
    id: serial("id").primaryKey(),
    matchId: integer("match_id")
      .notNull()
      .references(() => plinkoPvpMatches.id, { onDelete: "cascade" }),
    // 1 / 2 / 3. Composite index on (match_id, ball_number) is
    // the canonical lookup so per-ball history reads stay O(1).
    ballNumber: integer("ball_number").notNull(),
    // Inputs in their pre-simulation form. Stored exactly as the
    // player committed them so replay can show the original
    // inputs even after a future feature changes bucketing rules.
    player1Inputs: jsonb("player1_inputs")
      .notNull()
      .default(sql`'{}'::jsonb`),
    player2Inputs: jsonb("player2_inputs")
      .notNull()
      .default(sql`'{}'::jsonb`),
    // Per-ball result snapshots — bucket index, base points,
    // fall-out flag, final x/y, and full animation path. The
    // `path` array lets the client re-play the ball drop
    // identically without re-running the physics simulation.
    player1Result: jsonb("player1_result")
      .notNull()
      .default(sql`'{}'::jsonb`),
    player2Result: jsonb("player2_result")
      .notNull()
      .default(sql`'{}'::jsonb`),
    // True when the server auto-launched because round_deadline
    // elapsed before the player committed. Persisted for history
    // and replay so a spectator can see when a player went AFK.
    player1AutoLaunched: boolean("player1_auto_launched").notNull().default(false),
    player2AutoLaunched: boolean("player2_auto_launched").notNull().default(false),
    // Per-ball base-points awarded. Same values as
    // player{1,2}_result.points at resolution time, exposed as
    // a column so aggregate-totals queries can sum without
    // unpacking jsonb.
    ballPointsPlayer1: integer("ball_points_player1").notNull().default(0),
    ballPointsPlayer2: integer("ball_points_player2").notNull().default(0),
    // Per-ball outcome ('player1' | 'player2' | 'draw') — null
    // while the ball is in flight. NOTE: match-level `result`
    // is the AGGREGATE across all 3 balls, so per-ball `draw`
    // here does NOT mean the whole match is a tie.
    ballOutcome: plinkoPvpBallOutcomeEnum("ball_outcome"), // 'p1' | 'p2' | 'tie' | null
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    matchBallIdx: index("plinko_pvp_rounds_match_ball_idx").on(table.matchId, table.ballNumber),
  })
);

// Drizzle relations — declared after the tables so all symbols
// are bound before `relations(...)` runs. Relations are read at
// query time, not module-load, so the position is purely about
// lexical ordering for the TS compiler.
export const plinkoPvpMatchesRelations = relations(plinkoPvpMatches, ({ many }) => ({
  rounds: many(plinkoPvpRounds),
}));

export const plinkoPvpRoundsRelations = relations(plinkoPvpRounds, ({ one }) => ({
  match: one(plinkoPvpMatches, {
    fields: [plinkoPvpRounds.matchId],
    references: [plinkoPvpMatches.id],
  }),
}));

// ── KENO PvP ("Keno Catch Duel") ─────────────────────────────────────
// 1v1 skill keno: both players face the SAME shared 10-ball draw each
// round and race to catch the balls on the server-declared release
// schedule. First to 10 cumulative points takes the match; the higher
// total wins (tie → full refund) after the 5-round hard cap. Payout
// is the standard 90/10 split.
//
// Match flow: waiting → ready → round_1 … round_16 → overtime →
// finished (waiting/ready/round_N/overtime → cancelled). After the
// 3-minute match clock, a 30s overtime settles by most tiles (tie →
// 95% refund each). Mirrors slots_pvp (match + rounds child table,
// jsonb draws/catches, round deadline + timer).
export const kenoPvpStatusEnum = pgEnum("keno_pvp_status", [
  "waiting",
  "ready",
  "round_1",
  "round_2",
  "round_3",
  "round_4",
  "round_5",
  "round_6",
  "round_7",
  "round_8",
  "round_9",
  "round_10",
  "round_11",
  "round_12",
  "round_13",
  "round_14",
  "round_15",
  "round_16",
  "overtime",
  "finished",
  "cancelled",
]);

export const kenoPvpMatches = pgTable(
  "keno_pvp_matches",
  {
    id: serial("id").primaryKey(),
    player1Id: varchar("player1_id", { length: 255 }).notNull(),
    player2Id: varchar("player2_id", { length: 255 }),
    stakeAmount: numeric("stake_amount", { precision: 10, scale: 2 }).notNull(),
    status: kenoPvpStatusEnum("status").notNull().default("waiting"),
    // True for free human-vs-AI matches. The bot occupies player2Id
    // but is not a real user and must never receive token/stat updates.
    isAi: boolean("is_ai").notNull().default(false),
    // 1 / 2 / 3 / 4 / 5 — which round the match is collecting catches
    // for right now. Stamped at match creation and advanced at each
    // round resolution.
    currentRound: integer("current_round").notNull().default(1),
    // Match score — rounds won by each player (first to 3 wins).
    roundsWonPlayer1: integer("rounds_won_player1").notNull().default(0),
    roundsWonPlayer2: integer("rounds_won_player2").notNull().default(0),
    // Aggregate round scores across all rounds. Compared at match end
    // to break a rounds-won tie.
    p1Score: integer("p1_score").notNull().default(0),
    p2Score: integer("p2_score").notNull().default(0),
    // The CURRENT round's shared draw — array of 10 unique ball numbers
    // (1..KENO_POOL_SIZE). Server-generated when the round opens; ball
    // release timing is derived from `round_deadline` + the shared
    // constants (see src/lib/keno-pvp/constants.js), so both players
    // see the identical stream.
    currentDraw: jsonb("current_draw").default(sql`NULL`),
    // Per-round catch commits — array of { number, quality, caughtAt }
    // for the CURRENT round. Server-authoritative; one catch per ball
    // per player. Reset when the next round opens.
    p1Catches: jsonb("p1_catches").default(sql`NULL`),
    p2Catches: jsonb("p2_catches").default(sql`NULL`),
    // Per-round decision-window deadline = round open time +
    // ROUND_DURATION_MS (the 10-ball release schedule plus the final
    // ball's expiry). Mirrors slots-pvp's round_deadline semantics.
    roundDeadline: timestamp("round_deadline"),
    roundTimerSeconds: integer("round_timer_seconds").notNull().default(15),
    // Final match bookkeeping.
    winnerId: varchar("winner_id", { length: 255 }),
    result: varchar("result", { length: 20 }), // 'player1' | 'player2' | 'draw' | null
    houseFee: numeric("house_fee", { precision: 10, scale: 2 }).notNull().default("0.00"),
    prizePaid: numeric("prize_paid", { precision: 10, scale: 2 }).notNull().default("0.00"),
    startedAt: timestamp("started_at"),
    endedAt: timestamp("ended_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    statusIdx: index("keno_pvp_status_idx").on(table.status, table.createdAt),
    player1Idx: index("keno_pvp_player1_idx").on(table.player1Id, table.createdAt),
    player2Idx: index("keno_pvp_player2_idx").on(table.player2Id, table.createdAt),
    stakeIdx: index("keno_pvp_stake_open_idx").on(table.stakeAmount, table.status),
  })
);

// One row per round of a Keno PvP match (up to 5 rows per match).
// Cascade-deleted with the parent match so history stays tidy.
export const kenoPvpRounds = pgTable(
  "keno_pvp_rounds",
  {
    id: serial("id").primaryKey(),
    matchId: integer("match_id")
      .notNull()
      .references(() => kenoPvpMatches.id, { onDelete: "cascade" }),
    // 1 / 2 / 3 / 4 / 5. Composite index on (match_id, round_number) is
    // the canonical lookup so per-round history reads stay O(1).
    roundNumber: integer("round_number").notNull(),
    // The shared draw for this round (server-generated, both players
    // see the identical stream).
    sharedDraw: jsonb("shared_draw")
      .notNull()
      .default(sql`'[]'::jsonb`),
    // Per-player catch snapshots — { number, quality, caughtAt } per
    // caught ball. Lets the client replay the round identically.
    player1Catches: jsonb("player1_catches")
      .notNull()
      .default(sql`'[]'::jsonb`),
    player2Catches: jsonb("player2_catches")
      .notNull()
      .default(sql`'[]'::jsonb`),
    // Per-round scores — exposed as columns so aggregate-totals
    // queries can sum without unpacking jsonb.
    player1Score: integer("player1_score").notNull().default(0),
    player2Score: integer("player2_score").notNull().default(0),
    // 'player1' | 'player2' | 'draw' | null — null while the round is
    // unresolved. NOTE: match-level `result` is decided by ROUNDS WON,
    // so a per-round `draw` does NOT mean the whole match is a tie.
    roundWinner: varchar("round_winner", { length: 10 }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    matchRoundIdx: index("keno_pvp_rounds_match_round_idx").on(table.matchId, table.roundNumber),
  })
);

export const kenoPvpMatchesRelations = relations(kenoPvpMatches, ({ many }) => ({
  rounds: many(kenoPvpRounds),
}));

export const kenoPvpRoundsRelations = relations(kenoPvpRounds, ({ one }) => ({
  match: one(kenoPvpMatches, {
    fields: [kenoPvpRounds.matchId],
    references: [kenoPvpMatches.id],
  }),
}));

// STRIPE TOKEN PURCHASES
// ==============================================================================
//
// Virtual-token top-up economy. Tokens are NOT a second currency — they live
// in the existing `users.balance` column and are bought with real money via
// Stripe Checkout. Two tables back up the flow:
//
//   * token_packages            — the purchasable catalog (server-resolved
//     price -> token amount). Admin-managed; every Stripe session derives its
//     price from a row here, never from the client.
//   * stripe_checkout_sessions  — durable ledger of every Checkout Session we
//     create. `session_id` is UNIQUE so webhook events are idempotent at the
//     database level (a replay can never double-credit). `fulfilled` flips
//     exactly once when tokens are credited.
//
// Creating sessions and crediting `users.balance` are server-authoritative
// only. See src/lib/tokens/creditTokens.ts (shared credit authority) and
// src/app/api/stripe/* (checkout + webhook routes).

export const tokenPackages = pgTable(
  "token_packages",
  {
    id: serial("id").primaryKey(),
    // Stable slug used in URLs, session metadata and admin tooling.
    key: varchar("key", { length: 120 }).notNull().unique(),
    name: varchar("name", { length: 255 }).notNull(),
    tokenAmount: bigint("token_amount", { mode: "number" }).notNull(),
    // Optional bonus tokens awarded on top of tokenAmount.
    bonusTokens: bigint("bonus_tokens", { mode: "number" }).notNull().default(0),
    priceCents: integer("price_cents").notNull(),
    // Real Stripe Product + one-time Price ids backing this package. Populated
    // (created/persisted) lazily by src/lib/stripe/packages.ts the first time
    // the package is purchased, so every sale references a real Stripe price
    // rather than a client-trusted inline one. Both are nullable — empty means
    // "not yet created in Stripe".
    stripeProductId: varchar("stripe_product_id", { length: 255 }),
    stripePriceId: varchar("stripe_price_id", { length: 255 }),
    badge: varchar("badge", { length: 40 }),
    enabled: boolean("enabled").notNull().default(true),
    // Marketing flag to highlight the recommended / best-value offer in the shop.
    // Purely cosmetic positioning — it changes no price, award, or logic.
    featured: boolean("featured").notNull().default(false),
    // One-time-only offer: each user can buy this package at most once.
    // Enforced server-side in /api/stripe/checkout against fulfilled ledger
    // rows; the Shop also swaps the buy button for a "Purchased" state.
    oneTime: boolean("one_time").notNull().default(false),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    sortIdx: index("token_packages_sort_idx").on(table.enabled, table.sortOrder),
  })
);

export const stripeCheckoutSessions = pgTable(
  "stripe_checkout_sessions",
  {
    id: serial("id").primaryKey(),
    // Stripe's Checkout Session id; UNIQUE so webhook credit is DB-idempotent.
    sessionId: varchar("session_id", { length: 128 }).notNull().unique(),
    // Stripe PaymentIntent + Customer ids, captured from the completed session
    // for reconciliation / disputes. Null until the charge/async completes.
    paymentIntentId: varchar("payment_intent_id", { length: 255 }),
    customerId: varchar("customer_id", { length: 255 }),
    clerkId: varchar("clerk_id", { length: 255 }).notNull(),
    packageKey: varchar("package_key", { length: 120 }),
    // Stripe Checkout mode: 'payment' (one-time top-up) or 'subscription'.
    sessionMode: varchar("session_mode", { length: 20 }).notNull().default("payment"),
    tokenAmount: bigint("token_amount", { mode: "number" }).notNull().default(0),
    amountCents: integer("amount_cents").notNull(),
    currency: varchar("currency", { length: 3 }).notNull().default("usd"),
    paymentStatus: varchar("payment_status", { length: 30 }).notNull().default("open"),
    fulfilled: boolean("fulfilled").notNull().default(false),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    clerkIdx: index("stripe_checkout_sessions_clerk_idx").on(table.clerkId, table.createdAt),
    fulfilledIdx: index("stripe_checkout_sessions_fulfilled_idx").on(
      table.fulfilled,
      table.sessionId
    ),
  })
);

// GRYND+ TOKEN SUBSCRIPTIONS
// ==============================================================================
// Recurring monthly token grants backed by Stripe Billing. Three tables back
// the flow (same server-authoritative rules as the one-time economy):
//
//   * token_subscription_plans   — the purchasable subscription catalog
//     (monthly token grant + price). Admin-managed; mirrors token_packages.
//   * token_subscriptions        — one row per Stripe subscription with its
//     lifecycle status. `stripe_subscription_id` is UNIQUE so webhook replays
//     can never create duplicates.
//   * token_subscription_credits — per-invoice grant ledger; `stripe_invoice_id`
//     is UNIQUE so a replayed `invoice.paid` webhook can never double-credit
//     a month. Tokens are granted per paid invoice (including the first),
//     never at checkout time.

// Catalog of subscription offers (Grynd+ membership). Mirrors token_packages:
// server-resolved price -> monthly token grant.
export const tokenSubscriptionPlans = pgTable(
  "token_subscription_plans",
  {
    id: serial("id").primaryKey(),
    // Stable slug used in URLs, session metadata and admin tooling.
    key: varchar("key", { length: 120 }).notNull().unique(),
    name: varchar("name", { length: 255 }).notNull(),
    // Monthly token grant, credited once per paid invoice (webhook).
    monthlyTokens: bigint("monthly_tokens", { mode: "number" }).notNull(),
    priceCents: integer("price_cents").notNull(),
    // Real Stripe Product + recurring Price ids backing this plan. Populated
    // lazily by src/lib/stripe/subscriptions.ts on first subscribe (mirrors
    // token_packages). Nullable — empty means "not yet created in Stripe".
    stripeProductId: varchar("stripe_product_id", { length: 255 }),
    stripePriceId: varchar("stripe_price_id", { length: 255 }),
    badge: varchar("badge", { length: 40 }),
    // Benefit list rendered on the Shop membership card (sales copy; each
    // perk is implemented behind the active-subscription check).
    perks: text("perks").array().notNull().default([]),
    enabled: boolean("enabled").notNull().default(true),
    // Marketing flag to highlight the recommended plan. Cosmetic only.
    featured: boolean("featured").notNull().default(false),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    sortIdx: index("token_subscription_plans_sort_idx").on(
      table.enabled,
      table.sortOrder
    ),
  })
);

// One row per Stripe subscription (lifecycle mirror). `stripe_subscription_id`
// is UNIQUE so webhook events are idempotent at the database level.
export const tokenSubscriptions = pgTable(
  "token_subscriptions",
  {
    id: serial("id").primaryKey(),
    clerkId: varchar("clerk_id", { length: 255 }).notNull(),
    planKey: varchar("plan_key", { length: 120 }).notNull(),
    stripeSubscriptionId: varchar("stripe_subscription_id", {
      length: 255,
    }).notNull().unique(),
    customerId: varchar("customer_id", { length: 255 }),
    // Stripe subscription status: active | trialing | past_due | canceled |
    // incomplete | unpaid | paused.
    status: varchar("status", { length: 30 }).notNull().default("active"),
    currentPeriodStart: timestamp("current_period_start"),
    currentPeriodEnd: timestamp("current_period_end"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    clerkIdx: index("token_subscriptions_clerk_idx").on(
      table.clerkId,
      table.status
    ),
  })
);

// Per-invoice grant ledger. `stripe_invoice_id` is UNIQUE so each paid
// invoice credits exactly once — a replayed `invoice.paid` webhook is a no-op.
export const tokenSubscriptionCredits = pgTable(
  "token_subscription_credits",
  {
    id: serial("id").primaryKey(),
    clerkId: varchar("clerk_id", { length: 255 }).notNull(),
    planKey: varchar("plan_key", { length: 120 }).notNull(),
    stripeInvoiceId: varchar("stripe_invoice_id", { length: 255 }).notNull().unique(),
    amount: bigint("amount", { mode: "number" }).notNull(),
    periodStart: timestamp("period_start"),
    periodEnd: timestamp("period_end"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    clerkIdx: index("token_subscription_credits_clerk_idx").on(
      table.clerkId,
      table.createdAt
    ),
  })
);

// TOKEN TRANSACTION HISTORY
// ==============================================================================
// Durable, auditable record of every token credit/debit flowing through the
// virtual-token economy (Stripe purchases, subscription grants, and any shop
// spend added later).
// One row per token-mutating operation, written inside the same database
// transaction as the balance change so the ledger can never disagree with
// `users.balance`. `type = 'purchase'` rows carry the Stripe session id as
// their reference for reconciliation.

export const tokenTransactionTypeEnum = pgEnum("token_transaction_type", [
  "purchase",
  "spend",
  "refund",
]);

export const tokenTransactions = pgTable(
  "token_transactions",
  {
    id: serial("id").primaryKey(),
    clerkId: varchar("clerk_id", { length: 255 }).notNull(),
    type: tokenTransactionTypeEnum("type").notNull(),
    // Signed delta (− spend, + purchase/refund).
    amount: bigint("amount", { mode: "number" }).notNull(),
    // Where this change came from — e.g. a Stripe Checkout Session id.
    referenceType: varchar("reference_type", { length: 40 }),
    referenceId: varchar("reference_id", { length: 128 }),
    note: text("note"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    userIdx: index("token_transactions_user_idx").on(table.clerkId, table.createdAt),
    refIdx: index("token_transactions_ref_idx").on(table.referenceType, table.referenceId),
  })
);
