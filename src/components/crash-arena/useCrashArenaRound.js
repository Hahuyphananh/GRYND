"use client";
import { useReducer, useCallback, useRef, useMemo, useEffect, useState } from "react";
import {
  createRoundState,
  startRound,
  applyFold,
  crashRound,
  settleRound,
  nextRound,
} from "../../lib/crash-arena/roundSystem";
import {
  getCrashBotFoldTarget,
  getCrashBotFoldDecision,
} from "../../lib/crash-arena/botStrategy";
import { useSocket } from "../../context/SocketProvider";
import {
  crashArenaMatchRoom,
  CRASH_ARENA_TABLE_UPDATED,
  CRASH_ARENA_READY,
} from "../../lib/crash-arena/rooms";

const DEFAULT_AI_DIFFICULTY = "medium";

/**
 * Build the hand payload the local roundSystem.startRound expects from a
 * server round snapshot (poll / socket). Contributions come from the
 * entries; the wager from the round's big_blind (kept = table wager).
 */
function handFromRoundInfo(roundInfo) {
  const entries = Array.isArray(roundInfo?.entries) ? roundInfo.entries : [];
  return {
    wager: roundInfo?.bigBlind ?? roundInfo?.wager ?? null,
    carryOver: Number(roundInfo?.carryOver ?? 0),
    startedAt: roundInfo?.startedAt != null ? Number(roundInfo.startedAt) : null,
    // Continuous curve — never re-anchors; flightResumedAt = hand start.
    flightResumedAt:
      roundInfo?.flightResumedAt != null ? Number(roundInfo.flightResumedAt) : null,
    // Server-scheduled next-round deadline (epoch ms).
    nextRoundAt:
      roundInfo?.nextRoundAt != null ? Number(roundInfo.nextRoundAt) : null,
    contributions: entries.map((e) => ({
      userId: e.userId,
      amount: Number(e.contributed ?? 0),
      isActive: e.isActive !== false,
      allIn: e.allIn === true,
      foldedAtMultiplier:
        e.foldedAtMultiplier != null ? Number(e.foldedAtMultiplier) : null,
    })),
  };
}

/**
 * Apply server-side hand entries onto the local roster (used when
 * reconciling a hand that finished on the server). Local round state is
 * preserved — a player who already folded locally is never overwritten.
 */
function applyServerEntries(state, entries = []) {
  if (!Array.isArray(entries) || entries.length === 0) return state;
  let changed = false;
  const players = state.players.map((p) => {
    if (p.userId == null) return p;
    const entry = entries.find((e) => e.userId === p.userId);
    if (!entry) return p;
    if (entry.result === "won") {
      changed = true;
      return { ...p, isActive: true, folded: false, busted: false };
    }
    if (entry.result === "folded") {
      changed = true;
      return {
        ...p,
        isActive: false,
        folded: true,
        busted: false,
        foldedAtMultiplier:
          entry.foldedAtMultiplier != null
            ? Number(entry.foldedAtMultiplier)
            : p.foldedAtMultiplier,
      };
    }
    if (entry.result === "lost") {
      changed = true;
      return { ...p, isActive: false, folded: false, busted: true };
    }
    if (entry.result === "pending" && entry.isActive === false) {
      // Folded mid-hand (still pending until settle).
      changed = true;
      return { ...p, isActive: false, folded: true, busted: false };
    }
    return p;
  });
  return changed ? { ...state, players } : state;
}

/**
 * useCrashArenaRound — hook managing the Crash Arena round lifecycle (v2).
 *
 * Connects to CrashEngine by providing crashPoint/running and handling the
 * fold / crash callbacks. Calls real backend APIs for all operations, and
 * keeps the table in sync over the realtime socket:
 *
 *   • Joins the per-table socket room (`crash-arena:match:${tableId}`).
 *   • After successful API mutations it emits `crashArena:updated` so the
 *     other players at the table reconcile instantly.
 *   • On incoming `lobby:updated` events it reconciles hand state (round
 *     start, remote folds, settled hands) and calls `onRoomUpdate` so the
 *     page re-fetches the table roster.
 *
 * Hand-start model (all players synced):
 *   • First hand: seated players press "Start Round" (a ready vote — AI
 *     bots never vote, so the threshold is the seated human count, capped
 *     at 2). Once met the countdown begins, and on expiry `startNewRound()`
 *     fires — the button itself never triggers the rocket directly.
 *   • Later hands: no button — the auto-start countdown just runs.
 *
 * Fold model (v2):
 *   • Everyone antes the table wager; the curve climbs continuously; anyone
 *     can FOLD at any moment — no checkpoints, no deadlines.
 *   • `submitFold()` posts to /api/crash-arena/action and the server records
 *     the fold at the server-authoritative curve multiplier.
 *   • AI bots commit to a secret fold target per hand and fold through the
 *     same route (`forBot: true`) when the curve reaches it.
 *
 * Params:
 *   tableId     — database ID of the crash_arena_table
 *   wager       — round wager / ante amount
 *   roundNumber — starting round number
 *   onRoomUpdate — () => void — called when the socket signals a table
 *                  change so the page can re-fetch the roster.
 *
 * Returns:
 *   roundState, crashEngineRef, crashEngineProps
 *   readyVotes, markReady()
 *   startNewRound(), goToNextRound()
 *   submitFold(forBot, forBotUserId)
 *   joinTable(amount), leaveTable(), exitTable(), buyChips(name, amount)
 *   syncPlayers(), syncWaitingPlayers(), syncRoundFromServer(roundInfo)
 *   currentMultiplier, busy, error, myTip, revealedSignals, foldPause
 */
