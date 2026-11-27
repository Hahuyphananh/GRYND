-- roblox/src/shared/Daily.luau
local Daily = {}

function Daily.seedForToday()
	local d = os.date("!*t")
	-- Simple deterministic hash of YYYYMMDD
	local n = d.year * 10000 + d.month * 100 + d.day
	-- mix
	local s = (n * 2654435761) % 2147483647
	if s == 0 then s = 1 end
	return s
end

function Daily.label()
	local d = os.date("!*t")
	return string.format("%04d-%02d-%02d", d.year, d.month, d.day)
end

return Daily
