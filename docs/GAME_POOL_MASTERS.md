# Pool Masters — Game Guide

Pool Masters is a physics-based **8-ball pool** duel: sink your group (solids or stripes), then the 8-ball, before your opponent does. Playable against the AI or a real opponent for a stake.

## How a match works

1. **Break** — the cue ball breaks the racked 15 balls.
2. **Groups** — after the break, the table is **open**: your first legally pocketed ball assigns your group.
   - **Solids** = balls 1–7; **Stripes** = balls 9–15.
   - Once assigned, you must hit your own group first on every shot.
3. **Turn rules** — sink one of your balls → you keep shooting; miss or foul → the turn passes.
4. **Fouls** (server-validated):
   - **Scratch** (cue ball pocketed) — ball in hand for the opponent.
   - Hitting the wrong group first, no rail contact after contact, or pocketing the **8-ball** early.
5. **Win** — clear your group, then legally pocket the **8-ball**. Pocketing the 8-ball early or on a foul loses the match.

## Rules engine

- The server is the single authority. `POST /api/pool/submit-shot` takes only the player's **decisions** — angle, pull, spin, and where the cue ball goes down when it has ball in hand — then simulates the stroke from the row's own rack with the game's own physics (`src/lib/pool/physics.ts`) and rules on the results with the game's own rulebook (`src/lib/pool/rules.ts`): first contact, rail-after-contact, scratch, open table, whether you keep the turn, and the winner.
- The page runs the same two modules over the same rack (`src/lib/pool/{rack,shoot}.ts`) so the shot it animates is the shot the server played; it adopts the server's ruling once its local rollout settles, and falls back to the local rulebook only if the request never arrived — which can never move coins, because the settlement is the server's.
- A match is a single game of 8-ball, not a race: the winner takes the pot and the match ends.
- The match row is locked for the stroke, the shot is journalled in `pool_shots`, and a retried stroke returns the state it already produced instead of being applied twice.

## Payout

- **Winner** — takes the pot: **1.8× their own stake** (both stakes, minus the platform's 10% rake).
- **Loser** — loses exactly the stake they agreed to.
- **Resign** — the remaining seat wins the same pot.
- **No draw** — 8-ball always resolves to a winner.

Both stakes are escrowed when the second player joins, so a match is never half-funded: a seat that cannot cover the stake leaves the lobby waiting. A **vs-AI** match is free — normalised to a 0 stake and settled locally — and moves no coins.

## Modes

- **Pool vs AI** — free practice.
- **Pool PvP** — staked 8-ball duel.

## Key numbers

| Constant | Value |
| --- | --- |
| Stake | 1–100 coins (`GLOBAL_MAX_BET`), required for a public PvP lobby |
| Payout | 1.8× the winner's stake (10% rake: `PVP_RAKE_PCT`) |
| Balls | 15 object balls + cue (8-ball rules) |
| Groups | Solids 1–7 / Stripes 9–15 |
| Win | Pocket your group, then the 8-ball legally |