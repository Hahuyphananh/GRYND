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

import GameSessionHost from "../../../components/GameSessionHost";
import AiDifficultyPicker from "../../../components/lobby/AiDifficultyPicker";
import BattlePreview from "../../../components/games/battleship/BattlePreview";
import FleetPlacement from "../../../components/games/battleship/FleetPlacement";
import {
  AI_DIFFICULTY_LABELS,
  DEFAULT_AI_DIFFICULTY,
  readStoredAiDifficulty,
  type AiDifficulty,
} from "../../../lib/aiDifficulty";
import { useSocket } from "../../../context/SocketProvider";
import {
  BATTLESHIP_EVENTS,
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

  useEffect(() => {
    setDifficulty(readStoredAiDifficulty("battleship"));
  }, []);

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
    } catch {
      setNotice("Network error — try again");
    } finally {
      setBusy(false);
    }
  }, []);

  /** Free practice entry: the server validates the tier, seats the bot and deals its fleet. */
  const startPractice = useCallback(
    async (tier?: AiDifficulty) => {
      setBusy(true);
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
        setBusy(false);
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

  const cancelLobby = useCallback(async () => {
    if (!matchId) return;
    setBusy(true);
    try {
      await fetch(`/api/battleship/match/${matchId}/cancel`, { method: "POST" });
      setMatchId(null);
      setSnapshot(null);
      setReveal(null);
    } finally {
      setBusy(false);
    }
  }, [matchId]);

  const leave = useCallback(() => {
    setMatchId(null);
    setSnapshot(null);
    setReveal(null);
    setNotice(null);
    setPractice(false);
    setPracticeNotice(null);
    revealedRound.current = null;
  }, []);

  // ── Render ────────────────────────────────────────────────────────────
  const phase = snapshot?.phase ?? null;
  const view = snapshot?.combat ?? null;
  const over = isMatchOver(phase);

  let body: React.ReactNode = null;

  if (!isLoaded) {
    body = (
      <p data-testid="page-loading" className="text-[11px] text-white/45">
        Loading your session…
      </p>
    );
  } else if (!matchId) {
    body = (
      <div className="space-y-3">
        <div className="rounded-2xl border border-white/10 bg-[#061229]/70 p-6 text-center">
          <p className="text-[11px] uppercase tracking-[0.2em] text-[#ffec08]/80">Ranked PvP</p>
          <p className="mt-2 text-sm font-black text-white">Two boards. One simultaneous shot each round.</p>
          <p className="mt-1 text-[11px] text-white/45">
            Free to play — no entry fee, no wager, no payout.
          </p>
          <button
            type="button"
            data-testid="find-match"
            onClick={() => void joinQueue()}
            disabled={busy || !isSignedIn}
            className="mt-4 rounded-lg border-b-4 border-[#b7a800] bg-[#ffec08] px-5 py-2.5 text-[11px] font-black uppercase tracking-wider text-[#0a1200] transition disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? "Finding…" : "Find a ranked match"}
          </button>
          {!isSignedIn ? (
            <p data-testid="ranked-sign-in-hint" className="mt-2 text-[10px] text-white/40">
              Ranked matches need a signed-in captain. Practice is open to everyone.
            </p>
          ) : null}
        </div>

        <div
          data-testid="practice-lobby"
          className="rounded-2xl border border-cyan-500/25 bg-[#061229]/70 p-6 text-center"
        >
          <p className="text-[11px] uppercase tracking-[0.2em] text-cyan-300/80">Practice · VS AI</p>
          <p className="mt-2 text-sm font-black text-white">Unrated practice against an AI captain.</p>
          <p className="mt-1 text-[11px] text-white/45">
            Free and unrated — no Elo, no trophies, no ranked record. Same simultaneous rounds.
          </p>
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
          <button
            type="button"
            data-testid="start-practice"
            onClick={() => void startPractice()}
            disabled={busy}
            className="mt-4 rounded-lg border-b-4 border-cyan-700 bg-cyan-400 px-5 py-2.5 text-[11px] font-black uppercase tracking-wider text-[#04121a] transition disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? "Starting…" : `Play vs ${AI_DIFFICULTY_LABELS[difficulty]} AI`}
          </button>
        </div>

        {notice ? (
          <p data-testid="page-notice" className="text-[11px] text-red-300">
            {notice}
          </p>
        ) : null}
      </div>
    );
  } else if (!snapshot) {
    body = (
      <p data-testid="match-loading" className="text-[11px] text-white/45">
        Joining the match…
      </p>
    );
  } else if (phase === "waiting") {
    body = (
      <div
        data-testid="waiting-lobby"
        className="rounded-2xl border border-white/10 bg-[#061229]/70 p-6 text-center"
      >
        <p className="text-sm font-black uppercase tracking-[0.18em] text-[#ffec08]">
          Waiting for an opponent
        </p>
        <p className="mt-2 text-[11px] text-white/50">
          Your lobby is open. The second captain takes the other seat and the placement clock starts.
        </p>
        {notice ? (
          <p data-testid="page-notice" className="mt-3 text-[11px] text-red-300">
            {notice}
          </p>
        ) : null}
        {snapshot.you.seat === "player1" ? (
          <button
            type="button"
            data-testid="cancel-lobby"
            onClick={() => void cancelLobby()}
            disabled={busy}
            className="mt-4 rounded-lg border border-white/15 px-4 py-2 text-[10px] font-black uppercase tracking-wider text-white/70 transition hover:border-red-400/50 hover:text-red-300"
          >
            Cancel lobby
          </button>
        ) : null}
      </div>
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
        seat={snapshot.you.seat}
        reveal={reveal}
        isAi={practiceMode}
        aiDifficulty={(snapshot.aiDifficulty ?? (practiceMode ? difficulty : null)) as string | null}
        onRestart={() => void startPractice()}
        onAttack={(coordinate) => void submitAttack(coordinate)}
        onLeave={leave}
      />
    );
  } else {
    body = (
      <p data-testid="page-loading" className="text-[11px] text-white/45">
        Syncing the match…
      </p>
    );
  }

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
    <main data-testid="battleship-page" className="min-h-screen bg-[#030817] text-white">
      <div className="mx-auto w-full max-w-5xl px-3 py-5 sm:px-6 sm:py-8">
        <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-[10px] font-black uppercase tracking-[0.3em] text-[#ffec08]/80">
              GRYND · 1v1 Naval Duel
            </p>
            <h1 className="text-2xl font-black uppercase tracking-tight sm:text-3xl">Battleship</h1>
            <p className="mt-1 max-w-xl text-[11px] leading-snug text-white/50 sm:text-xs">
              Ten by ten, five ships, one simultaneous shot every round. Find the enemy fleet before it
              finds yours.
            </p>
          </div>
          <span className="rounded-full border border-[#ffec08]/40 px-3 py-1 text-[10px] font-black uppercase tracking-wider text-[#ffec08]">
            {practiceMode ? "Practice · unrated" : "Ranked · free to play"}
          </span>
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
    </GameSessionHost>
  );
}
