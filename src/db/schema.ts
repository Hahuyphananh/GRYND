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
    // LEGACY priority-matchmaking flag. Always false now — GRYND PRO grants no
    // matchmaking advantage, so membership can never affect who you're paired
    // with. Kept for backward-compatible reads.
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
  // Legacy progression counters. The Battle Pass that drove them has been
  // removed; the columns remain for historical data and are no longer
  // advanced by any progression system.
  level: integer("level").default(1).notNull(),
  xp: integer("xp").default(0).notNull(),
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
  lastDailyRewardClaimed: date("last_daily_reward_claimed"),
  pvpWins: integer("pvp_wins").default(0).notNull(),
  weeklyWagered: bigint("weekly_wagered", { mode: "number" }).default(0).notNull(),
  weeklyWon: bigint("weekly_won", { mode: "number" }).default(0).notNull(),
  weeklyProfit: bigint("weekly_profit", { mode: "number" }).default(0).notNull(),
  weeklyWins: integer("weekly_wins").default(0).notNull(),
  // Result-screen progression (written by applyLeaderboardCounters on every
  // settled wager — see migration 0151): the XP the last settlement granted
  // (wager XP × active boost) and the weekly win/loss delta it applied, so
  // result screens can show real "+N XP" and "RANK ↑ N" numbers without
  // per-game payload changes. last_settled_xp_at gates freshness — a stale
  // grant (old match, Monday weekly reset) is never shown as this match's.
  lastSettledXp: integer("last_settled_xp"),
  lastSettledXpAt: timestamp("last_settled_xp_at"),
  lastSettledWinsDelta: integer("last_settled_wins_delta").default(0).notNull(),
  lastSettledLossesDelta: integer("last_settled_losses_delta").default(0).notNull(),
  // Daily responsible-play counters (UTC day). daily_net = daily_won -
  // daily_wagered mirrors the bet-history tokenDiff sum the daily-loss
  // guard used to compute. Written only on real-money settlement
  // (leaderboardCounters.js + the PvP server stores) and reset to 0 at
  // midnight UTC by GET /api/jobs/daily-reset.
  dailyWagered: bigint("daily_wagered", { mode: "number" }).default(0).notNull(),
  dailyWon: bigint("daily_won", { mode: "number" }).default(0).notNull(),
  selectedTitle: text("selected_title").default(null),
  highestTitle: text("highest_title").default(null),
  selectedSpecialTitle: text("selected_special_title").default(null),
  selectedStreakType: varchar("selected_streak_type", { length: 10 }).default(null),
  // Custom chat name color (GRYND PRO perk). Only settable by active members —
  // enforced in /api/user/chat-color. Null = default color.
  chatColor: varchar("chat_color", { length: 7 }),
  // GRYND PRO profile accent.
  // Only writable by active members — enforced in
  // /api/user/profile-customization. Null = default styling.
  profileAccent: varchar("profile_accent", { length: 7 }),
  // Official Grynd icon the user has equipped. Resolved through the
  // official icon catalog (src/lib/icons.ts) — never an arbitrary URL.
  // Defaults to the official default icon key; NULL/invalid/disabled
  // values fall back to the default at read time.
  selectedIcon: varchar("selected_icon", { length: 120 }).default("default"),
  // Official Grynd name glow the user has equipped (catalog-granted,
  // catalog-backed). NULL = no glow. Resolved through the `glows` catalog
  // (src/lib/glows.ts) — never an arbitrary client-supplied color.
  selectedGlow: varchar("selected_glow", { length: 120 }),
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
  // Equipped cosmetics (framed map of category → cosmetic key). Touchable
  // ONLY through src/lib/cosmetics.ts equip/clear after catalog + ownership
  // validation — never directly writable by the client. Mirrors the
  // selected_glow / selected_icon catalog-backed equip pattern.
  equippedCosmetics: jsonb("equipped_cosmetics")
    .$type<Record<string, string>>()
    .notNull()
    .default(sql`'{}'::jsonb`),
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
  // Onboarding QUESTIONNAIRE completion (migration 0157) — the short
  // preference questionnaire, deliberately tracked separately from the
  // welcome tutorial above: neither state implies the other, and submitting
  // answers never marks the tutorial complete. NULL = never answered.
  // Written only through /api/onboarding/questionnaire. The answers
  // themselves live in onboardingResponses (one row per answer).
  questionnaireCompletedAt: timestamp("questionnaire_completed_at"),
  // Server-authoritative "Maybe Later" for the questionnaire invitation
  // (migration 0158). Set the first time a player dismisses the invitation
  // through /api/onboarding/questionnaire/dismiss, so it is never shown
  // again on any device/session. NULL = never dismissed (eligible for the
  // invitation). Independent of questionnaireCompletedAt: declining is not
  // answering.
  questionnaireDismissedAt: timestamp("questionnaire_dismissed_at"),
  isAdmin: boolean("is_admin").notNull().default(false),
  isBanned: boolean("is_banned").notNull().default(false),
});

// ONBOARDING QUESTIONNAIRE RESPONSES — one row per answered option, keyed by
// the stable ids exported from src/lib/onboardingQuestionnaire.js (a
// multi-select question simply has several rows). Nothing localized is ever
// persisted, so copy can be re-worded/re-translated without a migration.
// Written only by /api/onboarding/questionnaire, which replaces a user's
// answers atomically (delete + insert in one transaction), so the unique
// index below can never be hit by a legitimate submission.
export const onboardingResponses = pgTable(
  "onboarding_responses",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    questionKey: varchar("question_key", { length: 64 }).notNull(),
    answer: varchar("answer", { length: 64 }).notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    uniqueAnswerIdx: unique("onboarding_responses_unique_answer_idx").on(
      table.userId,
      table.questionKey,
      table.answer,
    ),
    userIdx: index("onboarding_responses_user_idx").on(
      table.userId,
      table.questionKey,
    ),
  }),
);

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

// PER-GAME ACTIVE PLAYER PRESENCE — the casino lobby's “N playing” badge.
//
// One row per (user, game): the heartbeat UPSERTs on that pair, so repeated
// beats are idempotent and multiple tabs/devices can never double-count a
// player. `game_key` holds the CANONICAL game id (the lobby's leaderboardKey
// — the same ids src/lib/gameTags.js exports); game pages report their own
// gameLabel and src/lib/gamePresence.js resolves it server-side.
//
// A row is "active" only while last_seen_at is inside the activity window
// (ACTIVE_PLAYER_WINDOW_SECONDS = 3 min), so a closed tab/crashed browser ages
// out on its own — no explicit leave required. Only the game page's own
// heartbeat writes here: the app-wide PresenceHeartbeat deliberately does not,
// which is what keeps a stale in-game marker from living forever.
//
// `session_id` is the client tab/session id and is NOT part of the unique key;
// it lets one tab leaving clear only its own row rather than a still-open
// second tab's presence.
//
// The table itself predates this feature (migration 0012) and is re-asserted
// idempotently by migration 0159.
export const userGamePresence = pgTable(
  "user_game_presence",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    gameKey: varchar("game_key", { length: 80 }).notNull(),
    gameId: integer("game_id"),
    sessionId: varchar("session_id", { length: 128 }),
    lastSeenAt: timestamp("last_seen_at").notNull().defaultNow(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    // One active row per (user, game) — the heartbeat's conflict target.
    userGameUnique: unique("user_game_presence_user_game_unique").on(
      table.userId,
      table.gameKey
    ),
    // The aggregate's access path: count active rows grouped by game.
    gameSeenIdx: index("user_game_presence_game_idx").on(table.gameKey, table.lastSeenAt),
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

// TOKEN-PRICED ITEM SHOP — consumable inventory + timed effects
// ==============================================================================
// Items are bought with tokens (users.balance) and have no cash value. The
// buy route debits the balance and writes a `spend` row to token_transactions
// in the same transaction. Consumables (streak shields, quest boosts) sit in
// user_items with a qty and are auto-consumed by game hooks; timed boosts
// (2× XP) live in user_item_effects with an expiry — repurchasing EXTENDS
// the window instead of stacking a second row.
export const userItems = pgTable(
  "user_items",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    itemKey: varchar("item_key", { length: 64 }).notNull(),
    qty: integer("qty").notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    uniqUserItem: unique("user_items_user_item_unique").on(table.userId, table.itemKey),
    userItemIdx: index("user_items_user_idx").on(table.userId),
  })
);

export const userItemEffects = pgTable(
  "user_item_effects",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    effectKey: varchar("effect_key", { length: 64 }).notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    uniqUserEffect: unique("user_item_effects_user_effect_unique").on(
      table.userId,
      table.effectKey
    ),
    userEffectIdx: index("user_item_effects_user_idx").on(table.userId),
  })
);

// COSMETIC CATALOG + OWNERSHIP (token-priced, server-authoritative)
// ==============================================================================
// Catalog rows are display-only to the client (GET /api/cosmetics); purchase
// (POST /api/cosmetics/buy) and equip (POST /api/cosmetics/equip) always
// re-resolve the row server-side. `price_tokens` IS NULL on non-shop items
// catalog items are `price_tokens IS NULL` non-shop items. Categories are the
// shop's "Cosmetics" section and the profile/chat/render surfaces:
// profile_frame, badge, avatar_effect, username_effect, chat_effect,
// profile_glow, elite_effect.
export const cosmetics = pgTable(
  "cosmetics",
  {
    id: serial("id").primaryKey(),
    key: varchar("key", { length: 120 }).notNull().unique(),
    name: varchar("name", { length: 255 }).notNull(),
    description: text("description").notNull().default(""),
    category: varchar("category", { length: 40 }).notNull(),
    rarity: varchar("rarity", { length: 40 }).notNull().default("Common"),
    priceTokens: integer("price_tokens"),
    visual: jsonb("visual").$type<Record<string, unknown>>().notNull().default({}),
    unlockCondition: varchar("unlock_condition", { length: 40 }),
    enabled: boolean("enabled").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    catalogIdx: index("cosmetics_catalog_idx").on(table.enabled, table.category, table.sortOrder),
  })
);

