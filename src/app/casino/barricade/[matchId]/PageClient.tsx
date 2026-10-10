"use client";

// src/app/casino/barricade/[matchId]/PageClient.tsx
//
// The online Barricade match view.
//
// ── AUTHORITY ─────────────────────────────────────────────────────────────
//
// The server owns the position. The ONLY thing this page ever sends is an
// ACTION ADDRESS plus the version it was shown:
//
//   { action: { type: "move", to: { col, row } }
//           | { type: "wall", wall: { col, row, orientation } },
//     expectedVersion }
//
// No board, no pawn position, no barricade list, no remaining-wall count, no
// turn owner, no winner and no result is ever sent — and none is ever derived
// locally. What the player sees is the server's `gameState`, the server's
// `isViewerTurn`, the server's `wallsRemaining` for BOTH seats, and the
// server's `result` / `winnerId` / `resultReason` for the result screen.
//
// The engine is used here for one thing only: to know which squares and grooves
// to OFFER (the same `legalMoves` / `legalWalls` the store validates against when
// the request lands). A click that the engine would refuse is dropped before it
// is even sent, the server refuses it anyway, and the refusal is what the player
// reads.
//
// Optimism is limited to FEEDBACK: the action the viewer just submitted is kept
// as a "pending" highlight until an authoritative snapshot moves past that
// version, then dropped. The view is never allowed to drift from the server.
//
// ── FLOW ──────────────────────────────────────────────────────────────────
//
//   poll GET /api/barricade/match/<id>   (adaptive interval, aborted on push)
//   socket `lobby:updated` on `barricade:match:<id>` → immediate refetch
//   click an offered square / groove → POST /move → adopt the returned snapshot
//   → emit `barricade:ready` so the opponent refetches in ~50 ms
//   waiting → MatchWaiting (creator can cancel) · finished/cancelled → result
//
// RECONNECT is the same path as a first load: the snapshot is re-read, the
// socket re-joins its room on every connect, and the server's disconnect grace
// timer for this seat is cancelled by that re-join. A player who stays away past
// the grace window is forfeited server-side; the survivor simply sees the
// terminal snapshot with reason `abandoned`.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import { useUser } from "@clerk/nextjs";
import {
  IconAlertTriangle,
  IconArrowsHorizontal,
  IconArrowsVertical,
  IconBallpen,
  IconDoorExit,
  IconFlag,
  IconWall,
} from "@tabler/icons-react";

import { useSocket } from "../../../../context/SocketProvider";
import EmotePicker, { EmoteBubble } from "../../../../components/game/EmotePicker";
import useGameEmotes from "../../../../hooks/useGameEmotes";
import SeatAvatar from "../../../../components/game/SeatAvatar";
import MatchLoading from "../../../../components/game/MatchLoading";
import MatchWaiting from "../../../../components/lobby/MatchWaiting";
import PvpResultScreen from "../../../../components/result/PvpResultScreen";
import ReportModal from "../../../../components/ReportModal";
import GameSessionHost from "../../../../components/GameSessionHost";
import BarricadeBoard, {
  type BarricadePreview,
} from "../../../../components/barricade/BarricadeBoard";
import {
  BARRICADE_MATCH_UPDATED,
  BARRICADE_READY,
  barricadeMatchRoom,
} from "../../../../lib/barricade/rooms";
import { MOVE_KINDS, ORIENTATIONS } from "../../../../lib/barricade/constants";
import {
  applyAction,
  classifyWall,
  goalRowFor,
  isMatchFinished,
  legalMoves,
  legalWalls,
  wallKey,
} from "../../../../lib/barricade/rules";
import {
  durationSeconds,
  isIncomingSnapshotStale,
  loggedActionLabel,
  outcomeFor,
  resultReasonLabel,
  seatColor,
  seatLabel,
  seatName,
  statusLabel,
  turnLabel,
  wallsFor,
} from "../../../../lib/barricade/ui";
import type {
  BarricadeAction,
  BarricadeState,
  MoveKind,
  Orientation,
  Position,
  Seat,
  WallPlacement,
} from "../../../../lib/barricade/types";
import {
  playBarricadeJump,
  playBarricadeLoss,
  playBarricadeReject,
  playBarricadeStep,
  playBarricadeWall,
  playBarricadeWin,
} from "../../../../lib/barricadeAudio";

