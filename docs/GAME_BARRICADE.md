# Barricade — rules engine

Barricade is GRYND's 9×9 race: two pawns start on the centre square of their own
baseline, each player has ten two-square barricades, and every turn is exactly
one pawn step (or jump) or one barricade placement. The first pawn to reach the
opposite baseline wins, and a barricade may never seal a player's last route.

This document covers the **pure rules engine** (`src/lib/barricade/`), the
**free practice experience** built on it (the board UI, the local bot and the
browser play-through harness) and the **online 1v1 match**: the API routes, the
two database tables, direct match creation/joining, the server-authoritative
store and the realtime channel. Online play is unstaked and deliberately unrated
— ratings, trophies, the quick-queue and the public catalogue swap are NOT part
of it, and free practice remains entirely client-side, with no network match and
no competitive progress.

## Files

| Path | What it is |
| --- | --- |
| `src/lib/barricade/constants.ts` | Board geometry, inventories, status/outcome vocabulary and every rejection code. Also quotes the two published rule sets this engine follows. |
| `src/lib/barricade/types.ts` | `BarricadeState`, `Position`, `WallPlacement`/`PlacedWall`, `BarricadeAction`/`LegalAction`, `MatchOutcome`, `RejectionCode`, and the validation verdicts. |
| `src/lib/barricade/rules.ts` | The engine: geometry, guards, pathfinding, legal-action generation, validation, application, and `BarricadeRuleError`. |
| `src/lib/barricade/ai.ts` | The practice bot (Easy / Normal / Hard) and the tier hints the difficulty picker shows. Drives the SAME `legalActions`/`applyAction` the human uses. |
| `src/components/barricade/BarricadeBoard.tsx` | The board. It renders a position and reports intent — no movement, barricade or path rule is re-implemented in the UI. |
| `src/app/casino/barricade/play-ai/` | The practice route (`page.tsx` metadata + `PageClient.tsx` turn loop, controls, rules dialog, result screen). |
| `src/lib/barricadeAudio.ts` | The board's own sound cues (shared audio context, like the other games). |
| `src/lib/barricade/serverStore.ts` | The ONLINE store: matchmaking, reads, the one gameplay mutation, resignation, lobby cancellation and disconnect resolution. Every transition is a row-locked `db.transaction`. |
| `src/lib/barricade/rooms.ts` | The Socket.IO room ids and event names (`barricade:match:<id>`, `barricade:ready`, `lobby:updated`) and the safe server-side broadcast helper. |
| `src/lib/barricade/ui.ts` | Pure view-model helpers for the online surface (status/turn copy, per-viewer outcome, snapshot staleness, the log labels). Owns no rule. |
| `src/app/api/barricade/` | The HTTP surface: `create-or-join`, `available`, `match/[matchId]` (the reconnect read), `/move`, `/forfeit`, `/cancel` and the internal `disconnect-forfeit`. |
| `src/app/casino/barricade/` | The online lobby (`page.tsx`/`PageClient.tsx`) and the match view (`[matchId]/`) — waiting room, board synchronisation, both reserves, resignation and the result screen. |
| `src/db/migrations/0207_barricade_pvp.sql` | `barricade_matches` + `barricade_moves` (with the unique `(match_id, ply)` anti-replay index). Idempotent, no money columns. |
| `tests/barricade-rules.test.mjs` | 50 tests: setup, movement, jumps, barricade geometry, path preservation, victory, terminal behaviour, rejection/immutability, plus a deterministic self-play fuzz cross-checked against an independent reference implementation. |
| `tests/barricade-ai.test.mjs` | The bot: every tier answers with an action the engine accepts, within the node and clock budgets, and the tiers differ by skill. |
| `tests/barricade-practice-ui.test.mjs` | The practice screen's contracts: the engine is the only rulebook, practice stays free (no wager/rating/network), every affordance has a hook, the groove grid is the engine's own 8×8 slot grid. |
| `tests/barricade-online-store.test.mjs` | The authoritative store, driven for real against a fake Drizzle client: authorization, turn ownership, stale versions, replayed plies, engine refusals, victory/settlement, resignation, lobby cancellation, disconnect resolution. |
| `tests/barricade-online-ui.test.mjs` | The online surface's contracts: the transport carries only an address + version, the room vocabulary matches the realtime server, every route is gated, the migration is idempotent and money-free, practice is untouched. |
| `qa/barricade-practice-check.mjs` | The browser play-through: complete matches at every tier, refused moves and barricades, restart, the result screen, and phone layouts. |
| `qa/barricade-online-check.mjs` | The online store against the REAL database: two seats, a played-out match, the concurrent-action race, refusals, settlement, cleanup. |