// Cosmetic ownership. Written only by server-side grants (shop purchase /
// account-creation catalog grant) — never by the client.
export const userCosmetics = pgTable(
  "user_cosmetics",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    cosmeticKey: varchar("cosmetic_key", { length: 120 }).notNull(),
    source: varchar("source", { length: 40 }).notNull().default("shop"),
    unlockedAt: timestamp("unlocked_at").notNull().defaultNow(),
  },
  (table) => ({
    uniqUserCosmetic: unique("user_cosmetics_user_key_unique").on(table.userId, table.cosmeticKey),
    userIdx: index("user_cosmetics_user_idx").on(table.userId),
  })
);
// Per-game play counter (casino lobby "Most Played" sort). One row per
// game label; incremented by /api/game-plays POST when a real game session
// starts (see migration 0152).
export const gamePlays = pgTable("game_plays", {
  id: serial("id").primaryKey(),
  gameLabel: varchar("game_label", { length: 64 }).notNull().unique(),
  plays: integer("plays").notNull().default(0),
  lastPlayedAt: timestamp("last_played_at"),
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

// OFFICIAL GRYND NAME GLOW CATALOG + OWNERSHIP
// ==============================================================================
// Mirrors the icons ownership pattern: a catalog table (each row is a fixed
// named color), a per-user ownership join table, and an equipped-item column
// on `users` (selected_glow). The equipped glow's hex renders on the user's
// name in chat, outranking the GRYND PRO free-form chat_color when both are
// set. `price_tokens` is reserved for a future token shop (NULL = not for
// sale).
export const glows = pgTable("glows", {
  id: serial("id").primaryKey(),
  // Stable slug used to own + equip the glow (matches the `key` in the glow
  // catalog).
  key: varchar("key", { length: 120 }).notNull().unique(),
  name: varchar("name", { length: 255 }).notNull(),
  description: text("description").notNull().default(""),
  // The hex color rendered on the name (e.g. "#00e5ff"). Trusted catalog
  // data — never accepted from clients.
  color: varchar("color", { length: 7 }).notNull(),
  rarity: varchar("rarity", { length: 40 }).notNull().default("Common"),
  // Reserved for the future token shop; not used for charging yet.
  priceTokens: integer("price_tokens"),
  enabled: boolean("enabled").notNull().default(true),
  isDefault: boolean("is_default").notNull().default(false),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const userGlows = pgTable(
  "user_glows",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    glowKey: varchar("glow_key", { length: 120 }).notNull(),
    unlockedAt: timestamp("unlocked_at").notNull().defaultNow(),
  },
  (table) => ({
    uniqUserGlow: index("user_glows_user_glow_idx").on(table.userId, table.glowKey),
  })
);

// OFFICIAL GRYND ANIMATED EMOTE CATALOG + OWNERSHIP + LOADOUT
// ==============================================================================
// Catalog table, a per-user ownership join table, and an ordered loadout
// column on `users`. Emote keys
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

// PER-GAME ELO RATINGS
// ==============================================================================
// One independent Elo rating per (player, game). A Chess rating and a
// Precision rating are separate rows and are never combined — there is
// deliberately no "overall" rating column anywhere.
//
// The row is created LAZILY, the first time the player completes an eligible
// ranked match in that game (src/lib/rating.js), so an unplayed game reads as
// "Unrated" instead of a fabricated starting rating. Every player therefore
// starts at STARTING_RATING (1000, src/lib/elo.js) on their first rated match.
//
// Written ONLY from server-side match settlement via applyRatingResult under
// SELECT ... FOR UPDATE in ascending user_id order. No client input is ever
// accepted for a rating, a delta or an outcome.
//
// NOTE: this table is intentionally NOT a child of the token economy. Ratings
// are never affected by balance, winnings, XP, level or cosmetics.
export const playerRatings = pgTable(
  "player_ratings",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // Rated game key — identical vocabulary to the rated-game registry
    // (see RATED_GAMES in src/lib/rating.js).
    gameKey: varchar("game_key", { length: 64 }).notNull(),
    // Current Elo for this game. Starts at STARTING_RATING and is clamped to
    // the legal band (see clampRating in src/lib/elo.js).
    rating: integer("rating").notNull().default(1000),
    // Highest rating ever reached — monotonic, so a bad run can never erase
    // a peak. Useful for profile display and future tier badges.
    peakRating: integer("peak_rating").notNull().default(1000),
    // Rated matches completed in this game. Drives the provisional K-factor
    // and the "provisional" flag in the UI.
    gamesRated: integer("games_rated").notNull().default(0),
    wins: integer("wins").notNull().default(0),
    losses: integer("losses").notNull().default(0),
    draws: integer("draws").notNull().default(0),
    // The delta applied by the player's most recent rated match, so result
    // screens can show "+16 / -16" without a second lookup. NOT the source of
    // truth — the journal row is.
    lastDelta: integer("last_delta").notNull().default(0),
    lastRatedAt: timestamp("last_rated_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    uniqPlayerGame: unique("player_ratings_user_game_unique").on(
      table.userId,
      table.gameKey,
    ),
    // Board ordering: rating DESC within one game.
    boardIdx: index("player_ratings_game_rating_idx").on(
      table.gameKey,
      desc(table.rating),
    ),
    userIdx: index("player_ratings_user_idx").on(table.userId),
  }),
);

// RATING EVENT JOURNAL — IDEMPOTENCY + PER-MATCH RATING HISTORY
// ==============================================================================
// One row per player per rated match (two rows per match), keyed uniquely by
// (user_id, game_key, match_id). The unique key is what makes a duplicate,
// replayed, retried or concurrent settlement of the same match a guaranteed
// no-op — and the same rows double as the match rating history (opponent,
// both ratings, delta, K), without touching any game's own tables.
//
// Inserted only from src/lib/rating.js, inside the caller's settlement
// transaction, so the journal commits atomically with the rating update.
export const ratingEvents = pgTable(
  "rating_events",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    gameKey: varchar("game_key", { length: 64 }).notNull(),
    // Authoritative match id in that game's own table.
    matchId: varchar("match_id", { length: 128 }).notNull(),
    opponentId: integer("opponent_id").references(() => users.id, {
      onDelete: "set null",
    }),
    // Authoritative outcome for THIS user: "win" | "loss" | "draw".
    outcome: varchar("outcome", { length: 8 }).notNull(),
    ratingBefore: integer("rating_before").notNull(),
    ratingAfter: integer("rating_after").notNull(),
    delta: integer("delta").notNull(),
    // The K-factor actually used (each side may differ: provisional vs
    // established). Stored for auditability. Never accepted from a client.
    kFactor: integer("k_factor").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    uniqRatingEvent: unique("rating_events_unique_event").on(
      table.userId,
      table.gameKey,
      table.matchId,
    ),
    userIdx: index("rating_events_user_idx").on(
      table.userId,
      table.gameKey,
      table.createdAt,
    ),
    matchIdx: index("rating_events_match_idx").on(table.matchId),
  }),
);

// RATING IDENTITY LEDGER — ANTI-RESET FOR PROVISIONAL STATUS + ELO
// ==============================================================================
// A snapshot of one player's per-game Elo progress, keyed by a HASH OF THEIR
// NORMALIZED EMAIL (see identityHashForEmail in src/lib/rating.js) instead of
// by user id. Two consequences, both deliberate:
//
//   1. It carries NO foreign key to `users`, so it SURVIVES account deletion.
//      Deleting an account cascades away `player_ratings`, but the identity
//      snapshot remains — so "play 10 placement matches → delete account →
//      re-register with the same email" restores the rating and the
//      provisional window instead of resetting them to 1000 / 0. Without
//      this, a player could re-roll their provisional status indefinitely.
//   2. It is refreshed on every rated match from the just-updated
//      `player_ratings` row, so it always mirrors current progress for the
//      account's current email (an email change simply starts a new key).
//
// The email itself is never stored — only a domain-separated sha256 hex digest
// — so the ledger is not directly identifying.
//
// NOT part of the token economy: no balance, winnings, XP or cosmetic value
// is stored or derived here.
export const ratingIdentities = pgTable(
  "rating_identities",
  {
    id: serial("id").primaryKey(),
    // sha256 hex of "grynd:rating-identity:" + lower(trim(email)).
    identityHash: varchar("identity_hash", { length: 64 }).notNull(),
    gameKey: varchar("game_key", { length: 64 }).notNull(),
    rating: integer("rating").notNull().default(1000),
    peakRating: integer("peak_rating").notNull().default(1000),
    gamesRated: integer("games_rated").notNull().default(0),
    wins: integer("wins").notNull().default(0),
    losses: integer("losses").notNull().default(0),
    draws: integer("draws").notNull().default(0),
    lastDelta: integer("last_delta").notNull().default(0),
    lastRatedAt: timestamp("last_rated_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    uniqIdentityGame: unique("rating_identities_identity_game_unique").on(
      table.identityHash,
      table.gameKey,
    ),
    identityIdx: index("rating_identities_identity_idx").on(table.identityHash),
  }),
);

