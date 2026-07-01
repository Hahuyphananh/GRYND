// src/lib/blackjack-pvp/serverStore.js
//
// Server-side canonical helpers for the Blackjack PvP match system.
//
// Why a dedicated serverStore (mirrors `src/lib/roulette-pvp/serverStore.js`):
//   The match state machine has to be authoritative on the server:
//     * matchmaking lock (stake-keyed) prevents lobby-race duplicates
//     * 3-second ready banner auto-advance (waits without manual click)
//     * deal a fresh 52-card shoe per match, deal 2 cards to each seat
//     * round-deadline enforcement (AFK → force `stood` so the round
//       can resolve)
//     * round resolution → BETWEEN_ROUNDS transition (Best-of-3 "next
//       round incoming" screen) → next round dealing with a fresh
//       shuffled deck and reset swap/hold counters
//     * Swap + Hold + Use-Held sub-actions with per-round usage caps
//   Centralising this in a tiny module keeps the API routes thin and
//   makes it possible to test the state machine in isolation.

import { eq, and, sql, isNull } from "drizzle-orm";
import { db } from "../../db/client";
import {
  blackjackPvpMatches,
  blackjackPvpRounds,
  users,
} from "../../db/schema";
import { sendSystemNotificationEmail } from "../emails/system";
import {
  ACTION_TYPE,
  BETWEEN_ROUNDS_MS,
  BLACKJACK_PVP_LOCK_NAMESPACE,
  BUSTED_SCORE_SENTINEL,
  HELD_RESOLUTION,
  HOLD_LIMIT_PER_ROUND,
  HOUSE_FEE_PCT,
  MATCH_STATUS,
  PLAYABLE_STATES,
  PLAYER_STATE,
  READY_WINDOW_MS,
  RESULT,
  ROUND_DEADLINE_MS,
  ROUND_TIMER_SECONDS,
  SWAP_LIMIT_PER_ROUND,
  TOTAL_ROUNDS,
  USE_HELD_SUBACTIONS,
  buildDeck,
  calcHandValue,
  decideRoundWinner,
  drawCards,
  effectiveHandScore,
} from "./constants";

const ROUND_STATUS_BY_NUMBER = {
  1: MATCH_STATUS.ROUND_1,
  2: MATCH_STATUS.ROUND_2,
  3: MATCH_STATUS.ROUND_3,
};

// Map a 1-based `currentRound` to the canonical match.status enum.
export function statusForRoundNumber(roundNumber) {
  const clamped = Math.max(1, Math.min(TOTAL_ROUNDS, Number(roundNumber) || 1));
  return ROUND_STATUS_BY_NUMBER[clamped] ?? MATCH_STATUS.ROUND_1;
}

// Per-row lifecycle helper: derive the round-deadline duration in ms
// from a match row, falling back to the server-side default if the
// column is null/0 (e.g. older rows that pre-date migration 0042).
function roundDeadlineMs(match) {
  const t = Number(match?.roundTimerSeconds);
  if (Number.isFinite(t) && t > 0) return t * 1000;
  return ROUND_DEADLINE_MS;
}

// Stable deterministic hash from numeric stake to a signed 32-bit int.
// Used purely as an advisory-lock key.
function hashStakeToInt(stake) {
  const fixed = Number(stake).toFixed(2);
  let h = 2166136261;
  for (let i = 0; i < fixed.length; i++) {
    h ^= fixed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h | 0) & 0x7fffffff;
}

// ── Lobby helpers ─────────────────────────────────────────────────────
export async function listOpenMatches({ limit = 30 } = {}) {
  return db
    .select({
      id: blackjackPvpMatches.id,
      player1Id: blackjackPvpMatches.player1Id,
      stakeAmount: blackjackPvpMatches.stakeAmount,
      createdAt: blackjackPvpMatches.createdAt,
    })
    .from(blackjackPvpMatches)
    .where(
      and(
        eq(blackjackPvpMatches.status, MATCH_STATUS.WAITING),
        isNull(blackjackPvpMatches.player2Id),
      ),
    )
    .orderBy(sql`${blackjackPvpMatches.createdAt} DESC`)
    .limit(limit);
}

export function isParticipant(match, userId) {
  return Boolean(
    match && userId && (match.player1Id === userId || match.player2Id === userId),
  );
}

function isPlayer1(match, userId) {
  return Boolean(match && userId && match.player1Id === userId);
}

// String identifiers used to pick the right per-seat column on the
// blackjack_pvp_matches row. We keep these consistent with the schema
// so future drift would be caught at compile time.
const SEAT_FIELDS = Object.freeze({
  player1: {
    hand: "player1Hand",
    state: "player1State",
    swapsUsed: "player1SwapsUsed",
    holdsUsed: "player1HoldsUsed",
    heldCard: "player1HeldCard",
    heldResolved: "player1HeldResolved",
  },
  player2: {
    hand: "player2Hand",
    state: "player2State",
    swapsUsed: "player2SwapsUsed",
    holdsUsed: "player2HoldsUsed",
    heldCard: "player2HeldCard",
    heldResolved: "player2HeldResolved",
  },
});

