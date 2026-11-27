-- roblox/src/shared/Deck.luau
-- Seeded Klondike deal. Not the verified solvable generator used by the web
-- app, but sufficient for a practice board and for 1v1 lobbies. Replace with
-- the verified generator before rating matches.

local Constants = require(script.Parent.Constants)
local Rules = require(script.Parent.Rules)

local Deck = {}

-- Mulberry32 PRNG (deterministic, good enough for card shuffles).
local function rng(seed)
	local s = seed
	return function()
		s = (s + 0x6D2B79F5) % 0x100000000
		local t = s
		t = (t ~ (t >> 15)) * (t | 1)
		t = (t ~ (t + (t * (t ~ (t >> 7)))) * (t | 61)) % 0x100000000
		return ((t ~ (t >> 14)) % 0x100000000) / 0x100000000
	end
end

function Deck.newDeck()
	local cards = {}
	for _, suit in ipairs(Constants.SUITS) do
		for rank = 1, 13 do
			table.insert(cards, { suit = suit, rank = rank })
		end
	end
	return cards
end

function Deck.shuffle(cards, seed)
	local r = rng(seed or os.time())
	for i = #cards, 2, -1 do
		local j = math.floor(r() * i) + 1
		cards[i], cards[j] = cards[j], cards[i]
	end
	return cards
end

function Deck.dealFromSeed(seed)
	local cards = Deck.shuffle(Deck.newDeck(), seed)
	local deal = {
		variant = Constants.VARIANT,
		variantVersion = Constants.VARIANT_VERSION,
		tableau = {},
		stock = {},
	}
	for col = 1, Constants.TABLEAU_COLUMNS do
		deal.tableau[col] = {}
	end
	local idx = 1
	for col = 1, Constants.TABLEAU_COLUMNS do
		for row = 1, col do
			local card = cards[idx]; idx = idx + 1
			local faceUp = (row == col)
			table.insert(deal.tableau[col], { card = card, faceUp = faceUp })
		end
	end
	for i = idx, #cards do
		table.insert(deal.stock, cards[i])
	end
	return deal
end

function Deck.stateFromSeed(seed)
	return Rules.initialStateFromDeal(Deck.dealFromSeed(seed))
end

return Deck
