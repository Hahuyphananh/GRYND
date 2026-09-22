"use client";

import type { ReactNode } from "react";
import { SWRConfig } from "swr";
import { createPersistentSwrCache } from "../lib/cache/persistentSwrCache";

export class HttpError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

/**
 * Default SWR fetcher. Parses the body defensively (some error paths return
 * an empty body) and throws an Error carrying the server's own message plus
 * the HTTP status so screens can tell "server said no" apart from "network
 * down".
 */
export async function swrFetcher<T = unknown>(url: string): Promise<T> {
  const response = await fetch(url, { credentials: "include" });

  let payload: any = null;
  try {
    const text = await response.text();
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }

  if (!response.ok) {
    throw new HttpError(
      payload?.error || payload?.message || `Request failed (${response.status})`,
      response.status,
    );
  }

  return payload as T;
}

/**
 * App-wide SWR defaults.
 *
 * The point of these values is the "instant from cache, refresh underneath"
 * feel: `keepPreviousData` means a key change (a leaderboard tab, a game
 * filter) shows the previous rows until the new ones land instead of
 * flashing a skeleton, and `dedupingInterval` collapses the burst of
 * identical requests a screen like the lobby would otherwise fire.
 *
 * `revalidateOnReconnect` handles the offline case for every SWR screen at
 * once — the global <OfflineBanner> covers the rest.
 */
export function SWRProvider({ children }: { children: ReactNode }) {
  return (
    <SWRConfig
      value={{
        provider: createPersistentSwrCache,
        fetcher: swrFetcher,
        // Cache-first, then refresh in the background.
        revalidateOnMount: true,
        revalidateOnFocus: true,
        revalidateOnReconnect: true,
        keepPreviousData: true,
        dedupingInterval: 4000,
        focusThrottleInterval: 30000,
        loadingTimeout: 8000,
        shouldRetryOnError: true,
        errorRetryCount: 3,
      }}
    >
      {children}
    </SWRConfig>
  );
}
