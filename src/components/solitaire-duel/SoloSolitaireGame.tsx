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
// TIMER: elapsed time is always `now - timerStartedAtMs` (timestamps), never an
// interval counter, and the interval only refreshes the display. Solo deals the
// board WITHOUT starting the clock: `timerStartedAtMs` stays null until the
// first accepted card move, so studying the opening deal costs no time. The
// Daily starts it when the player taps Start. It survives re-renders and is
// persisted, so a refresh resumes the same clock instead of restarting it.
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

import { useOnlineStatus } from "../../hooks/useOnlineStatus";

import PostMatchAdSlot from "../ads/PostMatchAdSlot";
import SolitaireBoard from "./SolitaireBoard";
import SolitaireThemePicker from "./SolitaireThemePicker";
import AutoFinishAnimation from "./AutoFinishAnimation";
import { measureFinishCards, type FlyingCard } from "./measureFinishCards";
import {
  autoFinishPlan,
} from "../../lib/solitaire-duel/autoFinish";
import {
  INACTIVITY_COUNTDOWN_MS,
  INACTIVITY_FORFEIT_MS,
} from "../../lib/solitaire-duel/constants";
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
import { soloElapsedMs } from "../../lib/solitaire-duel/soloTimer";
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
  /**
   * When the run's clock started: the first accepted card move in solo, or the
   * moment the Daily was started. Null while a solo board is still untouched.
   */
  timerStartedAtMs: number | null;
  /** The instant of the last accepted action; the inactivity clock runs from it. */
  lastActivityAtMs: number;
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
  timerStartedAtMs = startedAtMs,
  lastActivityAtMs = startedAtMs,
  endedAtMs = null,
  won = false,
}: {
  mode: Mode;
  seed: number;
  dateKey: string | null;
  deal: SolitaireDeal;
  log?: LogEntry[];
  startedAtMs?: number;
  timerStartedAtMs?: number | null;
  lastActivityAtMs?: number;
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
    timerStartedAtMs,
    lastActivityAtMs,
    endedAtMs,
    won: replayed.ok ? won || replayed.state.completed : false,
  };
}

/**
 * The instant a live session forfeits.
 *
 * Twenty minutes after the last accepted action, measured on the same clock the
 * duel uses (`INACTIVITY_FORFEIT_MS`). Stored as a timestamp, never an interval
 * count, so a refresh or a backgrounded tab cannot reset it.
 */
