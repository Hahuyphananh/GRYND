export type DiceFlushCategory =
  | "ones" | "twos" | "threes" | "fours" | "fives" | "sixes"
  | "threeOfKind" | "fourOfKind" | "fullHouse" | "smallStraight" | "largeStraight"
  | "fiveKind";

export type Scorecard = Partial<Record<DiceFlushCategory, number>>;

export type DiceFlushGameState = {
  id: string;
  game: "yahtzee";
  players: Array<{ userId: string; name: string; isAI?: boolean; difficulty?: "easy"|"medium"|"hard" }>;
  ai: boolean;
  wager: number;
  pot: number;
  state: "waiting" | "playing" | "finished";
  currentTurn: string;
  turnNumber: number;
  rollsThisTurn: number;
  dice: number[];
  heldDice: boolean[];
  /** SHARED scorecard — both players fill the same 12 categories. Each key
   *  is a category; the value is the score banked into it. */
  scorecards: Scorecard;
  /** Maps every filled category to the userId who claimed it. */
  scorecardOwner: Partial<Record<DiceFlushCategory, string>>;
  /** Category the current player committed to (their "call") before their
   *  first roll. If they bank this category this turn they earn CALL_BONUS
   *  extra points on top of the category score. null before a call is made
   *  and between turns. */
  currentCall: DiceFlushCategory | null;
  /** Server-stamped epoch (ms) by which the current turn must be completed.
   *  After this instant `autoBankIfExpired` auto-banks the best legal
   *  category. null while the game is not in the playing phase. */
  turnDeadline: number | null;
};

/** Bonus points awarded when the current player banks the category they
 *  called at the start of their turn (see `callCategory` / `currentCall`). */
export const CALL_BONUS = 15;

/** Time (ms) each player gets to complete their turn before the server
 *  auto-banks their best legal category (see `autoBankIfExpired`). */
export const TURN_TIME_LIMIT_MS = 20_000;

/** Number of categories on the shared scorecard (Chance was dropped so the
 *  two players split the sheet exactly 6-6). */
export const TOTAL_CATEGORIES = 12;

const ALL_CATEGORIES: DiceFlushCategory[] = ["ones","twos","threes","fours","fives","sixes","threeOfKind","fourOfKind","fullHouse","smallStraight","largeStraight","fiveKind"];

const UPPER_CATS: DiceFlushCategory[] = ["ones","twos","threes","fours","fives","sixes"];

const sum = (dice:number[]) => dice.reduce((a,b)=>a+b,0);

export function rollDice(state: DiceFlushGameState): DiceFlushGameState {
  if (state.rollsThisTurn >= 3) throw new Error("Roll limit reached");
  if (state.dice.length !== 5 || state.heldDice.length !== 5) throw new Error("Invalid dice state");
  const dice = state.dice.map((d, i) => state.heldDice[i] ? d : (Math.floor(Math.random() * 6) + 1));
  return { ...state, dice, rollsThisTurn: state.rollsThisTurn + 1 };
}

export function holdDice(state: DiceFlushGameState, heldDice: boolean[]): DiceFlushGameState {
  if (heldDice.length !== 5) throw new Error("Must provide exactly 5 hold flags");
  return { ...state, heldDice: heldDice.map(Boolean) };
}

/** Mark the current player's "call" — the category they commit to scoring
 *  this turn. Must happen before the first roll and only once per turn.
 *  Banking that category later in the turn earns CALL_BONUS extra points. */
export function callCategory(state: DiceFlushGameState, category: DiceFlushCategory): DiceFlushGameState {
  validateMove(state, state.currentTurn, "call_category", { category });
  return { ...state, currentCall: category };
}

