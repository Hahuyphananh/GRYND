/**
 * Supabase Realtime client wrapper.
 *
 * The app's backend writes to Postgres via `pg`/Drizzle directly (not the
 * Supabase client). Supabase Realtime's "Postgres Changes" feature turns
 * those writes into pushed events: any INSERT/UPDATE/DELETE on a published
 * table is delivered over a single shared WebSocket to subscribed clients —
 * no polling needed. The events fire off the Postgres WAL regardless of who
 * performed the write (Next.js API routes, webhooks, the realtime server).
 *
 * Prerequisites:
 *   1. Env vars (set in Vercel / local .env): NEXT_PUBLIC_SUPABASE_URL and
 *      the publishable key. Supabase renamed the legacy "anon key" to
 *      "publishable key" (same role, new label, anon deprecated by end of
 *      2026) — the code accepts NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY first,
 *      falling back to NEXT_PUBLIC_SUPABASE_ANON_KEY.
 *   2. The table must be a member of the `supabase_realtime` publication —
 *      see src/db/migrations/0096_enable_realtime_publication.sql.
 *
 * Degrades gracefully: when the env vars are missing, the subscribe helpers
 * no-op and callers fall back to their existing fetch-on-open behavior.
 *
 * ⚠️ Security: this app authenticates with Clerk, not Supabase Auth, and RLS
 * is off. Realtime streams FULL rows to anyone holding the anon key, so only
 * publish tables with non-sensitive data (big_wins, chat_messages). NEVER
 * publish `users` (email / password hash / balance) or other PII tables.
 */

import {
  createClient,
  type RealtimeChannel,
  type RealtimePostgresChangesFilter,
  type RealtimePostgresChangesPayload,
  type SupabaseClient,
} from "@supabase/supabase-js";

/** Wins below this are not surfaced in the Big Wins feed (mirrors the API). */
const MIN_BIG_WIN_AMOUNT = 1_000_000;

let client: SupabaseClient | null = null;
let channelSeq = 0;

function getClient(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  // Supabase renamed the legacy "anon key" to "publishable key" — accept
  // both names so either works. Same token role, only the label changed.
  const key =
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !key) {
    if (process.env.NODE_ENV !== "production") {
      console.warn(
        "NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY (or NEXT_PUBLIC_SUPABASE_ANON_KEY) are missing. Supabase Realtime features are disabled.",
      );
    }
    return null;
  }

  if (!client) {
    client = createClient(url.trim().replace(/\/$/, ""), key);
  }
  return client;
}

export interface PostgresChangePayload<T = Record<string, unknown>> {
  schema: string;
  table: string;
  eventType: "INSERT" | "UPDATE" | "DELETE";
  new: T;
  old: T;
}

/**
 * Subscribe to Postgres changes on a table. Returns an unsubscribe function.
 * All subscriptions share one WebSocket connection (multiplexed channels),
 * so the app stays within Supabase's concurrent-connection limits.
 */
export function subscribeToPostgresChanges<T extends Record<string, unknown>>(options: {
  table: string;
  event?: "INSERT" | "UPDATE" | "DELETE" | "*";
  filter?: string;
  handler: (payload: PostgresChangePayload<T>) => void;
}): () => void {
  const supabase = getClient();
  if (!supabase) return () => {};

  const channelName = `pg-changes:${options.table}:${Date.now()}:${channelSeq++}`;
  const channel: RealtimeChannel = supabase.channel(channelName);

  const filter = {
    event: options.event ?? "*",
    schema: "public",
    table: options.table,
    ...(options.filter ? { filter: options.filter } : {}),
  } as unknown as RealtimePostgresChangesFilter<"*">;

  channel.on<RealtimePostgresChangesPayload<T>>(
    "postgres_changes",
    filter,
    (payload) => {
      options.handler(payload as unknown as PostgresChangePayload<T>);
    },
  );
  channel.subscribe();

  return () => {
    supabase.removeChannel(channel);
  };
}

/** Big win row as rendered by the ChatWidget (camelCase, matches /api/chat/big-wins). */
export interface BigWinRow {
  id: string;
  userId: string;
  username: string;
  game: string;
  betAmount: number;
  winAmount: number;
  multiplier: number;
  createdAt: string;
}

/**
 * Live big-wins feed: fires whenever the backend inserts a new qualifying
 * big win. The win amount threshold is enforced client-side to match the
 * feed API (server-side row filters can't be applied to the whole table
 * cheaply, and qualifying wins are rare).
 */
export function subscribeToBigWins(handler: (win: BigWinRow) => void): () => void {
  return subscribeToPostgresChanges<Record<string, unknown>>({
    table: "big_wins",
    event: "INSERT",
    handler: (payload) => {
      const row = payload.new;
      if (!row) return;

      const winAmount = Number(row.win_amount);
      if (!Number.isFinite(winAmount) || winAmount < MIN_BIG_WIN_AMOUNT) return;

      handler({
        id: String(row.id ?? ""),
        userId: String(row.user_id ?? ""),
        username: String(row.username ?? ""),
        game: String(row.game ?? ""),
        betAmount: Number(row.bet_amount ?? 0),
        winAmount,
        multiplier: Number(row.multiplier ?? 0),
        createdAt: String(row.created_at ?? new Date().toISOString()),
      });
    },
  });
}

/** Chat message row (camelCase, mirrors /api/chat/messages output). */
export interface ChatMessageRealtimeRow {
  id: number;
  roomType: string;
  roomId: string;
  clerkId: string;
  displayName: string;
  content: string;
  isDeleted: boolean;
  createdAt: string;
}

/**
 * Subscribe to new chat messages in the GLOBAL room only.
 *
 * The `room_type=eq.global` filter is applied server-side so clients only
 * receive global-chat inserts — game-room chat is delivered via the
 * Socket.IO `chat:updated` path instead, which cuts realtime message volume
 * substantially (game rooms are where chat churns fastest). Game-room ids
 * are pathnames like `/casino/plinko/5` — slashes break Supabase's filter
 * syntax, which is why the room filter can't target them server-side.
 *
 * The caller still re-checks room_type/room_id so this stays correct if
 * multiple global rooms are ever introduced.
 */
export function subscribeToChatMessages(
  handler: (row: ChatMessageRealtimeRow) => void,
): () => void {
  return subscribeToPostgresChanges<Record<string, unknown>>({
    table: "chat_messages",
    event: "INSERT",
    filter: "room_type=eq.global",
    handler: (payload) => {
      const row = payload.new;
      if (!row) return;
      handler({
        id: Number(row.id ?? 0),
        roomType: String(row.room_type ?? ""),
        roomId: String(row.room_id ?? ""),
        clerkId: String(row.clerk_id ?? ""),
        displayName: String(row.display_name ?? ""),
        content: String(row.content ?? ""),
        isDeleted: Boolean(row.is_deleted ?? false),
        createdAt: String(row.created_at ?? ""),
      });
    },
  });
}

