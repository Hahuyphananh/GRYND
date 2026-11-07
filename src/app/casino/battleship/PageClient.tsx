"use client";

// src/app/casino/battleship/PageClient.tsx
//
// The Battleship screen: matchmaking → fleet placement → simultaneous combat.
//
// AUTHORITY: the server owns everything. This page sends three things and nothing
// else — "find me a match", a fleet layout, and ONE coordinate — and renders the
// snapshot it gets back. It never decides a hit, a sunk ship, a round, a result
// or a winner.
//
// TRANSPORT: a 1.5 s snapshot poll while the tab is visible, plus the match room's
// `lobby:updated` / combat events as an accelerator. Every event only says
// "refetch"; the state always comes from `GET /api/battleship/match/<id>`. On a
// reconnect the socket re-joins the room and the snapshot is re-read, so a
// refresh mid-round lands exactly back on the locked/awaiting state.

import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { IconAnchor } from "@tabler/icons-react";

import GameSessionHost from "../../../components/GameSessionHost";
import AiDifficultyPicker from "../../../components/lobby/AiDifficultyPicker";
// The SHARED casino lobby. Every other 1v1 game mounts this chrome, so the
// Battleship lobby (hero, action row, "The match" panel, open-lobby list) is the
// same product rather than a bespoke screen.
import { PvpLobby } from "../../../components/lobby/PvpLobby";
import MatchWaiting from "../../../components/lobby/MatchWaiting";
import BattlePreview from "../../../components/games/battleship/BattlePreview";
import FleetPlacement from "../../../components/games/battleship/FleetPlacement";
import {
  AI_DIFFICULTY_LABELS,
  DEFAULT_AI_DIFFICULTY,
  readStoredAiDifficulty,
  type AiDifficulty,
} from "../../../lib/aiDifficulty";
import { useSocket } from "../../../context/SocketProvider";
import { useSocketAwarePoll } from "../../../hooks/useVisiblePoll";
import {
  BATTLESHIP_EVENTS,
  BATTLESHIP_LOBBY_ROOM,
  BATTLESHIP_MATCH_UPDATED,
  battleshipMatchRoom,
} from "../../../lib/battleship/rooms";
import { formatCoordinate } from "../../../lib/battleship/rules";
import type { Coordinate, Fleet } from "../../../lib/battleship/types";
import {
  isMatchOver,
  opponentNameFor,
  type MatchSnapshot,
  type ResolvedRound,
} from "../../../lib/battleship/view";

const POLL_MS = 1500;
const REVEAL_MS = 1200;

/** One row of GET /api/battleship/available. */
type LobbyRow = {
  matchId: string;
  player1Id: string;
  phase: string;
  createdAt?: string;
};

/**
 * "How to Play" copy, in the shared lobby's modal. It is the same affordance
 * every other game lobby offers, and it is the only place the rules are
 * restated outside the game itself.
 */
const RULES = {
  title: "How to Play",
  sections: [
    {
      heading: "Place your fleet",
      body: "Six ships — carrier (5), battleship (4), cruiser (3), submarine (3), frigate (3) and destroyer (2) — go on your own 14×10 board. Ships may touch, but they can never share a cell. You have 60 seconds; the clock confirms a valid layout for you if it runs out.",
    },
    {
      heading: "One shot each round",
      body: "Pick any square you have not fired at. Your shot is LOCKED when you submit it — you cannot move it, and your opponent never sees the square before the round resolves.",
    },
    {
      heading: "Both shots resolve together",
      body: "The server judges the round's two shots against the same pre-round board. A hit, a miss or a sunk ship is the server's answer, never the browser's. Sink all six enemy ships to win.",
    },
    {
      heading: "Ranked or free practice",
      body: "Ranked duels are free to play — no stake, no escrow, no payout — and move your Elo and trophies. Practice against the AI is unrated: nothing is at stake and no record changes.",
    },
  ],
};