function inactivityForfeitAt(session: Session): number {
  return session.lastActivityAtMs + INACTIVITY_FORFEIT_MS;
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
        timerStartedAtMs: session.timerStartedAtMs,
        lastActivityAtMs: session.lastActivityAtMs,
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
  const { online } = useOnlineStatus();
  const onlineRef = useRef(online);
  useEffect(() => {
    onlineRef.current = online;
  }, [online]);
  const [savedResult, setSavedResult] = useState<
    "idle" | "saving" | "saved" | "duplicate" | "local" | "failed" | "offline"
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

  /**
   * Persist the live session ONLY while connected.
   *
   * Offline runs are playable but deliberately keep nothing: no session
   * snapshot, no device record, no queued upload. `navigator.onLine` is checked
   * here as well as through the hook, because the mount effect that deals the
   * first solo board can run before the hook's first connectivity update.
   */
  const persistSession = useCallback((next: Session | null) => {
    if (!onlineRef.current) return;
    if (typeof navigator !== "undefined" && navigator.onLine === false) return;
    storeSession(next);
  }, []);

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
      // Solo's clock waits for the first card move: the deal itself is free to
      // study, and the inactivity limit waits with it.
      timerStartedAtMs: null,
    });
    setSession(next);
    setSavedResult("idle");
    setReviewGameId(null);
    setPersonalBest(false);
    setError(null);
    setFinishing(null);
    persistSession(next);
  }, [persistSession]);

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
              // A resumed session has moves, so the clock had already started;
              // the fallback covers sessions stored before the field existed.
              timerStartedAtMs:
                Number(saved.timerStartedAtMs) || Number(saved.startedAtMs) || Date.now(),
              lastActivityAtMs:
                Number(saved.lastActivityAtMs) || Number(saved.startedAtMs) || Date.now(),
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
          timerStartedAtMs:
            Number(saved.timerStartedAtMs) || Number(saved.startedAtMs) || Date.now(),
          lastActivityAtMs:
            Number(saved.lastActivityAtMs) || Number(saved.startedAtMs) || Date.now(),
        });
      }
    }
    if (restored && !restored.won && Date.now() >= inactivityForfeitAt(restored)) {
      // A stored game left past the inactivity limit is already lost. Never
      // offer to resume it, and never leave it in progress.
      persistSession(null);
      setSession({ ...restored, endedAtMs: inactivityForfeitAt(restored), won: false });
    } else if (restored) {
      setResumeCandidate(restored);
    } else if (mode === "solo") {
      startSolo();
    }
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

  // INACTIVITY FORFEIT. There is no match clock, but a run still cannot stay in
  // progress forever: twenty minutes without a move (or an undo) loses the
  // game. Measured from the stored timestamp, so a refresh cannot reset it.
  useEffect(() => {
    if (!session || session.endedAtMs || session.won) return;
    // An untouched solo board has not started, so neither has the limit.
    if (session.timerStartedAtMs == null) return;
    if (nowMs < inactivityForfeitAt(session)) return;
    setSession((current) => {
      if (!current || current.endedAtMs || current.won) return current;
      if (Date.now() < inactivityForfeitAt(current)) return current;
      persistSession(null);
      return { ...current, endedAtMs: inactivityForfeitAt(current), won: false };
    });
  }, [session, nowMs]);

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
      // OFFLINE: the run is real but nothing is stored. No POST, no device
      // record, and nothing queued for a later reconnect.
      if (!onlineRef.current || (typeof navigator !== "undefined" && navigator.onLine === false)) {
        setSavedResult("offline");
        return;
      }
      const elapsedMs = soloElapsedMs(
        finished.timerStartedAtMs,
        finished.endedAtMs ?? Date.now(),
        Date.now(),
      );
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

  // A forfeit is a finished attempt, so it is recorded exactly once: the solo
  // route replays the log and stores a non-completion, the same row an abandoned
  // game produces. A daily forfeit is not submitted — that endpoint only stores
  // a solved board — but the loss still ends the session here.
  useEffect(() => {
    if (!session || !session.endedAtMs || session.won) return;
    if (session.mode !== "solo" || session.log.length === 0) return;
    void recordResult(session);
  }, [session, recordResult]);

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
            timerStartedAtMs: current.timerStartedAtMs ?? finishedAt,
            lastActivityAtMs: finishedAt,
          };
          persistSession(null);
          void recordResult(next);
          return next;
        }

        const ended = applied.state.completed;
        const movedAt = Date.now();
        const next: Session = {
          ...current,
          state: applied.state,
          log: [...current.log, entry],
          // THE first accepted card move starts the clock. A rejected move never
          // reaches here, so reading the deal costs nothing.
          timerStartedAtMs: current.timerStartedAtMs ?? movedAt,
          lastActivityAtMs: movedAt,
          endedAtMs: ended ? movedAt : null,
          won: ended,
        };
        persistSession(ended ? null : next);
        if (ended) void recordResult(next);
        return next;
      });
    },
    [persistSession, recordResult],
  );

  const undo = useCallback(() => {
    setError(null);
    setSession((current) => {
      if (!current || current.endedAtMs || current.log.length === 0) return current;
      const trimmed = current.log.slice(0, -1);
      const replayed = replayMoves({
        deal: current.deal,
        moves: trimmed as { kind: string; move: unknown }[],
      });
      // The engine always reports the deepest position it accepted, even when a
      // later entry is refused, so a stored log that no longer replays (an
      // older session, a rules change) still rewinds to that position instead
      // of leaving the button doing nothing. Undo is never a silent no-op while
      // there is history to remove.
      const log = replayed.ok
        ? trimmed
        : trimmed.slice(0, Math.max(0, replayed.rejectedAt ?? 0));
      const next = { ...current, state: replayed.state, log, lastActivityAtMs: Date.now() };
      persistSession(next);
      return next;
    });
  }, [persistSession]);

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
    const restartedAtMs = Date.now();
    const next = buildSession({
      mode: session.mode,
      seed: session.seed,
      dateKey: session.dateKey,
      deal: session.deal,
      startedAtMs: restartedAtMs,
      // A restarted solo run waits for its first move too; a daily replay is
      // started by this click, exactly like the first attempt.
      timerStartedAtMs: session.mode === "solo" ? null : restartedAtMs,
    });
    setSession(next);
    setSavedResult("idle");
    setReviewGameId(null);
    setPersonalBest(false);
    setError(null);
    setFinishing(null);
    submittedRef.current = null;
    persistSession(next);
  }, [abandonIfNeeded, persistSession, session]);

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
    persistSession(next);
  }, [daily, persistSession]);

  // ── Post-match ad ────────────────────────────────────────────────────────
  // The slot mounts with the win panel itself, so the video starts as soon as
  // the result appears instead of waiting for an exit click. It is an overlay:
  // the panel and every control stay behind it, and the server still decides
  // whether a free session is offered anything at all.

  const elapsedMs = session
    ? soloElapsedMs(session.timerStartedAtMs, session.endedAtMs, nowMs)
    : 0;
  // Time left before the inactivity rule ends this run (0 once it has).
  const inactivityRemainingMs = session
    ? Math.max(0, inactivityForfeitAt(session) - nowMs)
    : 0;
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
          {!online && (
            <p
              data-testid="solitaire-offline-note"
              className="mt-3 inline-flex rounded-full border border-amber-300/30 bg-amber-400/10 px-3 py-1 text-[11px] font-bold uppercase tracking-[0.14em] text-amber-200/80"
            >
              Offline · this run won't be saved
            </p>
          )}
        </div>
        <dl className="flex gap-2 text-center">          <div className="rounded-lg border border-white/10 bg-white/5 px-3 py-2">
            <dt className="text-[10px] uppercase tracking-wider text-slate-400">Time</dt>
            <dd className="font-mono text-lg text-white" aria-live="off">
              {session
                ? session.timerStartedAtMs == null
                  ? "0:00"
                  : formatDuration(Math.max(elapsedMs, 1000))
                : formatDuration(null)}
            </dd>
            {/* The idle clock is always on the timer, not only in the last five
                minutes: a run forfeits 20 minutes after the last accepted move. */}
            {session && !session.endedAtMs && !session.won && session.timerStartedAtMs != null && (
              <dd
                data-testid="solitaire-idle-countdown"
                title="Time until this run forfeits for inactivity"
                className={`font-mono text-[10px] leading-tight ${
                  inactivityRemainingMs <= INACTIVITY_COUNTDOWN_MS
                    ? "text-amber-300"
                    : "text-slate-500"
                }`}
              >
                idle {formatDuration(Math.max(1000, inactivityRemainingMs))}
              </dd>
            )}
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
          {session && !session.endedAtMs && !session.won && inactivityRemainingMs <= INACTIVITY_COUNTDOWN_MS && (
            <p
              role="status"
              data-testid="solitaire-inactivity-alarm"
              className="mb-2 rounded-lg border border-amber-400/40 bg-amber-400/10 px-3 py-2 text-xs font-semibold text-amber-100"
            >
              You&apos;ve been idle for a while. This run is lost if you do not move
              within {formatDuration(Math.max(1000, inactivityRemainingMs))}.
            </p>
          )}
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
            <Link
              href="/"
              className="ml-auto text-sm text-slate-400 hover:text-white"
            >
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
                {savedResult === "offline" && <p className="mt-2 text-xs text-amber-200">Offline run — nothing was saved.</p>}
                {mode === "daily" && dailyStats && (
                  <p className="mt-2 text-xs text-slate-400">
                    Daily streak: {dailyStats.currentStreak} · Completed: {dailyStats.completed}
                  </p>
                )}
                <div className="mt-5 flex flex-wrap justify-center gap-2">
                  {reviewGameId && (
                    <Link
                      href={`/solitaire/review/${session.mode}/${encodeURIComponent(reviewGameId)}`}
                      data-testid="solitaire-analysis"
                      className="inline-flex items-center justify-center rounded-lg border border-cyan-300/40 bg-cyan-300/10 px-4 py-2 text-sm font-semibold text-cyan-200 hover:bg-cyan-300/20"
                    >
                      Match analysis
                    </Link>
                  )}
                  <button
                    type="button"
                    onClick={restart}
                    className="inline-flex items-center justify-center rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-emerald-400"
                  >
                    Play again
                  </button>
                  {mode === "solo" ? (
                    <button
                      type="button"
                      onClick={newSoloGame}
                      className="inline-flex items-center justify-center rounded-lg border border-white/15 px-4 py-2 text-sm text-white hover:bg-white/5"
                    >
                      New deal
                    </button>
                  ) : (
                    <Link
                      href="/"
                      className="inline-flex items-center justify-center rounded-lg border border-white/15 px-4 py-2 text-sm text-white hover:bg-white/5"
                    >
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

          {session.endedAtMs !== null && !session.won && (
            <div className="absolute inset-0 z-10 flex items-center justify-center rounded-2xl bg-slate-950/80 p-4 backdrop-blur-xs">
              <div
                role="alertdialog"
                aria-label="Game over"
                data-testid="solitaire-inactivity-forfeit"
                className="w-full max-w-md rounded-2xl border border-rose-400/30 bg-slate-900 p-6 text-center shadow-2xl"
              >
                <p className="text-xs uppercase tracking-[0.25em] text-rose-300">Forfeited</p>
                <h3 className="mt-2 text-2xl font-semibold text-white">
                  Game over — you were inactive
                </h3>
                <p className="mt-2 text-sm text-slate-400">
                  Twenty minutes passed without a move, so this run counts as a loss. The
                  clock stopped at {formatDuration(elapsedMs)}.
                </p>
                <div className="mt-5 flex flex-wrap justify-center gap-2">
                  <button
                    type="button"
                    onClick={restart}
                    className="inline-flex items-center justify-center rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-emerald-400"
                  >
                    Play again
                  </button>
                  {mode === "solo" ? (
                    <button
                      type="button"
                      onClick={newSoloGame}
                      className="inline-flex items-center justify-center rounded-lg border border-white/15 px-4 py-2 text-sm text-white hover:bg-white/5"
                    >
                      New deal
                    </button>
                  ) : (
                    <Link
                      href="/"
                      className="inline-flex items-center justify-center rounded-lg border border-white/15 px-4 py-2 text-sm text-white hover:bg-white/5"
                    >
                      Back to lobby
                    </Link>
                  )}
                </div>
                {savedResult === "failed" && (
                  <p className="mt-3 text-xs text-slate-500">
                    This attempt could not be saved to your profile.
                  </p>
                )}
                {savedResult === "offline" && (
                  <p className="mt-3 text-xs text-slate-500">
                    Offline run — this attempt was not saved.
                  </p>
                )}
              </div>
            </div>
          )}

          {session.won && !finishing && (
            <PostMatchAdSlot
              matchId={`solitaire:${session.mode}:${session.dateKey ?? session.seed}:${session.endedAtMs ?? "finished"}`}
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
  timerStartedAtMs?: unknown;
  lastActivityAtMs?: unknown;
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
      timerStartedAtMs: saved.timerStartedAtMs,
      lastActivityAtMs: saved.lastActivityAtMs,
      endedAtMs: saved.endedAtMs ?? null,
    };
  } catch {
    return null;
  }
}
