"use client";

// ── Match page for the Precision PvP casino game ────────────────────────
//
// This file is ORCHESTRATION ONLY. The page used to carry every concern the
// game has; they now live in focused modules, and what is left here is the
// wiring between them:
//
//   * `hooks/usePrecisionMatchState`  — the single copy of the server snapshot,
//                                       fed by the poll and the socket
//                                       broadcasts (stale-response guarded).
//   * `hooks/usePrecisionRoundClock`  — the display clock, the pre-round
//                                       countdown and the arming fast-poll.
//   * `hooks/usePrecisionRoundReveal` — the per-round "who won" reveal.
//   * `hooks/usePrecisionEndPopup`    — the end-of-match popup, the payout
//                                       request and the replay/return handshake.
//   * `lib/precision/matchView`       — the pure derivations (lanes, reveal
//                                       payload, stop telemetry, seat).
//   * `components/precision/PrecisionMatchHeader` / `PrecisionMatchPhases`
//                                     — the header, status lines and the phase
//                                       panels (armed / active / finished).
//
// What stays here: the local player's own UI state (optimistic Ready + STOP
// flags, error line, report modal), the four user actions (ready, stop, resign,
// leave), and the map from `PrecisionState.phase` onto the primary surfaces.
//
// `waiting` → waiting room · `ready_up` → ready room · `arming` → the frozen
// recap of the round that just ended + the countdown · `active` → the two-lane
// rocket race + target + STOP · `finished` → the result popup with replay.
//
// IMPORTANT: All timing calculations live on the server. The client emits ONLY
// a bare STOP signal over the realtime socket; the server stamps the STOP
// instant and computes elapsed = stopInstant - roundGoInstant. The local running
// timer is visual-only, but it is ANCHORED to that same server GO instant via
// `roundClock.ts` and FREEZES the instant the player hits STOP, so the number on
// screen matches the number the server measures.

