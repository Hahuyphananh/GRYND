/**
 * Lane Rush Duel — UI + server contract tests (shared-bridge era).
 *
 * These lock in the contracts the pure bridge engine can't express:
 *   * the client reconciles only the newest status response, retries an
 *     action once (safe because the server dedupes on `actionId`), cleans
 *     up its timers/listeners and never offers a removed mechanic;
 *   * the server has ONE authoritative transition: current-player gating,
 *     row staleness, idempotent replay rejection, and no `pending` path;
 *   * only crossing row 10 (or a resignation) settles the match;
 *   * the 15s decision window is server-authoritative on both read and
 *     write paths;
 *   * memory flags are validated against the seat's own landing, public,
 *     append-only and capped at 2 per match;
 *   * broken tiles are pushed to both seats without leaking the layout;
 *   * the legacy points / banking / multiplier / peek logic is gone.
 *
 * The pure engine itself is covered by tests/lane-rush-bridge.test.mjs.
 *
 * Run:  node --import tsx --test tests/lane-rush-duel-ui-contract.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// Normalise CRLF so multi-line structural assertions work on any OS.
const read = (p) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const page = read("src/app/casino/lane-runner/[matchId]/PageClient.jsx");
const store = read("src/lib/lane-rush-duel/serverStore.js");
const actRoute = read("src/app/api/lane-rush-duel/match/[matchId]/act/route.js");
const matchRoute = read("src/app/api/lane-rush-duel/match/[matchId]/route.js");
const audio = read("src/lib/gameAudio.ts");
const constants = read("src/lib/lane-rush-duel/constants.js");
const aiRoute = read("src/app/api/lane-rush-duel/match/[matchId]/ai-turn/route.js");

// ════════════════════════════════════════════════════════════════════
// Client: shared-bridge integration + state-sync safety
// ════════════════════════════════════════════════════════════════════

test("the client renders the shared bridge and gates picks by the server turn", () => {
  assert.ok(page.includes("match?.isViewerTurn"), "turn comes from the server");
  assert.ok(page.includes('doAction("jump"'), "a tile choice is a jump");
  assert.ok(page.includes('doAction("flag"'), "a memory flag is a flag action");
  assert.ok(page.includes("flaggableSet"), "flags are gated to landed-safe tiles");
  assert.ok(page.includes("brokenSet"), "broken tiles come from the server");
});

test("the jump animation is presentation-only and server-driven", () => {
  assert.ok(
    page.includes('data-testid="lane-runner-jump"'),
    "the jump overlay exists",
  );
  assert.ok(page.includes("function JumpOverlay("), "it is a dedicated overlay");
  // The outcome it plays comes from the SERVER's resolved action history…
  assert.ok(page.includes("outcome: a.outcome"));
  // …and a log/shatter is never the thing that advances a row or hands over
  // the turn: the client never writes match state from an animation callback.
  assert.ok(!page.includes("onAnimationComplete={() => setMatch"));
  assert.ok(!page.includes("onAnimationComplete={() => setJump"));
  // The overlay can never intercept a click.
  assert.ok(
    page.includes("pointer-events-none absolute inset-0 z-30"),
    "the overlay never blocks the board",
  );
  // Reduced motion removes the decorative animation entirely.
  assert.ok(page.includes("!shouldReduce"));
});

test("the memory-flag UI is prominent, public and gated to personal landings", () => {
  // The remaining budget is shown in the HUD…
  assert.ok(
    page.includes('data-testid="lane-runner-flags-left"'),
    "the HUD shows the remaining flags",
  );
  assert.ok(page.includes("flagsLeft}/{flagsTotal} left"), "…as `n/2 left`");
  // …and a flag is only OFFERED right after this seat personally landed safe.
  assert.ok(
    page.includes('data-testid="lane-runner-flag-prompt"'),
    "a post-landing flag prompt exists",
  );
  assert.ok(
    page.includes('a.outcome !== "safe" && a.outcome !== "won"'),
    "the offer is derived from the server's own safe/won landings",
  );
  assert.ok(
    page.includes("myFlagsLeft > 0") && page.includes("!myFlagSet.has("),
    "the offer respects the budget and never repeats a tile",
  );
  // An untested tile can never be flagged from the client either.
  assert.ok(
    page.includes("if (!flaggableSet.has(k)) return;"),
    "flag mode refuses any tile this seat never landed on",
  );
  // The flag is a first-class board object, not a corner badge: a large,
  // glowing flag centred on the tile so it can actually be seen on the board.
  assert.ok(
    page.includes(
      "pointer-events-none absolute inset-0 z-20 flex items-center justify-center gap-0.5",
    ),
    "the flag is centred on the tile",
  );
  assert.ok(
    page.includes("text-rose-300 drop-shadow-[0_0_5px_rgba(251,113,133,0.95)]") &&
      page.includes("text-amber-300 drop-shadow-[0_0_5px_rgba(251,191,36,0.95)]"),
    "both seats' flags are drawn large and glowing",
  );
  assert.ok(
    page.includes('myFlag || oppFlag ? "opacity-45" : ""'),
    "the tile number stays readable, dimmed under a flag",
  );
  // The server stays authoritative — the client only asks.
  assert.ok(
    page.includes('doAction("flag"'),
    "placing a flag is a server action, not local state",
  );
});

test("bridge tiles are square glass panels with sharp edges", () => {
  assert.ok(
    page.includes("h-12 w-12 shrink-0 overflow-hidden rounded-none border-2"),
    "every tile is a square, sharp-edged panel",
  );
  assert.ok(page.includes("sm:h-14 sm:w-14"), "…that scales up on desktop");
  assert.ok(
    !page.includes("h-11 flex-1 overflow-hidden rounded-xl"),
    "the old rounded, stretched tile is gone",
  );
  assert.ok(
    !page.includes("flex flex-1 items-center gap-1.5"),
    "tiles are no longer stretched to fill the row",
  );
});

test("a breaking tile cracks like glass, on the beat of the impact", () => {
  assert.ok(page.includes("playGlassBreak"), "the glass-break cue is wired in");
  assert.ok(page.includes("playBreakAtImpact()"), "your own fall plays it");
  assert.ok(
    page.includes("playBreakAtImpact(true)"),
    "the opponent's fall plays it too, mixed down",
  );
  // Scheduled to the impact, never fired on the state change.
  assert.ok(
    page.includes("setTimeout(fire, GLASS_BREAK_IMPACT_MS)"),
    "the crack is delayed to the moment the glass gives way",
  );
  // A timeout breaks no tile, so it must keep the plain buzz.
  assert.ok(
    page.includes("A timeout breaks no tile"),
    "a timeout is not a glass break",
  );
  // The cue is synthesised (this module ships no audio files): a filtered
  // noise crack plus ringing partials, randomised so repeats never loop.
  assert.ok(
    audio.includes("export function playGlassBreak("),
    "playGlassBreak exists in the shared audio module",
  );
  assert.ok(
    audio.includes('highpass') && audio.includes("partials"),
    "it is a noise crack over scattered shard partials",
  );
});

test("the glass breaks on impact, not when the fall starts", () => {
  assert.ok(page.includes("function GlassBreak("), "a dedicated break effect exists");
  assert.ok(
    page.includes("<GlassBreak tileRect={tileRect} delay={0.5} />"),
    "the shatter is delayed to the moment the token lands",
  );
  assert.ok(
    page.includes("pendingBreakKey"),
    "a freshly broken tile only flips to shattered as the impact lands",
  );
  // The failed tile also keeps a permanent shattered look.
  assert.ok(page.includes("bg-white/55"), "the static crack web is drawn");
});

test("the bridge renders top-first, so the summit is row 10 — never row 1", () => {
  // Rows are rendered top-first: the LAST index (row 10) sits at the top of
  // the screen, with the start platform below it.
  assert.ok(
    page.includes(
      "Array.from({ length: bridgeRows }, (_, row) => row).reverse()",
    ),
    "rows render top-first",
  );
  assert.ok(page.includes("Summit · cross row {bridgeRows} to win"));
  assert.ok(page.includes("Start · row 1"));
  // The goal emphasis therefore belongs to `bridgeRows - 1`.
  assert.ok(page.includes("const isGoal = row === bridgeRows - 1;"));
  assert.ok(
    !page.includes("const isGoal = row === 0;"),
    "row 1 (the start) must never be highlighted as the summit",
  );
  // …and a winning jump leaves the bridge upward, off the top row.
  assert.ok(page.includes("to = { x: from.x, y: from.y - 34 };"));
  assert.ok(
    !page.includes("const top = anchorFor(0);"),
    "a win must not swoop back down toward row 1",
  );
});

test("the client never offers a removed mechanic", () => {
  for (const dead of [
    "canHold",
    "banked",
    "unbanked",
    "peek",
    "riskPath",
    "RISK_PATHS",
    "bankPending",
    "hold",
  ]) {
    assert.ok(!page.includes(dead), `removed mechanic "${dead}" must not appear in the UI`);
  }
});

test("an API failure can't leave the duel silently frozen", () => {
  assert.ok(page.includes("syncFailures"));
  assert.ok(page.includes("Reconnecting…"));
  assert.ok(page.includes("setSyncFailures(0)"));
});

test("a failed load offers a retry instead of a dead end", () => {
  assert.ok(page.includes("Couldn't load the duel:"));
  assert.ok(page.includes("onClick={() => fetchStatus()}"));
  assert.ok(page.includes("Match not found or you are not a participant."));
});

test("no async handler can surface an unhandled promise rejection", () => {
  assert.ok(page.includes('setError("Network error — could not resign.")'));
  assert.ok(page.includes('setError("Network error — could not cancel.")'));
  assert.ok(
    page.includes('setError("Network error — your action was not sent. Try again.")'),
  );
  // The action handler already retries once before surfacing the failure.
  assert.ok(page.includes("res = await send();\n        } catch {\n          // One retry"));
  // Clipboard writes are permissions-gated and must not reject unhandled.
  const clipboardCalls = page.match(/writeText\(window\.location\.href\)/g) || [];
  const guardedCalls =
    page.match(/writeText\(window\.location\.href\)\s*\?\.catch\(\(\) => \{\}\)/g) || [];
  assert.ok(clipboardCalls.length >= 2, "both invite-link copies are wired");
  assert.equal(guardedCalls.length, clipboardCalls.length);
});

// ════════════════════════════════════════════════════════════════════
// Server: one authoritative transition
// ════════════════════════════════════════════════════════════════════

test("the server guards the tile choice: current player, its own row, no replay", () => {
  // Only the current player may select a tile…
  assert.ok(
    store.includes("if (!match.currentTurnUserId || match.currentTurnUserId !== userId)"),
  );
  // …on the row that player is actually standing on…
  assert.ok(store.includes("selectedRow !== currentRow"));
  // …and a replayed action must not advance the game twice.
  assert.ok(store.includes("hasResolvedActionId(match.actions, actionId)"));
  assert.ok(store.includes("duplicate: true"));
});

test("no action is ever parked as pending anymore (stranded-action bug)", () => {
  assert.ok(!store.includes("parkPendingAction"));
  assert.ok(!store.includes("releasePendingActions"));
  assert.ok(!store.includes("pending: true"), "no code path may create a pending action");
  // The one live transition is the tile-selection jump.
  assert.ok(store.includes("async function applyBridgeJump"));
  assert.ok(store.includes("bridgeTurnAfterJump"));
});

test("only crossing row 10 (or a resignation) settles the match", () => {
  // The single terminal check inside the live transition: a fall never
  // settles — it resets the attempt and hands the turn over.
  assert.ok(store.includes("if (turn.ended)"));
  assert.ok(store.includes('reason: "crossed_bridge"'));
  assert.ok(store.includes("currentTurnUserId: turn.turnUserId"));
  // The old completion / both-ended settlement paths are gone.
  assert.ok(!store.includes('reason: "completed"'));
  assert.ok(!store.includes("resolveByFinalScores"));
  assert.ok(!store.includes("advanceTurn"));
});

test("the bot path dedupes wake-ups too", () => {
  assert.ok(aiRoute.includes("actionId"));
  assert.ok(store.includes("hasResolvedActionId(match.actions, actionId)"));
  assert.ok(store.includes("if (actionId) entry.actionId = String(actionId);"));
  // The bot may only act while it owns the turn.
  assert.ok(store.includes("if (match.currentTurnUserId !== BOT_USER_ID) return match;"));
});

test("the act route forwards actionId + row and treats a duplicate as success", () => {
  assert.ok(actRoute.includes("const actionId = body?.actionId ?? null;"));
  assert.ok(actRoute.includes("const row = body?.row ?? null;"));
  assert.ok(actRoute.includes("if (result.duplicate)"));
  assert.ok(actRoute.includes("duplicate: true"));
});

// ════════════════════════════════════════════════════════════════════
// The 15s decision timer — server-authoritative
// ════════════════════════════════════════════════════════════════════

test("an expired choice window ends the attempt — it never picks or breaks a tile", () => {
  const begin = store.indexOf("async function timeoutAttempt");
  assert.ok(begin > 0, "the timeout transition must exist");
  const body = store.slice(
    begin,
    store.indexOf("export function scrubMatchForViewer", begin),
  );

  // A timeout touches no tile, so no bad tile can break and nothing leaks.
  assert.ok(!body.includes("resolveJump("), "a timeout must not resolve a jump");
  assert.ok(!body.includes("Math.random"), "a timeout must not pick a tile");
  assert.ok(!body.includes("broken"), "a timeout must not break a tile");
  assert.ok(!body.includes("tile:"), "a timeout must record no tile");

  // It ends the attempt: reset the row, hand over the turn, restart the window.
  assert.ok(body.includes("[turn.rowField]: turn.row"));
  assert.ok(body.includes("currentTurnUserId: turn.turnUserId"));
  assert.ok(body.includes("roundDeadline: nextTurnDeadline()"));
  assert.ok(body.includes("action: BRIDGE_ACTIONS.TIMEOUT"));
});

test("the window is enforced on the write path too (a late tile cannot win)", () => {
  // `act` refuses a tile submitted after `roundDeadline` and resolves the
  // expiry instead, so a slow client or a lagging device clock buys no time.
  assert.ok(store.includes("new Date(match.roundDeadline).getTime() <= Date.now()"));
  assert.ok(store.includes('error: "Time ran out — the attempt ended"'));
  // …and the state that move produced is still pushed to the opponent.
  assert.ok(actRoute.includes("if (result.timedOut)"));
  assert.ok(actRoute.includes('action: "timeout"'));
});

// ════════════════════════════════════════════════════════════════════
// Memory flags — server-validated, public, append-only, 2 per match
// ════════════════════════════════════════════════════════════════════

test("a flag action is validated against the seat's OWN landing, not the request", () => {
  const begin = store.indexOf("if (wantsFlag) {");
  assert.ok(begin > 0, "the store must handle the flag action");
  const branchEnd = store.indexOf("const currentRow = seatRow(match, seat);", begin);
  assert.ok(branchEnd > begin);
  const body = store.slice(begin, branchEnd);

  // The client proposes coordinates; the SERVER decides whether its own
  // history shows that seat landing there safely.
  assert.ok(body.includes("canPlaceFlag({"));
  assert.ok(body.includes("row: selectedRow"));
  assert.ok(body.includes("tile: selectedTile"));
  assert.ok(body.includes("status: 409"), "an illegal flag is refused");
  // The gate itself lives in the engine and reads the seat's own history.
  assert.ok(constants.includes("if (!landedSafelyOn(match, seat, r, t))"));
  assert.ok(constants.includes("export function landedSafelyOn"));
  assert.ok(constants.includes("a.seat === seat"));

  // "flag" is an accepted action alongside the tile choice.
  assert.ok(store.includes("const wantsFlag = actAction === BRIDGE_ACTIONS.FLAG;"));
});

test("a flag never consumes the turn and never touches board state", () => {
  const begin = store.indexOf("if (wantsFlag) {");
  const body = store.slice(
    begin,
    store.indexOf("const currentRow = seatRow(match, seat);", begin),
  );

  // The flag branch runs BEFORE the turn check: a flag is not a tile choice.
  assert.ok(begin < store.indexOf("ONLY THE CURRENT PLAYER MAY ACT"));
  // …and it writes nothing but the flag column.
  for (const forbidden of [
    "currentTurnUserId:",
    "roundDeadline:",
    "[turn.rowField]",
    "p1Row:",
    "p2Row:",
    "status: MATCH_STATUS",
    "broken",
    "actions:",
  ]) {
    assert.ok(!body.includes(forbidden), `a flag must not write ${forbidden}`);
  }
  assert.ok(body.includes("[placement.field]: placement.flags"));
});

test("a flag column is append-only — no jump can move or remove a flag", () => {
  // The bridge transition no longer rewrites the flag columns at all.
  const jumpBody = store.slice(
    store.indexOf("async function applyBridgeJump"),
    store.indexOf("async function resolveMatch"),
  );
  assert.ok(!jumpBody.includes("p1Flags:"));
  assert.ok(!jumpBody.includes("p2Flags:"));
  assert.ok(!jumpBody.includes("dropBrokeFlags"));
  // …so every write to a flag column happens inside the flag branch, and it
  // appends (existing list first, the new flag last).
  const begin = store.indexOf("if (wantsFlag) {");
  const end = store.indexOf("const currentRow = seatRow(match, seat);", begin);
  let at = store.indexOf("[placement.field]: placement.flags");
  assert.ok(at > 0, "the flag column write must exist");
  let writes = 0;
  while (at !== -1) {
    assert.ok(at > begin && at < end, "only the flag branch writes a flag column");
    writes += 1;
    at = store.indexOf("[placement.field]: placement.flags", at + 1);
  }
  assert.ok(writes >= 1);
  assert.ok(constants.includes("const flags = ["));
  assert.ok(constants.includes("...flagsOf(match, seat),"));
});

test("flags are PUBLIC: both seats' flags ride the payload and the live event", () => {
  // The match payload carries both seats' flags, their remaining budget and
  // the per-match cap — flags are visible to both players.
  assert.ok(matchRoute.includes("myFlags: flagsOf(match, seat)"));
  assert.ok(matchRoute.includes("oppFlags: flagsOf(match, opponentSeat)"));
  assert.ok(matchRoute.includes("myFlagsLeft: flagsLeftForSeat(match, seat)"));
  assert.ok(matchRoute.includes("oppFlagsLeft: flagsLeftForSeat(match, opponentSeat)"));
  assert.ok(matchRoute.includes("flagsPerPlayer: BRIDGE_FLAGS_PER_PLAYER"));
  // A newly placed flag is pushed on the SAME event as a broken tile, with
  // both public lists, so neither seat waits for a poll.
  assert.ok(actRoute.includes("flagPlaced: result.flagPlaced ?? null"));
  assert.ok(actRoute.includes("p1Flags: Array.isArray(result.p1Flags)"));
  assert.ok(actRoute.includes("p2Flags: Array.isArray(result.p2Flags)"));
  // Flags are server-derived: a client cannot post flags or a broken set.
  assert.ok(!actRoute.includes("body?.flags"));
  assert.ok(!actRoute.includes("body?.broken"));
});

test("flags are per-match and reset with every new match", () => {
  const schema = read("src/db/schema.ts");
  assert.ok(
    /p1Flags: jsonb\("p1_flags"\)[\s\S]{0,120}?default\(sql`'\[\]'::jsonb`\)/.test(schema),
    "p1_flags defaults to []",
  );
  assert.ok(
    /p2Flags: jsonb\("p2_flags"\)[\s\S]{0,120}?default\(sql`'\[\]'::jsonb`\)/.test(schema),
    "p2_flags defaults to []",
  );
  const migration = read("src/db/migrations/0163_lane_rush_shared_bridge.sql");
  assert.ok(migration.includes('"p1_flags" jsonb NOT NULL DEFAULT \'[]\'::jsonb'));
  assert.ok(migration.includes('"p2_flags" jsonb NOT NULL DEFAULT \'[]\'::jsonb'));
  // The cap is a single shared constant (BRIDGE_FLAGS_PER_PLAYER = 2), never
  // duplicated per call site — the engine owns the budget.
  assert.ok(constants.includes("flagsLeftForSeat(match, seat) <= 0"));
  assert.ok(constants.includes("BRIDGE_FLAGS_PER_PLAYER - bridgeFlagsUsedBySeat(match, seat)"));
  assert.ok(constants.includes("export const BRIDGE_FLAGS_PER_PLAYER = 2;"));

  // ANTI-ORACLE: flag validation must never consult the hidden solution — it
  // may read the geometry only, and decides purely from the seat's own
  // landings. So a flag request cannot be used to probe safe/bad state.
  const canFlagBody = constants.slice(
    constants.indexOf("export function canPlaceFlag"),
    constants.indexOf("export function flagPlacement"),
  );
  assert.ok(canFlagBody.includes("landedSafelyOn"));
  assert.ok(!canFlagBody.includes("isBridgeTileBad"));
  assert.ok(!canFlagBody.includes("badTiles"));
  assert.ok(!canFlagBody.includes("bridge?.rows"));
});

// ════════════════════════════════════════════════════════════════════
// Permanent broken-tile state — pushed to BOTH seats over Socket.IO
// ════════════════════════════════════════════════════════════════════

test("the broken tile is pushed to both seats on the existing match event", () => {
  // The store reports exactly which tile broke (and whether it was new), so the
  // routes can announce it. Reuses `broadcastMatchUpdate` — no new event.
  assert.ok(store.includes("function brokeTileSignal({ outcome, brokenBefore = [] })"));
  assert.ok(store.includes("newlyBroken: Boolean("));
  assert.ok(store.includes("isTileBroken(brokenBefore, brokeTile.row, brokeTile.tile)"));

  // Human jump → act route; bot jump → ai-turn route. Both push it.
  for (const route of [actRoute, aiRoute]) {
    assert.ok(route.includes("broadcastMatchUpdate(matchId, {"));
    assert.ok(route.includes("brokeTile: result.newlyBroken ? result.brokeTile : null"));
    assert.ok(route.includes("broken: Array.isArray(result.broken) ? result.broken : undefined"));
  }
  // The room broadcast reaches every socket in the per-match room (both seats).
  const rooms = read("src/lib/lane-rush-duel/rooms.js");
  assert.ok(rooms.includes("io.to(roomId).emit(LANE_RUSH_DUEL_MATCH_UPDATED"));
});

test("the realtime + payload path never leaks the bridge layout", () => {
  // What travels: the ONE tile that broke + the public broken list. What never
  // travels: the layout's `badTiles`, or any per-row safe/bad answer.
  assert.ok(!actRoute.includes("badTiles"));
  assert.ok(!aiRoute.includes("badTiles"));
  assert.ok(!store.includes("brokeTile: outcome"), "the raw outcome must not be relayed whole");
  // The match payload hands out the scrubbed client view + the public list.
  assert.ok(matchRoute.includes("broken: brokenTilesOf(match)"));
  // Clients never send broken state — it is server-derived only.
  assert.ok(!actRoute.includes("body?.broken"));
  assert.ok(!actRoute.includes("broken ="), "a client cannot post a broken tile");
});

test("the countdown is display-only and reconnects get the server's remaining time", () => {
  // The payload carries absolute server time alongside the deadline, so a
  // client (or a reconnect) measures `roundDeadline - serverNow` rather than
  // trusting its own clock.
  assert.ok(matchRoute.includes("serverNow: new Date().toISOString()"));
  assert.ok(page.includes("const [clockOffsetMs, setClockOffsetMs] = useState(0)"));
  assert.ok(page.includes("const serverNowMs = now === null ? null : now + clockOffsetMs"));
  assert.ok(page.includes("Math.max(0, Math.ceil((deadlineMs - serverNowMs) / 1000))"));
  // The only thing the client does at 0 is ASK the server (a GET) — deduped per
  // deadline, so it can never spam, and it never decides anything itself.
  assert.ok(page.includes("expiredDeadlineRef.current === deadlineMs"));
  assert.ok(page.includes("expiredDeadlineRef.current = deadlineMs"));
  assert.ok(page.includes("fetchStatus();"));
  assert.ok(
    !page.includes("setMatch((cur) => ({ ...cur, p1Row"),
    "the client never resolves the timeout itself",
  );
});

// ════════════════════════════════════════════════════════════════════
// Legacy mechanics removal
// ════════════════════════════════════════════════════════════════════

test("the legacy points / banking server logic is gone", () => {
  // The bridge redesign has NO points, NO banking, NO multipliers and NO
  // peek: none of that state may survive on the server.
  assert.ok(!store.includes("bankedTotal = scoreFromActions"));
  assert.ok(!store.includes("WIN_BANKED_SCORE"));
  assert.ok(!store.includes("applyEntryImmediately"));
  assert.ok(!store.includes("bankedGainOnHold"));
  assert.ok(!store.includes("scoreFromActions"));
  assert.ok(!store.includes("buildPlayerTower"));
  assert.ok(!store.includes("decideBotAction("));
  // The one live transition is the tile-selection jump.
  assert.ok(store.includes("async function applyBridgeJump"));
  assert.ok(store.includes("bridgeTurnAfterJump"));
});

test("the constants module exports no removed mechanic", () => {
  for (const dead of [
    "RISK_PATHS",
    "RISK_PATH_KEYS",
    "LANE_POINTS",
    "DIFFICULTY_POINT_MULT",
    "WIN_BANKED_SCORE",
    "MAX_PEEKS",
    "buildPlayerTower",
    "scoreFromActions",
    "bankedScoreOf",
  ]) {
    assert.ok(
      !new RegExp(`export (const|function) ${dead}\\b`).test(constants),
      `constants must not export removed mechanic ${dead}`,
    );
  }
  assert.ok(constants.includes("export const BRIDGE_ROWS = 10;"));
  assert.ok(constants.includes("export const BRIDGE_TILE_CHOICE_SECONDS = 15;"));
});