// PER-GAME TROPHIES
// ==============================================================================
// One independent trophy count per (player, game), sitting alongside — never
// replacing — the per-game Elo rating. A Chess trophy count and a Precision
// trophy count are separate rows and are never combined.
//
// The row is created LAZILY, the first time the player completes an eligible
// ranked match in that game (src/lib/trophyStore.js), so an unplayed game
// reads as "no trophies yet" instead of a fabricated row. Every player starts
// at TROPHY_START (0) on their first ranked match in a game.
//
// THE RULE (src/lib/trophies.js): win = +30, loss = −30, draw = 0, floored at 0
// and otherwise UNBOUNDED per game. Together with the per-game Elo rating these
// are the two matchmaking signals (src/lib/quickQueue.ts).
//
// Written ONLY from server-side match settlement via applyTrophyResult under
// SELECT ... FOR UPDATE in ascending user_id order. No client input is ever
// accepted for a trophy count, a delta or an outcome.
//
// NOTE: this table is intentionally NOT a child of the token economy. Trophy
// counts are never affected by balance, winnings, XP or cosmetics.
export const playerTrophies = pgTable(
  "player_trophies",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // Trophy game key — identical vocabulary to RATED_GAMES (src/lib/rating.js),
    // so trophies and Elo can never disagree about which games are competitive.
    gameKey: varchar("game_key", { length: 64 }).notNull(),
    // Current trophy count for this game — floored at 0, otherwise unbounded.
    trophies: integer("trophies").notNull().default(0),
    // Highest count ever reached — monotonic, so a bad run can never erase a peak.
    peakTrophies: integer("peak_trophies").notNull().default(0),
    gamesRated: integer("games_rated").notNull().default(0),
    wins: integer("wins").notNull().default(0),
    losses: integer("losses").notNull().default(0),
    draws: integer("draws").notNull().default(0),
    // The delta applied by the player's most recent ranked match, so result
    // screens can show "+30 / −30" without a second lookup. NOT the source of
    // truth — the journal row is.
    lastDelta: integer("last_delta").notNull().default(0),
    lastTrophyAt: timestamp("last_trophy_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    uniqPlayerGame: unique("player_trophies_user_game_unique").on(
      table.userId,
      table.gameKey,
    ),
    // Board ordering: trophies DESC within one game.
    boardIdx: index("player_trophies_game_trophies_idx").on(
      table.gameKey,
      desc(table.trophies),
    ),
    userIdx: index("player_trophies_user_idx").on(table.userId),
  }),
);

// TROPHY EVENT JOURNAL — IDEMPOTENCY + PER-MATCH TROPHY HISTORY
// ==============================================================================
// One row per player per ranked match (two rows per match), keyed uniquely by
// (user_id, game_key, match_id). The unique key is what makes a duplicate,
// replayed, retried or concurrent settlement of the same match a guaranteed
// no-op — and the same rows double as the trophy history (opponent, both
// counts, delta), without touching any game's own tables.
//
// Inserted only from src/lib/trophyStore.js, inside the caller's settlement
// transaction, so the journal commits atomically with the trophy update.
export const trophyEvents = pgTable(
  "trophy_events",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    gameKey: varchar("game_key", { length: 64 }).notNull(),
    // Authoritative match id in that game's own table.
    matchId: varchar("match_id", { length: 128 }).notNull(),
    opponentId: integer("opponent_id").references(() => users.id, {
      onDelete: "set null",
    }),
    // Authoritative outcome for THIS user: "win" | "loss" | "draw".
    outcome: varchar("outcome", { length: 8 }).notNull(),
    trophiesBefore: integer("trophies_before").notNull(),
    trophiesAfter: integer("trophies_after").notNull(),
    delta: integer("delta").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    uniqTrophyEvent: unique("trophy_events_unique_event").on(
      table.userId,
      table.gameKey,
      table.matchId,
    ),
    userIdx: index("trophy_events_user_idx").on(
      table.userId,
      table.gameKey,
      table.createdAt,
    ),
    matchIdx: index("trophy_events_match_idx").on(table.matchId),
  }),
);

