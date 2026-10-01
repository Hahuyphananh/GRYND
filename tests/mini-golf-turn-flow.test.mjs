// tests/mini-golf-turn-flow.test.mjs
//
// Mini Golf's TURN HAND-OFF contract — the three things a turn-based duel
// cannot get wrong, and each of which regressed at least once:
//
//   1. ONE BOT TURN, ONE HOLE. `advanceAiTurns` used to play the bot's whole
//      run, and `applyShot` starts the next hole the moment a hole completes.
//      The starter alternates, so on an even hole the starter IS the bot: one
//      poll could therefore complete a hole AND begin playing the next one. To
//      the player that read as "my turn ended, the opponent's turn was skipped,
//      and now we're on another hole".
//   2. ONLY THE PLAYING SEAT'S BALL. A Mini Golf turn runs one seat's ball to
//      the cup; drawing both at once read as two live balls and made "whose
//      shot is this?" ambiguous.
//   3. THE TURN IS ANNOUNCED — by name ("<name>'s turn") and, for the practice
//      bot, as "GRYND AI turn" — because a bot's whole run resolves inside one
//      poll, leaving the announcement as the only evidence it took a turn.
//
// Asserted against the REAL files in the same style as the rest of
// tests/mini-golf-*.test.mjs: the store and the canvas are dependency-heavy, so
// the contract is pinned where it is written, and the rules premises it rests
// on are checked by calling the real module.
//
// Run:  node --import tsx --test tests/mini-golf-turn-flow.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const { starterSeatForHole } = await import("../src/lib/mini-golf/rules.ts");

const read = (rel) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");
const strip = (src) => src.replace(/\r\n/g, "\n");

const STORE = "src/lib/mini-golf/serverStore.ts";
const COURSE = "src/components/mini-golf/MiniGolfCourse.tsx";
const MATCH_PAGE = "src/app/casino/mini-golf/[matchId]/PageClient.tsx";

const countOf = (src, needle) => src.split(needle).length - 1;

const advanceFn = () => {
  const src = strip(read(STORE));
  const start = src.indexOf("export async function advanceAiTurns");
  assert.ok(start > -1, "advanceAiTurns must exist");
  return src.slice(start, src.indexOf("// ── Read"));
};

// ── 1. One bot turn, one hole ────────────────────────────────────────────

test("premise: the tee alternates, so an even hole is the bot's to start", () => {
  // This is WHY a single poll could cross a hole boundary: the bot is the
  // starter on every even hole, so a loop that keeps going after a completed
  // hole finds the turn already sitting on the bot again.
  assert.equal(starterSeatForHole(1), "player1");
  assert.equal(starterSeatForHole(2), "player2");
  assert.equal(starterSeatForHole(3), "player1");
  assert.equal(starterSeatForHole(4), "player2");
  assert.equal(starterSeatForHole(5), "player1");
});

test("the bot hands control back the moment a hole completes", () => {
  const fn = advanceFn();
  const completed = fn.indexOf("if (applied.holeCompleted) break;");
  const finished = fn.indexOf("if (outcome) break;");
  assert.ok(completed > -1, "a completed hole must break the bot's loop");
  assert.equal(
    countOf(fn, "if (applied.holeCompleted) break;"),
    1,
    "exactly one hole boundary break",
  );
  assert.ok(
    finished > -1 && finished < completed,
    "a finished match still short-circuits before the hole boundary",
  );
});

test("the bot loop still refuses to run outside its own turn", () => {
  const fn = advanceFn();
  // Turn ownership is the first guard: a poll landing mid-human-turn is a
  // no-op, and the loop can never advance the human's own ball.
  assert.match(fn, /if \(state\.currentTurn !== "player2"\) break;/);
  assert.match(fn, /if \(state\.balls\.player2\.holedOut\) break;/);
  assert.match(fn, /MAX_AI_SHOTS_PER_ADVANCE/);
  // A practice match still moves no rating, trophy or queue state.
  assert.match(fn, /Deliberately NO settleMatch \/ mirrorQueueTransition here/);
});

