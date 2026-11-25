---
name: mobile-game-ux
description: Use when building or changing touch gameplay, card dragging, tap-to-move, game HUD, move feedback, or in-match states in the solitaire client. Not for marketing pages, static screens, or server settlement logic.
---
<!-- type: flexible -->

# Mobile Game UX

Touch-first interaction design for GRYND's solitaire board and match surfaces.
The governing reality: **the server is authoritative**. A move is a proposal
until the server accepts it, and the UI must never claim a result it has not
received.

## Doctrine

- **One gesture, one decision.** A press resolves to exactly one intent - drag or
  tap-to-place - and then stays resolved. Ambiguity is what makes card games feel
  broken. GRYND's board already implements this with a 6px movement threshold
  (`DRAG_THRESHOLD_PX` in `src/components/solitaire-duel/SolitaireBoard.tsx`).
- **Tap-to-move is not a fallback, it is a first-class path.** It is required for
  keyboard play, for accessibility (WCAG 2.5.7 Dragging Movements), and for rapid
  play. Never ship a drag-only interaction.
- **Never show an unconfirmed result.** No optimistic win, no optimistic pile
  change that survives a rejected move. Show pending, then reconcile.
- **Feedback within one frame, confirmation within one network round trip.**
  Visual response to touch is immediate; the authoritative outcome waits for the
  server.
- **Effects serve the move, not the demo.** Every animation must be interruptible,
  cheap to composite, and removable under Reduce Motion without losing meaning.
- **Do not add dependencies.** Framer Motion 12 and CSS are already present.

## Process

### 1. Inspect the existing board before touching it

- `src/components/solitaire-duel/SolitaireBoard.tsx` - pointer handling, drag
  threshold, click-to-select, `data-drag-*` attributes, scroll clamping.
- `src/components/solitaire-duel/PlayingCard.tsx` - the card surface and drag
  source attributes.
- `src/components/solitaire-duel/AutoFinishAnimation.tsx` - an existing timed
  effect, including its safe-area placement and reduced-motion handling.
- The match store and API route that accept a move, so you know what is
  optimistic and what is confirmed.
- `src/app/globals.css` - existing card, board, and motion tokens.

If you cannot describe how a press currently becomes a move, do not change it.

### 2. Get the gesture model right

- **Drag:** start after a small threshold (do not use `0`, or every tap becomes a
  micro-drag); track with `pointermove` and pointer capture so the card keeps
  following outside its origin; snap on release; cancel on `pointercancel`.
- **Tap-to-move:** first tap selects, second tap on a legal target moves; tapping
  the same card again deselects; tapping an illegal target keeps the selection
  and gives a rejection cue rather than silently doing nothing.
- **Scroll vs drag:** a mostly vertical press on a card column must not scroll the
  page while a card is being dragged. Lock the page scroll for the duration of a
  drag and restore it on release, including on cancel.
- **Zoom:** set `touch-action` deliberately (`manipulation` or `none` on the
  board, never global `none`). Double-tap-to-zoom firing during rapid play is a
  defect.
- **Multi-touch:** ignore a second pointer during an active drag rather than
  cancelling the first.
- **Long-press:** not a primary action. It conflicts with text selection and with
  the platform's own long-press behaviour.

### 3. Design the HUD

- Put persistent information (opponent progress, timer, score) at the top, within
  the safe area, and actions at the bottom within thumb reach.
- Never let a HUD element overlap a playable card or the stock. If space is
  tight, collapse secondary information instead of shrinking the board.
- Show the opponent's progress as a compact, glanceable indicator - not a second
  board.
- The clock must remain legible and stable: use tabular numerals so digits do not
  shift width every second.
- Critical states (your turn, disconnected, opponent left) must be visible without
  reading small text.

### 4. Make state unambiguous

| State | What the player must see |
|---|---|
| Your turn | An active board plus an explicit turn cue, not just a colour change |
| Move pending | The card in its new place with a subtle pending treatment; no win banner |
| Move rejected | The card returns to origin; a brief, non-blocking explanation |
| Opponent's turn | Board visibly inactive; no dead taps |
| Disconnected | An honest banner, what still works, and automatic recovery |
| Match over | Result, rating/trophy delta when confirmed, and the next action |
| Empty / no match | The one action that starts a match |

### 5. Tune feedback and motion

- Touch-down acknowledgement: <= 100ms.
- Snap into place: 120-180ms; a long glide makes the board feel laggy.
- Invalid move: a short horizontal shake (<= 200ms) or a colour pulse, never a
  modal.
- Win/loss: at most one celebratory beat, interruptible by a tap, skipped under
  Reduce Motion.
- Animate `transform` and `opacity` only. Avoid `box-shadow`, `filter: blur`, and
  layout properties on anything that moves each frame.
- Cap concurrent particles and use `will-change` only for the duration of a drag.

### 6. Performance and platform reality

- Target 60fps on a mid-range Android device, not a desktop browser. Measure with
  the Chrome performance panel over a USB-connected device.
- Keep the per-frame work to reads of already-measured rects; never call
  `getBoundingClientRect` in a pointermove loop without caching.
- Do not rely on `setInterval` for game timing; it is throttled in a background
  WebView. Derive elapsed time from timestamps.
- Audio may be blocked until a user gesture; unlock on the first interaction and
  fail silently if unavailable.
- Haptics must not be tied to moves: `src/lib/native/haptics.ts` reserves them for
  discrete confirmations and forbids gameplay use because it can leak timing.

### 7. Portrait and landscape

- Portrait is the default. Do not require landscape for core play.
- If landscape is supported, the board must fit without scrolling, and left/right
  safe-area insets apply on notched devices.
- A rotation mid-drag cancels the drag cleanly and leaves the board in the last
  confirmed state.

### Verify

1. Play a full match with touch on a real device: drag, tap-to-move, rapid play,
   drag-to-invalid-target, drag outside the board, and a second finger landing
   mid-drag.
2. Confirm no page scroll during a drag and no double-tap zoom.
3. Confirm a rejected move returns the card and does not show a win.
4. Confirm Reduce Motion removes non-essential motion while keeping state clear.
5. Confirm the board still works with the keyboard alone.
6. Check 60fps on a mid-range Android device and a notched iPhone.
7. Run `npx tsc --noEmit` and the existing solitaire tests. Do not modify test
   expectations to accommodate a changed interaction without a stated reason.

Report which of these were actually played on a device.

## Red flags

| Rationalisation | Reality |
|---|---|
| "Drag works, tap-to-move can come later." | Tap-to-move is required for keyboard and assistive tech, and many players prefer it. It is not optional. |
| "I lowered the drag threshold to 0 so it feels responsive." | Then every tap becomes a drag and tap-to-move stops working. Keep a real threshold. |
| "I'll show the win immediately and reconcile if the server disagrees." | Taking back a win is far worse than a 300ms wait. Show pending. |
| "The page scrolls during a drag, but only a little." | It drags the board out from under the card and makes the move impossible. Lock the scroll. |
| "Haptics on every card placement make it feel premium." | It is forbidden here: it can leak timing in a competitive match, and constant vibration becomes noise. |
| "The animation is long but it looks great." | A 600ms snap makes the board feel unresponsive. Direct manipulation should feel instant. |
| "I animate `height` so the piles push each other." | That is a layout animation every frame. Animate transforms. |
