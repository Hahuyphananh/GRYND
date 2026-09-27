# Mines Duel — Game Guide

Mines Duel is a 1v1 (or vs-AI) nerve game on a **shared 5×5 board** with a hidden minefield. Both players act on the **same** board: safe reveals and their clues are public, flags are private claims, stepping on a mine loses instantly, and flagging every mine wins instantly.

## How a match works

1. **Matchmaking** — pick a stake in the lobby (free AI practice is token-free). The **host chooses the mine count** (1–24). The server generates the hidden 5×5 board and randomizes turn order at match creation.
2. **Alternating turns** — players act in a fixed, server-computed pattern (pairs of turns — the pair-leader swaps every pair, so the pattern repeats every 4 turns):
   - Turn order: FP, SP, SP, FP, FP, SP, SP, FP, …
   - The first pick is granted mercy (a safe reveal even if the mine count is high).
3. **Each turn has a 20-second window** — on a turn you either:
   - **Reveal** a tile. A safe tile and its **public clue** (the Chebyshev distance to the nearest mine) are shown to BOTH players; the first reveal lands on a guaranteed-safe tile.
   - **Flag** a tile you believe is a mine. Flags are **per-player claims** — each seat has its own set, the same cell can be flagged by both, and the sets are public.
4. **Instant endings — there is no draw:**
   - **Reveal a mine → you lose immediately.** The opponent wins with `win_reason = 'mine_hit'`.
   - **Claim every mine correctly → you win immediately** with `win_reason = 'all_mines_flagged'`.
   - A **wrong claim is NOT a loss** — it simply costs your turn.
   - Resigning or disconnecting ends the match too (`win_reason ∈ {'resign','disconnect'}`).
5. **Finished matches are closed** — once a match is FINISHED the server rejects every further action, and the full board is revealed for replay.

## Payout

- **Winner** — own stake back + **90%** of the loser's stake.
- **Loser** — loses the entire stake.
- **House** — 10% rake on the loser's stake only.
- (Stakes are currently retired and normalized to 0; there is no draw/refund path.)

## Modes

- **Mines Duel vs AI** — free practice against the GRYND AI (reveal-only — the bot never flags).
- **Mines Duel PvP** — real-time duel against another player on the shared board.

## Key numbers

| Constant | Value |
| --- | --- |
| Board | 5×5 (25 tiles, shared by both players) |
| Mines per board | 1–24 (host-chosen at lobby creation) |
| Turn timer | 20 seconds per turn |
| House rake (PvP) | 10% of the loser's stake |
| Win reasons | `mine_hit`, `all_mines_flagged`, `resign`, `disconnect` |