const ACTIVE_POLL_MS = 1800;
const IDLE_POLL_MS = 5000;
/**
 * The lobby, in its CANONICAL form: bare `/casino/barricade` 308-redirects to
 * the public landing page `/games/barricade`, which Barricade does not have yet
 * (its catalogue entry is a separate, later change) and which would therefore
 * 404. `/games/barricade/play` is the lobby, rewritten to `/casino/barricade`
 * internally — the same shape every other game uses.
 */
const LOBBY_PATH = "/games/barricade/play";

/** The optimistic-feedback ghost: the action submitted at `version`. */
type PendingAction = {
  version: number;
  action: BarricadeAction;
};

/**
 * One cue per accepted action, keyed on what the engine actually did — exactly
 * like free practice, except `mine` comes from the seat that played it.
 */
function playMoveSound(kind: MoveKind, mine: boolean) {
  if (kind === MOVE_KINDS.STEP) playBarricadeStep(mine);
  else playBarricadeJump(kind === MOVE_KINDS.JUMP_DIAGONAL, mine);
}

export default function BarricadeMatchPage() {
  const params = useParams<{ matchId: string }>();
  const router = useRouter();
  const { socket } = useSocket();
  const { user, isLoaded: identityLoaded } = useUser();
  const matchId = params?.matchId;
  const apiMatch = `/api/barricade/match/${matchId}`;
  // The route is readable signed-out (Barricade's whole subtree is a public
  // route pattern, like every other game's), but the snapshot itself is
  // account-gated — so a signed-out tab is told to sign in instead of polling a
  // 401 every 1.8 seconds.
  const signedOut = identityLoaded && !user;

  const [match, setMatch] = useState<any>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [wallMode, setWallMode] = useState(false);
  const [orientation, setOrientation] = useState<Orientation>(ORIENTATIONS[0]);
  const [hovered, setHovered] = useState<WallPlacement | null>(null);
  // `null` while the post-paint legality sweep is still running: the grooves
  // then render neutral, and a click is validated by the engine regardless.
  const [legalWallKeys, setLegalWallKeys] = useState<ReadonlySet<string> | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showForfeitConfirm, setShowForfeitConfirm] = useState(false);
  const [forfeiting, setForfeiting] = useState(false);
  const [cancellingLobby, setCancellingLobby] = useState(false);
  const [showReportModal, setShowReportModal] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const matchRef = useRef<any>(null);
  // The last ply whose sound cue was played, so a re-poll never re-sounds it.
  const soundedPlyRef = useRef<number | null>(null);
  const resultSoundedRef = useRef<string | null>(null);

  useEffect(() => {
    matchRef.current = match;
  }, [match]);

  // The App Router reuses this page instance when only `[matchId]` differs, so
  // every piece of per-match state is reset — otherwise the previous match's
  // position and pending ghost would flash into the new one.
  useEffect(() => {
    setMatch(null);
    setLoadError(null);
    setPending(null);
    setSubmitting(false);
    setWallMode(false);
    setHovered(null);
    setLegalWallKeys(null);
    setNotice(null);
    setShowForfeitConfirm(false);
    setForfeiting(false);
    setShowReportModal(false);
    soundedPlyRef.current = null;
    resultSoundedRef.current = null;
  }, [matchId]);

  // ── Fetching (also the reconnect path) ────────────────────────────────
  const fetchSnapshot = useCallback(
    async (signal?: AbortSignal) => {
      if (!matchId) return;
      if (signedOut) {
        setLoadError("Sign in to play this Barricade match.");
        return;
      }
      try {
        const res = await fetch(apiMatch, { cache: "no-store", signal });
        if (signal?.aborted) return;
        const data = await res.json().catch(() => null);
        if (signal?.aborted) return;
        if (!res.ok || !data?.success) {
          setLoadError(data?.error || "Unable to load this match");
          return;
        }
        // Several refreshes can be in flight at once; `version` is monotonic and
        // a same-version terminal snapshot can never be rolled back.
        setMatch((prev: any) =>
          isIncomingSnapshotStale(prev, data.data) ? prev : data.data,
        );
        // The optimistic ghost survives until the server has moved past the
        // version it was submitted against.
        setPending((prev) =>
          prev && Number(data.data?.version) > prev.version ? null : prev,
        );
        setLoadError(null);
      } catch (error: any) {
        if (error?.name === "AbortError") return;
      }
    },
    [apiMatch, matchId, signedOut],
  );

  const refresh = useCallback(() => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    void fetchSnapshot(controller.signal);
  }, [fetchSnapshot]);

  useEffect(() => {
    if (!matchId) return undefined;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = () => {
      if (cancelled) return;
      // A hidden tab cannot play: issue no snapshot reads while hidden, and
      // resume with one immediate catch-up when it is visible again.
      if (typeof document !== "undefined" && document.hidden) return;
      refresh();
      const idle =
        matchRef.current?.status === "finished" ||
        matchRef.current?.status === "cancelled";
      timer = setTimeout(tick, idle ? IDLE_POLL_MS : ACTIVE_POLL_MS);
    };
    tick();

    const onVisibilityChange = () => {
      if (cancelled) return;
      if (document.hidden) {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
      } else if (timer === null) {
        tick();
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      abortRef.current?.abort();
    };
  }, [matchId, refresh]);

  // ── Realtime sync ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!socket || !matchId) return undefined;
    const roomId = barricadeMatchRoom(matchId);
    const join = () => socket.emit("join_room", { roomId });
    join();
    // Socket.IO does not restore room membership across a reconnect, so re-join
    // on every connect — that is also what cancels the server's
    // disconnect-forfeit timer for this seat.
    socket.on("connect", join);

    const onUpdate = () => refresh();
    socket.on(BARRICADE_MATCH_UPDATED, onUpdate);

    return () => {
      socket.off("connect", join);
      socket.off(BARRICADE_MATCH_UPDATED, onUpdate);
      socket.emit("leave_room", { roomId });
    };
  }, [socket, matchId, refresh]);

  // ── Derived view model (all from the snapshot) ────────────────────────
  const viewerSeat: Seat | null = match?.viewerSeat ?? null;
  const opponentSeat: Seat | null = match?.opponentSeat ?? null;
  const state: BarricadeState | null = match?.gameState ?? null;
  const status = String(match?.status ?? "");
  const finished = status === "finished";
  const cancelled = status === "cancelled";
  const waiting = status === "waiting";
  const matchOver = finished || cancelled || (state ? isMatchFinished(state) : false);
  const isViewerTurn = Boolean(match?.isViewerTurn) && status === "playing";

  const players = match?.players ?? null;
  const viewerIdentity = viewerSeat ? players?.[viewerSeat] ?? null : null;
  const opponentIdentity = opponentSeat ? players?.[opponentSeat] ?? null : null;

  const viewerWalls = wallsFor(match?.wallsRemaining, viewerSeat);
  const opponentWalls = wallsFor(match?.wallsRemaining, opponentSeat);

  const opponentName =
    opponentIdentity?.name ||
    (opponentSeat ? seatLabel(opponentSeat, viewerSeat) : "Opponent");
  const opponentId =
    opponentSeat === "player1" ? match?.player1Id : match?.player2Id;

  const moves = Array.isArray(match?.moves) ? match.moves : [];
  const outcome = outcomeFor({
    result: match?.result,
    winnerId: match?.winnerId,
    viewerSeat,
    userId: user?.id,
  });

  // The server's own gate, narrowed only by "a request is in flight" and "the
  // match is over" — this page never invents a third condition.
  const canPlay = Boolean(state) && isViewerTurn && !matchOver && !submitting;

  // The engine's move menu for the seat that owns the turn. Purely an
  // affordance: the same generator runs again inside the store's transaction
  // before anything is written.
  const legalMoveList = useMemo(
    () => (state && state.status === "playing" ? legalMoves(state, state.turn) : []),
    [state],
  );

  const preview: BarricadePreview | null = useMemo(() => {
    if (!hovered || !state || !viewerSeat) return null;
    const verdict = classifyWall(state, viewerSeat, hovered);
    if (verdict.ok === false) return { wall: hovered, ok: false, message: verdict.message };
    return { wall: hovered, ok: true, message: "Tap to place this barricade." };
  }, [hovered, state, viewerSeat]);

  // The full legality sweep over every groove costs one breadth-first search per
  // candidate, so it runs AFTER paint. It is gated on the viewer actually being
  // able to act, so an opponent's turn never pays for it.
  useEffect(() => {
    if (!wallMode || !canPlay || !state || !viewerSeat) {
      setLegalWallKeys(null);
      return undefined;
    }
    setLegalWallKeys(null);
    let cancelledLocal = false;
    const handle = setTimeout(() => {
      if (cancelledLocal) return;
      setLegalWallKeys(
        new Set(legalWalls(state, viewerSeat).map((action) => wallKey(action.wall))),
      );
    }, 0);
    return () => {
      cancelledLocal = true;
      clearTimeout(handle);
    };
  }, [wallMode, canPlay, state, viewerSeat]);

  // Leave wall mode the moment it stops being the viewer's turn (a move landed,
  // the opponent resigned, the player has no barricades left).
  useEffect(() => {
    if (!canPlay || viewerWalls <= 0) {
      setWallMode(false);
      setHovered(null);
    }
  }, [canPlay, viewerWalls]);

  // ── Sound cues, keyed on the server's own ply ─────────────────────────
  useEffect(() => {
    const ply = Number(state?.ply);
    if (!Number.isInteger(ply)) return;
    if (soundedPlyRef.current === null) {
      // First snapshot (including a reconnect): record it silently, so a
      // reconnect does not replay the whole match's sounds.
      soundedPlyRef.current = ply;
      return;
    }
    if (ply <= soundedPlyRef.current) return;
    soundedPlyRef.current = ply;
    const last = state?.lastAction;
    if (!last) return;
    const mine = last.seat === match?.viewerSeat;
    if (last.action.type === "move") playMoveSound(last.action.kind, mine);
    else playBarricadeWall(mine);
  }, [state?.ply, state?.lastAction, match?.viewerSeat, state]);

  useEffect(() => {
    if (!matchOver) return;
    const key = `${status}:${match?.result ?? ""}:${match?.resultReason ?? ""}`;
    if (resultSoundedRef.current === key) return;
    resultSoundedRef.current = key;
    if (cancelled) return;
    if (outcome === "win") playBarricadeWin();
    else if (outcome === "loss") playBarricadeLoss();
  }, [matchOver, cancelled, outcome, status, match?.result, match?.resultReason]);

  // ── Actions ───────────────────────────────────────────────────────────
  // Adopt the server's authoritative core state from a POST response (the board,
  // the turn, the reserves, the result) and resync so the GET-only adornments
  // (the seat identities, the move log) are re-derived server-side.
  const adoptAuthoritative = useCallback(
    (snapshot: any) => {
      setMatch((prev: any) => ({ ...(prev ?? {}), ...(snapshot ?? {}) }));
      setPending(null);
      // A bare invalidation nudge: the opponent refetches, and nothing about the
      // match is carried in it.
      socket?.emit(BARRICADE_READY, { matchId });
      refresh();
    },
    [refresh, socket, matchId],
  );

  // The ONLY way an action is ever requested. It re-checks the target against
  // the snapshot the viewer is looking at, so a click on an unreachable square,
  // an occupied square, a refused groove or a click outside the viewer's turn is
  // a no-op here as well as server-side.
  const submitAction = useCallback(
    async (action: BarricadeAction) => {
      const current = matchRef.current;
      if (!current || submitting) return;
      if (String(current.status) !== "playing" || !current.isViewerTurn) {
        setNotice("It is not your turn.");
        return;
      }
      const currentState: BarricadeState | null = current.gameState ?? null;
      const seat: Seat | null = current.viewerSeat ?? null;
      if (!currentState || !seat) return;

      // Ask the engine — the SAME verdict the server will reach. A refusal is
      // explained locally and never sent.
      try {
        applyAction(currentState, seat, action);
      } catch (error: any) {
        setNotice(error?.message || "That turn is not legal here.");
        playBarricadeReject();
        return;
      }

      const expectedVersion = current.version;
      setSubmitting(true);
      setNotice(null);
      setPending({ version: Number(expectedVersion) || 0, action });
      try {
        const res = await fetch(`${apiMatch}/move`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // The whole request. No board, no turn, no winner.
          body: JSON.stringify({ action, expectedVersion }),
        });
        const data = await res.json().catch(() => null);
        if (!res.ok || !data?.success) {
          // Rejected (stale tab, wrong turn, an action the engine refuses, a
          // replayed turn) — drop the ghost and resync rather than guessing.
          setPending(null);
          setNotice(data?.error || "That turn was rejected.");
          playBarricadeReject();
          refresh();
          return;
        }
        setHovered(null);
        adoptAuthoritative(data.data.match);
      } catch {
        setPending(null);
        setNotice("The action could not be sent — retrying.");
        refresh();
      } finally {
        setSubmitting(false);
      }
    },
    [adoptAuthoritative, apiMatch, refresh, submitting],
  );

  const handleMove = useCallback(
    (to: Position) => {
      if (!canPlay || wallMode) return;
      void submitAction({ type: "move", to });
    },
    [canPlay, wallMode, submitAction],
  );

  const handlePlaceWall = useCallback(
    (wall: WallPlacement) => {
      if (!canPlay || !state || !viewerSeat) return;
      // Explain a refused placement instead of sending it.
      const verdict = classifyWall(state, viewerSeat, wall);
      if (verdict.ok === false) {
        setNotice(verdict.message);
        playBarricadeReject();
        return;
      }
      void submitAction({ type: "wall", wall });
    },
    [canPlay, state, viewerSeat, submitAction],
  );

  const forfeit = useCallback(async () => {
    if (!match || forfeiting) return;
    setShowForfeitConfirm(false);
    setForfeiting(true);
    try {
      const res = await fetch(`${apiMatch}/forfeit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const data = await res.json().catch(() => null);
      if (data?.success) adoptAuthoritative(data.data.match);
      else refresh();
    } finally {
      setForfeiting(false);
    }
  }, [match, forfeiting, apiMatch, refresh, adoptAuthoritative]);

  const cancelLobby = useCallback(async () => {
    setShowForfeitConfirm(false);
    setCancellingLobby(true);
    try {
      await fetch(`${apiMatch}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      refresh();
    } finally {
      setCancellingLobby(false);
    }
  }, [apiMatch, refresh]);

  const { incomingEmote, myEmote, sendEmote } = useGameEmotes({
    socket,
    roomId: matchId ? barricadeMatchRoom(matchId) : null,
    eventName: "barricade:emote",
    selfId: viewerSeat,
  });

  const turnCopy = turnLabel({
    status,
    isViewerTurn,
    viewerSeat,
    opponentName,
  });

  // ── Render ────────────────────────────────────────────────────────────
  if (!match && !loadError) {
    return <MatchLoading label="Loading your Barricade match…" currentPath={LOBBY_PATH} />;
  }

  if (!match && loadError) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-gradient-to-b from-[#0d1226] to-[#04060f] px-6 text-center text-white">
        <IconAlertTriangle className="h-8 w-8 text-amber-300" />
        <p className="text-sm text-white/80">{loadError}</p>
        <button
          onClick={() => router.push(LOBBY_PATH)}
          className="rounded-xl bg-amber-500 px-4 py-2 text-sm font-bold text-black"
        >
          Back to Barricade
        </button>
      </div>
    );
  }

  const showBoard = Boolean(state) && !waiting && !cancelled;
  const stage = state;

  const seatCard = (seat: Seat) => {
    const identity = seat === viewerSeat ? viewerIdentity : opponentIdentity;
    const isViewer = seat === viewerSeat;
    const active = Boolean(stage) && stage?.turn === seat && !matchOver;
    const name = identity?.name || seatLabel(seat, viewerSeat);
    const walls = wallsFor(match?.wallsRemaining, seat);
    const emote = isViewer ? myEmote : incomingEmote;
    return (
      <div
        key={seat}
        className={`barricade-seat ${active ? "is-active" : ""}`}
        data-testid={`barricade-seat-${isViewer ? "viewer" : "opponent"}`}
        data-active={active ? "true" : "false"}
      >
        <span className="barricade-seat-avatar">
          <SeatAvatar
            iconKey={identity?.iconKey ?? null}
            profileFrame={identity?.profileFrame ?? null}
            name={name}
            isAi={false}
            isGuest={Boolean(identity?.isGuest)}
            size="h-9 w-9"
          />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-bold text-white">
            {name}
            {isViewer ? <span className="ml-1 text-cyan-300">· you</span> : null}
          </span>
          <span className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-white/50">
            <IconWall size={12} aria-hidden="true" />
            <span
              data-testid={`barricade-walls-${isViewer ? "viewer" : "opponent"}`}
            >
              {walls}
            </span>{" "}
            barricades left
            <span
              aria-hidden="true"
              className="ml-1 inline-block h-2 w-2 rounded-full"
              style={{ backgroundColor: seatColor(seat) }}
            />
          </span>
        </span>
        <EmoteBubble emote={emote} side={isViewer ? "mine" : "incoming"} />
        {active ? (
          <span className="barricade-turn-badge" data-testid="barricade-turn-badge">
            to move
          </span>
        ) : null}
      </div>
    );
  };

  return (
    <>
      {waiting && (
        <MatchWaiting
          state="waiting"
          gameName="Barricade"
          icon={<IconWall className="h-8 w-8 text-cyan-300" />}
          subtitle="Waiting for an opponent to join your Barricade table…"
          seats={[
            {
              label: "You",
              name: viewerIdentity?.name || "You",
              occupied: true,
              wager: "Free",
            },
            { label: "Opponent", occupied: false },
          ]}
          onCancel={viewerSeat === "player1" ? cancelLobby : null}
          cancelLabel="Cancel match"
          cancelling={cancellingLobby}
        />
      )}

      <GameSessionHost autoStart={status === "playing"} autoStop={matchOver} gameLabel="barricade">
        <div
          data-testid="barricade-match"
          data-status={status}
          data-turn={stage?.turn ?? ""}
          className="min-h-screen overflow-x-clip bg-gradient-to-br from-[#001933] to-[#000d1a] px-3 pb-24 pt-20 text-white sm:px-6 md:pb-8"
        >
          <div className="mx-auto max-w-6xl">
            {/* ── Header ─────────────────────────────────────────────── */}
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <div>
                <h1 className="logo-text flex items-center gap-2 text-2xl font-black uppercase tracking-[0.08em] text-[#7cefff] drop-shadow-[0_0_16px_rgba(0,229,255,0.45)] sm:text-3xl">
                  <IconWall className="h-7 w-7 text-cyan-300" aria-hidden="true" />
                  Barricade
                </h1>
                <p className="mt-1 flex flex-wrap items-center gap-2 text-xs font-semibold uppercase tracking-widest text-white/55">
                  <span>9×9 · ten barricades each</span>
                  <span className="rounded-full border border-emerald-400/40 bg-emerald-500/15 px-2 py-0.5 text-[10px] font-bold tracking-wider text-emerald-200">
                    Free 1v1
                  </span>
                </p>
              </div>
              <div className="flex items-center gap-2">
                <span
                  data-testid="match-status"
                  className="rounded-full border border-cyan-400/40 bg-cyan-500/10 px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-cyan-200"
                >
                  {statusLabel(status)}
                </span>
                <button
                  onClick={() => router.push(LOBBY_PATH)}
                  className="rounded-lg border border-white/15 bg-white/10 px-3 py-1.5 text-xs font-semibold hover:bg-white/20"
                >
                  Lobby
                </button>
              </div>
            </div>

            {/* The seat cards: who is who, this seat's colour, and BOTH seats'
                remaining barricades — the opponent's reserve is public. */}
            <div className="mb-3 flex flex-col gap-2 sm:flex-row">
              {viewerSeat ? seatCard(viewerSeat) : null}
              {opponentSeat ? (
                seatCard(opponentSeat)
              ) : (
                <div className="barricade-seat" data-testid="barricade-seat-opponent-empty">
                  <span className="barricade-seat-avatar" aria-hidden="true" />
                  <span className="min-w-0 flex-1 text-[13px] font-semibold text-white/60">
                    Waiting for an opponent…
                  </span>
                </div>
              )}
            </div>

            {/* ── Turn / status banner ───────────────────────────────── */}
            <p
              className="barricade-status"
              role="status"
              aria-live="polite"
              data-testid="barricade-turn-status"
            >
              {turnCopy}
            </p>

            {!waiting && !cancelled ? (
              <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
                {/* ── Board column ─────────────────────────────────── */}
                <div className="rounded-2xl border border-cyan-400/20 bg-black/40 p-3 shadow-[0_0_30px_rgba(34,211,238,0.10)] sm:p-4">
                  {showBoard && stage ? (
                    <div className="barricade-board-shell">
                      <p className="barricade-goal-bar is-mine" data-testid="barricade-goal-mine">
                        {viewerSeat
                          ? `Your goal — reach any square of row ${goalRowFor(viewerSeat) + 1}`
                          : "Your goal — the far row"}
                      </p>
                      <BarricadeBoard
                        state={stage}
                        mySeat={viewerSeat ?? "player1"}
                        activeSeat={stage.turn}
                        moves={legalMoveList}
                        wallMode={wallMode && canPlay}
                        orientation={orientation}
                        legalWallKeys={legalWallKeys}
                        preview={preview}
                        disabled={!canPlay}
                        onMove={handleMove}
                        onPlaceWall={handlePlaceWall}
                        onHoverWall={setHovered}
                      />
                      <p
                        className="barricade-goal-bar is-theirs"
                        data-testid="barricade-goal-theirs"
                      >
                        {opponentSeat
                          ? `${opponentName}'s goal — row ${goalRowFor(opponentSeat) + 1}`
                          : "Opponent's goal"}
                      </p>
                    </div>
                  ) : (
                    <p className="py-10 text-center text-sm text-white/60">
                      The match is no longer on the board.
                    </p>
                  )}
                </div>

                {/* ── Controls / log column ────────────────────────── */}
                <div className="flex flex-col gap-3">
                  <div className="barricade-controls">
                    <div className="flex gap-2" role="group" aria-label="Turn action">
                      <button
                        type="button"
                        className={`barricade-mode-button ${!wallMode ? "is-active" : ""}`}
                        aria-pressed={!wallMode}
                        data-testid="barricade-mode-move"
                        disabled={!canPlay}
                        onClick={() => {
                          setWallMode(false);
                          setHovered(null);
                        }}
                      >
                        <IconBallpen size={16} aria-hidden="true" /> Move
                      </button>
                      <button
                        type="button"
                        className={`barricade-mode-button ${wallMode ? "is-active" : ""}`}
                        aria-pressed={wallMode}
                        data-testid="barricade-mode-wall"
                        disabled={!canPlay || viewerWalls <= 0}
                        onClick={() => setWallMode(true)}
                      >
                        <IconWall size={16} aria-hidden="true" /> Barricade
                      </button>
                    </div>

                    <div className="flex gap-2" role="group" aria-label="Barricade orientation">
                      <button
                        type="button"
                        className={`barricade-orientation-button ${
                          orientation === ORIENTATIONS[0] ? "is-active" : ""
                        }`}
                        aria-pressed={orientation === ORIENTATIONS[0]}
                        data-testid="barricade-orientation-horizontal"
                        onClick={() => setOrientation(ORIENTATIONS[0])}
                      >
                        <IconArrowsHorizontal size={16} aria-hidden="true" /> Horizontal
                      </button>
                      <button
                        type="button"
                        className={`barricade-orientation-button ${
                          orientation === ORIENTATIONS[1] ? "is-active" : ""
                        }`}
                        aria-pressed={orientation === ORIENTATIONS[1]}
                        data-testid="barricade-orientation-vertical"
                        onClick={() => setOrientation(ORIENTATIONS[1])}
                      >
                        <IconArrowsVertical size={16} aria-hidden="true" /> Vertical
                      </button>
                    </div>

                    <p
                      className={`barricade-notice ${notice || (wallMode && canPlay) ? "is-visible" : ""}`}
                      role="status"
                      aria-live="polite"
                      data-testid="barricade-notice"
                    >
                      {wallMode && canPlay
                        ? preview
                          ? preview.message
                          : notice ?? "Pick a groove for your barricade."
                        : notice ?? ""}
                    </p>

                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        className="barricade-secondary-button"
                        data-testid="barricade-resign"
                        disabled={forfeiting || matchOver || waiting}
                        onClick={() => setShowForfeitConfirm(true)}
                      >
                        <IconFlag size={16} aria-hidden="true" /> Resign
                      </button>
                      <button
                        type="button"
                        className="barricade-secondary-button"
                        data-testid="barricade-report"
                        onClick={() => setShowReportModal(true)}
                      >
                        <IconAlertTriangle size={16} aria-hidden="true" /> Report
                      </button>
                      {waiting ? (
                        <button
                          type="button"
                          className="barricade-secondary-button"
                          data-testid="barricade-cancel"
                          disabled={cancellingLobby}
                          onClick={cancelLobby}
                        >
                          <IconDoorExit size={16} aria-hidden="true" /> Cancel match
                        </button>
                      ) : null}
                    </div>
                  </div>

                  {/* The action log: the SERVER's recorded plies, nothing local. */}
                  <div
                    className="rounded-2xl border border-white/10 bg-white/5 p-3"
                    data-testid="barricade-move-log"
                  >
                    <h2 className="mb-2 text-xs font-bold uppercase tracking-wider text-white/60">
                      Actions played
                    </h2>
                    {moves.length === 0 ? (
                      <p className="text-xs text-white/45">No actions yet.</p>
                    ) : (
                      <ol className="flex flex-col gap-1 text-[11px] text-white/70">
                        {moves
                          .slice(-8)
                          .reverse()
                          .map((row: any) => (
                            <li
                              key={`${row.ply}-${row.createdAt ?? ""}`}
                              className="flex items-start justify-between gap-2"
                            >
                              <span className="text-white/40">#{Number(row.ply) + 1}</span>
                              <span className="flex-1 text-right">
                                <span
                                  className="mr-1 font-semibold"
                                  style={{
                                    color: seatColor(
                                      row.playerId === match?.player1Id
                                        ? "player1"
                                        : "player2",
                                    ),
                                  }}
                                >
                                  {row.playerId === match?.player1Id ? "Blue" : "Purple"}
                                </span>
                                {loggedActionLabel(row)}
                              </span>
                            </li>
                          ))}
                      </ol>
                    )}
                  </div>

                  <EmotePicker onSend={sendEmote} />
                </div>
              </div>
            ) : null}
          </div>

          {/* ── Resign confirmation ─────────────────────────────────── */}
          <AnimatePresence>
            {showForfeitConfirm && (
              <motion.div
                className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                onClick={() => setShowForfeitConfirm(false)}
              >
                <motion.div
                  className="w-full max-w-sm rounded-2xl border border-white/10 bg-[#0b1226] p-5 text-white"
                  initial={{ scale: 0.94, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  exit={{ scale: 0.96, opacity: 0 }}
                  onClick={(event) => event.stopPropagation()}
                >
                  <h2 className="text-lg font-bold">Resign this match?</h2>
                  <p className="mt-2 text-sm text-white/70">
                    Your opponent is awarded the win and the match settles immediately.
                  </p>
                  <div className="mt-5 flex gap-2">
                    <button
                      onClick={() => setShowForfeitConfirm(false)}
                      className="flex-1 rounded-xl bg-white/10 py-2.5 text-sm font-bold hover:bg-white/20"
                    >
                      Keep playing
                    </button>
                    <button
                      data-testid="confirm-forfeit"
                      onClick={forfeit}
                      disabled={forfeiting}
                      className="flex-1 rounded-xl bg-red-500 py-2.5 text-sm font-bold text-black disabled:opacity-60"
                    >
                      {forfeiting ? "Resigning…" : "Resign"}
                    </button>
                  </div>
                </motion.div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* ── Result ──────────────────────────────────────────────── */}
          <PvpResultScreen
            open={finished}
            outcome={outcome ?? "loss"}
            headline={
              outcome === "win"
                ? "You won the race"
                : outcome === "loss"
                  ? "Your opponent won the race"
                  : "Match complete"
            }
            subline={resultReasonLabel(match?.resultReason, outcome)}
            gameName="Barricade"
            durationSeconds={durationSeconds(match?.startedAt, match?.endedAt)}
            opponent={{
              name: opponentName,
              iconKey: opponentIdentity?.iconKey ?? null,
              profileFrame: opponentIdentity?.profileFrame ?? null,
            }}
            summary={[
              { label: "Result", value: outcome === "win" ? "Win" : "Loss" },
              { label: "Actions played", value: String(Number(match?.ply) || 0) },
              { label: "Your barricades left", value: String(viewerWalls) },
              { label: "Opponent's barricades left", value: String(opponentWalls) },
            ]}
            details={[
              { label: "Match ID", value: String(matchId) },
              { label: "You played", value: seatName(viewerSeat) },
              {
                label: "Reason",
                value: resultReasonLabel(match?.resultReason, outcome),
              },
              ...moves.map((row: any) => ({
                label: `Action ${Number(row.ply) + 1}`,
                value: `${row.playerId === match?.player1Id ? "Blue" : "Purple"} — ${loggedActionLabel(row)}`,
              })),
            ]}
            playAgain={{
              label: "New match",
              onClick: () => router.push(LOBBY_PATH),
            }}
            onReturnToLobby={() => router.push("/casino")}
          />

          {/* ── Report ──────────────────────────────────────────────── */}
          <ReportModal
            isOpen={showReportModal}
            onClose={() => setShowReportModal(false)}
            reportedPlayerName={opponentName}
            gameType="barricade"
            onSubmit={async (reason: string, details: string) => {
              try {
                await fetch("/api/reports/submit", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    reportedClerkId: opponentId,
                    reason,
                    details,
                    gameType: "barricade",
                  }),
                });
              } catch {
                // best-effort
              }
              setShowReportModal(false);
            }}
          />
        </div>
      </GameSessionHost>
    </>
  );
}
