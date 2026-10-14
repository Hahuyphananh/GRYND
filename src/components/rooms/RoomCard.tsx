"use client";

// src/components/rooms/RoomCard.tsx
//
// ONE room, with everything its participants can do to it. Which buttons exist
// is decided by the room's own state plus the caller's role — both of which come
// from the server's RoomView, never from a local guess.
//
// The card is deliberately dumb about authorization: it HIDES actions a player
// cannot take (the host's Start button, the invitee's Accept) because a visible
// button that always fails is bad UX — but every one of those actions is
// re-checked server-side, so hiding it is presentation, not security.

import { useState } from "react";
import Link from "next/link";
import { useTranslation } from "../../hooks/useTranslation";
import type { RoomView } from "../../lib/rooms/types";

export interface FriendOption {
  clerk_id?: string | null;
  id?: string | number;
  name?: string | null;
}

/** Statuses that can no longer change. */
const TERMINAL = new Set(["declined", "expired", "cancelled", "failed"]);

function statusTone(status: string): string {
  switch (status) {
    case "open":
      return "border-[#00e5ff]/40 bg-[#00e5ff]/10 text-[#00e5ff]";
    case "starting":
      return "border-amber-400/40 bg-amber-500/10 text-amber-300";
    case "started":
      return "border-emerald-400/40 bg-emerald-500/10 text-emerald-300";
    case "failed":
      return "border-red-400/40 bg-red-500/10 text-red-300";
    default:
      return "border-white/20 bg-white/5 text-gray-300";
  }
}

