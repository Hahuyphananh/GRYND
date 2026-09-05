# Crash Arena — Game Guide

Crash Arena is a **crash-curve poker hybrid**. A multiplier curve climbs while a hand is live; betting checkpoints open along the way, and players bet their chips on the hand — but if the curve crashes before you fold out, your hand (and your bets) are gone. It rewards reading the crash curve and knowing when to get out.

## How a match works

1. **Table & rounds** — players sit at a crash-arena table (multi-player, with AI seats available). Each round follows a state machine:
   - **Waiting** — players opt in (**Play**) or sit out (**Sit Out**).
   - **Running** — the hand is live: blinds/antes are posted, and the crash curve climbs underneath.
2. **Betting along the curve** — betting checkpoints open at **1.25×** and then every **+0.25×** after that. At each checkpoint players can **fold**, **call**, or **raise** on the hand. The curve keeps climbing while the betting continues.
3. **Crash** — the multiplier hits the (hidden, provably-fair) crash point and the hand is over. Anyone still in the hand when it crashes loses their bets; players who folded earlier keep whatever they committed to the pot at their fold point.
4. **Settlement** — the winner is determined by fold-order / pot rules and the pot is distributed. Side pots are computed and refunded per the tier accounting rules.

## Provably fair

- The **seed hash** is published before the hand; the **seed** is revealed after it crashes, so the crash point is verifiable.
- The crash point is **never** generated on the client — it arrives only with the server's crash event.

## Payout

- The pot (main + side pots) is awarded per the crash-poker settlement rules; the house keeps the standard PvP rake.

## Interface notes

- The arena shows the live crash curve, each player's seat + stack, and the current betting checkpoint.
- A round timer drives the phases; the server is the source of truth for money (the client only renders and drives the betting UI).

## Key numbers

| Constant | Value |
| --- | --- |
| First betting checkpoint | 1.25× |
| Checkpoint interval | +0.25× |
| Phases | waiting → running → crashed → settling |