Run the suites with `npm run test:barricade` (rules + bot + UI contracts) and the
browser harness with `npm run verify:barricade` (see Verification below).

The engine imports nothing — no React, no HTTP, no Drizzle, no browser APIs, no
randomness. The same state always produces the same actions, which is what lets
the store, the board and (later) the AI share one implementation.

## Coordinates

* **Squares** are `(col, row)`, `0 ≤ col, row ≤ 8`. Column 0 is the left edge as
  seen from player1; row 0 is player1's own baseline and row 8 is player2's. So
  player1 walks up (row + 1) and player2 walks down. This matches the board
  game's own notation (a1 = near-left, player 1 on the near side).
* **Barricades** are addressed by the SLOT (groove intersection) their
  north-west square touches: `(col, row)` with `0 ≤ col, row ≤ 7`.
  - `horizontal` spans the groove between rows `row` and `row + 1`, across
    columns `col` and `col + 1` (it blocks up/down movement).
  - `vertical` spans the groove between columns `col` and `col + 1`, across rows
    `row` and `row + 1` (it blocks left/right movement).
  - Two barricades on the same slot **overlap** (same orientation) or **cross**
    (different orientation). Barricades that merely touch at a point — different
    slots — are legal, exactly as with the physical pieces.

## Rules as implemented

| Rule | Implementation |
| --- | --- |
| Setup | 9×9 board; pawns on `(4,0)` and `(4,8)`; 10 barricades each. |
| One action per turn | A turn is either one pawn move or one barricade placement; there is no pass. |
| Alternating turns | `turn` flips on every accepted action. |
| Pawn movement | One square orthogonally, forwards, sideways or backwards; never diagonally as an ordinary move. |
| Board edges | Off-board destinations are rejected (`out-of-bounds`). |
| Barricades block movement | Both players, in both directions across the groove. |
| Straight jump | With the pawns face to face across an open groove, a pawn jumps to the square beyond the opponent when that square is on the board and open. |
| Diagonal jump | When a barricade or the board edge sits directly behind the opponent, the pawn may instead move laterally to one of the two squares beside them, provided that lateral route is open. |
| Barricade conflicts | Overlap and crossing rejected before placement. |
| Path preservation | A placement that would leave EITHER pawn with no route to its goal baseline is rejected (`wall-blocks-path`). |
| Victory | Landing on any square of the opposite baseline finishes the match immediately (`outcome.reason = "reached-baseline"`). |
| Terminal state | `status !== "playing"` → `legalActions`, `legalMoves`, `legalWalls` all return `[]` and every action is rejected with `match-not-playing`. |

## Documented decisions and discrepancies

