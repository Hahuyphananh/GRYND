# Mines Duel — Game Guide

Mines Duel is a **simultaneous, independent-board competitive scoring** game. Both players race at the same time, each on their **own** server-generated 10×10 boards. There are no turns: whoever scores more when the boards are done — or the 180-second clock runs out — wins.

> The previous shared-board, alternating-turn duel is retired. Legacy rows and enum labels (`p1_turn` / `p2_turn`) are kept only so old matches still resolve to a known state.

## How a match works

1. **Matchmaking** — the host creates a lobby (free; stakes are retired). The server rolls two boards: same dimensions, **10 mines each**, same value distribution, **different mine positions**.
2. **Ready** — both seats fill and a 3-second banner runs. The server then flips the match to `active` and starts **one 180-second match timer** (server-authoritative).
3. **Play, simultaneously** — each player reveals or flags cells on their own board, at will. Every action is validated and scored by the server.

## Mines and values

Each board holds **10 mines**, drawn from a fixed server-side distribution:

| Value | Count |
| --- | --- |
| 10 | 5 |
| 20 | 3 |
| 30 | 1 |
| 50 | 1 |

The distribution is a single server constant (`MINE_VALUE_DISTRIBUTION`) so it can be rebalanced later. A mine's **value is hidden until that player correctly flags it**.

## Scoring

| Action | Points |
| --- | --- |
| Reveal a safe tile | +5 |
| Correctly flag a mine | + that mine's value |
| Wrong flag | −10 |
| Reveal a mine | −25 |
| Clear the whole board | +100 |

Scores **clamp at 0**. Every score change is computed server-side; a client can never submit a score.

- **Revealing a mine does not end the match** — the player sees that mine, loses 25, and keeps playing.
- A **wrong flag** costs 10 and its state is kept until that tile is eventually revealed.
- **Clearing a board** (every safe tile revealed and every mine resolved) awards +100, **locks** that player's board, and shows their final score to both players. The opponent keeps playing. Completion is **not** an automatic victory.

## The clock

One server-authoritative timer: **180 seconds**. It starts the instant the match goes `active` and is the same for both players. The client may render a countdown but never supplies time.

## End of match

The match ends when **both boards are complete** (immediately, without waiting for the clock) **or** the 180-second timer expires.

The winner is the **higher final score**. Ties resolve deterministically:

1. higher score
2. fewer mines hit
3. fewer incorrect flags
4. more correct flags
5. earlier board-completion timestamp
6. otherwise a **draw** (never random)

Resigning ends the match in the opponent's favour.

## Visibility / anti-cheat

- Neither board's mine positions or values leave the server while the match is live; a player only receives the cells they have resolved (with the clue for safe reveals) and the opponent's **public** progress (score, safe reveals, mines hit, completion).
- Both full boards are revealed only once the match is `finished` (the replay state).
- The routes accept **only** a `cellIndex`. Score, points, winner, mine value, mine position, completion and timer are all server-derived.

## Realtime & reconnection

The existing Mines realtime infrastructure is reused, not replaced. The
per-match Socket.IO room `mines-pvp:match:<id>` and the generic `lobby:updated`
"refetch the authoritative snapshot" relay carry all live updates — there is **no
new socket system** and no shared-board push.

- **`lobby:updated`** (unreserved, relayed by the client) is a bare refetch hint.
  Every successful action fans it out to the match room and the lobby room, so the
opponent refetches `/api/mines-pvp/match/<id>` — which recomputes every number
server-side and returns that viewer's OWN board plus the opponent's public
progress only.
- **`mines-pvp:score`** is a **server-only** cosmetic hint minted by
  `broadcastScoreEvent` (`{ seat, delta, reason }`, reason ∈ `safe` /
`correct_flag` / `wrong_flag` / `mine_hit` / `complete`). It drives score
animations and is never authoritative. The generic `room_event` relay **drops**
client-forged copies.
- **`mines-pvp:opponent:reconnected`** is the other **server-only** event,
emitted by the realtime-server when a player rejoins; client-forged copies are
dropped too.
- **Race safety**: two actions in flight are safe because the store takes a
`FOR UPDATE` row lock and its update is conditional on the status it validated
against, so a lost race returns 409 and never double-applies. The same cell
twice, an action at the timer edge, an action after the seat locked, and a
duplicated socket event are all rejected server-side.
- **Timer**: the server decides legality from `matchDeadline`. The client
countdown is visual only — a late action is refused with `Match timer has
expired` and changes no score or board.
- **Disconnects**: a blip never awards a win, freezes the opponent, or touches a
score/board. The socket's per-match participant is tracked; an abandoned socket
starts a grace timer whose expiry POSTs `/api/mines-pvp/disconnect-forfeit`.
Rejoining the room cancels that timer. The forfeit is *ignored* when the match
is already terminal, when the seat already **completed/locked** its board (the
finisher keeps its result), when it is a vs-AI practice match, and a waiting
lobby with no opponent is **cancelled** instead. On reconnect the client's
`/status` refetch returns the correct player-specific board state (own reveals,
flags, score, completion, timer) in every phase — normal play, after completion,
near expiry, and after the match finished.

## Persistence & replay

Every match row is server-authoritative (see `mines_pvp_matches` in
`src/db/schema.ts`). It stores each seat's own board
(`p1_board` / `p2_board`), scores (`p{N}_score`), revealed cells
(`p{N}_revealed`), flags (`p{N}_flags`) and confirmed mines
(`p{N}_correct_flags`), the public counters (`p{N}_safe_revealed`,
`p{N}_mines_hit`, `p{N}_correct_flag_count`, `p{N}_incorrect_flag_count`),
completion state + timestamp (`p{N}_completed` / `p{N}_completed_at` /
`p{N}_locked`), the shared clock (`started_at`, `match_deadline`,
`match_timer_seconds`) and the outcome (`result`, `winner_id`, `win_reason`).

At settlement the store writes one `mines_pvp_rounds` row holding the **full
replay**: both final boards with their mine values (`board_snapshot` /
`p2_board_snapshot`), both final scores, and each seat's complete final state
(`p1_final_state` / `p2_final_state` — revealed tiles, flags, correct flags,
safe reveals, mines hit, flag counts, completion flag and completion timestamp).
The finished-match API (`GET /api/mines-pvp/match/:id`) returns this under
`rounds`; an **active** match returns `rounds: []` and never leaks unrevealed
mines.

## Key numbers

| Constant | Value |
| --- | --- |
| Board | 10×10 (100 tiles), per player |
| Mines per board | 10 |
| Mine values | 10×5, 20×3, 30×1, 50×1 |
| Match timer | 180 seconds |
| Safe reveal | +5 |
| Wrong flag / mine hit | −10 / −25 |
| Board completion | +100 |
| Win reasons | `score`, `resign`, `disconnect` (`mine_hit` / `all_mines_flagged` on legacy rows) |
| Replay | `mines_pvp_rounds` — both boards, both final scores, both final states |