// ── createOrJoin ─────────────────────────────────────────────────────
// Stake-based matchmaking with the same race-protection pattern used
// by roulette-pvp: a stake-keyed advisory lock + FOR UPDATE row lock +
// conditional UPDATE on `waiting` + null `player2_id`.
export async function createOrJoin({ userId, stakeAmount }) {
  if (!stakeAmount || stakeAmount <= 0) {
    return { error: "Invalid stake amount", status: 400 };
  }

  return await db.transaction(async (tx) => {
    const lockKey = hashStakeToInt(stakeAmount);
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(${BLACKJACK_PVP_LOCK_NAMESPACE}, ${lockKey})`,
    );

    // 1) Look for an existing open match with matching stake.
    const [openMatch] = await tx
      .select()
      .from(blackjackPvpMatches)
      .where(
        and(
          eq(blackjackPvpMatches.status, MATCH_STATUS.WAITING),
          isNull(blackjackPvpMatches.player2Id),
          eq(
            blackjackPvpMatches.stakeAmount,
            Number(stakeAmount).toFixed(2),
          ),
        ),
      )
      .orderBy(sql`${blackjackPvpMatches.createdAt} ASC`)
      .limit(1)
      .for("update");

    if (openMatch) {
      if (openMatch.player1Id === userId) {
        return { match: openMatch, joined: false };
      }
      return await joinExistingMatch(tx, openMatch.id, userId, stakeAmount);
    }

    // 2) No open match — create a fresh waiting match.
    return await createWaitingMatch(tx, userId, stakeAmount);
  });
}

async function createWaitingMatch(tx, userId, stakeAmount) {
  // Deduct stake (atomic: only if balance is sufficient).
  const [creator] = await tx
    .update(users)
    .set({ balance: sql`${users.balance} - ${stakeAmount}` })
    .where(
      and(
        eq(users.clerkId, userId),
        sql`${users.balance} >= ${stakeAmount}`,
      ),
    )
    .returning({ balance: users.balance });

  if (!creator) {
    return { error: "Insufficient balance", status: 400 };
  }

  const [match] = await tx
    .insert(blackjackPvpMatches)
    .values({
      player1Id: userId,
      stakeAmount: Number(stakeAmount).toFixed(2),
      status: MATCH_STATUS.WAITING,
      currentRound: 1,
      roundTimerSeconds: ROUND_TIMER_SECONDS,
      // Both players start with empty hands; the dealing happens when
      // round_1 actually opens (after the 3-second ready window).
      player1Hand: [],
      player2Hand: [],
      deck: [],
      startedAt: new Date(),
    })
    .returning();

  if (Number(stakeAmount) >= 1000) {
    sendSystemNotificationEmail({
      eventType: "bet_placed",
      description: `User ${userId} created blackjack PvP lobby (${stakeAmount} stake).`,
      metadata: { userId, stakeAmount, matchId: match.id },
    }).catch(() => {});
  }

  return { match, joined: false };
}

async function joinExistingMatch(tx, candidateId, userId, stakeAmount) {
  const [match] = await tx
    .select()
    .from(blackjackPvpMatches)
    .where(eq(blackjackPvpMatches.id, candidateId))
    .for("update");

  if (!match || match.status !== MATCH_STATUS.WAITING || match.player2Id) {
    return { error: "Lobby no longer available", status: 409 };
  }

  const [joiner] = await tx
    .update(users)
    .set({ balance: sql`${users.balance} - ${stakeAmount}` })
    .where(
      and(
        eq(users.clerkId, userId),
        sql`${users.balance} >= ${stakeAmount}`,
      ),
    )
    .returning({ balance: users.balance });

  if (!joiner) {
    return { error: "Insufficient balance", status: 400 };
  }

  const readyDeadline = new Date(Date.now() + READY_WINDOW_MS);

  const [updated] = await tx
    .update(blackjackPvpMatches)
    .set({
      player2Id: userId,
      status: MATCH_STATUS.READY,
      roundDeadline: readyDeadline,
    })
    .where(
      and(
        eq(blackjackPvpMatches.id, candidateId),
        // Defensive guard: only update if status is still `waiting`
        // and player2Id is still null when we commit.
        eq(blackjackPvpMatches.status, MATCH_STATUS.WAITING),
        isNull(blackjackPvpMatches.player2Id),
      ),
    )
    .returning();

  // If our conditional UPDATE didn't match any rows, refund the
  // joiner's stake — the lobby was cancelled in a parallel tx.
  if (!updated) {
    await tx
      .update(users)
      .set({ balance: sql`${users.balance} + ${stakeAmount}` })
      .where(eq(users.clerkId, userId));
    return { error: "Lobby no longer available", status: 409 };
  }

  return { match: updated, joined: true };
}

// ── Auto-advance ready → round_1 ──────────────────────────────────────
async function advanceFromReady(tx, match) {
  const deadline = new Date(Date.now() + roundDeadlineMs(match));
  // Build a fresh shoe and deal 2 cards to each player. Cards are
  // drawn alternately so the visual hand layout doesn't imply a
  // turn order — both players play simultaneously.
  const deck = buildDeck();
  const p1Cards = drawCards(deck, 2);
  const p2Cards = drawCards(deck, 2);

  await tx
    .update(blackjackPvpMatches)
    .set({
      status: MATCH_STATUS.ROUND_1,
      roundDeadline: deadline,
      currentRound: 1,
      player1Hand: p1Cards,
      player2Hand: p2Cards,
      player1State: PLAYER_STATE.PLAYING,
      player2State: PLAYER_STATE.PLAYING,
      deck,
    })
    .where(
      and(
        eq(blackjackPvpMatches.id, match.id),
        eq(blackjackPvpMatches.status, MATCH_STATUS.READY),
      ),
    );

  const [refreshed] = await tx
    .select()
    .from(blackjackPvpMatches)
    .where(eq(blackjackPvpMatches.id, match.id));
  return refreshed || match;
}

// ── Cancel (creator only, while in waiting) ───────────────────────────
export async function cancelMatch({ userId, matchId }) {
  return await db.transaction(async (tx) => {
    const [match] = await tx
      .select()
      .from(blackjackPvpMatches)
      .where(eq(blackjackPvpMatches.id, matchId))
      .for("update");

    if (!match) return { error: "Match not found", status: 404 };
    if (match.status !== MATCH_STATUS.WAITING) {
      return {
        error: "Match cannot be cancelled after opponent joins",
        status: 400,
      };
    }
    if (match.player1Id !== userId) {
      return { error: "Only the creator can cancel", status: 403 };
    }

    await tx
      .update(users)
      .set({
        balance: sql`${users.balance} + ${Number(match.stakeAmount)}`,
      })
      .where(eq(users.clerkId, userId));

    const [updated] = await tx
      .update(blackjackPvpMatches)
      .set({
        status: MATCH_STATUS.CANCELLED,
        endedAt: new Date(),
      })
      .where(eq(blackjackPvpMatches.id, matchId))
      .returning();

    return { match: updated };
  });
}

// ── Match fetch with row lock (for atomic operations) ─────────────────
async function fetchMatchForUpdate(tx, matchId) {
  const [match] = await tx
    .select()
    .from(blackjackPvpMatches)
    .where(eq(blackjackPvpMatches.id, matchId))
    .for("update");
  return match;
}

// ── Action dispatch ──────────────────────────────────────────────────
// Single canonical entry-point for ALL round actions (hit, stand,
// swap, hold, use_held). The lock + auto-resolve + bust detection
// lives here so we cannot accidentally leak parallel writes from one
// action handler bypassing another's invariants.
//
// `payload` is action-specific (see `applyAction`).
export async function recordAction({ userId, matchId, action, payload }) {
  if (!Object.values(ACTION_TYPE).includes(action)) {
    return { error: "Invalid action", status: 400 };
  }

  return await db.transaction(async (tx) => {
    const match = await fetchMatchForUpdate(tx, matchId);
    if (!match) return { error: "Match not found", status: 404 };
    if (!isParticipant(match, userId)) {
      return { error: "Forbidden", status: 403 };
    }
    if (!PLAYABLE_STATES.has(match.status)) {
      return { error: "Match is not in an active round", status: 400 };
    }

    // Auto-stand on stale deadlines BEFORE applying the new action,
    // so a player who times out is force-marked stood and a subsequent
    // hit/stand attempt is rejected.
    if (
      match.roundDeadline &&
      new Date(match.roundDeadline).getTime() <= Date.now()
    ) {
      const forceResult = await forceDeadlineAdvance(tx, match);
      return { match: forceResult, forceAdvanced: true };
    }

    const seat = isPlayer1(match, userId) ? "player1" : "player2";
    const fields = SEAT_FIELDS[seat];

    // ── Apply the per-action mutation in isolation. Returns
    // setValues + a `chainResolve` flag indicating whether the round
    // should re-evaluate after the UPDATE.
    const mutation = applyAction(match, action, seat, fields, payload);
    if (!mutation.ok) return { error: mutation.error, status: mutation.status };

    // The row is row-locked via `fetchMatchForUpdate` (`FOR UPDATE`)
    // above, so a parallel seat's action cannot race past this UPDATE.
    // We still gate on `eq(status, match.status)` to refuse a stale
    // POST that arrived after the round already advanced.
    const [updated] = await tx
      .update(blackjackPvpMatches)
      .set(mutation.setValues)
      .where(
        and(
          eq(blackjackPvpMatches.id, matchId),
          eq(blackjackPvpMatches.status, match.status),
        ),
      )
      .returning();

    if (!updated) {
      // The latest state had moved — re-fetch so the caller can
      // retry against the fresh state.
      const [refreshed] = await tx
        .select()
        .from(blackjackPvpMatches)
        .where(eq(blackjackPvpMatches.id, matchId));
      return { match: refreshed, raced: true };
    }

    const bothTerminal =
      updated.player1State !== PLAYER_STATE.PLAYING &&
      updated.player2State !== PLAYER_STATE.PLAYING;

    let resolved = updated;
    if (bothTerminal) {
      resolved = await resolveRound(tx, updated);
    }

    return { match: resolved, justResolved: bothTerminal };
  });
}

// ── Action validators + mutators ─────────────────────────────────────
// Pure: returns `{ ok, setValues }` for a given (match, action, seat,
// fields, payload). NO DB writes here — only mutates the proposed
// state in-memory for review before the wrapped UPDATE commits it.
function applyAction(match, action, seat, fields, payload) {
  const currentState = match[fields.state];
  const currentHand = Array.isArray(match[fields.hand])
    ? [...match[fields.hand]]
    : [];
  const currentDeck = Array.isArray(match.deck) ? [...match.deck] : [];

  switch (action) {
    case ACTION_TYPE.HIT: {
      if (currentState !== PLAYER_STATE.PLAYING) {
        return {
          ok: false,
          error: `Seat already in '${currentState}' — no further action possible`,
          status: 409,
        };
      }
      if (currentDeck.length === 0) {
        return {
          ok: false,
          error: "Shoe is empty — server cannot deal further cards",
          status: 409,
        };
      }
      // The drawn card is the LAST card in the hand after this hit;
      // if the player later uses Hold, it will be lifted from the end
      // of the hand array.
      const drawn = drawCards(currentDeck, 1);
      const nextHand = [...currentHand, ...drawn];
      const newScore = calcHandValue(nextHand);
      const nextState =
        newScore > 21 ? PLAYER_STATE.BUSTED : PLAYER_STATE.PLAYING;
      return {
        ok: true,
        setValues: {
          deck: currentDeck,
          [fields.hand]: nextHand,
          [fields.state]: nextState,
        },
      };
    }

    case ACTION_TYPE.STAND: {
      if (currentState !== PLAYER_STATE.PLAYING) {
        return {
          ok: false,
          error: `Seat already in '${currentState}' — no further action possible`,
          status: 409,
        };
      }
      return {
        ok: true,
        setValues: { [fields.state]: PLAYER_STATE.STAND },
      };
    }

    case ACTION_TYPE.SWAP: {
      // Swap is unrestricted by seat-state — even if a player busted
      // via Hit they may still consume their per-round Swap in an
      // attempt to revive (or, if the post-swap value still busts,
      // the bust locks in immediately as the rule specifies).
      const swapsUsed = Number(match[fields.swapsUsed]) || 0;
      if (swapsUsed >= SWAP_LIMIT_PER_ROUND) {
        return {
          ok: false,
          error: "Swap already used this round",
          status: 409,
        };
      }
      if (currentHand.length < 2) {
        return {
          ok: false,
          error: "Swap requires at least the two starting cards",
          status: 409,
        };
      }
      const choice = payload?.swapIndex;
      if (choice !== 0 && choice !== 1) {
        return {
          ok: false,
          error: "Swap requires a valid swapIndex (0 or 1)",
          status: 400,
        };
      }
      if (currentDeck.length === 0) {
        return {
          ok: false,
          error: "Shoe is empty — server cannot deal further cards",
          status: 409,
        };
      }
      // Pull a fresh card from the deck and replace the chosen
      // original starting card in-place.
      const drawn = drawCards(currentDeck, 1);
      const nextHand = [...currentHand];
      nextHand[choice] = drawn[0];
      const newScore = calcHandValue(nextHand);
      const nextState =
        newScore > 21 ? PLAYER_STATE.BUSTED : PLAYER_STATE.PLAYING;
      return {
        ok: true,
        setValues: {
          deck: currentDeck,
          [fields.hand]: nextHand,
          [fields.state]: nextState,
          [fields.swapsUsed]: swapsUsed + 1,
        },
      };
    }

    case ACTION_TYPE.HOLD: {
      // Hold is only allowed while the seat is `playing` and after at
      // least one Hit (hand length >= 2 means original 2 + ≥1 hit).
      if (currentState !== PLAYER_STATE.PLAYING) {
        return {
          ok: false,
          error: "Hold is only available while your turn is in progress",
          status: 409,
        };
      }
      const holdsUsed = Number(match[fields.holdsUsed]) || 0;
      if (holdsUsed >= HOLD_LIMIT_PER_ROUND) {
        return {
          ok: false,
          error: "Hold already used this round",
          status: 409,
        };
      }
      if (currentHand.length < 2) {
        return {
          ok: false,
          error: "Hold requires at least one card drawn after the initial deal",
          status: 409,
        };
      }
      if (match[fields.heldCard]) {
        return {
          ok: false,
          error: "You already have a card on hold — resolve it first",
          status: 409,
        };
      }
      // Lift the LAST card from the hand and stash it.
      const stored = currentHand[currentHand.length - 1];
      const nextHand = currentHand.slice(0, -1);
      return {
        ok: true,
        setValues: {
          [fields.hand]: nextHand,
          [fields.heldCard]: stored,
          [fields.holdsUsed]: holdsUsed + 1,
          // State unchanged — player can still Hit, Stand, or Use Held.
          [fields.state]: PLAYER_STATE.PLAYING,
        },
      };
    }

    case ACTION_TYPE.USE_HELD: {
      // Resolve a previously held card: either add it back to the
      // hand OR discard it forever. We allow USE_HELD while STOOD so
      // the player can finalize a "swap-after-stand" or "hold-and-
      // stand" choice (e.g. hold at 15, then stand, then later add
      // the held card for 20). BUSTED seats cannot resolve because
      // a busted seat is auto-terminal and the round is already
      // doomed unless the opponent also busts. Swap-after-bust is
      // the canonical revival path; Hold-after-bust is intentionally
      // excluded per game spec.
      if (
        currentState !== PLAYER_STATE.PLAYING &&
        currentState !== PLAYER_STATE.STAND
      ) {
        return {
          ok: false,
          error: "Held card can only be resolved while playing or stood",
          status: 409,
        };
      }
      const heldCard = match[fields.heldCard];
      if (!heldCard) {
        return {
          ok: false,
          error: "No card on hold to resolve",
          status: 409,
        };
      }
      if (match[fields.heldResolved]) {
        return {
          ok: false,
          error: "Held card already resolved this round",
          status: 409,
        };
      }
      const sub = payload?.subaction;
      if (sub !== USE_HELD_SUBACTIONS.ADD && sub !== USE_HELD_SUBACTIONS.DISCARD) {
        return {
          ok: false,
          error: "use_held requires subaction 'add' or 'discard'",
          status: 400,
        };
      }
      if (sub === USE_HELD_SUBACTIONS.ADD) {
        const nextHand = [...currentHand, heldCard];
        const newScore = calcHandValue(nextHand);
        const nextState =
          newScore > 21 ? PLAYER_STATE.BUSTED : PLAYER_STATE.PLAYING;
        return {
          ok: true,
          setValues: {
            [fields.hand]: nextHand,
            [fields.heldCard]: null,
            [fields.heldResolved]: HELD_RESOLUTION.ADD,
            [fields.state]: nextState,
          },
        };
      }
      // DISCARD
      return {
        ok: true,
        setValues: {
          [fields.heldCard]: null,
          [fields.heldResolved]: HELD_RESOLUTION.DISCARD,
          // State unchanged — stash removal doesn't change the score.
          [fields.state]: PLAYER_STATE.PLAYING,
        },
      };
    }

    default:
      return { ok: false, error: "Unsupported action", status: 400 };
  }
}

// ── Force-deadline advance ────────────────────────────────────────────
// If the round timer elapsed and any seat is still in `playing`,
// force-mark them `stood` so the round can resolve. After the
// stand-mark the canonical `bothTerminal` gate fires — so the
// resolution handles the round-end cases per the spec:
//   • both force-stood (AFK vs AFK) → both STAND → resolve
//   • one was already BUSTED + other force-stands (AFK vs busted)
//     → bust + stand → resolve
async function forceDeadlineAdvance(tx, match) {
  const setValues = { deck: match.deck ?? [] };
  if (match.player1State === PLAYER_STATE.PLAYING) {
    setValues.player1State = PLAYER_STATE.STAND;
  }
  if (match.player2State === PLAYER_STATE.PLAYING) {
    setValues.player2State = PLAYER_STATE.STAND;
  }

  // Only re-bump the round deadline if a stale clock actually
  // triggered the auto-stand; otherwise we'd keep extending it
  // forever on every poll.
  const [updated] = await tx
    .update(blackjackPvpMatches)
    .set(setValues)
    .where(
      and(
        eq(blackjackPvpMatches.id, match.id),
        match.roundDeadline
          ? sql`${blackjackPvpMatches.roundDeadline} <= NOW()`
          : sql`TRUE`,
      ),
    )
    .returning();

  const effective = updated || match;
  const bothTerminal =
    effective.player1State !== PLAYER_STATE.PLAYING &&
    effective.player2State !== PLAYER_STATE.PLAYING;

  if (!bothTerminal) {
    return effective;
  }
  return await resolveRound(tx, effective);
}

// ── Resolve the current round ────────────────────────────────────────
// Round-end trigger (in priority order):
//   1. Both seats reached a terminal state (`standing` or `busted`)
//      simultaneously — including the AFK force-stand path.
//   2. One seat busted while the other has already stood (per spec:
//      "one player busts and the other has already stood"). The seat
//      that's still `playing` gets to finish their turn before this
//      path can fire.
//   3. Same as 2 but inverted (both stood).
// Both conditions collapse to the existing `bothTerminal` invariant
// (player1State !== PLAYING && player2State !== PLAYING) so the
// single boolean remains the canonical resolution gate.
//
// Mutates state:
//   1. Compute round winner via decideRoundWinner (closer to 21).
//      Winner priority: 1) highest score ≤21, 2) bust loses, 3) equal
//      score = tied round.
//   2. Persist a snapshot row to `blackjack_pvp_rounds` with BOTH
//      hands + BOTH scores + BOTH end-states visible (the round-end
//      reveal event for the result screen).
//   3. Increment `score_player1` / `score_player2` for the winner.
//   4. Decide next status:
//      • Match end → FINISHED (with house fee + payout).
//      • Otherwise → BETWEEN_ROUNDS (the per-spec transition screen
//        before the next fresh shuffled deck is dealt).
async function resolveRound(tx, match) {
  const slot = Number(match.currentRound) || 1;

  const decision = decideRoundWinner({
    p1Cards: match.player1Hand,
    p1State: match.player1State,
    p2Cards: match.player2Hand,
    p2State: match.player2State,
  });

  const roundWinner = decision.winner; // 'player1' | 'player2' | 'draw'

  // Persist per-round snapshot BEFORE we mutate the match row so the
  // history always reflects the round's final state.
  await tx.insert(blackjackPvpRounds).values({
    matchId: match.id,
    roundNumber: slot,
    player1Hand: match.player1Hand ?? [],
    player2Hand: match.player2Hand ?? [],
    player1Score: decision.p1Score,
    player2Score: decision.p2Score,
    player1State: match.player1State,
    player2State: match.player2State,
    roundWinner,
  });

  // Score totals
  let newScoreP1 = Number(match.scorePlayer1) || 0;
  let newScoreP2 = Number(match.scorePlayer2) || 0;
  if (roundWinner === RESULT.PLAYER1) newScoreP1 += 1;
  else if (roundWinner === RESULT.PLAYER2) newScoreP2 += 1;

  // Decide next status.
  let nextStatus;
  let nextRound = slot + 1;
  let nextDeadline = null;
  let winnerId = null;
  let prizePaid = "0.00";
  let houseFee = "0.00";
  let result = null;

  const earlyFinish = newScoreP1 >= 2 || newScoreP2 >= 2;

  if (earlyFinish || slot >= TOTAL_ROUNDS) {
    // ── Match end ───────────────────────────────────────────────
    nextStatus = MATCH_STATUS.FINISHED;
    nextRound = slot; // freeze round counter at the deciding slot
    nextDeadline = null;
    if (newScoreP1 > newScoreP2) {
      const credit = await creditWinner(tx, match, RESULT.PLAYER1);
      winnerId = credit.winnerId;
      prizePaid = credit.payout.toFixed(2);
      houseFee = credit.fee.toFixed(2);
      result = RESULT.PLAYER1;
    } else if (newScoreP2 > newScoreP1) {
      const credit = await creditWinner(tx, match, RESULT.PLAYER2);
      winnerId = credit.winnerId;
      prizePaid = credit.payout.toFixed(2);
      houseFee = credit.fee.toFixed(2);
      result = RESULT.PLAYER2;
    } else {
      // Best-of-3 draw → refund both players in full, no house fee.
      await tx
        .update(users)
        .set({
          balance: sql`${users.balance} + ${Number(match.stakeAmount)}`,
        })
        .where(eq(users.clerkId, match.player1Id));
      await tx
        .update(users)
        .set({
          balance: sql`${users.balance} + ${Number(match.stakeAmount)}`,
        })
        .where(eq(users.clerkId, match.player2Id));
      result = RESULT.DRAW;
    }
  } else {
    // ── Between-rounds transition ────────────────────────────────
    // Per the Best-of-3 spec, the match moves through an explicit
    // BETWEEN_ROUNDS state before the next round's fresh deck is
    // dealt. This unlocks a dedicated "Round X+1 incoming" screen.
    // The match row keeps the just-resolved round's hands + states
    // so the active-render keeps the cards visible during the
    // countdown if the UI hasn't hidden them yet.
    nextStatus = MATCH_STATUS.BETWEEN_ROUNDS;
    nextDeadline = new Date(Date.now() + BETWEEN_ROUNDS_MS);

    const setValues = {
      status: nextStatus,
      currentRound: nextRound,
      scorePlayer1: newScoreP1,
      scorePlayer2: newScoreP2,
      roundDeadline: nextDeadline,
      // Preserve the just-resolved round's hand + state on the row
      // until `advanceFromBetweenRounds` flips it to round_(X+1).
      player1Hand: match.player1Hand ?? [],
      player2Hand: match.player2Hand ?? [],
      player1State: match.player1State ?? PLAYER_STATE.STAND,
      player2State: match.player2State ?? PLAYER_STATE.STAND,
      // Stash the (now-consumed) deck; the next round will rebuild.
      deck: match.deck ?? [],
      // Reset all per-round counters + held cards for the next round.
      player1SwapsUsed: 0,
      player2SwapsUsed: 0,
      player1HoldsUsed: 0,
      player2HoldsUsed: 0,
      player1HeldCard: null,
      player2HeldCard: null,
      player1HeldResolved: null,
      player2HeldResolved: null,
    };

    const [updated] = await tx
      .update(blackjackPvpMatches)
      .set(setValues)
      .where(eq(blackjackPvpMatches.id, match.id))
      .returning();

    return updated || match;
  }

  // Apply final-set values for the finished branch.
  const setValues = {
    status: nextStatus,
    currentRound: nextRound,
    scorePlayer1: newScoreP1,
    scorePlayer2: newScoreP2,
    roundDeadline: nextDeadline,
    player1State: PLAYER_STATE.STAND, // round is over; both seats 'stood' for read consistency
    player2State: PLAYER_STATE.STAND,
    // Reveal both hands on the match row when the match ends so the
    // final-round reveal animation can run on both seats without a
    // second API call.
    player1Hand: match.player1Hand ?? [],
    player2Hand: match.player2Hand ?? [],
    houseFee: houseFee,
    prizePaid: prizePaid,
    endedAt: new Date(),
  };
  if (winnerId !== null) setValues.winnerId = winnerId;
  if (result !== null) setValues.result = result;

  const [updated] = await tx
    .update(blackjackPvpMatches)
    .set(setValues)
    .where(eq(blackjackPvpMatches.id, match.id))
    .returning();

  // Stats side-effects (best-effort — failures don't roll the match).
  // Pass the freshly-updated row so the prizePaid/houseFee reflects
  // what this transaction just wrote — NOT the pre-update `match`
  // passed into resolveRound.
  const finalRow = updated || match;
  if (result === RESULT.PLAYER1 || result === RESULT.PLAYER2) {
    await recordPvPResult(tx, finalRow, winnerId, result).catch(() => {});
  }

  return finalRow;
}

async function creditWinner(tx, match, roundWinner) {
  const totalPot = Number(match.stakeAmount) * 2;
  const fee = Number((totalPot * HOUSE_FEE_PCT).toFixed(2));
  const payout = Number((totalPot - fee).toFixed(2));
  const winnerId =
    roundWinner === RESULT.PLAYER1 ? match.player1Id : match.player2Id;

  await tx
    .update(users)
    .set({ balance: sql`${users.balance} + ${payout}` })
    .where(eq(users.clerkId, winnerId));

  return { winnerId, fee, payout };
}

// Best-effort stat side-effect — bumps pvpWins / pvpGamesPlayed on the
// `users` row so the global PvP leaderboards stay fresh without
// re-running the historical aggregate queries on every match.
async function recordPvPResult(tx, match, winnerId, result) {
  const loserId =
    result === RESULT.PLAYER1 ? match.player2Id : match.player1Id;
  if (!winnerId || !loserId) return;

  await tx
    .update(users)
    .set({
      pvpWins: sql`${users.pvpWins} + 1`,
    })
    .where(eq(users.clerkId, winnerId));
  await tx
    .update(users)
    .set({
      gamesWon: sql`${users.gamesWon} + 1`,
      totalWon: sql`${users.totalWon} + ${Number(match.prizePaid) || 0}`,
      biggestWin:
        Number(match.prizePaid) > 0
          ? sql`GREATEST(${users.biggestWin}, ${Number(match.prizePaid)})`
          : sql`${users.biggestWin}`,
    })
    .where(eq(users.clerkId, winnerId));
  await tx
    .update(users)
    .set({
      gamesLost: sql`${users.gamesLost} + 1`,
      totalWagered: sql`${users.totalWagered} + ${Number(match.stakeAmount)}`,
    })
    .where(eq(users.clerkId, loserId));
}

// ── Between-rounds → next round (Best-of-3 spec) ─────────────────────
// Advances from MATCH_STATUS.BETWEEN_ROUNDS to MATCH_STATUS.ROUND_(X+1)
// with a single FRESH SHUFFLED 52-card shoe that both seats draw
// from, two dealt cards per seat, and reset swap/hold counters. The
// match score is preserved across rounds per spec. Hit/swap draws
// later in the round pull from the same shoe, persisted on the
// `deck` column as the post-deal remainder.
//
// Idempotent in the sense that calling it twice with the row no
// longer in `BETWEEN_ROUNDS` simply confirms the match row (no
// UPDATE applied — see WHERE status guard).
async function advanceFromBetweenRounds(tx, match) {
  const upcomingRound = (Number(match.currentRound) || 1) + 1;
  if (upcomingRound > TOTAL_ROUNDS) {
    // Shouldn't reach here — `resolveRound` finished the match when
    // `slot >= TOTAL_ROUNDS` — but guard defensively so the lobby is
    // never stranded in `between_rounds` without a forward path.
    return match;
  }

  // Build ONE fresh shuffled shoe and deal BOTH seats from it. This
  // is what the Best-of-3 spec means by "fresh shuffled deck per
  // round" — a single shoe from which cards are drawn sequentially,
  // with the remainder persisted on the row's `deck` column for
  // later hit / swap draws inside the same round.
  const freshShoe = buildDeck();
  const player1Hand = drawCards(freshShoe, 2);
  const player2Hand = drawCards(freshShoe, 2);

  // Idempotency guard: only advance while status is BETWEEN_ROUNDS.
  const [updated] = await tx
    .update(blackjackPvpMatches)
    .set({
      status: statusForRoundNumber(upcomingRound),
      currentRound: upcomingRound,
      roundDeadline: new Date(Date.now() + roundDeadlineMs(match)),
      deck: freshShoe,
      player1Hand,
      player2Hand,
      player1State: PLAYER_STATE.PLAYING,
      player2State: PLAYER_STATE.PLAYING,
      // Reset all per-round counters + held cards for the next round.
      player1SwapsUsed: 0,
      player2SwapsUsed: 0,
      player1HoldsUsed: 0,
      player2HoldsUsed: 0,
      player1HeldCard: null,
      player2HeldCard: null,
      player1HeldResolved: null,
      player2HeldResolved: null,
    })
    .where(
      and(
        eq(blackjackPvpMatches.id, match.id),
        eq(blackjackPvpMatches.status, MATCH_STATUS.BETWEEN_ROUNDS),
      ),
    )
    .returning();

  return updated || match;
}

// Public helper that the /continue API route calls to skip the
// between-rounds countdown. Subject to the same row-lock + status
// guard as the auto-advance path.
export async function continueMatch({ userId, matchId }) {
  return await db.transaction(async (tx) => {
    const match = await fetchMatchForUpdate(tx, matchId);
    if (!match) return { error: "Match not found", status: 404 };
    if (!isParticipant(match, userId)) {
      return { error: "Forbidden", status: 403 };
    }
    if (match.status !== MATCH_STATUS.BETWEEN_ROUNDS) {
      return {
        error: "Match is not in a between-rounds transition",
        status: 409,
      };
    }
    const advanced = await advanceFromBetweenRounds(tx, match);
    return { match: advanced, advanced: true };
  });
}

// ── Status fetch with auto-resolve ────────────────────────────────────
// If the round deadline has elapsed and one seat is still in
// `playing`, force-mark them `stood` so the round can resolve. This
// is the server's "AFK nudge".
//
// Also auto-advances BETWEEN_ROUNDS → next round_X after the
// between-rounds deadline has elapsed.
export async function fetchMatchWithAutoResolve(userId, matchId) {
  return await db.transaction(async (tx) => {
    const match = await fetchMatchForUpdate(tx, matchId);
    if (!match) return { error: "Match not found", status: 404 };
    if (!isParticipant(match, userId)) {
      return { error: "Forbidden", status: 403 };
    }

    // Auto-advance the brief Ready window into round_1.
    if (
      match.status === MATCH_STATUS.READY &&
      match.roundDeadline &&
      new Date(match.roundDeadline).getTime() <= Date.now()
    ) {
      const advanced = await advanceFromReady(tx, match);
      return { match: advanced };
    }

    // Best-of-3 inter-round transition — auto-advance to next round
    // once the between-rounds deadline has elapsed.
    if (
      match.status === MATCH_STATUS.BETWEEN_ROUNDS &&
      match.roundDeadline &&
      new Date(match.roundDeadline).getTime() <= Date.now()
    ) {
      const advanced = await advanceFromBetweenRounds(tx, match);
      return { match: advanced };
    }

    // Auto-resolve the current round if its deadline has passed.
    if (
      PLAYABLE_STATES.has(match.status) &&
      match.roundDeadline &&
      new Date(match.roundDeadline).getTime() <= Date.now()
    ) {
      const resolved = await forceDeadlineAdvance(tx, match);
      return { match: resolved };
    }

    return { match };
  });
}

// ── Round history fetch ───────────────────────────────────────────────
export async function fetchMatchRounds(matchId) {
  return db
    .select()
    .from(blackjackPvpRounds)
    .where(eq(blackjackPvpRounds.matchId, matchId))
    .orderBy(sql`${blackjackPvpRounds.roundNumber} ASC`);
}

// ── Lightweight read for /status (no row lock) ───────────────────────
export async function fetchMatch(matchId) {
  const [match] = await db
    .select()
    .from(blackjackPvpMatches)
    .where(eq(blackjackPvpMatches.id, matchId));
  return match || null;
}
