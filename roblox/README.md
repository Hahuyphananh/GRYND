# GRYND Solitaire — Roblox port

Roblox Studio is installed at
`%LOCALAPPDATA%\Roblox\Versions\version-8d7a1009c17e4ff8\RobloxStudioBeta.exe`.

## Syncing this repo into Studio

1. Install Rojo: `cargo install rojo` (or via Aftman).
2. From this folder: `rojo serve default.project.json`.
3. In Studio: Plugins → Rojo → Connect. The shared/server/client folders sync live.

## What is ported so far

- `src/shared/Constants.luau` — suits, ranks, tableau size.
- `src/shared/Types.luau` — Card, SolitaireState, moves.
- `src/shared/Deck.luau` — seeded Klondike deal (replace with the verified
  solvable generator before rating matches).
- `src/shared/Rules.luau` — move validation + applyMove + progress + view.
- `src/client/CardView.luau` — renders a card (rank + suit glyph, red/black).
- `src/server/Leaderboard.luau` — OrderedDataStore fastest-time board.
- `src/server/Lobby.luau` — 1v1 queue + shared seed.

## Still to build

- Board UI (tableau/waste/stock/foundations) and drag/tap input.
- Move application wiring + optimistic render.
- Result screen + leaderboard submission.
- Daily seeded deal + persistence (DataStore).
- Practice bot (optional; the web app has one).
- Card-back themes and sounds.

## Notes

- The web app's "card art" is CSS-rendered (Unicode suit glyphs + rank labels),
  so `CardView` reproduces that look rather than importing image assets.
- 1v1 lobbies share one deal seed so both seats race on identical boards.
