-- roblox/src/server/Leaderboard.luau
local DataStoreService = game:GetService("DataStoreService")

local Leaderboard = {}
local STORE_NAME = "grynd_solitaire_fastest"

local store = DataStoreService:GetOrderedDataStore(STORE_NAME)

function Leaderboard.submit(userId, score)
	-- Lower score is better (moves or seconds). OrderedDataStore sorts ascending
	-- when we store negative? We store moves directly and read ascending.
	pcall(function()
		store:SetAsync(tostring(userId), score)
	end)
end

function Leaderboard.top(n)
	n = n or 10
	local ok, pages = pcall(function()
		return store:GetSortedAsync(true, n)
	end)
	if not ok then return {} end
	local result = {}
	local page = pages:GetCurrentPage()
	for _, entry in ipairs(page) do
		table.insert(result, { userId = entry.key, score = entry.value })
	end
	return result
end

return Leaderboard