// TROPHY IDENTITY LEDGER — ANTI-RESET FOR TROPHY PROGRESS
// ==============================================================================
// A snapshot of one player's per-game trophies, keyed by a HASH OF THEIR
// NORMALIZED EMAIL (the SAME digest the Elo ledger uses — see
// identityHashForEmail in src/lib/rating.js) instead of by user id. It carries
// NO foreign key to `users`, so it SURVIVES account deletion and lets a
// deleted-and-recreated account restore its trophies instead of restarting.
//
// Refreshed on every ranked match from the just-updated `player_trophies` row.
// The email itself is never stored — only a domain-separated sha256 hex digest.
//
// NOT part of the token economy: no balance, winnings, XP or cosmetic value is
// stored or derived here.
export const trophyIdentities = pgTable(
  "trophy_identities",
  {
    id: serial("id").primaryKey(),
    // sha256 hex of "grynd:rating-identity:" + lower(trim(email)).
    identityHash: varchar("identity_hash", { length: 64 }).notNull(),
    gameKey: varchar("game_key", { length: 64 }).notNull(),
    trophies: integer("trophies").notNull().default(0),
    peakTrophies: integer("peak_trophies").notNull().default(0),
    gamesRated: integer("games_rated").notNull().default(0),
    wins: integer("wins").notNull().default(0),
    losses: integer("losses").notNull().default(0),
    draws: integer("draws").notNull().default(0),
    lastDelta: integer("last_delta").notNull().default(0),
    lastTrophyAt: timestamp("last_trophy_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    uniqIdentityGame: unique("trophy_identities_identity_game_unique").on(
      table.identityHash,
      table.gameKey,
    ),
    identityIdx: index("trophy_identities_identity_idx").on(table.identityHash),
  }),
);

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
  endedAt: timestamp("ended_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => ({
  statusEndedIdx: index("chess_games_status_ended_idx").on(
    table.status,
    table.endedAt,
  ),
}));

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
// Strictly 1v1 tower-stacking duel (SEATS = 2; the 2–6 player shared
// table mode was retired). The server is fully
// authoritative: every match/tower/resource/placement value is owned
// by the server and stored here; clients only submit intent (block
// shape + x + rotation) and render back the state the server persists.
// Seats live in `tower_arena_players` (always two rows per match).
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
    // AI tier the lobby picked before starting (migration 0166). NULL =
    // nothing chosen, which reads back as the `normal` default.
    aiDifficulty: varchar("ai_difficulty", { length: 16 }),
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
    // AI tier the lobby picked before starting (migration 0166). NULL =
    // nothing chosen, which reads back as the `normal` default.
    aiDifficulty: varchar("ai_difficulty", { length: 16 }),

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
    endedAt: timestamp("ended_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    openGamesIdx: index("rps_pvp_open_games_idx").on(table.player2Id),
    statusIdx: index("rps_pvp_status_idx").on(table.status),
    statusEndedIdx: index("rps_pvp_games_status_ended_idx").on(
      table.status,
      table.endedAt,
    ),
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

//
// RELATIONS
//

export const usersRelations = relations(users, ({ many }) => ({
  minesGames: many(minesGames),
  laneRunnerGames: many(laneRunnerGames),
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
    // AI tier the lobby picked before starting (migration 0166). NULL =
    // nothing chosen, which reads back as the `normal` default.
    aiDifficulty: varchar("ai_difficulty", { length: 16 }),
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
    // AI tier the lobby picked before starting (migration 0166). NULL =
    // nothing chosen, which reads back as the `normal` default.
    aiDifficulty: varchar("ai_difficulty", { length: 16 }),
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

// MINES PvP MATCHES — server-authoritative two-player "Mines Duel",
// played under the SHARED-BOARD competitive Minesweeper rules. Both
// players act on the SAME 5×5 board; the HOST picks the mine count at
// lobby creation. The server randomizes turn order at match creation
// (when player2 joins), then each player gets a 20s window to either
// REVEAL a tile or FLAG one they believe is a mine.
//
// Match flow:
//   waiting → ready → p1_turn → p2_turn → finished
//
// Shared-board rules:
//   • EVERY safe reveal (and its server-computed clue) is public to both
//     players — they read the same board, so the clue is not private.
//   • Revealing a mine loses IMMEDIATELY for the revealer (sudden death);
//     the opponent wins with `win_reason = 'mine_hit'`.
//   • Flags are per-player CLAIMS (`p1_flags` / `p2_flags`), never
//     terminal, and a WRONG claim is not a loss — it just costs a turn.
//   • A player who correctly flags EVERY mine wins IMMEDIATELY with
//     `win_reason = 'all_mines_flagged'`.
//   • There is no draw case; a finished match rejects every further action.
//
// Payout (non-AI matches; stakes are currently retired and normalized to 0):
//   Winner: own stake back + 90% of loser's stake
//   Loser:   loses entire stake
//   House:   10% rake on loser's stake only
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
    // 0-24 row-major cell index of the seat's most recent REVEAL. Null
    // until the player reveals (or gets auto-revealed at deadline). Flag
    // CLAIMS never touch these scalars — they describe reveals only, and
    // `p{N}_pick_is_mine` is surfaced to the viewer's own seat mid-match,
    // so mirroring a claim here would hand the claimer its verdict. The
    // authoritative history lives on `picks` (see below) and the claims on
    // `p{N}_flags`.
    p1Pick: integer("p1_pick"),
    p2Pick: integer("p2_pick"),
    // Whether the seat's most recent REVEAL landed on a mine. Computed at
    // reveal time and persisted so post-match replays don't have to walk
    // `board` to render the result. Full history lives on `picks`; flag
    // claims are deliberately excluded (see `p{N}_pick` above).
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
    // Chronologically-ordered JSONB array of every ACTION in the match —
    // both reveals and flag claims, since both consume a turn.
    //
    // REVEAL entry:
    //   { userId, seat: "player1"|"player2", cell: <0..24>,
    //     isMine: boolean, hint: <server clue | null>, flag: false,
    //     mercy: boolean, autoPicked: boolean, pickedAt: ISO ts }
    // CLAIM entry:
    //   { userId, seat, cell, isMine: null, hint: null, flag: true,
    //     kind: "flag", mercy: false, autoPicked: boolean, pickedAt }
    //   (a claim carries NO verdict — it is public to both seats mid-match,
    //    so the server's answer on it cannot travel with it)
    //
    // Authoritative state — `picks.length` is the turn counter; the
    // server computes the next picker's seat/turn via the closed-
    // form "odds" formula in src/lib/mines-pvp/constants.js
    // (`activePickerForMatch`). Mirrored onto `mines_pvp_rounds.
    // picks` at match resolution for post-match replays. See
    // src/db/migrations/0050_mines_pvp_odds_turns.sql.
    picks: jsonb("picks")
      .notNull()
      .default(sql`'[]'::jsonb`),
    // Per-player flag CLAIMS (shared-board rules). Flags are NOT terminal:
    // each seat owns its own set, the same cell may be flagged by both, a
    // flag never ends the match on its own, and a wrong flag is not a loss.
    // Each array holds unique, sorted 0-24 row-major cell indices (the
    // canonical form — see `normalizeFlags` in src/lib/mines-pvp/
    // constants.js). The claim is ALSO recorded in `picks` as a `flag: true`
    // entry (a claim consumes a turn), but the SET itself — the source of
    // truth for the all-mines-flagged win — lives here, per seat.
    p1Flags: jsonb("p1_flags")
      .notNull()
      .default(sql`'[]'::jsonb`),
    p2Flags: jsonb("p2_flags")
      .notNull()
      .default(sql`'[]'::jsonb`),
    // WHY the match ended (see WIN_REASON in
    // src/lib/mines-pvp/constants.js): 'mine_hit' | 'all_mines_flagged'
    // | 'resign' | 'disconnect'. Null until the match finishes — the
    // shared-board rules added the second player-driven ending
    // (`all_mines_flagged`), so `result` alone no longer says how the hand
    // was decided.
    winReason: varchar("win_reason", { length: 32 }),
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
    // 'player1' | 'player2' | null. There is no DRAW under the shared-board
    // rules ('draw' only appears on legacy pre-migration rows); `win_reason`
    // above records how the hand was actually decided.
    result: varchar("result", { length: 20 }),
    houseFee: numeric("house_fee", { precision: 10, scale: 2 }).notNull().default("0.00"),
    prizePaid: numeric("prize_paid", { precision: 10, scale: 2 }).notNull().default("0.00"),
    isAi: boolean("is_ai").notNull().default(false),
    // AI tier the lobby picked before starting (migration 0166). NULL =
    // nothing chosen, which reads back as the `normal` default.
    aiDifficulty: varchar("ai_difficulty", { length: 16 }),
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
    // Odds-turn history: the full chronological action list from this
    // match (every reveal AND every flag claim), mirrored at resolution
    // time so post-match replay views can render every action without
    // re-walking the live match row. Shape of each entry matches the
    // `mines_pvp_matches.picks` element shape — see that column for the
    // contract.
    picks: jsonb("picks")
      .notNull()
      .default(sql`'[]'::jsonb`),
    // 'player1' | 'player2' | null ('draw' only on legacy rows).
    roundWinner: varchar("round_winner", { length: 10 }),
    // Mirror of the match's `win_reason` captured at resolution time so a
    // replay can label how the hand ended (mine hit vs all mines flagged
    // vs resign/disconnect) without joining the live match row.
    winReason: varchar("win_reason", { length: 32 }),
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
    // AI tier the lobby picked before starting (migration 0166). NULL =
    // nothing chosen, which reads back as the `normal` default.
    aiDifficulty: varchar("ai_difficulty", { length: 16 }),
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
    // DECIMAL — the round score is the exact full-grid accuracy
    // percentage (computeFinalRoundScore, 1dp — e.g. 81.3), so these
    // can hold fractional values. INT here caused pg_strtoint32 500s
    // on every non-integer reconstruction.
    p1RoundScore: numeric("p1_round_score", { precision: 6, scale: 1 }).notNull().default("0.0"),
    p2RoundScore: numeric("p2_round_score", { precision: 6, scale: 1 }).notNull().default("0.0"),
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
    // DECIMAL — cumulative sum of 1dp round scores (e.g. 247.4).
    p1Total: numeric("p1_total", { precision: 7, scale: 1 }).notNull().default("0.0"),
    p2Total: numeric("p2_total", { precision: 7, scale: 1 }).notNull().default("0.0"),
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
    // DECIMAL — mirrors memory_grid_matches.p1/p2_round_score.
    p1RoundScore: numeric("p1_round_score", { precision: 6, scale: 1 }).notNull().default("0.0"),
    p2RoundScore: numeric("p2_round_score", { precision: 6, scale: 1 }).notNull().default("0.0"),
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
    // ── SHARED GLASS BRIDGE (the redesigned game) ─────────────────
    // ONE bridge per match, shared by both seats: 10 rows, exactly one
    // bad tile per row. SERVER-SIDE layout
    // ({ rows, tiles, difficulty, badTiles, commitment }) — clients only
    // ever receive bridgeClientView(bridge, { broken }) + the public
    // flags, never this object.
    bridge: jsonb("bridge")
      .notNull()
      .default(sql`'{}'::jsonb`),
    // Rows crossed per seat: 0 = standing at the start, 10 = crossed
    // the whole bridge (that seat wins).
    p1Row: integer("p1_row").notNull().default(0),
    p2Row: integer("p2_row").notNull().default(0),
    // Bad tiles already stepped on: [{row,tile}, …] — public knowledge and
    // broken for the rest of the match.
    broken: jsonb("broken")
      .notNull()
      .default(sql`'[]'::jsonb`),
    // Memory flags per seat: [{row,tile}, …] — visible to both players.
    p1Flags: jsonb("p1_flags")
      .notNull()
      .default(sql`'[]'::jsonb`),
    p2Flags: jsonb("p2_flags")
      .notNull()
      .default(sql`'[]'::jsonb`),
    // Chronological action history: [{ userId, seat, action:
    // "jump"|"flag", row, tile, outcome, autoPicked, at }]
    actions: jsonb("actions")
      .notNull()
      .default(sql`'[]'::jsonb`),
    // Tile-choice deadline (15s per choice; the timer resets after every
    // successful jump).
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

// ── KENO PvP ("Keno Survival Duel") ─────────────────────────────────
// 1v1 survival keno: both players start with 3 lives and ONE tile is lit
// for both at a time. The first player to tap the live tile claims it and
// costs the opponent a life; a tile nobody claims in time is a BOTH-MISS
// (both lose a life). The claim window starts at 1.6s, tightens 100ms per
// claimed tile and floors at 0.4s. Lives at 0 = eliminated (opponent
// takes the pot); both eliminated on the same both-miss = draw (full
// refund). Payout is the standard 90/10 split.
//
// Match flow: waiting → ready → <live> → finished (waiting → cancelled).
// The live run reuses the legacy `round_1` enum value for its whole
// duration (see src/lib/keno-pvp/constants.js — MATCH_STATUS.LIVE);
// nothing advances a round any more, and the legacy round_2…round_16 /
// overtime values exist only so pre-rework history rows still read.
// `round_deadline` is the live tile's expiry and `round_timer_seconds`
// the opening window in seconds. The keno_pvp_rounds child table is
// legacy-only now: the public per-tile log on the match row (tile_log)
// carries the replay instead.
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
    // AI tier the lobby picked before starting (migration 0166). NULL =
    // nothing chosen, which reads back as the `normal` default.
    aiDifficulty: varchar("ai_difficulty", { length: 16 }),
    // Survival lives. Start at 3; only your OWN miss costs one — you did
    // not tap the live tile before its window closed. Beating you to the
    // tile costs you nothing. 0 = eliminated.
    p1Lives: integer("p1_lives").notNull().default(3),
    p2Lives: integer("p2_lives").notNull().default(3),
    // Tiles each player claimed first this match. Feeds the shrinking
    // claim window (3s − 100ms per claim, floor 0.5s) and the
    // board-exhausted tiebreak.
    p1Tiles: integer("p1_tiles").notNull().default(0),
    p2Tiles: integer("p2_tiles").notNull().default(0),
    // Per-tile scratch state for the tile CURRENTLY lit: whether each
    // player tapped it while its window was open, and their reaction. A
    // false at resolution is a miss and costs that player a life. Reset
    // whenever the next tile lights.
    p1ClaimedLive: boolean("p1_claimed_live").notNull().default(false),
    p2ClaimedLive: boolean("p2_claimed_live").notNull().default(false),
    p1ClaimedMs: integer("p1_claimed_ms"),
    p2ClaimedMs: integer("p2_claimed_ms"),
    // The tile currently lit for BOTH players (1..40), or NULL when no
    // tile is live. `roundDeadline` is its expiry and `liveStartedAt`
    // when it lit up.
    liveTile: integer("live_tile"),
    liveTileIndex: integer("live_tile_index").notNull().default(0),
    liveStartedAt: timestamp("live_started_at"),
    // Tiles already drawn this match — a tile never lights twice.
    usedTiles: jsonb("used_tiles")
      .notNull()
      .default(sql`'[]'::jsonb`),
    // Public per-tile history for the match feed / replay:
    // [{tile,index,outcome,at,p1Lives,p2Lives,windowMs,reactionMs}, ...]
    tileLog: jsonb("tile_log")
      .notNull()
      .default(sql`'[]'::jsonb`),
    // LEGACY (pre-rework multi-round game): current_round / rounds_won_* /
    // p1_score / p2_score / current_draw / p1_catches / p2_catches are no
    // longer written by the survival engine. Kept so historical rows stay
    // readable.
    currentRound: integer("current_round").notNull().default(1),
    roundsWonPlayer1: integer("rounds_won_player1").notNull().default(0),
    roundsWonPlayer2: integer("rounds_won_player2").notNull().default(0),
    p1Score: integer("p1_score").notNull().default(0),
    p2Score: integer("p2_score").notNull().default(0),
    // LEGACY: the pre-rework round's shared 10-ball draw.
    currentDraw: jsonb("current_draw").default(sql`NULL`),
    // LEGACY: pre-rework per-round catch commits.
    p1Catches: jsonb("p1_catches").default(sql`NULL`),
    p2Catches: jsonb("p2_catches").default(sql`NULL`),
    // Deadline of the CURRENT live tile (= live_started_at + the current
    // window). NULL when no tile is live.
    roundDeadline: timestamp("round_deadline"),
    // Opening claim window in seconds (legacy column name; the window
    // shrinks by 100ms per claimed tile down to 0.4s).
    roundTimerSeconds: integer("round_timer_seconds").notNull().default(2),
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

// LEGACY: one row per round of a pre-rework Keno PvP match. The survival
// duel does not write rounds — it keeps its replay in
// keno_pvp_matches.tile_log — so this table only exists for historical
// rows now. Cascade-deleted with the parent match so history stays tidy.
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

// GRYND PRO MEMBERSHIP SUBSCRIPTIONS
// ==============================================================================
// Recurring monthly token grants backed by Stripe Billing. Three tables back
// the flow (same server-authoritative rules as the one-time economy):
//
//   * token_subscription_plans   — the purchasable subscription catalog
//     (monthly token grant + price). Admin-managed; mirrors token_packages.
//   * token_subscriptions        — one row per Stripe subscription with its
//     lifecycle status. `stripe_subscription_id` is UNIQUE so webhook replays
//     can never create duplicates.
//   * token_subscription_credits — LEGACY per-invoice grant ledger. GRYND no
//     longer grants tokens on any invoice, so nothing writes here any more.
//     The table is kept (and its UNIQUE `stripe_invoice_id`) for historical
//     rows so past grants stay auditable.

// Catalog of membership offers. GRYND has a SINGLE paid plan, GRYND PRO
// (`grynd-pro`); the legacy `grynd-plus` / `grynd-high-roller` rows are kept
// but disabled (migration 0168). Monthly token grants were removed with the
// token currency — `monthly_tokens` is 0 for every row.
export const tokenSubscriptionPlans = pgTable(
  "token_subscription_plans",
  {
    id: serial("id").primaryKey(),
    // Stable slug used in URLs, session metadata and admin tooling.
    key: varchar("key", { length: 120 }).notNull().unique(),
    name: varchar("name", { length: 255 }).notNull(),
    // LEGACY. Pre-token-removal monthly grant. Always 0 now — membership
    // grants no tokens or currency of any kind (belt-and-braces guard against
    // any leftover code path crediting the old amount).
    monthlyTokens: bigint("monthly_tokens", { mode: "number" }).notNull(),
    priceCents: integer("price_cents").notNull(),
    // Real Stripe Product + recurring Price ids backing this plan. Populated
    // lazily by src/lib/stripe/subscriptions.ts on first subscribe (mirrors
    // token_packages). Nullable — empty means "not yet created in Stripe".
    stripeProductId: varchar("stripe_product_id", { length: 255 }),
    stripePriceId: varchar("stripe_price_id", { length: 255 }),
    badge: varchar("badge", { length: 40 }),
    // Benefit list rendered on the Shop membership card (sales copy). GRYND
    // PRO perks are non-competitive only: ad-free, advanced statistics /
    // analytics, detailed match history, profile cosmetics, priority support.
    // No tokens, no XP/quest multipliers, no matchmaking advantages.
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
  "reward",
]);

// ── Precision (reflex-stop duel) ───────────────────────────────────────
//
// Persistence for the Precision lobby queue and the live match state.
// Deliberately mirrors `towerArenaMatches`: a handful of QUERYABLE columns
// (phase / status / wager / timestamps) beside a jsonb snapshot of the
// public match state, so the API can list, sweep and settle rows with an
// index instead of loading and filtering every game in memory.
//
// WHY THIS EXISTS AT ALL
//   Precision used to keep lobbies and matches in `globalThis` Maps inside
//   the Next process. On a serverless deploy that state is per-instance and
//   dies with the instance: a match created by one request could be
//   invisible to the very next poll (the player saw an empty page), and any
//   `setTimeout`-driven transition (the arming countdown, the bot's stop)
//   was lost outright on a frozen/recycled instance. Every row here is the
//   durable replacement — the countdown and the bot are now expressed as
//   STORED INSTANTS the next read can act on, so no live process is
//   required for a match to make progress.
//
// SERVER-ONLY COLUMNS (never serialised to a client)
//   serverTargetMs  the rolled round target while the round is still arming
//   aiStopAt        the instant the bot will stop at (AI practice matches)
//   pendingStops    the per-seat stop telemetry of the round in flight
//   anomalyLedger   per-user reaction samples + already-logged variance flags
//
// The lobby id doubles as the match id once two players are paired — see
// `tryAutoMatch` — so both URL shapes (`/games/precision/game/<id>`) keep
// working exactly as before.
export const precisionLobbies = pgTable(
  "precision_lobbies",
  {
    id: text("id").primaryKey(),
    hostUserId: varchar("host_user_id", { length: 255 }).notNull(),
    hostName: varchar("host_name", { length: 64 }).notNull().default("Player 1"),
    opponentUserId: varchar("opponent_user_id", { length: 255 }),
    opponentName: varchar("opponent_name", { length: 64 }),
    wager: integer("wager").notNull(),
    gameMode: varchar("game_mode", { length: 12 }).notNull().default("pvp"),
    status: varchar("status", { length: 12 }).notNull().default("waiting"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    // The pairing query is "first waiting lobby at this wager, not mine";
    // the list query is "all waiting lobbies, oldest first".
    index("precision_lobbies_status_idx").on(
      table.status,
      table.wager,
      table.createdAt,
    ),
    index("precision_lobbies_host_idx").on(table.hostUserId, table.status),
  ],
);

export const precisionMatches = pgTable(
  "precision_matches",
  {
    id: text("id").primaryKey(),
    // ── Canonical house columns ──
    // Same shape as `pool_matches` / `tower_arena_matches` so the shared
    // analytics (`/api/pm/analytics`), retention job (`/api/jobs/retention`),
    // lobby stats and sitemap keep reading precision history without a
    // per-game special case. Derived from the seats on every write.
    player1Id: varchar("player1_id", { length: 255 }).notNull(),
    player2Id: varchar("player2_id", { length: 255 }),
    winnerId: varchar("winner_id", { length: 255 }),
    wager: integer("wager").notNull().default(0),
    /** waiting | active | finished | cancelled — mirrors `phase` for the
     *  reporting surface. A row only exists once two seats are known, so a
     *  real match starts at `active`. */
    status: varchar("status", { length: 20 }).notNull().default("waiting"),
    isAiGame: boolean("is_ai_game").notNull().default(false),
    // AI tier the lobby picked before starting (migration 0166). NULL =
    // nothing chosen, which reads back as the `normal` default.
    aiDifficulty: varchar("ai_difficulty", { length: 16 }),
    phase: varchar("phase", { length: 16 }).notNull().default("ready_up"),
    // Public PrecisionState snapshot — byte-for-byte what
    // `/api/precision/get-match` hands the client (minus the server-only
    // columns below, which are never merged into it).
    state: jsonb("state").notNull(),
    pendingStops: jsonb("pending_stops").notNull().default(sql`'{}'::jsonb`),
    anomalyLedger: jsonb("anomaly_ledger").notNull().default(sql`'{}'::jsonb`),
    serverTargetMs: integer("server_target_ms"),
    aiStopAt: timestamp("ai_stop_at"),
    // Payout idempotency. A DB column (rather than the in-memory Set the
    // helper used before) so two instances — or a retry after the instance
    // that settled the match died — can never pay a match twice.
    payoutProcessedAt: timestamp("payout_processed_at"),
    /** Terminal timestamp. Also the retention job's purge column. */
    endedAt: timestamp("ended_at"),
    // Last REAL state transition (arm / ready / stop / forfeit). The
    // abandoned-match sweep prunes rows that never finish and stop moving.
    touchedAt: timestamp("touched_at").notNull().defaultNow(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    // Abandoned-match sweep: unfinished matches that stopped moving.
    index("precision_matches_phase_idx").on(table.phase, table.touchedAt),
    // Finished-match sweep + retention purge.
    index("precision_matches_ended_idx").on(table.endedAt),
    index("precision_matches_player1_idx").on(table.player1Id, table.createdAt),
    index("precision_matches_player2_idx").on(table.player2Id, table.createdAt),
  ],
);

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

// ── Mini Golf (PvP) ─────────────────────────────────────────────────────
//
// Server-authoritative 1v1 turn-based mini golf: best-of-5 holes, first to
// win 3 holes takes the match, no wagers / no tokens / no payouts.
//
// Matchmaking follows the Plinko Duel pattern rather than Pool Masters'
// lobby+match pair: a single row with a nullable `player2_id` and a
// `waiting` status IS the lobby, so `create-or-join` matches two players
// under one advisory lock with no second table to keep in sync. Pool's
// lobby table exists only because its online flow was never made
// authoritative; there is no reason to copy that here.
//
// Authoritative state lives in `game_state` (jsonb) and is produced solely
// by `src/lib/mini-golf/rules.ts`. The scalar columns are denormalised
// copies of the fields the platform needs to filter/sort/settle on
// (turn, current hole, hole wins, status, seed) so the canonical queue and
// the lobby list never have to parse JSON. The seed is the source of truth
// for the course; `game_state.holes` is the frozen snapshot generated from
// it at creation, so a match replays identically even if COURSE_VERSION or
// the generator changes later.
//
// Player ids are stored as plain clerk-id strings with no FK to `users`,
// matching every other PvP table.
export const miniGolfMatches = pgTable(
  "mini_golf_matches",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    player1Id: varchar("player1_id", { length: 255 }).notNull(),
    // Nullable so a `waiting` row doubles as the open lobby.
    player2Id: varchar("player2_id", { length: 255 }),
    winnerId: varchar("winner_id", { length: 255 }),
    // Derived from `game_state.current_turn` on every write.
    currentTurnUserId: varchar("current_turn_user_id", { length: 255 }),
    currentHole: integer("current_hole").notNull().default(1),
    player1HoleWins: integer("player1_hole_wins").notNull().default(0),
    player2HoleWins: integer("player2_hole_wins").notNull().default(0),
    status: varchar("status", { length: 20 }).notNull().default("waiting"),
    // Server-generated course seed. bigint because the 32-bit unsigned seed
    // range (up to 4294967295) overflows int4.
    seed: bigint("seed", { mode: "number" }).notNull(),
    courseVersion: integer("course_version").notNull(),
    // The authoritative MiniGolfState (see src/lib/mini-golf/rules.ts).
    gameState: jsonb("game_state").notNull(),
    // Marked on every future AI match so settlement can skip rating/stats.
    isAi: boolean("is_ai").notNull().default(false),
    // AI tier for a free vs-AI match: easy | normal | hard (NULL = the
    // mini-golf default, `hard`). Ignored on human duels.
    aiDifficulty: varchar("ai_difficulty", { length: 16 }),
    // 'player1' | 'player2' | 'tie'. Null until the match settles.
    result: varchar("result", { length: 20 }),
    startedAt: timestamp("started_at"),
    endedAt: timestamp("ended_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    statusIdx: index("mini_golf_matches_status_idx").on(table.status, table.createdAt),
    player1Idx: index("mini_golf_matches_player1_idx").on(table.player1Id, table.createdAt),
    player2Idx: index("mini_golf_matches_player2_idx").on(table.player2Id, table.createdAt),
  })
);

// Append-only shot log. The authoritative replay record: every accepted
// stroke with the exact inputs the server validated and the full deterministic
// simulation output. `shot_seq` is monotonic per match and uniquely indexed,
// which — together with the row lock taken in `shoot()` — makes replayed or
// duplicated shots impossible at the storage layer.
export const miniGolfShots = pgTable(
  "mini_golf_shots",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    matchId: uuid("match_id")
      .notNull()
      .references(() => miniGolfMatches.id, { onDelete: "cascade" }),
    shotSeq: integer("shot_seq").notNull(),
    holeNumber: integer("hole_number").notNull(),
    playerId: varchar("player_id", { length: 255 }).notNull(),
    // Strokes this player has taken on this hole after this shot (1-based).
    strokeNumber: integer("stroke_number").notNull(),
    angle: numeric("angle").notNull(),
    power: numeric("power").notNull(),
    // ShotResult: { path, restPosition, pocketed, settled, frames, waterHits, ... }
    result: jsonb("result").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    matchIdx: index("mini_golf_shots_match_idx").on(table.matchId, table.createdAt),
    holeIdx: index("mini_golf_shots_hole_idx").on(table.matchId, table.holeNumber),
    // Anti-replay: one persisted row per shot sequence per match.
    seqIdx: unique("mini_golf_shots_seq_unique").on(table.matchId, table.shotSeq),
  })
);

// ── Speed Typing (PvP, rated) ────────────────────────────────────────────
//
// Server-authoritative 1v1 typing race: both seats receive the EXACT same text
// and the first to complete it correctly wins. No randomness during play, no
// wagers, no tokens, no balances, no payouts.
//
// Matchmaking follows the Mini Golf pattern rather than Pool Masters' / Precision's
// lobby+match pair: a single row with a nullable `player2_id` and a `waiting`
// status IS the open lobby, so `create-or-join` matches two players under one
// advisory lock (SPEED_TYPING_LOCK_NAMESPACE) with no second table to keep in
// sync — and no per-wager queue bucket, because the game is unstaked.
//
// HOUSE COLUMNS ONLY, ON PURPOSE. This table currently carries the match's
// IDENTITY and LIFECYCLE — everything matchmaking, the lobby list, the
// canonical queue mirror and the match-history formatter need — and nothing
// else. The race's own state (the shared passage + its server-only text, the
// GO instant, the per-seat finish/progress columns, the race envelope) arrives
// with the gameplay migration as additive columns, exactly as Mini Golf gained
// its `ai_difficulty` column in 0182 after shipping in 0179.
//
// There is deliberately NO stake_amount / prize_paid / house_fee column: the
// game is unstaked, so no money is ever moved by settlement.
//
// Player ids are stored as plain clerk-id strings with no FK to `users`,
// matching every other PvP table.
export const speedTypingMatches = pgTable(
  "speed_typing_matches",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    player1Id: varchar("player1_id", { length: 255 }).notNull(),
    // Nullable so a `waiting` row doubles as the open lobby.
    player2Id: varchar("player2_id", { length: 255 }),
    winnerId: varchar("winner_id", { length: 255 }),
    /** waiting | ready | playing | finished | cancelled — the shared house
     *  vocabulary the retention sweep, the queue mirror and the match-history
     *  formatter all read. */
    status: varchar("status", { length: 20 }).notNull().default("waiting"),
    // Marked on every practice match so settlement can skip rating/stats.
    isAi: boolean("is_ai").notNull().default(false),
    // AI tier for a practice match (NULL = the documented default). Ignored on
    // human duels. Present from day one so the practice bot needs no migration.
    aiDifficulty: varchar("ai_difficulty", { length: 16 }),
    // 'player1' | 'player2' | 'tie'. Null until the match settles.
    result: varchar("result", { length: 20 }),
    // ── The race (migration 0191) ──────────────────────────────────────────
    // Server-generated race seed, bigint because the 32-bit unsigned range
    // (up to 4294967295) overflows int4. Deterministic selection — see
    // `passageIndexFromSeed` in src/lib/speed-typing/passages.ts.
    raceSeed: bigint("race_seed", { mode: "number" }),
    // The passage pair this match races on. The TEXT lives in code, derived
    // from this pair, so the server always verifies against its own copy.
    passageId: varchar("passage_id", { length: 64 }),
    passageVersion: integer("passage_version"),
    // The ABSOLUTE server instant typing opens (join instant + countdown).
    goAt: timestamp("go_at"),
    // Monotonic per authoritative write: the concurrency field a stale client
    // compares against, incremented by every accepted checkpoint/finish/
    // forfeit/resolution.
    revision: integer("revision").notNull().default(0),
    // 'finish' | 'deadline' | 'forfeit' | 'draw' — how the server ended it.
    resolutionReason: varchar("resolution_reason", { length: 32 }),
    // The authoritative race state (see src/lib/speed-typing/rules.ts):
    // { version, seats: { player1, player2 }, resolvedAtMs, resolutionReason }.
    // Never null — a legacy/unarmed row coerces to an empty race.
    raceState: jsonb("race_state").notNull().default(sql`'{}'::jsonb`),
    // Authoritative progress + correct/incorrect counts, per seat: the mirror
    // of race_state.seats.* that indexed reads (boards, history) can use
    // without parsing JSONB.
    player1CharsTyped: integer("player1_chars_typed").notNull().default(0),
    player1Errors: integer("player1_errors").notNull().default(0),
    player2CharsTyped: integer("player2_chars_typed").notNull().default(0),
    player2Errors: integer("player2_errors").notNull().default(0),
    // Authoritative completion per seat: the SERVER instant of the verified
    // finish. Null = this seat has not completed the passage.
    player1CompletedAt: timestamp("player1_completed_at"),
    player2CompletedAt: timestamp("player2_completed_at"),
    startedAt: timestamp("started_at"),
    endedAt: timestamp("ended_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    // Lobby list: "the oldest waiting row with no opponent".
    statusIdx: index("speed_typing_matches_status_idx").on(table.status, table.createdAt),
    // Match history: "my finished matches, newest first" per seat.
    player1Idx: index("speed_typing_matches_player1_idx").on(table.player1Id, table.createdAt),
    player2Idx: index("speed_typing_matches_player2_idx").on(table.player2Id, table.createdAt),
    // The scheduler: "armed races past their hard limit, still unresolved".
    dueIdx: index("speed_typing_matches_due_idx").on(table.status, table.goAt),
  })
);

// ── Tic-Tac-Toe Duel (PvP, rated) ────────────────────────────────────────
//
// Server-authoritative 1v1 turn-based tic-tac-toe: 3x3 board, nine cells,
// X vs O, X goes first, three in a row wins, a full board with no line is a
// draw. No randomness during play, no wagers, no tokens, no balances, no
// payouts.
//
// Matchmaking follows the Mini Golf pattern (0179) rather than Pool Masters'
// lobby+match pair (0022): a single row with a nullable `player2_id` and a
// `waiting` status IS the open lobby, so `create-or-join` matches two players
// under one advisory lock (TIC_TAC_TOE_LOCK_NAMESPACE) with no second table to
// keep in sync — and no per-wager queue bucket, because the game is unstaked.
//
// THERE IS NO SEED COLUMN, ON PURPOSE: tic-tac-toe contains no randomness. The
// board is a pure function of the accepted move order, so unlike mini golf's
// course there is nothing to regenerate — the append-only move log replays the
// whole match.
//
// There is deliberately NO stake_amount / prize_paid / house_fee column: the
// game is unstaked, so no money is ever moved by settlement.
//
// Player ids are stored as plain clerk-id strings with no FK to `users`,
// matching every other PvP table.
export const ticTacToeMatches = pgTable(
  "tic_tac_toe_matches",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    player1Id: varchar("player1_id", { length: 255 }).notNull(),
    // Nullable so a `waiting` row doubles as the open lobby.
    player2Id: varchar("player2_id", { length: 255 }),
    winnerId: varchar("winner_id", { length: 255 }),
    // Derived from `game_state.currentTurn` on every write.
    currentTurnUserId: varchar("current_turn_user_id", { length: 255 }),
    // Accepted moves so far (0..9). The mark is a pure function of parity:
    // X moves on an even ply, O on an odd one.
    ply: integer("ply").notNull().default(0),
    /** waiting | ready | playing | finished | cancelled — the shared house
     *  vocabulary the retention sweep, the queue mirror and the match-history
     *  formatter all read. `ready` is never entered: the second seat joining
     *  takes the match straight to `playing`, exactly as Mini Golf does. */
    status: varchar("status", { length: 20 }).notNull().default("waiting"),
    // The authoritative TicTacToeState (see src/lib/tic-tac-toe/rules.ts).
    gameState: jsonb("game_state").notNull(),
    // Marked on any practice match so settlement can skip rating/stats.
    isAi: boolean("is_ai").notNull().default(false),
    // AI tier for a practice match (NULL = the documented default).
    aiDifficulty: varchar("ai_difficulty", { length: 16 }),
    // 'player1' | 'player2' | 'tie'. Null until the match settles.
    result: varchar("result", { length: 20 }),
    startedAt: timestamp("started_at"),
    endedAt: timestamp("ended_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    statusIdx: index("tic_tac_toe_matches_status_idx").on(table.status, table.createdAt),
    player1Idx: index("tic_tac_toe_matches_player1_idx").on(table.player1Id, table.createdAt),
    player2Idx: index("tic_tac_toe_matches_player2_idx").on(table.player2Id, table.createdAt),
  })
);

// Append-only move log. The authoritative replay record: every accepted mark
// with the exact input the server validated.
//
// The mark itself is deliberately NOT stored — it is a pure function of the ply
// (`ply % 2 === 0` is X), so a `mark` column would be redundant state that
// could drift out of agreement with the ply counter.
//
// `cell_idx_unique` does more than prevent replays: it makes "a player may only
// place their mark in an empty cell" a STORAGE invariant, so a cell can never
// be occupied twice even if a future code path forgets the application check.
export const ticTacToeMoves = pgTable(
  "tic_tac_toe_moves",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    matchId: uuid("match_id")
      .notNull()
      .references(() => ticTacToeMatches.id, { onDelete: "cascade" }),
    ply: integer("ply").notNull(),
    playerId: varchar("player_id", { length: 255 }).notNull(),
    // 0..8, row-major (0-2 top row, 3-5 middle, 6-8 bottom).
    cellIndex: integer("cell_index").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    matchIdx: index("tic_tac_toe_moves_match_idx").on(table.matchId, table.ply),
    // Anti-replay: one persisted row per turn number per match.
    plyIdx: unique("tic_tac_toe_moves_ply_unique").on(table.matchId, table.ply),
    // The game rule as a structural guarantee: a cell is occupied at most once.
    cellIdx: unique("tic_tac_toe_moves_cell_unique").on(table.matchId, table.cellIndex),
  })
);