export default function BattleshipPageClient() {
  const { isLoaded, isSignedIn } = useAuth();
  const { socket } = useSocket();

  const [matchId, setMatchId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<MatchSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // Practice vs the built-in bot: free and unrated. The tier is the SHARED
  // preference (`grynd_ai_difficulty:battleship`), read after mount so SSR and
  // the first client render agree.
  const [practice, setPractice] = useState(false);
  const [difficulty, setDifficulty] = useState<AiDifficulty>(DEFAULT_AI_DIFFICULTY);
  const [practiceNotice, setPracticeNotice] = useState<string | null>(null);
  const [reveal, setReveal] = useState<{ round: number; coordinates: string[] } | null>(null);
  // Practice keeps its own in-flight flag so starting a match against the bot
  // does not read as "searching for an opponent" in the shared lobby.
  const [aiBusy, setAiBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [resigning, setResigning] = useState(false);
  const [lobbies, setLobbies] = useState<LobbyRow[]>([]);
  const [lobbiesLoading, setLobbiesLoading] = useState(true);
  const [myOpenId, setMyOpenId] = useState<string | null>(null);

  useEffect(() => {
    setDifficulty(readStoredAiDifficulty("battleship"));
  }, []);

  // ── Open lobbies (the shared lobby's list) ─────────────────────────────
  const fetchLobbies = useCallback(async () => {
    try {
      const res = await fetch("/api/battleship/available", { cache: "no-store" });
      const data = await res.json().catch(() => null);
      if (data?.success) {
        setLobbies(Array.isArray(data.data) ? (data.data as LobbyRow[]) : []);
        setMyOpenId(data.myOpenMatchId ?? null);
      }
    } catch {
      // silent — the poll retries
    } finally {
      setLobbiesLoading(false);
    }
  }, []);

  // One read on mount, then the socket-aware, visibility-gated cadence, with the
  // `lobby:battleship` room pushing an instant refresh on top. Gated on being
  // signed in: the list is account-gated, so an anonymous tab must not poll a 401.
  useSocketAwarePoll(fetchLobbies, socket, Boolean(isSignedIn));

  useEffect(() => {
    if (!socket) return undefined;
    const refresh = () => void fetchLobbies();
    socket.emit("join_room", { roomId: BATTLESHIP_LOBBY_ROOM });
    socket.on(BATTLESHIP_MATCH_UPDATED, refresh);
    return () => {
      socket.emit("leave_room", { roomId: BATTLESHIP_LOBBY_ROOM });
      socket.off(BATTLESHIP_MATCH_UPDATED, refresh);
    };
  }, [socket, fetchLobbies]);

  // With no account there is no poll to finish, so the list must not sit on its
  // loading state forever.
  useEffect(() => {
    if (isSignedIn === false) setLobbiesLoading(false);
  }, [isSignedIn]);

  const pokeLobby = useCallback(() => {
    socket?.emit("room_event", {
      roomId: BATTLESHIP_LOBBY_ROOM,
      event: BATTLESHIP_MATCH_UPDATED,
    });
  }, [socket]);

  // The start banner is feedback, not state: it clears itself.
  useEffect(() => {
    if (!practiceNotice) return undefined;
    const timer = setTimeout(() => setPracticeNotice(null), 4000);
    return () => clearTimeout(timer);
  }, [practiceNotice]);

  const abortRef = useRef<AbortController | null>(null);
  const revealTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const revealedRound = useRef<number | null>(null);

  /** Flash the two attacked cells together, once per resolved round. */
  const showReveal = useCallback((resolved: ResolvedRound | null | undefined) => {
    if (!resolved || !resolved.attacks?.player1 || !resolved.attacks?.player2) return;
    if (revealedRound.current !== null && resolved.round <= revealedRound.current) return;
    revealedRound.current = resolved.round;
    setReveal({
      round: resolved.round,
      coordinates: [resolved.attacks.player1.coordinate, resolved.attacks.player2.coordinate],
    });
    if (revealTimer.current) clearTimeout(revealTimer.current);
    revealTimer.current = setTimeout(() => setReveal(null), REVEAL_MS);
  }, []);

  useEffect(
    () => () => {
      if (revealTimer.current) clearTimeout(revealTimer.current);
    },
    [],
  );

  // ── Snapshot (also the reconnect path) ────────────────────────────────
  /** Practice matches drive the practice routes; ranked keeps the ranked ones. */
  const practiceMode = practice || snapshot?.isAi === true;

  const refresh = useCallback(async (): Promise<MatchSnapshot | null> => {
    if (!matchId) return null;
    const base = practiceMode
      ? `/api/battleship/practice/${matchId}`
      : `/api/battleship/match/${matchId}`;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const res = await fetch(base, {
        cache: "no-store",
        signal: controller.signal,
      });
      const data = await res.json().catch(() => null);
      if (controller.signal.aborted) return null;
      if (!res.ok || !data?.success) {
        setNotice(String(data?.error || "Unable to load this match"));
        return null;
      }
      setSnapshot(data.data as MatchSnapshot);
      setNotice(null);
      return data.data as MatchSnapshot;
    } catch (error) {
      if ((error as Error)?.name === "AbortError") return null;
      return null;
    }
  }, [matchId, practiceMode]);

  useEffect(() => {
    if (!matchId) return undefined;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      if (cancelled) return;
      // A hidden tab is not playing: skip the read but keep the schedule.
      if (typeof document === "undefined" || !document.hidden) await refresh();
      timer = setTimeout(tick, POLL_MS);
    };
    void tick();

    const onVisible = () => {
      if (!cancelled && (typeof document === "undefined" || !document.hidden)) void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
      abortRef.current?.abort();
    };
  }, [matchId, refresh]);

  // ── Realtime: invalidation only, scoped to this match's room ──────────
  useEffect(() => {
    if (!socket || !matchId) return undefined;
    const roomId = battleshipMatchRoom(matchId);
    const join = () => socket.emit("join_room", { roomId });
    join();
    // Socket.IO does not restore membership across a reconnect.
    socket.on("connect", join);

    const onUpdate = () => {
      void refresh();
    };
    const onResolved = (payload: any) => {
      showReveal(payload as ResolvedRound);
      void refresh();
    };

    socket.on(BATTLESHIP_MATCH_UPDATED, onUpdate);
    socket.on(BATTLESHIP_EVENTS.ATTACK_LOCKED, onUpdate);
    socket.on(BATTLESHIP_EVENTS.OPPONENT_WAITING, onUpdate);
    socket.on(BATTLESHIP_EVENTS.ROUND_RESOLVED, onResolved);
    socket.on(BATTLESHIP_EVENTS.ROUND_STARTED, onUpdate);
    socket.on(BATTLESHIP_EVENTS.SHIP_SUNK, onUpdate);
    socket.on(BATTLESHIP_EVENTS.MATCH_FINISHED, onUpdate);

    return () => {
      socket.off("connect", join);
      socket.off(BATTLESHIP_MATCH_UPDATED, onUpdate);
      socket.off(BATTLESHIP_EVENTS.ATTACK_LOCKED, onUpdate);
      socket.off(BATTLESHIP_EVENTS.OPPONENT_WAITING, onUpdate);
      socket.off(BATTLESHIP_EVENTS.ROUND_RESOLVED, onResolved);
      socket.off(BATTLESHIP_EVENTS.ROUND_STARTED, onUpdate);
      socket.off(BATTLESHIP_EVENTS.SHIP_SUNK, onUpdate);
      socket.off(BATTLESHIP_EVENTS.MATCH_FINISHED, onUpdate);
      socket.emit("leave_room", { roomId });
    };
  }, [socket, matchId, refresh, showReveal]);

  // ── Actions ───────────────────────────────────────────────────────────
  const joinQueue = useCallback(async () => {
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch("/api/battleship/create-or-join", {
        method: "POST",
        cache: "no-store",
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) {
        setNotice(String(data?.error || "Unable to find a match"));
        return;
      }
      setMatchId(String(data.data.matchId));
      setSnapshot((data.data.match ?? null) as MatchSnapshot | null);
      // Tell the other open lobbies (and this tab's list) that a seat changed.
      pokeLobby();
      void fetchLobbies();
    } catch {
      setNotice("Network error — try again");
    } finally {
      setBusy(false);
    }
  }, [fetchLobbies, pokeLobby]);

  /** Free practice entry: the server validates the tier, seats the bot and deals its fleet. */
  const startPractice = useCallback(
    async (tier?: AiDifficulty) => {
      setAiBusy(true);
      setNotice(null);
      try {
        const res = await fetch("/api/battleship/create-ai", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ difficulty: tier ?? difficulty }),
        });
        const data = await res.json().catch(() => null);
        if (!res.ok || !data?.success) {
          setNotice(String(data?.error || "Unable to start a practice match"));
          return;
        }
        setPractice(true);
        setMatchId(String(data.data.matchId));
        setSnapshot((data.data.match ?? null) as MatchSnapshot | null);
        setReveal(null);
        revealedRound.current = null;
        setPracticeNotice(
          `Practice started · ${AI_DIFFICULTY_LABELS[(data.data.aiDifficulty ?? difficulty) as AiDifficulty] ?? difficulty} AI`,
        );
      } catch {
        setNotice("Network error — try again");
      } finally {
        setAiBusy(false);
      }
    },
    [difficulty],
  );

  const submitFleet = useCallback(
    async (fleet: Fleet) => {
      if (!matchId) return;
      setBusy(true);
      setNotice(null);
      try {
        const res = await fetch(
          practiceMode
            ? `/api/battleship/practice/${matchId}/fleet`
            : `/api/battleship/match/${matchId}/fleet`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ships: fleet.ships }),
          },
        );
        const data = await res.json().catch(() => null);
        if (!res.ok || !data?.success) {
          setNotice(String(data?.error || "Your fleet was refused"));
          return;
        }
        setSnapshot(data.data as MatchSnapshot);
      } catch {
        setNotice("Network error — try again");
      } finally {
        setBusy(false);
      }
    },
    [matchId, practiceMode],
  );

  const submitAttack = useCallback(
    async (coordinate: Coordinate) => {
      if (!matchId || busy) return;
      setBusy(true);
      setNotice(null);
      try {
        // THE BODY IS ONE COORDINATE. Never a result, a ship, a round or a winner.
        const res = await fetch(
          practiceMode
            ? `/api/battleship/practice/${matchId}/attack`
            : `/api/battleship/match/${matchId}/attack`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ coordinate: formatCoordinate(coordinate) }),
          },
        );
        const data = await res.json().catch(() => null);
        if (!res.ok || !data?.success) {
          setNotice(String(data?.error || "That shot was refused"));
          return;
        }
        setSnapshot(data.data as MatchSnapshot);
        if (data.data?.resolved) showReveal(data.data.resolved as ResolvedRound);
      } catch {
        setNotice("Network error — try again");
      } finally {
        setBusy(false);
      }
    },
    [busy, matchId, practiceMode, showReveal],
  );

  const cancelLobby = useCallback(
    async (targetId?: string) => {
      const id = targetId ?? matchId;
      if (!id || cancelling) return;
      // Its own flag, not the lobby's `busy`: cancelling must not flash the
      // "Searching for a match…" takeover over the waiting screen.
      setCancelling(true);
      try {
        await fetch(`/api/battleship/match/${id}/cancel`, { method: "POST" });
        setMatchId(null);
        setSnapshot(null);
        setReveal(null);
        pokeLobby();
        await fetchLobbies();
      } finally {
        setCancelling(false);
      }
    },
    [cancelling, fetchLobbies, matchId, pokeLobby],
  );

  const resign = useCallback(async () => {
    // Practice leaves through its own exit; only a live ranked match can be
    // resigned, and the opponent is awarded the win by the server.
    if (!matchId || practiceMode || resigning) return;
    const confirmed =
      typeof window === "undefined" ||
      window.confirm("Resign this match? Your opponent will be awarded the win.");
    if (!confirmed) return;

    setResigning(true);
    setNotice(null);
    try {
      const res = await fetch(`/api/battleship/match/${matchId}/resign`, {
        method: "POST",
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) {
        setNotice(String(data?.error || "Unable to resign this match"));
        return;
      }
      await refresh();
    } catch {
      setNotice("Network error — could not resign.");
    } finally {
      setResigning(false);
    }
  }, [matchId, practiceMode, refresh, resigning]);

  const leave = useCallback(() => {
    setMatchId(null);
    setSnapshot(null);
    setReveal(null);
    setNotice(null);
    setPractice(false);
    setPracticeNotice(null);
    revealedRound.current = null;
    // Back on the shared lobby: re-read the list so the player's own open
    // lobby (if any) offers Resume straight away.
    void fetchLobbies();
  }, [fetchLobbies]);

  // ── Render ────────────────────────────────────────────────────────────
  const phase = snapshot?.phase ?? null;
  const view = snapshot?.combat ?? null;
  const over = isMatchOver(phase);
  const finishedLabel = snapshot
    ? snapshot.result === "draw"
      ? "Draw"
      : snapshot.result === snapshot.you.seat
        ? "Victory"
        : "Defeat"
    : "Match over";

  let body: React.ReactNode = null;

  if (!isLoaded) {
    body = (
      <p data-testid="page-loading" className="text-[11px] text-white/45">
        Loading your session…
      </p>
    );
  } else if (!snapshot) {
    body = (
      <p data-testid="match-loading" className="text-[11px] text-white/45">
        Joining the match…
      </p>
    );
  } else if (phase === "placement") {
    body = snapshot.fleet ? (
      <div
        data-testid="fleet-confirmed"
        className="rounded-2xl border border-white/10 bg-[#061229]/70 p-6 text-center"
      >
        <p className="text-sm font-black uppercase tracking-[0.18em] text-[#ffec08]">
          Fleet confirmed
        </p>
        <p className="mt-2 text-[11px] text-white/50">
          Waiting for your opponent to deploy. Combat opens when both fleets are validated.
        </p>
        {notice ? (
          <p data-testid="page-notice" className="mt-3 text-[11px] text-red-300">
            {notice}
          </p>
        ) : null}
      </div>
    ) : (
      <>
        {practiceMode ? (
          <p data-testid="practice-difficulty" className="mb-3 text-center text-[10px] font-black uppercase tracking-wider text-cyan-300/80">
            Practice vs {AI_DIFFICULTY_LABELS[(snapshot.aiDifficulty ?? difficulty) as AiDifficulty] ?? difficulty} AI · unrated
          </p>
        ) : null}
        <FleetPlacement onFleetConfirmed={(fleet) => void submitFleet(fleet)} />
        {notice ? (
          <p data-testid="page-notice" className="mt-3 text-[11px] text-red-300">
            {notice}
          </p>
        ) : null}
      </>
    );
  } else if (phase === "cancelled") {
    body = (
      <div
        data-testid="match-cancelled"
        className="rounded-2xl border border-white/10 bg-[#061229]/70 p-6 text-center"
      >
        <p className="text-sm font-black uppercase tracking-[0.18em] text-white">Match cancelled</p>
        <button
          type="button"
          onClick={leave}
          className="mt-4 rounded-lg border-b-4 border-[#b7a800] bg-[#ffec08] px-4 py-2 text-[11px] font-black uppercase tracking-wider text-[#0a1200]"
        >
          Back to lobby
        </button>
      </div>
    );
  } else if (view && (phase === "combat" || over)) {
    body = (
      <BattlePreview
        view={view}
        round={snapshot.round}
        roundDeadline={snapshot.deadlines.round}
        locked={Boolean(snapshot.pending?.youLocked)}
        lockedCoordinate={snapshot.pending?.yourCoordinate ?? null}
        opponentLocked={Boolean(snapshot.pending?.opponentLocked)}
        busy={busy}
        error={notice}
        opponentName={opponentNameFor(snapshot)}
        result={over ? snapshot.result : null}
        matchId={matchId}
        seat={snapshot.you.seat}
        reveal={reveal}
        isAi={practiceMode}
        aiDifficulty={(snapshot.aiDifficulty ?? (practiceMode ? difficulty : null)) as string | null}
        onRestart={() => void startPractice()}
        onAttack={(coordinate) => void submitAttack(coordinate)}
        onLeave={leave}
      />
    );
  } else if (over) {
    // A resignation can land during placement, before both fleets produce a
    // combat view. The match is still final, so show its result rather than a
    // loading line that would never resolve.
    body = (
      <div
        data-testid="match-finished"
        className="rounded-2xl border border-white/10 bg-[#061229]/70 p-6 text-center"
      >
        <p className="text-[10px] font-black uppercase tracking-[0.3em] text-[#ffec08]/70">
          Battleship
        </p>
        <p className="mt-2 text-2xl font-black uppercase tracking-wide text-white">
          {finishedLabel}
        </p>
        <p className="mt-2 text-[11px] text-white/50">This match is over.</p>
        <button
          type="button"
          onClick={leave}
          className="mt-4 rounded-lg border border-white/20 px-4 py-2 text-[10px] font-black uppercase tracking-wider text-white/70"
        >
          Back to lobby
        </button>
      </div>
    );
  } else {
    body = (
      <p data-testid="page-loading" className="text-[11px] text-white/45">
        Syncing the match…
      </p>
    );
  }

  // The pre-match screen IS the shared casino lobby (hero → action row → facts
  // panel → open lobbies), so Battleship reads exactly like every other 1v1
  // game. The arena below it (placement, combat) keeps its own layout.
  //
  // A WAITING lobby is still pre-match: the lobby chrome stays up and the shared
  // full-screen takeover sits over it, exactly as Dominoes and Hillstrike do. A
  // fresh match with no snapshot yet is pre-match too, so resuming a lobby never
  // flashes an arena placeholder.
  const showLobby = isLoaded && (!matchId || phase === "waiting" || (!snapshot && !practice));
  const myLobbyName = snapshot ? (snapshot.players?.[snapshot.you.seat]?.name ?? null) : null;

  return (
    // Presence + "recently played" come from the SHARED host, driven by the
    // match's own state: an open lobby is not a game, and a finished match stops
    // counting immediately. Practice matches count too — a player practising is
    // still playing Battleship.
    <GameSessionHost
      autoStart={Boolean(matchId) && !over}
      autoStop={over}
      gameLabel="battleship"
    >
    {showLobby ? (
    <main data-testid="battleship-page" className="min-h-screen bg-[#030817] text-white">
      <div className="mx-auto w-full max-w-6xl px-3 py-5 sm:px-6 sm:py-8">
        <PvpLobby
          title="Battleship"
          subtitle="A free 1v1 naval duel: two hidden 14×10 boards, one simultaneous shot each round, and every hit resolved by the server."
          icon={
            <IconAnchor className="h-9 w-9 flex-shrink-0 text-cyan-300 drop-shadow-[0_0_12px_rgba(34,211,238,0.55)] sm:h-10 sm:w-10" />
          }
          rulesKey="battleship"
          rules={RULES}
          waitingSubtitle="Your fleet is ready to place. The duel starts the moment an opponent takes the other seat."
          busy={busy}
          onPlay={() => void joinQueue()}
          playLabel="Find a Match"
          playBusyLabel="Searching…"
          canPlay={Boolean(isSignedIn)}
          // Free practice stays open to a signed-out visitor: the create-AI route
          // mints a guest seat, and every follow-up route authorises by seat.
          vsAi={{
            label: "Play vs AI",
            badge: "Free",
            disabled: false,
            busy: aiBusy,
            onClick: () => void startPractice(),
          }}
          myOpenId={myOpenId}
          onResume={(id: string) => {
            setPractice(false);
            setSnapshot(null);
            setMatchId(id);
          }}
          onCancel={(id: string) => void cancelLobby(id)}
          cancelling={cancelling}
          lobbies={lobbies}
          lobbiesLoading={lobbiesLoading}
          lobbyEmptyText="No open Battleship lobbies right now. Open one and an opponent will be matched in."
          lobbyKey={(row: LobbyRow) => row.matchId}
          lobbyTitle={(row: LobbyRow) => <>Lobby #{String(row.matchId).slice(0, 8)}</>}
          lobbyMeta={(row: LobbyRow) => (
            <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
              <span>Host: {String(row.player1Id).slice(0, 12)}…</span>
              <span>1v1 · 14×10</span>
              <span className="text-emerald-300">Free</span>
            </span>
          )}
          onJoin={() => void joinQueue()}
          joinLabel="Join"
          onRefresh={() => void fetchLobbies()}
          error={notice}
          children={
            <AiDifficultyPicker
              gameKey="battleship"
              value={difficulty}
              onChange={setDifficulty}
              hint={{
                easy: "Random shots — a good first opponent.",
                normal: "Hunts around its hits and sweeps the open squares.",
                hard: "Weighs every remaining ship placement. Still beatable.",
              }}
            />
          }
        />

        {/* The matchmaking takeover, held open for as long as the server says the
            lobby is still waiting — the same screen every other game mounts. */}
        {matchId && phase === "waiting" ? (
          <MatchWaiting
            state="waiting"
            gameName="Battleship"
            icon={<IconAnchor size={30} className="text-cyan-300" aria-hidden="true" />}
            subtitle="Your fleet is ready to place. The duel starts the moment an opponent takes the other seat."
            seats={[
              { label: "You", name: myLobbyName, occupied: true },
              { label: "Opponent", occupied: false },
            ]}
            onCancel={() => void cancelLobby()}
            cancelLabel="Cancel lobby"
            cancelling={cancelling}
          />
        ) : null}
      </div>
    </main>
    ) : (
    <main data-testid="battleship-page" className="min-h-screen bg-[#030817] text-white">
      <div className="mx-auto w-full max-w-6xl px-2 py-3 sm:px-6 sm:py-4">
        {/* Slim in-arena header: the placement and combat screens need the
            vertical room for both boards, so the lobby-sized hero is not
            repeated here. */}
        <header className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 items-baseline gap-2">
            <h1 className="text-lg font-black uppercase tracking-tight sm:text-xl">Battleship</h1>
            <span className="text-[10px] font-black uppercase tracking-[0.2em] text-[#ffec08]/70">
              14×10 · 1v1
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span className="rounded-full border border-[#ffec08]/40 px-2.5 py-0.5 text-[9px] font-black uppercase tracking-wider text-[#ffec08]">
              {practiceMode ? "Practice · unrated" : "Ranked · free to play"}
            </span>
            {matchId && !over && phase && phase !== "waiting" ? (
              practiceMode ? (
                <button
                  type="button"
                  onClick={leave}
                  className="rounded-lg border border-white/15 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-white/60 transition hover:border-white/40 hover:text-white"
                >
                  Leave
                </button>
              ) : (
                <button
                  type="button"
                  data-testid="battleship-resign"
                  onClick={() => void resign()}
                  disabled={resigning}
                  className="rounded-lg border border-red-400/40 px-2.5 py-1 text-[10px] font-black uppercase tracking-wider text-red-200 transition hover:border-red-300 hover:text-white disabled:cursor-wait disabled:opacity-50"
                >
                  {resigning ? "Resigning…" : "Resign"}
                </button>
              )
            ) : null}
          </div>
        </header>

        {practiceNotice ? (
          <p
            data-testid="practice-started"
            className="mb-3 rounded-xl border border-cyan-400/40 bg-cyan-400/10 px-3 py-2 text-center text-[11px] font-bold uppercase tracking-wider text-cyan-200"
          >
            {practiceNotice}
          </p>
        ) : null}

        {body}
      </div>
    </main>
    )}
    </GameSessionHost>
  );
}
