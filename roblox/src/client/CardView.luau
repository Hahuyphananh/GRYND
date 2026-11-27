-- roblox/src/client/CardView.luau
-- Builds a Roblox GUI card that mirrors the web PlayingCard (rank + suit glyph,
-- red/black colouring). Cards are Frames so they can be dragged/animated.

local Constants = require(game.ReplicatedStorage.Shared.Constants)

local CardView = {}

local RED = Color3.fromRGB(216, 31, 58)
local BLACK = Color3.fromRGB(20, 26, 36)
local FACE = Color3.fromRGB(232, 236, 243)

local function rankLabel(rank)
	return Constants.RANK_LABELS[rank] or tostring(rank)
end

local function suitGlyph(suit)
	return Constants.SUIT_GLYPHS[suit] or ""
end

function CardView.create(card, faceUp, parent)
	local frame = Instance.new("Frame")
	frame.Name = "Card"
	frame.Size = UDim2.fromScale(1, 1)
	frame.BackgroundColor3 = FACE
	frame.BorderSizePixel = 0
	frame.Parent = parent

	local corner = Instance.new("UICorner")
	corner.CornerRadius = UDim.new(0, 6)
	corner.Parent = frame

	if not faceUp or not card then
		-- Back face: simple pattern
		frame.BackgroundColor3 = Color3.fromRGB(40, 60, 120)
		return frame
	end

	local red = Constants.isRedSuit(card.suit)
	local color = red and RED or BLACK

	local rank = Instance.new("TextLabel")
	rank.Name = "Rank"
	rank.Size = UDim2.new(0.5, 0, 0.35, 0)
	rank.Position = UDim2.new(0.08, 0, 0.06, 0)
	rank.BackgroundTransparency = 1
	rank.Text = rankLabel(card.rank) .. suitGlyph(card.suit)
	rank.TextColor3 = color
	rank.TextScaled = true
	rank.Font = Enum.Font.GothamBold
	rank.Parent = frame

	local pip = Instance.new("TextLabel")
	pip.Name = "Pip"
	pip.Size = UDim2.new(0.6, 0, 0.5, 0)
	pip.Position = UDim2.new(0.2, 0, 0.35, 0)
	pip.BackgroundTransparency = 1
	pip.Text = suitGlyph(card.suit)
	pip.TextColor3 = color
	pip.TextScaled = true
	pip.Font = Enum.Font.GothamBold
	pip.Parent = frame

	return frame
end

return CardView