test("the bot's turn is never resolved in the same tick as the player's shot", () => {
  const src = strip(read(MATCH_PAGE));
  assert.doesNotMatch(
    src,
    /match\?\.isAi && !data\??\.data\??\.matchCompleted/,
    "the immediate post-shot AI refetch must be gone",
  );
  const launch = src.slice(
    src.indexOf("const launchShot = useCallback"),
    src.indexOf("const forfeit = useCallback"),
  );
  assert.ok(launch.length > 0, "launchShot must exist");
  // The success path adopts the authoritative snapshot and nothing else — the
  // bot is driven by the poll, one turn later, so it gets a visible beat.
  const success = launch.slice(
    launch.indexOf("setMatch(data.data.match);"),
    launch.indexOf("} catch {"),
  );
  assert.ok(success.length > 0, "the success path must adopt the returned match");
  assert.doesNotMatch(success, /refresh\(\)/, "the success path must not refetch");
  assert.match(launch, /ACTIVE_POLL_MS/, "the bot is left to the active poll");
});

// ── 2. Only the playing seat's ball ─────────────────────────────────────

test("the canvas draws exactly one seat's ball", () => {
  const src = strip(read(COURSE));
  assert.match(src, /visibleSeat\?: Seat \| null;/, "the canvas takes a visible seat");
  assert.match(src, /visibleSeat = null,/, "and defaults to drawing every seat");
  assert.match(
    src,
    /if \(visibleSeat && seat !== visibleSeat\) continue;/,
    "the ball loop must skip the hidden seat",
  );
  // A prop change must repaint, or the opponent's ball would linger on screen.
  // (`movingBall,` immediately followed by `visibleSeat,` only occurs in the
  // paint effect's dependency list — the props above are `movingBall = null,`.)
  assert.match(src, /movingBall,\n\s+visibleSeat,/, "visibleSeat must be a paint dependency");
});

test("the board follows the shot in flight, else the seat whose turn it is", () => {
  const src = strip(read(MATCH_PAGE));
  assert.match(src, /const turnSeat: Seat \| null = \(match\?\.currentTurn/);
  assert.match(src, /const ballSeat: Seat \| null =/);
  // An animating rollout owns the board…
  assert.match(src, /anim\?\.seat \?\?/);
  // …then the hole-result interstitial leaves the seat that just finished on
  // screen, and otherwise the seat whose turn it is.
  assert.match(src, /holeOverlay \? \(\(match\?\.lastShot\?\.seat as Seat \| undefined\) \?\? turnSeat\) : turnSeat\)/);
  assert.match(src, /visibleSeat=\{ballSeat\}/, "the derived seat must reach the canvas");
});

// ── 3. The turn is announced ────────────────────────────────────────────

test("a turn hand-off is announced exactly once per hole, seat and shot", () => {
  const src = strip(read(MATCH_PAGE));
  assert.match(src, /const TURN_CALL_MS = \d+;/);
  assert.match(src, /data-testid="turn-announcement"/);
  // Keyed on (hole, seat, shot) so the poll, the socket push and the post-shot
  // resync — which all redeliver the same state — read as one announcement.
  assert.match(src, /const key = `\$\{Number\(match\.currentHole\) \|\| 0\}:\$\{seat\}:\$\{Number\(match\.shotSeq\) \|\| 0\}`/);
  assert.match(src, /if \(key === turnCallKeyRef\.current\) return;/);
});

test("the announcement names the seat, and says GRYND AI for the bot", () => {
  const src = strip(read(MATCH_PAGE));
  assert.match(src, /seat === viewerSeat\s*\n\s*\? "Your turn"/);
  assert.match(src, /"GRYND AI turn"/, "the practice bot announces itself by name");
  assert.match(
    src,
    /`\$\{seats\.opponent\?\.name \|\| seatLabel\(seat, viewerSeat\)\}'s turn`/,
    "a human opponent is announced by display name",
  );
  assert.match(
    src,
    /const opponentName = match\?\.isAi\s*\n\s*\? "GRYND AI"/,
    "the bot's display name is GRYND AI",
  );
  // The interstitial owns the screen while it is up; the hand-off it leads to
  // is announced the moment it clears.
  assert.match(src, /if \(holeOverlay\) return;/);
});

// ── 4. The bottom shoot menu is gone and the board owns the viewport ────