export function calculateScore(dice:number[], category: DiceFlushCategory): number {
  const counts = new Map<number, number>();
  dice.forEach(d => counts.set(d, (counts.get(d) ?? 0) + 1));
  const freq = [...counts.values()].sort((a,b)=>b-a);
  const unique = [...new Set(dice)].sort((a,b)=>a-b);
  switch (category) {
    case "ones": case "twos": case "threes": case "fours": case "fives": case "sixes": {
      const target = UPPER_CATS.indexOf(category)+1;
      return dice.filter(d=>d===target).length*target;
    }
    case "threeOfKind": return freq[0] >= 3 ? sum(dice) : 0;
    case "fourOfKind": return freq[0] >= 4 ? sum(dice) : 0;
    case "fullHouse": return freq[0] === 3 && freq[1] === 2 ? 25 : 0;
    case "smallStraight": return ([1,2,3,4].every(n=>unique.includes(n)) || [2,3,4,5].every(n=>unique.includes(n)) || [3,4,5,6].every(n=>unique.includes(n))) ? 30 : 0;
    case "largeStraight": return (JSON.stringify(unique) === JSON.stringify([1,2,3,4,5]) || JSON.stringify(unique) === JSON.stringify([2,3,4,5,6])) ? 40 : 0;
    case "fiveKind": return freq[0] === 5 ? 50 : 0;
  }
}

export function validateMove(state: DiceFlushGameState, userId: string, action: "roll_dice"|"hold_dice"|"call_category"|"choose_category", payload?: any) {
  if (state.state !== "playing") throw new Error("Game is not active");
  if (state.currentTurn !== userId) throw new Error("Not your turn");
  if (action === "hold_dice" && (!payload || !Array.isArray(payload.heldDice) || payload.heldDice.length !== 5)) throw new Error("Invalid hold_dice payload");
  if (action === "roll_dice" && state.rollsThisTurn >= 3) throw new Error("No rolls remaining");
  if (action === "call_category") {
    if (!payload?.category || !ALL_CATEGORIES.includes(payload.category)) throw new Error("Invalid category");
    if (state.rollsThisTurn !== 0) throw new Error("Call must be made before the first roll");
    if (state.currentCall !== null) throw new Error("Category already called this turn");
    if (state.scorecards[payload.category] !== undefined) throw new Error("Category already used");
  }
  if (action === "choose_category") {
    if (!payload?.category || !ALL_CATEGORIES.includes(payload.category)) throw new Error("Invalid category");
    if (state.scorecards[payload.category] !== undefined) throw new Error("Category already used");
  }
}

/** Bank the current dice into `category` for `scoringUserId` on the SHARED
 *  scorecard. Records ownership, applies the call bonus when the banked
 *  category matches the turn's call, then advances to the next player. */
export function nextTurn(state: DiceFlushGameState, scoringUserId: string, category: DiceFlushCategory): DiceFlushGameState {
  if (state.scorecards[category] !== undefined) throw new Error("Category already used");
  // Call bonus: if the current player called this category at the start of
  // the turn, add CALL_BONUS on top of the category score.
  const baseScore = calculateScore(state.dice, category);
  const score = state.currentCall === category ? baseScore + CALL_BONUS : baseScore;
  const scorecards = { ...state.scorecards, [category]: score };
  const scorecardOwner = { ...state.scorecardOwner, [category]: scoringUserId };
  const idx = state.players.findIndex(p => p.userId === scoringUserId);
  const next = state.players[(idx + 1) % state.players.length];
  return {
    ...state,
    scorecards,
    scorecardOwner,
    currentCall: null,
    currentTurn: next.userId,
    turnNumber: state.turnNumber + 1,
    rollsThisTurn: 0,
    heldDice: [false,false,false,false,false],
    dice: [1,1,1,1,1],
    // Stamp a fresh shot-clock deadline for the next player. Only relevant
    // while the match is live — a finishing move is followed by the caller
    // flipping state to "finished" anyway.
    turnDeadline: state.state === "playing" ? Date.now() + TURN_TIME_LIMIT_MS : null,
  };
}

/** Highest-scoring unfilled category on the SHARED sheet given the current
 *  dice. Used by the auto-bank path (turn timeout). Never returns a category
 *  that has already been claimed. */
export function pickBestCategory(state: DiceFlushGameState): DiceFlushCategory {
  let best: DiceFlushCategory | null = null;
  let bestScore = -1;
  for (const c of ALL_CATEGORIES) {
    if (state.scorecards[c] !== undefined) continue;
    const s = calculateScore(state.dice, c);
    if (s > bestScore) {
      bestScore = s;
      best = c;
    }
  }
  return best ?? ALL_CATEGORIES[0];
}

/** If the current player's turn has exceeded `turnDeadline`, auto-bank their
 *  best legal category (honoring the call bonus) and advance the turn to the
 *  next player with a fresh deadline. Returns the (possibly unchanged) state
 *  and whether a timeout actually occurred. Call this at the top of every
 *  move handler and on state reads so a stalled turn self-resolves. */
