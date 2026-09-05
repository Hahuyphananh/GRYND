# Chess — Game Guide

Chess on GRYND is classic chess played against the GRYND AI (5 difficulty levels) or against another player in real-time PvP duels. Same rules as standard chess: checkmate your opponent's king to win.

## How a match works

1. **Mode** — play vs the AI (choose a difficulty level) or create/join a PvP match with a stake.
2. **Standard chess rules** — all pieces move exactly as in FIDE chess; the game is fully governed by the chess.js rules engine.
   - Legal moves only, castling, en passant, promotion (with a promotion picker).
   - **Check and checkmate** end the game; stalemate and draws resolve normally.
3. **Turn play** — you move, then the opponent (AI or human) moves. An on-board clock counts each side's remaining time — run out of time and you lose the game.

## AI difficulty

- The AI uses **minimax with alpha-beta pruning**; the search depth scales with the chosen level:
  - Level 1–5 maps to a minimax depth of 2–6 (depth = level + 1, capped).
  - Higher levels look further ahead and play measurably stronger.
- The AI plays its own colour (you can play as white or black) and shows a "Thinking…" indicator while computing.

## Payout (PvP)

- **Winner** — takes the pot (stake back + winnings; 90/10 rake on the loser's stake).
- **Loser** — loses the stake.
- **Draw** — both refunded.

## Modes

- **Chess vs AI** — free practice, any difficulty.
- **Chess PvP** — real-time duel for the stake pot (with clocks).

## Key numbers

| Constant | Value |
| --- | --- |
| Board | Standard 8×8 |
| AI difficulty | 5 levels (minimax depth 2–6) |
| Timers | Per-side game clocks |