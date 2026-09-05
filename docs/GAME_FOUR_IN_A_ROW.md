# Four in a Row — Game Guide

Four in a Row is the classic **connect-4** duel: drop coloured discs into a 6×7 board and be the first to line up **four in a row** — horizontally, vertically, or diagonally. Playable against the AI or a real opponent for a stake.

## How a match works

1. **Mode** — play the AI (free practice) or a staked PvP match.
2. **Turn play** — on your turn, drop a disc into one of the 7 columns; it falls to the lowest free cell in that column.
3. **Win** — the first player to connect **4 discs in a line** (row, column, or diagonal) wins the round and takes the pot.
4. **Draw** — if the board fills with no four-in-a-row, the match is a draw and both stakes are refunded in full.

## Rules

- A column that is full can't be chosen (your turn continues).
- Win detection runs server-side after every drop — the server is the authority, the client animates.
- PvP matches show a clear "Your Turn" / "Opponent's Turn" indicator.

## Payout

- **Winner** — takes the pot (stake back + winnings; standard 90/10 rake on the loser's stake).
- **Loser** — loses the stake.
- **Draw** — both refunded in full.

## Modes

- **Four in a Row vs AI** — free practice.
- **Four in a Row PvP** — staked duel.

## Key numbers

| Constant | Value |
| --- | --- |
| Board | 6 rows × 7 columns |
| Win condition | 4 in a row (H/V/diagonal) |