test("the retired bottom control panel appears exactly once, on the board", () => {
  const src = strip(read(MATCH_PAGE));
  for (const id of ["turn-status", "power-meter", "aim-state", "bot-turn-summary", "turn-announcement"]) {
    assert.equal(
      countOf(src, `data-testid="${id}"`),
      1,
      `${id} must exist exactly once (the on-board HUD, not a duplicated panel)`,
    );
  }
  // The board sits inside the board column, and the match facts collapse so the
  // sidebar cannot push it off screen.
  assert.match(src, /data-testid="mini-golf-board"/);
  assert.match(src, /data-testid="match-details-toggle"/);
  assert.match(src, /aria-expanded=\{showDetails\}/);
});

test("the course is sized to the screen and the layout stacks on mobile", () => {
  const src = strip(read(MATCH_PAGE));
  // The board takes every pixel the strip and seat row leave, on desktop…
  assert.match(src, /lg:flex-1 lg:grid-cols-\[minmax\(0,1fr\)_300px\]/);
  // …and a viewport-relative share of it on a phone, instead of a fixed box.
  assert.match(src, /min-h-\[clamp\(240px,46svh,560px\)\]/);
  assert.match(src, /lg:min-h-\[220px\]/);
  // Below lg the two columns become one normal-flow column, so the page simply
  // scrolls rather than squeezing the course.
  assert.match(src, /relative w-full flex-1 overflow-hidden rounded-xl/);
  assert.match(src, /overflow-x-clip/, "a wide board must never scroll the page sideways");
  assert.match(src, /<NavigationBar currentPath="\/casino" \/>/, "the shared navbar is rendered");
  assert.match(src, /min-h-\[calc\(100svh-68px\)\]/);
});

// ── 5. A refresh can never run the opponent's turn behind the board ─────
//
// In a practice match the GET itself plays the bot's turn, and in a human
// duel it delivers the opponent's move. Firing it while a rollout or the
// hole-result interstitial owned the board is what swallowed the hand-off on
// later holes — the opponent's turn resolved underneath the interstitial and
// was never seen. The snapshot request is now deferred until the board is
// free, then flushed once.

test("refresh defers while a rollout or the hole interstitial owns the board", () => {
  const src = strip(read(MATCH_PAGE));
  assert.match(src, /const pendingRefreshRef = useRef\(false\);/);
  const refreshFn = src.slice(
    src.indexOf("const refresh = useCallback"),
    src.indexOf("const flushPendingRefresh = useCallback"),
  );
  assert.ok(refreshFn.length > 0, "refresh must exist before flushPendingRefresh");
  assert.match(
    refreshFn,
    /if \(animRef\.current \|\| overlayRef\.current\) \{\s*\n\s*pendingRefreshRef\.current = true;\s*\n\s*return;/,
    "refresh must defer while a rollout or the interstitial is up",
  );
});

test("the deferred refresh is flushed once the board is free", () => {
  const src = strip(read(MATCH_PAGE));
  assert.match(src, /const flushPendingRefresh = useCallback\(\(\) => \{/);
  // It re-checks the board is free before firing, so a queued rollout that
  // just started can leave the request pending (its own finish flushes it).
  const flushFn = src.slice(
    src.indexOf("const flushPendingRefresh = useCallback"),
    src.indexOf("useEffect(", src.indexOf("const flushPendingRefresh = useCallback")),
  );
  assert.match(flushFn, /if \(animRef\.current \|\| overlayRef\.current\) return;/);
  // Wired at every settle point: the hole interstitial's timeout and the two
  // rollout-finish branches.
  assert.ok(
    countOf(src, "flushPendingRefresh()") >= 3,
    "the flush must run from the interstitial timeout and the rollout finish",
  );
});

test("a hand-off is not announced mid-rollout (it would eat the key)", () => {
  const src = strip(read(MATCH_PAGE));
  const announce = src.slice(
    src.indexOf("── Turn announcement"),
    src.indexOf("const { incomingEmote, myEmote, sendEmote }"),
  );
  assert.ok(announce.length > 0, "the turn announcement effect must exist");
  // Skipping while a rollout is in flight leaves the key for the hand-off the
  // player actually needs to see once the board settles.
  assert.match(announce, /if \(holeOverlay\) return;/);
  assert.match(announce, /if \(anim\) return;/);
});
