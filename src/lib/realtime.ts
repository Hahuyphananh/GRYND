/**
 * Supabase Realtime client layer — shared, deduplicated, failure-safe.
 *
 * The app's backend writes to Postgres via `pg`/Drizzle directly (not the
 * Supabase client). Supabase Realtime's "Postgres Changes" feature turns those
 * writes into pushed events: any INSERT/UPDATE/DELETE on a published table is
 * delivered over a single shared WebSocket to subscribed clients — no polling
 * needed. The events fire off the Postgres WAL regardless of who performed the
 * write (Next.js API routes, webhooks, the realtime server).
 *
 * Why this module exists (and what it guarantees)
 *   * ONE Supabase client per browser session. It is created lazily, cached on
 *     `globalThis` (so a dev HMR re-import cannot spawn a second one), and is
 *     never created during SSR. No subscription ever builds its own client.
 *   * DEDUPLICATED channels. Subscriptions are keyed by
 *     `schema:table:event:filter`; N components asking for the same slice share
 *     ONE channel with N handlers. React re-renders therefore cannot multiply
 *     channels, and the last unsubscribe tears the channel down.
 *   * FAILURE-SAFE. With no env vars, on the server, or if Realtime throws, the
 *     helpers no-op and return a no-op unsubscribe. A Realtime outage must never
 *     break gameplay — callers keep their existing HTTP fetch behavior.
 *   * RECONNECT-AWARE. `.subscribe()`'s status callback is surfaced through
 *     `onStatus`, so callers can fall back to polling while the channel is
 *     `CHANNEL_ERROR`/`TIMED_OUT`/`CLOSED` and stop when it is `SUBSCRIBED`.
 *
 * Prerequisites:
 *   1. Env vars (set in Vercel / local .env): NEXT_PUBLIC_SUPABASE_URL and the
 *      publishable key. Supabase renamed the legacy "anon key" to "publishable
 *      key" (same role, new label). This module accepts
 *      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY first, then
 *      NEXT_PUBLIC_SUPABASE_ANON_KEY, then
 *      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY.
 *   2. The table must be a member of the `supabase_realtime` publication and,
 *      because RLS is enabled, must carry a SELECT policy for the subscriber
 *      role — see src/db/migrations/0096 + 0097 + 0204.
 *
 * ⚠️ Security: this app authenticates with Clerk, not Supabase Auth, and RLS is
 * off on some tables. Realtime streams FULL rows to anyone holding the public
 * publishable key, so ONLY publish non-sensitive tables. NEVER publish `users`
 * (email / password hash / balance), the token ledger, auth/session tables, or
 * any staked game table (wager / payout columns). The browser may ONLY ever use
 * the publishable/anon key — the service-role key and DB credentials must never
 * reach the client bundle. Only the `NEXT_PUBLIC_*` vars below are read here.
 */

import {
  createClient,
  type RealtimeChannel,
  type RealtimePostgresChangesFilter,
  type RealtimePostgresChangesPayload,
  type SupabaseClient,
} from "@supabase/supabase-js";

/** The Postgres change verbs Realtime can deliver. */
export type RealtimeEvent = "INSERT" | "UPDATE" | "DELETE";
/** A verb or `"*"` for every verb. */
export type RealtimeEventFilter = RealtimeEvent | "*";

/**
 * Channel lifecycle status, as reported by `RealtimeChannel.subscribe`.
 * `SUBSCRIBED` means live; anything else means the push path is down and the
 * caller should lean on its HTTP fallback.
 */
export type RealtimeStatus =
  | "SUBSCRIBED"
  | "TIMED_OUT"
  | "CLOSED"
  | "CHANNEL_ERROR";

export interface PostgresChangePayload<T = Record<string, unknown>> {
  schema: string;
  table: string;
  eventType: "INSERT" | "UPDATE" | "DELETE";
  new: T;
  old: T;
}

export interface RealtimeSubscriptionOptions<T extends Record<string, unknown>> {
  table: string;
  /** Defaults to `"*"`. */
  event?: RealtimeEventFilter;
  /** Optional PostgREST filter, e.g. `id=eq.123`. Prefer the helpers below. */
  filter?: string;
  /** Defaults to `"public"`. */
  schema?: string;
  handler: (payload: PostgresChangePayload<T>) => void;
  /** Optional channel-status listener (reconnect handling). */
  onStatus?: (status: RealtimeStatus) => void;
}

