"use client";

// src/hooks/useRooms.ts
//
// The client state behind the rooms UI: the caller's rooms + invitations, and
// every action on them.
//
// TRANSPORT — the database row is the source of truth, the socket is an
// accelerator:
//   * `rooms:changed` arrives in the caller's OWN verified `user:<clerkId>`
//     room (the realtime server derives the room id from the Clerk subject on
//     the socket, so nobody else's signal can arrive here). It carries no room,
//     code, game or inviter — it only means "refetch", which this hook does
//     over the caller's authenticated session.
//   * a 20-second poll while the tab is visible covers an offline friend, a cold
//     realtime instance and a socket that never connected. It never runs while
//     the tab is hidden.
//
// IDEMPOTENCE ON THE CLIENT: every action is guarded by a per-action `busy`
// key, so a double click cannot send the same accept/start twice. The server
// re-checks all of it anyway — this is only to keep the UI honest about what is
// in flight.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSocket } from "../context/SocketProvider";
import { ROOM_GAMES } from "../lib/rooms/catalog";
import type { RoomGameOption, RoomView } from "../lib/rooms/types";

const POLL_INTERVAL_MS = 20_000;

interface ApiFailure {
  code?: string;
  error?: string;
}

/** The result every action reports: a notice on success, or an error code. */
export interface RoomFeedback {
  ok: boolean;
  code: string;
  message: string;
}

export function useRooms({ enabled = true }: { enabled?: boolean } = {}) {
  const { socket } = useSocket();
  const [rooms, setRooms] = useState<RoomView[]>([]);
  const [games, setGames] = useState<RoomGameOption[]>(ROOM_GAMES as RoomGameOption[]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiFailure | null>(null);
  const [busy, setBusy] = useState<string>("");
  const [feedback, setFeedback] = useState<RoomFeedback | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/rooms", {
        credentials: "include",
        cache: "no-store",
      });
      const data = await response.json().catch(() => null);
      if (!mounted.current) return;
      if (!response.ok || !data?.success) {
        setError({ code: data?.code, error: data?.error });
        setLoading(false);
        return;
      }
      setRooms(Array.isArray(data.rooms) ? data.rooms : []);
      if (Array.isArray(data.games) && data.games.length > 0) {
        setGames(data.games as RoomGameOption[]);
      }
      setError(null);
      setLoading(false);
    } catch (err) {
      // A failed refresh never blanks what is already on screen.
      if (!mounted.current) return;
      setError({ code: "network", error: (err as Error)?.message });
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      setRooms([]);
      setLoading(false);
      return;
    }
    void refresh();
  }, [enabled, refresh]);

  // Realtime accelerator: a signal means "something changed for you".
  useEffect(() => {
    if (!enabled || !socket) return;
    const onChanged = () => {
      void refresh();
    };
    socket.on("rooms:changed", onChanged);
    return () => {
      socket.off("rooms:changed", onChanged);
    };
  }, [enabled, socket, refresh]);

  // Polling backstop, visible tabs only.
  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      void refresh();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [enabled, refresh]);

  /**
   * One action = one request. `key` names the action for the busy guard (e.g.
   * `start:<roomId>`), so two different actions can run at once but the same
   * one cannot be fired twice.
   */
  const request = useCallback(
    async (
      key: string,
      url: string,
      init: RequestInit & { method: string },
    ): Promise<RoomFeedback> => {
      setBusy(key);
      setFeedback(null);
      try {
        const response = await fetch(url, {
          credentials: "include",
          headers: init.body ? { "Content-Type": "application/json" } : undefined,
          ...init,
        });
        const data = await response.json().catch(() => null);
        if (!response.ok || !data?.success) {
          const failure: RoomFeedback = {
            ok: false,
            code: String(data?.code || `http_${response.status}`),
            message: String(data?.error || "Something went wrong"),
          };
          if (mounted.current) setFeedback(failure);
          return failure;
        }
        const room: RoomView | undefined = data.room;
        if (room && mounted.current) {
          // Merge the authoritative room the server just returned instead of
          // guessing locally, then let the next refresh reconcile the list.
          setRooms((current) => {
            const others = current.filter((item) => item.id !== room.id);
            return [room, ...others].sort(
              (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
            );
          });
        }
        void refresh();
        const success: RoomFeedback = {
          ok: true,
          code: "",
          message: data?.message ? String(data.message) : "",
        };
        return success;
      } catch (err) {
        const failure: RoomFeedback = {
          ok: false,
          code: "network",
          message: (err as Error)?.message || "Network error",
        };
        if (mounted.current) setFeedback(failure);
        return failure;
      } finally {
        if (mounted.current) setBusy("");
      }
    },
    [refresh],
  );

  const createRoom = useCallback(
    (gameKey: string, stake: number) =>
      request("create", "/api/rooms", {
        method: "POST",
        body: JSON.stringify({ kind: "room", gameKey, stake }),
      }),
    [request],
  );

  const challengeFriend = useCallback(
    (gameKey: string, friendUserId: string) =>
      request(`challenge:${friendUserId}`, "/api/rooms/challenge", {
        method: "POST",
        body: JSON.stringify({ gameKey, friendUserId }),
      }),
    [request],
  );

  const inviteFriend = useCallback(
    (roomId: string, friendUserId: string) =>
      request(`invite:${roomId}`, `/api/rooms/${roomId}/invite`, {
        method: "POST",
        body: JSON.stringify({ friendUserId }),
      }),
    [request],
  );

  const respond = useCallback(
    (roomId: string, accept: boolean) =>
      request(
        `respond:${roomId}`,
        `/api/rooms/${roomId}/respond`,
        { method: "POST", body: JSON.stringify({ accept }) },
      ),
    [request],
  );

  const startRoom = useCallback(
    (roomId: string) =>
      request(`start:${roomId}`, `/api/rooms/${roomId}/start`, { method: "POST" }),
    [request],
  );

  const cancelRoom = useCallback(
    (roomId: string) =>
      request(`cancel:${roomId}`, `/api/rooms/${roomId}`, { method: "DELETE" }),
    [request],
  );

  const joinByCode = useCallback(
    (code: string) =>
      request("join", "/api/rooms/join", {
        method: "POST",
        body: JSON.stringify({ code }),
      }),
    [request],
  );

  const hosted = useMemo(() => rooms.filter((room) => room.isHost), [rooms]);
  const invitations = useMemo(
    () => rooms.filter((room) => !room.isHost && room.inviteStatus === "invited"),
    [rooms],
  );
  const shared = useMemo(
    () => rooms.filter((room) => !room.isHost && room.inviteStatus !== "invited"),
    [rooms],
  );

  return {
    rooms,
    games,
    loading,
    error,
    busy,
    feedback,
    clearFeedback: () => setFeedback(null),
    refresh,
    createRoom,
    challengeFriend,
    inviteFriend,
    respond,
    startRoom,
    cancelRoom,
    joinByCode,
    hosted,
    invitations,
    shared,
  };
}

export type UseRoomsResult = ReturnType<typeof useRooms>;