export default function RoomCard({
  room,
  friends = [],
  busy = "",
  onInvite,
  onRespond,
  onStart,
  onCancel,
  className = "",
}: {
  room: RoomView;
  /** The caller's friends, for the invite picker (host view only). */
  friends?: FriendOption[];
  /** The action key currently in flight (`invite:<id>`, `start:<id>`, …). */
  busy?: string;
  onInvite?: (roomId: string, friendUserId: string) => void;
  onRespond?: (roomId: string, accept: boolean) => void;
  onStart?: (roomId: string) => void;
  onCancel?: (roomId: string) => void;
  className?: string;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const [invitee, setInvitee] = useState("");

  const isHost = room.isHost;
  const isChallenge = room.kind === "challenge";
  const statusLabel = t(`rooms.status_${room.status}`, room.status);
  const gameLabel = t(`rooms.game_${room.gameKey}`, room.gameLabel || room.gameKey);
  const pending = (action: string) => busy === `${action}:${room.id}`;

  const code = room.code || "";
  const shareUrl = code ? `/rooms/join?code=${encodeURIComponent(code)}` : "";

  const invited = room.members.filter((m) => !m.isHost);
  const invitedIds = new Set(room.members.map((m) => m.userId));
  const invitableFriends = friends.filter(
    (friend) => friend.clerk_id && !invitedIds.has(String(friend.clerk_id)),
  );

  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div
      className={`rounded-xl border border-[#00e5ff]/25 bg-[#0b224f]/85 p-4 shadow-[0_0_18px_rgba(0,229,255,0.12)] ${className}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-full border border-[#FFD700]/40 bg-[#FFD700]/10 px-2 py-0.5 text-[11px] font-semibold text-[#FFD700]">
          {isChallenge
            ? t("rooms.kindChallenge", "Friend challenge")
            : t("rooms.kindRoom", "Private room · PRO")}
        </span>
        <span className="text-sm font-semibold text-white">{gameLabel}</span>
        <span className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${statusTone(room.status)}`}>
          {statusLabel}
        </span>
        {room.settings?.stake > 0 ? (
          <span className="text-[11px] text-amber-300">
            {t("rooms.stakeLabel", { stake: room.settings.stake })}
          </span>
        ) : (
          <span className="text-[11px] text-gray-300">{t("rooms.freeEntry", "Free entry")}</span>
        )}
        {isHost && (
          <span className="text-[11px] text-gray-400">
            {t("rooms.youAreHost", "You are the host")}
          </span>
        )}
      </div>

      {code && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="rounded border border-white/20 bg-black/30 px-2 py-1 font-mono text-sm tracking-widest text-white">
            {code}
          </span>
          <button
            type="button"
            onClick={() => copy(code)}
            className="rounded bg-white/10 px-2 py-1 text-xs font-semibold text-white hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff]"
          >
            {copied ? t("rooms.copied", "Copied") : t("rooms.copyCode", "Copy code")}
          </button>
          <button
            type="button"
            onClick={() =>
              copy(`${typeof window !== "undefined" ? window.location.origin : ""}${shareUrl}`)
            }
            className="rounded bg-white/10 px-2 py-1 text-xs font-semibold text-white hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff]"
          >
            {t("rooms.copyLink", "Copy invite link")}
          </button>
          <Link
            href={shareUrl}
            className="text-xs font-semibold text-[#00e5ff] underline-offset-2 hover:underline"
          >
            {t("rooms.openSharePage", "Open share page")}
          </Link>
        </div>
      )}

      <div className="mt-3 space-y-1">
        {room.members.map((member) => (
          <p key={member.userId} className="flex items-center gap-2 text-xs text-gray-200">
            <span className="h-1.5 w-1.5 rounded-full bg-[#00e5ff]" />
            <span className="font-semibold">
              {member.name || t("rooms.anonymousPlayer", "Player")}
              {member.isYou ? ` (${t("rooms.you", "you")})` : ""}
            </span>
            <span className="text-gray-400">
              {member.isHost
                ? t("rooms.memberHost", "host")
                : t(`rooms.member_${member.inviteStatus}`, member.inviteStatus)}
            </span>
          </p>
        ))}
        {invited.length === 0 && (
          <p className="text-xs text-gray-400">
            {t("rooms.noInviteesYet", "No friend invited yet.")}
          </p>
        )}
      </div>

      {/* ── The host's actions ─────────────────────────────────────────── */}
      {isHost && !TERMINAL.has(room.status) && room.status !== "started" && (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          {invitableFriends.length > 0 && onInvite && (
            <>
              <label className="sr-only" htmlFor={`invitee-${room.id}`}>
                {t("rooms.pickFriend", "Choose a friend")}
              </label>
              <select
                id={`invitee-${room.id}`}
                value={invitee}
                onChange={(event) => setInvitee(event.target.value)}
                className="rounded border border-white/20 bg-[#08203f] px-2 py-1 text-xs text-white"
              >
                <option value="">{t("rooms.pickFriend", "Choose a friend")}</option>
                {invitableFriends.map((friend) => (
                  <option key={String(friend.clerk_id)} value={String(friend.clerk_id)}>
                    {friend.name || friend.clerk_id}
                  </option>
                ))}
              </select>
              <button
                type="button"
                disabled={!invitee || pending("invite")}
                onClick={() => onInvite(room.id, invitee)}
                className="rounded bg-[#00e5ff] px-3 py-1 text-xs font-semibold text-[#003366] disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff]"
              >
                {pending("invite")
                  ? t("rooms.inviting", "Inviting…")
                  : t("rooms.invite", "Invite")}
              </button>
            </>
          )}

          {!isChallenge && onStart && (
            <button
              type="button"
              disabled={!room.canStart || pending("start")}
              onClick={() => onStart(room.id)}
              className="rounded bg-[#FFD700] px-3 py-1 text-xs font-semibold text-[#003366] disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400"
            >
              {pending("start")
                ? t("rooms.starting", "Starting…")
                : room.canStart
                  ? t("rooms.start", "Start match")
                  : t("rooms.waitingForOpponent", "Waiting for a friend")}
            </button>
          )}

          {onCancel && (
            <button
              type="button"
              disabled={pending("cancel")}
              onClick={() => onCancel(room.id)}
              className="rounded bg-red-500/90 px-3 py-1 text-xs font-semibold text-white disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400"
            >
              {pending("cancel") ? t("rooms.closing", "Closing…") : t("rooms.cancel", "Close room")}
            </button>
          )}
        </div>
      )}

      {/* ── The invitee's answer ───────────────────────────────────────── */}
      {!isHost &&
        room.inviteStatus === "invited" &&
        (room.status === "open" || room.status === "starting") &&
        onRespond && (
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={pending("respond")}
              onClick={() => onRespond(room.id, true)}
              className="rounded bg-emerald-500 px-3 py-1 text-xs font-semibold text-white disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
            >
              {pending("respond")
                ? t("rooms.accepting", "Accepting…")
                : t("rooms.accept", "Accept")}
            </button>
            <button
              type="button"
              disabled={pending("respond")}
              onClick={() => onRespond(room.id, false)}
              className="rounded bg-white/10 px-3 py-1 text-xs font-semibold text-white disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
            >
              {t("rooms.decline", "Decline")}
            </button>
          </div>
        )}

      {room.status === "started" && room.matchUrl && (
        <div className="mt-4">
          <Link
            href={room.matchUrl}
            className="inline-block rounded bg-[#00e5ff] px-3 py-1 text-xs font-semibold text-[#003366] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff]"
          >
            {t("rooms.openMatch", "Open the match")}
          </Link>
        </div>
      )}

      {TERMINAL.has(room.status) && (
        <p className="mt-3 text-xs text-gray-400">
          {t(`rooms.closedHint_${room.status}`, t("rooms.closedHint", "This room is closed."))}
        </p>
      )}
    </div>
  );
}
