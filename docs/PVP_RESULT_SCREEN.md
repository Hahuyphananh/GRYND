# Shared PvP Result Screen — integration guide

Component: `src/components/result/PvpResultScreen.jsx`
Reference adapter: Mines Duel — `src/app/casino/mines-pvp/[matchId]/PageClient.tsx` → `renderResult()`

## Goal

One polished, shared end-of-match experience (WIN / LOSS / DRAW) across every
PvP game, replacing each game's bespoke "You Win / You Lose / Match Over"
popup. All rewards and stats come from the game's **existing** match payload —
the component never invents values and auto-hides any section whose data is
absent (XP, Battle Pass, Prestige, duration, opponent…).

## The component

```jsx
<PvpResultScreen
  open
  outcome="win" | "loss" | "draw"
  headline="Opponent hit a mine — you take the pot"  // optional narrative
  subline="You took home 190.00 tokens…"             // optional
  gameName="Mines Duel"
  opponent={{ name, iconKey, isAi }}                  // optional
  tokenDelta={190}                                    // number | null → hides
  xp={40}                                             // number | null → hides
  progress={[{ label: "Battle Pass", from: "72", to: "73", percent: 75 }]}
  durationSeconds={154}                               // number | null → hides
  summary={[{ label: "Result", value: "Win" }]}
  details={[{ label: "Match ID", value: "123" }]}     // inside "Match Details"
  detailsContent={<>…game-specific JSX…</>}           // optional extra block
  playAgain={{ label, onClick }}                       // null → button hidden
  rematch={{ label, onClick }}                         // null → button hidden
  onReturnToLobby={onClick}
/>
```

Notes:
- Buttons are guarded internally — a double tap can't fire two actions.
- Win plays confetti (skipped under `prefers-reduced-motion`).
- The expandable "Match Details" panel holds `details` rows + `detailsContent`.
- Duration is formatted from `durationSeconds`; pass it only when the match
  row's `startedAt`/`endedAt` are both present.

## Conversion checklist per game

1. Keep the finished-state detection exactly as today.
2. Map the existing winner to `outcome` (no winner → `"draw"`).
3. Compute `tokenDelta` from real payout fields: `win → +prizePaid`,
   `loss → −stake`, draw → refund/0 as the game defines.
4. XP / Battle Pass / Prestige: only if the match payload already carries
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
- Lane Rush Duel — `src/app/casino/lane-runner/[matchId]/PageClient.jsx` (`matchEndPopup`
  const, mounted once per layout variant; real `p1Points/p2Points` + winner-only `prizePaid`
  from the match API; duration from `startedAt/endedAt`)
- Tower Arena — `src/app/casino/tower-arena/game/[matchId]/PageClient.tsx` (finished-state
  `PvpResultScreen` + mid-match resign path both use the shared screen; rankings stay visible
  behind via "View Results" dismiss, resign shows "Watch game"; real placement/payout/net from
  `finalRankings` and the resign API; old `ResultPopup`/`Stat` components deleted)
- Plinko Duel — `src/app/casino/plinko/[matchId]/PageClient.tsx` (`renderWinnerPopup` now
  renders the shared screen; real `p1Score–p2Score`, `prizePaid`/`houseFee`/`stakeAmount`,
  winner-vs-viewer verdict, round-decided label, duration from `startedAt/endedAt`; per-seat
  score boxes moved into Match Details; old modal + `TrophyIcon` deleted)
- Memory Grid — `src/app/casino/memory-grid/[matchId]/PageClient.tsx` (finished-state screen
  replaces the inline board + separate draw popup; real rounds/score, stake/prizePaid/houseFee
  delta math, refund copy on draw, duration from `startedAt/endedAt`)
- Blackjack PvP — `src/app/casino/blackjack/[matchId]/PageClient.tsx` (match-end screen from
  real winner/points/payout fields; old `MatchEndModal` + its icons deleted)
- Roulette PvP — `src/app/casino/roulette/[matchId]/PageClient.jsx` (finished banner replaced;
  real points/refund/stake math from the match payload)
- Chess Arena — `src/app/casino/chess-game/[gameId]/PageClient.jsx` (win/loss/draw screen from
  game row result/payout; old popup + icons deleted)
- Rock Paper Scissors — `src/app/casino/rps/game/[gameId]/PageClient.tsx` (win/loss/draw screen
  from real choose/status settlement; old popup deleted)
- Four in a Row — `src/app/casino/four-in-a-row/game/[gameId]/PageClient.tsx` (game-over screen
  from real winner/fee math; old `gameOverModal` deleted)
- Dots & Boxes — `src/app/casino/dots-and-boxes/game/[gameId]/PageClient.tsx` (finished screen
  from real scores/settlement; old result popup + celebration code deleted)
- Pool Masters — `src/app/casino/pool-masters/game/[matchId]/PageClient.tsx` (win/loss screen
  from real wager/prize fields; old `creatorPopup` deleted)
- Precision — `src/components/precision/PrecisionResultPopup.tsx` rewritten as a thin
  PvpResultScreen adapter (page props unchanged; test IDs kept)
- Hex Duel — `src/app/casino/hex-duel/PageClient.tsx` (victory/defeat screen for for-fun, AI,
  and multiplayer modes; real payout/wager deltas; old `VictoryModal`/`LoseModal`/`ConfettiPiece`
  + their keyframes/icons deleted)
- Dice Flush — `src/app/casino/dice-flush/PageClient.tsx` (game-over overlay replaced; real
  final scores, free-play subline for AI; old overlay + confetti/`celebrateWin` removed)
- Odds — `src/app/casino/odds/PageClient.tsx` (`OddsGameDisplay` game-over popup replaced;
  AI mode hides tokens, PvP nets payout−wager / −wager / draw refund 0; old popup + icons
  deleted)

## Games with no match-over result UI (nothing to convert)

- Crash Arena (table) — `RoundResultModal` is a per-hand, 8s auto-dismissing card whose design
  is to keep hands flowing (winner semantics: fold-out / last-standing / pot carry-over, plus
  folded-vs-busted player outcomes that don't map to win/loss/draw). The shared screen has no
  auto-dismiss and would block every hand on a button press; leaving the table just refunds
  and navigates to the lobby. Existing per-hand treatment is already the right lightweight fit.
- Chess `[tableAmount]` — waiting/lobby page only, the board lives elsewhere (already converted)
- Neon Flush — no result popup exists on the match page

## Solo AI practice modes (converted too)

Free-play practice companions of the PvP games — no tokens are ever wagered, so the
shared screen shows outcome + stats with the token row hidden:

- Chess vs AI — `src/app/casino/chess/ai/ChessAIPageInner.tsx` (win/loss/draw from real
  `gameResult`/`winnerText`; color/moves/difficulty in summary; old modal + `celebrateWin`
  calls + its icons deleted)
- Four-in-a-Row vs AI — `src/app/casino/four-in-a-row/play-ai/PageClient.tsx` (inline
  result banner replaced; real session score W/L/D + move count; old banner + icons deleted)
- RPS vs AI — `src/app/casino/rps/play-ai/PageClient.tsx` (best-of-7 match-over block
  replaced; real final score + rounds; per-round reveal flash kept)
