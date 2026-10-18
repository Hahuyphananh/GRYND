# Ultimate Tic-Tac-Toe — Game Guide

Ultimate Tic-Tac-Toe on GRYND is **Classic Ultimate Tic-Tac-Toe**: one large 3×3 board
whose nine squares are themselves 3×3 mini-boards. All nine mini-boards are in
play from the opening move. Live route: `/casino/tic-tac-toe` (lobby) and
`/casino/tic-tac-toe/<matchId>` (match).

## How a match works

1. **One lattice, nine boards** — the match starts with nine empty, active
   mini-boards. There is no expansion, no stage and no sudden-death board.
2. **Your cell chooses the opponent's board** — the cell you play sets the
   opponent's required mini-board: the slot with the same index on the lattice
   (play cell 4 → the opponent must play in board 5, the centre).
3. **A resolved destination frees the choice** — if the required board has since
   been claimed (`X` / `O`) or drawn, the next player may play in any unfinished
   board, and the interface says so in words.
4. **Three in a row claims a mini-board** — complete a row, column or diagonal
   inside a mini-board to claim it. A full board with no line is a draw and is
   locked, keeping every mark visible.
5. **Three claimed boards in a line wins the match** — a row, a column or a long
   diagonal of the lattice ends the match immediately. A fully resolved lattice
   with no line is a draw.

Plain 3×3 Tic-Tac-Toe (where one line ends the match) and the retired
**Mega expansion** game (1 board → 4 boards → 9 boards, with stage transitions
and a sudden-death tiebreak) are **not** playable. Their only remaining trace is
the read-only compatibility path described below.

## Authority and contract

- The server is the sole authority. `validateMove` re-derives the required
  destination, the seat's mark, occupancy and the result on every request; the
  client sends only `{ boardIndex, cellIndex, expectedVersion }`.
- Every mutator locks the match row before reading it, and a stale
  `expectedVersion` is refused (409) rather than merged.
- `normalizeForViewer` produces the view DTO. Its keys are: `version`,
  `phase`, `status`, `result`, `winnerId`, `winner`, `boardSize`, `cellCount`,
  `latticeSize`, `maxBoards`, `marks`, `player1Id`, `player2Id`, `boards`
  (always nine), `activeBoards`, `completedBoards`, `nextBoard`,
  `playableBoards`, `winningBoards`, `ply`, `currentTurn`, `currentTurnUserId`,
  `lastMove`, `viewerSeat`, `viewerMark`, `isViewerTurn`, `viewerCanMove`,
  `legacyState`. Stage-era fields (`stage`, `stageBoardSlots`, `megaSize`,
  `tiebreak`, `suddenDeath`) are **not** part of the contract.
- Move history, replay (`replayMoves`) and reconnect reuse the same engine, so a
  reconnecting client rebuilds the identical position from the move log.

## Retained backward-compatibility code

Historical rows are readable but not playable. This code is deliberate and must
not be deleted while old matches remain in the database:

| Symbol | File | Purpose |
| --- | --- | --- |
| `isExpansionEraState` | `src/lib/tic-tac-toe/rules.ts` | Detects an expansion-era state blob (`stage` / `tiebreak` / `suddenDeath` keys) or a malformed one. |
| `legacyState` (DTO flag) | `src/lib/tic-tac-toe/rules.ts` | Reported to the view so a legacy row renders as unplayable instead of being reinterpreted. Forces `viewerCanMove: false`. |
| `rulesVoidReason` | `src/lib/tic-tac-toe/serverStore.ts` | `"legacy"` \| `"unreadable"` \| `null` — why a row cannot be played. |
| `needsRulesVoid` | `src/lib/tic-tac-toe/serverStore.ts` | Guard used when joining/seating a match and before settlement. |
| `voidUnplayableMatch` / `rulesVoidError` (module-private) | `src/lib/tic-tac-toe/serverStore.ts` | Cancels a void match and refunds both seats through the shared ledger (idempotent per match+seat). Called from the leave/forfeit path and reported as `cancelled` so the realtime retry loop stops. |
| `tic_tac_toe_moves.board_index` | `src/db/migrations/0203_tic_tac_toe_mega_boards.sql` | The per-move lattice slot every replay needs; kept, widened in place. |

An expansion-era row is **never** reinterpreted as an Ultimate position: the old
stage 1 was one board and the new game is nine from move one, so "continuing" it
would silently change the game under a rated, staked match. Voided matches carry
no result and touch no rating or trophy — they are cancelled and refunded, like a
lobby closed before play.

## Migration considerations

- **No destructive migration.** Completed matches, ratings and trophies are left
  untouched; historical `game_state` JSONB keeps its old keys and is only ever
  read.
- **New matches always write nine boards** and the current field set; nothing
  new writes a stage, tiebreak or sudden-death key.
- Migration `0203_tic_tac_toe_mega_boards.sql` and its journal entry stay as
  written (applied migrations are immutable).
- If legacy rows are still present when the game is next touched, the operator
  can close them through the normal void path; nothing needs backfilling.
- A voided match is mirrored to the canonical queue as `cancelled` with
  `cancelReason: "rules_migrated"`, which is the field to filter on if these
  refunds need to be counted in analytics.

## Product copy

The four rules above are taught in the lobby ("How to Play"), the in-game strip
and instruction line, and the public landing page. The copy avoids the retired
words *expansion*, *stage* and *tiebreak*, and the UI-contract suite asserts that
no expansion-era vocabulary returns.

## Key numbers

| Constant | Value |
| --- | --- |
| Mini-boards | 9 (fixed 3×3 lattice) |
| Cells per mini-board | 9 |
| Winning lines per mini-board | 8 |
| Winning lattice lines | 8 |
| Maximum plies | 81 |
| Rated / stakes | Rated 1v1, staked duel; vs-AI practice is free |
