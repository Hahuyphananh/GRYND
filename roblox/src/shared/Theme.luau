-- roblox/src/shared/Theme.luau
local Theme = {}

Theme.PALETTES = {
	{ name = "Midnight", back = Color3.fromRGB(40, 60, 120), pattern = Color3.fromRGB(255, 255, 255) },
	{ name = "Crimson",  back = Color3.fromRGB(120, 30, 40),  pattern = Color3.fromRGB(255, 220, 220) },
	{ name = "Forest",   back = Color3.fromRGB(30, 80, 50),   pattern = Color3.fromRGB(220, 255, 220) },
	{ name = "Gold",     back = Color3.fromRGB(110, 90, 30),  pattern = Color3.fromRGB(255, 240, 200) },
}

Theme.current = 1

function Theme.get()
	return Theme.PALETTES[Theme.current]
end

function Theme.next()
	Theme.current = (Theme.current % #Theme.PALETTES) + 1
	return Theme.get()
end

return Theme
