-- roblox/src/client/Main.client.luau
-- Builds the entire solitaire board in code and drives it through the shared
-- Rules engine. Run via Rojo sync; nothing needs to be authored in Studio.

local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Shared = ReplicatedStorage:WaitForChild("Shared")
local Constants = require(Shared.Constants)
local Rules = require(Shared.Rules)
local Deck = require(Shared.Deck)
local CardView = require(script.Parent.CardView)

local player = Players.LocalPlayer
local RS = ReplicatedStorage
local StartMatch = RS:WaitForChild("StartMatch")
local SubmitScore = RS:WaitForChild("SubmitScore")
local GetLeaderboard = RS:WaitForChild("GetLeaderboard")
local JoinQueue = RS:WaitForChild("JoinQueue")
local LeaveQueue = RS:WaitForChild("LeaveQueue")

local gui = Instance.new("ScreenGui")
gui.Name = "GryndSolitaire"
gui.ResetOnSpawn = false
gui.Parent = player:WaitForChild("PlayerGui")

local root = Instance.new("Frame")
root.Name = "Board"
root.Size = UDim2.fromScale(1, 1)
root.BackgroundColor3 = Color3.fromRGB(18, 30, 24)
root.BorderSizePixel = 0
root.Parent = gui

local status = Instance.new("TextLabel")
status.Name = "Status"
status.Size = UDim2.new(1, 0, 0, 36)
status.Position = UDim2.new(0, 0, 0, 0)
status.BackgroundTransparency = 1
status.TextColor3 = Color3.new(1, 1, 1)
status.TextScaled = true
status.Font = Enum.Font.GothamBold
status.Text = "Solitaire — click Draw, then cards"
status.Parent = root

-- Layout containers
local topRow = Instance.new("Frame")
topRow.Name = "TopRow"
topRow.Size = UDim2.new(1, -20, 0, 110)
topRow.Position = UDim2.new(0, 10, 0, 44)
topRow.BackgroundTransparency = 1
topRow.Parent = root

local tableauFrame = Instance.new("Frame")
tableauFrame.Name = "Tableau"
tableauFrame.Size = UDim2.new(1, -20, 1, -170)
tableauFrame.Position = UDim2.new(0, 10, 0, 164)
tableauFrame.BackgroundTransparency = 1
tableauFrame.Parent = root

-- Foundations (4)
local foundations = {}
for i = 1, 4 do
	local f = Instance.new("Frame")
	f.Name = "Foundation" .. i
	f.Size = UDim2.new(0, 70, 0, 100)
	f.Position = UDim2.new(0, (i - 1) * 78, 0, 0)
	f.BackgroundColor3 = Color3.fromRGB(30, 50, 40)
	f.BorderSizePixel = 1
	f.BorderColor3 = Color3.fromRGB(80, 120, 90)
	f.Parent = topRow
	foundations[i] = f
end

-- Stock + waste
local stockFrame = Instance.new("Frame")
stockFrame.Name = "Stock"
stockFrame.Size = UDim2.new(0, 70, 0, 100)
stockFrame.Position = UDim2.new(0, 4 * 78 + 20, 0, 0)
stockFrame.BackgroundColor3 = Color3.fromRGB(30, 50, 40)
stockFrame.BorderSizePixel = 1
stockFrame.BorderColor3 = Color3.fromRGB(80, 120, 90)
stockFrame.Parent = topRow

local wasteFrame = Instance.new("Frame")
wasteFrame.Name = "Waste"
wasteFrame.Size = UDim2.new(0, 70, 0, 100)
wasteFrame.Position = UDim2.new(0, 4 * 78 + 98, 0, 0)
wasteFrame.BackgroundColor3 = Color3.fromRGB(30, 50, 40)
wasteFrame.BorderSizePixel = 1
wasteFrame.BorderColor3 = Color3.fromRGB(80, 120, 90)
wasteFrame.Parent = topRow

local drawBtn = Instance.new("TextButton")
drawBtn.Name = "Draw"
drawBtn.Size = UDim2.new(0, 70, 0, 36)
drawBtn.Position = UDim2.new(0, 4 * 78 + 176, 0, 32)
drawBtn.BackgroundColor3 = Color3.fromRGB(60, 110, 80)
drawBtn.TextColor3 = Color3.new(1, 1, 1)
drawBtn.Text = "Draw"
drawBtn.Font = Enum.Font.GothamBold
drawBtn.TextScaled = true
drawBtn.Parent = topRow

local newBtn = Instance.new("TextButton")
newBtn.Name = "NewGame"
newBtn.Size = UDim2.new(0, 90, 0, 36)
newBtn.Position = UDim2.new(0, 4 * 78 + 254, 0, 32)
newBtn.BackgroundColor3 = Color3.fromRGB(90, 70, 130)
newBtn.TextColor3 = Color3.new(1, 1, 1)
newBtn.Text = "New Game"
newBtn.Font = Enum.Font.GothamBold
newBtn.TextScaled = true
newBtn.Parent = topRow

