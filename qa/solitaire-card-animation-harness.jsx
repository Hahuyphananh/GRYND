import React, { useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import SolitaireBoard from "../src/components/solitaire-duel/SolitaireBoard.tsx";

// The real board, in a real browser, driven by real clicks. Only the ENGINE is
// replaced by a tiny local reducer: draws and redeals advance the authoritative
// view exactly the way rules.ts does, so the stock button is genuinely clicked
// and the board's own click model is exercised.
const READONLY = new URLSearchParams(location.search).get("readonly") === "1";

const SUITS = ["spades", "hearts", "diamonds", "clubs"];
const deck = [];
for (const suit of SUITS) {
  for (let rank = 1; rank <= 13; rank += 1) deck.push({ suit, rank });
}

function initialState() {
  const tableau = [];
  let next = 20;
  for (let column = 0; column < 7; column += 1) {
    const pile = [];
    if (column === 0) {
      // A lone face-down card: the reveal target, fully visible in its fan.
      pile.push({ faceUp: false, card: null });
    } else {
      for (let k = 0; k < column; k += 1) pile.push({ faceUp: false, card: null });
      pile.push({ faceUp: true, card: deck[next] ?? deck[0] });
      next += 1;
    }
    tableau.push(pile);
  }
  return {
    tableau,
    stockCount: 12,
    nextStockCard: { suit: "clubs", rank: 9 },
    waste: [],
    foundations: { spades: [], hearts: [], diamonds: [], clubs: [] },
    ply: 1,
    resetCount: 0,
    progress: { foundationCards: 0, revealedTableau: 0, percent: 0 },
    completed: false,
  };
}

// The cards a click on the stock draws, in order.
const DRAW_CARDS = [
  { suit: "spades", rank: 1 },
  { suit: "hearts", rank: 2 },
  { suit: "clubs", rank: 3 },
  { suit: "diamonds", rank: 4 },
  { suit: "spades", rank: 5 },
];

function Harness() {
  const [view, setView] = useState(initialState);

  const onMove = useCallback((move) => {
    if (move?.kind !== "draw") return;
    setView((current) => {
      const waste = current.waste ?? [];
      if ((current.stockCount ?? 0) > 0) {
        const card = DRAW_CARDS[waste.length % DRAW_CARDS.length];
        return {
          ...current,
          stockCount: current.stockCount - 1,
          waste: [...waste, card],
          ply: current.ply + 1,
        };
      }
      // The redeal: the waste is reversed onto the stock and the waste emptied.
      return {
        ...current,
        stockCount: waste.length,
        waste: [],
        ply: current.ply + 1,
      };
    });
  }, []);

  /** Emulate the snapshot after the move above a hidden card. */
  const reveal = () => {
    setView((current) => ({
      ...current,
      tableau: current.tableau.map((pile, column) =>
        column === 0 && pile[0] && !pile[0].faceUp
          ? [{ faceUp: true, card: { suit: "clubs", rank: 12 } }]
          : pile,
      ),
      ply: current.ply + 1,
    }));
  };

  /** Emulate moving the top waste card to its foundation. */
  const wasteToFoundation = () => {
    setView((current) => {
      const waste = current.waste ?? [];
      const top = waste[waste.length - 1];
      if (!top) return current;
      return {
        ...current,
        waste: waste.slice(0, -1),
        foundations: {
          ...current.foundations,
          [top.suit]: [...(current.foundations?.[top.suit] ?? []), top],
        },
        ply: current.ply + 1,
      };
    });
  };

  /** Emulate moving the top waste card to a tableau column. */
  const wasteToTableau = () => {
    setView((current) => {
      const waste = current.waste ?? [];
      const top = waste[waste.length - 1];
      if (!top) return current;
      const tableau = current.tableau.map((pile) => [...pile]);
      tableau[6].push({ faceUp: true, card: top });
      return { ...current, waste: waste.slice(0, -1), tableau, ply: current.ply + 1 };
    });
  };

  /** Put the board into the position a player reaches by drawing the deck out. */
  const setupRedeal = () => {
    setView((current) => ({
      ...current,
      stockCount: 0,
      waste: [
        { suit: "spades", rank: 8 },
        { suit: "hearts", rank: 9 },
        { suit: "clubs", rank: 10 },
      ],
      ply: current.ply + 1,
    }));
  };

  return (
    <div style={{ minHeight: "100vh", background: "#0b1220", padding: 16 }}>
      <output
        data-testid="qa-state"
        data-ply={view.ply}
        data-stock={view.stockCount}
        data-waste={view.waste.length}
      />
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
        <button data-testid="qa-reveal" onClick={reveal}>Reveal tableau card</button>
        <button data-testid="qa-waste-to-foundation" onClick={wasteToFoundation}>Waste → foundation</button>
        <button data-testid="qa-waste-to-tableau" onClick={wasteToTableau}>Waste → tableau</button>
        <button data-testid="qa-redeal-setup" onClick={setupRedeal}>Set up redeal</button>
      </div>
      <div style={{ maxWidth: 980, margin: "0 auto" }}>
        <SolitaireBoard
          view={view}
          interactive={!READONLY}
          readOnly={READONLY}
          onMove={onMove}
          onInvalid={() => {}}
        />
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")).render(<Harness />);
