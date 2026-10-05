"use client";

// ── useSharedPoll — one fetch per browser, shared to every tab ───────────
//
// Every open tab used to run its own interval for the same lobby reads (live
// stats, friend presence, per-game active counts). Five tabs meant five
// identical requests per tick, and a hidden tab kept ticking. This collapses
// that to ONE request per tick per BROWSER:
//
//   * tabs coordinate through a `localStorage` leader lease — only the leader
//     tab fetches;
//   * the leader broadcasts the payload on a `BroadcastChannel`, so every other
//     tab updates instantly and does no request at all;
//   * a new tab asks the leader for the current payload (`hello`) instead of
//     fetching its own;
//   * if the leader tab is hidden/closed, its lease expires and another tab
//     takes over — the payload keeps flowing;
//   * a follower that has heard nothing for a while self-heals with its own
//     fetch, so a coordination failure degrades to per-tab polling rather than
//     a frozen lobby.
//
// It is deliberately a LIGHTWEIGHT AGGREGATED source, not row-by-row Realtime:
// the underlying numbers (a presence COUNT, a friend join) cannot safely be
// published as rows, so the aggregate is what gets shared.
//
// Safety: if `BroadcastChannel` is unavailable the lease is disabled and every
// tab polls on its own — exactly the previous behaviour. Nothing here may ever
// leave a caller without data.

import { useEffect, useRef, useState } from "react";
import { leaseIsFree, renewLease } from "../lib/sharedPoll";

export type SharedPollStatus = "loading" | "ready" | "error";

interface Subscriber {
  push: (data: unknown, status: SharedPollStatus) => void;
}

interface Entry {
  name: string;
  fetcher: () => Promise<unknown>;
  intervalMs: number;
  subs: Set<Subscriber>;
  data: unknown;
  status: SharedPollStatus;
  timer: ReturnType<typeof setInterval> | null;
  channel: BroadcastChannel | null;
  lastDataAt: number;
  inFlight: boolean;
  /** One-shot: give the leader a moment to answer `hello` before self-fetching. */
  helloFallback: ReturnType<typeof setTimeout> | null;
}

const registry = new Map<string, Entry>();

function getStorage(): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Cross-tab sharing needs BroadcastChannel; without it we poll per-tab. */
function canShare(): boolean {
  return typeof window !== "undefined" && typeof BroadcastChannel !== "undefined";
}

function leaseKeyFor(name: string): string {
  return `grynd:shared-poll:${name}:leader`;
}

function isHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

function notify(entry: Entry): void {
  for (const sub of entry.subs) sub.push(entry.data, entry.status);
}

function broadcast(entry: Entry, message: unknown): void {
  try {
    entry.channel?.postMessage(message);
  } catch {
    // A failed broadcast is non-fatal — followers self-heal.
  }
}

function fetchNow(entry: Entry): void {
  if (entry.inFlight) return;
  entry.inFlight = true;
  Promise.resolve()
    .then(() => entry.fetcher())
    .then((payload) => {
      if (payload === undefined) return; // fetcher signalled "no update"
      entry.data = payload;
      entry.status = "ready";
      entry.lastDataAt = Date.now();
      clearHelloFallback(entry);
      notify(entry);
      broadcast(entry, { type: "data", payload, at: entry.lastDataAt });
    })
    .catch(() => {
      entry.status = "error";
      notify(entry);
    })
    .finally(() => {
      entry.inFlight = false;
    });
}

function tick(entry: Entry): void {
  if (entry.subs.size === 0) return;
  if (isHidden()) return; // hidden tabs do no work
  const now = Date.now();
  const storage = canShare() ? getStorage() : null;
  const leaseKey = leaseKeyFor(entry.name);

  // Leader (or no live leader) → fetch and renew. `leaseIsFree(null)` is true,
  // so without BroadcastChannel every tab fetches (previous behaviour).
  if (leaseIsFree(storage, leaseKey, now)) {
    renewLease(storage, leaseKey, now, entry.intervalMs * 1.5);
    fetchNow(entry);
    return;
  }

  // A follower that has never received data — a freshly opened tab: ask the
  // leader for its payload instead of duplicating the read, and only fall back
  // to our own fetch if the answer never comes.
  if (entry.lastDataAt === 0) {
    broadcast(entry, { type: "hello" });
    scheduleHelloFallback(entry);
    return;
  }

  // Follower: heard nothing for a while → self-heal rather than go stale.
  if (now - entry.lastDataAt > entry.intervalMs * 1.6) {
    fetchNow(entry);
  } else {
    // Ask the leader to re-broadcast its current payload.
    broadcast(entry, { type: "hello" });
  }
}

function clearHelloFallback(entry: Entry): void {
  if (entry.helloFallback === null) return;
  clearTimeout(entry.helloFallback);
  entry.helloFallback = null;
}