The reference game's rules page (barricade.gg/rules) is very close to the
original board game (Gigamic's Quoridor), but it is silent on two points. Both
were decided from the original rulebook rather than guessed, and both are
enforced by the engine:

1. **A jump is only legal when the two pawns are not separated by a barricade.**
   barricade.gg says "when the two players are adjacent… you can jump over your
   opponent", with no mention of the groove between them. Quoridor is explicit
   instead: *"When two pawns face each other on neighboring squares which are not
   separated by a fence, the player whose turn it is can jump the opponent's
   pawn."* The stricter reading is implemented: a barricade between the pawns
   cancels the step, the straight jump AND both diagonals (`jump-not-available`).

2. **A diagonal jump may not hop a barricade.** Quoridor: *"Walls may not be
   jumped, including when moving laterally due to a pawn or wall being behind a
   jumped pawn."* The diagonal move travels two grooves — sideways beside the
   moving pawn, then across to the destination — and both must be open.
   Otherwise the diagonal is refused (`move-blocked-by-wall`), even when its
   square is geometrically beside the opponent's pawn.

Further engine decisions that follow the same published rules:

* **The diagonal exists only when the straight jump is blocked.** barricade.gg:
  "If there's a barricade (or the board edge) directly behind your opponent, you
  can't jump straight — instead you move diagonally to either square beside
  them." A destination that would be a diagonal while the straight jump is open
  is refused with `jump-not-available`.
* **Victory is any square of the far row**, not just its centre column.
* **A barricade is owned but never partisan:** the placer is recorded on the
  board (`owner`) for rendering and history, and it blocks both players.
* **Path preservation ignores pawns.** The rule protects against walls, not
  against a temporarily blocking opponent; connectivity is computed on the
  barricade grid alone. (With only two pawns this can never deadlock.)
* **Backwards and sideways steps are legal** — the pawns "moved one square at a
  time, horizontally or vertically, forwards or backwards".
* **The engine does not model resignation or clocks.** barricade.gg adds "You
  also win if your opponent resigns or runs out of time"; those are store-level
  terminal states. `END_REASONS` already names them so every terminal state in
  the app shares one vocabulary, and a state the store finishes that way is
  inert here too (`status !== "playing"`).
* **Barricade is two-player only** in this build, so no rule about jumping
  multiple pawns (`MOVE_KINDS` has no multi-jump kind) is needed.

## Engine API

```ts
import {
  createInitialState, legalActions, legalMoves, legalWalls,
  validateAction, applyAction, tryApplyAction, classifyPawnMove, classifyWall,
  distanceToGoal, hasPathToGoal, wallSealsAPath, wallBlocksStep, wallsConflict,
  BarricadeRuleError, isBarricadeRuleError,
} from "../lib/barricade/rules";
```

* `createInitialState()` → frozen, ready-to-play state.
* `legalActions(state)` → everything the seat on turn may do (moves first, then
  barricades, deterministic order). **This is the one canonical generator** —
  the board UI, the bot and the store all read it; `legalMoves(state, seat)` and
  `legalWalls(state, seat)` expose the two halves for AI search.
* `validateAction(state, seat, action)` → `{ ok: true, kind }` or
  `{ ok: false, code, message }`, checked in a fixed order: action shape →
  match lifecycle → seat ownership → movement/barricade rule → the advisory
  `kind` a caller may have supplied.
* `applyAction(state, seat, action)` → the NEXT frozen state, or throws
  `BarricadeRuleError` (with `code`) when rejected. The input state is never
  mutated, on either path.
* `classifyPawnMove` / `classifyWall` → why one specific destination or groove is
  legal or not (useful for UI hints).
* `distanceToGoal` / `hasPathToGoal` / `wallSealsAPath` → graph-based
  pathfinding (breadth-first over open grooves).

Rejection codes (`REJECTION` in `constants.ts`): `invalid-action`,
`invalid-seat`, `out-of-bounds`, `invalid-orientation`, `match-not-playing`,
`not-your-turn`, `action-mismatch`, `destination-occupied`, `move-not-adjacent`,
`move-blocked-by-wall`, `jump-not-available`, `no-walls-remaining`,
`wall-overlap`, `wall-crossing`, `wall-blocks-path`.

## The practice experience (`/casino/barricade/play-ai`)

One screen, one opponent: the player is always blue (player1, moving first) and
the bot is purple. Every action — the human's click and the bot's decision alike
— goes through `applyAction`, so an illegal action is refused by the engine, not
by the UI.

**The board renders, it never decides.** `BarricadeBoard` takes the state, the
engine's own `legalMoves` list and the engine's cleared-groove list as props. It
highlights exactly the squares the engine offered, marks each groove with the
engine's verdict (`unknown` while the post-paint legality pass is still running),
and reports clicks as intent (`onMove` / `onPlaceWall`). The page then asks
`classifyWall` for a preview verdict and applies the action through `applyAction`
— the engine's rejection message is what the player reads.

* Geometry: one 17-track CSS grid (9 squares + the 8 grooves between them per
  axis), so a barricade is drawn — and clicked — IN the groove it occupies rather
  than inside a cell. Row 0 (player1's baseline) is drawn at the bottom, so each
  pawn races towards the far side of the screen. Cell and groove sizes are fluid
  (`clamp()`), with a tighter set below 400px.
* Turn loop: the board stops accepting input while the bot thinks; the bot's
  answer lands after a short visible beat (`AI_THINK_DELAY_MS`), and the effect is
  epoch-guarded so a Restart drops a stale timer.
* State shown: both pawns, every placed barricade, remaining barricade counters,
  whose turn it is, the active player's goal baseline, the last move, the session
  tally, win/defeat, Restart and Back-to-lobby. A wrong or illegal action is
  explained in a live region instead of being swallowed.
* The full legality pass over all 64 grooves costs one breadth-first search per
  candidate, so it runs after paint in a zero-delay timer; until it lands the
  grooves are drawn neutral and a click is still validated by the engine.

**The bot** (`src/lib/barricade/ai.ts`) reads the same `legalMoves`/`legalWalls`
menu the human does and is bounded twice — by node budget (`AI_MAX_NODES`) and by
a wall-clock deadline (`AI_DEADLINE_MS` ≤ 250 ms) — so a move is tens of
milliseconds of synchronous work at worst, never an unbounded search, a frozen
tab or a long blocking operation:

| Tier | How it plays |
| --- | --- |
| Easy | Advances towards its goal, with simple barricade decisions. |
| Normal | Evaluates the shortest path for both pawns and places barricades where they cost the opponent the most. |
| Hard | Searches a bounded set of legal replies and weighs path distance, remaining barricade resources and the opponent's threats. |

The tier is owned by the shared lobby picker (`AiDifficultyPicker`, key
`barricade`) and remembered per game, and a bot action the engine refuses is
reported and resets the board instead of stalling the match.

**Reachability.** `/casino/barricade(.*)` and `/games/barricade(.*)` are listed in
`GAME_ROUTE_PATTERNS` (`src/proxy.ts`) so a signed-out visitor can read the free
practice page instead of being bounced to `/sign-in` — the same contract every
other game lobby has, and the exact bug the Keno comment in that list records.
There is no wager, no rating and no server-side match behind this route.

## Online 1v1 (server-authoritative)

Two routes and one store. `/casino/barricade` is the lobby (also served at
`/games/barricade/play`, noindex); `/casino/barricade/<matchId>` is the live
match. Free practice keeps its own route and is unaffected.

**The client decides nothing.** The only gameplay request is an ACTION ADDRESS
plus the version the client was shown:

```jsonc
// POST /api/barricade/match/<matchId>/move
{ "action": { "type": "move", "to": { "col": 4, "row": 1 } }, "expectedVersion": 7 }
{ "action": { "type": "wall", "wall": { "col": 0, "row": 1, "orientation": "vertical" } }, "expectedVersion": 7 }
```

The position, both pawns, every barricade, both reserves, whose turn it is,
whether the action is legal, the winner, the result and the end instant are all
derived by the server from its own row through the same engine
(`validateAction` → `applyAction`). No field for any of them is read from the
request, and `barricade_matches.game_state` is never written from client input.

### Lifecycle

| Status | Meaning |
| --- | --- |
| `waiting` | The row IS the open lobby (`player2_id` is NULL). Direct create/join only — no public matchmaking is advertised. |
| `playing` | Both seats hold a real age-verified account id; the first mover plays immediately (no ready banner, no countdown). |
| `finished` | Settled exactly once, with `result` (the winning SEAT), `winner_id`, `result_reason` and `ended_at`. |
| `cancelled` | An open lobby released by its creator, or abandoned past the grace window. Never settles, so no winner is recorded. |

### Concurrency

1. Every mutation takes the match row with `FOR UPDATE`, so two concurrent
actions serialise; the second re-reads the row, sees the version the first wrote,
and is refused as stale.
2. `move()` additionally checks `expectedVersion` against the authoritative `ply`
INSIDE that lock — a double submit or a stale tab is a clean 409.
3. `barricade_moves` carries a unique `(match_id, ply)` index: one persisted
action per turn number is a storage invariant, and the loser of that race is
reported as a conflict, never a 500.
4. Matchmaking runs under one per-game advisory lock
(`pg_advisory_xact_lock`) plus a conditional UPDATE, so two callers can never
both open a lobby, and a caller can never join a lobby that is being cancelled.

### Realtime, disconnects and reconnection

No new realtime service: Barricade reuses the platform's Socket.IO vocabulary and
the existing grace-timer forfeit path.

* Both seats join `barricade:match:<id>`; after every accepted action, and after
a resignation or cancellation, the client emits the bare `barricade:ready` poke,
which the realtime server relays as the generic `lobby:updated` to the other seat
— but only after checking the caller is a TRACKED participant of that match.
* HTTP polling of `GET /api/barricade/match/<matchId>` remains the backstop and
is the reconnection path: a refreshed tab or a new device re-reads the same
authoritative row, and the re-join on `connect` cancels the server's disconnect
timer for that seat.
* If a seat stays away past the grace window, the realtime server re-verifies
that player's Clerk token and calls `/api/barricade/disconnect-forfeit`, which
awards the seat still present the win (`abandoned`) or releases an empty lobby.
It is idempotent, so the retry loop stops on a terminal match.

### Client projection

The snapshot is viewer-projected on the server (`viewer_seat`, `is_viewer_turn`,
`opponent_seat`), so the board never has to decide whose turn it is. Barricade is
perfect information, so BOTH reserves are published — that is what lets a seat
see how many barricades the opponent has left. A non-participant gets a 403 on
every read and every action: there is no spectator mode, and one player can never
act on another player's match.

### Scope

No wager, stake, pot or payout column exists and no money is moved. Rating,
trophies, the quick-queue and the public catalogue entry are deliberately not
wired (Barricade is not in the rated/trophy registries yet), and Dice Flush is
untouched.

## Verification

`node --import tsx --test tests/barricade-rules.test.mjs` — 50 tests, all passing.

Highlights:

* The groove geometry (`wallBlocksStep`) and the fast internal groove index are
  both checked against a from-scratch reference definition for **every** square,
  direction, slot and orientation (36,864 cases), and against a reference BFS on
  randomised boards.
* A deterministic self-play fuzz (seeded, so it is reproducible) plays several
  complete games per seed and asserts, at every ply: every action the engine
  generates is accepted by the engine's validator, the move menu equals the set
  of squares the validator accepts, distances match the reference BFS, both pawns
  always keep a route, inventories add up to 20 minus the barricades on the
  board, and no two barricades ever conflict. The whole 128-candidate barricade
  menu is cross-checked against the reference implementation as the games run.
* Terminal behaviour is pinned from both sides: reaching the far row is an
  immediate win, and a finished match refuses moves, barricades and even the
  seat nominally on turn.
* Rejections are pinned for immutability: with a deeply frozen input state, every
  rejection path throws and leaves the state byte-for-byte identical, and an
  accepted action returns a new object with the original untouched.

`npm run test:barricade` also runs the bot suite (`tests/barricade-ai.test.mjs`),
the practice UI contracts (`tests/barricade-practice-ui.test.mjs`) and the online
suites (`tests/barricade-online-store.test.mjs`, `tests/barricade-online-ui.test.mjs`)
— 114 tests, all passing.

The online store suite drives the real module against a fake Drizzle client and
tries to make it accept what a client is not allowed to decide: a forged move
`kind`, a destination the row's position refuses, an unrelated account's action,
an action from the seat NOT on turn, a stale `expectedVersion`, a replayed ply
(the unique index firing), a barricade the engine refuses, and a resignation or
cancellation that must not be possible. It also pins the settlement: a winning
jump finishes the match once, and a finished match accepts no further action.

`node --env-file-if-exists=.env.local --import tsx qa/barricade-online-check.mjs`
plays a COMPLETE match against the real database with two seats — every action
taken from the engine's own `legalMoves` and every response compared with
`applyAction` — and asserts the real row lock: two actions fired concurrently on
the same turn produce exactly one applied action and one clean conflict, an
out-of-turn action and a replayed action are refused, both seats see the same
position projected per viewer, the match settles once with the engine's own
reason, and every row the run created is deleted again. 33/33 checks pass.

`npm run verify:barricade` plays the real page in a real browser
(`qa/barricade-practice-check.mjs`, Playwright): it plays a COMPLETE match at
Easy, Normal and Hard, checks that an illegal tap changes nothing, that a legal
barricade previews and is charged to the reserve, that a groove the engine
refuses (built by covering a whole groove until only the sealing slot is left)
previews as invalid and places nothing, that Restart and the result screen's
"New game" deal fresh boards, that the result overlay reports the win or the
defeat it should, and that the board fits 1280×800 plus 390×844 and 320×568
phones with a placeable-by-tap barricade. It re-centres the board before every
tap and hit-tests the point, because the navigation bar is fixed and the board is
taller than the space under it. Screenshots and the full result land in
`qa/reports/barricade-practice/`.

Across the runs used for this phase the harness won at Easy (a 17-action race)
and lost at Normal and Hard (9–16 actions), i.e. it exercised BOTH the win and
the defeat variant of the result screen, with 41/41 browser checks passing. The
harness plays a deliberately simple race-and-sweep game, so its record says
nothing about how hard the tiers are — only that every one of them reaches a
terminal state and reports it correctly.
