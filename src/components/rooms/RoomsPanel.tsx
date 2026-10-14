"use client";

// src/components/rooms/RoomsPanel.tsx
//
// The private-rooms block: the caller's rooms and challenges, the PRO create
// flow, and join-by-code.
//
// WHY IT IS A SINGLE COMPONENT: the Friends tab and the shared room page render
// the same thing (what am I in, what do I have to answer, what can I start), so
// they share one implementation and one source of truth — the `/api/rooms`
// response, refreshed by the realtime signal with a poll as the backstop.
//
// PRO GATING IS NOT DONE HERE: the button is shown to everyone and the SERVER
// answers `pro_required`. The UI then says so and points at the upgrade page,
// because hiding the button would only hide the reason.

import { useState } from "react";
import Link from "next/link";
import AsyncState from "../states/AsyncState";
import RoomCard, { type FriendOption } from "./RoomCard";
import RoomGameDialog from "./RoomGameDialog";
import { useTranslation } from "../../hooks/useTranslation";
import { useRooms } from "../../hooks/useRooms";

/** Localise an API failure code; the server's message is the fallback. */
function failureText(
  t: (key: string, fallback?: string | Record<string, unknown>) => string,
  code: string,
  message: string,
): string {
  if (!code) return message;
  return t(`rooms.error_${code}`, message);
}

export default function RoomsPanel({
  friends = [],
  focusRoomId,
  className = "",
}: {
  /** The caller's friends (from the Friends tab) for the invite picker. */
  friends?: FriendOption[];
  /** Highlight one room (the shared room page). */
  focusRoomId?: string;
  className?: string;
}) {
  const { t } = useTranslation();
  const rooms = useRooms();
  const [dialog, setDialog] = useState<null | "room" | "challenge">(null);
  const [joinCode, setJoinCode] = useState("");

  const list = focusRoomId
    ? rooms.rooms.filter((room) => room.id === focusRoomId)
    : rooms.rooms;
  const ordered = focusRoomId
    ? rooms.rooms
    : [...rooms.invitations, ...rooms.hosted, ...rooms.shared];

  const handleCreate = async (gameKey: string, stake: number) => {
    const result = await rooms.createRoom(gameKey, stake);
    if (result.ok) setDialog(null);
  };

  const handleJoin = async () => {
    const result = await rooms.joinByCode(joinCode.trim().toUpperCase());
    if (result.ok) setJoinCode("");
  };

  return (
    <section
      className={`mt-8 rounded-xl border border-[#00e5ff]/30 bg-[#0b224f]/85 p-6 shadow-[0_0_24px_rgba(0,229,255,0.15)] ${className}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-xl text-[#00e5ff]">
          {t("rooms.title", "Private rooms & challenges")}
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setDialog("room")}
            className="rounded bg-[#FFD700] px-3 py-1.5 text-sm font-semibold text-[#003366] hover:bg-[#ffd700]/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400"
          >
            {t("rooms.createCta", "Create private room")}
          </button>
          <span className="rounded-full border border-[#FFD700]/40 bg-[#FFD700]/10 px-2 py-0.5 text-[11px] font-semibold text-[#FFD700]">
            {t("rooms.proBadge", "PRO")}
          </span>
        </div>
      </div>

      <p className="mt-1 text-xs text-gray-300">
        {t(
          "rooms.subtitle",
          "Private rooms are a GRYND PRO feature. Challenging a friend is free for everyone.",
        )}
      </p>

      <div className="mt-4 flex flex-wrap items-end gap-2">
        <div>
          <label htmlFor="room-join-code" className="text-xs font-semibold uppercase tracking-wide text-gray-300">
            {t("rooms.joinCodeLabel", "Room code")}
          </label>
          <input
            id="room-join-code"
            value={joinCode}
            onChange={(event) => setJoinCode(event.target.value.toUpperCase())}
            placeholder={t("rooms.joinCodePlaceholder", "ABCD234567")}
            maxLength={16}
            className="mt-1 w-44 rounded border border-white/20 bg-[#08203f] px-3 py-1.5 font-mono text-sm tracking-widest text-white"
          />
        </div>
        <button
          type="button"
          disabled={!joinCode.trim() || rooms.busy === "join"}
          onClick={handleJoin}
          className="rounded bg-[#00e5ff] px-3 py-1.5 text-sm font-semibold text-[#003366] disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff]"
        >
          {rooms.busy === "join" ? t("rooms.joining", "Joining…") : t("rooms.join", "Join")}
        </button>
      </div>

      {rooms.feedback && !rooms.feedback.ok && (
        <div className="mt-3 rounded border border-red-400/40 bg-red-500/10 px-3 py-2 text-sm text-red-200">
          <p>{failureText(t, rooms.feedback.code, rooms.feedback.message)}</p>
          {rooms.feedback.code === "pro_required" && (
            <Link href="/upgrade-pro" className="mt-1 inline-block text-xs font-semibold text-[#FFD700] underline">
              {t("rooms.upgradeCta", "See GRYND PRO")}
            </Link>
          )}
        </div>
      )}

      {rooms.feedback?.ok && (
        <p className="mt-3 rounded border border-emerald-400/40 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-200">
          {t("rooms.actionDone", "Done.")}
        </p>
      )}

      <div className="mt-4">
        <AsyncState
          isLoading={rooms.loading}
          error={rooms.error}
          hasData={rooms.rooms.length > 0}
          isEmpty={ordered.length === 0}
          onRetry={rooms.refresh}
          emptyTitle={t("rooms.emptyTitle", "No private rooms yet")}
          emptyDescription={t(
            "rooms.emptyDescription",
            "Create a room or challenge a friend from your friends list.",
          )}
        >
          {list.length === 0 ? (
            <p className="text-sm text-gray-300">
              {t("rooms.notFound", "This room is not available to you.")}
            </p>
          ) : (
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              {list.map((room) => (
                <RoomCard
                  key={room.id}
                  room={room}
                  friends={friends}
                  busy={rooms.busy}
                  onInvite={rooms.inviteFriend}
                  onRespond={rooms.respond}
                  onStart={rooms.startRoom}
                  onCancel={rooms.cancelRoom}
                />
              ))}
            </div>
          )}
        </AsyncState>
      </div>

      <RoomGameDialog
        open={dialog === "room"}
        mode="room"
        games={rooms.games}
        busy={rooms.busy === "create"}
        onClose={() => setDialog(null)}
        onConfirm={handleCreate}
      />
    </section>
  );
}

/**
 * The free "Challenge" flow, exposed as a dialog so the Friends tab can open it
 * for ONE friend. It deliberately does not go through the PRO room path: a
 * challenge is created by /api/rooms/challenge, which never checks membership.
 */
export function ChallengeFriendDialog({
  friend,
  onClose,
  onSent,
}: {
  friend: { clerk_id?: string | null; name?: string | null } | null;
  onClose: () => void;
  onSent?: (ok: boolean, code: string, message: string) => void;
}) {
  const { t } = useTranslation();
  const rooms = useRooms();
  const [busy, setBusy] = useState(false);

  if (!friend?.clerk_id) return null;

  const send = async (gameKey: string, _stake: number) => {
    setBusy(true);
    const result = await rooms.challengeFriend(gameKey, String(friend.clerk_id));
    setBusy(false);
    onSent?.(result.ok, result.code, result.message);
    if (result.ok) onClose();
  };

  return (
    <RoomGameDialog
      open
      mode="challenge"
      games={rooms.games}
      busy={busy}
      onClose={onClose}
      onConfirm={send}
    />
  );
}