/**
 * A fresh follower gives the leader a short grace period to answer `hello`,
 * then fetches for itself so a missing/unresponsive leader can only delay the
 * lobby by a moment — never freeze it.
 */
function scheduleHelloFallback(entry: Entry): void {
  if (entry.helloFallback !== null) return;
  entry.helloFallback = setTimeout(() => {
    entry.helloFallback = null;
    if (entry.subs.size === 0) return;
    if (entry.lastDataAt !== 0) return; // the leader answered in time
    if (isHidden()) return;
    fetchNow(entry);
  }, 1200);
}

function startTimer(entry: Entry): void {
  if (entry.timer !== null) return;
  entry.timer = setInterval(() => tick(entry), entry.intervalMs);
}

function stopTimer(entry: Entry): void {
  if (entry.timer === null) return;
  clearInterval(entry.timer);
  entry.timer = null;
}

function onVisibility(entry: Entry): void {
  if (isHidden()) {
    stopTimer(entry);
    return;
  }
  tick(entry);
  startTimer(entry);
}

function createEntry(
  name: string,
  fetcher: () => Promise<unknown>,
  intervalMs: number,
): Entry {
  const entry: Entry = {
    name,
    fetcher,
    intervalMs,
    subs: new Set(),
    data: null,
    status: "loading",
    timer: null,
    channel: null,
    lastDataAt: 0,
    inFlight: false,
    helloFallback: null,
  };

  if (canShare()) {
    try {
      entry.channel = new BroadcastChannel(`grynd:shared-poll:${name}`);
      entry.channel.onmessage = (event: MessageEvent) => {
        const msg = event?.data;
        if (!msg || typeof msg !== "object") return;
        if (msg.type === "data") {
          entry.data = msg.payload;
          entry.status = "ready";
          entry.lastDataAt = Number(msg.at) || Date.now();
          clearHelloFallback(entry);
          notify(entry);
        } else if (msg.type === "hello") {
          // Another tab needs the current payload — answer if we have one.
          if (entry.data !== null) {
            broadcast(entry, {
              type: "data",
              payload: entry.data,
              at: entry.lastDataAt || Date.now(),
            });
          }
        }
      };
    } catch {
      entry.channel = null;
    }
  }

  return entry;
}

export interface UseSharedPollResult<T> {
  data: T | null;
  status: SharedPollStatus;
  /** Force a fresh read now (visibility/online regain, a manual action). */
  refresh: () => void;
}

/**
 * Subscribe to a browser-wide shared poll.
 *
 * `name` identifies the logical stream (e.g. `"live-stats"`); every tab and
 * every component that uses the same name shares one fetch. `fetcher` returns
 * the payload to broadcast; return `undefined` to signal "no update".
 */
export function useSharedPoll<T>(
  name: string,
  fetcher: () => Promise<T>,
  { intervalMs, enabled = true }: { intervalMs: number; enabled?: boolean },
): UseSharedPollResult<T> {
  const fetcherRef = useRef(fetcher);
  useEffect(() => {
    fetcherRef.current = fetcher;
  });

  const [state, setState] = useState<{ data: T | null; status: SharedPollStatus }>(
    () => {
      const existing = registry.get(name);
      return {
        data: (existing?.data as T) ?? null,
        status: existing?.status ?? "loading",
      };
    },
  );

  useEffect(() => {
    if (!enabled || !name || !intervalMs) return undefined;
    if (typeof window === "undefined") return undefined;

    let entry = registry.get(name);
    if (!entry) {
      entry = createEntry(name, () => fetcherRef.current() as Promise<unknown>, intervalMs);
      registry.set(name, entry);
    }
    // Always read the LATEST fetcher, even when the entry already existed.
    entry.fetcher = () => fetcherRef.current() as Promise<unknown>;
    entry.intervalMs = intervalMs;

    const sub: Subscriber = {
      push: (data, status) => setState({ data: (data as T) ?? null, status }),
    };
    entry.subs.add(sub);
    // Adopt whatever the entry already has (this tab, another component).
    sub.push(entry.data, entry.status);

    // Prime immediately: the leader fetches; a follower asks for the payload.
    tick(entry);
    startTimer(entry);

    const onVisibilityChange = () => onVisibility(entry as Entry);
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("online", onVisibilityChange);

    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("online", onVisibilityChange);
      entry!.subs.delete(sub);
      if (entry!.subs.size === 0) {
        clearHelloFallback(entry!);
        stopTimer(entry!);
        try {
          entry!.channel?.close();
        } catch {
          // ignore
        }
        registry.delete(name);
      }
    };
  }, [name, intervalMs, enabled]);

  const refresh = () => {
    const entry = registry.get(name);
    if (entry) fetchNow(entry);
  };

  return { data: state.data, status: state.status, refresh };
}

export default useSharedPoll;
