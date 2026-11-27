-- roblox/src/shared/Types.luau
-- Mirrors src/lib/solitaire-duel/types.ts

local Types = {}

export type Suit = "spades" | "hearts" | "diamonds" | "clubs"
export type Rank = number -- 1..13
export type Card = { suit: Suit, rank: Rank }
export type Color = "red" | "black"

export type PileCard = { card: Card?, faceUp: boolean }
export type FoundationPiles = { [Suit]: { Card } }

export type SolitaireState = {
	variant: string,
	variantVersion: number,
	tableau: { { PileCard } },
	stock: { Card },
	waste: { Card },
	foundations: FoundationPiles,
	ply: number,
	resetCount: number,
	peakFoundation: number,
	completed: boolean,
	completedAtMs: number?,
}

export type SolitaireDeal = {
	variant: string,
	variantVersion: number,
	tableau: { { PileCard } },
	stock: { Card },
}

export type SolitaireMove =
	{ kind: "draw" }
	| { kind: "waste-to-foundation", suit: Suit }
	| { kind: "waste-to-tableau", toColumn: number }
	| { kind: "tableau-to-foundation", fromColumn: number, card: Card, suit: Suit }
	| { kind: "tableau-to-tableau", fromColumn: number, card: Card, toColumn: number }
	| { kind: "foundation-to-tableau", suit: Suit, toColumn: number }

export type SeatProgress = {
	foundationCards: number,
	revealedTableau: number,
	progressPercent: number,
}

return Types
