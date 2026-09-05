# Poker — Game Guide

Poker on GRYND is **multi-table No-Limit Texas Hold'em** played against other players (with AI seats filling a table when needed). Classic Hold'em: blinds, community cards, betting rounds, and the best five-card hand wins the pot.

## How a match works

1. **Table & seats** — join a poker table (multi-player). Each player sits at a seat with a stack; the game sets the **small blind** and **big blind** each hand.
2. **Deal** — each player gets two hole cards. Community cards are dealt across three streets:
   - **Pre-flop** — action starts left of the big blind.
   - **Flop** — 3 community cards.
   - **Turn** — 1 more community card.
   - **River** — final community card.
3. **Betting rounds** — on your turn you can **fold**, **call**, or **raise** (No-Limit: any raise up to your stack). Betting checkpoints follow standard Hold'em order; the hand ends when all active players have matched the current bet or everyone folds.
4. **Showdown** — remaining players reveal their hands; the best five-card poker hand (using any combination of hole + community cards) wins the pot. A folded player loses their committed chips.

## Game rules

- Standard **hand rankings** (royal flush → high card).
- **Blinds** rotate every hand; dead button/house rules follow standard table play.
- AI seats play through the same engine with a bot strategy, so a partially-full table still deals hands.

## Payout

- The pot (all bets) is awarded to the winning hand. The house keeps the standard PvP rake on the pot.

## Interface notes

- The table is a classic oval poker layout with seats, stacks, and a betting control bar (fold / call / raise).
- On narrow screens the app recommends rotating your device; creator-mode recording frames render a fitted phone-style table so recordings are readable in any orientation.

## Key numbers

| Constant | Value |
| --- | --- |
| Game | No-Limit Texas Hold'em |
| Community streets | Flop (3) → Turn (1) → River (1) |
| Blinds | Small + big blind per hand |