export type DiceFlushCategory =
  | "ones" | "twos" | "threes" | "fours" | "fives" | "sixes"
  | "threeOfKind" | "fourOfKind" | "fullHouse" | "smallStraight" | "largeStraight"
  | "fiveKind" | "chance";

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
  scorecards: Record<string, Scorecard>;
};

const ALL_CATEGORIES: DiceFlushCategory[] = ["ones","twos","threes","fours","fives","sixes","threeOfKind","fourOfKind","fullHouse","smallStraight","largeStraight","fiveKind","chance"];

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

export function calculateScore(dice:number[], category: DiceFlushCategory): number {
  const counts = new Map<number, number>();
  dice.forEach(d => counts.set(d, (counts.get(d) ?? 0) + 1));
  const freq = [...counts.values()].sort((a,b)=>b-a);
  const unique = [...new Set(dice)].sort((a,b)=>a-b);
  switch (category) {
    case "ones": case "twos": case "threes": case "fours": case "fives": case "sixes": {
      const target = ["ones","twos","threes","fours","fives","sixes"].indexOf(category)+1;
      return dice.filter(d=>d===target).length*target;
    }
    case "threeOfKind": return freq[0] >= 3 ? sum(dice) : 0;
    case "fourOfKind": return freq[0] >= 4 ? sum(dice) : 0;
    case "fullHouse": return freq[0] === 3 && freq[1] === 2 ? 25 : 0;
    case "smallStraight": return ([1,2,3,4].every(n=>unique.includes(n)) || [2,3,4,5].every(n=>unique.includes(n)) || [3,4,5,6].every(n=>unique.includes(n))) ? 30 : 0;
    case "largeStraight": return (JSON.stringify(unique) === JSON.stringify([1,2,3,4,5]) || JSON.stringify(unique) === JSON.stringify([2,3,4,5,6])) ? 40 : 0;
    case "fiveKind": return freq[0] === 5 ? 50 : 0;
    case "chance": return sum(dice);
  }
}

export function validateMove(state: DiceFlushGameState, userId: string, action: "roll_dice"|"hold_dice"|"choose_category", payload?: any) {
  if (state.state !== "playing") throw new Error("Game is not active");
  if (state.currentTurn !== userId) throw new Error("Not your turn");
  if (action === "hold_dice" && (!payload || !Array.isArray(payload.heldDice) || payload.heldDice.length !== 5)) throw new Error("Invalid hold_dice payload");
  if (action === "roll_dice" && state.rollsThisTurn >= 3) throw new Error("No rolls remaining");
  if (action === "choose_category") {
    if (!payload?.category || !ALL_CATEGORIES.includes(payload.category)) throw new Error("Invalid category");
    if ((state.scorecards[userId] ?? {})[payload.category] !== undefined) throw new Error("Category already used");
  }
}

export function nextTurn(state: DiceFlushGameState, scoringUserId: string, category: DiceFlushCategory): DiceFlushGameState {
  const currentCard = state.scorecards[scoringUserId] ?? {};
  const scorecards = { ...state.scorecards, [scoringUserId]: { ...currentCard, [category]: calculateScore(state.dice, category) } };
  const idx = state.players.findIndex(p => p.userId === scoringUserId);
  const next = state.players[(idx + 1) % state.players.length];
  return { ...state, scorecards, currentTurn: next.userId, turnNumber: state.turnNumber + 1, rollsThisTurn: 0, heldDice: [false,false,false,false,false], dice:[1,1,1,1,1] };
}

const UPPER_CATS: DiceFlushCategory[] = ["ones","twos","threes","fours","fives","sixes"];

function upperBonus(card: Scorecard) {
  const sum = UPPER_CATS.reduce((t, k) => t + ((card as any)[k] ?? 0), 0);
  return sum >= 63 ? 35 : 0;
}

export function checkGameEnd(state: DiceFlushGameState) {
  const done = state.players.every(p => Object.keys(state.scorecards[p.userId] ?? {}).length >= 13);
  if (!done) return { ended: false as const };
  const totals = Object.fromEntries(state.players.map(p => {
    const card = state.scorecards[p.userId] ?? {};
    const raw = Object.values(card).reduce((a,b)=>a+(b ?? 0), 0);
    return [p.userId, raw + upperBonus(card)];
  }));
  const winner = [...state.players].sort((a,b)=>totals[b.userId]-totals[a.userId])[0];
  return { ended: true as const, winnerId: winner.userId, totals };
}

export const DiceFlushCategories = ALL_CATEGORIES;
