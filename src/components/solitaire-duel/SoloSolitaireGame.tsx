"use client";

// src/components/solitaire-duel/SoloSolitaireGame.tsx
//
// SOLO SOLITAIRE + DAILY CHALLENGE — the single-player surface.
//
// Both modes run the SAME pure Klondike engine the ranked match uses
// (`rules.ts`), projected with `viewForState`, so card movement, foundations,
// stock/waste behaviour and win detection can never drift from PvP. What is
// deliberately NOT reused is the multiplayer session: there is no seat, no
// opponent, no clock authority, no match row and no Elo here.
//
// TIMER: elapsed time is always `now - startedAtMs` (timestamps), never an
// interval counter. The interval only refreshes the display. `startedAtMs` is
// set when the board is dealt (or when the player taps Start for the Daily),
// survives re-renders and is persisted, so a refresh resumes the same clock
// instead of restarting it.
//
// PERSISTENCE: the move log is persisted, not the derived board. Resuming
// replays the log through the engine, which is the same verification the server
// performs before a record is written. Guests get local-only records and are
// told so; signed-in players get server-stored records.
//
// ISOLATION: this component never calls the match/AI APIs and its API writes go
// to the solo/daily tables only. It cannot create a ranked match.

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import PostMatchAdSlot from "../ads/PostMatchAdSlot";
import SolitaireBoard from "./SolitaireBoard";
import SolitaireThemePicker from "./SolitaireThemePicker";
import AutoFinishAnimation from "./AutoFinishAnimation";
import { measureFinishCards, type FlyingCard } from "./measureFinishCards";
import {
  autoFinishPlan,
} from "../../lib/solitaire-duel/autoFinish";
import { dealFromSeed } from "../../lib/solitaire-duel/deck";
import {
  LOCAL_COMPLETED_KEY,
  MAX_LOCAL_COMPLETED,
  localCompletedReviewId,
  readLocalCompletedGames,
  type LocalCompletedGame,
} from "../../lib/solitaire-duel/localReview";
import {
  applyMove,
  initialStateFromDeal,
  normalizeMove,
  replayMoves,
  viewForState,
} from "../../lib/solitaire-duel/rules";
import { formatDuration, summariseSolo } from "../../lib/solitaire-duel/soloStats.js";
import type {
  SolitaireDeal,
  SolitaireMove,
  SolitaireState,
} from "../../lib/solitaire-duel/types";

type Mode = "solo" | "daily";
type LogEntry = { kind: string; move: unknown };
type Summary = ReturnType<typeof summariseSolo>;

type DailySummary = {
  completed: number;
  currentStreak: number;
  longestStreak: number;
  bestMs: number | null;
  today: { completed: boolean; moves: number; elapsedMs: number | null } | null;
};

type ServerHistoryGame = {
  id: string;
  gameKind: Mode;
  dateKey: string | null;
  moves: number;
  elapsedMs: number | null;
  completedAt: string | null;
};

type HistoryRow = {
  key: string;
  mode: Mode;
  id: string;
  moves: number;
  elapsedMs: number | null;
  endedAtMs: number | null;
  dateKey: string | null;
};

type Session = {
  mode: Mode;
  seed: number;
  dateKey: string | null;
  deal: SolitaireDeal;
  state: SolitaireState;
  log: LogEntry[];
  startedAtMs: number;
  endedAtMs: number | null;
  won: boolean;
};

const SESSION_KEY = "grynd.solitaire.session.v1";
const LOCAL_SOLO_KEY = "grynd.solitaire.solo.records.v1";
const MAX_LOCAL_RECORDS = 100;
// A guest's completed games are kept on the device so they stay reconstructable
// after the active session is cleared — including by Game Review (see
// `localReview.ts`, which owns the ring and its key).

function randomSeed(): number {
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    return crypto.getRandomValues(new Uint32Array(1))[0];
  }
  return Math.floor(Math.random() * 0x1_0000_0000) >>> 0;
}

function buildSession({
  mode,
  seed,
  dateKey,
  deal,
  log = [],
  startedAtMs = Date.now(),
  endedAtMs = null,
  won = false,
}: {
  mode: Mode;
  seed: number;
  dateKey: string | null;
  deal: SolitaireDeal;
  log?: LogEntry[];
  startedAtMs?: number;
  endedAtMs?: number | null;
  won?: boolean;
}): Session {
  const replayed = replayMoves({ deal, moves: log as { kind: string; move: unknown }[] });
  return {
    mode,
    seed,
    dateKey,
    deal,
    // A corrupt stored log falls back to the fresh deal rather than a half board.
    state: replayed.ok ? replayed.state : initialStateFromDeal(deal),
    log: replayed.ok ? log : [],
    startedAtMs,
    endedAtMs,
    won: replayed.ok ? won || replayed.state.completed : false,
  };
}