export default function useCrashArenaRound({
  tableId,
  wager = 10,
  roundNumber = 1,
  onRoomUpdate,
  isAi = false,
  aiDifficulty = DEFAULT_AI_DIFFICULTY,
  // Private tables: the host may add AI seats; only the host's client
  // drives them (the server rejects bot actions from non-hosts).
  isPrivate = false,
  amIHost = false,
  // Official Grynd icon key for the caller's own seat ("You"). Server
  // roster syncs override it with the authoritative value; this only
  // covers the brief local "You" placeholder before the first sync.
  myIconKey = "default",
}) {
  const { socket } = useSocket();
  const crashEngineRef = useRef(null);
  const currentRoundIdRef = useRef(null);
  // Per-bot fold targets: Map<userId, fold multiplier> the bot committed to
  // at hand start. The bot folds when the shared curve crosses its target.
  const botFoldTargetsRef = useRef(new Map());
  const botInFlightRef = useRef(new Set());
  // Whether THIS client is allowed to drive bot decisions (practice table
  // host, or the host of a private table that added AI seats).
  const canDriveBots = isAi || (isPrivate && amIHost);
  // Id + status of the most recent round reconciled from the server
  // (poll or socket) — guards against re-applying the same round on
  // every refetch while still allowing a status flip (running → settled)
  // to re-reconcile.
  const lastSyncedRef = useRef(null);
  // Live mirror of roundState so stable callbacks can read the current
  // roster without stale closures.
  const roundStateRef = useRef(null);
  // Current curve multiplier (throttled feed from CrashEngine) — drives
  // the AI bot fold decisions.
  const currentMultiplierRef = useRef(1.0);
  const onRoomUpdateRef = useRef(onRoomUpdate);
  onRoomUpdateRef.current = onRoomUpdate;

  const [busy, setBusy] = useReducer((_, v) => v, false);
  const [error, setError] = useReducer((_, v) => v, null);
  const [currentMultiplier, setCurrentMultiplier] = useState(1.0);
  // User ids of seated players who pressed "Start Round" for the first
  // hand. Shared across clients via socket broadcasts.
  const [readyVotes, setReadyVotes] = useState([]);

  // ── Private per-hand insight (signals) ─────────────────────────────
  // `myTip` = THIS caller's private insight for the running hand
  // (delivered per-caller by the tables poll / start-round response).
  // `revealedSignals` = tips that have gone public: folded seats' tips
  // while the hand runs, and every entered seat's tips once it settles.
  const [myTip, setMyTip] = useState(null);
  const [revealedSignals, setRevealedSignals] = useState(null);
  // Ref mirror so stable callbacks can merge reveals without stale closures.
  const revealedSignalsRef = useRef(null);

  const mergeRevealedSignals = useCallback((list) => {
    if (!Array.isArray(list) || list.length === 0) return;
    const cur = revealedSignalsRef.current || {};
    let next = null;
    for (const r of list) {
      if (!r || r.userId == null || !r.signal) continue;
      const prev = cur[r.userId];
      if (prev?.archetype !== r.signal.archetype || prev?.tier !== r.signal.tier) {
        next = next || { ...cur };
        next[r.userId] = r.signal;
      }
    }
    if (next) {
      revealedSignalsRef.current = next;
      setRevealedSignals(next); // new object identity → re-render
    }
  }, []);

  const resetSignals = useCallback(() => {
    revealedSignalsRef.current = {};
    setRevealedSignals({});
    setMyTip(null);
  }, []);

  // ── Fold pause (server-authoritative freeze) ─────────────────────────
  // Every accepted fold freezes the shared curve for FOLD_PAUSE_MS so the
  // whole table can read who folded + their revealed insight before the
  // rocket resumes. `foldPause` carries the frozen multiplier, the ABSOLUTE
  // resume deadline the server broadcast (so every client holds the SAME
  // value for the SAME window), and the fold's display data. `curveSegment`
  // is the live flight anchor the CrashEngine renders from — re-anchored on
  // every freeze and every resume so the engine's cap/hold machinery pins
  // the curve at the server's value.
  const [foldPause, setFoldPause] = useState(null);
  const [curveSegment, setCurveSegment] = useState({ from: 1, resumedAt: null });
  // Key of the flight anchor (roundNumber:startedAt) the segment was last
  // reset for — a pause freeze must survive re-renders of the same hand.
  const lastAnchorKeyRef = useRef(null);

  /**
   * Freeze the flight after an accepted fold, using the pause window the
   * server broadcast with the fold response/broadcast.
   *
   * @param {{from: number, until: number, handOver?: boolean}} pause
   * @param {{userId: number, foldedAtMultiplier?: number|null, signal?: object|null}} serverAction
   */
  const applyFoldPause = useCallback((pause, serverAction) => {
    if (!pause || !serverAction?.userId) return;
    if (!Number.isFinite(Number(pause.until)) || !Number.isFinite(Number(pause.from))) return;
    if (Number(pause.from) < 1) return;
    const rs = roundStateRef.current;
    if (!rs || rs.phase !== "running") return;
    const foldPlayer = (rs.players || []).find((p) => p.userId === serverAction.userId) ?? null;
    // Snap the segment anchor to the frozen value NOW: with curveCap pinned
    // to it, even a client a few ticks behind holds exactly this multiplier.
    setCurveSegment({ from: Number(pause.from), resumedAt: Date.now() });
    setFoldPause({
      from: Number(pause.from),
      until: Number(pause.until),
      // A fold-out (hand over) freeze must NOT auto-resume once `until`
      // passes — the sweep settles the hand at that deadline instead.
      handOver: pause.handOver === true,
      fold: {
        userId: serverAction.userId,
        name: foldPlayer?.name ?? null,
        isYou: Boolean(foldPlayer?.isYou),
        isBot: Boolean(foldPlayer?.isBot),
        multiplier:
          serverAction.foldedAtMultiplier != null
            ? Number(serverAction.foldedAtMultiplier)
            : Number(pause.from),
        signal: serverAction.signal ?? null,
      },
    });
  }, []);

  // Resume the flight the instant the server's absolute pause deadline hits:
  // re-anchor the segment to the frozen multiplier at that exact moment.
  // A fold-out freeze (handOver) NEVER resumes — the crash-check sweep
  // settles the hand at `until`, and the phase leaving "running" (the
  // clear-effect below) drops the pause when the results take over.
  useEffect(() => {
    if (!foldPause) return;
    if (foldPause.handOver) return;
    const until = foldPause.until;
    const delay = Math.max(0, until - Date.now());
    const timer = setTimeout(() => {
      setCurveSegment((seg) =>
        seg.from === foldPause.from
          ? { from: foldPause.from, resumedAt: until }
          : seg,
      );
      setFoldPause(null);
    }, delay);
    return () => clearTimeout(timer);
  }, [foldPause]);

  // ── Reducer ──────────────────────────────────────────────────────────

  const [roundState, dispatch] = useReducer((state, action) => {
    switch (action.type) {
      case "START_ROUND": {
        // Crash Arena keeps the crash point server-only until the crash —
        // this dispatch carries crashPoint: null for the whole hand (never
        // generated client-side). Anything non-null must be a positive
        // number or it's rejected.
        const crashPoint = action.crashPoint != null ? Number(action.crashPoint) : null;
        if (crashPoint != null && (!Number.isFinite(crashPoint) || crashPoint < 1)) {
          return state; // guard
        }
        const seedHash = action.seedHash ?? null;
        return startRound(state, wager, crashPoint, seedHash, null, action.hand ?? null);
      }
      case "FOLD":
      case "REMOTE_FOLD": {
        // Apply the server-authoritative fold (our own or another player's).
        if (state.phase !== "running") return state;
        const sa = action.serverAction;
        if (!sa || sa.userId == null) return state;
        const p = state.players.find((pl) => pl.userId === sa.userId);
        if (!p) return state;
        return applyFold(state, p.name, sa.foldedAtMultiplier ?? null, sa);
      }
      case "SETTLE_FROM_SERVER": {
        // A hand ended on the server (fold-out or crash) — apply the
        // authoritative ranked results.
        const res = action.results || {};
        let next = applyServerEntries(state, res.entries || []);
        // The settle scheduled the next round start (absolute deadline).
        if (res.nextRoundAt != null) {
          next = { ...next, nextRoundAt: Number(res.nextRoundAt) };
        }
        const winnerName = res.winnerUserId != null
          ? next.players.find((p) => p.userId === res.winnerUserId)?.name ?? null
          : null;
        // The winner's own entry carries the multiplier they folded at — a
        // fold-order winner folded before the crash, a fold-out winner did
        // not fold at all.
        const winnerEntry =
          res.winnerUserId != null && Array.isArray(res.entries)
            ? res.entries.find((e) => e.userId === res.winnerUserId)
            : null;
        const wonByFold =
          winnerEntry?.foldedAtMultiplier != null;
        const winnerMultiplier = wonByFold
          ? Number(winnerEntry.foldedAtMultiplier)
          : null;
        const fee = Number(res.rake ?? 0);
        const payout = Number(res.payout ?? 0);
        const payoutGross = Number(res.payoutGross ?? payout + fee);
        next = {
          ...next,
          phase: "crashed",
          // The server crash broadcast records the ACTUAL crash multiplier
          // before these results land (crashRound sets it) — keep it.
          crashMultiplier: next.crashMultiplier ?? null,
        };
        return settleRound(next, {
          winner: winnerName,
          winnerMultiplier,
          wonByFold,
          payout,
          fee,
          payoutGross,
          potDistributed: payoutGross,
          carryOver: Number(res.carryOver ?? 0),
          payouts: Array.isArray(res.payouts)
            ? res.payouts.map((r) => ({
                userId: r.userId,
                rank: Number(r.rank || 0),
                amount: Number(r.amount || 0),
              }))
            : [],
          foldedPlayers: [],
          bustedPlayers: [],
          activeAtCrash: Array.isArray(res.activeAtCrash) ? res.activeAtCrash : [],
        });
      }
      case "CRASH":
        return settleRound(crashRound(state, action.multiplier));
      case "SYNC_ROUND": {
        // Reconcile the server's latest round into local state. Covers the
        // cases where another player started / settled the hand and this
        // client missed the live event (late join, socket drop).
        const sr = action.round;
        if (!sr || !sr.id) return state;

        let next = state;
        // Crash Arena: crashPoint is null while running (server-only); it is
        // only present on settled rounds (revealed after the crash).
        const cp = sr.crashPoint != null ? Number(sr.crashPoint) : null;
        const hasValidCp = cp != null && Number.isFinite(cp) && cp >= 1;
        const hand = handFromRoundInfo(sr);
        // The server-scheduled next-round deadline travels with the round
        // snapshot so a client that missed the settle broadcast still
        // counts down to the exact same moment.
        if (sr.nextRoundAt != null) {
          next = { ...next, nextRoundAt: Number(sr.nextRoundAt) };
        }

        if (sr.status === "running") {
          // A client still showing the previous hand's results when the
          // server already started the next round (settle → countdown →
          // start) catches up directly instead of waiting for a click.
          if (next.phase === "settling") {
            next = nextRound(next);
          }
          if (next.phase === "waiting") {
            next = startRound(next, action.wager, null, sr.seedHash ?? null, null, hand);
          }
        }

        if (sr.status === "settled" || sr.status === "crashed") {
          if (next.phase !== "settling") {
            if (next.phase === "waiting") {
              next = startRound(next, action.wager, hasValidCp ? cp : null, sr.seedHash ?? null, null, hand);
            }
            if (next.phase === "running") {
              // Apply server-side results FIRST (won → still active, folded
              // → folded, lost → busted), then settle directly.
              next = applyServerEntries(next, sr.entries);
              next = settleRound(next);
            }
            if (next.phase === "crashed") {
              next = settleRound(next);
            }
          }
        }

        return next;
      }
      case "NEXT_ROUND":
        return nextRound(state);
      case "SET_PLAYERS":
        return { ...state, players: action.players };
      case "SYNC_PLAYERS": {
        // Merge the server's seated roster into the local player list.
        // Local round state (contributed/folded/busted/sit-out) is
        // preserved; in the waiting phase the roster mirrors the server
        // exactly.
        const serverPlayers = action.serverPlayers || [];
        const localPlayers = state.players;
        const inLiveRound = state.phase !== "waiting";

        const serverByName = new Map();
        for (const sp of serverPlayers) serverByName.set(sp.name, sp);

        const mergedByName = new Map();
        for (const lp of localPlayers) mergedByName.set(lp.name, lp);

        // NOTE: players are keyed by display name (pre-existing roundSystem
        // design) — duplicate display names at one table would collapse.

        // Drop local players who are no longer seated (unless mid-round,
        // where we keep the roster stable so actions/busts stay visible).
        if (!inLiveRound) {
          for (const name of [...mergedByName.keys()]) {
            if (!serverByName.has(name)) mergedByName.delete(name);
          }
        }

        for (const sp of serverByName.values()) {
          const lp = mergedByName.get(sp.name);
          if (lp) {
            // Preserve local round state; refresh balance for remote players
            // only ("You"'s balance is tracked locally during rounds).
            // Official icon key always flows from the server roster.
            mergedByName.set(sp.name, {
              ...lp,
              iconKey: sp.iconKey || lp.iconKey || "default",
              isYou: lp.isYou || Boolean(sp.isYou),
              userId: lp.userId ?? sp.userId ?? null,
              isBot: Boolean(sp.isBot) || lp.isBot === true,
              aiDifficulty: sp.aiDifficulty ?? lp.aiDifficulty ?? null,
              balance: lp.isYou ? lp.balance : Number(sp.balance),
            });
          } else {
            // A player first seen mid-round is seated but was not locked
            // into the running hand — keep them out until the next hand.
            mergedByName.set(sp.name, {
              name: sp.name,
              userId: sp.userId ?? null,
              iconKey: sp.iconKey || "default",
              balance: Number(sp.balance),
              isYou: Boolean(sp.isYou),
              isBot: Boolean(sp.isBot),
              aiDifficulty: sp.aiDifficulty ?? null,
              isSittingOut: false,
              isPlaying: !inLiveRound,
              contributed: 0,
              isActive: false,
              folded: false,
              foldedAtMultiplier: null,
              lastAction: null,
              allIn: false,
              cashoutMultiplier: null,
              busted: false,
            });
          }
        }

        return { ...state, players: [...mergedByName.values()] };
      }
      case "SYNC_WAITING_PLAYERS":
        return { ...state, waitingPlayers: action.waitingPlayers || [] };
      case "BUY_CHIPS":
        return {
          ...state,
          players: state.players.map((p) =>
            p.name === action.playerName
              ? { ...p, balance: Number(p.balance) + Number(action.amount) }
              : p,
          ),
        };
      default:
        return state;
    }
  }, null, () => ({
    ...createRoundState([], roundNumber),
    waitingPlayers: [],
  }));

  // Keep a live mirror of roundState for stable callbacks.
  roundStateRef.current = roundState;

  // A hand that leaves "running" (crash, settle, fold-out) ends the pause
  // immediately — the results/explosion already took over the screen.
  useEffect(() => {
    if (roundState.phase !== "running" && foldPause) {
      setFoldPause(null);
    }
  }, [roundState.phase, foldPause]);

  // Anchor the flight at the start of every new hand. Each hand has its own
  // absolute startedAt, so the segment (and any leftover pause) resets
  // exactly once per hand without touching the freeze applied mid-hand.
  useEffect(() => {
    if (roundState.phase !== "running") return;
    const key = `${roundState.roundNumber}:${roundState.startedAt ?? ""}`;
    if (lastAnchorKeyRef.current === key) return;
    lastAnchorKeyRef.current = key;
    setCurveSegment({
      from: 1,
      resumedAt: roundState.flightResumedAt ?? roundState.startedAt,
    });
    setFoldPause(null);
  }, [roundState.phase, roundState.roundNumber, roundState.startedAt, roundState.flightResumedAt]);

  // Prune ready votes that belong to players who are no longer seated.
  useEffect(() => {
    const seatedIds = new Set(
      (roundState.players || [])
        .map((p) => p.userId)
        .filter((id) => id != null),
    );
    setReadyVotes((prev) => {
      const kept = prev.filter((id) => seatedIds.has(id));
      return kept.length === prev.length ? prev : kept;
    });
  }, [roundState.players]);

  // ── First-round ready votes ──────────────────────────────────────────

  const markReady = useCallback(() => {
    const me = (roundStateRef.current?.players || []).find((p) => p.isYou);
    if (!me?.userId) return;
    setReadyVotes((prev) =>
      prev.includes(me.userId) ? prev : [...prev, me.userId],
    );
    if (socket) {
      socket.emit(CRASH_ARENA_READY, {
        tableId,
        ready: true,
        readyUserId: me.userId,
      });
    }
  }, [tableId, socket]);

  // ── Crash callback ──────────────────────────────────────────────────
  // Declared BEFORE submitFold (which references it) to avoid a TDZ
  // ReferenceError — deps arrays are evaluated at render, not call time.

  const handleCrash = useCallback((multiplier) => {
    dispatch({ type: "CRASH", multiplier });
    // No settle call and no room fanout here: the realtime-server crash
    // sweep settles the hand at the server-authoritative crash moment and
    // broadcasts the crash (multiplier + results) to the whole room itself.
    // This callback only drives local round state.
  }, []);

  /**
   * Apply the server-authoritative round results (settle payload).
   *
   * Guards against re-settling the SAME hand more than once, which was
   * making the results popup reappear mid-countdown with the previous
   * hand's win:
   *   • a fold that raced the crash returns results in the fold response
   *     AND the crash sweep re-broadcasts them ~1s later;
   *   • the 10s roster poll re-reads the settled round after the modal
   *     was dismissed, and the SYNC_ROUND catch-up would settle it again.
   *
   * Once a round's results have been applied, `lastSyncedRef` is marked
   * settled so every later arrival (socket broadcast or poll) is skipped.
   */
  const applyServerSettlement = useCallback((results, roundId) => {
    if (!results) return;
    if (roundId == null) return;
    const rid = String(roundId);
    const last = lastSyncedRef.current;
    const alreadySettled = last && last.id === rid && last.status === "settled";
    // While the results are still on screen (settling) a re-sent
    // authoritative payload (fold response + crash sweep both carry it)
    // is an upgrade over locally-mirrored numbers — apply it. Once the
    // player advanced to the next hand (waiting), re-applying would
    // resurrect the results popup mid-countdown, so skip.
    if (alreadySettled && roundStateRef.current?.phase !== "settling") return;
    lastSyncedRef.current = { id: rid, status: "settled" };
    dispatch({ type: "SETTLE_FROM_SERVER", results });
  }, []);

  /**
   * Submit a FOLD for the current hand (or for a bot via `forBot`). The
   * server records the fold at the server-authoritative curve multiplier.
   *
   * @param {boolean} [forBot] act on behalf of a bot (no account)
   * @param {number|null} [forBotUserId] the bot's user id at a private
   *   table (the server validates it is a reserved bot seated there);
   *   practice tables resolve their single bot automatically
   * @returns {Promise<boolean>} true when the server accepted the fold
   */
  const submitFold = useCallback(async (forBot = false, forBotUserId = null) => {
    const roundId = currentRoundIdRef.current;
    if (!roundId) {
      if (!forBot) setError("No active hand");
      return false;
    }
    const rs = roundStateRef.current;
    if (rs.phase !== "running") {
      if (!forBot) setError("The hand is not running");
      return false;
    }
    if (forBot && forBotUserId != null) {
      botInFlightRef.current.add(forBotUserId);
    }

    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/crash-arena/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          roundId,
          action: "fold",
          ...(forBot ? { forBot: true } : {}),
          ...(forBot && forBotUserId != null ? { forBotUserId } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        // The fold raced the crash and lost (hand already settled) — not an
        // error for the bot; surface it for the human.
        if (forBot && forBotUserId != null) {
          botInFlightRef.current.delete(forBotUserId);
        }
        if (!forBot) setError(data?.error || "Fold rejected");
        return false;
      }
      const d = data.data;
      dispatch({
        type: "FOLD",
        serverAction: d.action,
      });
      // Our own fold (or a bot seat we drive) just went public — the
      // insight is revealed the moment the fold is accepted.
      if (d.action?.signal) {
        mergeRevealedSignals([{ userId: d.action.userId, signal: d.action.signal }]);
      }
      // The server froze the curve for the fold reveal — hold it at the
      // broadcast multiplier until the absolute `until` deadline.
      if (d.pause) {
        applyFoldPause(d.pause, d.action);
      }
      // The fold raced the crash and lost — the server settled the hand at
      // its deterministic crash moment. Record the crash locally (actual
      // multiplier) and animate the explosion before the results land.
      if (d.crashed && d.crashMultiplier != null) {
        handleCrash(Number(d.crashMultiplier));
        crashEngineRef.current?.triggerCrash?.(Number(d.crashMultiplier));
      }
      if (d.handOver && d.results) {
        applyServerSettlement(d.results, roundId);
        // Every entered seat's insight is public once the hand settles.
        mergeRevealedSignals(d.results.signals);
      }
      // Tell the rest of the table instantly.
      if (socket) {
        socket.emit(CRASH_ARENA_READY, {
          tableId,
          action: {
            userId: d.action.userId,
            action: "fold",
            contributed: d.action.contributed,
            foldedAtMultiplier: d.action.foldedAtMultiplier ?? null,
          },
          ...(d.pause ? { pause: d.pause } : {}),
          ...(d.handOver && d.results
            ? { handOver: true, results: d.results }
            : {}),
        });
      }
      return true;
    } catch (err) {
      if (forBot && forBotUserId != null) {
        botInFlightRef.current.delete(forBotUserId);
      }
      if (!forBot) setError("Network error submitting fold");
      return false;
    } finally {
      if (forBot && forBotUserId != null) {
        botInFlightRef.current.delete(forBotUserId);
      }
      setBusy(false);
    }
  }, [tableId, socket, handleCrash, applyServerSettlement, mergeRevealedSignals, applyFoldPause]);

  /**
   * Assign a fresh fold target to every seated bot that doesn't have one
   * for the current hand (per-bot difficulty wins; practice bots fall back
   * to the table's difficulty).
   */
  const ensureBotFoldTargets = useCallback(() => {
    if (!canDriveBots) return;
    const rs = roundStateRef.current;
    if (!rs || rs.phase !== "running") return;
    for (const bot of rs.players) {
      if (!bot.isBot || bot.userId == null) continue;
      if (!botFoldTargetsRef.current.has(bot.userId)) {
        botFoldTargetsRef.current.set(
          bot.userId,
          getCrashBotFoldTarget(bot.aiDifficulty ?? aiDifficulty),
        );
      }
    }
  }, [canDriveBots, aiDifficulty]);

  const handleMultiplierUpdate = useCallback((multiplier, crashed) => {
    currentMultiplierRef.current = multiplier;
    setCurrentMultiplier(multiplier);
    if (crashed || !canDriveBots) return;
    const rs = roundStateRef.current;
    if (!rs || rs.phase !== "running") return;
    // Lazy targets: assign when the first multiplier tick arrives (hand may
    // have started before this client synced).
    ensureBotFoldTargets();
    for (const bot of rs.players) {
      if (!bot.isBot || bot.userId == null) continue;
      if (!bot.isActive || bot.folded || bot.busted || bot.allIn) continue;
      if (botInFlightRef.current.has(bot.userId)) continue;
      const target = botFoldTargetsRef.current.get(bot.userId);
      if (target == null) continue;
      if (getCrashBotFoldDecision({ multiplier, target, allIn: bot.allIn })) {
        submitFold(true, bot.userId);
      }
    }
  }, [canDriveBots, ensureBotFoldTargets, submitFold]);

  // ── Hand control ────────────────────────────────────────────────────

  const startNewRound = useCallback(async () => {
    if (!tableId) return;
    // Only the first client whose countdown expires should create the
    // hand — once anyone starts it, everyone else syncs via broadcast.
    if (roundStateRef.current?.phase !== "waiting") return;
    setBusy(true);
    setError(null);
    currentMultiplierRef.current = 1.0;
    setCurrentMultiplier(1.0);
    try {
      const res = await fetch("/api/crash-arena/start-round", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ tableId }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        // A concurrent start (another player's timer) is expected — ignore.
        if (!/already in progress/i.test(data?.error || "")) {
          setError(data?.error || "Failed to start hand");
        }
        return;
      }
      // NOTE: the response deliberately has NO crashPoint — it stays
      // server-only until the crash. Only the seed commitment + the hand
      // snapshot (plus the server start time for curve alignment) go out.
      const { roundId, seedHash, startedAt, hand } = data.data;
      currentRoundIdRef.current = roundId;
      lastSyncedRef.current = { id: String(roundId), status: "running" };
      setReadyVotes([]);
      // A fresh hand deals fresh private insights — clear the previous
      // round's revealed tips and take our new private tip (the starter
      // gets theirs inline; everyone else's arrives on the first poll).
      revealedSignalsRef.current = {};
      setRevealedSignals({});
      setMyTip(data.data.myTip ?? null);
      botFoldTargetsRef.current = new Map();
      botInFlightRef.current = new Set();
      dispatch({
        type: "START_ROUND",
        crashPoint: null,
        seedHash,
        hand: { ...(hand || {}), startedAt },
      });
      // Broadcast so the other players' CrashEngines start in sync.
      if (socket) {
        socket.emit(CRASH_ARENA_READY, {
          tableId,
          roundStarted: true,
          roundId,
          seedHash,
          startedAt,
          hand: { ...(hand || {}), startedAt },
        });
      }
    } catch (err) {
      setError("Network error starting hand");
    } finally {
      setBusy(false);
    }
  }, [tableId, socket]);

  const goToNextRound = useCallback(() => {
    dispatch({ type: "NEXT_ROUND" });
    currentRoundIdRef.current = null;
    setReadyVotes([]);
    currentMultiplierRef.current = 1.0;
    setCurrentMultiplier(1.0);
    revealedSignalsRef.current = {};
    setRevealedSignals({});
    setMyTip(null);
    botFoldTargetsRef.current = new Map();
    botInFlightRef.current = new Set();
  }, []);

  // ── Hand reconciliation (from poll or socket) ───────────────────────

  /**
   * Reconcile the server's latest round into local round state.
   * Safe to call on every tables fetch: rounds already processed are
   * skipped, and finished rounds are only auto-applied when they ended
   * recently (so a page reload doesn't resurrect stale results).
   */
  const syncRoundFromServer = useCallback((roundInfo) => {
    if (!roundInfo?.id) return;
    const roundId = String(roundInfo.id);
    const roundStatus = roundInfo.status;

    // Private insight delivery: `myTip` (this caller's running-hand tip)
    // and `revealedSignals` (public tips — folded seats while running,
    // all seats once settled) travel with the round snapshot so a client
    // that missed the live broadcast still reconciles them on the poll.
    mergeRevealedSignals(roundInfo.revealedSignals);
    if (roundInfo.myTip != null) setMyTip(() => roundInfo.myTip);

    // Skip only when this exact round AND status were already
    // reconciled — a status flip (running → settled) must re-reconcile
    // so a client that missed the crash (throttled tab, socket blip)
    // doesn't stay stuck in "running" forever.
    const last = lastSyncedRef.current;
    if (last && last.id === roundId && last.status === roundStatus) return;

    const isActive = roundStatus === "running";
    const roundSettled = roundStatus === "settled" || roundStatus === "crashed";
    const wasRunning = roundStateRef.current?.phase === "running";
    let recent = true;
    if (roundInfo.createdAt) {
      const created = new Date(roundInfo.createdAt).getTime();
      if (Number.isFinite(created)) {
        recent = Date.now() - created < 90_000; // 90s window for finished rounds
      }
    }
    if (!isActive && !recent) return;

    lastSyncedRef.current = { id: roundId, status: roundStatus };
    // A running round is the one folds must target.
    if (isActive) {
      currentRoundIdRef.current = roundId;
    }
    dispatch({ type: "SYNC_ROUND", round: roundInfo, wager });

    // The poll caught a hand that already CRASHED while we were mid-flight
    // (missed broadcast / socket blip) — animate the explosion at the
    // revealed crash point. Fold-out wins are skipped: they have a winner
    // entry, and no crash ever happened for that hand.
    if (wasRunning && roundSettled) {
      const entries = Array.isArray(roundInfo.entries) ? roundInfo.entries : [];
      const hasWinner = entries.some((e) => e?.result === "won");
      const cp = roundInfo.crashPoint != null ? Number(roundInfo.crashPoint) : null;
      if (!hasWinner && cp != null && Number.isFinite(cp) && cp >= 1) {
        crashEngineRef.current?.triggerCrash?.(cp);
      }
    }
  }, [wager, mergeRevealedSignals]);

  // ── Realtime room wiring ─────────────────────────────────────────────

  useEffect(() => {
    if (!tableId || !socket) return;
    const roomId = crashArenaMatchRoom(tableId);

    // (Re)join the per-table room. The server arms a disconnect grace
    // timer whenever our socket drops, and only re-joining cancels it —
    // so we must re-emit join_room on EVERY socket (re)connection,
    // including Socket.IO auto-reconnects after a network blip.
    // Otherwise a page refresh / reconnect would quietly release the
    // seat (and refund the balance) once the grace window expires.
    const joinRoom = () => socket.emit("join_room", { roomId });
    joinRoom();

    const onUpdate = (payload = {}) => {
      // Another player started a hand — start ours with the same
      // server-authoritative hand snapshot immediately.
      if (payload?.roundStarted) {
        // Fresh hand → fresh private insights for everyone.
        revealedSignalsRef.current = {};
        setRevealedSignals({});
        setMyTip(null);
        syncRoundFromServer({
          id: payload.roundId,
          status: "running",
          // The crash point is server-only — it never travels with the
          // round-start broadcast; clients fly the curve blind.
          crashPoint: null,
          seedHash: payload.seedHash ?? null,
          startedAt: payload.startedAt ?? null,
          bigBlind: payload.hand?.wager ?? null,
          carryOver: payload.hand?.carryOver ?? 0,
          flightResumedAt: payload.hand?.flightResumedAt ?? null,
          entries: (payload.hand?.contributions || []).map((c) => ({
            userId: c.userId,
            contributed: c.amount,
            result: "pending",
            isActive: true,
            allIn: Boolean(c.allIn),
            lastAction: "ante",
          })),
        });
      }
      // The server announced the crash (realtime-server crash sweep) —
      // settle locally and animate the explosion at the now-revealed
      // multiplier. The results (handOver) land right after.
      if (payload?.crashed && payload?.multiplier != null) {
        handleCrash(Number(payload.multiplier));
        crashEngineRef.current?.triggerCrash?.(Number(payload.multiplier));
      }
      // Another player folded — mirror it live. The folder's private
      // insight went public the moment the fold was accepted, so reveal it.
      if (payload?.action?.userId) {
        dispatch({
          type: "REMOTE_FOLD",
          serverAction: payload.action,
        });
        if (payload.action.signal) {
          mergeRevealedSignals([{ userId: payload.action.userId, signal: payload.action.signal }]);
        }
        // The server froze the curve for the reveal — hold it until the
        // same absolute deadline the acting player is holding to.
        if (payload?.pause) {
          applyFoldPause(payload.pause, payload.action);
        }
      }
      // A fold-out / crash settled the hand on the server — apply results
      // (only once per hand: the fold-response path may already have
      // applied the same authoritative payload, and the poll re-reads the
      // settled round after the modal was dismissed).
      if (payload?.handOver && payload?.results) {
        applyServerSettlement(payload.results, currentRoundIdRef.current);
        // Every entered seat's insight is public once the hand settles.
        mergeRevealedSignals(payload.results.signals);
      }
      // A seated player pressed "Start Round" (first-round ready vote).
      if (payload?.ready && payload?.readyUserId) {
        setReadyVotes((prev) =>
          prev.includes(payload.readyUserId)
            ? prev
            : [...prev, payload.readyUserId],
        );
      }
      // Anything else (joined/left/crashed/settled) → let the page
      // re-fetch the roster + latest round.
      onRoomUpdateRef.current?.();
    };

    socket.on(CRASH_ARENA_TABLE_UPDATED, onUpdate);
    socket.on("connect", joinRoom);

    return () => {
      socket.off(CRASH_ARENA_TABLE_UPDATED, onUpdate);
      socket.off("connect", joinRoom);
      socket.emit("leave_room", { roomId });
    };
  }, [tableId, socket, syncRoundFromServer, handleCrash, applyServerSettlement, mergeRevealedSignals, applyFoldPause]);

  // ── Player management (API calls) ────────────────────────────────────

  const joinTable = useCallback(async (buyIn, joinCode = null) => {
    if (!tableId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/crash-arena/join", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          tableId,
          buyInAmount: buyIn,
          // Private tables are invite-only — the server validates the code
          // (hosts and members are exempt).
          ...(joinCode ? { joinCode } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setError(data?.error || "Failed to join table");
        return false;
      }
      const me = {
        name: "You",
        iconKey: myIconKey,
        balance: buyIn,
        isYou: true,
        isSittingOut: false,
        isPlaying: true,
        contributed: 0,
        isActive: false,
        folded: false,
        foldedAtMultiplier: null,
        lastAction: null,
        allIn: false,
        cashoutMultiplier: null,
        busted: false,
      };
      if (data.data?.status === "waiting") {
        // Joined mid-round — land on the wait list until this round ends.
        dispatch({
          type: "SYNC_WAITING_PLAYERS",
          waitingPlayers: [
            ...(roundState.waitingPlayers || []).filter((p) => !p.isYou),
            me,
          ],
        });
      } else {
        // Add/replace "You" in the local player list (roster may already
        // contain a synced copy of the seat).
        dispatch({
          type: "SET_PLAYERS",
          players: [
            ...roundState.players.filter((p) => p.name !== "You"),
            me,
          ],
        });
      }
      if (socket) socket.emit(CRASH_ARENA_READY, { tableId, joined: true });
      return true;
    } catch (err) {
      setError("Network error joining table");
      return false;
    } finally {
      setBusy(false);
    }
  }, [tableId, roundState.players, roundState.waitingPlayers, socket, myIconKey]);

  /**
   * "Leave" — step off the table onto the wait list (balance stays at the
   * table so the player can come back next round or cash out later).
   *
   * @returns {Promise<boolean>} true when the server confirmed the leave.
   */
  const leaveTable = useCallback(async () => {
    if (!tableId) return false;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/crash-arena/leave", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ tableId }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        // Already released (cleanup ran, another tab exited) — nothing to
        // do, treat it as a confirmed leave so callers can move on.
        if (/not at this table/i.test(data?.error || "")) return true;
        setError(data?.error || "Failed to leave table");
        return false;
      }
      const me = (roundStateRef.current?.players || []).find((p) => p.isYou);
      dispatch({
        type: "SET_PLAYERS",
        players: roundState.players.filter((p) => !p.isYou),
      });
      dispatch({
        type: "SYNC_WAITING_PLAYERS",
        waitingPlayers: me
          ? [...(roundState.waitingPlayers || []), { ...me, isSittingOut: false, cashoutMultiplier: null, busted: false }]
          : roundState.waitingPlayers || [],
      });
      if (socket) socket.emit(CRASH_ARENA_READY, { tableId, left: true });
      return true;
    } catch (err) {
      setError("Network error leaving table");
      return false;
    } finally {
      setBusy(false);
    }
  }, [tableId, roundState.players, roundState.waitingPlayers, socket]);

  /**
   * "Back to Lobby" — permanently leave: refund remaining balance to the
   * wallet and mark the player as left. This is the ONLY in-page path that
   * releases the seat server-side — plain navigation links would leave the
   * player registered at the table forever.
   *
   * @returns {Promise<boolean>} true when the server confirmed the exit.
   */
  const exitTable = useCallback(async () => {
    if (!tableId) return false;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/crash-arena/leave", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ tableId, permanent: true }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        // Already released (cleanup ran, another tab exited) — the player
        // is effectively out of the table, so treat it as a confirmed
        // permanent leave (otherwise they'd be stranded with no way back).
        if (/not at this table/i.test(data?.error || "")) return true;
        setError(data?.error || "Failed to leave table");
        return false;
      }
      dispatch({
        type: "SET_PLAYERS",
        players: roundState.players.filter((p) => !p.isYou),
      });
      dispatch({
        type: "SYNC_WAITING_PLAYERS",
        waitingPlayers: (roundState.waitingPlayers || []).filter((p) => !p.isYou),
      });
      if (socket) socket.emit(CRASH_ARENA_READY, { tableId, left: true });
      return true;
    } catch (err) {
      setError("Network error leaving table");
      return false;
    } finally {
      setBusy(false);
    }
  }, [tableId, roundState.players, roundState.waitingPlayers, socket]);

  const buyChips = useCallback((playerName, amount) => {
    // TODO: Add API endpoint for buying more chips at table
    dispatch({ type: "BUY_CHIPS", playerName, amount });
  }, []);

  /**
   * Sync the server's seated roster into the local player list.
   * Used after joining from the lobby, on room load, and on periodic refresh
   * so the room shows every seated player, not just locally-known ones.
   */
  const syncPlayers = useCallback((serverPlayers) => {
    dispatch({ type: "SYNC_PLAYERS", serverPlayers });
  }, []);

  /**
   * Sync the server's wait-list roster into local state.
   */
  const syncWaitingPlayers = useCallback((serverWaiting) => {
    dispatch({ type: "SYNC_WAITING_PLAYERS", waitingPlayers: serverWaiting });
  }, []);

  // ── CrashEngine props ────────────────────────────────────────────────

  // Crash Arena has no cashout — the engine's cashout callback is a no-op
  // (kept so the shared CrashEngine component stays untouched). The crash
  // point stays null (server-only until the crash): the engine flies blind
  // and the hook triggers the explosion when the server announces the crash.
  //
  // The curve is CONTINUOUS in v2 (no betting checkpoints) EXCEPT for fold
  // pauses: during a pause the engine is fed curveFrom = the frozen
  // multiplier, a freshly-snapped anchor, and curveCap = the same value, so
  // its cap/hold machinery pins the flight at the server's frozen multiplier
  // for every client. On resume the anchor re-snaps to the frozen value at
  // the server's absolute deadline and the curve keeps climbing from there.
  const crashEngineProps = useMemo(() => {
    const running = roundState.phase === "running";
    const isPaused = running && foldPause != null;
    return {
      crashPoint: roundState.crashPoint || null,
      startedAt: roundState.startedAt,
      running,
      curveFrom: curveSegment.from,
      curveResumedAt:
        curveSegment.resumedAt ?? roundState.flightResumedAt ?? roundState.startedAt,
      curveCap: isPaused ? foldPause.from : null,
      onCashout: () => {},
      onCrash: handleCrash,
      onMultiplierUpdate: handleMultiplierUpdate,
    };
  }, [roundState.crashPoint, roundState.startedAt, roundState.phase, roundState.flightResumedAt, curveSegment, foldPause, handleCrash, handleMultiplierUpdate]);

  return {
    roundState,
    crashEngineRef,
    crashEngineProps,
    readyVotes,
    markReady,
    startNewRound,
    goToNextRound,
    submitFold,
    syncPlayers,
    syncWaitingPlayers,
    syncRoundFromServer,
    joinTable,
    leaveTable,
    exitTable,
    buyChips,
    currentMultiplier,
    busy,
    error,
    myTip,
    revealedSignals,
    foldPause,
  };
}