// SOLITAIRE DUEL — the 1v1 simultaneous Klondike race.
// ==============================================================================
// ONE server-generated deal per match that BOTH seats play from their own
// independent board. `deal` is the single canonical puzzle; `p1_state` /
// `p2_state` are two copies of it that diverge only through each seat's own
// validated moves. A seat's move can never touch the other seat's column.
//
// `server_seed` is secret until the match is terminal; `server_seed_hash` is the
// public pre-match commitment, so the revealed seed can be verified against the
// deal that was actually played.
//
// There is deliberately NO stake_amount / prize_paid / house_fee column: the
// game is unstaked, so no money is ever moved by settlement.
export const solitaireDuelMatches = pgTable(
  "solitaire_duel_matches",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    // The frozen ruleset, versioned into the deal digest.
    variant: varchar("variant", { length: 24 }).notNull().default("klondike-1"),
    variantVersion: integer("variant_version").notNull().default(1),
    player1Id: varchar("player1_id", { length: 255 }).notNull(),
    // Nullable so a `waiting` row doubles as the open lobby.
    player2Id: varchar("player2_id", { length: 255 }),
    winnerId: varchar("winner_id", { length: 255 }),
    /** waiting | ready | playing | finished | cancelled — the shared house
     *  vocabulary the retention sweep, the queue mirror and the match-history
     *  formatter all read. `ready` is part of the vocabulary but never entered:
     *  joining takes the match straight to `playing`, with a countdown window
     *  before the first legal move. */
    status: varchar("status", { length: 20 }).notNull().default("waiting"),
    // Marked on a practice match so settlement skips ratings/trophies. The
    // second seat is the internal bot id; the human always holds player1.
    isAi: boolean("is_ai").notNull().default(false),
    // AI tier for a practice match (NULL = the documented default).
    aiDifficulty: varchar("ai_difficulty", { length: 16 }),
    // 'player1' | 'player2' | 'draw'. Null until the match settles.
    result: varchar("result", { length: 20 }),
    // finish | deadline | forfeit | draw — how the server ended it.
    resolutionReason: varchar("resolution_reason", { length: 20 }),
    // Provably-fair seed pair (see src/lib/solitaire-duel/seeds.js).
    serverSeed: varchar("server_seed", { length: 64 }).notNull(),
    serverSeedHash: varchar("server_seed_hash", { length: 64 }).notNull(),
    // uint32, so it exceeds int4's range and must be a bigint column.
    dealSeed: bigint("deal_seed", { mode: "number" }).notNull(),
    // The ONE canonical deal both seats start from (server-only).
    deal: jsonb("deal").notNull(),
    // The two independent boards. Both NOT NULL: a match always has two boards,
    // even while seat 2 is still an empty lobby slot.
    p1State: jsonb("p1_state").notNull(),
    p2State: jsonb("p2_state").notNull(),
    // Denormalised per-seat facts, so no read has to parse JSONB.
    p1Ply: integer("p1_ply").notNull().default(0),
    p2Ply: integer("p2_ply").notNull().default(0),
    p1PeakFoundation: integer("p1_peak_foundation").notNull().default(0),
    p2PeakFoundation: integer("p2_peak_foundation").notNull().default(0),
    p1Revealed: integer("p1_revealed").notNull().default(0),
    p2Revealed: integer("p2_revealed").notNull().default(0),
    p1FinishedAt: timestamp("p1_finished_at"),
    p2FinishedAt: timestamp("p2_finished_at"),
    // The last accepted move per seat, for the inactivity rule. Null until the
    // seat plays its first move, in which case GO is the baseline.
    p1LastActionAt: timestamp("p1_last_action_at"),
    p2LastActionAt: timestamp("p2_last_action_at"),
    // Absolute server instants — never a per-client delay. The match is
    // untimed, so there is no deadline column.
    goAt: timestamp("go_at"),
    startedAt: timestamp("started_at"),
    endedAt: timestamp("ended_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    statusIdx: index("solitaire_duel_matches_status_idx").on(table.status, table.createdAt),
    player1Idx: index("solitaire_duel_matches_player1_idx").on(table.player1Id, table.createdAt),
    player2Idx: index("solitaire_duel_matches_player2_idx").on(table.player2Id, table.createdAt),
  })
);