function storeSession(session: Session | null) {
  if (typeof window === "undefined") return;
  try {
    if (!session) {
      window.localStorage.removeItem(SESSION_KEY);
      return;
    }
    window.localStorage.setItem(
      SESSION_KEY,
      JSON.stringify({
        mode: session.mode,
        seed: session.seed,
        dateKey: session.dateKey,
        log: session.log,
        startedAtMs: session.startedAtMs,
        endedAtMs: session.endedAtMs,
        won: session.won,
      }),
    );
  } catch {
    // Storage full or disabled: gameplay continues, only resume is lost.
  }
}

function readLocalSolo(): Array<{ completed: boolean; moves: number; elapsedMs: number }> {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(LOCAL_SOLO_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function appendLocalSolo(entry: { completed: boolean; moves: number; elapsedMs: number }) {
  if (typeof window === "undefined") return readLocalSolo();
  const records = [...readLocalSolo(), entry].slice(-MAX_LOCAL_RECORDS);
  try {
    window.localStorage.setItem(LOCAL_SOLO_KEY, JSON.stringify(records));
  } catch {
    // ignore quota failures
  }
  return records;
}

/**
 * Keep a guest's COMPLETED game (seed/date + ordered log), not a board.
 *
 * The server path does this in `solitaire_solo_results` / `_daily_results`; a
 * guest has no account row, so the browser is the store. The log is exactly the
 * one the server would have replayed — after undo, it is the final log — and the
 * deal comes from the seed (solo) or is stored with the game (daily, because
 * only the server can derive that one from the date). Only a win is
 * kept: an abandoned attempt stays a summary record, never a "review".
 */
function appendLocalCompleted(game: {
  mode: Mode;
  seed: number;
  dateKey: string | null;
  /** Daily only: the server-derived deal, kept because it cannot be re-derived here. */
  deal?: SolitaireDeal | null;
  log: LogEntry[];
  startedAtMs: number;
  endedAtMs: number;
  elapsedMs: number;
}): string | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(LOCAL_COMPLETED_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    const records = Array.isArray(parsed) ? parsed : [];
    const savedAtMs = Date.now();
    const id = localCompletedReviewId(savedAtMs, game.log.length);
    records.push({
      mode: game.mode,
      seed: game.seed,
      dateKey: game.dateKey,
      // A solo deal is a pure function of its seed, so only a daily game has to
      // carry the deal itself.
      deal: game.mode === "daily" ? game.deal ?? null : null,
      log: game.log,
      startedAtMs: game.startedAtMs,
      endedAtMs: game.endedAtMs,
      elapsedMs: game.elapsedMs,
      id,
      won: true,
      savedAtMs,
    });
    window.localStorage.setItem(
      LOCAL_COMPLETED_KEY,
      JSON.stringify(records.slice(-MAX_LOCAL_COMPLETED)),
    );
    return id;
  } catch {
    // Storage full or disabled: the result is still shown, only replay is lost.
    return null;
  }
}


export type SoloSolitaireGameProps = {
  mode: Mode;
  /** Daily only: the server-derived deal for `dateKey`. */
  daily?: { dateKey: string; deal: SolitaireDeal; signedIn: boolean; summary: DailySummary | null } | null;
  /** Solo only: the signed-in summary, or null for a guest. */
  soloSummary?: Summary | null;
};

export default function SoloSolitaireGame({ mode, daily, soloSummary = null }: SoloSolitaireGameProps) {
  const [session, setSession] = useState<Session | null>(null);
  const [resumeCandidate, setResumeCandidate] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<Summary | null>(soloSummary);
  const [dailyStats, setDailyStats] = useState<DailySummary | null>(daily?.summary ?? null);
  const [signedIn, setSignedIn] = useState(Boolean(daily?.signedIn ?? soloSummary));
  const [savedResult, setSavedResult] = useState<
    "idle" | "saving" | "saved" | "duplicate" | "local" | "failed"
  >("idle");
  // The id of the recorded game, so the result popup can offer its analysis.
  // Server row id when signed in, local-only id for a guest's completed game.
  const [reviewGameId, setReviewGameId] = useState<string | null>(null);
  // Completed games this browser kept, oldest last. Read from the same ring the
  // guest review uses, so the Solo page can reopen any of them later.
  const [history, setHistory] = useState<LocalCompletedGame[]>([]);
  // The account's own list, when signed in. `null` = not fetched (or the read
  // failed), in which case the device ring is shown instead.
  const [serverHistory, setServerHistory] = useState<ServerHistoryGame[] | null>(null);
  const [personalBest, setPersonalBest] = useState(false);
  // The cosmetic flight after an auto-finish, or null. The game is ALREADY
  // complete and recorded when this is set; this only delays the victory panel.
  const [finishing, setFinishing] = useState<FlyingCard[] | null>(null);
  const pendingFinishRef = useRef<FlyingCard[] | null>(null);
  const submittedRef = useRef<string | null>(null);
  const router = useRouter();
  // The post-match ad is offered once per finished game, when the player picks
  // an exit action — never over the result itself. The chosen action is parked
  // until the slot reports back, so an unavailable ad cannot strand the panel.
  const [adOpen, setAdOpen] = useState(false);
  const [pendingExit, setPendingExit] = useState<string | null>(null);
  const pendingExitRef = useRef<(() => void) | null>(null);
  const adAttemptedRef = useRef(false);

  // A finished game is appended exactly once; re-reading on every save-result
  // transition keeps the history list in step without a second store.
  useEffect(() => {
    setHistory(readLocalCompletedGames());
  }, [savedResult]);

  // ACCOUNT HISTORY: a signed-in player's list follows the account, not this
  // browser. Re-read after every save so the game that just finished appears.
  useEffect(() => {
    if (!signedIn) {
      setServerHistory(null);
      return undefined;
    }
    let cancelled = false;
    fetch("/api/solitaire/history?limit=12", { credentials: "same-origin" })
      .then((response) => (response.ok ? response.json() : null))
      .then((payload) => {
        if (cancelled) return;
        const games = payload?.data?.games;
        setServerHistory(Array.isArray(games) ? (games as ServerHistoryGame[]) : null);
      })
      .catch(() => {
        if (!cancelled) setServerHistory(null);
      });
    return () => {
      cancelled = true;
    };
  }, [signedIn, savedResult]);

  // The finish is measured inside the state updater (while the old board is
  // still on screen) and released here, so the overlay mounts on the commit
  // that paints the completed board.
  useEffect(() => {
    if (!pendingFinishRef.current) return;
    const cards = pendingFinishRef.current;
    pendingFinishRef.current = null;
    setFinishing(cards);
  }, [session]);

  const dateKey = daily?.dateKey ?? null;

  // ── Start / resume ───────────────────────────────────────────────────────
  const startSolo = useCallback(() => {
    const seed = randomSeed();
    const next = buildSession({
      mode: "solo",
      seed,
      dateKey: null,
      deal: dealFromSeed(seed),
      startedAtMs: Date.now(),
    });
    setSession(next);
    setSavedResult("idle");
    setReviewGameId(null);
    setPersonalBest(false);
    setError(null);
    setFinishing(null);
    adAttemptedRef.current = false;
    storeSession(next);
  }, []);

  useEffect(() => {
    let restored: Session | null = null;
    if (mode === "solo") {
      const saved = readStoredSessionRaw();
      if (saved && saved.mode === "solo" && saved.log.length > 0 && !saved.endedAtMs) {
        const seed = Number(saved.seed);
        if (Number.isInteger(seed)) {
          try {
            restored = buildSession({
              mode: "solo",
              seed,
              dateKey: null,
              deal: dealFromSeed(seed),
              log: saved.log,
              startedAtMs: Number(saved.startedAtMs) || Date.now(),
            });
          } catch {
            restored = null;
          }
        }
      }
    } else if (daily) {
      const saved = readStoredSessionRaw();
      if (
        saved &&
        saved.mode === "daily" &&
        saved.dateKey === daily.dateKey &&
        saved.log.length > 0 &&
        !saved.endedAtMs
      ) {
        restored = buildSession({
          mode: "daily",
          seed: Number(saved.seed) || 0,
          dateKey: daily.dateKey,
          deal: daily.deal,
          log: saved.log,
          startedAtMs: Number(saved.startedAtMs) || Date.now(),
        });
      }
    }
    if (restored) setResumeCandidate(restored);
    else if (mode === "solo") startSolo();
    setReady(true);
    // `daily` is a stable server payload for the page's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, daily?.dateKey]);

  // Display refresh only: the elapsed number is derived from timestamps.
  useEffect(() => {
    if (!session || session.endedAtMs) return undefined;
    const id = window.setInterval(() => setNowMs(Date.now()), 250);
    return () => window.clearInterval(id);
  }, [session]);

  useEffect(() => {
    if (mode === "solo" && !soloSummary && !summary) {
      let cancelled = false;
      fetch("/api/solitaire/solo", { credentials: "same-origin" })
        .then(async (response) => {
          if (response.status === 401) return null;
          return response.ok ? response.json() : null;
        })
        .then((payload) => {
          if (cancelled || !payload?.data?.summary) return;
          setSignedIn(true);
          setSummary(payload.data.summary as Summary);
        })
        .catch(() => {});
      return () => {
        cancelled = true;
      };
    }
    return undefined;
  }, [mode, soloSummary, summary]);

  // ── Move handling ────────────────────────────────────────────────────────
  const recordResult = useCallback(
    async (finished: Session) => {
      const elapsedMs = Math.max(0, (finished.endedAtMs ?? Date.now()) - finished.startedAtMs);
      const key = `${finished.mode}:${finished.dateKey ?? finished.seed}:${finished.log.length}`;
      if (submittedRef.current === key) return;
      submittedRef.current = key;
      setSavedResult("saving");
      setReviewGameId(null);

      // The record every path below can keep locally: the deal (or seed) and
      // the FINAL log, never a board snapshot. A guest's review and the Solo
      // page's history both read this ring.
      const localGame = {
        mode: finished.mode,
        seed: finished.seed,
        dateKey: finished.dateKey,
        deal: finished.deal,
        log: finished.log,
        startedAtMs: finished.startedAtMs,
        endedAtMs: finished.endedAtMs ?? Date.now(),
        elapsedMs,
      };

      try {
        const endpoint = finished.mode === "daily" ? "/api/solitaire/daily" : "/api/solitaire/solo";
        const body =
          finished.mode === "daily"
            ? { moves: finished.log, elapsedMs }
            : { seed: finished.seed, moves: finished.log, elapsedMs };
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify(body),
        });
        if (response.status === 401) {
          setSavedResult("local");
          if (finished.won) {
            // Guest practice: retain the game itself (its deal or seed, plus
            // the final log), so a refresh or a later visit can rebuild this
            // exact board. Solo derives its deal from the seed; a daily game
            // carries the server's deal because only the server derives it.
            const localReviewId = appendLocalCompleted(localGame);
            if (localReviewId) setReviewGameId(localReviewId);
          }
          if (finished.mode === "solo") {
            setSummary(summariseSolo(appendLocalSolo({
              completed: finished.won,
              moves: finished.log.length,
              elapsedMs,
            })));
          }
          return;
        }
        if (!response.ok) {
          setSavedResult("failed");
          return;
        }
        const payload = await response.json();
        // The server returns the recorded row's id so the popup can offer the
        // analysis of exactly this game. A duplicate submission has no id and
        // therefore no entry point.
        setReviewGameId(
          typeof payload?.data?.id === "string" ? payload.data.id : null,
        );
        if (finished.mode === "daily") {
          const next = payload?.data?.summary as DailySummary | undefined;
          if (next) {
            setDailyStats(next);
            const best = next.bestMs;
            setPersonalBest(Boolean(best && elapsedMs <= best && payload?.data?.recorded));
          }
          setSavedResult(payload?.data?.duplicate ? "duplicate" : "saved");
        } else {
          const next = payload?.data?.summary as Summary | undefined;
          if (next) {
            setSummary(next);
            setPersonalBest(Boolean(next.bestMs && elapsedMs <= next.bestMs && finished.won));
          }
          setSavedResult("saved");
        }
      } catch {
        setSavedResult("failed");
      }
    },
    [],
  );

  const playMove = useCallback(
    (move: SolitaireMove) => {
      setError(null);
      setSession((current) => {
        if (!current || current.endedAtMs || current.won) return current;
        const normalized = normalizeMove(move);
        if (!normalized.ok) {
          setError("That move is not valid.");
          return current;
        }
        const applied = applyMove({ state: current.state, move: normalized.move });
        if (!applied.ok) {
          setError(applied.error || "That move is not valid.");
          return current;
        }
        const entry: LogEntry = { kind: normalized.move.kind, move: normalized.move };

        // AUTO-FINISH. The engine has just proved that every remaining card can
        // go straight to a foundation, so the game is decided NOW: the clock
        // stops at this instant, the log gets the whole legal sequence, and the
        // result is recorded once. Everything after this — measuring, flying,
        // skipping — is cosmetic and cannot change the time or the record.
        const plan = autoFinishPlan(applied.state);
        if (plan) {
          const finishedAt = Date.now();
          const flying = measureFinishCards(plan.steps);
          if (flying.length > 0) pendingFinishRef.current = flying;
          const next: Session = {
            ...current,
            state: plan.finalState,
            // APPEND, never replace: the stored log is the whole game, and the
            // result endpoint replays it from the deal to verify the win.
            log: [
              ...current.log,
              entry,
              ...plan.steps.map((step) => ({ kind: step.move.kind, move: step.move })),
            ],
            endedAtMs: finishedAt,
            won: true,
          };
          storeSession(null);
          void recordResult(next);
          return next;
        }

        const ended = applied.state.completed;
        const next: Session = {
          ...current,
          state: applied.state,
          log: [...current.log, entry],
          endedAtMs: ended ? Date.now() : null,
          won: ended,
        };
        storeSession(ended ? null : next);
        if (ended) void recordResult(next);
        return next;
      });
    },
    [recordResult],
  );

  const undo = useCallback(() => {
    setError(null);
    setSession((current) => {
      if (!current || current.endedAtMs || current.log.length === 0) return current;
      const log = current.log.slice(0, -1);
      const replayed = replayMoves({ deal: current.deal, moves: log as { kind: string; move: unknown }[] });
      if (!replayed.ok) return current;
      const next = { ...current, state: replayed.state, log };
      storeSession(next);
      return next;
    });
  }, []);

  const abandonIfNeeded = useCallback(
    (current: Session | null) => {
      if (!current || current.endedAtMs || current.log.length === 0) return;
      void recordResult({ ...current, endedAtMs: Date.now() });
    },
    [recordResult],
  );

  const newSoloGame = useCallback(() => {
    abandonIfNeeded(session);
    startSolo();
  }, [abandonIfNeeded, session, startSolo]);

  const restart = useCallback(() => {
    abandonIfNeeded(session);
    if (!session) return;
    const next = buildSession({
      mode: session.mode,
      seed: session.seed,
      dateKey: session.dateKey,
      deal: session.deal,
      startedAtMs: Date.now(),
    });
    setSession(next);
    setSavedResult("idle");
    setReviewGameId(null);
    setPersonalBest(false);
    setError(null);
    setFinishing(null);
    submittedRef.current = null;
    adAttemptedRef.current = false;
    storeSession(next);
  }, [abandonIfNeeded, session]);

  const startDaily = useCallback(() => {
    if (!daily) return;
    const next = buildSession({
      mode: "daily",
      seed: 0,
      dateKey: daily.dateKey,
      deal: daily.deal,
      startedAtMs: Date.now(),
    });
    setSession(next);
    setSavedResult("idle");
    setReviewGameId(null);
    setPersonalBest(false);
    setError(null);
    setFinishing(null);
    submittedRef.current = null;
    adAttemptedRef.current = false;
    storeSession(next);
  }, [daily]);

  // ── Post-match ad ────────────────────────────────────────────────────────
  // Every exit on the win panel goes through this guard. The finished game
  // earns one attempt: the action is parked and the slot decides whether a
  // creative plays. When it reports back (played or unavailable) the parked
  // action runs. A game that is still in progress exits immediately.
  const guardExit = (key: string, action: () => void) => {
    if (!session?.won || finishing) {
      action();
      return;
    }
    if (pendingExitRef.current || adOpen) return;
    if (adAttemptedRef.current) {
      action();
      return;
    }
    adAttemptedRef.current = true;
    pendingExitRef.current = action;
    setPendingExit(key);
    setAdOpen(true);
  };

  const handleAdSettled = useCallback(() => {
    const next = pendingExitRef.current;
    pendingExitRef.current = null;
    setPendingExit(null);
    setAdOpen(false);
    next?.();
  }, []);

  const elapsedMs = session ? Math.max(0, (session.endedAtMs ?? nowMs) - session.startedAtMs) : 0;
  const moves = session?.log.length ?? 0;
  const bestMs = mode === "daily" ? dailyStats?.bestMs ?? null : summary?.bestMs ?? null;
  const todayRecorded = Boolean(dailyStats?.today?.completed);
  const isPracticeReplay = mode === "daily" && todayRecorded && !session?.won;

  // The list under BOTH single-player modes. Signed in: the account's games
  // (which follow the player across devices). Guest: the games this browser
  // kept, the same ring a guest's review is rebuilt from.
  const historyRows: HistoryRow[] = serverHistory
    ? serverHistory
        .filter((game) => typeof game?.id === "string" && game.id)
        .map((game) => ({
          key: `account:${game.gameKind}:${game.id}`,
          mode: game.gameKind === "daily" ? "daily" : "solo",
          id: game.id,
          moves: Number(game.moves) || 0,
          elapsedMs: Number.isFinite(Number(game.elapsedMs))
            ? Number(game.elapsedMs)
            : null,
          endedAtMs: game.completedAt ? Date.parse(game.completedAt) : null,
          dateKey: game.dateKey ?? null,
        }))
    : history
        .filter((row) => typeof row?.id === "string" && row.id)
        .slice(-12)
        .reverse()
        .map((row) => ({
          key: `device:${row.id}`,
          mode: row.mode === "daily" ? "daily" : "solo",
          id: row.id,
          moves: Array.isArray(row.log) ? row.log.length : 0,
          elapsedMs: Number.isFinite(Number(row.elapsedMs)) ? Number(row.elapsedMs) : null,
          endedAtMs: Number.isFinite(Number(row.endedAtMs)) ? Number(row.endedAtMs) : null,
          dateKey: row.dateKey ?? null,
        }));

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-emerald-300/80">
            {mode === "daily" ? "Daily Challenge" : "Solo Solitaire"}
          </p>
          <h2 className="mt-1 text-2xl font-semibold text-white sm:text-3xl">
            {mode === "daily" ? daily?.dateKey ?? "Today" : "Klondike, no opponent"}
          </h2>
          <p className="mt-1 max-w-xl text-sm text-slate-400">
            {mode === "daily"
              ? "One shared deal for every player, dealt once per UTC day. Replays are practice and are not recorded."
              : "Classic Klondike with the ranked rules. Unrated: this never affects Elo or ranked history."}
          </p>
        </div>
        <dl className="flex gap-2 text-center">          <div className="rounded-lg border border-white/10 bg-white/5 px-3 py-2">
            <dt className="text-[10px] uppercase tracking-wider text-slate-400">Time</dt>
            <dd className="font-mono text-lg text-white" aria-live="off">
              {formatDuration(session ? Math.max(elapsedMs, 1000) : null)}
            </dd>
          </div>
          <div className="rounded-lg border border-white/10 bg-white/5 px-3 py-2">
            <dt className="text-[10px] uppercase tracking-wider text-slate-400">Moves</dt>
            <dd className="font-mono text-lg text-white">{moves}</dd>
          </div>
          <div className="rounded-lg border border-white/10 bg-white/5 px-3 py-2">
            <dt className="text-[10px] uppercase tracking-wider text-slate-400">Best</dt>
            <dd className="font-mono text-lg text-white">{formatDuration(bestMs)}</dd>
          </div>
        </dl>
      </div>

      {/* The table selector. Solo and the Daily Challenge are the same
          component, and the board reads this one preference in ranked and
          practice play too. Collapsed by default: the board's height budget is
          what keeps the whole tableau above the fold. */}
      <div className="mb-4 flex justify-end">
        <SolitaireThemePicker />
      </div>

      {!ready && <p className="py-16 text-center text-slate-400">Shuffling the deck…</p>}

      {ready && !session && mode === "daily" && (
        <div className="rounded-2xl border border-white/10 bg-slate-900/60 p-6 text-center">
          <p className="text-sm text-slate-300">
            {todayRecorded
              ? "You have already recorded today's challenge. You can replay the same deal as practice."
              : "The timer starts when you begin."}
          </p>
          <div className="mt-4 flex flex-wrap justify-center gap-3">
            <button type="button" onClick={startDaily} className="rounded-lg bg-emerald-500 px-5 py-2 font-semibold text-slate-950 hover:bg-emerald-400">
              {todayRecorded ? "Replay as practice" : "Start challenge"}
            </button>
            <Link href="/" className="rounded-lg border border-white/15 px-5 py-2 text-slate-200 hover:bg-white/5">
              Back to lobby
            </Link>
          </div>
        </div>
      )}

      {ready && !session && mode === "solo" && (
        <div className="rounded-2xl border border-white/10 bg-slate-900/60 p-6 text-center">
          <button type="button" onClick={startSolo} className="rounded-lg bg-emerald-500 px-5 py-2 font-semibold text-slate-950 hover:bg-emerald-400">
            New game
          </button>
        </div>
      )}

      {resumeCandidate && !session && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-400/30 bg-amber-400/10 px-4 py-3">
          <p className="text-sm text-amber-100">
            You have an unfinished game ({resumeCandidate.log.length} moves,{" "}
            {formatDuration(Date.now() - resumeCandidate.startedAtMs)}).
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => {
                setSession(resumeCandidate);
                setResumeCandidate(null);
              }}
              className="rounded-lg bg-amber-300 px-4 py-1.5 text-sm font-semibold text-slate-950"
            >
              Resume
            </button>
            {mode === "solo" && (
              <button
                type="button"
                onClick={() => {
                  setResumeCandidate(null);
                  startSolo();
                }}
                className="rounded-lg border border-white/20 px-4 py-1.5 text-sm text-white"
              >
                Start fresh
              </button>
            )}
          </div>
        </div>
      )}

      {session && (
        <div className="relative">
          {isPracticeReplay && (
            <p className="mb-2 rounded-lg border border-indigo-400/30 bg-indigo-400/10 px-3 py-2 text-xs text-indigo-200">
              Practice replay — today's official result is already recorded.
            </p>
          )}
          <SolitaireBoard
            view={viewForState(session.state)}
            interactive={!session.endedAtMs && !session.won}
            holdHeight={finishing?.[0]?.board.height}
            onMove={playMove}
            onInvalid={() => setError("That card cannot move there.")}
          />

          {finishing && (
            <AutoFinishAnimation cards={finishing} onDone={() => setFinishing(null)} />
          )}

          <div className="mt-4 flex flex-wrap items-center gap-2">
            {mode === "solo" ? (
              <button type="button" onClick={newSoloGame} disabled={Boolean(finishing)} className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-slate-950 disabled:opacity-40 hover:bg-emerald-400">
                New game
              </button>
            ) : (
              <button type="button" onClick={startDaily} disabled={Boolean(finishing)} className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-slate-950 disabled:opacity-40 hover:bg-emerald-400">
                New challenge
              </button>
            )}
            <button
              type="button"
              onClick={restart}
              disabled={Boolean(finishing)}
              className="rounded-lg border border-white/15 px-4 py-2 text-sm text-slate-200 disabled:opacity-40 hover:bg-white/5"
            >
              Restart
            </button>
            <button
              type="button"
              onClick={undo}
              disabled={session.log.length === 0 || Boolean(session.endedAtMs)}
              className="rounded-lg border border-white/15 px-4 py-2 text-sm text-slate-200 disabled:opacity-40 hover:bg-white/5"
            >
              Undo
            </button>
            <Link href="/" className="ml-auto text-sm text-slate-400 hover:text-white">
              Exit
            </Link>
          </div>

          {error && (
            <p role="alert" className="mt-3 text-sm text-rose-300">
              {error}
            </p>
          )}

          {session.won && !finishing && (
            <div className="absolute inset-0 z-10 flex items-center justify-center rounded-2xl bg-slate-950/80 p-4 backdrop-blur-xs">
              <div role="dialog" aria-label="Game complete" className="w-full max-w-md rounded-2xl border border-emerald-400/30 bg-slate-900 p-6 text-center shadow-2xl">
                <p className="text-xs uppercase tracking-[0.25em] text-emerald-300">Solved</p>
                <h3 className="mt-2 text-2xl font-semibold text-white">
                  {mode === "daily" ? "Daily challenge complete" : "You cleared the board"}
                </h3>
                <dl className="mt-4 grid grid-cols-2 gap-3 text-left text-sm">
                  <div className="rounded-lg bg-white/5 px-3 py-2">
                    <dt className="text-slate-400">Time</dt>
                    <dd className="font-mono text-lg text-white">{formatDuration(elapsedMs)}</dd>
                  </div>
                  <div className="rounded-lg bg-white/5 px-3 py-2">
                    <dt className="text-slate-400">Moves</dt>
                    <dd className="font-mono text-lg text-white">{moves}</dd>
                  </div>
                </dl>
                {personalBest && <p className="mt-3 text-sm font-medium text-emerald-300">Personal best!</p>}
                {savedResult === "saved" && <p className="mt-2 text-xs text-slate-400">Result saved to your profile.</p>}
                {savedResult === "duplicate" && <p className="mt-2 text-xs text-slate-400">Today's official result was already recorded. This replay stays practice.</p>}
                {savedResult === "local" && <p className="mt-2 text-xs text-amber-200">Saved on this device only — sign in to keep solo records.</p>}
                {savedResult === "failed" && <p className="mt-2 text-xs text-rose-300">Could not save this result. Your board is unaffected.</p>}
                {mode === "daily" && dailyStats && (
                  <p className="mt-2 text-xs text-slate-400">
                    Daily streak: {dailyStats.currentStreak} · Completed: {dailyStats.completed}
                  </p>
                )}
                <div className="mt-5 flex flex-wrap justify-center gap-2">
                  {reviewGameId && (
                    <Link
                      href={`/solitaire/review/${session.mode}/${encodeURIComponent(reviewGameId)}`}
                      onClick={(event) => {
                        event.preventDefault();
                        guardExit("analysis", () =>
                          router.push(
                            `/solitaire/review/${session.mode}/${encodeURIComponent(reviewGameId)}`,
                          ),
                        );
                      }}
                      data-testid="solitaire-analysis"
                      className="inline-flex items-center justify-center rounded-lg border border-cyan-300/40 bg-cyan-300/10 px-4 py-2 text-sm font-semibold text-cyan-200 hover:bg-cyan-300/20"
                    >
                      Match analysis
                    </Link>
                  )}
                  <button
                    type="button"
                    onClick={() => guardExit("playAgain", restart)}
                    disabled={Boolean(pendingExit)}
                    aria-busy={pendingExit === "playAgain"}
                    className="inline-flex items-center justify-center gap-2 rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-emerald-400 disabled:opacity-60"
                  >
                    {pendingExit === "playAgain" && (
                      <span aria-hidden="true" className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
                    )}
                    Play again
                  </button>
                  {mode === "solo" ? (
                    <button
                      type="button"
                      onClick={() => guardExit("newDeal", newSoloGame)}
                      disabled={Boolean(pendingExit)}
                      aria-busy={pendingExit === "newDeal"}
                      className="inline-flex items-center justify-center gap-2 rounded-lg border border-white/15 px-4 py-2 text-sm text-white disabled:opacity-60"
                    >
                      {pendingExit === "newDeal" && (
                        <span aria-hidden="true" className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
                      )}
                      New deal
                    </button>
                  ) : (
                    <Link
                      href="/"
                      onClick={(event) => {
                        event.preventDefault();
                        guardExit("lobby", () => router.push("/"));
                      }}
                      className="inline-flex items-center justify-center gap-2 rounded-lg border border-white/15 px-4 py-2 text-sm text-white"
                    >
                      {pendingExit === "lobby" && (
                        <span aria-hidden="true" className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
                      )}
                      Back to lobby
                    </Link>
                  )}
                </div>
                {!signedIn && (
                  <p className="mt-4 text-xs text-slate-500">
                    Playing as a guest. Records stay in this browser and are never uploaded.
                  </p>
                )}
              </div>
            </div>
          )}

          {adOpen && (
            <PostMatchAdSlot
              matchId={`solitaire:${session.mode}:${session.dateKey ?? session.seed}:${session.endedAtMs ?? "finished"}`}
              onDone={handleAdSettled}
            />
          )}
        </div>
      )}

      {historyRows.length > 0 && (
        <section
          data-testid="solitaire-review-history"
          className="mt-6 rounded-2xl border border-white/10 bg-slate-900/50 p-4"
        >
          <h3 className="text-xs font-bold uppercase tracking-[0.2em] text-white/50">
            Past games
          </h3>
          <p className="mt-1 text-[11px] text-slate-500">
            {serverHistory
              ? "Completed games saved to your account. Open one to replay it move by move."
              : "Completed games kept in this browser. Open one to replay it move by move."}
          </p>
          <ul className="mt-3 divide-y divide-white/5">
            {historyRows.map((row) => (
                <li
                  key={row.key}
                  className="flex flex-wrap items-center justify-between gap-3 py-2"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm text-white/80">
                      {row.mode === "daily" ? `Daily · ${row.dateKey ?? "Today"}` : "Solo"}
                      <span className="text-slate-500">
                        {" · "}
                        {row.moves} moves{" · "}
                        {formatDuration(row.elapsedMs)}
                      </span>
                    </p>
                    {row.endedAtMs !== null && Number.isFinite(row.endedAtMs) && (
                      <p className="text-[11px] text-slate-500">
                        {new Date(row.endedAtMs).toLocaleString()}
                      </p>
                    )}
                  </div>
                  <Link
                    href={`/solitaire/review/${row.mode}/${encodeURIComponent(row.id)}`}
                    data-testid={`solitaire-history-review-${row.id}`}
                    className="rounded-lg border border-cyan-300/40 bg-cyan-300/10 px-3 py-1.5 text-xs font-semibold text-cyan-200 hover:bg-cyan-300/20"
                  >
                    Review
                  </Link>
                </li>
              ))}
          </ul>
        </section>
      )}

      {mode === "solo" && summary && (
        <p className="mt-4 text-xs text-slate-500">
          Solo record: {summary.completed}/{summary.games} completed · best {formatDuration(summary.bestMs)} ·{" "}
          {signedIn ? "saved to your account" : "this device only"}
        </p>
      )}
    </div>
  );
}

/** Raw stored session, shape-checked. Kept separate so resume can rebuild a deal. */
function readStoredSessionRaw(): {
  mode?: unknown;
  seed?: unknown;
  dateKey?: unknown;
  log: LogEntry[];
  startedAtMs?: unknown;
  endedAtMs?: unknown;
} | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw) as Record<string, unknown>;
    const log = Array.isArray(saved.log) ? (saved.log as LogEntry[]) : [];
    return {
      mode: saved.mode,
      seed: saved.seed,
      dateKey: saved.dateKey,
      log,
      startedAtMs: saved.startedAtMs,
      endedAtMs: saved.endedAtMs ?? null,
    };
  } catch {
    return null;
  }
}
