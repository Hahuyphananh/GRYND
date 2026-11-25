"use client";

// The ranked lobby's friend challenge tab.
//
// The friends list is the server's own `/api/friends/list`; the search is a
// local filter over those rows, so a player cannot accidentally send a
// challenge to a stranger. The challenge itself is the existing
// `/api/rooms/challenge` endpoint, which re-checks the friendship server-side
// and creates the same private, one-invitee room the profile rooms panel uses.

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useUser } from "@clerk/nextjs";
import {
  IconLink,
  IconSearch,
  IconSwords,
  IconUsers,
} from "@tabler/icons-react";

import FriendChallengePanel from "./FriendChallengePanel";

type Friend = {
  id?: string | number;
  clerk_id?: string | null;
  name?: string | null;
  icon_key?: string | null;
};

type Tab = "friends" | "link";

type Created = { roomId: string; name: string };

export default function RankedFriendsPanel() {
  const { isLoaded, isSignedIn } = useUser();
  const [tab, setTab] = useState<Tab>("friends");
  const [friends, setFriends] = useState<Friend[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<Created | null>(null);

  useEffect(() => {
    if (!isSignedIn) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch("/api/friends/list", {
          credentials: "include",
          cache: "no-store",
        });
        const data = await response.json().catch(() => null);
        if (cancelled) return;
        if (!response.ok || !data?.success) {
          setError(data?.error || "Could not load your friends.");
          setFriends([]);
          return;
        }
        const rows = Array.isArray(data.friends)
          ? data.friends
          : Array.isArray(data.data)
            ? data.data
            : [];
        setFriends(rows);
      } catch {
        if (!cancelled) setError("Could not load your friends.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isSignedIn]);

  const visible = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return friends;
    return friends.filter((friend) =>
      String(friend.name || "").toLowerCase().includes(query),
    );
  }, [friends, search]);

  const challenge = useCallback(
    async (friend: Friend) => {
      if (busyId || !friend.clerk_id) return;
      const key = String(friend.clerk_id);
      setBusyId(key);
      setError(null);
      setCreated(null);
      try {
        const response = await fetch("/api/rooms/challenge", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            gameKey: "solitaire-duel",
            friendUserId: key,
          }),
        });
        const data = await response.json().catch(() => null);
        if (!response.ok || !data?.success || !data?.room?.id) {
          setError(data?.error || "Could not create the private room.");
          return;
        }
        setCreated({
          roomId: String(data.room.id),
          name: String(friend.name || "your friend"),
        });
      } catch {
        setError("Could not create the private room.");
      } finally {
        setBusyId(null);
      }
    },
    [busyId],
  );

  if (!isLoaded) return null;

  if (!isSignedIn) {
    return (
      <div className="mt-4 rounded-xl border border-white/10 bg-white/[0.02] p-4">
        <p className="text-xs font-black uppercase tracking-[0.16em] text-cyan-200/70">
          Friends
        </p>
        <p className="mt-1 text-xs leading-relaxed text-white/45">
          Sign in to search your friends and open a private Solitaire Duel
          against them.
        </p>
        <Link
          href="/sign-in?redirect_url=/play/ranked"
          className="mt-3 inline-block text-xs font-bold text-cyan-200 underline-offset-4 hover:underline"
        >
          Sign in to challenge a friend →
        </Link>
      </div>
    );
  }

  return (
    <div
      className="mt-4 rounded-xl border border-white/10 bg-white/[0.02] p-4"
      data-testid="ranked-friends-panel"
    >
      <div
        role="tablist"
        aria-label="Find a friend opponent"
        className="flex flex-wrap gap-2"
      >
        <button
          type="button"
          role="tab"
          aria-selected={tab === "friends"}
          onClick={() => setTab("friends")}
          className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-black uppercase tracking-[0.12em] transition ${
            tab === "friends"
              ? "bg-cyan-500/80 text-[#04121a]"
              : "border border-white/10 bg-white/[0.03] text-white/60 hover:text-white"
          }`}
        >
          <IconUsers size={14} aria-hidden="true" />
          Search friends
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "link"}
          onClick={() => setTab("link")}
          className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-black uppercase tracking-[0.12em] transition ${
            tab === "link"
              ? "bg-cyan-500/80 text-[#04121a]"
              : "border border-white/10 bg-white/[0.03] text-white/60 hover:text-white"
          }`}
        >
          <IconLink size={14} aria-hidden="true" />
          Share a link
        </button>
      </div>

      {tab === "friends" ? (
        <div className="mt-4" role="tabpanel" aria-label="Search friends">
          <label htmlFor="ranked-friend-search" className="sr-only">
            Search your friends
          </label>
          <div className="flex items-center gap-2 rounded-lg border border-white/10 bg-black/25 px-3">
            <IconSearch size={15} className="text-white/35" aria-hidden="true" />
            <input
              id="ranked-friend-search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search your friends by name"
              className="min-w-0 flex-1 bg-transparent py-2.5 text-sm text-white outline-none placeholder:text-white/30"
              data-testid="ranked-friend-search"
            />
          </div>

          {loading ? (
            <p className="mt-3 text-xs text-white/40">Loading friends…</p>
          ) : visible.length === 0 ? (
            <p className="mt-3 text-xs leading-relaxed text-white/45">
              {friends.length === 0
                ? "No friends yet. Add a friend from your profile first."
                : "No friend matches that name."}
            </p>
          ) : (
            <ul className="mt-3 space-y-2">
              {visible.map((friend) => {
                const key = String(friend.clerk_id || "");
                return (
                  <li
                    key={key || String(friend.id || friend.name)}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-white/8 bg-white/[0.02] px-3 py-2"
                    data-testid="ranked-friend-row"
                  >
                    <span className="flex min-w-0 items-center gap-2.5">
                      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full border border-white/10 bg-white/[0.05] text-[11px] font-black text-white/60">
                        {String(friend.name || "?").slice(0, 1).toUpperCase()}
                      </span>
                      <span className="truncate text-sm font-semibold text-white/85">
                        {friend.name || "Unknown player"}
                      </span>
                    </span>
                    <button
                      type="button"
                      onClick={() => challenge(friend)}
                      disabled={!key || busyId === key}
                      className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-cyan-400/30 bg-cyan-400/10 px-3 py-1.5 text-[11px] font-black uppercase tracking-[0.1em] text-cyan-100 transition hover:bg-cyan-400/20 disabled:opacity-40"
                    >
                      <IconSwords size={13} aria-hidden="true" />
                      {busyId === key ? "Creating…" : "Challenge"}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          {created ? (
            <div
              role="status"
              className="mt-3 rounded-lg border border-emerald-400/30 bg-emerald-400/10 px-3 py-2 text-xs text-emerald-100"
              data-testid="ranked-challenge-created"
            >
              <p className="font-bold">
                Private room created against {created.name}.
              </p>
              <Link
                href={`/rooms/${encodeURIComponent(created.roomId)}`}
                className="mt-1 inline-block font-bold underline underline-offset-4"
              >
                Open the private room →
              </Link>
            </div>
          ) : null}

          {error ? (
            <p role="alert" className="mt-3 text-xs text-rose-300">
              {error}
            </p>
          ) : null}
        </div>
      ) : (
        <div className="mt-3" role="tabpanel" aria-label="Share a challenge link">
          <FriendChallengePanel embedded />
        </div>
      )}
    </div>
  );
}