// Append-only per-seat move log. The authoritative replay record: every
// accepted move with the exact validated input the server acted on.
//
// `ply_unique` makes "one accepted move per ply, per seat" a STORAGE invariant,
// so a duplicated or racing POST can never advance a board twice — the same
// structural backstop `tic_tac_toe_moves` provides, but keyed by seat because
// the two players move independently rather than alternating.
export const solitaireDuelMoves = pgTable(
  "solitaire_duel_moves",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    matchId: uuid("match_id")
      .notNull()
      .references(() => solitaireDuelMatches.id, { onDelete: "cascade" }),
    seat: varchar("seat", { length: 10 }).notNull(),
    ply: integer("ply").notNull(),
    // The move kind, denormalised so an audit can filter without parsing JSONB.
    kind: varchar("kind", { length: 32 }).notNull(),
    // The validated move, verbatim.
    move: jsonb("move").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    matchIdx: index("solitaire_duel_moves_match_idx").on(table.matchId, table.seat, table.ply),
    plyIdx: unique("solitaire_duel_moves_ply_unique").on(table.matchId, table.seat, table.ply),
  })
);

// SUDOKU DUEL — the 1v1 simultaneous Sudoku race.
// ==============================================================================
// ONE server-generated puzzle per match that BOTH seats solve from their own
// independent board. `puzzle` is the clue grid (public, both seats see it);
// `solution` is the authoritative completion and is SERVER-ONLY — it is never
// projected to a client, because a client must derive it, not read it.
// `p1_state` / `p2_state` are two copies of the opening clue board that diverge
// only through each seat's own judged actions, so a seat's action can never
// touch the other seat's column.
//
// A seat state holds givens + CORRECTLY placed values only: an incorrect value
// is counted as a mistake and discarded, never written. `mistakes` and
// `penalty_ms` are the +1s-per-mistake competitive penalty; `p*_finished_at` and
// `completed_at_ms` are server-stamped and decide a photo finish.
//
// `server_seed` is secret until the match is terminal; `server_seed_hash` is the
// public pre-match commitment, so the revealed seed can be verified against the
// puzzle that was actually played.
//
// There is deliberately NO stake_amount / prize_paid / house_fee column: the
// game is unstaked, so no money is ever moved by settlement.
export const sudokuDuelMatches = pgTable(
  "sudoku_duel_matches",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    // The frozen ruleset, versioned into the puzzle digest.
    variant: varchar("variant", { length: 24 }).notNull().default("classic-9"),
    variantVersion: integer("variant_version").notNull().default(1),
    // easy | normal | hard — a clue-count TARGET, see constants.ts.
    difficulty: varchar("difficulty", { length: 16 }).notNull().default("normal"),
    player1Id: varchar("player1_id", { length: 255 }).notNull(),
    // Nullable so a `waiting` row doubles as the open lobby.
    player2Id: varchar("player2_id", { length: 255 }),
    winnerId: varchar("winner_id", { length: 255 }),
    /** waiting | ready | playing | finished | cancelled — the shared house
     *  vocabulary. `ready` is never entered: joining takes the match straight to
     *  `playing`, with a 3 → 2 → 1 → GO countdown before the first legal action. */
    status: varchar("status", { length: 20 }).notNull().default("waiting"),
    // Marks a free practice match against the built-in bot so settlement skips
    // ratings, trophies, win counters and the queue mirror; false for every
    // human match.
    isAi: boolean("is_ai").notNull().default(false),
    // The practice-bot tier ('easy' | 'normal' | 'hard'); NULL falls back to the
    // documented default at read time. Mirrors solitaire_duel_matches.
    aiDifficulty: varchar("ai_difficulty", { length: 16 }),
    // 'player1' | 'player2' | 'draw'. Null until the match settles.
    result: varchar("result", { length: 20 }),
    // finish | deadline | forfeit | draw — how the server ended it.
    resolutionReason: varchar("resolution_reason", { length: 20 }),
    // Provably-fair seed pair (see src/lib/sudoku-duel/seeds.js).
    serverSeed: varchar("server_seed", { length: 64 }).notNull(),
    serverSeedHash: varchar("server_seed_hash", { length: 64 }).notNull(),
    // uint32, so it exceeds int4's range and must be a bigint column.
    puzzleSeed: bigint("puzzle_seed", { mode: "number" }).notNull(),
    // The ONE canonical puzzle both seats solve. `puzzle` is the clues (public);
    // `solution` is the authoritative answer (server-only, never sent).
    puzzle: jsonb("puzzle").notNull(),
    solution: jsonb("solution").notNull(),
    givens: integer("givens").notNull().default(0),
    // The two independent boards. Both NOT NULL: a match always has two boards,
    // even while seat 2 is still an empty lobby slot.
    p1State: jsonb("p1_state").notNull(),
    p2State: jsonb("p2_state").notNull(),
    // Denormalised per-seat facts, so no read has to parse JSONB.
    p1Ply: integer("p1_ply").notNull().default(0),
    p2Ply: integer("p2_ply").notNull().default(0),
    // Correctly completed NON-given cells — the competitive metric.
    p1Correct: integer("p1_correct").notNull().default(0),
    p2Correct: integer("p2_correct").notNull().default(0),
    p1Mistakes: integer("p1_mistakes").notNull().default(0),
    p2Mistakes: integer("p2_mistakes").notNull().default(0),
    p1PenaltyMs: integer("p1_penalty_ms").notNull().default(0),
    p2PenaltyMs: integer("p2_penalty_ms").notNull().default(0),
    p1FinishedAt: timestamp("p1_finished_at"),
    p2FinishedAt: timestamp("p2_finished_at"),
    // The last accepted action per seat, for the inactivity rule. Null until the
    // seat acts, in which case GO is the baseline.
    p1LastActionAt: timestamp("p1_last_action_at"),
    p2LastActionAt: timestamp("p2_last_action_at"),
    // Absolute server instants — never a per-client delay. The match is
    // untimed, so there is no deadline column.
    goAt: timestamp("go_at"),
    startedAt: timestamp("started_at"),
    endedAt: timestamp("ended_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    statusIdx: index("sudoku_duel_matches_status_idx").on(table.status, table.createdAt),
    player1Idx: index("sudoku_duel_matches_player1_idx").on(table.player1Id, table.createdAt),
    player2Idx: index("sudoku_duel_matches_player2_idx").on(table.player2Id, table.createdAt),
  })
);

