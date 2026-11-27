-- roblox/src/server/Bootstrap.server.luau
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Players = game:GetService("Players")

local Shared = ReplicatedStorage:WaitForChild("Shared")
local Leaderboard = require(script.Parent.Leaderboard)
local Lobby = require(script.Parent.Lobby)

local function mkRemote(name, className)
	local r = ReplicatedStorage:FindFirstChild(name)
	if not r then
		r = Instance.new(className)
		r.Name = name
		r.Parent = ReplicatedStorage
	end
	return r
end

local StartMatch = mkRemote("StartMatch", "RemoteEvent")
local SubmitScore = mkRemote("SubmitScore", "RemoteEvent")
local GetLeaderboard = mkRemote("GetLeaderboard", "RemoteFunction")
local JoinQueue = mkRemote("JoinQueue", "RemoteEvent")
local LeaveQueue = mkRemote("LeaveQueue", "RemoteEvent")

-- Leaderboard query
GetLeaderboard.OnServerInvoke = function(player)
	return Leaderboard.top(10)
end

-- Score submission
SubmitScore.OnServerEvent:Connect(function(player, score)
	if typeof(score) ~= "number" then return end
	score = math.clamp(math.floor(score), 0, 100000)
	Leaderboard.submit(player.UserId, score)
end)

-- Lobby
JoinQueue.OnServerEvent:Connect(function(player)
	Lobby.join(player)
end)
LeaveQueue.OnServerEvent:Connect(function(player)
	Lobby.leave(player)
end)

-- Clean up queue on leave
Players.PlayerRemoving:Connect(function(player)
	Lobby.leave(player)
end)

print("Bootstrap ready")
