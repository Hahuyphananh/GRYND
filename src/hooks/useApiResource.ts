"use client";

import { useCallback, useMemo } from "react";
import useSWR, { mutate as globalMutate, type SWRConfiguration } from "swr";
import { getCacheTimestamp } from "../lib/cache/persistentSwrCache";

export type ApiResource<T> = {
  data: T | undefined;
  error: unknown;
  /** True only while there is no data yet (the first, blocking load). */
  isLoading: boolean;
  /** True on any request in flight, including background refreshes. */
  isValidating: boolean;
  hasData: boolean;
  /** Epoch ms when the current payload was cached, or null. */
  cachedAt: number | null;
  refresh: () => Promise<unknown>;
};

/**
 * Thin wrapper over `useSWR` that gives screens the handful of things the
 * shared states need: whether we have anything to show, whether the *first*
 * load is still pending, and how old the cached payload is.
 *
 * Pair with `<AsyncState>`:
 *
 *   const users = useApiResource<User[]>("/api/leaderboard/all-time");
 *   <AsyncState
 *     isLoading={users.isLoading}
 *     error={users.error}
 *     hasData={users.hasData}
 *     isEmpty={users.data?.items?.length === 0}
 *     onRetry={users.refresh}
 *     cachedAt={users.cachedAt}
 *   >
 *     ...
 *   </AsyncState>
 *
 * Pass `null` as the key to skip fetching (e.g. while signed out).
 */
export function useApiResource<T = unknown>(
  key: string | null,
  options?: SWRConfiguration<T>,
): ApiResource<T> {
  const { data, error, isLoading, isValidating, mutate } = useSWR<T>(key, options);

  const refresh = useCallback(async () => {
    if (!key) return undefined;
    // Revalidate even when the key isn't currently subscribed elsewhere.
    return globalMutate(key);
  }, [key]);

  const hasData = data !== undefined && data !== null;
  const cachedAt = useMemo(
    () => (key ? getCacheTimestamp(key) : null),
    // Re-read the stamp whenever the payload changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key, data],
  );

  return {
    data,
    error,
    isLoading: isLoading && !hasData,
    isValidating,
    hasData,
    cachedAt,
    refresh,
  };
}
