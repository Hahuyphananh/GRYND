# Crash Arena — Game Guide

Crash Arena is a **crash-curve game of chicken**. A multiplier curve climbs
while a hand is live; everyone antes the same amount, and anyone can **Fold
at any moment** — the last player to fold takes the biggest share of the
pot, and anyone still in when the curve crashes gets nothing. It rewards
reading the curve and outlasting the other players.

## How a match works

1. **Table & rounds** — players sit at a crash-arena table (multi-player,
   with AI seats available). Each round follows a state machine:
   - **Waiting** — players opt in (**Play**) or sit out (**Sit Out**).
   - **Running** — the hand is live: everyone has antes, and the crash
     curve climbs underneath.
2. **The ante** — every player posts the **table wager** at the start of
   each hand. No blinds, no dealer, no roles — the pot is just the antes
   (plus any carry-over). Short stacks post everything and ride all-in.
3. **Fold anytime** — one decision, one button. Fold at any multiplier to
   bow out: your ante stays in the pot as dead money, and your **fold
   rank** decides your share. Each accepted fold **freezes the curve for
   3 seconds** so the whole table gets time to read the reveal (who folded
   + their now-public insight) — the freeze is real and server-
   authoritative: the crash clock stops, every client holds the exact same
   frozen multiplier, and the flight resumes together at the same moment.
4. **Ranked payouts** — when the hand ends, players rank by fold order:
   rank 1 is the **last player to fold** (or the last one standing when
   everyone else folded), rank 2 is the second-to-last folder, and so on.
   The pot (minus the 5% fee) is split by rank with linear weights — 1st
   takes the biggest share, every folder gets something, and **crash
   victims get nothing**.
5. **Crash** — the multiplier hits the (hidden, provably-fair) crash point
   and the hand is over. If **nobody folded**, no one wins and the whole
   pot **carries over** to the next hand.

## Private Insights (signals)

Every entered player is dealt one **private insight** per hand — a quality
tier plus a claim about the crash zone:

| Tier | P(claim names the crash zone) | Dealt to humans |
| --- | --- | --- |
| Strong | 72% | 30% |
| Medium | 58% | 40% |
| Weak | 46% | 30% |

- **Claims** name one of four zones: under 2.5×, 2.5–4.5×, 4.5–6.5×,
  over 6.5×. Each player draws their claim independently, so seats see
  different reads every hand (and the tier distribution is identical for
  every human — a fair, symmetric draw).
- **Privacy** — your insight shows only to you while the hand runs. It goes
  **public to the whole table the moment you fold**, and every unrevealed
  insight is revealed when the hand settles.
- **Bot seats** draw from difficulty-gated tiers (easy bots draw mostly
  weak reads, hard bots mostly strong) so the reads bots reveal when they
  fold are flavored by their difficulty.
- **Why it's skill** — the pot pays **fold order, not tip accuracy**:
  a wrong "strong" tip can still win you the pot if your early fold is the
  last fold before the crash. The insight is a read to weigh, never a
  free answer, and every reveal is public so you can calibrate opponents
  (and yourself) over time.
- **Engine** — `src/lib/games/crash/signals.ts` (pure, generator-free
  calibration enforced by the deal construction: each claim names the true
  zone with probability equal to the published accuracy). Tip is keyed by
  `userId` on the hand snapshot; the tables API never returns another
  player's private tip mid-hand.

## Provably fair

- The **seed hash** is published before the hand; the **seed** is revealed
  after it crashes, so the crash point is verifiable.
- The crash point is **never** generated on the client — it arrives only
  with the server's crash event.

## Payout

- The pot is awarded by fold-order ranking (see above); the house keeps
  the standard 5% platform fee.

## Interface notes

- The arena shows the live crash curve, each player's seat + stack, a
  **CRASH RISK** meter (pure visual read on the multiplier), and one big
  **Fold** button while you're in the hand. When a fold is accepted, a
  **Paused** card pops up over the frozen curve — who folded, at what
  multiplier, their revealed insight, and a countdown to the resume.
- A round timer drives the phases; the server is the source of truth for
  money (the client only renders and drives the Fold button).

## Key numbers

| Constant | Value |
| --- | --- |
| Curve growth rate | 0.11 (`multiplier = e^(0.11·t)`) |
| Crash range | 1.20× – 9.20× |
| Ante (per hand) | table wager, same for every player |
| Fold | any time, any multiplier |
| Fold pause | 3s freeze of the curve (all clients) after every accepted fold |
| Platform fee | 5% of the pot |
| Payout split | linear weights: rank r of R → (R − r + 1) |
| Min buy-in | 5× table wager |
| Max players | 6 |