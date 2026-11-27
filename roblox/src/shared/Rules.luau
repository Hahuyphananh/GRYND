-- roblox/src/shared/Rules.luau
-- Port of the authoritative Klondike engine. Server is still the source of truth;
-- this module exists so the client can render optimistically and so a solo
-- practice board can run entirely on-device.

local Constants = require(script.Parent.Constants)

local Rules = {}

local SUITS = Constants.SUITS
local function isSuit(v) return typeof(v) == "string" and table.find(SUITS, v) ~= nil end
local function isRank(v) return typeof(v) == "number" and v == math.floor(v) and v >= 1 and v <= 13 end
local function isRedSuit(suit) return suit == "hearts" or suit == "diamonds" end
local function isColumnIndex(v) return typeof(v) == "number" and v == math.floor(v) and v >= 0 and v < Constants.TABLEAU_COLUMNS end

function Rules.isSuit(v) return isSuit(v) end
function Rules.isRank(v) return isRank(v) end
function Rules.isRedSuit(suit) return isRedSuit(suit) end

function Rules.toCard(value)
	if typeof(value) ~= "table" then return nil end
	if not isSuit(value.suit) or not isRank(value.rank) then return nil end
	return { suit = value.suit, rank = value.rank }
end

function Rules.sameCard(a, b)
	if not a or not b then return false end
	return a.suit == b.suit and a.rank == b.rank
end

local function emptyFoundations()
	return { spades = {}, hearts = {}, diamonds = {}, clubs = {} }
end

function Rules.initialStateFromDeal(deal)
	local state = {
		variant = deal.variant,
		variantVersion = deal.variantVersion,
		tableau = {},
		stock = {},
		waste = {},
		foundations = emptyFoundations(),
		ply = 0,
		resetCount = 0,
		peakFoundation = 0,
		completed = false,
		completedAtMs = nil,
	}
	for _, col in ipairs(deal.tableau) do
		local c = {}
		for _, p in ipairs(col) do
			table.insert(c, { card = p.card, faceUp = p.faceUp })
		end
		table.insert(state.tableau, c)
	end
	for _, card in ipairs(deal.stock) do
		table.insert(state.stock, { suit = card.suit, rank = card.rank })
	end
	return state
end

function Rules.cloneState(state)
	local s = {
		variant = state.variant,
		variantVersion = state.variantVersion,
		tableau = {},
		stock = {},
		waste = {},
		foundations = { spades = {}, hearts = {}, diamonds = {}, clubs = {} },
		ply = state.ply,
		resetCount = state.resetCount or 0,
		peakFoundation = state.peakFoundation,
		completed = state.completed,
		completedAtMs = state.completedAtMs,
	}
	for _, col in ipairs(state.tableau) do
		local c = {}
		for _, p in ipairs(col) do
			table.insert(c, { card = p.card and { suit = p.card.suit, rank = p.card.rank } or nil, faceUp = p.faceUp })
		end
		table.insert(s.tableau, c)
	end
	for _, card in ipairs(state.stock) do table.insert(s.stock, { suit = card.suit, rank = card.rank }) end
	for _, card in ipairs(state.waste) do table.insert(s.waste, { suit = card.suit, rank = card.rank }) end
	for _, suit in ipairs(SUITS) do
		for _, c in ipairs(state.foundations[suit] or {}) do
			table.insert(s.foundations[suit], { suit = c.suit, rank = c.rank })
		end
	end
	return s
end

function Rules.foundationCount(state)
	local total = 0
	for _, suit in ipairs(SUITS) do
		total = total + #(state.foundations[suit] or {})
	end
	return total
end

function Rules.revealedTableauCount(state)
	local faceDown = 0
	for _, col in ipairs(state.tableau) do
		for _, pile in ipairs(col) do
			if not pile.faceUp then faceDown = faceDown + 1 end
		end
	end
	return Constants.TABLEAU_CARDS - faceDown
end

function Rules.progressOf(state)
	local fc = Rules.foundationCount(state)
	return {
		foundationCards = fc,
		revealedTableau = Rules.revealedTableauCount(state),
		progressPercent = math.floor((fc / Constants.DECK_SIZE) * 100 + 0.5),
	}
end

function Rules.isComplete(state)
	return Rules.foundationCount(state) == Constants.DECK_SIZE
end

