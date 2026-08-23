"use client";

// ── Match page for the Precision PvP casino game ────────────────────────
//
// The page renders three sub-states driven by `PrecisionState.phase`:
//   1. waiting  → <PrecisionWaitingRoom />
//   2. active   → Target + STOP button (server owns all timing)
//   3. finished → <PrecisionResultPopup /> + replay/return buttons
//
// The match page polls /api/precision/get-match every 1.5s. The polling
// follow-up is intentionally kept identical to other PvP games (Pool,
// Hex Duel, Uno) so behaviour is predictable.
//
// IMPORTANT: All timing calculations live on the server. The client
// emits ONLY a bare STOP signal over the realtime socket; the server
// stamps the STOP instant and computes elapsed = stopInstant -
// match.roundGoInstant. The local running timer is visual-only (for UX)
// and does not affect scoring.

import { use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { usePostHog } from "posthog-js/react";
import { AnimatePresence, motion } from "framer-motion";

import NavigationBar from "../../../../../components/navigation-bar";
import Footer from "../../../../../components/Footer";
import ReportModal from "../../../../../components/ReportModal";
import { useTranslation } from "../../../../../hooks/useTranslation";
import PrecisionWaitingRoom from "../../../../../components/precision/PrecisionWaitingRoom";
import PrecisionReadyRoom from "../../../../../components/precision/PrecisionReadyRoom";
import PrecisionScoreboard from "../../../../../components/precision/PrecisionScoreboard";
import PrecisionResultPopup from "../../../../../components/precision/PrecisionResultPopup";
import PrecisionRoundResultPanel, {
  ROUND_RESULT_REVEAL_MS,
} from "../../../../../components/precision/PrecisionRoundResultPanel";
import {
  emitStop,
  fetchFinishMatch,
  isLocalPlayerTurn,
  joinEndReplayRoom,
  joinMatchRoom,
  leaveEndReplayRoom,
  leaveMatchRoom,
  markReady,
  resignMatch,
} from "../../../../../lib/precision/multiplayer";
import { useSocket } from "../../../../../context/SocketProvider";
import {
  MATCH_POLL_INTERVAL_MS,
  SOCKET_NAMESPACE,
} from "../../../../../lib/precision/constants";
import {
  diffToRank,
  formatTokens,
  getReplaySecondsLeft,
  makeInitialEndPopupState,
} from "../../../../../lib/precision/utils";
import { PrecisionRankIcon } from "../../../../../components/precision/PrecisionRankIcon";
import {
  IconFlag,
  IconClock,
  IconTarget,
} from "@tabler/icons-react";
import { playRankSound } from "../../../../../lib/precisionAudio";
import { fadeUp } from "../../../../../lib/animations";
import type {
  PrecisionEndPopupState,
  PrecisionPlayer,
  PrecisionState,
} from "../../../../../lib/precision/types";

// ── Next.js 16 dynamic params are async (Promise-based).
// The match page receives `params` as a Promise that must be unwrapped
// with `React.use()` before accessing properties. Accessing
// `params.matchId` directly leaves `matchId` undefined and triggers a
// client-side TypeError on the next `.slice(0, 6)` render below —
// manifesting to the user as the "Application error: a client-side
// exception has occurred" overlay when navigating from the lobby to the
// match page after Create PvP / Create AI.
interface PrecisionMatchPageProps {
  params: Promise<{ matchId: string }>;
}

const DEFAULT_PLAYERS: PrecisionPlayer[] = [
  { seat: 1, userId: "host", name: "You", isReady: true, isConnected: true },
  { seat: 2, userId: "opponent", name: "Opponent", isReady: false, isConnected: false },
];

export default function PrecisionMatchPage({ params }: PrecisionMatchPageProps) {
  const router = useRouter();
  const posthog = usePostHog();
  const { socket } = useSocket();
  const { t } = useTranslation();
  // Unwrap the dynamic-route params Promise. `use()` suspends this
  // component until the param is resolved; the result is a plain
  // object, so `matchId` is a real string (or falls back to "" if
  // somehow absent — see the guard below).
  const { matchId: rawMatchId } = use(params);
  // Defensive fallback: if the URL is missing the dynamic segment the
  // page would otherwise render with `matchId === undefined` and crash
  // on the first `.slice()` call. Strictly a safety-net — Next.js
  // always supplies the segment when routing through [matchId].
  const matchId = typeof rawMatchId === "string" && rawMatchId.length > 0
    ? rawMatchId
    : "unknown";

  const [state, setState] = useState<PrecisionState | null>(null);
  const [endPopup, setEndPopup] = useState<PrecisionEndPopupState | null>(null);
  const [replayRequested, setReplayRequested] = useState(false);
  const [opponentReplayRequested, setOpponentReplayRequested] = useState(false);
  const [returnChosen, setReturnChosen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Report modal — flags the human opponent for moderation.
  const [showReportModal, setShowReportModal] = useState(false);
  // Optimistic + server-confirmed Ready flag for the local player.
  // `selfReadyUserIdRef` is the userId we sent to /api/precision/ready
  // so we can resolve "self" when auth isn't fully wired. A ref (not
  // state) is used so the socket listener effect doesn't have to
  // re-bind every time we click Ready.
  const [selfReady, setSelfReady] = useState(false);
  const [readySubmitting, setReadySubmitting] = useState(false);
  const selfReadyUserIdRef = useRef<string | null>(null);
  // Round-stop optimistic flags. `selfStopPending` flips true the
  // instant the user clicks STOP and is reset when both seats'
  // submissions land (the existing `roundResultEvent` listener
  // detects that). `stopSubmitting` covers the in-flight window
  // before the ACK fires. The race-proof single-click lock uses
  // a ref so the synchronous click handler always wins:
  // `stopLockedThisRoundRef.current === true` means STOP has
  // already fired for this round.
  const [selfStopPending, setSelfStopPending] = useState(false);
  const [stopSubmitting, setStopSubmitting] = useState(false);
  const stopLockedThisRoundRef = useRef<boolean>(false);
  // Round-result reveal overlay state. Populated whenever the server
  // reports a fresh per-round decision (via broadcast OR polling); the
  // dedicated `<PrecisionRoundResultPanel>` renders on top of the page
  // for `ROUND_RESULT_REVEAL_MS` (3s) then auto-dismisses. Tracking the
  // snapshot fields directly (instead of pulling from state on render)
  // lets the view remain stable even if `state.lastRoundStops` later
  // gets overwritten by armMatchRound's next-arm cycle, which would
  // otherwise cancel the reveal mid-animation. Diffs are SERVER-STAMPED
  // in `recordRoundStop`, not recomputed locally — the panel reads them
  // verbatim from `state.lastRoundStops.seat{N}.diffMs`.
  const [roundResultReveal, setRoundResultReveal] = useState<{
    targetMs: number;
    seat1ElapsedMs: number;
    seat1DiffMs: number;
    seat2ElapsedMs: number;
    seat2DiffMs: number;
    roundWinnerSeat: (1 | 2) | null;
    /** Stable signature used to debounce duplicate captures from
     * broadcast + polling (same round decision landing via both paths). */
    signature: string;
  } | null>(null);
  const roundResultTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Tracks the most recently-revealed target (server-stamped when arm→
  // active fires). The post-decision broadcast flips `state.targetMs`
  // to null because the NEXT arm cycle stores its target privately; we
  // snapshot the previous value here so the reveal panel can show the
  // target the round JUST used instead of "—".
  const lastRevealedTargetRef = useRef<number | null>(null);

  // ── Running-timer state (client-side, visual-only) ─────────────────
  // When the round flips to `active`, we start a local rAF loop that
  // updates `timerMs` every frame. The value is informational — the
  // player sees the elapsed time live so they can stop near the target.
  // Server timing is authoritative for scoring; this display is for UX.
  const [timerMs, setTimerMs] = useState(0);
  const timerRafRef = useRef<number | null>(null);
  const localGoInstantRef = useRef<number | null>(null);
  // Live 5-second pre-round countdown (display-only). Driven by the
  // server-stamped `countdownEndsAt` so BOTH clients count down from the
  // same absolute instant. null while not in the arming phase.
  const [countdownMs, setCountdownMs] = useState<number | null>(null);

  // Start / stop helpers for the local timer rAF loop.
  const stopTimer = useCallback(() => {
    if (timerRafRef.current !== null) {
      cancelAnimationFrame(timerRafRef.current);
      timerRafRef.current = null;
    }
    localGoInstantRef.current = null;
  }, []);

  const startTimer = useCallback(() => {
    stopTimer();
    localGoInstantRef.current = performance.now();
    const tick = () => {
      if (localGoInstantRef.current === null) return;
      setTimerMs(performance.now() - localGoInstantRef.current);
      timerRafRef.current = requestAnimationFrame(tick);
    };
    timerRafRef.current = requestAnimationFrame(tick);
  }, [stopTimer]);
  // TODO(gameplay): when the auth flow lands in the scaffold, derive this
  // from the Clerk session id compared to `state.players[*].userId` so the
  // opponent-aware logic below actually flips sides correctly. For the
  // scaffolding we treat the host as seat 1 and the joiner as seat 2; the
  // waiting room and result popup render fine on either side.
  //
  // The lobby page writes `precision:localSeat` ("1" or "2") to
  // sessionStorage once it knows which seat we own, so post-matchmaking
  // clients can decide whether *they* are the Ready button.
  const [localSeat] = useState<1 | 2>(() => {
    if (typeof window === "undefined") return 1;
    try {
      const stored = window.sessionStorage.getItem("precision:localSeat");
      return stored === "2" ? 2 : 1;
    } catch {
      return 1;
    }
  });

  // Keep a ref of latest state so async handlers always operate on the
  // freshest copy. Matches the closure-protection pattern used elsewhere.
  const stateRef = useRef<PrecisionState | null>(null);
  stateRef.current = state;

  // ── Polling ──────────────────────────────────────────────────────────
  // The match page polls /api/precision/get-match every 1.5s. This
  // IS the canonical refresh path: a hard browser reload (`F5`) re-runs
  // `fetchOnce` synchronously on mount and the server's match state is
  // restored from disk. The server NEVER resets the match on disconnect
  // — `realtime-server/server.js`'s `disconnect` handler only drops the
  // user from the participation map (`forgetPrecisionUser`), leaving
  // `precisionMatchStore` intact so the next reconnect resumes mid-game.
  //
  // We pull `socket?.id` into the deps so a socket RECONNECT (new
  // socket id, same matchId) tears this effect down + re-runs it,
  // firing `fetchOnce` synchronously instead of waiting up to 1.5s
  // for the next poll tick. Without this, a reconnecting player could
  // see a stale local state for ~1s while the broadcast lag resolves.
  // The polling cadence is otherwise unaffected.
  useEffect(() => {
    let cancelled = false;

    const fetchOnce = async () => {
      try {
        // Audit fix: skip the HTTP refresh once the match is
        // terminally finished. After `phase === "finished"` the
        // canonical state never changes — the polling is just
        // burning a request every 1.5s. The end-popup's auto-return
        // effect navigates away once the replay window expires, so
        // there's no UX benefit to continued polling. Kept in-band
        // (not a separate effect) so the socket-driven refetch on
        // reconnect still works exactly once via the `[matchId,
        // socket?.id]` deps below.
        if (stateRef.current?.phase === "finished") return;
        const res = await fetch(
          `/api/precision/get-match?matchId=${encodeURIComponent(matchId)}`,
          { cache: "no-store" },
        );
        const data = await res.json();
        if (cancelled) return;
        if (data?.match) setState(data.match as PrecisionState);
      } catch {
        // Network blip — try again next tick.
      }
    };

    void fetchOnce();
    const id = setInterval(fetchOnce, MATCH_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [matchId, socket?.id]);

  // ── Realtime rooms ───────────────────────────────────────────────────
  useEffect(() => {
    if (!socket || !matchId) return;
    // Re-join on EVERY socket (re)connection — Socket.IO doesn't re-join
    // rooms automatically, and the realtime server's disconnect grace
    // timer is only cancelled by a re-join. Without this, a refresh or
    // network blip would forfeit the match once the grace window expires.
    const join = () => joinMatchRoom(socket, matchId);
    join();
    socket.on("connect", join);
    return () => {
      socket.off("connect", join);
      leaveMatchRoom(socket, matchId);
    };
  }, [socket, matchId]);

  // ── Ready-up socket events ─────────────────────────────────────────
  // Both players join the same matchRoom. When either clicks Ready, the
  // caller emits `playerReadyEvent` carrying the new authoritative match
  // snapshot. When both are ready, the second caller adds
  // `matchStartEvent` so the opponent flips to the active phase without
  // waiting for the 1.5s poll tick. We always re-derive `selfReady` from
  // the local seat so a stale optimistic flag can't strand the UI.
  //
  // Effect deps intentionally exclude `selfReadyUserIdRef` (ref) so the
  // listener doesn't re-bind on every Ready click.
  //
  useEffect(() => {
    if (!socket || !matchId) return;

    const handlePlayerReady = (payload: any) => {
      if (payload?.matchId !== matchId) return;
      if (payload?.match) {
        const next = payload.match as PrecisionState;
        setState(next);
        if (
          selfReadyUserIdRef.current &&
          next.players.some(
            (p) => p.userId === selfReadyUserIdRef.current && p.isReady,
          )
        ) {
          setSelfReady(true);
        }
      }
    };
    const handleMatchStart = (payload: any) => {
      if (payload?.matchId !== matchId) return;
      if (payload?.match) setState(payload.match as PrecisionState);
      else if (stateRef.current) {
        // Best-effort flip when the broadcast didn't carry a snapshot — the
        // next polling tick will reconcile anyway.
        setState({
          ...stateRef.current,
          phase: "active",
          version: stateRef.current.version + 1,
        });
      }
    };

    socket.on(SOCKET_NAMESPACE.playerReadyEvent, handlePlayerReady);
    socket.on(SOCKET_NAMESPACE.matchStartEvent, handleMatchStart);

    return () => {
      socket.off(SOCKET_NAMESPACE.playerReadyEvent, handlePlayerReady);
      socket.off(SOCKET_NAMESPACE.matchStartEvent, handleMatchStart);
    };
  }, [socket, matchId]);

  // ── Round-result socket events ─────────────────────────────────────
  // When either player's STOP is processed and BOTH have submitted,
  // the canonical `precision:roundResult` broadcast lands in the match
  // room. Polling is the source of truth; the socket event just lets
  // the opponent see the updated state within sub-second latency.
  useEffect(() => {
    if (!socket || !matchId) return;

    const handleRoundResult = (payload: any) => {
      if (payload?.matchId !== matchId) return;
      if (payload?.match) {
        const next = payload.match as import("../../../../../lib/precision/types").PrecisionState;
        setState(next);
        setSelfStopPending(false);
      }
    };
    const handleMatchFinished = (payload: any) => {
      if (payload?.matchId !== matchId) return;
      if (payload?.match) setState(payload.match as PrecisionState);
      // Letting polling reconcile phase === "finished" is fine.
    };

    socket.on(SOCKET_NAMESPACE.roundResultEvent, handleRoundResult);
    socket.on(SOCKET_NAMESPACE.matchFinishedEvent, handleMatchFinished);

    return () => {
      socket.off(SOCKET_NAMESPACE.roundResultEvent, handleRoundResult);
      socket.off(SOCKET_NAMESPACE.matchFinishedEvent, handleMatchFinished);
    };
  }, [socket, matchId]);

  // ── Round-arm-start socket events ───────────────────────────────────────
  // When the server-side setTimeout flips from `arming` to `active`, the
  // server emits `roundArmStartEvent` carrying the live match. This
  // removes the 1.5s polling lag for the input form to appear after
  // the server's random pre-round delay. Polling is still the canonical
  // source of truth; the socket event just makes the UI feel responsive.
  useEffect(() => {
    if (!socket || !matchId) return;

    const handleRoundArmStart = (payload: any) => {
      if (payload?.matchId !== matchId) return;
      if (payload?.match) setState(payload.match as PrecisionState);
    };

    socket.on(SOCKET_NAMESPACE.roundArmStartEvent, handleRoundArmStart);

    return () => {
      socket.off(SOCKET_NAMESPACE.roundArmStartEvent, handleRoundArmStart);
    };
  }, [socket, matchId]);

  // ── End-popup rooms + handlers ───────────────────────────────────────
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

  // ── Auto-open the result popup when the server ends the match ─────
  // The match goes to `phase: "finished"` server-side once either seat
  // hits TARGET_WINS. This effect catches the transition and pops the
  // result popup with the appropriate win/loss/draw framing derived
  // from the local seat. Polling is the canonical source of truth for
  // the match-end flag, so we rely on `state.phase` not socket events.
  //
  // The effect ALSO triggers the server-authoritative payout via
  // `fetchFinishMatch(matchId)`. That helper hits
  // `/api/precision/finish-match` once per match (idempotency is
  // server-side via `precisionPaidOutMatches` in
  // `src/lib/precision/finishMatch.ts`) so both clients can safely
  // re-trigger on retry / polling-during-blip without double-paying.
  // The server is the sole authority on the actual balance update —
  // the client never observes a payout number without it being
  // stamped by the DB.
  const payoutResultRef = useRef<{
    payout: number;
    newBalance: number;
    alreadyProcessed: boolean;
    winnerUserId: string | null;
  } | null>(null);
  const payoutRequestedRef = useRef<boolean>(false);
  useEffect(() => {
    if (!state || state.phase !== "finished") return;
    if (endPopup) return;
    if (state.winnerSeat === null) return;
    const result =
      state.winnerSeat === localSeat ? "win" : "loss";
    const opponentName = players.find((p) => p.seat !== localSeat)?.name;
    // Payout is SERVER-ONLY — no client-side math. We render `payout:
    // 0` while `/api/precision/finish-match` resolves and replace it
    // with the authoritative server-stamped value via the
    // `payoutRequestedRef` effect below. The PRIOR `Math.round(state.wager
    // * 1.9)` placeholder is removed under the "all timing on the
    // server" / "only the server decides" invariants — rendering an
    // estimated payout number, even for one paint frame, lets a
    // tampered client show a fake payout.
    const initialPayout = payoutResultRef.current?.payout ?? 0;
    const winnerName =
      players.find((p) => p.seat === state.winnerSeat)?.name ?? null;
    setEndPopup(
      makeInitialEndPopupState(
        result,
        "completed",
        initialPayout,
        opponentName,
        {
          winnerName,
          finalScore: state.score ?? null,
          prizeMultiplier: 1.9,
          wager: state.wager,
        },
      ),
    );
    posthog?.capture("precision_match_finished", {
      matchId,
      winnerSeat: state.winnerSeat,
      finalScore: state.score,
    });
    // NOTE: the SUBMITTING client already emits `matchFinishedEvent`
    // from `handleStopClick`. The local polling useEffect must NOT
    // re-broadcast — doing so would double-emit the same transition.
    // We're just consuming the polled state here. Sockets are managed
    // by the round-stop submitter path.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.phase, state?.winnerSeat, state?.version, localSeat, matchId]);

  // ── Trigger server payout when the match ends ────────────────────
  // Fires ONCE per page load (gated by `payoutRequestedRef`) when
  // the local view first sees `phase: "finished"` + winnerSeat set.
  // Both clients can hit the endpoint — idempotency on the server
  // ensures only one payout lands per matchId. Failures unlock the
  // ref so a subsequent polling-driven retry can succeed.
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
                winnerName:
                  data.winnerUserId
                    ? // Resolve winner name from server payload when
                      // present (defensive: server returns userId, the
                      // page translates it via players[]).
                      prev.winnerName
                    : prev.winnerName,
                finalScore: data.finalScore ?? prev.finalScore,
                wager: prev.wager,
                prizeMultiplier: data.payoutMultiplier ?? prev.prizeMultiplier,
              }
            : prev,
        );
        posthog?.capture("precision_payout_received", {
          matchId,
          payout: data.payout,
          alreadyProcessed: data.alreadyProcessed,
          newBalance: data.newBalance,
        });
      })
      .catch(() => {
        // Unlock on hard failure so a subsequent re-render with a
        // different matchId (e.g. user resets the page) can retry
        // cleanly.
        payoutRequestedRef.current = false;
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.phase, state?.winnerSeat, state?.version, matchId]);

  // ── Reset the single-click STOP lock between rounds ─────────────
  // The page-wide race-proof single-click lock is reset whenever the
  // round resolves. Resolution is detected via TWO independent signals:
  //   * `state?.currentRound` — bumps on a non-tie round decision
  //     (recordRoundStop increments it after applying the score).
  //   * `state?.phase`        — flips out of "active" on EITHER a tie
  //     (recordRoundStop re-arms the same round via armMatchRound,
  //     setting phase → "arming" without bumping currentRound) OR a
  //     match finish (phase → "finished"). Watching phase catches the
  //     tie-replay path where currentRound does NOT change.
  // Without the phase dep, the STOP button would stay disabled after
  // a tie even though the server has re-armed and the new round is
  // waiting to open.
  //
  // OPTIMIZATION — the prior layout had THREE overlapping useEffects
  // doing round-resolution bookkeeping (the lock reset, a server-truth
  // selfStopPending clear, and a third tie-detection effect that
  // compared `state?.currentRound !== currentRound` against a render-
  // scope hoisted variable; the closure always sees the just-rendered
  // value so the comparison was structurally dead code). Folded into
  // ONE effect keyed on the same canonical transitions to drop two
  // redundant effect runs per poll tick AND eliminate the dead branch.
  // Note: dep array intentionally lists only the three primitive
  // transitions (NOT the whole `state` reference) — including `state`
  // would re-fire this effect on every poll (state ref churns each
  // tick) and unconditionally reset `stopLockedThisRoundRef`, breaking
  // the single-click STOP lock window that the lock is meant to cover.
  useEffect(() => {
    stopLockedThisRoundRef.current = false;
    // Clear optimistic pending once the server has resolved the round
    // (any seat won → lastRoundWinnerSeat set) OR has transitioned out
    // of the "active" phase (tie → "arming"; match over → "finished").
    if (!state) return;
    if (state.phase !== "active" || state.lastRoundWinnerSeat !== null) {
      setSelfStopPending(false);
    }
  }, [state?.currentRound, state?.phase, state?.lastRoundWinnerSeat]);

  // ── Capture the last revealed target for the results panel ───────
  // The server exclusively stamps the target value with the arm→active
  // transition and reveals it via `match.targetMs`. Right after a round
  // resolves, recordRoundStop calls armMatchRound which sets
  // `match.targetMs = null` (the new target is server-private until the
  // next arm→active fires). We snapshot the last non-null value here so
  // the per-round results panel can display the round's actual target
  // — the public field is already null at decision time.
  useEffect(() => {
    const t = state?.targetMs;
    if (typeof t === "number") {
      lastRevealedTargetRef.current = t;
    }
  }, [state?.targetMs]);

  // ── Per-round results reveal — fires on each fresh decision ─────
  // The server sets `state.lastRoundStops` exactly when the round is
  // decided (winner selected or tie noted). Each time those values
  // change to a NEW shape, we snapshot them into `roundResultReveal`
  // so the dedicated overlay can show them for ~3s. Signature uses
  // the per-seat elapsed values + the winner flag; ties encode
  // `winner=null`. The same decision landing via both the socket
  // broadcast AND the polling tick will produce identical signatures
  // and only re-trigger the same capture (idempotent — same data,
  // same target, no double-animation flicker).
  useEffect(() => {
    const lr = state?.lastRoundStops;
    if (!lr) return;
    // Defensive: target might not have been captured yet if polling
    // landed before the arm→active timer fired. Fall back to the
    // currently-revealed value or the broadcast's `targetMs` if both
    // null we still render — but in that corner case just skip the
    // reveal so we don't show a "target —" overlay.
    const targetSnapshot =
      lastRevealedTargetRef.current ?? state?.targetMs ?? null;
    if (targetSnapshot === null || !Number.isFinite(targetSnapshot)) return;
    const signature = `${lr.seat1.elapsedMs}|${lr.seat2.elapsedMs}|${lr.seat1.diffMs}|${lr.seat2.diffMs}|${state?.lastRoundWinnerSeat ?? "tie"}`;
    setRoundResultReveal((prev) => {
      if (prev?.signature === signature) return prev; // already showing
      return {
        targetMs: targetSnapshot,
        seat1ElapsedMs: lr.seat1.elapsedMs,
        seat1DiffMs: lr.seat1.diffMs,
        seat2ElapsedMs: lr.seat2.elapsedMs,
        seat2DiffMs: lr.seat2.diffMs,
        roundWinnerSeat: (state?.lastRoundWinnerSeat ?? null) as
          | (1 | 2)
          | null,
        signature,
      };
    });
    // Reset the auto-dismiss timer — every fresh decision extends the
    // 3s reveal window. Clearing the prior handle prevents an early
    // dismiss when rounds land back-to-back.
    if (roundResultTimerRef.current !== null) {
      clearTimeout(roundResultTimerRef.current);
    }
    roundResultTimerRef.current = setTimeout(() => {
      setRoundResultReveal(null);
      roundResultTimerRef.current = null;
    }, ROUND_RESULT_REVEAL_MS);
  }, [
    state?.lastRoundStops?.seat1?.elapsedMs,
    state?.lastRoundStops?.seat2?.elapsedMs,
    state?.lastRoundStops?.seat1?.diffMs,
    state?.lastRoundStops?.seat2?.diffMs,
    state?.lastRoundWinnerSeat,
    state?.targetMs,
  ]);

  // ── Round-result sound effect ───────────────────────────────────
  // When the per-round reveal panel appears (roundResultReveal is set),
  // play the rank-appropriate sound for the local player's diff.
  useEffect(() => {
    if (!roundResultReveal) return;
    const localDiff =
      localSeat === 1
        ? roundResultReveal.seat1DiffMs
        : roundResultReveal.seat2DiffMs;
    playRankSound(localDiff);
  }, [roundResultReveal, localSeat]);

  // ── Start / stop the local running timer based on phase ────────
  // When the round flips from `arming` to `active`, the local timer
  // begins. When the round resolves (any phase other than `active`),
  // the timer is stopped and reset.
  useEffect(() => {
    if (state?.phase === "active") {
      startTimer();
    } else {
      stopTimer();
      setTimerMs(0);
    }
    return () => stopTimer();
  }, [state?.phase, startTimer, stopTimer]);

  // ── 5-second pre-round countdown ticker ─────────────────────────
  // During `arming`, the server stamps `countdownEndsAt`
  // (`armingStartedAt + ROUND_COUNTDOWN_MS`). We tick every 100ms and
  // display ceil(remaining/1000) so both clients show the same
  // 5…4…3…2…1 from the same server timestamp. The server's own timer
  // fires at that exact instant and flips the phase to "active" (the
  // `precision:roundArmStart` broadcast), so the countdown is
  // display-only — all round timing remains server-authoritative.
  useEffect(() => {
    const endsAt = state?.countdownEndsAt;
    if (state?.phase !== "arming" || typeof endsAt !== "number") {
      setCountdownMs(null);
      return;
    }
    const tick = () => setCountdownMs(Math.max(0, endsAt - Date.now()));
    tick();
    const id = setInterval(tick, 100);
    return () => clearInterval(id);
  }, [state?.phase, state?.countdownEndsAt]);

  // Cancel the auto-dismiss timer on unmount so a stale timer can't
  // call setState on a torn-down React tree.
  useEffect(() => {
    return () => {
      if (roundResultTimerRef.current !== null) {
        clearTimeout(roundResultTimerRef.current);
        roundResultTimerRef.current = null;
      }
      stopTimer();
    };
  }, [stopTimer]);

  // NOTE: the optimistic `selfStopPending` clear is folded into the
  // consolidated round-resolution useEffect above (one effect for both
  // lock reset + server-truth re-derive). The prior duplicate effects
  // (one keyed on phase/lastRoundWinnerSeat, one structurally-dead
  // comparison against a stale render-scope `currentRound` value) are
  // removed.

  // ── When both players agree to a replay, route back to lobby ──────────
  useEffect(() => {
    if (replayRequested && opponentReplayRequested) {
      router.push("/casino/precision");
    }
  }, [replayRequested, opponentReplayRequested, router]);

  // ── Handlers ─────────────────────────────────────────────────────────
  const handleLeave = useCallback(() => {
    router.push("/casino/precision");
  }, [router]);

  const handleResign = useCallback(async () => {
    if (!matchId) return;
    try {
      await resignMatch(matchId);
      setEndPopup(
        makeInitialEndPopupState("loss", "resigned", stateRef.current?.wager ?? 0),
      );
      posthog?.capture("precision_match_resigned", { matchId });
    } catch (err) {
      setError((err as Error)?.message ?? t("games.precision.resign_failed"));
    }
  }, [matchId, posthog, t]);

  const handleReadyClick = useCallback(async () => {
    if (!matchId || readySubmitting || selfReady) return;
    // Optimistic UI: flip the clicker's own Ready badge synchronously so
    // the change is visible BEFORE the network round-trip returns.
    setSelfReady(true);
    setReadySubmitting(true);
    setError(null);
    try {
      // Resolve our own userId from current state (prefer the most recent
      // server snapshot). Fall back to the seeded "host" placeholder so
      // the API call succeeds during the scaffold before auth lands.
      const liveState = stateRef.current;
      const selfRecord =
        liveState?.players.find((p) => p.seat === localSeat) ?? null;
      const userId =
        selfRecord?.userId ?? (localSeat === 1 ? "host" : "opponent");
      selfReadyUserIdRef.current = userId;
      const response = await markReady(matchId, userId);
      if (!response.success || !response.match) {
        // Roll back the optimistic flip on failure.
        setSelfReady(false);
        setError(response.error ?? t("games.precision.ready_failed"));
        return;
      }
      setState(response.match);
      // Broadcast so the opponent's UI flips immediately.
      socket?.emit("room_event", {
        roomId: SOCKET_NAMESPACE.matchRoom(matchId),
        event: SOCKET_NAMESPACE.playerReadyEvent,
        payload: { matchId, match: response.match },
      });
      if (response.bothReady) {
        socket?.emit("room_event", {
          roomId: SOCKET_NAMESPACE.matchRoom(matchId),
          event: SOCKET_NAMESPACE.matchStartEvent,
          payload: { matchId, match: response.match },
        });
        posthog?.capture("precision_ready_both", { matchId });
      } else {
        posthog?.capture("precision_ready_self", { matchId });
      }
    } catch (err) {
      // Roll back on thrown errors too.
      setSelfReady(false);
      setError((err as Error)?.message ?? t("games.precision.ready_threw"));
    } finally {
      setReadySubmitting(false);
    }
  }, [matchId, readySubmitting, selfReady, localSeat, socket, posthog]);

  const handleReplayRequest = useCallback(() => {
    if (!endPopup || returnChosen) return;
    setReplayRequested(true);
    socket?.emit("room_event", {
      roomId: SOCKET_NAMESPACE.endReplayRoom(matchId),
      event: SOCKET_NAMESPACE.endReplayRequestEvent,
      payload: { matchId },
    });
    posthog?.capture("precision_replay_requested", { matchId });
  }, [endPopup, returnChosen, socket, matchId, posthog]);

  // ── Round-stop submit (bare STOP — server owns all timing) ─────
  // The client sends ONLY a `{ matchId }` payload over the realtime
  // socket. The server-side `recordRoundStop` stamps the STOP instant
  // (`Date.now()` at receive time) and computes elapsed =
  // `stopInstant - match.roundGoInstant` authoritatively. The client
  // has no influence on either instant — see the "never trust the
  // client" and "all timing on the server" invariants in the project
  // README.
  //
  // Single-click enforcement: `stopLockedThisRoundRef` flips to `true`
  // synchronously the instant the handler runs, before any state
  // updates or socket emits. Any double-click that leaks past React's
  // event batching hits this guard and is rejected. The flag clears
  // when the round advances (see the `state?.currentRound` effect).
  //
  // Server feedback flows in two paths:
  //   * Direct ACK callback: fires once the realtime server has
  //     processed the stop. Flips `stopSubmitting` off and unlocks
  //     the optimistic STOP on server-rejection / network error.
  //   * Match-room broadcast: fires once BOTH seats have submitted.
  //     The existing `roundResultEvent` listener sets
  //     `selfStopPending` false and updates state.
  const handleStopClick = useCallback(() => {
    if (!matchId) return;
    if (stopSubmitting || selfStopPending) return;
    // Race-proof single-click lock. Synchronously set BEFORE any other
    // work so a second click that lands in the same React batch hits
    // the guard above and returns. Resets between rounds via the
    // `state?.currentRound` effect.
    if (stopLockedThisRoundRef.current) return;
    stopLockedThisRoundRef.current = true;
    if (!socket) {
      // No realtime connection — the round can't resolve without it.
      // Unlock so the user can retry the next round.
      stopLockedThisRoundRef.current = false;
      setError(t("games.precision.stop_no_socket"));
      return;
    }
    setStopSubmitting(true);
    setError(null);
    setSelfStopPending(true);
    posthog?.capture("precision_round_stop_sent", {
      matchId,
      transport: "websocket",
    });
    // Send the STOP signal with the per-round replay envelope. The
    // realtime server validates participation, HTTP-proxies to
    // Next.js's `/api/precision/round-stop` endpoint, which calls
    // `recordRoundStop`. The server stamps the STOP instant
    // internally and computes the elapsed time from
    // `match.roundGoInstant`. The fifth argument is the Socket.IO
    // ACK callback: it fires EXACTLY ONCE with `{ success, error? }`
    // and unlocks the optimistic state on failure.
    //
    // The replay envelope (`roundId`, `nonce`) is read live from
    // `stateRef.current` so the client always echoes the values the
    // server stamped at the most recent `armMatchRound` call. The
    // server REJECTS any stop packet whose `roundId` or `nonce`
    // does not match `match.roundId` / `match.roundNonce` — so a
    // tampered client cannot replay a packet from a previous round.
    emitStop(
      socket,
      matchId,
      stateRef.current?.roundId ?? "",
      stateRef.current?.roundNonce ?? "",
      (ack) => {
      setStopSubmitting(false);
      if (!ack || ack.success !== true) {
        // Server refused — unlock the optimistic state so the user
        // can try again on the next round.
        stopLockedThisRoundRef.current = false;
        setSelfStopPending(false);
        setError((ack && ack.error) || t("games.precision.stop_rejected"));
        posthog?.capture("precision_round_stop_rejected", {
          matchId,
          error: (ack && ack.error) || "unknown",
        });
      }
    });
  }, [matchId, stopSubmitting, selfStopPending, socket, posthog]);

  const handleReturnToLobby = useCallback(() => {
    setReturnChosen(true);
    socket?.emit("room_event", {
      roomId: SOCKET_NAMESPACE.endReplayRoom(matchId),
      event: SOCKET_NAMESPACE.endReturnEvent,
      payload: { matchId },
    });
    router.push("/casino/precision");
  }, [socket, matchId, router]);

  // OPTIMIZATION — useCallback the per-round reveal panel's onDismiss
  // so the inline arrow previously used here didn't churn the panel's
  // useEffect dep list (the panel uses an onDismissRef so the dep
  // doesn't matter for correctness anymore, but a stable identity also
  // lets the React.memo wrapper around PrecisionRoundResultPanel skip
  // subtree renders on unrelated poll ticks).
  const dismissRoundResult = useCallback(() => {
    setRoundResultReveal(null);
    if (roundResultTimerRef.current !== null) {
      clearTimeout(roundResultTimerRef.current);
      roundResultTimerRef.current = null;
    }
  }, []);

  // ── Derived display values ───────────────────────────────────────────
  const players = useMemo<PrecisionPlayer[]>(
    () => state?.players ?? DEFAULT_PLAYERS,
    [state],
  );
  const hostName = useMemo(
    () => players.find((p) => p.seat === 1)?.name ?? "Host",
    [players],
  );

  // Report target: the opponent is whoever occupies the seat we don't
  // hold. Only show the flag once a real second player has joined —
  // the scaffold seeds placeholder "host"/"opponent" userIds, which
  // are not real Clerk ids and must never be reported.
  const opponentPlayer = players.find((p) => p.seat !== localSeat) ?? null;
  const opponentClerkId = opponentPlayer?.userId ?? null;
  const opponentName = opponentPlayer?.name ?? t("games.precision.opponent_label_short");
  const canReport =
    !!state &&
    !!opponentClerkId &&
    opponentClerkId !== "host" &&
    opponentClerkId !== "opponent";

  const isHost = players[0]?.seat === localSeat;
  const showWaiting = !state || state.phase === "waiting" || state.phase === "starting";
  const showReadyRoom = state?.phase === "ready_up";
  const showActive = state?.phase === "active";
  // Derive selfReady from server truth whenever we have one — the optimistic
  // flag is only a hint for the brief window between click and response.
  const selfPlayer = players.find((p) => p.seat === localSeat) ?? null;
  const effectiveSelfReady = selfReady || selfPlayer?.isReady === true;

  // Arming is the pre-round random delay the server imposes. During
  // arming the input form is hidden and a "Get ready..." screen shows.
  // The client NEVER knows the planned end of the delay — it just sees
  // phase=active when the server flips the timer.
  const showArming = state?.phase === "arming";

  // Awaiting-opponent hint: true if SELF has submitted but the round
  // hasn't resolved yet (round still in progress for both seats).
  // Treat "round resolved" as either lastRoundWinnerSeat being set (a
  // seat won) OR currentRound having advanced (ties also advance the
  // round counter without setting lastRoundWinnerSeat).
  useEffect(() => {
    if (
      selfStopPending &&
      state?.phase === "active" &&
      state?.currentRound !== currentRound
    ) {
      // Server advanced the round (e.g. tie) so reset our optimistic
      // pending flag so the user can resubmit for the new round.
      setSelfStopPending(false);
    }
    // `currentRound` derived below closes over the latest render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.currentRound, state?.phase, selfStopPending]);
  const awaitingOpponentStop =
    selfStopPending &&
    state?.phase === "active" &&
    state?.lastRoundWinnerSeat === null;
  const score = state?.score ?? { seat1: 0, seat2: 0 };
  const currentRound = state?.currentRound ?? 1;
  const lastRoundWinnerSeat = state?.lastRoundWinnerSeat ?? null;

  const turnBanner = state?.phase === "active"
    ? isLocalPlayerTurn(state, localSeat)
      ? t("games.precision.your_turn")
      : t("games.precision.opponent_turn")
    : null;

  // Live rank preview for the active phase — computed once per render
  // instead of via an inline IIFE in JSX.
  const previewRank =
    state?.targetMs !== null && state?.phase === "active"
      ? diffToRank(Math.abs(timerMs - state.targetMs))
      : null;

  return (
    <div className="min-h-screen overflow-x-clip bg-gradient-to-b from-[#06120f] to-[#050816] px-3 pb-24 pt-20 text-white sm:px-6 md:pb-8">
      <NavigationBar currentPath="/casino" />

      <div className="mx-auto mt-4 max-w-6xl rounded-2xl border border-cyan-500/40 bg-black/30 p-4 sm:mt-8 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-[0.35em] text-cyan-300/80">
              {t("games.precision.match_label", { id: matchId.slice(0, 6) })}
            </p>
            <h1 className="mt-1 text-2xl font-black text-fuchsia-300 sm:text-3xl">
              {state?.phase === "active" ? t("games.precision.duel_in_progress") : t("games.precision.setting_up")}
            </h1>
            {state && (
              <p className="mt-1 text-sm text-cyan-100/90">
                {t("games.precision.wager_tokens", { wager: formatTokens(state.wager) })}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2">
            {canReport && (
              <button
                onClick={() => setShowReportModal(true)}
                className="rounded border border-red-500/40 bg-red-500/10 px-4 py-2 font-bold text-red-300 transition hover:bg-red-500/25"
              >
                <span className="inline-flex items-center gap-1"><IconFlag size={12} /> Report</span>
              </button>
            )}
            <button
              onClick={handleLeave}
              className="rounded bg-[#f5ff3b] px-4 py-2 font-bold text-black"
            >
              {t("games.precision.lobby_button")}
            </button>
            {state?.phase === "active" && (
              <button
                onClick={handleResign}
                className="rounded bg-red-600 px-4 py-2 font-bold text-white hover:bg-red-500"
              >
                {t("games.precision.resign")}
              </button>
            )}
          </div>
        </div>

        {turnBanner && (
          <p className="mt-4 inline-block rounded border border-amber-300/40 bg-amber-300/10 px-3 py-1 text-sm font-bold uppercase tracking-widest text-amber-200">
            {turnBanner}
          </p>
        )}

        {error && (
          <p className="mt-4 rounded border border-red-400/40 bg-red-500/10 px-3 py-2 text-sm text-red-200">
            {error}
          </p>
        )}

        {/* ── Round-transition wrapper ─────────────────────────
            Single AnimatePresence with mode="wait" + initial={false}
            so consecutive phases (waiting → ready → arming → active →
            finished) cross-fade cleanly. Each region's child is a
            motion.div keyed on the phase name; when the phase flips,
            AnimatePresence unmounts the prior region (running its exit
            animation) and mounts the new one. `initial={false}` skips
            the entrance animation on the FIRST mount so a refresh
            doesn't replay the fade. The per-region transform is short
            (fadeUp: 12px y + opacity), compositor-friendly, and the
            page remains idle between region changes.
        */}
        <AnimatePresence mode="wait" initial={false}>
          {showWaiting && (
            <motion.div key="phase-waiting" {...fadeUp}>
              <PrecisionWaitingRoom
                matchId={matchId}
                hostName={hostName}
                players={players}
                wager={state?.wager ?? 0}
                onLeave={handleLeave}
                onCancel={isHost ? handleLeave : undefined}
                isHost={isHost}
                copyCode={matchId}
              />
            </motion.div>
          )}

          {showReadyRoom && (
            <motion.div key="phase-ready" {...fadeUp}>
              <PrecisionReadyRoom
                matchId={matchId}
                players={players}
                wager={state?.wager ?? 0}
                selfReady={effectiveSelfReady}
                readySubmitting={readySubmitting}
                onReadyClick={handleReadyClick}
                onLeave={handleLeave}
              />
            </motion.div>
          )}

          {showArming && state && (
            <motion.div key="phase-arming" {...fadeUp}>
              {/* Timer fade: continuous gentle scale + opacity breath on
                  the arming indicator. The animation runs on the
                  compositor thread (transform + opacity only) so it
                  doesn't bust the rAF/memoization optimizations set up
                  in the previous pass. Combined with the existing
                  `animate-pulse` timer glyph, the arming phase feels like
                  a soft heartbeat instead of a static panel. */}
              <motion.div
                animate={{
                  scale: [1, 1.02, 1],
                  opacity: [0.92, 1, 0.92],
                }}
                transition={{
                  duration: 1.6,
                  repeat: Infinity,
                  ease: "easeInOut",
                }}
                className="mt-6 space-y-5"
              >
                <PrecisionScoreboard
                  score={score}
                  players={players}
                  currentRound={currentRound}
                  lastRoundWinnerSeat={lastRoundWinnerSeat}
                  viewerSeat={localSeat}
                />
                <div className="flex flex-col items-center justify-center rounded-2xl border border-yellow-400/40 bg-[#1a120a]/80 p-8 text-center sm:p-10">
                  <p className="animate-pulse"><IconClock size={44} className="text-yellow-400" /></p>
                  <h2 className="mt-4 text-2xl font-black text-yellow-300 sm:text-3xl">
                    {t("games.precision.round_get_ready", { round: currentRound })}
                  </h2>
                  {/* ── 5-second countdown before the timer starts ──
                      Both clients count down from the server-stamped
                      `countdownEndsAt` so they stay in sync; the server
                      flips to "active" (timer + target) the instant it
                      hits zero. `Math.max(1, …)` keeps the display on
                      "1" during the final tick instead of flashing 0. */}
                  <p className="mt-4 text-xs uppercase tracking-[0.35em] text-yellow-200/70">
                    {t("games.precision.countdown_label")}
                  </p>
                  <p
                    data-testid="precision-round-countdown"
                    className="mt-1 font-mono text-8xl font-black tabular-nums text-yellow-300 sm:text-9xl"
                  >
                    {countdownMs !== null ? Math.max(1, Math.ceil(countdownMs / 1000)) : "…"}
                  </p>
                  <p className="mt-3 max-w-md text-sm text-cyan-100/90 sm:text-base">
                    {t("games.precision.arming_hint")}
                  </p>
                  <button
                    onClick={handleResign}
                    className="mt-6 rounded bg-red-600 px-6 py-2 font-bold text-white hover:bg-red-500"
                  >
                    {t("games.precision.resign")}
                  </button>
                </div>
              </motion.div>
            </motion.div>
          )}

          {showActive && state && (
            <motion.div key="phase-active" {...fadeUp}>
              <div className="mt-6 space-y-5">
                <PrecisionScoreboard
                  score={score}
                  players={players}
                  currentRound={currentRound}
                  lastRoundWinnerSeat={lastRoundWinnerSeat}
                  viewerSeat={localSeat}
                  awaitingOpponentStop={awaitingOpponentStop}
                  lastRoundStops={
                    state.lastRoundStops
                      ? {
                          seat1: {
                            elapsedMs: state.lastRoundStops.seat1.elapsedMs,
                            diffMs: state.lastRoundStops.seat1.diffMs,
                          },
                          seat2: {
                            elapsedMs: state.lastRoundStops.seat2.elapsedMs,
                            diffMs: state.lastRoundStops.seat2.diffMs,
                          },
                        }
                      : null
                  }
                />

                <div className="rounded-2xl border border-fuchsia-400/40 bg-[#0a0420]/80 p-5 text-center sm:p-8">
                  <p><IconTarget size={44} className="text-fuchsia-400" /></p>
                  <h2 className="mt-4 text-2xl font-black text-fuchsia-300">
                    {t("games.precision.round_label", { round: currentRound })}
                  </h2>

                  {/* ── Running timer (client-side, visual-only) ── */}
                  <p className="mt-3 text-xs uppercase tracking-[0.35em] text-cyan-300/80">
                    {t("games.precision.elapsed_label")}
                  </p>
                  <p
                    data-testid="precision-round-timer"
                    className="mt-1 font-mono text-6xl font-black tabular-nums text-cyan-200 sm:text-7xl"
                  >
                    {Math.round(timerMs).toLocaleString()}
                    <span className="ml-1 text-3xl text-cyan-300/60">{t("games.precision.ms_suffix")}</span>
                  </p>

                  {/* Per-round target revealed by the server when the
                      arming→active timer fires. The value is `null` if the
                      state hasn't been refreshed yet on the very first
                      active tick — show a placeholder rather than crashing. */}
                  <p className="mt-4 text-xs uppercase tracking-[0.35em] text-cyan-300/80">
                    {t("games.precision.target")}
                  </p>
                  <p
                    data-testid="precision-round-target"
                    className="mt-1 text-4xl font-black text-yellow-300 sm:text-5xl"
                  >
                    {state.targetMs !== null
                      ? `${state.targetMs.toLocaleString()} ${t("games.precision.ms_suffix")}`
                      : "-"}
                  </p>

                  {/* Live rank preview — shows what rank the player would
                      earn if they stopped at the current timer value. */}
                  {previewRank && (
                    <p className={`mt-3 text-lg font-bold ${previewRank.color}`}>
                      <PrecisionRankIcon label={previewRank.label} size={16} className="mr-1 inline" /> {previewRank.label}{" "}
                      <span className="text-sm font-normal text-cyan-100/70">
                        ({t("games.precision.ms_off_format", { ms: Math.abs(Math.round(timerMs - (state.targetMs ?? 0))).toLocaleString() })})
                      </span>
                    </p>
                  )}
                  {state.lastRoundStops && (
                    <div
                      data-testid="precision-last-round-stops"
                      className="mt-5 rounded-2xl border border-cyan-400/40 bg-black/30 px-4 py-2 text-xs text-cyan-100"
                    >
                      <p className="text-[10px] uppercase tracking-[0.35em] text-cyan-200/80">
                        {t("games.precision.previous_round_snapshot")}
                      </p>
                      <p className="mt-1 font-mono">
                        {t("games.precision.you_label_short")}{" "}
                        <span className="font-bold text-yellow-300">
                          {state.lastRoundStops[
                            localSeat === 1 ? "seat1" : "seat2"
                          ]?.elapsedMs ?? 0}{" "}
                          {t("games.precision.ms_suffix")}
                        </span>{" "}
                        · {t("games.precision.opponent_label_short")}{" "}
                        <span className="font-bold text-fuchsia-300">
                          {state.lastRoundStops[
                            localSeat === 1 ? "seat2" : "seat1"
                          ]?.elapsedMs ?? 0}{" "}
                          {t("games.precision.ms_suffix")}
                        </span>
                      </p>
                      <p className="mt-1 text-[10px] text-cyan-100/70">
                        {t("games.precision.snapshot_hint")}
                      </p>
                    </div>
                  )}
                  <p className="mt-4 text-sm text-cyan-100/90 sm:text-base">
                    {t("games.precision.stop_hint")}
                  </p>
                  <div className="mx-auto mt-5 flex max-w-md flex-col gap-3">
                    <button
                      type="button"
                      onClick={handleStopClick}
                      disabled={
                        selfStopPending ||
                        stopSubmitting ||
                        awaitingOpponentStop
                      }
                      data-testid="precision-stop-button"
                      className={
                        selfStopPending
                          ? "w-full cursor-default rounded-2xl border-2 border-emerald-300/40 bg-emerald-400/20 px-6 py-6 text-3xl font-black tracking-widest text-emerald-100"
                          : stopSubmitting
                            ? "w-full cursor-wait rounded-2xl border-2 border-yellow-300/40 bg-yellow-400/20 px-6 py-6 text-3xl font-black tracking-widest text-yellow-100"
                            : "w-full rounded-2xl border-2 border-red-400/60 bg-gradient-to-b from-red-500 to-red-600 px-6 py-6 text-3xl font-black tracking-widest text-white shadow-[0_0_30px_rgba(239,68,68,0.65)] transition active:scale-95 hover:from-red-400 hover:to-red-500 animate-pulse"
                      }
                    >
                      {selfStopPending
                        ? t("games.precision.stop_sent")
                        : stopSubmitting
                          ? t("games.precision.submitting")
                          : t("games.precision.stop_button")}
                    </button>
                  </div>
                  <button
                    onClick={handleResign}
                    className="mt-6 rounded bg-red-600 px-6 py-2 font-bold text-white hover:bg-red-500"
                  >
                    {t("games.precision.resign")}
                  </button>
                </div>
              </div>
            </motion.div>
          )}

          {state?.phase === "finished" && (
            <motion.div key="phase-finished" {...fadeUp}>
              <div className="mt-8 flex flex-col items-center gap-3">
                {state.score && (
                  <PrecisionScoreboard
                    score={state.score}
                    players={players}
                    currentRound={Math.max(state.currentRound, 1)}
                    lastRoundWinnerSeat={state.lastRoundWinnerSeat}
                  />
                )}
                <p className="rounded border border-cyan-400/40 bg-cyan-400/10 px-4 py-2 text-sm font-bold text-cyan-100">
                  {t("games.precision.match_finished_short")}
                </p>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <PrecisionResultPopup
        popup={endPopup}
        onReplay={handleReplayRequest}
        onReturnToLobby={handleReturnToLobby}
        replayRequested={replayRequested}
        opponentReplayRequested={opponentReplayRequested}
        returnChosen={returnChosen}
      />

      {roundResultReveal && (
        <PrecisionRoundResultPanel
          targetMs={roundResultReveal.targetMs}
          seat1Name={
            players.find((p) => p.seat === 1)?.name ?? t("games.precision.seat_alpha")
          }
          seat1ElapsedMs={roundResultReveal.seat1ElapsedMs}
          seat1DiffMs={roundResultReveal.seat1DiffMs}
          seat2Name={
            players.find((p) => p.seat === 2)?.name ?? t("games.precision.seat_bravo")
          }
          seat2ElapsedMs={roundResultReveal.seat2ElapsedMs}
          seat2DiffMs={roundResultReveal.seat2DiffMs}
          roundWinnerSeat={roundResultReveal.roundWinnerSeat}
          localSeat={localSeat}
          onDismiss={dismissRoundResult}
        />
      )}

      {/* Report modal */}
      <ReportModal
        isOpen={showReportModal}
        onClose={() => setShowReportModal(false)}
        onSubmit={async (reason, details) => {
          const res = await fetch("/api/reports/submit", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              reportedClerkId: opponentClerkId,
              gameType: "precision",
              gameId: matchId,
              reason,
              details: details || undefined,
            }),
          });
          const data = await res.json();
          if (!data.success) throw new Error(data.error || "Failed to submit report");
        }}
        reportedPlayerName={opponentName || "Opponent"}
        gameType="Precision"
      />

      <Footer />
    </div>
  );
}
