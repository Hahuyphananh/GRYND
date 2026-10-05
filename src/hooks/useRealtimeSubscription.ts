"use client";

/**
 * React bindings for the shared Supabase Realtime layer.
 *
 * These hooks own the LIFECYCLE concerns so call sites cannot get them wrong:
 *
 *   * subscribe on mount, unsubscribe on unmount (no leaked channels);
 *   * a stable dependency list (`table`/`event`/`filter`/`enabled`) so a normal
 *     re-render does NOT tear down and rebuild the channel;
 *   * the latest `onEvent` is read through a ref, so an inline callback does not
 *     restart the subscription;
 *   * nothing is subscribed while the component is unmounted or `enabled` is
 *     false;
 *   * channel status is surfaced so a caller can fall back to its HTTP poll
 *     while the push path is down.
 *
 * IMPORTANT: a realtime event is a NOTIFICATION ONLY. The existing HTTP fetch
 * remains the source of truth and must not be removed here — these hooks make
 * it cheaper to KEEP the fetch as a backstop, not to trust the push blindly.
 */

import { useEffect, useRef, useState } from "react";
import {
  subscribeToGameChanges,
  subscribeToMatchChanges,
  subscribeToTableChanges,
  type PostgresChangePayload,
  type RealtimeEventFilter,
  type RealtimeStatus,
} from "../lib/realtime";

/**
 * Channel status surfaced to callers, plus two hook-level states:
 * `CONNECTING` before the first status arrives, and `DISABLED` when the
 * subscription is skipped (no match/game id, `enabled` false, or Realtime
 * unavailable). Callers fall back to their HTTP poll unless this is
 * `SUBSCRIBED`.
 */
type StatusState = RealtimeStatus | "DISABLED" | "CONNECTING";

export interface UseRealtimeSubscriptionOptions<T extends Record<string, unknown>> {
  table: string;
  event?: RealtimeEventFilter;
  /** PostgREST filter, e.g. `id=eq.123`. Prefer the scoped hooks below. */
  filter?: string;
  /** Set false to skip the subscription entirely (e.g. signed out). */
  enabled?: boolean;
  onEvent: (payload: PostgresChangePayload<T>) => void;
  onStatus?: (status: StatusState) => void;
}

/**
 * Keep an always-current reference to the latest callback without letting its
 * identity become a subscription dependency. Assigning in an effect (rather
 * than during render) keeps this safe under concurrent rendering.
 */
function useLatest<T>(value: T) {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  });
  return ref;
}

/**
 * Subscribe to Postgres changes for as long as the component is mounted.
 * Returns the current channel status (`DISABLED` when Realtime is unavailable).
 */
export function useRealtimeSubscription<T extends Record<string, unknown>>(
  options: UseRealtimeSubscriptionOptions<T>,
): StatusState {
  const { table, event = "*", filter, enabled = true } = options;
  const onEventRef = useLatest(options.onEvent);
  const onStatusRef = useLatest(options.onStatus);
  const [status, setStatus] = useState<StatusState>("CONNECTING");

  useEffect(() => {
    if (!enabled || !table) {
      setStatus("DISABLED");
      return undefined;
    }

    let disposed = false;
    const unsubscribe = subscribeToTableChanges<T>({
      table,
      event,
      filter,
      handler: (payload) => {
        if (disposed) return;
        onEventRef.current(payload);
      },
      onStatus: (next) => {
        if (disposed) return;
        setStatus(next);
        onStatusRef.current?.(next);
      },
    });

    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [table, event, filter, enabled]);

  return status;
}

export interface UseScopedRealtimeOptions<T extends Record<string, unknown>> {
  table: string;
  /** Column holding the id. Defaults to `"id"`. */
  idColumn?: string;
  event?: RealtimeEventFilter;
  enabled?: boolean;
  onEvent: (payload: PostgresChangePayload<T>) => void;
  onStatus?: (status: StatusState) => void;
}

/**
 * `matchId -> realtime subscription -> state update`.
 * Subscribes only to this match's row, not to the whole table.
 */
export function useMatchRealtime<T extends Record<string, unknown>>(
  matchId: string | number | null | undefined,
  options: UseScopedRealtimeOptions<T>,
): StatusState {
  const { table, idColumn = "id", event = "*", enabled = true } = options;
  const onEventRef = useLatest(options.onEvent);
  const onStatusRef = useLatest(options.onStatus);
  const [status, setStatus] = useState<StatusState>("CONNECTING");
  const hasId = matchId !== null && matchId !== undefined && String(matchId).trim() !== "";

  useEffect(() => {
    if (!enabled || !table || !hasId) {
      setStatus("DISABLED");
      return undefined;
    }

    let disposed = false;
    const unsubscribe = subscribeToMatchChanges<T>({
      table,
      idColumn,
      matchId: matchId as string | number,
      event,
      handler: (payload) => {
        if (disposed) return;
        onEventRef.current(payload);
      },
      onStatus: (next) => {
        if (disposed) return;
        setStatus(next);
        onStatusRef.current?.(next);
      },
    });

    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [table, idColumn, event, enabled, hasId, matchId]);

  return status;
}

/**
 * `gameId -> realtime subscription -> state update`.
 * Same contract as `useMatchRealtime`, named for the game domain.
 */
export function useGameRealtime<T extends Record<string, unknown>>(
  gameId: string | number | null | undefined,
  options: UseScopedRealtimeOptions<T>,
): StatusState {
  const { table, idColumn = "id", event = "*", enabled = true } = options;
  const onEventRef = useLatest(options.onEvent);
  const onStatusRef = useLatest(options.onStatus);
  const [status, setStatus] = useState<StatusState>("CONNECTING");
  const hasId = gameId !== null && gameId !== undefined && String(gameId).trim() !== "";

  useEffect(() => {
    if (!enabled || !table || !hasId) {
      setStatus("DISABLED");
      return undefined;
    }

    let disposed = false;
    const unsubscribe = subscribeToGameChanges<T>({
      table,
      idColumn,
      gameId: gameId as string | number,
      event,
      handler: (payload) => {
        if (disposed) return;
        onEventRef.current(payload);
      },
      onStatus: (next) => {
        if (disposed) return;
        setStatus(next);
        onStatusRef.current?.(next);
      },
    });

    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [table, idColumn, event, enabled, hasId, gameId]);

  return status;
}