import { use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { usePostHog } from "posthog-js/react";

import NavigationBar from "../../../../../components/navigation-bar";
import Footer from "../../../../../components/Footer";
// Shared Creator Mode foundation (admin-only): mounts the viewport
// recorder + overlay and auto-starts when the match actually begins
// (leaves the waiting room), auto-stops when it finishes or the user
// quits. The waiting room and Footer/modals stay OUTSIDE so nothing is
// recorded until real gameplay starts.
import CreatorModeHost from "../../../../../components/creator-mode/CreatorModeHost";
import {
  CreatorView,
  CreatorModeShell,
  ShellHeader,
  ShellMain,
} from "../../../../../components/creator-mode/CreatorModeLayout";
import ReportModal from "../../../../../components/ReportModal";
import { useTranslation } from "../../../../../hooks/useTranslation";
import useGameEmotes from "../../../../../hooks/useGameEmotes";
import PrecisionResultPopup from "../../../../../components/precision/PrecisionResultPopup";
import PrecisionRoundResultPanel from "../../../../../components/precision/PrecisionRoundResultPanel";
import PrecisionMatchErrorBoundary from "../../../../../components/precision/PrecisionMatchErrorBoundary";
import {
  PrecisionCreatorHeader,
  PrecisionMatchHeader,
  PrecisionMatchStatus,
} from "../../../../../components/precision/PrecisionMatchHeader";
import PrecisionMatchPhases from "../../../../../components/precision/PrecisionMatchPhases";
import { usePrecisionMatchState } from "../../../../../hooks/usePrecisionMatchState";
import { usePrecisionRoundClock } from "../../../../../hooks/usePrecisionRoundClock";
import { usePrecisionRoundReveal } from "../../../../../hooks/usePrecisionRoundReveal";
import { usePrecisionEndPopup } from "../../../../../hooks/usePrecisionEndPopup";
import {
  emitStop,
  isLocalPlayerTurn,
  leaveGame,
  markReady,
  resignMatch,
} from "../../../../../lib/precision/multiplayer";
import { useSocket } from "../../../../../context/SocketProvider";
import { SOCKET_NAMESPACE } from "../../../../../lib/precision/constants";
import {
  buildRaceLanes,
  buildRoundStops,
  liveTargetMsOf,
  readStoredLocalSeat,
} from "../../../../../lib/precision/matchView";
import { diffToRank, makeInitialEndPopupState } from "../../../../../lib/precision/utils";
import type { PrecisionPlayer, PrecisionState } from "../../../../../lib/precision/types";

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

// ── Outer render-error containment ──────────────────────────────────────
// The boundary has to sit ABOVE the page's own render logic. React error
// boundaries only catch errors thrown by their CHILDREN, so a boundary
// RETURNED by this component could never catch a throw from this component's
// render body — and the page builds every one of its nodes (header, phase
// panels, rocket lanes) right here, from the server snapshot. A malformed or
// unexpected snapshot therefore escaped past the old inner boundary to the
// App Router's error overlay: the reported blank/black page that a refresh
// appeared to fix. Wrapping the whole page in the boundary closes that gap.
export default function PrecisionMatchPage(props: PrecisionMatchPageProps) {
  return (
    <PrecisionMatchErrorBoundary>
      <PrecisionMatchPageInner {...props} />
    </PrecisionMatchErrorBoundary>
  );
}

function PrecisionMatchPageInner({ params }: PrecisionMatchPageProps) {
  const router = useRouter();
  const posthog = usePostHog();
  const { socket } = useSocket();
  const { t } = useTranslation();
  // Unwrap the dynamic-route params Promise. `use()` suspends this
  // component until the param is resolved; the result is a plain
  // object, so `matchId` is a real string (or falls back to "unknown" if
  // somehow absent — see the guard below).
  //
  // The Promise is memoised to a STABLE identity for the component's life,
  // matching every other match page in the repo (blackjack / mines-pvp /
  // roulette / lane-runner / plinko): `use()` must always be handed the same
  // promise across renders or it re-suspends on each of them, and wrapping it
  // also keeps the call safe on a Next version that hands `params` through
  // un-wrapped (a plain object is not a thenable). A re-suspend here is what
  // rendered the page as nothing but its background until a hard reload.
  const paramsPromise = useMemo(() => Promise.resolve(params), [params]);
  const { matchId: rawMatchId } = use(paramsPromise);
  // Defensive fallback: if the URL is missing the dynamic segment the
  // page would otherwise render with `matchId === undefined` and crash
  // on the first `.slice()` call. Strictly a safety-net — Next.js
  // always supplies the segment when routing through [matchId].
  const matchId = typeof rawMatchId === "string" && rawMatchId.length > 0 ? rawMatchId : "unknown";

  // ── Local player's own UI state ──────────────────────────────────────
  // TODO(gameplay): when the auth flow lands in the scaffold, derive this
  // from the Clerk session id compared to `state.players[*].userId` so the
  // opponent-aware logic below actually flips sides correctly. For now the
  // lobby page writes `precision:localSeat` ("1" or "2") to sessionStorage
  // once it knows which seat we own, so post-matchmaking clients can decide
  // whether *they* are the Ready button.
  const [localSeat, setLocalSeat] = useState(readStoredLocalSeat);
  // Optimistic + server-confirmed Ready flag for the local player.
  // `selfReadyUserIdRef` is the userId we sent to /api/precision/ready
  // so we can resolve "self" when auth isn't fully wired. A ref (not
  // state) is used so the socket listener doesn't have to re-bind every
  // time we click Ready.
  const [selfReady, setSelfReady] = useState(false);
  const [readySubmitting, setReadySubmitting] = useState(false);
  const selfReadyUserIdRef = useRef<string | null>(null);
  // Round-stop optimistic flags. `selfStopPending` flips true the
  // instant the user clicks STOP and is reset when both seats'
  // submissions land. `stopSubmitting` covers the in-flight window
  // before the ACK fires. The race-proof single-click lock uses
  // a ref so the synchronous click handler always wins:
  // `stopLockedThisRoundRef.current === true` means STOP has
  // already fired for this round.
  const [selfStopPending, setSelfStopPending] = useState(false);
  const [stopSubmitting, setStopSubmitting] = useState(false);
  const stopLockedThisRoundRef = useRef<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  // Report modal — flags the human opponent for moderation.
  const [showReportModal, setShowReportModal] = useState(false);

  // ── Server state ─────────────────────────────────────────────────────
  const handleRoundResult = useCallback(() => setSelfStopPending(false), []);
  const handleReadySnapshot = useCallback((next: PrecisionState) => {
    const selfId = selfReadyUserIdRef.current;
    if (
      selfId &&
      Array.isArray(next.players) &&
      next.players.some((p) => p.userId === selfId && p.isReady)
    ) {
      setSelfReady(true);
    }
  }, []);

  const { state, stateRef, lookup, applySnapshot, refreshState } = usePrecisionMatchState({
    matchId,
    socket,
    onRoundResult: handleRoundResult,
    onReadySnapshot: handleReadySnapshot,
  });

  const { timerMs, countdownMs, selfFrozenElapsedMs, freezeTimer, releaseFreeze } =
    usePrecisionRoundClock({ state, refreshState });

  const { reveal, dismissReveal } = usePrecisionRoundReveal({ state, localSeat });

  // ── Derived display values ───────────────────────────────────────────
  // Real seats only. This used to fall back to a hardcoded placeholder pair
  // so the waiting room always had two "connected" tiles — which is exactly
  // what made a stale match URL look like a live game with no content (fake
  // "You" + "Opponent" seats, nothing else). An empty list renders empty
  // seats ("Awaiting…" / "Open") and, when the server has nothing for this
  // id at all, the dedicated unavailable panel takes over.
  const players = useMemo<PrecisionPlayer[]>(() => state?.players ?? [], [state]);
  const currentRound = state?.currentRound ?? 1;

  const {
    endPopup,
    setEndPopup,
    replayRequested,
    opponentReplayRequested,
    returnChosen,
    requestReplay,
    requestReturn,
  } = usePrecisionEndPopup({
    matchId,
    socket,
    state,
    players,
    localSeat,
    router,
    posthog,
  });

  // Emotes — dedicated per-match room (same pattern as the other PvP games).
  const { incomingEmote, myEmote, sendEmote } = useGameEmotes({
    socket,
    roomId: matchId ? `precision:emote:${matchId}` : null,
    eventName: "precision:emote",
    selfId: String(localSeat),
  });

  // A vs-AI practice match ALWAYS seats the human at seat 1 (see
  // `createAiMatch`). A stale sessionStorage seat from a previous PvP match
  // would otherwise be treated as "self", mislabelling the bot as the player —
  // which stranded the Ready / STOP controls. Correct it as soon as the
  // snapshot tells us this is an AI match.
  useEffect(() => {
    if (state?.isAiGame && localSeat !== 1) setLocalSeat(1);
  }, [state?.isAiGame, localSeat]);

  // Report target: the opponent is whoever occupies the seat we don't
  // hold. Only show the flag once a real second player has joined —
  // the scaffold seeds placeholder "host"/"opponent" userIds, which
  // are not real Clerk ids and must never be reported.
  const opponentPlayer = players.find((p) => p.seat !== localSeat) ?? null;
  const opponentClerkId = opponentPlayer?.userId ?? null;
  const opponentName = opponentPlayer?.name ?? t("games.precision.opponent_label_short");
  const canReport =
    !!state && !!opponentClerkId && opponentClerkId !== "host" && opponentClerkId !== "opponent";

  const turnBanner =
    state?.phase === "active"
      ? isLocalPlayerTurn(state, localSeat)
        ? t("games.precision.your_turn")
        : t("games.precision.opponent_turn")
      : null;

  // Live rank preview for the active phase — computed once per render
  // instead of via an inline IIFE in JSX.
  const liveTargetMs = liveTargetMsOf(state);
  const previewRank =
    liveTargetMs !== null && state?.phase === "active"
      ? diffToRank(Math.abs(timerMs - liveTargetMs))
      : null;

  // Normalised per-seat telemetry for the scoreboard's rank badges.
  const boardStops = useMemo(() => buildRoundStops(state), [state]);

  // ── Rocket-race lanes ──────────────────────────────────────────────
  // Used for BOTH the live round (`recap=false`) and the post-round arming
  // recap (`recap=true`); see `buildRaceLanes`.
  const raceLanes = useCallback(
    (recap: boolean) =>
      buildRaceLanes({
        recap,
        state,
        players,
        localSeat,
        selfFrozenElapsedMs,
        seat1Fallback: t("games.precision.seat_alpha"),
        seat2Fallback: t("games.precision.seat_bravo"),
      }),
    [state, players, localSeat, selfFrozenElapsedMs, t]
  );

  const awaitingOpponentStop =
    selfStopPending && state?.phase === "active" && state?.lastRoundWinnerSeat === null;

  // ── Reset the single-click STOP lock between rounds ─────────────
  // The page-wide race-proof single-click lock is reset whenever the
  // round resolves. Resolution is detected via TWO independent signals:
  //   * `state?.currentRound` — bumps on a non-tie round decision
  //     (recordRoundStop increments it after applying the score).
  //   * `state?.phase`        — flips out of "active" on EITHER a tie
  //     (the server re-arms the same round — phase → "arming" without
  //     bumping currentRound) OR a match finish (phase → "finished").
  //     Watching phase catches the tie-replay path where currentRound
  //     does NOT change. Without the phase dep, the STOP button would stay
  //     disabled after a tie even though the server has re-armed and the new
  //     round is waiting to open.
  //
  // Note: dep array intentionally lists only the three primitive
  // transitions (NOT the whole `state` reference) — including `state`
  // would re-fire this effect on every poll (the state ref churns each
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
      // Release the frozen timer/rocket too — the round is over, so the next
      // `active` round must start flying again from zero. The arming recap
      // reads the frozen positions from `lastRoundStops` instead.
      releaseFreeze();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.currentRound, state?.phase, state?.lastRoundWinnerSeat]);

  // ── Awaiting-opponent hint ──────────────────────────────────────────
  // The server advanced the round (e.g. a tie was re-armed) while we were
  // still showing the optimistic pending flag: re-derive it so the player can
  // submit for the new round.
  useEffect(() => {
    if (selfStopPending && state?.phase === "active" && state?.currentRound !== currentRound) {
      setSelfStopPending(false);
    }
    // `currentRound` is the just-rendered value for this render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.currentRound, state?.phase, selfStopPending]);

  // ── Handlers ─────────────────────────────────────────────────────────
  // Tell the server we're done with this game id BEFORE navigating away, so
  // nothing is left behind: a waiting lobby is cancelled, a practice (vs AI)
  // match is removed, and a live PvP match is forfeited to the opponent (the
  // same outcome the realtime server's disconnect grace timer produces).
  // Fire-and-forget — the endpoint is idempotent and its failure must never
  // block the navigation.
  const handleLeave = useCallback(() => {
    void leaveGame(matchId).catch(() => {});
    router.push("/casino/precision");
  }, [matchId, router]);

  const handleResign = useCallback(async () => {
    if (!matchId) return;
    try {
      await resignMatch(matchId);
      setEndPopup(makeInitialEndPopupState("loss", "resigned", stateRef.current?.wager ?? 0));
      posthog?.capture("precision_match_resigned", { matchId });
    } catch (err) {
      setError((err as Error)?.message ?? t("games.precision.resign_failed"));
    }
  }, [matchId, posthog, t, setEndPopup, stateRef]);

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
      const selfRecord = liveState?.players.find((p) => p.seat === localSeat) ?? null;
      const userId = selfRecord?.userId ?? (localSeat === 1 ? "host" : "opponent");
      selfReadyUserIdRef.current = userId;
      const response = await markReady(matchId, userId);
      if (!response.success || !response.match) {
        // Roll back the optimistic flip on failure.
        setSelfReady(false);
        setError(response.error ?? t("games.precision.ready_failed"));
        return;
      }
      applySnapshot(response.match);
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
  }, [matchId, readySubmitting, selfReady, localSeat, socket, posthog, applySnapshot, stateRef, t]);

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
  // when the round advances (see the round-resolution effect above).
  //
  // Server feedback flows in two paths:
  //   * Direct ACK callback: fires once the realtime server has
  //     processed the stop. Flips `stopSubmitting` off and unlocks
  //     the optimistic STOP on server-rejection / network error.
  //   * Match-room broadcast: fires once BOTH seats have submitted.
  //     The `roundResultEvent` listener clears `selfStopPending` and
  //     updates the snapshot.
  const handleStopClick = useCallback(() => {
    if (!matchId) return;
    if (stopSubmitting || selfStopPending) return;
    // Race-proof single-click lock. Synchronously set BEFORE any other
    // work so a second click that lands in the same React batch hits
    // the guard above and returns. Resets between rounds.
    if (stopLockedThisRoundRef.current) return;
    stopLockedThisRoundRef.current = true;
    if (!socket) {
      // No realtime connection — the round can't resolve without it.
      // Unlock so the user can retry the next round.
      stopLockedThisRoundRef.current = false;
      setError(t("games.precision.stop_no_socket"));
      return;
    }
    // Freeze the display clock and the player's rocket the instant STOP is
    // accepted for submission. Without this the local rAF loop kept running
    // until the ROUND resolved — which, against the bot, is a whole server
    // read after the AI's own stop — so the timer visibly refused to stop on
    // click. `freezeTimer` parks both on the spot.
    freezeTimer();
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
    // `recordRoundStop`. The fifth argument is the Socket.IO ACK
    // callback: it fires EXACTLY ONCE with `{ success, error? }` and
    // unlocks the optimistic state on failure.
    //
    // The replay envelope (`roundId`, `nonce`) is read live from
    // `stateRef.current` so the client always echoes the values the
    // server stamped when the live round was armed. The server REJECTS
    // any stop packet whose `roundId` or `nonce` does not match the live
    // round — so a tampered client cannot replay a packet from a previous
    // round.
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
      }
    );
  }, [matchId, stopSubmitting, selfStopPending, socket, posthog, freezeTimer, stateRef, t]);

  const handleReturnToLobby = useCallback(() => {
    requestReturn();
    // A finished match is a no-op server-side, but a player can also reach
    // this handler while still waiting, so route the same cleanup through it.
    void leaveGame(matchId).catch(() => {});
    router.push("/casino/precision");
  }, [requestReturn, matchId, router]);

  // ── Close-the-tab cleanup while still waiting for an opponent ────────
  // A waiting lobby has no realtime room, so the socket-disconnect grace
  // timer can't reach it: without this, closing the tab left the lobby in the
  // public list (and in everyone's "waiting" view) for the full 5-minute TTL.
  // `sendBeacon` survives the unload; the endpoint only ever cancels a
  // `waiting` lobby this caller hosts, so a live match is never touched by a
  // navigation. Only wired while this page is actually in the waiting phase.
  useEffect(() => {
    if (state?.phase !== "waiting") return;
    const onBeforeUnload = () => {
      try {
        const payload = new Blob([JSON.stringify({ matchId })], {
          type: "application/json",
        });
        navigator.sendBeacon?.("/api/precision/leave", payload);
      } catch {
        // Beacons are best-effort — the LOBBY_TTL_MS sweep is the backstop.
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [state?.phase, matchId]);

  // ── Creator-mode layout nodes ─────────────────────────────────────
  // The game content is split into reusable nodes so the normal page
  // (non-creator) renders byte-for-byte the same, while Creator Mode
  // gets a bespoke arrangement: portrait = phone-style (compact header
  // on top, the game panels filling the middle); landscape/square =
  // the panels fill the frame height.

  const headerNode = (
    <PrecisionMatchHeader
      matchId={matchId}
      state={state}
      canReport={canReport}
      onReport={() => setShowReportModal(true)}
      onLeave={handleLeave}
      onResign={handleResign}
    />
  );

  const creatorHeaderNode = (
    <PrecisionCreatorHeader
      matchId={matchId}
      state={state}
      canReport={canReport}
      onReport={() => setShowReportModal(true)}
      onLeave={handleLeave}
      onResign={handleResign}
    />
  );

  const statusNode = <PrecisionMatchStatus turnBanner={turnBanner} error={error} />;

  const bodyNode = (
    <PrecisionMatchPhases
      matchId={matchId}
      state={state}
      lookup={lookup}
      players={players}
      localSeat={localSeat}
      selfReady={selfReady}
      readySubmitting={readySubmitting}
      onReadyClick={handleReadyClick}
      onLeave={handleLeave}
      onResign={handleResign}
      onStopClick={handleStopClick}
      selfStopPending={selfStopPending}
      stopSubmitting={stopSubmitting}
      awaitingOpponentStop={awaitingOpponentStop}
      boardStops={boardStops}
      countdownMs={countdownMs}
      timerMs={timerMs}
      liveTargetMs={liveTargetMs}
      previewRank={previewRank}
      raceLanes={raceLanes}
      incomingEmote={incomingEmote}
      myEmote={myEmote}
      sendEmote={sendEmote}
    />
  );

  // Normal (non-creator) page — byte-for-byte the original stack.
  const normalView = (
    <div className="mx-auto mt-4 max-w-6xl rounded-2xl border border-cyan-500/40 bg-black/30 p-4 sm:mt-8 sm:p-5">
      {headerNode}
      {statusNode}
      {bodyNode}
    </div>
  );

  // Portrait (9:16) — phone-style: compact header, the game panels
  // filling the middle.
  const portraitContent = (
    <CreatorModeShell className="bg-gradient-to-b from-[#06120f] to-[#050816]">
      <ShellHeader className="flex flex-col gap-1.5">{creatorHeaderNode}</ShellHeader>
      <ShellMain className="overflow-hidden">
        <div className="flex h-full w-full flex-col px-3 py-2">
          {statusNode}
          <div className="flex-1 min-h-0 overflow-y-auto rounded-2xl border border-cyan-500/40 bg-black/30 p-4">
            {bodyNode}
          </div>
        </div>
      </ShellMain>
    </CreatorModeShell>
  );

  // Landscape (16:9) / square (1:1) — the game panels fill the frame
  // height.
  const landscapeContent = (
    <CreatorModeShell className="bg-gradient-to-b from-[#06120f] to-[#050816]">
      <ShellMain className="overflow-hidden">
        <div className="flex h-full w-full flex-col gap-2 p-4">
          {creatorHeaderNode}
          {statusNode}
          <div className="flex-1 min-h-0 overflow-y-auto rounded-2xl border border-cyan-500/40 bg-black/30 p-4">
            {bodyNode}
          </div>
        </div>
      </ShellMain>
    </CreatorModeShell>
  );

  return (
    // Render-error containment lives in the DEFAULT EXPORT wrapper above — a
    // boundary has to be the page's PARENT to catch throws from this render
    // body (a bad server snapshot must degrade to a recoverable panel, never
    // a blank page).
    <div className="min-h-screen overflow-x-clip bg-gradient-to-b from-[#06120f] to-[#050816] px-3 pb-24 pt-20 text-white sm:px-6 md:pb-8">
      <NavigationBar currentPath="/casino" />

      {/* Only the actual game content is recorded — the waiting room +
          NavBar above and the Footer/modals below sit outside the shared
          CreatorModeHost recording viewport. Recording auto-starts when
          the match leaves the waiting room and stops when it finishes. */}
      <CreatorModeHost
        autoStart={Boolean(state) && state.phase !== "waiting" && state.phase !== "finished"}
        autoStop={state?.phase === "finished"}
        gameLabel="precision"
        backToLobbyHref="/casino/precision"
      >
        <CreatorView normal={normalView} portrait={portraitContent} landscape={landscapeContent} />

        {/* End-of-round reveal + end-of-match result — mounted INSIDE
            CreatorModeHost (as siblings of <CreatorView>) so both are part of
            the recording. They used to sit after the host, i.e. outside the
            recording frame, so a creator clip ended mid-duel with no round
            result and no WIN/LOSS panel. The popup picks its own sizing from
            the creator-mode flag (see PrecisionResultPopup). */}
        {reveal && (
          <PrecisionRoundResultPanel
            targetMs={reveal.targetMs}
            seat1Name={players.find((p) => p.seat === 1)?.name ?? t("games.precision.seat_alpha")}
            seat1ElapsedMs={reveal.seat1ElapsedMs}
            seat1DiffMs={reveal.seat1DiffMs}
            seat2Name={players.find((p) => p.seat === 2)?.name ?? t("games.precision.seat_bravo")}
            seat2ElapsedMs={reveal.seat2ElapsedMs}
            seat2DiffMs={reveal.seat2DiffMs}
            roundWinnerSeat={reveal.roundWinnerSeat}
            localSeat={localSeat}
            onDismiss={dismissReveal}
          />
        )}

        <PrecisionResultPopup
          popup={endPopup}
          onReplay={requestReplay}
          onReturnToLobby={handleReturnToLobby}
          replayRequested={replayRequested}
          opponentReplayRequested={opponentReplayRequested}
          returnChosen={returnChosen}
          // Frozen rockets of the last decided round. `lastRoundStops` survives
          // the match-finish transition, so the board can show where both
          // rockets ultimately landed; null when no round was ever decided.
          race={
            state?.lastRoundStops
              ? {
                  targetMs: state.lastRoundTargetMs ?? null,
                  lanes: raceLanes(true),
                }
              : null
          }
        />
      </CreatorModeHost>

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