// Append-only per-seat action log. The authoritative replay record: every
// accepted action with the exact validated input the server judged.
//
// `ply_unique` makes "one accepted action per ply, per seat" a STORAGE
// invariant, so a duplicated or racing POST can never advance a board twice —
// keyed by seat because the two players act independently rather than
// alternating. A logged `place` is not necessarily correct: an incorrect value
// is recorded as the action that produced a mistake, and the resulting state
// still holds only correct entries.
export const sudokuDuelMoves = pgTable(
  "sudoku_duel_moves",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    matchId: uuid("match_id")
      .notNull()
      .references(() => sudokuDuelMatches.id, { onDelete: "cascade" }),
    seat: varchar("seat", { length: 10 }).notNull(),
    ply: integer("ply").notNull(),
    // 'place' | 'clear', denormalised so an audit can filter without JSON.
    kind: varchar("kind", { length: 16 }).notNull(),
    // The validated action, verbatim.
    action: jsonb("action").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    matchIdx: index("sudoku_duel_moves_match_idx").on(table.matchId, table.seat, table.ply),
    plyIdx: unique("sudoku_duel_moves_ply_unique").on(table.matchId, table.seat, table.ply),
  })
);

// GAME EVALUATION RESULTS — post-match LLM coaching/analysis journal.
// ==============================================================================
// One row per evaluation request for a finished match. `objective_data` holds
// the game-specific stats computed server-side (the ONLY source of truth the
// LLM is allowed to reason over); `ai_response` holds the structured LLM
// output once it lands. The row is written first with status 'pending' and
// updated to 'complete'/'failed' by the evaluation job, so a request is always
// traceable even if the provider call dies.
//
// `match_id` is deliberately a plain string with NO foreign key: it points at
// a different game-specific table per `game_key` (chess_games.id,
// mines_pvp_matches.id, ...), so a single FK cannot be expressed. `user_id` is
// a Clerk id stored as a plain string with no FK, matching every other PvP
// table.
//
// Access paths: the daily-limit check counts a user's rows inside a time
// window, hence (user_id, created_at); the match lookup fetches an evaluation
// by (game_key, match_id).
export const evaluationResults = pgTable(
  "evaluation_results",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    // Clerk id of the evaluated player.
    userId: varchar("user_id", { length: 255 }).notNull(),
    // Canonical game key, e.g. "chess".
    gameKey: varchar("game_key", { length: 80 }).notNull(),
    // The game's own match/game id — polymorphic, so no FK (see above).
    matchId: varchar("match_id", { length: 255 }).notNull(),
    // Membership tier the evaluation was requested under: "free" | "pro".
    tier: varchar("tier", { length: 20 }).notNull(),
    // Game-specific computed stats fed to the model (not LLM output).
    objectiveData: jsonb("objective_data").notNull(),
    // Structured LLM output. Null until the provider call completes.
    aiResponse: jsonb("ai_response"),
    // "pending" | "complete" | "failed".
    status: varchar("status", { length: 20 }).notNull().default("pending"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    // Daily-limit count query: rows for one user in a rolling window.
    userCreatedIdx: index("evaluation_results_user_created_idx").on(
      table.userId,
      table.createdAt,
    ),
    // Match lookup: the evaluation(s) for one game's match id.
    gameMatchIdx: index("evaluation_results_game_match_idx").on(
      table.gameKey,
      table.matchId,
    ),
  }),
);