export interface FilteredSubscriptionOptions<
  T extends Record<string, unknown>,
> extends Omit<RealtimeSubscriptionOptions<T>, "filter"> {
  /** Column to filter on, e.g. `id`, `match_id`, `game_id`. */
  column: string;
  /** Value the column must equal, e.g. a match id. */
  value: string | number;
}

/** Options shared by the match/game convenience subscriptions. */
export interface ScopedSubscriptionOptions<
  T extends Record<string, unknown>,
> extends Omit<RealtimeSubscriptionOptions<T>, "filter"> {
  /** Column holding the match/game id. Defaults to `"id"`. */
  idColumn?: string;
}

const noop = () => {};

function devWarn(...args: unknown[]): void {
  if (process.env.NODE_ENV !== "production") {
    // eslint-disable-next-line no-console
    console.warn(...args);
  }
}

// ── Pure helpers (exported so they can be unit-tested without a network) ────

/**
 * Resolve the browser-safe Supabase credentials from the environment.
 * Returns `null` when either half is missing, which disables Realtime.
 */
export function realtimeConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): { url: string; key: string } | null {
  const url = String(env.NEXT_PUBLIC_SUPABASE_URL || "").trim().replace(/\/$/, "");
  // Supabase renamed the legacy "anon key" to "publishable key" — accept both
  // names so either works. Same token role, only the label changed.
  const key = String(
    env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
      env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
      env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY ||
      "",
  ).trim();

  if (!url || !key) return null;
  return { url, key };
}

/**
 * Build a safe PostgREST equality filter (`column=eq.value`).
 *
 * Returns `null` for anything that could break or escape the filter syntax
 * (commas, parentheses, quotes, whitespace, empty values). Callers MUST treat a
 * `null` as "do not subscribe" rather than "subscribe unfiltered" — silently
 * widening a match subscription to the whole table is the unsafe failure mode.
 */
export function buildRealtimeFilter(
  column: string,
  value: string | number | null | undefined,
): string | null {
  const col = String(column || "").trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(col)) return null;
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  // Ids are uuids / numeric / opaque tokens. Reject anything with PostgREST
  // metacharacters (`,` `(` `)` `"` `'` whitespace) so the filter cannot be
  // injected or truncated.
  if (!/^[A-Za-z0-9._:@-]+$/.test(raw)) return null;
  return `${col}=eq.${raw}`;
}

/**
 * Stable channel key. Two subscriptions with the same table/event/filter share
 * ONE underlying channel — this is what makes duplicate subscriptions (e.g.
 * from a React re-render) impossible.
 */
export function realtimeChannelKey(options: {
  schema?: string;
  table: string;
  event?: RealtimeEventFilter;
  filter?: string;
}): string {
  return [
    options.schema || "public",
    options.table,
    options.event || "*",
    options.filter || "*",
  ].join(":");
}

// ── The one shared client ───────────────────────────────────────────────────

type RealtimeGlobal = typeof globalThis & {
  __gryndRealtimeClient?: SupabaseClient | null;
};

let cachedClient: SupabaseClient | null = null;

/**
 * The single Supabase client for this browser session.
 *
 * Lazily created, cached on `globalThis` (HMR-safe), and never created during
 * SSR. Returns `null` when env vars are missing or the client cannot be built —
 * every caller must handle `null` by degrading to its HTTP path.
 */
export function getRealtimeClient(): SupabaseClient | null {
  // Realtime is a browser-only concern; never build a client on the server.
  if (typeof window === "undefined") return null;

  const g = globalThis as RealtimeGlobal;
  if (cachedClient) return cachedClient;
  if (g.__gryndRealtimeClient) {
    cachedClient = g.__gryndRealtimeClient;
    return cachedClient;
  }

  // Read each `process.env.NEXT_PUBLIC_*` member DIRECTLY (not via a variable)
  // so Next.js's build-time DefinePlugin still inlines the literals into the
  // browser bundle. Accessing them through an indirection would leave them
  // undefined at runtime and silently disable Realtime in production.
  const config = realtimeConfigFromEnv({
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY:
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY,
  });
  if (!config) {
    devWarn(
      "NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY (or NEXT_PUBLIC_SUPABASE_ANON_KEY / NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY) are missing. Supabase Realtime features are disabled.",
    );
    return null;
  }

  try {
    const client = createClient(config.url, config.key);
    cachedClient = client;
    g.__gryndRealtimeClient = client;
    return client;
  } catch (error) {
    devWarn("[realtime] failed to create Supabase client:", error);
    return null;
  }
}