function Rules.foundationExpects(state, suit)
	local pile = state.foundations[suit] or {}
	if #pile == 0 then return Constants.ACE end
	return pile[#pile].rank + 1
end

function Rules.canPlaceOnTableau(card, top)
	if not top then return card.rank == Constants.KING end
	local diffColor = isRedSuit(card.suit) ~= isRedSuit(top.suit)
	return diffColor and card.rank == top.rank - 1
end

function Rules.tableauTop(state, column)
	local col = state.tableau[column + 1] -- 0-based column -> 1-based lua
	if not col or #col == 0 then return nil end
	return col[#col]
end

function Rules.faceUpRunFrom(state, column, head)
	local col = state.tableau[column + 1]
	if not col then return nil end
	local index = nil
	for i, pile in ipairs(col) do
		if pile.faceUp and pile.card and Rules.sameCard(pile.card, head) then index = i; break end
	end
	if not index then return nil end
	local run = {}
	for i = index, #col do
		local pile = col[i]
		if not pile.faceUp or not pile.card then return nil end
		local prev = run[#run]
		if prev then
			if not (prev.rank == pile.card.rank + 1) then return nil end
			if not (isRedSuit(prev.suit) ~= isRedSuit(pile.card.suit)) then return nil end
		end
		table.insert(run, pile.card)
	end
	return run
end

-- Move validation: returns { ok = true } or { ok = false, code, error }
function Rules.validateMove(state, move)
	if not state or not state.tableau then
		return { ok = false, code = "ILLEGAL_MOVE", error = "no board" }
	end
	if state.completed then
		return { ok = false, code = "ALREADY_COMPLETE", error = "already complete" }
	end
	if state.ply >= Constants.MAX_MOVES_PER_SEAT then
		return { ok = false, code = "MOVE_LIMIT_REACHED", error = "move limit" }
	end

	if move.kind == "draw" then
		if #state.stock > 0 or #state.waste > 0 then return { ok = true } end
		return { ok = false, code = "ILLEGAL_MOVE", error = "stock and waste empty" }
	elseif move.kind == "waste-to-foundation" then
		local card = state.waste[#state.waste]
		if not card then return { ok = false, code = "CARD_NOT_FOUND", error = "waste empty" } end
		if card.suit ~= move.suit then return { ok = false, code = "ILLEGAL_MOVE", error = "wrong suit" } end
		if card.rank ~= Rules.foundationExpects(state, move.suit) then
			return { ok = false, code = "ILLEGAL_MOVE", error = "foundation rejects" }
		end
		return { ok = true }
	elseif move.kind == "waste-to-tableau" then
		local card = state.waste[#state.waste]
		if not card then return { ok = false, code = "CARD_NOT_FOUND", error = "waste empty" } end
		local top = Rules.tableauTop(state, move.toColumn)
		if top and not top.faceUp then return { ok = false, code = "ILLEGAL_MOVE", error = "target not playable" } end
		if not Rules.canPlaceOnTableau(card, top and top.card or nil) then
			return { ok = false, code = "ILLEGAL_MOVE", error = "cannot place" }
		end
		return { ok = true }
	elseif move.kind == "tableau-to-foundation" then
		local top = Rules.tableauTop(state, move.fromColumn)
		if not top or not top.faceUp or not top.card then
			return { ok = false, code = "CARD_NOT_FOUND", error = "no face-up card" }
		end
		if not Rules.sameCard(top.card, move.card) then
			return { ok = false, code = "ILLEGAL_MOVE", error = "only top card" }
		end
		if move.card.suit ~= move.suit then return { ok = false, code = "ILLEGAL_MOVE", error = "wrong suit" } end
		if move.card.rank ~= Rules.foundationExpects(state, move.suit) then
			return { ok = false, code = "ILLEGAL_MOVE", error = "foundation rejects" }
		end
		return { ok = true }
	elseif move.kind == "tableau-to-tableau" then
		local run = Rules.faceUpRunFrom(state, move.fromColumn, move.card)
		if not run then return { ok = false, code = "CARD_NOT_FOUND", error = "no run" } end
		local top = Rules.tableauTop(state, move.toColumn)
		if top and not top.faceUp then return { ok = false, code = "ILLEGAL_MOVE", error = "target not playable" } end
		if not Rules.canPlaceOnTableau(run[1], top and top.card or nil) then
			return { ok = false, code = "ILLEGAL_MOVE", error = "cannot place run" }
		end
		return { ok = true }
	elseif move.kind == "foundation-to-tableau" then
		local pile = state.foundations[move.suit] or {}
		local card = pile[#pile]
		if not card then return { ok = false, code = "CARD_NOT_FOUND", error = "foundation empty" } end
		local top = Rules.tableauTop(state, move.toColumn)
		if top and not top.faceUp then return { ok = false, code = "ILLEGAL_MOVE", error = "target not playable" } end
		if not Rules.canPlaceOnTableau(card, top and top.card or nil) then
			return { ok = false, code = "ILLEGAL_MOVE", error = "cannot place" }
		end
		return { ok = true }
	end
	return { ok = false, code = "BAD_MOVE", error = "unknown move kind" }
end

function Rules.applyMove(state, move)
	local v = Rules.validateMove(state, move)
	if not v.ok then return { ok = false, code = v.code, error = v.error } end

	local next = Rules.cloneState(state)
	local revealed = {}

	local function exposeBottom(column)
		local col = next.tableau[column + 1]
		local bottom = col and col[#col]
		if bottom and not bottom.faceUp and bottom.card then
			bottom.faceUp = true
			table.insert(revealed, bottom.card)
		end
	end

	if move.kind == "draw" then
		if #next.stock > 0 then
			local card = table.remove(next.stock)
			table.insert(next.waste, card)
		else
			next.stock = {}
			for i = #next.waste, 1, -1 do table.insert(next.stock, next.waste[i]) end
			next.waste = {}
		end
	elseif move.kind == "waste-to-foundation" then
		local card = table.remove(next.waste)
		if card then table.insert(next.foundations[move.suit], card) end
	elseif move.kind == "waste-to-tableau" then
		local card = table.remove(next.waste)
		if card then table.insert(next.tableau[move.toColumn + 1], { card = card, faceUp = true }) end
	elseif move.kind == "tableau-to-foundation" then
		local source = next.tableau[move.fromColumn + 1]
		table.remove(source)
		table.insert(next.foundations[move.suit], move.card)
		exposeBottom(move.fromColumn)
	elseif move.kind == "tableau-to-tableau" then
		local source = next.tableau[move.fromColumn + 1]
		local headIndex = nil
		for i, pile in ipairs(source) do
			if pile.faceUp and pile.card and Rules.sameCard(pile.card, move.card) then headIndex = i; break end
		end
		local moving = {}
		for i = headIndex, #source do table.insert(moving, source[i]) end
		for i = #source, headIndex, -1 do table.remove(source) end
		for _, pile in ipairs(moving) do
			table.insert(next.tableau[move.toColumn + 1], { card = pile.card, faceUp = true })
		end
		exposeBottom(move.fromColumn)
	elseif move.kind == "foundation-to-tableau" then
		local pile = next.foundations[move.suit]
		local card = table.remove(pile)
		if card then table.insert(next.tableau[move.toColumn + 1], { card = card, faceUp = true }) end
	end

	next.ply = state.ply + 1
	next.peakFoundation = math.max(state.peakFoundation or 0, Rules.foundationCount(next))
	next.completed = Rules.foundationCount(next) == Constants.DECK_SIZE

	return { ok = true, state = next, revealed = revealed }
end

function Rules.viewForState(state)
	local tableau = {}
	for _, col in ipairs(state.tableau) do
		local c = {}
		for _, pile in ipairs(col) do
			if pile.faceUp and pile.card then
				table.insert(c, { faceUp = true, card = { suit = pile.card.suit, rank = pile.card.rank } })
			else
				table.insert(c, { faceUp = false, card = nil })
			end
		end
		table.insert(tableau, c)
	end
	local foundations = { spades = {}, hearts = {}, diamonds = {}, clubs = {} }
	for _, suit in ipairs(SUITS) do
		for _, c in ipairs(state.foundations[suit] or {}) do
			table.insert(foundations[suit], { suit = c.suit, rank = c.rank })
		end
	end
	local stockCount = #state.stock
	local nextStockCard = nil
	if stockCount > 0 then
		local c = state.stock[stockCount]
		nextStockCard = { suit = c.suit, rank = c.rank }
	end
	local waste = {}
	for _, c in ipairs(state.waste) do table.insert(waste, { suit = c.suit, rank = c.rank }) end
	return {
		tableau = tableau,
		stockCount = stockCount,
		nextStockCard = nextStockCard,
		waste = waste,
		foundations = foundations,
		ply = state.ply,
		resetCount = state.resetCount or 0,
		progress = Rules.progressOf(state),
		completed = state.completed == true,
		canRedeal = (stockCount == 0 and #state.waste > 0),
	}
end

return Rules
