"use client";

// ── End-of-match popup for the Precision match page ──────────────────────
//
// Owns everything that happens once a match is over:
//
//   * the popup state itself (auto-opened on the `finished` transition),
//   * the server-authoritative payout request (`/api/precision/finish-match`,
//     idempotent server-side so BOTH clients can safely ask),
//   * the replay / return-to-lobby handshake over the dedicated end-replay
//     room, including the auto-return when the replay window lapses.
//
// The popup is opened from the POLLED state (`phase === "finished"`), not from
// a socket event, because polling is the canonical source of truth for the
// match-end flag. Payout is SERVER-ONLY: the client never computes a number,
// it renders `0` until the server stamps the real one.

import { useCallback, useEffect, useRef, useState } from "react";
import type { useRouter } from "next/navigation";
import type { usePostHog } from "posthog-js/react";

import {
  fetchFinishMatch,
  joinEndReplayRoom,
  leaveEndReplayRoom,
} from "../lib/precision/multiplayer";
import { SOCKET_NAMESPACE } from "../lib/precision/constants";
import { getReplaySecondsLeft, makeInitialEndPopupState } from "../lib/precision/utils";
import type {
  PrecisionEndPopupState,
  PrecisionPlayer,
  PrecisionState,
} from "../lib/precision/types";
import type { RealtimeSocket } from "../lib/socket";

export interface UsePrecisionEndPopupOptions {
  matchId: string;
  socket: RealtimeSocket | null;
  state: PrecisionState | null;
  players: PrecisionPlayer[];
  localSeat: 1 | 2;
  router: ReturnType<typeof useRouter>;
  /** PostHog client (may be undefined before analytics hydrates). */
  posthog: ReturnType<typeof usePostHog>;
}

export interface UsePrecisionEndPopupResult {
  endPopup: PrecisionEndPopupState | null;
  /** Replace the popup state (e.g. the local player resigning). */
  setEndPopup: React.Dispatch<React.SetStateAction<PrecisionEndPopupState | null>>;
  replayRequested: boolean;
  opponentReplayRequested: boolean;
  returnChosen: boolean;
  /** Ask the opponent for a replay over the end-replay room. */
  requestReplay: () => void;
  /** Tell the opponent we are heading back to the lobby. */
  requestReturn: () => void;
}

