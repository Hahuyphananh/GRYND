# Shared PvP Result Screen — integration guide

Component: `src/components/result/PvpResultScreen.jsx`
Reference adapter: Mines Duel — `src/app/casino/mines-pvp/[matchId]/PageClient.tsx` → `renderResult()`

## Goal

One polished, shared end-of-match experience (WIN / LOSS / DRAW) across every
PvP game, replacing each game's bespoke "You Win / You Lose / Match Over"
popup. All progression and stats come from the game's **existing** match payload —
the component never invents values and auto-hides any section whose data is
absent (Overall Elo, Battle Pass, duration, opponent…).

**No token copy.** Stakes are retired platform-wide (`src/lib/games/stakes.js`),
so no result popup shows a token / stake / pot / prize / winnings figure — not
as a row, not in `subline`, not in `details`. The screen carries the outcome and
the real match statistics only.

## The component

```jsx
<PvpResultScreen
  open
  outcome="win" | "loss" | "draw"
  headline="Opponent hit a mine — you take the win"  // optional narrative
  subline="Practice match vs GRYND AI."              // optional
  gameName="Mines Duel"
  opponent={{ name, iconKey, isAi }}                  // optional
  progress={[{ label: "Battle Pass", from: "72", to: "73", percent: 75 }]}
  durationSeconds={154}                               // number | null → hides
  summary={[{ label: "Result", value: "Win" }]}
  details={[{ label: "Match ID", value: "123" }]}     // inside "Match Details"
  detailsContent={<>…game-specific JSX…</>}           // optional extra block
  playAgain={{ label, onClick }}                       // null → button hidden
  rematch={{ label, onClick }}                         // null → button hidden
  secondaryAction={{ label, href }}                    // optional extra action (internal route)
  // secondaryAction={{ label, onClick }}              // …or an in-page action
  onReturnToLobby={onClick}
/>
```

Notes:
- Buttons are guarded internally — a double tap can't fire two actions.
- `secondaryAction` is the single generic "extra action" slot (rendered between
  Rematch and Return to Lobby). Pass `{ label, href }` for an internal route —
  rendered through `next/link`, so it prefetches — or `{ label, onClick }` for an
  in-page action; omit it to hide the button. It is deliberately game-agnostic
  (the panel never learns which game, or where, it points), so any result screen
  can reuse it.
- There is no `tokenDelta` prop: the token row was removed platform-wide.
  A game that still computes a payout locally must not pass it here.
- Win plays confetti (skipped under `prefers-reduced-motion`).
- The expandable "Match Details" panel holds `details` rows + `detailsContent`.
- Duration is formatted from `durationSeconds`; pass it only when the match
  row's `startedAt`/`endedAt` are both present.

## Conversion checklist per game

1. Keep the finished-state detection exactly as today.
2. Map the existing winner to `outcome` (no winner → `"draw"`).
3. Show no token/stake/payout figure. If the game's data-fetch still needs the
   settlement response (balance, analytics), keep the call, but don't render
   the numbers and don't derive a delta for the popup.
4. Overall Elo / Battle Pass: only if the match payload already carries
   them — otherwise omit (never fabricate).
5. Duration from existing `startedAt`/`endedAt`.
6. Opponent name/icon from the players enrichment already returned.
7. Move any useful old-popup content into `summary`, `details`, or
   `detailsContent`; delete the old overlay JSX entirely (no double popup).

## Games converted

- Mines Duel — `src/app/casino/mines-pvp/[matchId]/PageClient.tsx` (`renderResult()`)
- Keno Duel — `src/app/casino/keno-pvp/[matchId]/PageClient.jsx` (`ResultModal` adapter; the
  1.2s `showResult` delay before showing the screen is kept, per-round breakdown moved into
  Match Details)
- Lane Rush Duel — `src/app/casino/lane-runner/[matchId]/PageClient.jsx` (`resultScreenProps`
  const, mounted once per layout variant; real `p1Points/p2Points` + resignation state;
  duration from `startedAt/endedAt`)
- Tower Arena — `src/app/casino/tower-arena/game/[matchId]/PageClient.tsx` (finished-state
  `PvpResultScreen` + mid-match resign path both use the shared screen; rankings stay visible
  behind via "View Results" dismiss, resign shows "Watch game"; placement + the server's
  win/lose verdict from `finalRankings` and the resign API; old `ResultPopup`/`Stat` components
  deleted)
- Memory Grid — `src/app/casino/memory-grid/[matchId]/PageClient.tsx` (finished-state screen
  replaces the inline board + separate draw popup; real rounds/score, duration from
  `startedAt/endedAt`)
- Chess Arena — `src/app/casino/chess-game/[gameId]/PageClient.jsx` (win/loss/draw screen from
  the game row's winner/result; old popup + icons deleted). For a finished match it adds a
  "See Evaluation" `secondaryAction` linking to `/evaluation/chess/[gameId]` (omitted for an
  `expired` match, which the evaluation API refuses with a 409).
- Rock Paper Scissors — `src/app/casino/rps/game/[gameId]/PageClient.tsx` (win/loss/draw screen
  from real choose/status settlement; old popup deleted)
- Four in a Row — `src/app/casino/four-in-a-row/game/[gameId]/PageClient.tsx` (game-over screen
  from the real winner + the winning-four strip; old `gameOverModal` deleted)
- Dots & Boxes — `src/app/casino/dots-and-boxes/game/[gameId]/PageClient.tsx` (finished screen
  from real scores; old result popup + celebration code deleted)
- Pool Masters — `src/app/casino/pool-masters/game/[matchId]/PageClient.tsx` (win/loss screen
  from the real winner seat; old `creatorPopup` deleted)
- Precision — `src/components/precision/PrecisionResultPopup.tsx` rewritten as a thin
  PvpResultScreen adapter (page props unchanged; test IDs kept); shows the result, score,
  winner and the deciding round's frozen rockets only
- Hex Duel — `src/app/casino/hex-duel/PageClient.tsx` (victory/defeat screen for for-fun, AI,
  and multiplayer modes; real moves/territory; the end-game settlement call still runs for the
  balance + analytics, its payout response is simply not displayed; old `VictoryModal`/
  `LoseModal`/`ConfettiPiece` + their keyframes/icons deleted)
- Dice Flush — `src/app/casino/dice-flush/PageClient.tsx` (game-over overlay replaced; real
  final scores, free-play subline for AI; old overlay + confetti/`celebrateWin` removed)
- Odds — `src/app/casino/odds/PageClient.tsx` (`OddsGameDisplay` game-over popup replaced;
  real final score + rounds; old popup + icons deleted)

## Games with no match-over result UI (nothing to convert)

- Chess `[tableAmount]` — waiting/lobby page only, the board lives elsewhere (already converted)
- Neon Flush — no result popup exists on the match page

## Solo AI practice modes (converted too)

Free-play practice companions of the PvP games — nothing is ever wagered, so the
shared screen shows outcome + stats and carries no token/stake copy:

- Chess vs AI — `src/app/casino/chess/ai/ChessAIPageInner.tsx` (win/loss/draw from real
  `gameResult`/`winnerText`; color/moves/difficulty in summary; old modal + `celebrateWin`
  calls + its icons deleted)
- Four-in-a-Row vs AI — `src/app/casino/four-in-a-row/play-ai/PageClient.tsx` (inline
  result banner replaced; real session score W/L/D + move count; old banner + icons deleted)
- RPS vs AI — `src/app/casino/rps/play-ai/PageClient.tsx` (best-of-7 match-over block
  replaced; real final score + rounds; per-round reveal flash kept)
