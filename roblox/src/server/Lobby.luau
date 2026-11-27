-- roblox/src/server/Lobby.luau
-- Minimal 1v1 matchmaking. Pairs two queued players and hands them a shared
-- deal seed so both seats play the same board (mirrors the web duel).

local Lobby = {}

local queue = {}
local nextSeed = 1000

local function popTwo()
	if #queue < 2 then return nil end
	local a = table.remove(queue, 1)
	local b = table.remove(queue, 1)
	return a, b
end

function Lobby.join(player)
	table.insert(queue, player)
	local a, b = popTwo()
	if a and b then
		nextSeed = nextSeed + 1
		local seed = nextSeed
		-- Hand the seed to both clients via a RemoteEvent (created in Studio).
		local ev = game.ReplicatedStorage:FindFirstChild("StartMatch")
		if ev then
			ev:FireClient(a, seed)
			ev:FireClient(b, seed)
		end
	end
end

function Lobby.leave(player)
	for i, p in ipairs(queue) do
		if p == player then table.remove(queue, i); break end
	end
end

return Lobby