export function usePrecisionEndPopup({
  matchId,
  socket,
  state,
  players,
  localSeat,
  router,
  posthog,
}: UsePrecisionEndPopupOptions): UsePrecisionEndPopupResult {
  const [endPopup, setEndPopup] = useState<PrecisionEndPopupState | null>(null);
  const [replayRequested, setReplayRequested] = useState(false);
  const [opponentReplayRequested, setOpponentReplayRequested] = useState(false);
  const [returnChosen, setReturnChosen] = useState(false);

  const payoutResultRef = useRef<{
    payout: number;
    newBalance: number;
    alreadyProcessed: boolean;
    winnerUserId: string | null;
  } | null>(null);
  const payoutRequestedRef = useRef<boolean>(false);

  // Keep the popup state readable from async handlers without re-binding them.
  const endPopupRef = useRef<PrecisionEndPopupState | null>(null);
  endPopupRef.current = endPopup;

  // ── End-popup rooms + handlers ──────────────────────────────────────
  useEffect(() => {
    if (!socket || !matchId) return;
    joinEndReplayRoom(socket, matchId);
    socket.on(SOCKET_NAMESPACE.endReplayRequestEvent, (payload: any) => {
      if (payload?.matchId !== matchId) return;
      setOpponentReplayRequested(true);
    });
    socket.on(SOCKET_NAMESPACE.endReturnEvent, (payload: any) => {
      if (payload?.matchId !== matchId) return;
      setReturnChosen(true);
    });
    return () => {
      leaveEndReplayRoom(socket, matchId);
      socket.off(SOCKET_NAMESPACE.endReplayRequestEvent);
      socket.off(SOCKET_NAMESPACE.endReturnEvent);
    };
  }, [socket, matchId]);

  // ── When both players agree to a replay, route back to the lobby ──────
  useEffect(() => {
    if (replayRequested && opponentReplayRequested) {
      router.push("/casino/precision");
    }
  }, [replayRequested, opponentReplayRequested, router]);

  // ── Auto-return when the replay window closes ─────────────────────────
  useEffect(() => {
    if (!endPopup) return;
    const deadline = endPopup.openedAt + getReplaySecondsLeft(endPopup.openedAt) * 1000;
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      router.push("/casino/precision");
      return;
    }
    const id = setTimeout(() => router.push("/casino/precision"), remaining);
    return () => clearTimeout(id);
  }, [endPopup, router]);

  // ── Auto-open the result popup when the server ends the match ──────
  // The match goes to `phase: "finished"` server-side once either seat hits
  // TARGET_WINS. This effect catches the transition and pops the result popup
  // with the appropriate win/loss framing derived from the local seat.
  useEffect(() => {
    if (!state || state.phase !== "finished") return;
    if (endPopupRef.current) return;
    if (state.winnerSeat === null) return;
    const result = state.winnerSeat === localSeat ? "win" : "loss";
    const opponentName = players.find((p) => p.seat !== localSeat)?.name;
    // Payout is SERVER-ONLY — no client-side math. We render `payout: 0`
    // while `/api/precision/finish-match` resolves and replace it with the
    // authoritative server-stamped value via the payout effect below.
    // Rendering an estimated number, even for one paint frame, would let a
    // tampered client show a fake payout.
    const initialPayout = payoutResultRef.current?.payout ?? 0;
    const winnerName = players.find((p) => p.seat === state.winnerSeat)?.name ?? null;
    setEndPopup(
      makeInitialEndPopupState(result, "completed", initialPayout, opponentName, {
        winnerName,
        finalScore: state.score ?? null,
        prizeMultiplier: 1.9,
        wager: state.wager,
      })
    );
    posthog?.capture("precision_match_finished", {
      matchId,
      winnerSeat: state.winnerSeat,
      finalScore: state.score,
    });
    // NOTE: the SUBMITTING client already emits `matchFinishedEvent` from its
    // STOP handler. This effect must NOT re-broadcast — that would double-emit
    // the same transition. We only consume the polled state here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.phase, state?.winnerSeat, state?.version, localSeat, matchId]);

  // ── Trigger server payout when the match ends ────────────────────
  // Fires ONCE per page load (gated by `payoutRequestedRef`) when the local
  // view first sees `phase: "finished"` + winnerSeat set. Both clients can hit
  // the endpoint — idempotency on the server ensures only one payout lands per
  // matchId. Failures unlock the ref so a subsequent retry can succeed.
  useEffect(() => {
    if (!state || state.phase !== "finished") return;
    if (state.winnerSeat === null) return;
    if (payoutRequestedRef.current) return;
    payoutRequestedRef.current = true;
    fetchFinishMatch(matchId)
      .then((data) => {
        if (!data?.success) {
          // Network or auth failure — let the next poll cycle retry.
          payoutRequestedRef.current = false;
          return;
        }
        payoutResultRef.current = {
          payout: Number(data.payout ?? 0),
          newBalance: Number(data.newBalance ?? 0),
          alreadyProcessed: Boolean(data.alreadyProcessed),
          winnerUserId: data.winnerUserId ?? null,
        };
        setEndPopup((prev) =>
          prev
            ? {
                ...prev,
                payout: Number(data.payout ?? prev.payout),
                winnerName: prev.winnerName,
                finalScore: data.finalScore ?? prev.finalScore,
                wager: prev.wager,
                prizeMultiplier: data.payoutMultiplier ?? prev.prizeMultiplier,
              }
            : prev
        );
        posthog?.capture("precision_payout_received", {
          matchId,
          payout: data.payout,
          alreadyProcessed: data.alreadyProcessed,
          newBalance: data.newBalance,
        });
      })
      .catch(() => {
        // Unlock on hard failure so a subsequent re-render with a different
        // matchId (e.g. the user reloads the page) can retry cleanly.
        payoutRequestedRef.current = false;
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.phase, state?.winnerSeat, state?.version, matchId]);

  const requestReplay = useCallback(() => {
    if (!endPopupRef.current || returnChosen) return;
    setReplayRequested(true);
    socket?.emit("room_event", {
      roomId: SOCKET_NAMESPACE.endReplayRoom(matchId),
      event: SOCKET_NAMESPACE.endReplayRequestEvent,
      payload: { matchId },
    });
    posthog?.capture("precision_replay_requested", { matchId });
  }, [returnChosen, socket, matchId, posthog]);

  const requestReturn = useCallback(() => {
    setReturnChosen(true);
    socket?.emit("room_event", {
      roomId: SOCKET_NAMESPACE.endReplayRoom(matchId),
      event: SOCKET_NAMESPACE.endReturnEvent,
      payload: { matchId },
    });
  }, [socket, matchId]);

  return {
    endPopup,
    setEndPopup,
    replayRequested,
    opponentReplayRequested,
    returnChosen,
    requestReplay,
    requestReturn,
  };
}
