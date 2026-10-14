"use client";

// src/components/rooms/RoomGameDialog.tsx
//
// "Which game, and for how much?" — the picker shared by the free friend
// challenge and the PRO private room.
//
// The options come from src/lib/rooms/catalog.ts, the SAME module the server
// validates with, so a game the server would refuse is never offered, and the
// stake bounds shown are the ones enforced. A game whose `maxStake` is 0 (Pool
// Masters: its lobby flow carries no escrow) is shown as free-play only.
//
// The dialog does not decide anything: it hands the chosen game + stake to the
// caller, and the server re-validates both.

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "../../hooks/useTranslation";
import type { RoomGameOption } from "../../lib/rooms/types";

export default function RoomGameDialog({
  open,
  mode,
  games,
  busy = false,
  onClose,
  onConfirm,
}: {
  open: boolean;
  /** `challenge` = free friend challenge, `room` = PRO private room. */
  mode: "challenge" | "room";
  games: RoomGameOption[];
  busy?: boolean;
  onClose: () => void;
  onConfirm: (gameKey: string, stake: number) => void;
}) {
  const { t } = useTranslation();
  const selectable = useMemo(() => games.filter((game) => game.seats >= 2), [games]);
  const [gameKey, setGameKey] = useState<string>(selectable[0]?.key || "");
  const [stake, setStake] = useState<number>(0);

  // A dialog reopened for another game must not carry a stale stake.
  useEffect(() => {
    if (!open) return;
    setGameKey((current) =>
      selectable.some((game) => game.key === current) ? current : selectable[0]?.key || "",
    );
    setStake(0);
  }, [open, selectable]);

  if (!open) return null;

  const game = selectable.find((item) => item.key === gameKey) || null;
  const maxStake = game?.maxStake ?? 0;
  const stakeOffered = maxStake > 0;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={
        mode === "challenge"
          ? t("rooms.dialogChallengeTitle", "Challenge a friend")
          : t("rooms.dialogRoomTitle", "Create a private room")
      }
      className="fixed inset-0 z-[120] flex items-center justify-center bg-black/80 p-4"
    >
      <div className="w-full max-w-lg rounded-xl border border-[#00e5ff]/40 bg-[#0b224f] p-5 shadow-[0_0_30px_rgba(0,229,255,0.25)]">
        <h2 className="text-lg font-semibold text-[#00e5ff]">
          {mode === "challenge"
            ? t("rooms.dialogChallengeTitle", "Challenge a friend")
            : t("rooms.dialogRoomTitle", "Create a private room")}
        </h2>
        <p className="mt-1 text-xs text-gray-300">
          {mode === "challenge"
            ? t(
                "rooms.dialogChallengeHint",
                "Your friend gets the invitation instantly and the match starts when they accept.",
              )
            : t(
                "rooms.dialogRoomHint",
                "Share the room code or invite friends, then start when everyone is in.",
              )}
        </p>

        {selectable.length === 0 ? (
          <p className="mt-4 text-sm text-gray-200">
            {t("rooms.noGames", "No game currently supports private rooms.")}
          </p>
        ) : (
          <>
            <fieldset className="mt-4">
              <legend className="text-xs font-semibold uppercase tracking-wide text-gray-300">
                {t("rooms.pickGame", "Game")}
              </legend>
              <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
                {selectable.map((option) => (
                  <button
                    key={option.key}
                    type="button"
                    onClick={() => {
                      setGameKey(option.key);
                      setStake(0);
                    }}
                    aria-pressed={option.key === gameKey}
                    className={`rounded-lg border px-3 py-2 text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff] ${
                      option.key === gameKey
                        ? "border-[#00e5ff] bg-[#00e5ff]/15 text-white"
                        : "border-white/15 bg-white/5 text-gray-200 hover:bg-white/10"
                    }`}
                  >
                    {t(`rooms.game_${option.key}`, option.label)}
                    <span className="mt-0.5 block text-[10px] font-normal text-gray-300">
                      {option.maxStake > 0
                        ? t("rooms.optionStaked", { max: option.maxStake })
                        : t("rooms.optionFree", "Free play")}
                    </span>
                  </button>
                ))}
              </div>
            </fieldset>

            {mode === "room" && (
              <div className="mt-4">
                <label
                  htmlFor="room-stake"
                  className="text-xs font-semibold uppercase tracking-wide text-gray-300"
                >
                  {t("rooms.pickStake", "Entry (coins)")}
                </label>
                <input
                  id="room-stake"
                  type="number"
                  min={0}
                  max={Math.max(maxStake, 0)}
                  step={1}
                  value={stake}
                  disabled={!stakeOffered}
                  onChange={(event) => {
                    const next = Number(event.target.value);
                    setStake(Number.isFinite(next) ? Math.max(0, Math.min(maxStake, Math.trunc(next))) : 0);
                  }}
                  className="mt-1 w-full rounded border border-white/20 bg-[#08203f] px-3 py-2 text-sm text-white disabled:opacity-50"
                />
                <p className="mt-1 text-[11px] text-gray-300">
                  {stakeOffered
                    ? t("rooms.stakeHint", {
                        max: maxStake,
                      })
                    : t("rooms.stakeFreeOnly", "This game's private rooms are free-play only.")}
                </p>
              </div>
            )}

            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded bg-white/10 px-3 py-1.5 text-sm font-semibold text-white hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
              >
                {t("rooms.dialogCancel", "Cancel")}
              </button>
              <button
                type="button"
                disabled={!game || busy}
                onClick={() => game && onConfirm(game.key, stakeOffered ? stake : 0)}
                className="rounded bg-[#FFD700] px-3 py-1.5 text-sm font-semibold text-[#003366] disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400"
              >
                {busy
                  ? t("rooms.creating", "Working…")
                  : mode === "challenge"
                    ? t("rooms.dialogSend", "Send challenge")
                    : t("rooms.dialogCreate", "Create room")}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