/** True when a Supabase client could be created in this environment. */
export function isRealtimeEnabled(): boolean {
  return getRealtimeClient() !== null;
}

// ── The deduplicating channel registry ──────────────────────────────────────

interface ChannelEntry {
  key: string;
  channel: RealtimeChannel;
  handlers: Set<(payload: PostgresChangePayload<Record<string, unknown>>) => void>;
  statusHandlers: Set<(status: RealtimeStatus) => void>;
  status: RealtimeStatus;
}

const registry = new Map<string, ChannelEntry>();

function broadcastStatus(entry: ChannelEntry, status: RealtimeStatus): void {
  entry.status = status;
  for (const listener of entry.statusHandlers) {
    try {
      listener(status);
    } catch (error) {
      devWarn("[realtime] status handler threw:", error);
    }
  }
}

function deliver(entry: ChannelEntry, payload: PostgresChangePayload<Record<string, unknown>>): void {
  for (const handler of entry.handlers) {
    try {
      handler(payload);
    } catch (error) {
      // A consumer's handler must never take down the push loop.
      devWarn("[realtime] subscription handler threw:", error);
    }
  }
}

/**
 * Subscribe to Postgres changes on a table, reusing the shared channel for an
 * identical `schema:table:event:filter` slice. Returns an idempotent
 * unsubscribe that removes this handler (and the channel when it was the last).
 *
 * Never throws: with Realtime disabled or unavailable it returns a no-op.
 */
export function subscribeToTableChanges<T extends Record<string, unknown>>(
  options: RealtimeSubscriptionOptions<T>,
): () => void {
  const supabase = getRealtimeClient();
  if (!supabase || !options.table) return noop;

  try {
    const schema = options.schema || "public";
    const event = options.event || "*";
    const key = realtimeChannelKey({
      schema,
      table: options.table,
      event,
      filter: options.filter,
    });

    let entry = registry.get(key);
    if (!entry) {
      const channel = supabase.channel(key);
      // The entry is created BEFORE `.on` so the mutable sets are always
      // present; the listener closures read the live sets on every event.
      const created: ChannelEntry = {
        key,
        channel,
        handlers: new Set(),
        statusHandlers: new Set(),
        status: "CLOSED",
      };
      registry.set(key, created);
      entry = created;

      const filter = {
        event,
        schema,
        table: options.table,
        ...(options.filter ? { filter: options.filter } : {}),
      } as unknown as RealtimePostgresChangesFilter<"*">;

      channel.on<RealtimePostgresChangesPayload<Record<string, unknown>>>(
        "postgres_changes",
        filter,
        (payload) => {
          const live = registry.get(key);
          if (!live) return;
          deliver(live, payload as unknown as PostgresChangePayload<Record<string, unknown>>);
        },
      );

      // supabase-js re-subscribes this channel automatically after a transport
      // reconnect; the status callback is how callers observe that (and fall
      // back to polling while it is not SUBSCRIBED).
      channel.subscribe((status) => {
        const live = registry.get(key);
        if (!live) return;
        broadcastStatus(live, status as RealtimeStatus);
      });
    }

    const handler = options.handler as (
      payload: PostgresChangePayload<Record<string, unknown>>,
    ) => void;
    entry.handlers.add(handler);

    const statusHandler = options.onStatus
      ? (options.onStatus as (status: RealtimeStatus) => void)
      : null;
    if (statusHandler) {
      entry.statusHandlers.add(statusHandler);
      // Replay the current status so a late subscriber is not left "unknown".
      if (entry.status !== "CLOSED") {
        try {
          statusHandler(entry.status);
        } catch (error) {
          devWarn("[realtime] status handler threw:", error);
        }
      }
    }

    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      const live = registry.get(key);
      if (!live) return;
      live.handlers.delete(handler);
      if (statusHandler) live.statusHandlers.delete(statusHandler);
      if (live.handlers.size === 0) {
        try {
          supabase.removeChannel(live.channel);
        } catch (error) {
          devWarn("[realtime] failed to remove channel:", error);
        }
        registry.delete(key);
      }
    };
  } catch (error) {
    devWarn("[realtime] subscribeToTableChanges failed:", error);
    return noop;
  }
}