-- Tableau columns
local columns = {}
for c = 1, Constants.TABLEAU_COLUMNS do
	local col = Instance.new("Frame")
	col.Name = "Col" .. c
	col.Size = UDim2.new(1 / Constants.TABLEAU_COLUMNS, -6, 1, 0)
	col.Position = UDim2.new((c - 1) / Constants.TABLEAU_COLUMNS, 3, 0, 0)
	col.BackgroundTransparency = 1
	col.Parent = tableauFrame
	columns[c] = col
end

-- State
local seed = math.floor(os.time())
local state = nil
local selected = nil -- { kind, ... }
local submittedFor = nil

local function newGame(s, label)
	seed = s
	state = Deck.stateFromSeed(seed)
	selected = nil
	render()
	status.Text = (label or "Seed") .. " " .. seed .. " — click Draw"
end

local function clearChildren(f)
	for _, ch in ipairs(f:GetChildren()) do
		if ch:IsA("GuiObject") then ch:Destroy() end
	end
end

local function render()
	-- Auto-submit score on first completion of this seed.
	if state and Rules.isComplete(state) and submittedFor ~= seed then
		submittedFor = seed
		SubmitScore:FireServer(state.ply)
	end

	-- Foundations
	for i, suit in ipairs(Constants.SUITS) do
		clearChildren(foundations[i])
		local pile = state.foundations[suit]
		if pile and #pile > 0 then
			CardView.create(pile[#pile], true, foundations[i])
		end
	end
	-- Stock
	clearChildren(stockFrame)
	if #state.stock > 0 then
		CardView.create(nil, false, stockFrame)
	end
	-- Waste
	clearChildren(wasteFrame)
	if #state.waste > 0 then
		CardView.create(state.waste[#state.waste], true, wasteFrame)
	end
	-- Tableau
	for c = 1, Constants.TABLEAU_COLUMNS do
		clearChildren(columns[c])
		local col = state.tableau[c]
		for r, pile in ipairs(col) do
			local cardFrame = CardView.create(pile.card, pile.faceUp, columns[c])
			cardFrame.Size = UDim2.new(1, 0, 0, 90)
			cardFrame.Position = UDim2.new(0, 0, 0, (r - 1) * 26)
			if pile.faceUp and pile.card then
				cardFrame.MouseButton1Click:Connect(function()
					if selected and selected.kind == "tableau" and selected.col == c - 1 and Rules.sameCard(selected.card, pile.card) then
						selected = nil
						status.Text = "Deselected"
					else
						selected = { kind = "tableau", col = c - 1, card = pile.card }
						status.Text = "Selected " .. pile.card.rank .. Constants.SUIT_GLYPHS[pile.card.suit]
					end
				end)
			end
		end
	end
	-- Waste click -> select
	wasteFrame.InputBegan:Connect(function() end)
end

-- Wire clicks via separate handlers attached once:
wasteFrame.MouseButton1Click:Connect(function()
	if #state.waste > 0 then
		selected = { kind = "waste" }
		status.Text = "Selected waste"
	end
end)

stockFrame.MouseButton1Click:Connect(function()
	local res = Rules.applyMove(state, { kind = "draw" })
	if res.ok then
		state = res.state
		render()
		status.Text = "Drew"
	else
		status.Text = res.error or "no draw"
	end
end)

drawBtn.MouseButton1Click:Connect(function()
	local res = Rules.applyMove(state, { kind = "draw" })
	if res.ok then
		state = res.state
		render()
		status.Text = "Drew"
	else
		status.Text = res.error or "no draw"
	end
end)

-- Tableau column click -> place selected
for c = 1, Constants.TABLEAU_COLUMNS do
	columns[c].MouseButton1Click:Connect(function()
		if not selected then return end
		local toCol = c - 1
		local move = nil
		if selected.kind == "waste" then
			move = { kind = "waste-to-tableau", toColumn = toCol }
		elseif selected.kind == "tableau" then
			move = { kind = "tableau-to-tableau", fromColumn = selected.col, card = selected.card, toColumn = toCol }
		elseif selected.kind == "foundation" then
			move = { kind = "foundation-to-tableau", suit = selected.suit, toColumn = toCol }
		end
		if not move then return end
		local res = Rules.applyMove(state, move)
		if res.ok then
			state = res.state
			selected = nil
			render()
			status.Text = "Moved"
			if Rules.isComplete(state) then status.Text = "You win!" end
		else
			status.Text = res.error or "illegal"
		end
	end)
end

-- Foundation click -> place selected
for i, suit in ipairs(Constants.SUITS) do
	foundations[i].MouseButton1Click:Connect(function()
		if not selected then return end
		local move = nil
		if selected.kind == "waste" then
			move = { kind = "waste-to-foundation", suit = suit }
		elseif selected.kind == "tableau" then
			move = { kind = "tableau-to-foundation", fromColumn = selected.col, card = selected.card, suit = suit }
		end
		if not move then return end
		local res = Rules.applyMove(state, move)
		if res.ok then
			state = res.state
			selected = nil
			render()
			status.Text = "Moved to foundation"
			if Rules.isComplete(state) then status.Text = "You win!" end
		else
			status.Text = res.error or "illegal"
		end
	end)
end

newBtn.MouseButton1Click:Connect(function()
	newGame(math.floor(os.time()), "New game")
end)

newGame(seed, "Seed")

-- Daily challenge
local dailyBtn = Instance.new("TextButton")
dailyBtn.Name = "Daily"
dailyBtn.Size = UDim2.new(0, 80, 0, 36)
dailyBtn.Position = UDim2.new(0, 4 * 78 + 352, 0, 32)
dailyBtn.BackgroundColor3 = Color3.fromRGB(130, 90, 50)
dailyBtn.TextColor3 = Color3.new(1, 1, 1)
dailyBtn.Text = "Daily"
dailyBtn.Font = Enum.Font.GothamBold
dailyBtn.TextScaled = true
dailyBtn.Parent = topRow
dailyBtn.MouseButton1Click:Connect(function()
	local Daily = require(Shared.Daily)
	newGame(Daily.seedForToday(), "Daily " .. Daily.label())
end)

-- 1v1 lobby
local pvpBtn = Instance.new("TextButton")
pvpBtn.Name = "OneVOne"
pvpBtn.Size = UDim2.new(0, 80, 0, 36)
pvpBtn.Position = UDim2.new(0, 4 * 78 + 440, 0, 32)
pvpBtn.BackgroundColor3 = Color3.fromRGB(50, 90, 130)
pvpBtn.TextColor3 = Color3.new(1, 1, 1)
pvpBtn.Text = "1v1"
pvpBtn.Font = Enum.Font.GothamBold
pvpBtn.TextScaled = true
pvpBtn.Parent = topRow

local inQueue = false
pvpBtn.MouseButton1Click:Connect(function()
	if inQueue then
		inQueue = false
		LeaveQueue:FireServer()
		pvpBtn.Text = "1v1"
		status.Text = "Left queue"
	else
		inQueue = true
		JoinQueue:FireServer()
		pvpBtn.Text = "Queue..."
		status.Text = "Queued for 1v1"
	end
end)

StartMatch.OnClientEvent:Connect(function(matchSeed)
	inQueue = false
	pvpBtn.Text = "1v1"
	newGame(matchSeed, "1v1 match")
	status.Text = "Match started — seed " .. matchSeed
end)

-- Theme picker
local themeBtn = Instance.new("TextButton")
themeBtn.Name = "Theme"
themeBtn.Size = UDim2.new(0, 80, 0, 36)
themeBtn.Position = UDim2.new(0, 4 * 78 + 528, 0, 32)
themeBtn.BackgroundColor3 = Color3.fromRGB(130, 110, 50)
themeBtn.TextColor3 = Color3.new(1, 1, 1)
themeBtn.Text = "Theme"
themeBtn.Font = Enum.Font.GothamBold
themeBtn.TextScaled = true
themeBtn.Parent = topRow
themeBtn.MouseButton1Click:Connect(function()
	local Theme = require(Shared.Theme)
	local t = Theme.next()
	themeBtn.Text = t.name
	render()
end)

-- Leaderboard
local lbBtn = Instance.new("TextButton")
lbBtn.Name = "Leaderboard"
lbBtn.Size = UDim2.new(0, 100, 0, 36)
lbBtn.Position = UDim2.new(0, 4 * 78 + 616, 0, 32)
lbBtn.BackgroundColor3 = Color3.fromRGB(70, 70, 90)
lbBtn.TextColor3 = Color3.new(1, 1, 1)
lbBtn.Text = "Top 10"
lbBtn.Font = Enum.Font.GothamBold
lbBtn.TextScaled = true
lbBtn.Parent = topRow
lbBtn.MouseButton1Click:Connect(function()
	local ok, data = pcall(function() return GetLeaderboard:InvokeServer() end)
	if not ok or not data then status.Text = "Leaderboard unavailable"; return end
	local lines = {"Top 10 (moves):"}
	for i, e in ipairs(data) do
		table.insert(lines, i .. ". " .. tostring(e.userId) .. " — " .. tostring(e.score))
	end
	status.Text = table.concat(lines, " | ")
end)

-- Submit score on win: hook into render? Instead check after each move in move handlers.
-- We'll submit in the place-card handlers below by detecting completion.

