/**
 * speed-typing-ui-contract.test.mjs
 *
 * The Speed Typing FRONTEND contract: what the match page may show, what it may
 * send, and — above all — what it is NOT allowed to decide.
 *
 * The UI is held to the same trust boundary as the server. It renders the shared
 * passage, highlights the player's position, shows both progress bars, WPM and
 * accuracy, and displays the result — but every number it displays is either a
 * LOCAL ESTIMATE clearly derived from the buffer, or a value that arrived from
 * the server. There is no code path in which the client computes the winner.
 *
 * Run:  node --import tsx --test tests/speed-typing-ui-contract.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (rel) => fs.readFileSync(rel, "utf8");
const code = (rel) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");

const MATCH_PAGE = "src/app/casino/speed-typing/[matchId]/PageClient.tsx";
const PROGRESS_ROUTE =
  "src/app/api/speed-typing/match/[matchId]/progress/route.ts";
const FINISH_ROUTE = "src/app/api/speed-typing/match/[matchId]/finish/route.ts";
const CANCEL_ROUTE = "src/app/api/speed-typing/match/[matchId]/cancel/route.ts";
const ROOMS = "src/lib/speed-typing/rooms.ts";

const page = code(MATCH_PAGE);

// ════════════════════════════════════════════════════════════════════════
// 1. The eleven screens/states exist
// ════════════════════════════════════════════════════════════════════════

test("ui: every required state is rendered", () => {
  assert.match(page, /data-testid="speed-typing-loading"/, "loading state");
  assert.match(page, /<MatchWaiting/, "waiting / match-found state");
  assert.match(page, /data-testid="speed-typing-countdown"/, "countdown");
  assert.match(page, /data-testid="speed-typing-arena"/, "typing arena");
  assert.match(page, /data-testid="speed-typing-complete"/, "completion state");
  assert.match(page, /<PvpResultScreen/, "winner/loser result screen");
  // Opponent + local progress bars, and the WPM/accuracy readout.
  assert.match(page, /<ProgressBar/);
  assert.match(page, /fallbackLabel="You"/);
  assert.match(page, /fallbackLabel="Opponent"/);
  // Both seats are headed by their own avatar + username, not a bare label.
  assert.match(page, /import SeatAvatar from/);
  assert.match(page, /<SeatAvatar/);
  assert.match(page, /setSeatIdentities\(\(data\.data\.seatIdentities as SeatIdentities\) \?\? null\)/);
  assert.match(page, /const viewerName = viewerIdentity\?\.name \|\| "You"/);
  assert.match(page, /"Your WPM"/);
  assert.match(page, /"Accuracy"/);
  assert.match(page, /data-testid="speed-typing-timer"/);
});

test("ui: rematch and return-to-queue reuse the existing platform patterns", () => {
  // The shared result screen's own CTAs, exactly as every other game drives them.
  assert.match(page, /playAgain=\{\{ label: "RACE AGAIN", onClick: requeue \}\}/);
  assert.match(page, /onReturnToLobby=\{\(\) => router\.push\("\/casino\/speed-typing"\)\}/);
  // "Race again" re-enters the ONE matchmaking path — it does not invent a
  // second queue.
  const requeue = page.slice(page.indexOf("const requeue"), page.indexOf("// ── Result"));
  assert.match(requeue, /fetch\("\/api\/speed-typing\/create-or-join"/);
  assert.match(requeue, /router\.push\(`\/casino\/speed-typing\/\$\{data\.data\.matchId\}`\)/);
  // The page never names an economy endpoint or a staked rematch.
  assert.doesNotMatch(page, /betAmount|stakeAmount|prizePaid|houseFee|newBalance/);
});

// ════════════════════════════════════════════════════════════════════════
// 2. Typing UI: passage, position, correctness, immediacy
// ════════════════════════════════════════════════════════════════════════

test("ui: the shared passage is displayed with position and correctness", () => {
  // The passage is rendered character by character from the SERVER's text.
  assert.match(page, /const passage = race\?\.passageText \?\? ""/);
  assert.match(page, /passageChars\.map\(\(char, index\) =>/);
  // The current position is highlighted on its own span…
  assert.match(page, /const isCurrent = index === typedChars\.length/);
  assert.match(page, /ref=\{isCurrent \? caretRef : undefined\}/);
  // …correct characters and mistakes are visually distinct…
  assert.match(page, /isCorrect\n?\s*\? "text-emerald-300"/);
  assert.match(page, /isWrong\n?\s*\? "text-red-400/);
  // …and the caret is kept on screen without animating per keystroke.
  assert.match(page, /caretRef\.current\?\.scrollIntoView\(\{ block: "nearest" \}\)/);
});

test("ui: keyboard input is immediate and the arena focuses itself", () => {
  // A real, focusable input backs the invisible keyboard interaction.
  assert.match(page, /<textarea/);
  assert.match(page, /aria-label="Type the passage"/);
  assert.match(page, /onChange=\{onChange\}/);
  assert.match(page, /autoCorrect="off"/);
  assert.match(page, /spellCheck=\{false\}/);
  // Pasting is refused — a pasted passage is not a typed one.
  assert.match(page, /onPaste=\{\(event\) => event\.preventDefault\(\)\}/);
  // Focus lands on the arena as soon as the race opens, and after a reconnect.
  assert.match(page, /inputRef\.current\?\.focus\(\)/);
  assert.match(page, /document\.addEventListener\("visibilitychange", focus\)/);
  // The clock never repaints the passage: the track is memoised.
  assert.match(page, /const PassageTrack = memo\(/);
  assert.match(page, /<PassageTrack/);
});

// ════════════════════════════════════════════════════════════════════════
// 3. The client may NOT decide the result
// ════════════════════════════════════════════════════════════════════════

test("authority: the result comes from the server's verdict, never from local typing", () => {
  // The outcome is read off the snapshot's `result` / `winnerId` only.
  const outcome = page.slice(page.indexOf("const outcome ="), page.indexOf("const durationSeconds"));
  assert.match(outcome, /match\?\.result === "tie"/);
  assert.match(outcome, /match\.winnerId === user\.id/);
  // Nothing local (WPM, a finished flag, a progress comparison) may feed it.
  for (const forbidden of [/local\.wpm/, /myWpm/, /isComplete/, /typed === passage/]) {
    assert.doesNotMatch(outcome, forbidden, `the outcome must not read ${forbidden}`);
  }
  // The result screen only opens for a FINISHED match the server reported.
  assert.match(page, /open=\{phase === "result" && match\?\.status === "finished"\}/);
  // A cancelled match is never dressed up as a win or a loss.
  assert.match(page, /data-testid="speed-typing-cancelled"/);
});

test("authority: the server's frozen numbers win over the local estimate", () => {
  // Local prediction exists for paint latency only, and is explicitly replaced
  // by the authoritative values the moment the seat has finished.
  assert.match(
    page,
    /const myWpm = race\?\.you\?\.finished \? \(race\.you\.wpm \?\? local\.wpm\) : local\.wpm/,
  );
  assert.match(
    page,
    /const myAccuracy = race\?\.you\?\.finished \? \(race\.you\.accuracy \?\? local\.accuracy\) : local\.accuracy/,
  );
  // The opponent's numbers arrive from the server (socket payload or snapshot),
  // never from a local simulation of them.
  assert.match(page, /const opponentWpm = opponent\?\.wpm \?\? race\?\.metrics\?\.opponent\?\.wpm \?\? 0/);
});

test("authority: the page sends the typed text and NOTHING else", () => {
  const sends = [...page.matchAll(/fetch\((?:.|\n)*?\}\);/g)].map((m) => m[0]);
  assert.ok(sends.length >= 3, "expected the snapshot GET, the checkpoint POST and the finish POST");
  for (const call of sends) {
    // No request body may carry a number the server would have to trust.
    assert.doesNotMatch(call, /wpm|accuracy|winner|elapsedMs|rating|troph/i, `forbidden field sent: ${call.slice(0, 80)}`);
  }
  // The two gameplay POSTs send exactly one field.
  assert.match(page, /body: JSON\.stringify\(\{ typedText: buffer \}\)/);
});

test("authority: the routes pass only the typed text into the store", () => {
  const progress = code(PROGRESS_ROUTE);
  const finish = code(FINISH_ROUTE);
  assert.match(progress, /typedText: body\?\.typedText/);
  assert.match(finish, /typedText: body\?\.typedText/);
  for (const [name, src] of [
    ["progress", progress],
    ["finish", finish],
  ]) {
    // The routes never read a client-supplied decision field at all.
    for (const forbidden of [/body\?\.wpm/, /body\?\.accuracy/, /body\?\.winner/, /body\?\.rating/, /body\?\.troph/]) {
      assert.doesNotMatch(src, forbidden, `${name} must not read ${forbidden}`);
    }
    assert.match(src, /requireAgeVerifiedUser\(\)/, "both routes are session-gated");
  }
  // The finish route only ever resolves from the store's own verdict.
  assert.match(finish, /if \(result\.outcome\?\.settled\)/);
  assert.match(finish, /resolutionReason: result\.outcome\.resolutionReason/);
});

// ════════════════════════════════════════════════════════════════════════
// 4. Realtime + performance
// ════════════════════════════════════════════════════════════════════════

test("realtime: the page joins the match room, re-joins on connect, and listens", () => {
  assert.match(page, /const \{ socket \} = useSocket\(\)/);
  assert.match(page, /const roomId = speedTypingMatchRoom\(matchId\)/);
  assert.match(page, /socket\.emit\("join_room", \{ roomId \}\)/);
  // A reconnect must re-join (Socket.IO does not restore membership).
  assert.match(page, /socket\.on\("connect", join\)/);
  assert.match(page, /socket\.emit\("leave_room", \{ roomId \}\)/);
  for (const event of [
    /SPEED_TYPING_EVENTS\.MATCH_UPDATED,\s*onUpdated/,
    /SPEED_TYPING_EVENTS\.OPPONENT_PROGRESS,\s*onProgress/,
    /SPEED_TYPING_EVENTS\.COUNTDOWN,\s*onCountdown/,
    /SPEED_TYPING_EVENTS\.MATCH_FINISHED,\s*onUpdated/,
  ]) {
    assert.match(page, event);
  }
  // The poll is a backstop, never the only path. It is also visibility-gated
  // and socket-aware: it relaxes while the socket is healthy, tightens if it
  // drops, and stops entirely while the tab is hidden (a hidden tab cannot be
  // typing, so its timer must not keep reading from Postgres).
  assert.match(
    page,
    /useVisiblePoll\(\s*\(\) => load\(\{ silent: true \}\),\s*socketConnected \? SOCKET_HEALTHY_POLL_MS : SOCKET_DOWN_POLL_MS,\s*Boolean\(match\) && !finished,\s*\)/,
  );
  assert.match(page, /import \{[\s\S]{0,160}useVisiblePoll,[\s\S]{0,160}\} from "\.\.\/\.\.\/\.\.\/\.\.\/hooks\/useVisiblePoll"/);
  // No unconditional fixed-interval poll may remain on this page.
  assert.doesNotMatch(page, /window\.setInterval\(\s*\(\) => void load/);
});

test("realtime: the client ignores progress for its own seat and leaks no text", () => {
  // Only the OTHER seat's projection is adopted as "opponent".
  const handler = page.slice(page.indexOf("const onProgress"), page.indexOf("const onCountdown"));
  assert.match(handler, /if \(seat !== mySeatKey && payload\?\.seatKey === seat\)/);
  // …and the projection the client consumes is the closed server shape.
  assert.match(page, /data\.data\.match as MatchDto/);
  // The page never sends its buffer anywhere except the two gameplay routes.
  const emits = [...page.matchAll(/socket\??\.emit\(([^,]+),([\s\S]{0,80}?)\)/g)].map((m) => m[0]);
  for (const emit of emits) {
    assert.match(emit, /join_room|leave_room|"connect"|SPEED_TYPING_EVENTS\.READY/, `unexpected emit: ${emit}`);
  }
});

test("realtime: the vocabulary is client-safe and defined once", () => {
  const rooms = read(ROOMS);
  // Client-safe: the vocabulary module imports nothing at all.
  assert.doesNotMatch(rooms, /^import /m, "the room/event vocabulary must stay import-free");
  assert.match(rooms, /export function speedTypingMatchRoom/);
  assert.match(rooms, /MATCH_UPDATED: "lobby:updated"/);
  assert.match(rooms, /OPPONENT_PROGRESS: "speed-typing:opponent-progress"/);
  // The server module re-exports the same vocabulary rather than restating it.
  const realtime = code("src/lib/speed-typing/realtime.ts");
  assert.match(realtime, /from "\.\/rooms"/);
  assert.doesNotMatch(realtime, /MATCH_UPDATED: "lobby:updated"/, "the event list must not be duplicated");
});

test("ui: waiting uses the shared takeover, and can release the open lobby", () => {
  // The platform's own waiting takeover, with the house seat shape.
  const waiting = page.slice(page.indexOf("<MatchWaiting"), page.indexOf("phase === \"countdown\""));
  assert.match(waiting, /gameName="Speed Typing"/);
  assert.match(waiting, /\{ label: "You", name: viewerName, occupied: true \}/);
  assert.match(waiting, /\{ label: "Opponent", occupied: false \}/);
  // A waiting row IS the open lobby, so abandoning it must release it rather
  // than leave a ghost a future opponent could be paired into. The creator
  // cancels through the store's own `cancelMatch`; a non-creator leaves.
  assert.match(waiting, /onCancel=\{canCancelLobby \? cancelLobby : null\}/);
  assert.match(waiting, /onLeave=\{canCancelLobby \? null : leaveWaiting\}/);
  assert.match(page, /const canCancelLobby = status === "waiting" && match\?\.viewerSeat === 1/);
  assert.match(page, /fetch\(`\/api\/speed-typing\/match\/\$\{matchId\}\/cancel`/);
});

test("authority: cancellation only closes an unstarted lobby and rates nothing", () => {
  const cancel = code(CANCEL_ROUTE);
  assert.match(cancel, /requireAgeVerifiedUser\(\)/, "the route is session-gated");
  assert.match(cancel, /cancelMatch\(\{ userId, matchId \}\)/, "it delegates to the store");
  // No settlement vocabulary: a cancelled lobby never moved a rating or trophy.
  assert.doesNotMatch(cancel, /award|troph|rating|settle/i);
});

test("ui: the page uses GRYND chrome, not a separate design system", () => {
  assert.match(page, /import GameSessionHost from/);
  assert.match(page, /import MatchWaiting from/);
  assert.match(page, /import PvpResultScreen from/);
  assert.match(page, /import NavigationBar from/);
  assert.match(page, /autoStart=\{match\?\.status === "playing"\}/);
  assert.match(page, /autoStop=\{finished\}/);
  assert.match(page, /gameLabel="speed-typing"/);
  // Ads stay off the match surface, as on every other game board.
  assert.doesNotMatch(read(MATCH_PAGE), /AdSense|AdSlot/);
});