/**
 * Subscribe to Postgres changes on a table.
 *
 * Kept as the original public entry point: same name, same signature, same
 * return (an unsubscribe function). It now delegates to the shared,
 * deduplicating registry.
 */
export function subscribeToPostgresChanges<T extends Record<string, unknown>>(options: {
  table: string;
  event?: RealtimeEventFilter;
  filter?: string;
  handler: (payload: PostgresChangePayload<T>) => void;
}): () => void {
  return subscribeToTableChanges<T>(options);
}

/** Subscribe to INSERT events only. */
export function subscribeToInserts<T extends Record<string, unknown>>(
  options: Omit<RealtimeSubscriptionOptions<T>, "event">,
): () => void {
  return subscribeToTableChanges<T>({ ...options, event: "INSERT" });
}

/** Subscribe to UPDATE events only. */
export function subscribeToUpdates<T extends Record<string, unknown>>(
  options: Omit<RealtimeSubscriptionOptions<T>, "event">,
): () => void {
  return subscribeToTableChanges<T>({ ...options, event: "UPDATE" });
}

/** Subscribe to DELETE events only. */
export function subscribeToDeletes<T extends Record<string, unknown>>(
  options: Omit<RealtimeSubscriptionOptions<T>, "event">,
): () => void {
  return subscribeToTableChanges<T>({ ...options, event: "DELETE" });
}

/**
 * Subscribe to ONE table slice: a single column equal to a single value.
 *
 * This is the preferred shape for match/game state — a client subscribes to
 * its own row, not every client to every row. An unbuildable filter (an unsafe
 * id) produces a no-op subscription rather than an unfiltered one.
 */
export function subscribeToFilteredChanges<T extends Record<string, unknown>>(
  options: FilteredSubscriptionOptions<T>,
): () => void {
  const filter = buildRealtimeFilter(options.column, options.value);
  if (!filter) {
    devWarn(
      `[realtime] refusing to subscribe to ${options.table}: unsafe filter value for column "${options.column}".`,
    );
    return noop;
  }
  return subscribeToTableChanges<T>({
    table: options.table,
    event: options.event,
    schema: options.schema,
    filter,
    handler: options.handler,
    onStatus: options.onStatus,
  });
}

/**
 * `matchId -> realtime subscription -> state update`.
 *
 * Subscribes to the row(s) of `table` whose `idColumn` equals `matchId`.
 * Realtime events are NOTIFICATIONS ONLY — the caller still treats the existing
 * HTTP read (or the server's authoritative write) as the source of truth and
 * must never move game logic into the browser because of a push.
 */
export function subscribeToMatchChanges<T extends Record<string, unknown>>(
  options: ScopedSubscriptionOptions<T> & { matchId: string | number },
): () => void {
  return subscribeToFilteredChanges<T>({
    table: options.table,
    event: options.event,
    schema: options.schema,
    column: options.idColumn || "id",
    value: options.matchId,
    handler: options.handler,
    onStatus: options.onStatus,
  });
}

/**
 * `gameId -> realtime subscription -> state update`.
 *
 * Alias of the match pattern with game-oriented column naming, kept separate so
 * call sites read as the domain they belong to.
 */
export function subscribeToGameChanges<T extends Record<string, unknown>>(
  options: ScopedSubscriptionOptions<T> & { gameId: string | number },
): () => void {
  return subscribeToFilteredChanges<T>({
    table: options.table,
    event: options.event,
    schema: options.schema,
    column: options.idColumn || "id",
    value: options.gameId,
    handler: options.handler,
    onStatus: options.onStatus,
  });
}

// ── Chat (existing public API, unchanged shape) ─────────────────────────────

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
 * substantially (game rooms are where chat churns fastest). Game-room ids are
 * pathnames like `/casino/plinko/5` — slashes break Supabase's filter syntax,
 * which is why the room filter can't target them server-side.
 *
 * The caller still re-checks room_type/room_id so this stays correct if
 * multiple global rooms are ever introduced.
 */
export function subscribeToChatMessages(
  handler: (row: ChatMessageRealtimeRow) => void,
): () => void {
  return subscribeToTableChanges<Record<string, unknown>>({
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
