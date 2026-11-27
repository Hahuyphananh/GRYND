-- roblox/src/shared/Constants.luau
-- Mirrors src/lib/solitaire-duel/constants.ts

local Constants = {}

Constants.SUITS = { "spades", "hearts", "diamonds", "clubs" }
Constants.RED_SUITS = { hearts = true, diamonds = true }
Constants.ACE = 1
Constants.KING = 13
Constants.DECK_SIZE = 52
Constants.TABLEAU_COLUMNS = 7
Constants.TABLEAU_CARDS = 28
Constants.MAX_MOVES_PER_SEAT = 10000
Constants.VARIANT = "klondike"
Constants.VARIANT_VERSION = 3

Constants.SUIT_GLYPHS = {
	spades = "♠", hearts = "♥", diamonds = "♦", clubs = "♣",
}
Constants.RANK_LABELS = {
	[1] = "A", [11] = "J", [12] = "Q", [13] = "K",
}

function Constants.isRedSuit(suit)
	return Constants.RED_SUITS[suit] == true
end

return Constants
