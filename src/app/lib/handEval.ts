// lib/handEval.ts
export type Card = { suit: string; value: string };

const cardOrder = [
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "10",
  "J",
  "Q",
  "K",
  "A",
];

export function evaluateHand(
  playerCards: Card[] = [],
  community: Card[] = [],
): string {
  // 🔒 Defensive guard (prevents "not iterable" crash)
  if (!Array.isArray(playerCards) || !Array.isArray(community)) {
    return "";
  }

  const all = [...playerCards, ...community].filter(
    (c): c is Card =>
      !!c &&
      typeof c === "object" &&
      typeof c.suit === "string" &&
      typeof c.value === "string",
  );

  if (all.length === 0) return "";
  if (all.length < 5) return "";

  // Count suits for flush
  const suitsCount: Record<string, Card[]> = {};
  all.forEach((c) => {
    if (!suitsCount[c.suit]) suitsCount[c.suit] = [];
    suitsCount[c.suit].push(c);
  });

  // Count values for pairs/triples/quads
  const valueCount: Record<string, Card[]> = {};
  all.forEach((c) => {
    if (!valueCount[c.value]) valueCount[c.value] = [];
    valueCount[c.value].push(c);
  });

  const valuesSorted = [...all].sort(
    (a, b) => cardOrder.indexOf(b.value) - cardOrder.indexOf(a.value),
  );

  const counts = Object.values(valueCount).map((g) => g.length);
  const pairs = Object.entries(valueCount).filter(([_, g]) => g.length === 2);
  const triples = Object.entries(valueCount).filter(([_, g]) => g.length === 3);
  const quads = Object.entries(valueCount).filter(([_, g]) => g.length === 4);

  // Check flush
  const flush = Object.values(suitsCount).find((g) => g.length >= 5);
  const flushValues = flush
    ? flush.map((c) => cardOrder.indexOf(c.value)).sort((a, b) => b - a)
    : null;

  // Check straight
  const uniqueIndices = Array.from(
    new Set(all.map((c) => cardOrder.indexOf(c.value)).filter((i) => i >= 0)),
  ).sort((a, b) => b - a);

  let straight = false;
  for (let i = 0; i <= uniqueIndices.length - 5; i++) {
    if (uniqueIndices[i] - uniqueIndices[i + 4] === 4) {
      straight = true;
      break;
    }
  }

  // Special case A-2-3-4-5 straight
  if (
    uniqueIndices.includes(12) &&
    uniqueIndices.includes(0) &&
    uniqueIndices.includes(1) &&
    uniqueIndices.includes(2) &&
    uniqueIndices.includes(3)
  ) {
    straight = true;
  }

  // Royal flush / Straight flush
  if (flush && straight) {
    const flushVals = flush
      .map((c) => cardOrder.indexOf(c.value))
      .sort((a, b) => b - a);

    if (
      flushVals[0] === 12 &&
      flushVals.slice(0, 5).every((v, i) => v - i === 8)
    ) {
      return "Royal Flush";
    }
    return "Straight Flush";
  }

  if (quads.length) return `Four of a Kind ${quads[0][0]}`;
  if (triples.length && pairs.length)
    return `Full House ${triples[0][0]} over ${pairs[0][0]}`;
  if (flush) return `Flush ${flush[0].value} high`;
  if (straight) return "Straight";
  if (triples.length) return `Three of a Kind ${triples[0][0]}`;
  if (pairs.length >= 2) return `Two Pair ${pairs[0][0]} & ${pairs[1][0]}`;
  if (pairs.length === 1) return `Pair of ${pairs[0][0]}`;

  return `High Card ${valuesSorted[0].value}`;
}