export function autoBankIfExpired(state: DiceFlushGameState): { state: DiceFlushGameState; didTimeout: boolean } {
  if (state.state !== "playing") return { state, didTimeout: false };
  if (state.turnDeadline === null) return { state, didTimeout: false };
  if (Date.now() <= state.turnDeadline) return { state, didTimeout: false };
  const category = pickBestCategory(state);
  const next = nextTurn(state, state.currentTurn, category);
  // A timeout auto-bank can be the move that fills the final category on
  // the shared sheet. If so, flip the match to "finished" here so callers
  // that don't run settleIfEnded (the shot-clock path) can't leave the
  // game stuck in `playing` with a full scorecard — no legal moves, no
  // result, and no payout. PvP pots are settled by the route afterward;
  // AI-mode pots are 0 so a payout is a no-op there.
  if (checkGameEnd(next).ended) next.state = "finished";
  return { state: next, didTimeout: true };
}

function upperBonus(card: Scorecard) {
  const sum = UPPER_CATS.reduce((t, k) => t + ((card as any)[k] ?? 0), 0);
  return sum >= 63 ? 35 : 0;
}

/** Derive a player's slice of the shared sheet — the categories they claimed
 *  plus their scores. Used for upper-section bonus and final totals. */
export function playerCard(state: DiceFlushGameState, userId: string): Scorecard {
  const card: Scorecard = {};
  for (const [cat, owner] of Object.entries(state.scorecardOwner ?? {})) {
    if (owner === userId) {
      const k = cat as DiceFlushCategory;
      const v = state.scorecards[k];
      if (v !== undefined) card[k] = v;
    }
  }
  return card;
}

/** Per-player totals on the shared sheet. Each player's total is the sum of
 *  the categories they claimed plus their own upper-section bonus (35 when
 *  their claimed upper categories sum to 63+). */
export function playerTotals(state: DiceFlushGameState): Record<string, { upper: number; bonus: number; raw: number; total: number }> {
  return Object.fromEntries(state.players.map(p => {
    const card = playerCard(state, p.userId);
    const upper = UPPER_CATS.reduce((t, k) => t + ((card as any)[k] ?? 0), 0);
    const bonus = upperBonus(card);
    const raw = Object.values(card).reduce((a, b) => a + (b ?? 0), 0);
    return [p.userId, { upper, bonus, raw, total: raw + bonus }];
  }));
}

/** Per-player match breakdown for a finished (or in-flight) game. Each
 *  player gets the categories they claimed plus their upper/bonus/raw/total
 *  figures. Handles BOTH the new shared-sheet shape (via `scorecardOwner`)
 *  and legacy per-player scorecards from before the shared-sheet redesign,
 *  so history stays correct across the format change. */
export function matchBreakdown(state: DiceFlushGameState): Record<string, { categories: Scorecard; upper: number; bonus: number; raw: number; total: number }> {
  const ownerKeys = Object.keys(state.scorecardOwner ?? {});
  if (ownerKeys.length > 0) {
    // New shared-sheet shape.
    const totals = playerTotals(state);
    return Object.fromEntries(state.players.map(p => [
      p.userId,
      { categories: playerCard(state, p.userId), ...totals[p.userId] },
    ]));
  }
  // Legacy per-player shape (pre-shared-sheet games): each player has their
  // own card keyed by userId.
  return Object.fromEntries(state.players.map(p => {
    const card: Scorecard = (state.scorecards as any)?.[p.userId] ?? {};
    const upper = UPPER_CATS.reduce((t, k) => t + ((card as any)[k] ?? 0), 0);
    const bonus = upper >= 63 ? 35 : 0;
    const raw = Object.values(card).reduce((a, b) => a + (b ?? 0), 0);
    return [p.userId, { categories: card, upper, bonus, raw, total: raw + bonus }];
  }));
}

export function checkGameEnd(state: DiceFlushGameState) {
  const done = Object.keys(state.scorecards).length >= TOTAL_CATEGORIES;
  if (!done) return { ended: false as const };
  const totals = playerTotals(state);
  const winner = [...state.players].sort((a,b)=>totals[b.userId].total-totals[a.userId].total)[0];
  return { ended: true as const, winnerId: winner.userId, totals };
}

export const DiceFlushCategories = ALL_CATEGORIES;
